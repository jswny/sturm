import { tool } from "ai";
import { z } from "zod";
import {
  DISCORD_MESSAGE_SEARCH_DEFAULT_LIMIT,
  DISCORD_MESSAGE_SEARCH_MAX_CONTENT_CHARS,
  DISCORD_MESSAGE_SEARCH_MAX_LIMIT,
  DISCORD_MESSAGE_SEARCH_MIN_LIMIT,
  searchDiscordMessages,
  type DiscordMessageSearchEnv,
  type DiscordMessageSearchContext,
  type DiscordMessageSearchResponse
} from "../discord-message-search";
import { formatUtcTimestampField } from "../discord/timestamps";

const DISCORD_MESSAGE_SEARCH_MAX_HAS_FILTERS = 3;

const discordMessageSearchHasSchema = z.enum([
  "image",
  "sound",
  "video",
  "file",
  "sticker",
  "embed",
  "link",
  "poll",
  "snapshot"
]);

const discordMessageSearchResponseSchema = z.object({
  ok: z.boolean().describe("Whether the search request succeeded"),
  guildId: z.string().optional(),
  channelId: z.string().optional(),
  query: z.record(z.string(), z.unknown()),
  totalResults: z.number().int().optional(),
  indexNotReady: z.boolean().optional(),
  retryAfterSeconds: z.number().optional(),
  documentsIndexed: z.number().int().optional(),
  results: z
    .array(
      z.object({
        id: z.string(),
        channelId: z.string(),
        authorId: z.string(),
        authorDisplayName: z.string(),
        authorBot: z.boolean(),
        sent_at_utc: z.string(),
        edited_at_utc: z.string().optional(),
        content: z.string().optional(),
        attachments: z.array(z.string()).optional(),
        embeds: z.number().int().optional(),
        stickers: z.array(z.string()).optional(),
        url: z.string()
      })
    )
    .optional(),
  error: z.string().optional()
});

export function createDiscordMessageSearchTools(
  env: DiscordMessageSearchEnv,
  context: DiscordMessageSearchContext
) {
  return {
    searchDiscordMessages: tool({
      description:
        "Search Discord messages in the current channel only. Use this when recent channel context is not enough and the user asks about earlier channel discussion. Provide at least one filter: content, authorUserId, mentionsUserId, has, or pinned. Results include message links. Do not use this to search other channels or the whole guild.",
      inputSchema: z.object({
        content: z
          .string()
          .min(1)
          .max(DISCORD_MESSAGE_SEARCH_MAX_CONTENT_CHARS)
          .optional()
          .describe(
            `Text to search for in message content, up to ${DISCORD_MESSAGE_SEARCH_MAX_CONTENT_CHARS} characters`
          ),
        authorUserId: z
          .string()
          .optional()
          .describe("Only return messages sent by this raw Discord user ID"),
        mentionsUserId: z
          .string()
          .optional()
          .describe(
            "Only return messages that mention this raw Discord user ID"
          ),
        has: z
          .array(discordMessageSearchHasSchema)
          .max(DISCORD_MESSAGE_SEARCH_MAX_HAS_FILTERS)
          .optional()
          .describe(
            `Only return messages with these attachment/content types; include up to ${DISCORD_MESSAGE_SEARCH_MAX_HAS_FILTERS} filters`
          ),
        pinned: z
          .boolean()
          .optional()
          .describe("Filter by whether messages are pinned"),
        beforeMessageId: z
          .string()
          .optional()
          .describe("Only return messages before this raw Discord message ID"),
        afterMessageId: z
          .string()
          .optional()
          .describe("Only return messages after this raw Discord message ID"),
        sortBy: z
          .enum(["timestamp", "relevance"])
          .optional()
          .describe("Sort by timestamp or relevance"),
        sortOrder: z
          .enum(["asc", "desc"])
          .optional()
          .describe("Sort direction; relevance ignores this"),
        limit: z
          .number()
          .int()
          .min(DISCORD_MESSAGE_SEARCH_MIN_LIMIT)
          .max(DISCORD_MESSAGE_SEARCH_MAX_LIMIT)
          .default(DISCORD_MESSAGE_SEARCH_DEFAULT_LIMIT)
          .describe(
            `Maximum results to return, from ${DISCORD_MESSAGE_SEARCH_MIN_LIMIT} to ${DISCORD_MESSAGE_SEARCH_MAX_LIMIT} inclusive`
          )
      }),
      outputSchema: discordMessageSearchResponseSchema,
      execute: async (input) => searchDiscordMessages(env, context, input),
      toModelOutput: ({ output }) => ({
        type: "text",
        value: formatDiscordMessageSearchOutput(output)
      })
    })
  };
}

function formatDiscordMessageSearchOutput(
  output: DiscordMessageSearchResponse
) {
  if (!output.ok) {
    return `Discord message search failed: ${output.error}`;
  }

  if (output.indexNotReady) {
    return [
      "Discord message search index is not ready for this query.",
      `Retry after: ${output.retryAfterSeconds ?? 0} seconds`,
      `Documents indexed: ${output.documentsIndexed ?? 0}`
    ]
      .filter(Boolean)
      .join("\n");
  }

  const results = output.results ?? [];
  if (results.length === 0) {
    return "No Discord messages matched that current-channel search.";
  }

  return [
    `Discord current-channel message search returned ${results.length} result(s).`,
    "all timestamps are ISO 8601 UTC",
    output.totalResults !== undefined
      ? `Total matching results reported by Discord: ${output.totalResults}`
      : "",
    ...results.map((message, index) =>
      [
        `${index + 1}. ${message.authorDisplayName} (${message.authorId}) ${formatMessageTimestamps(message)}`,
        message.content ? `   content: ${message.content}` : "",
        message.attachments?.length
          ? `   attachments: ${message.attachments.join(", ")}`
          : "",
        message.embeds ? `   embeds: ${message.embeds}` : "",
        message.stickers?.length
          ? `   stickers: ${message.stickers.join(", ")}`
          : "",
        `   url: ${message.url}`
      ]
        .filter(Boolean)
        .join("\n")
    )
  ]
    .filter(Boolean)
    .join("\n");
}

function formatMessageTimestamps(
  message: NonNullable<DiscordMessageSearchResponse["results"]>[number]
) {
  return [
    formatUtcTimestampField("sent_at_utc", message.sent_at_utc),
    message.edited_at_utc
      ? formatUtcTimestampField("edited_at_utc", message.edited_at_utc)
      : ""
  ]
    .filter(Boolean)
    .join(" ");
}

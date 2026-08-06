import { tool } from "ai";
import { z } from "zod";
import {
  DISCORD_MESSAGE_HISTORY_PAGE_SIZE,
  readEarlierDiscordMessages,
  type DiscordMessageHistoryContext,
  type DiscordMessageHistoryEnv
} from "../discord-message-history";

const discordMessageHistoryResponseSchema = z.object({
  ok: z.boolean().describe("Whether the history read succeeded"),
  guildId: z.string().optional(),
  channelId: z.string().optional(),
  startedFromLatest: z
    .boolean()
    .optional()
    .describe(
      "Whether the first call had to start from the latest messages because no snapshot cursor was available"
    ),
  nextBeforeMessageId: z
    .string()
    .optional()
    .describe("Tool-only cursor to pass as beforeMessageId on the next call"),
  messages: z
    .array(
      z.object({
        id: z.string(),
        formattedText: z.string().optional(),
        url: z.string()
      })
    )
    .optional(),
  error: z.string().optional()
});

type DiscordMessageHistoryToolResponse = z.infer<
  typeof discordMessageHistoryResponseSchema
>;

export function createDiscordMessageHistoryTools(
  env: DiscordMessageHistoryEnv,
  context: DiscordMessageHistoryContext
) {
  return {
    readEarlierDiscordMessages: tool({
      description: `Read a chronological page of up to ${DISCORD_MESSAGE_HISTORY_PAGE_SIZE} messages older than the live Discord channel transcript snapshot. This is limited to the current channel. On the first call, omit beforeMessageId to start immediately before the oldest message retained in the snapshot; if the snapshot did not provide a cursor, the tool starts from the latest available messages and reports that fallback. A full page may have older messages; if more context is needed, call again with the returned nextBeforeMessageId as beforeMessageId. A partial or empty page means there are no older messages. Stop paging as soon as there is enough context to answer. Use searchDiscordMessages instead when looking for specific content, authors, mentions, attachments, or pinned messages. Cursor IDs are tool-only and must not appear in the final response.`,
      inputSchema: z.object({
        beforeMessageId: z
          .string()
          .optional()
          .describe(
            "Tool-only pagination cursor. Omit on the first call; on later calls, pass nextBeforeMessageId from the previous result."
          )
      }),
      outputSchema: discordMessageHistoryResponseSchema,
      execute: async (input) => readEarlierDiscordMessages(env, context, input),
      toModelOutput: ({ output }) => ({
        type: "text",
        value: formatDiscordMessageHistoryOutput(output)
      })
    })
  };
}

function formatDiscordMessageHistoryOutput(
  output: DiscordMessageHistoryToolResponse
) {
  if (!output.ok) {
    return `Discord message history read failed: ${output.error ?? "Unknown error."}`;
  }

  const messages = output.messages ?? [];
  return [
    `Earlier Discord messages: ${messages.length} (oldest to newest)`,
    ...messages
      .filter((message) => message.formattedText)
      .map(
        (message) => `${message.formattedText}\n  message_url: ${message.url}`
      ),
    output.startedFromLatest
      ? "The live snapshot did not provide a cursor, so this page started from the latest available channel messages."
      : undefined,
    output.nextBeforeMessageId
      ? `nextBeforeMessageId: ${output.nextBeforeMessageId}`
      : undefined,
    messages.length === DISCORD_MESSAGE_HISTORY_PAGE_SIZE
      ? "This was a full page. If more chronological context is needed, call this tool again with nextBeforeMessageId as beforeMessageId. Otherwise answer now. Do not expose cursor IDs in the final response."
      : messages.length > 0
        ? "This partial page reached the end of channel history. Answer from the messages already available."
        : "No older messages were returned. Answer from the messages already available."
  ]
    .filter(Boolean)
    .join("\n");
}

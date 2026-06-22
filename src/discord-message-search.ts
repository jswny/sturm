import {
  MessageSearchHasType,
  MessageSearchSortMode,
  type APIMessage
} from "discord-api-types/v10";
import {
  DiscordApiError,
  getGuildMember,
  searchGuildMessages as searchDiscordGuildMessages
} from "./discord/api";
import type { DiscordApiEnv } from "./discord/api";
import { resolveDiscordMemberDisplayName } from "./discord/display-name";
import { normalizeUtcTimestamp } from "./discord/timestamps";
import { logError, logWarn } from "./logging";

export const DISCORD_MESSAGE_SEARCH_MAX_CONTENT_CHARS = 1024;
export const DISCORD_MESSAGE_SEARCH_MIN_LIMIT = 1;
export const DISCORD_MESSAGE_SEARCH_MAX_LIMIT = 25;
export const DISCORD_MESSAGE_SEARCH_DEFAULT_LIMIT = 10;

const DISCORD_MESSAGE_SEARCH_MAX_WAIT_MS = 5_000;

export type DiscordMessageSearchEnv = DiscordApiEnv;

export type DiscordMessageSearchContext = {
  guildId?: string;
  channelId?: string;
  channel?: { nsfw?: boolean };
};

export type DiscordMessageSearchHas =
  | "image"
  | "sound"
  | "video"
  | "file"
  | "sticker"
  | "embed"
  | "link"
  | "poll"
  | "snapshot";

export type DiscordMessageSearchInput = {
  content?: string;
  authorUserId?: string;
  mentionsUserId?: string;
  has?: DiscordMessageSearchHas[];
  pinned?: boolean;
  beforeMessageId?: string;
  afterMessageId?: string;
  sortBy?: "timestamp" | "relevance";
  sortOrder?: "asc" | "desc";
  limit?: number;
};

export type DiscordMessageSearchResponse = {
  ok: boolean;
  guildId?: string;
  channelId?: string;
  query: DiscordMessageSearchInput;
  totalResults?: number;
  indexNotReady?: boolean;
  retryAfterSeconds?: number;
  documentsIndexed?: number;
  results?: DiscordMessageSearchMatch[];
  error?: string;
};

export type DiscordMessageSearchMatch = {
  id: string;
  channelId: string;
  authorId: string;
  authorDisplayName: string;
  authorBot: boolean;
  sent_at_utc: string;
  edited_at_utc?: string;
  content?: string;
  attachments?: string[];
  embeds?: number;
  stickers?: string[];
  url: string;
};

type SearchMessage = Omit<APIMessage, "reactions">;

export async function searchDiscordMessages(
  env: DiscordMessageSearchEnv,
  context: DiscordMessageSearchContext,
  input: DiscordMessageSearchInput
): Promise<DiscordMessageSearchResponse> {
  const prepared = prepareSearchInput(input);
  if (prepared.error) {
    return failure(context, input, prepared.error);
  }

  if (!env.DISCORD_TOKEN?.trim()) {
    return failure(context, prepared.input, "DISCORD_TOKEN is not configured.");
  }

  if (!context.guildId) {
    return failure(
      context,
      prepared.input,
      "Discord message search requires a server context."
    );
  }

  if (!context.channelId || !isDiscordSnowflake(context.channelId)) {
    return failure(
      context,
      prepared.input,
      "Discord message search requires a real current channel ID."
    );
  }

  try {
    const result = await searchDiscordGuildMessages(
      env,
      context.guildId,
      {
        channel_id: [context.channelId],
        limit: prepared.input.limit,
        content: prepared.input.content,
        author_id: prepared.input.authorUserId
          ? [prepared.input.authorUserId]
          : undefined,
        mentions: prepared.input.mentionsUserId
          ? [prepared.input.mentionsUserId]
          : undefined,
        has: prepared.input.has?.map(toDiscordSearchHasType),
        pinned: prepared.input.pinned,
        max_id: prepared.input.beforeMessageId,
        min_id: prepared.input.afterMessageId,
        sort_by: toDiscordSearchSortMode(
          prepared.input.sortBy ??
            (prepared.input.content ? "relevance" : "timestamp")
        ),
        sort_order: prepared.input.sortOrder ?? "desc",
        include_nsfw: context.channel?.nsfw === true
      },
      { maxWaitMs: DISCORD_MESSAGE_SEARCH_MAX_WAIT_MS }
    );

    if ("retry_after" in result) {
      return {
        ok: true,
        guildId: context.guildId,
        channelId: context.channelId,
        query: prepared.input,
        indexNotReady: true,
        retryAfterSeconds: result.retry_after,
        documentsIndexed: result.documents_indexed
      };
    }

    const messages = result.messages.flat();
    const authorDisplayNames = await resolveSearchMessageAuthorDisplayNames(
      env,
      context.guildId,
      messages
    );

    return {
      ok: true,
      guildId: context.guildId,
      channelId: context.channelId,
      query: prepared.input,
      totalResults: result.total_results,
      documentsIndexed: result.documents_indexed,
      results: messages.map((message) =>
        formatSearchMatch(context.guildId ?? "", message, authorDisplayNames)
      )
    };
  } catch (error) {
    logDiscordMessageSearchFailure(error, context, prepared.input);
    return failure(
      context,
      prepared.input,
      formatDiscordMessageSearchError(error)
    );
  }
}

function prepareSearchInput(input: DiscordMessageSearchInput): {
  input: DiscordMessageSearchInput;
  error?: string;
} {
  const prepared: DiscordMessageSearchInput = {
    content:
      input.content
        ?.trim()
        .slice(0, DISCORD_MESSAGE_SEARCH_MAX_CONTENT_CHARS) || undefined,
    authorUserId: input.authorUserId?.trim() || undefined,
    mentionsUserId: input.mentionsUserId?.trim() || undefined,
    has: input.has?.length ? [...new Set(input.has)] : undefined,
    pinned: input.pinned,
    beforeMessageId: input.beforeMessageId?.trim() || undefined,
    afterMessageId: input.afterMessageId?.trim() || undefined,
    sortBy: input.sortBy,
    sortOrder: input.sortOrder,
    limit: clampSearchLimit(input.limit ?? DISCORD_MESSAGE_SEARCH_DEFAULT_LIMIT)
  };

  for (const [label, value] of [
    ["authorUserId", prepared.authorUserId],
    ["mentionsUserId", prepared.mentionsUserId],
    ["beforeMessageId", prepared.beforeMessageId],
    ["afterMessageId", prepared.afterMessageId]
  ] as const) {
    if (value && !isDiscordSnowflake(value)) {
      return {
        input: prepared,
        error: `${label} must be a raw Discord snowflake ID.`
      };
    }
  }

  if (
    !prepared.content &&
    !prepared.authorUserId &&
    !prepared.mentionsUserId &&
    !prepared.has?.length &&
    prepared.pinned === undefined
  ) {
    return {
      input: prepared,
      error:
        "Provide at least one search filter: content, authorUserId, mentionsUserId, has, or pinned."
    };
  }

  return { input: prepared };
}

function formatSearchMatch(
  guildId: string,
  message: SearchMessage,
  authorDisplayNames: Map<string, string>
) {
  const attachments = message.attachments.map((attachment) =>
    attachment.content_type
      ? `${attachment.filename} ${attachment.content_type}`
      : attachment.filename
  );
  return {
    id: message.id,
    channelId: message.channel_id,
    authorId: message.author.id,
    authorDisplayName:
      authorDisplayNames.get(message.author.id) ??
      message.author.global_name ??
      message.author.username,
    authorBot: message.author.bot ?? false,
    sent_at_utc: normalizeUtcTimestamp(message.timestamp),
    edited_at_utc: message.edited_timestamp
      ? normalizeUtcTimestamp(message.edited_timestamp)
      : undefined,
    content: normalizeMessageContent(message.content) || undefined,
    attachments: attachments.length ? attachments : undefined,
    embeds: message.embeds.length || undefined,
    stickers: message.sticker_items?.map((sticker) => sticker.name),
    url: `https://discord.com/channels/${guildId}/${message.channel_id}/${message.id}`
  } satisfies DiscordMessageSearchMatch;
}

async function resolveSearchMessageAuthorDisplayNames(
  env: DiscordMessageSearchEnv,
  guildId: string | undefined,
  messages: SearchMessage[]
) {
  const authorIds = getUniqueSearchMessageAuthorIds(messages);
  if (!guildId || authorIds.length === 0) return new Map<string, string>();

  const results = await Promise.all(
    authorIds.map(async (authorId) => {
      try {
        const member = await getGuildMember(env, guildId, authorId, {
          maxWaitMs: DISCORD_MESSAGE_SEARCH_MAX_WAIT_MS
        });
        return [authorId, resolveDiscordMemberDisplayName(member)] as const;
      } catch {
        return undefined;
      }
    })
  );

  return new Map(results.filter((entry) => entry !== undefined));
}

function getUniqueSearchMessageAuthorIds(messages: SearchMessage[]) {
  return [...new Set(messages.map((message) => message.author.id))];
}

function toDiscordSearchHasType(has: DiscordMessageSearchHas) {
  const values = {
    image: MessageSearchHasType.Image,
    sound: MessageSearchHasType.Sound,
    video: MessageSearchHasType.Video,
    file: MessageSearchHasType.File,
    sticker: MessageSearchHasType.Sticker,
    embed: MessageSearchHasType.Embed,
    link: MessageSearchHasType.Link,
    poll: MessageSearchHasType.Poll,
    snapshot: MessageSearchHasType.Snapshot
  } satisfies Record<DiscordMessageSearchHas, MessageSearchHasType>;
  return values[has];
}

function toDiscordSearchSortMode(sortBy: "timestamp" | "relevance") {
  return sortBy === "relevance"
    ? MessageSearchSortMode.Relevance
    : MessageSearchSortMode.Timestamp;
}

function failure(
  context: DiscordMessageSearchContext,
  query: DiscordMessageSearchInput,
  error: string
): DiscordMessageSearchResponse {
  return {
    ok: false,
    guildId: context.guildId,
    channelId: context.channelId,
    query,
    error
  };
}

function logDiscordMessageSearchFailure(
  error: unknown,
  context: DiscordMessageSearchContext,
  query: DiscordMessageSearchInput
) {
  const logContext = {
    guildId: context.guildId,
    channelId: context.channelId,
    hasContentQuery: Boolean(query.content),
    authorUserId: query.authorUserId,
    mentionsUserId: query.mentionsUserId,
    has: query.has,
    pinned: query.pinned
  };

  if (error instanceof DiscordApiError) {
    logWarn("Discord message search API request failed", {
      ...logContext,
      discordStatus: error.status,
      discordCode: error.code,
      error: formatDiscordMessageSearchError(error)
    });
    return;
  }

  logError("Discord message search failed", error, logContext);
}

function formatDiscordMessageSearchError(error: unknown) {
  if (error instanceof DiscordApiError) {
    if (error.status === 403) {
      return "Discord rejected the message search. The bot may be missing Read Message History, or message content search may require the Message Content privileged intent.";
    }

    if (error.status === 404) {
      return "Discord could not find that guild or channel.";
    }

    return `Discord API error ${error.status}.`;
  }

  return error instanceof Error ? error.message : String(error);
}

function normalizeMessageContent(content: string) {
  return content.replace(/\s+/g, " ").trim();
}

function clampSearchLimit(limit: number) {
  if (!Number.isFinite(limit)) return DISCORD_MESSAGE_SEARCH_DEFAULT_LIMIT;
  return Math.min(
    DISCORD_MESSAGE_SEARCH_MAX_LIMIT,
    Math.max(DISCORD_MESSAGE_SEARCH_MIN_LIMIT, Math.trunc(limit))
  );
}

function isDiscordSnowflake(value: string) {
  return /^\d{8,}$/.test(value);
}

import {
  DiscordApiError,
  getChannelMessages,
  type DiscordApiEnv
} from "./discord/api";
import { resolveDiscordMessageAuthorDisplayNames } from "./discord/message-authors";
import {
  createDiscordRetrievedMessage,
  type DiscordRetrievedMessage
} from "./discord/message-format";
import type { DiscordMessageToolContext } from "./discord/types";
import { logError, logWarn } from "./logging";

export const DISCORD_MESSAGE_HISTORY_PAGE_SIZE = 15;
const DISCORD_MESSAGE_HISTORY_MAX_WAIT_MS = 5_000;

export type DiscordMessageHistoryEnv = DiscordApiEnv;

export type DiscordMessageHistoryContext = DiscordMessageToolContext & {
  initialBeforeMessageId?: string;
};

export type DiscordMessageHistoryInput = {
  beforeMessageId?: string;
};

export type DiscordMessageHistoryResponse = {
  ok: boolean;
  guildId?: string;
  channelId?: string;
  startedFromLatest?: boolean;
  nextBeforeMessageId?: string;
  messages?: DiscordMessageHistoryMessage[];
  error?: string;
};

export type DiscordMessageHistoryMessage = DiscordRetrievedMessage;

export async function readEarlierDiscordMessages(
  env: DiscordMessageHistoryEnv,
  context: DiscordMessageHistoryContext,
  input: DiscordMessageHistoryInput
): Promise<DiscordMessageHistoryResponse> {
  const explicitBeforeMessageId = input.beforeMessageId?.trim() || undefined;
  if (explicitBeforeMessageId && !isDiscordSnowflake(explicitBeforeMessageId)) {
    return failure(
      context,
      "beforeMessageId must be a raw Discord snowflake ID."
    );
  }

  if (!env.DISCORD_TOKEN?.trim()) {
    return failure(context, "DISCORD_TOKEN is not configured.");
  }

  if (!context.guildId) {
    return failure(
      context,
      "Discord message history requires a server context."
    );
  }

  if (!context.channelId || !isDiscordSnowflake(context.channelId)) {
    return failure(
      context,
      "Discord message history requires a real current channel ID."
    );
  }

  const beforeMessageId =
    explicitBeforeMessageId ?? context.initialBeforeMessageId;

  try {
    const fetchedMessages = await getChannelMessages(env, context.channelId, {
      limit: DISCORD_MESSAGE_HISTORY_PAGE_SIZE,
      beforeMessageId,
      maxWaitMs: DISCORD_MESSAGE_HISTORY_MAX_WAIT_MS
    });
    const authorDisplayNames = await resolveDiscordMessageAuthorDisplayNames(
      env,
      context.guildId,
      fetchedMessages,
      DISCORD_MESSAGE_HISTORY_MAX_WAIT_MS
    );

    return {
      ok: true,
      guildId: context.guildId,
      channelId: context.channelId,
      startedFromLatest: beforeMessageId === undefined,
      nextBeforeMessageId: fetchedMessages.at(-1)?.id,
      messages: fetchedMessages
        .map((message) =>
          createDiscordRetrievedMessage(context.guildId ?? "", message, {
            app: context.app,
            memberDisplayNames: authorDisplayNames
          })
        )
        .reverse()
    };
  } catch (error) {
    logDiscordMessageHistoryFailure(error, context, beforeMessageId);
    return failure(context, formatDiscordMessageHistoryError(error));
  }
}

function failure(
  context: DiscordMessageHistoryContext,
  error: string
): DiscordMessageHistoryResponse {
  return {
    ok: false,
    guildId: context.guildId,
    channelId: context.channelId,
    error
  };
}

function logDiscordMessageHistoryFailure(
  error: unknown,
  context: DiscordMessageHistoryContext,
  beforeMessageId: string | undefined
) {
  const logContext = {
    guildId: context.guildId,
    channelId: context.channelId,
    beforeMessageId
  };

  if (error instanceof DiscordApiError) {
    logWarn("Discord message history API request failed", {
      ...logContext,
      discordStatus: error.status,
      discordCode: error.code,
      error: formatDiscordMessageHistoryError(error)
    });
    return;
  }

  logError("Discord message history read failed", error, logContext);
}

function formatDiscordMessageHistoryError(error: unknown) {
  if (error instanceof DiscordApiError) {
    if (error.status === 403) {
      return "Discord rejected the message history read. The bot may be missing View Channel or Read Message History.";
    }

    if (error.status === 404) {
      return "Discord could not find that channel.";
    }

    return `Discord API error ${error.status}.`;
  }

  return error instanceof Error ? error.message : String(error);
}

function isDiscordSnowflake(value: string) {
  return /^\d{8,}$/.test(value);
}

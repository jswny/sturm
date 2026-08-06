import type { APIMessage } from "discord-api-types/v10";
import { getChannelMessages, type DiscordApiEnv } from "./api";
import { resolveDiscordMessageAuthorDisplayNames } from "./message-authors";
import {
  formatDiscordMessageForSnapshot,
  type DiscordMessageFormatContext
} from "./message-format";
import type { DiscordChatRequest } from "./types";

const RECENT_CHANNEL_MESSAGE_LIMIT = 30;
const RECENT_CHANNEL_CONTEXT_MAX_WAIT_MS = 1_500;
const RECENT_CHANNEL_CONTEXT_MAX_CHARS = 6_000;

type DiscordChannelContextEnv = DiscordApiEnv & {
  DISCORD_APPLICATION_ID?: string;
};

export type RecentDiscordChannelContext = {
  text: string;
  oldestVisibleMessageId?: string;
};

export async function createRecentDiscordChannelContext(
  env: DiscordChannelContextEnv,
  request: DiscordChatRequest
): Promise<RecentDiscordChannelContext> {
  if (!request.channelId || !isDiscordSnowflake(request.channelId)) {
    return { text: "" };
  }

  const messages = await getChannelMessages(env, request.channelId, {
    limit: RECENT_CHANNEL_MESSAGE_LIMIT,
    maxWaitMs: RECENT_CHANNEL_CONTEXT_MAX_WAIT_MS
  });
  const memberDisplayNames = await resolveDiscordMessageAuthorDisplayNames(
    env,
    request.guildId,
    messages,
    RECENT_CHANNEL_CONTEXT_MAX_WAIT_MS
  );

  return formatRecentDiscordChannelMessages(messages, {
    app: {
      ...request.app,
      applicationId:
        env.DISCORD_APPLICATION_ID?.trim() ?? request.app?.applicationId
    },
    currentInteractionId: request.discordInteractionId,
    memberDisplayNames
  });
}

function formatRecentDiscordChannelMessages(
  messages: APIMessage[],
  options: DiscordMessageFormatContext & { currentInteractionId?: string }
): RecentDiscordChannelContext {
  const entries = messages
    .map((message) => formatDiscordMessageForSnapshot(message, options))
    .filter((entry) => entry !== undefined)
    .reverse();

  if (entries.length === 0) return { text: "" };

  const header = [
    "Live Discord channel transcript snapshot (fetched at turn time; may be incomplete):",
    "all timestamps are ISO 8601 UTC",
    "messages are ordered oldest to newest",
    "Sturm assistant responses are marker-only entries; their content is represented in persisted assistant history",
    "Sturm markers correspond chronologically to prior assistant responses in persisted assistant history",
    "the current Discord user message appears after this snapshot as the final user message in the model input"
  ].join("\n");
  const transcriptHeader = "Recent messages:";
  let keptEntries = entries;
  while (
    [header, transcriptHeader, ...keptEntries.map((entry) => entry.text)].join(
      "\n"
    ).length > RECENT_CHANNEL_CONTEXT_MAX_CHARS &&
    keptEntries.length > 1
  ) {
    keptEntries = keptEntries.slice(1);
  }

  const block = [
    header,
    transcriptHeader,
    ...keptEntries.map((entry) => entry.text)
  ].join("\n");
  return {
    text: limitText(block, RECENT_CHANNEL_CONTEXT_MAX_CHARS),
    oldestVisibleMessageId: keptEntries[0]?.id
  };
}

function isDiscordSnowflake(value: string) {
  return /^\d{8,}$/.test(value);
}

function limitText(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

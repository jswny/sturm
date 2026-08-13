import type { APIMessage } from "discord-api-types/v10";
import { getChannelMessages, type DiscordApiEnv } from "./api";
import { resolveDiscordMessageAuthorDisplayNames } from "./message-authors";
import type { DiscordMessageFormatContext } from "./message-format";
import type { DiscordChatRequest } from "./types";

const LIVE_CHANNEL_MESSAGE_LIMIT = 30;
const LIVE_CHANNEL_SNAPSHOT_MAX_WAIT_MS = 1_500;

type DiscordLiveChannelSnapshotEnv = DiscordApiEnv & {
  DISCORD_APPLICATION_ID?: string;
};

export type LiveDiscordChannelSnapshot = {
  messages: APIMessage[];
  formatContext: DiscordMessageFormatContext & {
    currentInteractionId?: string;
  };
};

export async function createLiveDiscordChannelSnapshot(
  env: DiscordLiveChannelSnapshotEnv,
  request: DiscordChatRequest
): Promise<LiveDiscordChannelSnapshot | undefined> {
  if (!request.channelId || !isDiscordSnowflake(request.channelId)) {
    return undefined;
  }

  const messages = await getChannelMessages(env, request.channelId, {
    limit: LIVE_CHANNEL_MESSAGE_LIMIT,
    maxWaitMs: LIVE_CHANNEL_SNAPSHOT_MAX_WAIT_MS
  });
  const memberDisplayNames = await resolveDiscordMessageAuthorDisplayNames(
    env,
    request.guildId,
    messages,
    LIVE_CHANNEL_SNAPSHOT_MAX_WAIT_MS
  );

  return {
    messages,
    formatContext: {
      app: {
        ...request.app,
        applicationId:
          env.DISCORD_APPLICATION_ID?.trim() ?? request.app?.applicationId
      },
      currentInteractionId: request.discordInteractionId,
      memberDisplayNames
    }
  };
}

function isDiscordSnowflake(value: string) {
  return /^\d{8,}$/.test(value);
}

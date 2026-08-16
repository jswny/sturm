import type { RESTGetAPIChannelMessagesResult } from "discord-api-types/v10";
import { getChannelMessages, type DiscordApiEnv } from "./api";

const DISCORD_MESSAGE_PAGE_SIZE = 100;

export async function readDiscordMessagesAfterCursor(
  env: DiscordApiEnv,
  channelId: string,
  cursorMessageId: string,
  maxPages: number
) {
  const firstPage = await getChannelMessages(env, channelId, {
    limit: DISCORD_MESSAGE_PAGE_SIZE,
    afterMessageId: cursorMessageId
  });
  if (firstPage.length < DISCORD_MESSAGE_PAGE_SIZE) return firstPage;

  const messages = new Map(firstPage.map((message) => [message.id, message]));
  let oldestMessageId = getOldestDiscordMessageId(firstPage);
  for (let page = 1; page < maxPages; page++) {
    const nextPage = await readDiscordMessagesBeforeCursor(
      env,
      channelId,
      oldestMessageId,
      DISCORD_MESSAGE_PAGE_SIZE
    );
    for (const message of nextPage) {
      if (compareDiscordSnowflakes(message.id, cursorMessageId) > 0) {
        messages.set(message.id, message);
      }
    }

    if (
      nextPage.length < DISCORD_MESSAGE_PAGE_SIZE ||
      nextPage.some(
        (message) => compareDiscordSnowflakes(message.id, cursorMessageId) <= 0
      )
    ) {
      return [...messages.values()];
    }
    oldestMessageId = getOldestDiscordMessageId(nextPage);
  }

  throw new Error(
    `Channel backlog exceeded ${maxPages * DISCORD_MESSAGE_PAGE_SIZE} messages; cursor was not advanced.`
  );
}

export function readDiscordMessagesBeforeCursor(
  env: DiscordApiEnv,
  channelId: string,
  beforeMessageId: string,
  limit: number
) {
  return getChannelMessages(env, channelId, {
    limit,
    beforeMessageId
  });
}

export function getOldestDiscordMessageId(
  messages: RESTGetAPIChannelMessagesResult
) {
  const oldest = messages.reduce((current, message) =>
    compareDiscordSnowflakes(message.id, current.id) < 0 ? message : current
  );
  return oldest.id;
}

export function compareDiscordSnowflakes(left: string, right: string) {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

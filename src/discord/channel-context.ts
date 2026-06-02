import type { APIMessage } from "discord-api-types/v10";
import { getChannelMessages, type DiscordApiEnv } from "./api";
import type { DiscordChatRequest } from "./types";

const RECENT_CHANNEL_MESSAGE_LIMIT = 30;
const RECENT_CHANNEL_CONTEXT_MAX_WAIT_MS = 1_500;
const RECENT_CHANNEL_CONTEXT_MAX_CHARS = 6_000;
const RECENT_CHANNEL_MESSAGE_MAX_CHARS = 700;

type DiscordChannelContextEnv = DiscordApiEnv & {
  DISCORD_APPLICATION_ID?: string;
};

export async function createRecentDiscordChannelContext(
  env: DiscordChannelContextEnv,
  request: DiscordChatRequest
) {
  if (!request.channelId || !isDiscordSnowflake(request.channelId)) return "";

  const messages = await getChannelMessages(env, request.channelId, {
    limit: RECENT_CHANNEL_MESSAGE_LIMIT,
    maxWaitMs: RECENT_CHANNEL_CONTEXT_MAX_WAIT_MS
  });

  return formatRecentDiscordChannelMessages(messages, {
    applicationId: env.DISCORD_APPLICATION_ID?.trim()
  });
}

function formatRecentDiscordChannelMessages(
  messages: APIMessage[],
  options: { applicationId?: string }
) {
  const lines = messages
    .filter((message) => !isCurrentApplicationMessage(message, options))
    .map(formatRecentDiscordChannelMessage)
    .filter(Boolean)
    .reverse();

  if (lines.length === 0) return "";

  const header =
    "Recent Discord channel messages (read-only context fetched at turn time; may be incomplete):";
  let keptLines = lines;
  while (
    [header, ...keptLines].join("\n").length >
      RECENT_CHANNEL_CONTEXT_MAX_CHARS &&
    keptLines.length > 1
  ) {
    keptLines = keptLines.slice(1);
  }

  const block = [header, ...keptLines].join("\n");
  return limitText(block, RECENT_CHANNEL_CONTEXT_MAX_CHARS);
}

function formatRecentDiscordChannelMessage(message: APIMessage) {
  const body = formatMessageBody(message);
  if (!body) return "";

  const author = formatMessageAuthor(message);
  const edited = message.edited_timestamp ? " edited" : "";
  return `- ${message.timestamp}${edited} ${author}: ${body}`;
}

function formatMessageAuthor(message: APIMessage) {
  const displayName = message.author.global_name || message.author.username;
  const labels = [`id: ${message.author.id}`];
  if (message.author.bot) labels.push("bot");
  if (message.webhook_id) labels.push(`webhook_id: ${message.webhook_id}`);
  return `${displayName} (${labels.join(", ")})`;
}

function formatMessageBody(message: APIMessage) {
  const parts: string[] = [];
  const content = normalizeMessageContent(message.content);
  if (content) parts.push(content);
  if (message.attachments.length > 0) {
    parts.push(
      `attachments: ${message.attachments.map(formatAttachment).join(", ")}`
    );
  }
  if (message.embeds.length > 0) parts.push(`embeds: ${message.embeds.length}`);
  if (message.sticker_items?.length) {
    parts.push(
      `stickers: ${message.sticker_items
        .map((sticker) => sticker.name)
        .join(", ")}`
    );
  }
  if (message.poll) parts.push("poll: present");

  return limitText(parts.join(" | "), RECENT_CHANNEL_MESSAGE_MAX_CHARS);
}

function normalizeMessageContent(content: string) {
  return content.replace(/\s+/g, " ").trim();
}

function formatAttachment(attachment: APIMessage["attachments"][number]) {
  const contentType = attachment.content_type
    ? ` ${attachment.content_type}`
    : "";
  return `${attachment.filename}${contentType}`;
}

function isCurrentApplicationMessage(
  message: APIMessage,
  options: { applicationId?: string }
) {
  return Boolean(
    options.applicationId && message.application_id === options.applicationId
  );
}

function isDiscordSnowflake(value: string) {
  return /^\d{8,}$/.test(value);
}

function limitText(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

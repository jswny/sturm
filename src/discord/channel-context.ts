import type { APIMessage } from "discord-api-types/v10";
import { getChannelMessages, getGuildMember, type DiscordApiEnv } from "./api";
import { resolveDiscordMemberDisplayName } from "./display-name";
import { formatUtcTimestampField } from "./timestamps";
import type { DiscordChatRequest } from "./types";

const RECENT_CHANNEL_MESSAGE_LIMIT = 30;
const RECENT_CHANNEL_CONTEXT_MAX_WAIT_MS = 1_500;
const RECENT_CHANNEL_CONTEXT_MAX_CHARS = 6_000;
const RECENT_CHANNEL_MESSAGE_MAX_CHARS = 700;

type DiscordChannelContextEnv = DiscordApiEnv & {
  DISCORD_APPLICATION_ID?: string;
};

type RecentDiscordChannelMessageOptions = {
  applicationId?: string;
  botUserId?: string;
  currentInteractionId?: string;
  memberDisplayNames: Map<string, string>;
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
  const memberDisplayNames = await resolveRecentMessageAuthorDisplayNames(
    env,
    request.guildId,
    messages
  );

  return formatRecentDiscordChannelMessages(messages, {
    applicationId: env.DISCORD_APPLICATION_ID?.trim(),
    botUserId: request.app?.botUserId,
    currentInteractionId: request.discordInteractionId,
    memberDisplayNames
  });
}

function formatRecentDiscordChannelMessages(
  messages: APIMessage[],
  options: RecentDiscordChannelMessageOptions
) {
  const lines = messages
    .map((message) => formatRecentDiscordChannelMessage(message, options))
    .filter(Boolean)
    .reverse();

  if (lines.length === 0) return "";

  const header = [
    "Live Discord channel transcript snapshot (fetched at turn time; may be incomplete):",
    "all timestamps are ISO 8601 UTC",
    "messages are ordered oldest to newest",
    "Sturm assistant responses are marker-only entries; their content is represented in persisted assistant history",
    "Sturm markers correspond chronologically to prior assistant responses in persisted assistant history",
    "the current Discord user message appears after this snapshot as the final user message in the model input"
  ].join("\n");
  const transcriptHeader = "Recent messages:";
  let keptLines = lines;
  while (
    [header, transcriptHeader, ...keptLines].join("\n").length >
      RECENT_CHANNEL_CONTEXT_MAX_CHARS &&
    keptLines.length > 1
  ) {
    keptLines = keptLines.slice(1);
  }

  const block = [header, transcriptHeader, ...keptLines].join("\n");
  return limitText(block, RECENT_CHANNEL_CONTEXT_MAX_CHARS);
}

function formatRecentDiscordChannelMessage(
  message: APIMessage,
  options: RecentDiscordChannelMessageOptions
): string {
  if (isCurrentSturmInteractionMessage(message, options)) return "";
  if (isSturmMessage(message, options)) {
    return `- ${formatMessageTimestamps(message)} Sturm (bot): [assistant response omitted; see persisted assistant history]`;
  }

  const body = formatMessageBody(message);
  if (!body) return "";

  const author = formatMessageAuthor(message, options.memberDisplayNames);
  return `- ${formatMessageTimestamps(message)} ${author}: ${body}`;
}

function formatMessageTimestamps(message: APIMessage) {
  return [
    formatUtcTimestampField("sent_at_utc", message.timestamp),
    message.edited_timestamp
      ? formatUtcTimestampField("edited_at_utc", message.edited_timestamp)
      : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function formatMessageAuthor(
  message: APIMessage,
  memberDisplayNames: Map<string, string>
) {
  const displayName =
    memberDisplayNames.get(message.author.id) ??
    message.author.global_name ??
    message.author.username;
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

function isCurrentSturmInteractionMessage(
  message: APIMessage,
  options: RecentDiscordChannelMessageOptions
) {
  return Boolean(
    options.currentInteractionId &&
    isSturmMessage(message, options) &&
    getMessageInteractionId(message) === options.currentInteractionId
  );
}

function isSturmMessage(
  message: APIMessage,
  options: RecentDiscordChannelMessageOptions
) {
  return Boolean(
    (options.applicationId &&
      message.application_id === options.applicationId) ||
    (options.botUserId && message.author.id === options.botUserId)
  );
}

function getMessageInteractionId(message: APIMessage) {
  return message.interaction_metadata?.id ?? message.interaction?.id;
}

async function resolveRecentMessageAuthorDisplayNames(
  env: DiscordChannelContextEnv,
  guildId: string | undefined,
  messages: APIMessage[]
) {
  const authorIds = getUniqueMessageAuthorIds(messages);
  if (!guildId || authorIds.length === 0) return new Map<string, string>();

  const results = await Promise.all(
    authorIds.map(async (authorId) => {
      try {
        const member = await getGuildMember(env, guildId, authorId, {
          maxWaitMs: RECENT_CHANNEL_CONTEXT_MAX_WAIT_MS
        });
        return [authorId, resolveDiscordMemberDisplayName(member)] as const;
      } catch {
        return undefined;
      }
    })
  );

  return new Map(results.filter((entry) => entry !== undefined));
}

function getUniqueMessageAuthorIds(messages: APIMessage[]) {
  return [...new Set(messages.map((message) => message.author.id))];
}

function isDiscordSnowflake(value: string) {
  return /^\d{8,}$/.test(value);
}

function limitText(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

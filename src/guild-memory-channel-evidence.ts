import type { RESTGetAPIChannelMessagesResult } from "discord-api-types/v10";
import type { GuildMemoryChannelMessageEvidence } from "./guild-memory-reflection-evidence-snapshot";

export const CHANNEL_REFLECTION_CHUNK_POLICY = {
  maxMessages: 50,
  maxContentChars: 24_000,
  maxMessageChars: 2_000,
  truncationMarker: "\n[truncated]"
} as const;

export type GuildMemoryStoredChannelMessage = {
  message_id: string;
  channel_id: string;
  channel_name: string | null;
  author_user_id: string;
  author_display_name: string | null;
  content: string;
  sent_at_utc: string;
};

export function createChannelMessageEvidence(
  message: RESTGetAPIChannelMessagesResult[number],
  channel: { channelId: string; channelName?: string }
): GuildMemoryChannelMessageEvidence | null {
  const content = message.content.trim();
  if (!content || message.author.bot || message.webhook_id) return null;
  const authorDisplayName =
    message.author.global_name?.trim() || message.author.username.trim();
  return {
    messageId: message.id,
    channelId: channel.channelId,
    ...(channel.channelName ? { channelName: channel.channelName } : {}),
    authorUserId: message.author.id,
    ...(authorDisplayName ? { authorDisplayName } : {}),
    content,
    sentAtUtc: new Date(message.timestamp).toISOString()
  };
}

export function selectChannelReflectionEvidence(
  rows: GuildMemoryStoredChannelMessage[]
) {
  const evidence: GuildMemoryChannelMessageEvidence[] = [];
  let contentChars = 0;
  for (const row of rows) {
    if (evidence.length >= CHANNEL_REFLECTION_CHUNK_POLICY.maxMessages) break;
    const content = truncateContent(
      row.content,
      CHANNEL_REFLECTION_CHUNK_POLICY.maxMessageChars
    );
    if (
      evidence.length > 0 &&
      contentChars + content.length >
        CHANNEL_REFLECTION_CHUNK_POLICY.maxContentChars
    ) {
      break;
    }
    evidence.push({
      messageId: row.message_id,
      channelId: row.channel_id,
      ...(row.channel_name ? { channelName: row.channel_name } : {}),
      authorUserId: row.author_user_id,
      ...(row.author_display_name
        ? { authorDisplayName: row.author_display_name }
        : {}),
      content,
      sentAtUtc: row.sent_at_utc
    });
    contentChars += content.length;
  }
  return evidence;
}

export function createChannelReflectionCorrelationId(
  prefix: "ambient" | "backfill",
  scopeId: string,
  messages: GuildMemoryChannelMessageEvidence[]
) {
  const first = messages[0];
  const last = messages.at(-1);
  if (!first || !last) {
    throw new Error("Channel memory reflection requires at least one message.");
  }
  return `${prefix}:${scopeId}:${first.messageId}:${last.messageId}:${messages.length}`;
}

function truncateContent(content: string, maxLength: number) {
  const trimmed = content.trim();
  return trimmed.length <= maxLength
    ? trimmed
    : `${trimmed.slice(0, maxLength)}${CHANNEL_REFLECTION_CHUNK_POLICY.truncationMarker}`;
}

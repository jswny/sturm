import type { DiscordChatRequest } from "./discord/types";
import type {
  GuildMemoryAmbientBatchEvidence,
  GuildMemoryBackfillBatchEvidence,
  GuildMemoryChannelMessageEvidence,
  GuildMemoryReflectionEvidence
} from "./guild-memory-reflection-evidence-snapshot";

export function formatGuildMemoryReflectionEvidence(
  evidence: GuildMemoryReflectionEvidence
) {
  switch (evidence.kind) {
    case "completed_turn":
      return formatCompletedTurnEvidence(
        evidence.request,
        evidence.assistantText
      );
    case "ambient_batch":
      return formatAmbientBatchEvidence(evidence);
    case "backfill_batch":
      return formatBackfillBatchEvidence(evidence);
  }
}

function formatCompletedTurnEvidence(
  request: DiscordChatRequest,
  assistantText: string
) {
  return [
    "User:",
    `discord_user_id: ${request.user?.id ?? request.userId ?? "unknown"}`,
    request.user?.displayName
      ? `display_name: ${request.user.displayName}`
      : "",
    `guild_id: ${request.guildId ?? "unknown"}`,
    `channel_id: ${request.channelId ?? "unknown"}`,
    "message:",
    truncateForReflection(request.text),
    "",
    "Assistant response:",
    truncateForReflection(assistantText)
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function formatAmbientBatchEvidence(evidence: GuildMemoryAmbientBatchEvidence) {
  return formatChannelBatchEvidence({
    source: "ambient_channel_observer",
    guildId: evidence.guildId,
    messages: evidence.messages
  });
}

function formatBackfillBatchEvidence(
  evidence: GuildMemoryBackfillBatchEvidence
) {
  return formatChannelBatchEvidence({
    source: "historical_channel_messages",
    guildId: evidence.guildId,
    messages: evidence.messages
  });
}

function formatChannelBatchEvidence(input: {
  source: "ambient_channel_observer" | "historical_channel_messages";
  guildId: string;
  messages: GuildMemoryChannelMessageEvidence[];
}) {
  return [
    `source: ${input.source}`,
    `guild_id: ${input.guildId}`,
    `message_count: ${input.messages.length}`,
    "messages:",
    ...input.messages.map((message) =>
      [
        `- message_id: ${message.messageId}`,
        `  channel_id: ${message.channelId}`,
        message.channelName ? `  channel_name: ${message.channelName}` : "",
        `  author_discord_user_id: ${message.authorUserId}`,
        message.authorDisplayName
          ? `  author_display_name: ${message.authorDisplayName}`
          : "",
        `  sent_at_utc: ${message.sentAtUtc}`,
        "  content:",
        indent(truncateForReflection(message.content, 2_000), 4)
      ]
        .filter((line) => line !== "")
        .join("\n")
    )
  ].join("\n");
}

function truncateForReflection(value: string, maxLength = 4_000) {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}\n[truncated]`;
}

function indent(value: string, spaces: number) {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

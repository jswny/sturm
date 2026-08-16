import type { DiscordChatRequest } from "./discord/types";
import type {
  GuildMemoryAmbientBatchEvidence,
  GuildMemoryReflectionEvidence
} from "./guild-memory-reflection-evidence-snapshot";

export function formatGuildMemoryReflectionEvidence(
  evidence: GuildMemoryReflectionEvidence
) {
  return evidence.kind === "completed_turn"
    ? formatCompletedTurnEvidence(evidence.request, evidence.assistantText)
    : formatAmbientBatchEvidence(evidence);
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
  return [
    "source: ambient_channel_observer",
    `guild_id: ${evidence.guildId}`,
    `message_count: ${evidence.messages.length}`,
    "messages:",
    ...evidence.messages.map((message) =>
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

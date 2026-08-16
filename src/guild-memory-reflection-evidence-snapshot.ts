import type { DiscordChatRequest } from "./discord/types";

export type GuildMemoryCompletedTurnEvidence = {
  kind: "completed_turn";
  request: DiscordChatRequest;
  assistantText: string;
};

export type GuildMemoryAmbientMessageEvidence = {
  messageId: string;
  channelId: string;
  channelName?: string;
  authorUserId: string;
  authorDisplayName?: string;
  content: string;
  sentAtUtc: string;
};

export type GuildMemoryAmbientBatchEvidence = {
  kind: "ambient_batch";
  guildId: string;
  messages: GuildMemoryAmbientMessageEvidence[];
};

export type GuildMemoryReflectionEvidence =
  | GuildMemoryCompletedTurnEvidence
  | GuildMemoryAmbientBatchEvidence;

export function createCompletedTurnMemoryEvidence(
  request: DiscordChatRequest,
  assistantText: string
): GuildMemoryCompletedTurnEvidence {
  return {
    kind: "completed_turn",
    request,
    assistantText
  };
}

export function createAmbientBatchMemoryEvidence(
  guildId: string,
  messages: GuildMemoryAmbientMessageEvidence[]
): GuildMemoryAmbientBatchEvidence {
  return {
    kind: "ambient_batch",
    guildId,
    messages
  };
}

export function parseGuildMemoryReflectionEvidence(
  value: unknown
): GuildMemoryReflectionEvidence | null {
  if (!isObject(value)) return null;
  if (value.kind === "completed_turn") {
    if (!isDiscordChatRequest(value.request)) return null;
    if (typeof value.assistantText !== "string") return null;
    return createCompletedTurnMemoryEvidence(
      value.request,
      value.assistantText
    );
  }

  if (value.kind !== "ambient_batch") return null;
  if (typeof value.guildId !== "string") return null;
  if (!Array.isArray(value.messages) || value.messages.length === 0)
    return null;
  const messages = value.messages.map(parseAmbientMessageEvidence);
  if (messages.some((message) => message === null)) return null;
  return createAmbientBatchMemoryEvidence(
    value.guildId,
    messages as GuildMemoryAmbientMessageEvidence[]
  );
}

export function parseLegacyCompletedTurnMemoryEvidence(
  value: Record<string, unknown>
): GuildMemoryCompletedTurnEvidence | null {
  if (!isDiscordChatRequest(value.request)) return null;
  if (typeof value.assistantText !== "string") return null;
  return createCompletedTurnMemoryEvidence(value.request, value.assistantText);
}

function parseAmbientMessageEvidence(
  value: unknown
): GuildMemoryAmbientMessageEvidence | null {
  if (!isObject(value)) return null;
  if (typeof value.messageId !== "string") return null;
  if (typeof value.channelId !== "string") return null;
  if (
    value.channelName !== undefined &&
    typeof value.channelName !== "string"
  ) {
    return null;
  }
  if (typeof value.authorUserId !== "string") return null;
  if (
    value.authorDisplayName !== undefined &&
    typeof value.authorDisplayName !== "string"
  ) {
    return null;
  }
  if (typeof value.content !== "string") return null;
  if (typeof value.sentAtUtc !== "string") return null;
  return {
    messageId: value.messageId,
    channelId: value.channelId,
    ...(value.channelName ? { channelName: value.channelName } : {}),
    authorUserId: value.authorUserId,
    ...(value.authorDisplayName
      ? { authorDisplayName: value.authorDisplayName }
      : {}),
    content: value.content,
    sentAtUtc: value.sentAtUtc
  };
}

function isDiscordChatRequest(value: unknown): value is DiscordChatRequest {
  return (
    isObject(value) &&
    typeof value.correlationId === "string" &&
    typeof value.text === "string"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

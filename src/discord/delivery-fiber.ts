import type { ChatResponseResult } from "@cloudflare/think";
import type { DiscordChatDeliveryRecord } from "./delivery";

const DISCORD_DELIVERY_FIBER_PREFIX = "discord-response-delivery:";

type DiscordDeliveryFiberSnapshotBase = {
  kind: "discord_response_delivery";
  version: 1;
  correlationId: string;
};

export type DiscordDeliveryFiberSnapshot =
  | (DiscordDeliveryFiberSnapshotBase & {
      action: "chat_response";
      result: ChatResponseResult;
    })
  | (DiscordDeliveryFiberSnapshotBase & {
      action: "completed_without_response";
    })
  | (DiscordDeliveryFiberSnapshotBase & {
      action: "failure";
      error: string;
      userMessage?: string;
    });

export function createDiscordDeliveryFiberSnapshot(
  record: DiscordChatDeliveryRecord,
  result: ChatResponseResult
): DiscordDeliveryFiberSnapshot {
  if (result.status !== "completed") {
    throw new Error("Discord delivery fibers require a completed chat result.");
  }

  return {
    kind: "discord_response_delivery",
    version: 1,
    correlationId: record.correlationId,
    action: "chat_response",
    result
  };
}

export function createCompletedDiscordDeliveryFiberSnapshot(
  record: DiscordChatDeliveryRecord
): DiscordDeliveryFiberSnapshot {
  return {
    kind: "discord_response_delivery",
    version: 1,
    correlationId: record.correlationId,
    action: "completed_without_response"
  };
}

export function createFailedDiscordDeliveryFiberSnapshot(
  record: DiscordChatDeliveryRecord,
  error: string,
  userMessage?: string
): DiscordDeliveryFiberSnapshot {
  return {
    kind: "discord_response_delivery",
    version: 1,
    correlationId: record.correlationId,
    action: "failure",
    error,
    userMessage
  };
}

export function parseDiscordDeliveryFiberSnapshot(
  value: unknown
): DiscordDeliveryFiberSnapshot | null {
  if (!isObject(value)) return null;
  if (value.kind !== "discord_response_delivery" || value.version !== 1) {
    return null;
  }
  if (typeof value.correlationId !== "string") return null;

  if (value.action === "completed_without_response") {
    return value as DiscordDeliveryFiberSnapshot;
  }
  if (value.action === "failure") {
    if (typeof value.error !== "string") return null;
    if (
      value.userMessage !== undefined &&
      typeof value.userMessage !== "string"
    ) {
      return null;
    }
    return value as DiscordDeliveryFiberSnapshot;
  }
  if (value.action !== "chat_response") return null;
  if (!isObject(value.result)) return null;
  if (value.result.status !== "completed") return null;
  if (typeof value.result.requestId !== "string") return null;
  if (typeof value.result.continuation !== "boolean") return null;
  if (!isObject(value.result.message)) return null;
  if (typeof value.result.message.id !== "string") return null;
  if (value.result.message.role !== "assistant") return null;
  if (!Array.isArray(value.result.message.parts)) return null;

  return value as DiscordDeliveryFiberSnapshot;
}

export function getDiscordDeliveryFiberName(correlationId: string) {
  return `${DISCORD_DELIVERY_FIBER_PREFIX}${correlationId}`;
}

export function getDiscordDeliveryFiberCorrelationId(name: string) {
  return name.startsWith(DISCORD_DELIVERY_FIBER_PREFIX)
    ? name.slice(DISCORD_DELIVERY_FIBER_PREFIX.length)
    : undefined;
}

export function createDiscordDeliveryFiberMetadata(
  record: DiscordChatDeliveryRecord
) {
  return {
    type: "discord_response_delivery",
    correlationId: record.correlationId,
    discordInteractionId: record.discordInteractionId,
    sequence: record.sequence,
    responseTargetType: record.responseTarget.type
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

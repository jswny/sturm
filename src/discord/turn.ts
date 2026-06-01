import type { UIMessage } from "ai";
import {
  hydrateStoredArtifacts,
  type ResponseArtifact,
  type StoredResponseArtifact
} from "../artifacts";
import {
  formatAssistantMessageText,
  formatDiscordResponseText,
  formatDiscordUserMessage
} from "./format";
import type { DiscordChatRequest, DiscordChatResponse } from "./types";

type DiscordUserMessageMetadata = {
  source?: unknown;
  interactionId?: unknown;
  guildId?: unknown;
  channelId?: unknown;
  channel?: unknown;
  appPermissions?: unknown;
  userId?: unknown;
  user?: unknown;
  userPermissions?: unknown;
};

export type DiscordSessionMemory = {
  getPathLength(): Promise<number>;
  clearMessages(): Promise<void>;
  clearWorkspace?(): Promise<number>;
};

export function createDiscordUserMessage(
  request: DiscordChatRequest
): UIMessage {
  return {
    id: `discord-${request.interactionId}`,
    role: "user",
    metadata: {
      source: "discord",
      interactionId: request.interactionId,
      guildId: request.guildId,
      channelId: request.channelId,
      channel: request.channel,
      appPermissions: request.appPermissions,
      userId: request.userId,
      user: request.user,
      userPermissions: request.userPermissions
    },
    parts: [{ type: "text", text: formatDiscordUserMessage(request) }]
  };
}

export function getDiscordTurnFromUserMessage(
  message: UIMessage
): DiscordChatRequest | undefined {
  if (message.role !== "user") return undefined;

  const metadata = message.metadata as DiscordUserMessageMetadata;
  if (metadata?.source !== "discord") return undefined;
  if (typeof metadata.interactionId !== "string") return undefined;

  return {
    interactionId: metadata.interactionId,
    text: "",
    guildId:
      typeof metadata.guildId === "string" ? metadata.guildId : undefined,
    channelId:
      typeof metadata.channelId === "string" ? metadata.channelId : undefined,
    channel: getDiscordChannelMetadata(metadata.channel),
    appPermissions: getDiscordPermissionMetadata(metadata.appPermissions),
    userId: typeof metadata.userId === "string" ? metadata.userId : undefined,
    user: getDiscordUserMetadata(metadata.user),
    userPermissions:
      typeof metadata.userPermissions === "string"
        ? metadata.userPermissions
        : undefined
  };
}

export function createDiscordResponseFromAssistantMessage(
  text: string,
  artifacts: ResponseArtifact[]
): DiscordChatResponse {
  return {
    content: formatDiscordResponseText(text, artifacts),
    attachments: artifacts.map((artifact) => ({
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      artifactKey: artifact.artifactKey,
      sha256: artifact.sha256,
      base64: artifact.base64,
      description: formatAttachmentDescription(artifact)
    }))
  };
}

export function createAssistantHistoryText(
  text: string,
  artifacts: ResponseArtifact[]
) {
  return formatAssistantMessageText(text, artifacts);
}

export async function hydrateStoredResponseArtifacts(
  env: Env,
  storedArtifacts: StoredResponseArtifact[] = []
): Promise<ResponseArtifact[]> {
  return hydrateStoredArtifacts(env, storedArtifacts);
}

export async function clearDiscordSession(
  session: DiscordSessionMemory
): Promise<DiscordChatResponse> {
  const messageCount = await session.getPathLength();
  await session.clearMessages();
  const workspaceRootEntries = await session.clearWorkspace?.();
  return {
    content: formatResetResponse(messageCount, workspaceRootEntries)
  };
}

function formatResetResponse(
  messageCount: number,
  workspaceRootEntries: number | undefined
) {
  const messageText =
    messageCount === 1
      ? "Cleared 1 message"
      : `Cleared ${messageCount} messages`;

  if (workspaceRootEntries === undefined) {
    return `Reset context. ${messageText}.`;
  }

  const workspaceText =
    workspaceRootEntries === 0
      ? "channel workspace was already empty"
      : "cleared channel workspace";

  return `Reset context. ${messageText}; ${workspaceText}.`;
}

function formatAttachmentDescription(artifact: ResponseArtifact) {
  const description =
    artifact.description ??
    (artifact.source === "image_generation"
      ? `Generated image for: ${artifact.metadata.prompt}`
      : `Sturm artifact: ${artifact.filename}`);

  return description.slice(0, 1024);
}

export function getDiscordMessageText(message: UIMessage) {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}

export function withAssistantText(message: UIMessage, text: string): UIMessage {
  return {
    ...message,
    parts: [{ type: "text", text }]
  };
}

function getDiscordUserMetadata(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const user = value as { id?: unknown; displayName?: unknown };
  if (typeof user.id !== "string") return undefined;
  return {
    id: user.id,
    displayName:
      typeof user.displayName === "string" ? user.displayName : undefined
  };
}

function getDiscordChannelMetadata(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const channel = value as {
    id?: unknown;
    guildId?: unknown;
    name?: unknown;
    type?: unknown;
    typeName?: unknown;
    topic?: unknown;
    parentId?: unknown;
    nsfw?: unknown;
    slowmodeSeconds?: unknown;
  };
  if (typeof channel.id !== "string") return undefined;

  return {
    id: channel.id,
    guildId: typeof channel.guildId === "string" ? channel.guildId : undefined,
    name: typeof channel.name === "string" ? channel.name : undefined,
    type: typeof channel.type === "number" ? channel.type : undefined,
    typeName:
      typeof channel.typeName === "string" ? channel.typeName : undefined,
    topic: typeof channel.topic === "string" ? channel.topic : undefined,
    parentId:
      typeof channel.parentId === "string" ? channel.parentId : undefined,
    nsfw: typeof channel.nsfw === "boolean" ? channel.nsfw : undefined,
    slowmodeSeconds:
      typeof channel.slowmodeSeconds === "number"
        ? channel.slowmodeSeconds
        : undefined
  };
}

function getDiscordPermissionMetadata(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const permissions = value as { raw?: unknown; names?: unknown };
  if (typeof permissions.raw !== "string") return undefined;

  return {
    raw: permissions.raw,
    names: Array.isArray(permissions.names)
      ? permissions.names.filter((name) => typeof name === "string")
      : []
  };
}

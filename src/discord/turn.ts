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
  correlationId?: unknown;
  discordInteractionId?: unknown;
  sourceCorrelationId?: unknown;
  sourceInteractionId?: unknown;
  emptyResponseBehavior?: unknown;
  guildId?: unknown;
  channelId?: unknown;
  channel?: unknown;
  attachments?: unknown;
  app?: unknown;
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
    id: `discord-${request.correlationId}`,
    role: "user",
    metadata: {
      source: "discord",
      correlationId: request.correlationId,
      discordInteractionId: request.discordInteractionId,
      sourceCorrelationId: request.sourceCorrelationId,
      sourceInteractionId: request.sourceInteractionId,
      emptyResponseBehavior: request.emptyResponseBehavior,
      guildId: request.guildId,
      channelId: request.channelId,
      channel: request.channel,
      attachments: request.attachments,
      app: request.app,
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
  if (typeof metadata.correlationId !== "string") return undefined;

  return {
    correlationId: metadata.correlationId,
    discordInteractionId:
      typeof metadata.discordInteractionId === "string"
        ? metadata.discordInteractionId
        : undefined,
    sourceCorrelationId:
      typeof metadata.sourceCorrelationId === "string"
        ? metadata.sourceCorrelationId
        : undefined,
    sourceInteractionId:
      typeof metadata.sourceInteractionId === "string"
        ? metadata.sourceInteractionId
        : undefined,
    text: "",
    emptyResponseBehavior:
      metadata.emptyResponseBehavior === "suppress" ? "suppress" : undefined,
    guildId:
      typeof metadata.guildId === "string" ? metadata.guildId : undefined,
    channelId:
      typeof metadata.channelId === "string" ? metadata.channelId : undefined,
    channel: getDiscordChannelMetadata(metadata.channel),
    attachments: getDiscordAttachmentMetadata(metadata.attachments),
    app: getDiscordAppMetadata(metadata.app),
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

function getDiscordAppMetadata(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const app = value as { applicationId?: unknown; botUserId?: unknown };
  return {
    applicationId:
      typeof app.applicationId === "string" ? app.applicationId : undefined,
    botUserId: typeof app.botUserId === "string" ? app.botUserId : undefined
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

function getDiscordAttachmentMetadata(value: unknown) {
  if (!Array.isArray(value)) return undefined;

  return value
    .map((item) => {
      if (!item || typeof item !== "object") return undefined;
      const attachment = item as {
        id?: unknown;
        filename?: unknown;
        mimeType?: unknown;
        sizeBytes?: unknown;
        url?: unknown;
        proxyUrl?: unknown;
        width?: unknown;
        height?: unknown;
        description?: unknown;
      };
      if (
        typeof attachment.id !== "string" ||
        typeof attachment.filename !== "string" ||
        typeof attachment.sizeBytes !== "number" ||
        typeof attachment.url !== "string"
      ) {
        return undefined;
      }

      return {
        id: attachment.id,
        filename: attachment.filename,
        mimeType:
          typeof attachment.mimeType === "string"
            ? attachment.mimeType
            : undefined,
        sizeBytes: attachment.sizeBytes,
        url: attachment.url,
        proxyUrl:
          typeof attachment.proxyUrl === "string"
            ? attachment.proxyUrl
            : undefined,
        width:
          typeof attachment.width === "number" ? attachment.width : undefined,
        height:
          typeof attachment.height === "number" ? attachment.height : undefined,
        description:
          typeof attachment.description === "string"
            ? attachment.description
            : undefined
      };
    })
    .filter((attachment) => attachment !== undefined);
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

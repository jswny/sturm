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

import type { UIMessage } from "ai";
import type { GeneratedImage } from "../images";
import type { StoredGeneratedImage } from "./delivery";
import {
  formatAssistantMessageText,
  formatDiscordResponseText,
  formatDiscordUserMessage
} from "./format";
import type { DiscordChatRequest, DiscordChatResponse } from "./types";

export type DiscordSessionMemory = {
  getPathLength(): Promise<number>;
  clearMessages(): Promise<void>;
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
      userId: request.userId,
      user: request.user,
      userPermissions: request.userPermissions
    },
    parts: [{ type: "text", text: formatDiscordUserMessage(request) }]
  };
}

export function createDiscordResponseFromAssistantMessage(
  text: string,
  artifacts: GeneratedImage[]
): DiscordChatResponse {
  return {
    content: formatDiscordResponseText(text, artifacts),
    attachments: artifacts.map((artifact) => ({
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      r2Key: artifact.r2Key,
      base64: artifact.base64,
      description: `Generated image for: ${artifact.prompt}`
    }))
  };
}

export function createAssistantHistoryText(
  text: string,
  artifacts: GeneratedImage[]
) {
  return formatAssistantMessageText(text, artifacts);
}

export async function hydrateStoredGeneratedImages(
  env: Env,
  storedImages: StoredGeneratedImage[] = []
): Promise<GeneratedImage[]> {
  return Promise.all(
    storedImages.map(async (stored) => {
      const object = await env.ARTIFACTS_BUCKET.get(stored.r2Key);
      if (!object) {
        throw new Error(`Missing R2 artifact ${stored.r2Key}.`);
      }

      return {
        ...stored,
        base64: bytesToBase64(new Uint8Array(await object.arrayBuffer()))
      };
    })
  );
}

export async function clearDiscordSession(
  session: DiscordSessionMemory
): Promise<DiscordChatResponse> {
  const messageCount = await session.getPathLength();
  await session.clearMessages();
  return {
    content:
      messageCount === 1
        ? "Reset context. Cleared 1 message."
        : `Reset context. Cleared ${messageCount} messages.`
  };
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

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

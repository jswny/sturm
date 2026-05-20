import {
  convertToModelMessages,
  generateText,
  stepCountIs,
  type UIMessage
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { GeneratedImage } from "../images";
import { CHAT_MODEL, REPLY_PROVIDER_OPTIONS } from "../model";
import { createSystemPrompt } from "../prompts";
import { createDiscordTools } from "../tools";
import {
  formatAssistantMessageText,
  formatDiscordResponseText,
  formatDiscordUserMessage,
  inlineDataUrls
} from "./format";
import type { DiscordChatRequest, DiscordChatResponse } from "./types";

export type DiscordSessionMemory = {
  appendMessage(message: UIMessage): Promise<void>;
  getHistory(): Promise<unknown[]>;
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
      user: request.user
    },
    parts: [{ type: "text", text: formatDiscordUserMessage(request) }]
  };
}

export async function createDiscordAssistantResponse(
  env: Env,
  session: DiscordSessionMemory,
  sessionAffinity: string,
  request: DiscordChatRequest
): Promise<DiscordChatResponse> {
  const workersai = createWorkersAI({ binding: env.AI });
  const history = (await session.getHistory()) as UIMessage[];
  const imageArtifacts: GeneratedImage[] = [];
  const result = await generateText({
    model: workersai(CHAT_MODEL, {
      sessionAffinity
    }),
    providerOptions: REPLY_PROVIDER_OPTIONS,
    system: createSystemPrompt(),
    messages: inlineDataUrls(await convertToModelMessages(history)),
    tools: createDiscordTools(env, {
      onImageGenerated: (artifact) => imageArtifacts.push(artifact)
    }),
    stopWhen: stepCountIs(5)
  });
  const assistantText = formatAssistantMessageText(result.text, imageArtifacts);
  const responseText = formatDiscordResponseText(result.text, imageArtifacts);

  const assistantMessage: UIMessage = {
    id: `discord-${request.interactionId}-assistant`,
    role: "assistant",
    metadata: {
      source: "discord",
      interactionId: request.interactionId,
      guildId: request.guildId,
      channelId: request.channelId,
      userId: request.userId,
      user: request.user
    },
    parts: [{ type: "text", text: assistantText }]
  };
  await session.appendMessage(assistantMessage);

  return {
    content: responseText,
    attachments: imageArtifacts.map((artifact) => ({
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      base64: artifact.base64,
      description: `Generated image for: ${artifact.prompt}`
    }))
  };
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

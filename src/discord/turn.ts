import {
  convertToModelMessages,
  generateText,
  stepCountIs,
  type ToolSet,
  type UIMessage
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { GeneratedImage } from "../images";
import { CHAT_MODEL, REPLY_PROVIDER_OPTIONS } from "../model";
import { createSystemPrompt } from "../prompts";
import { createDiscordCodeModeTool, createDiscordTools } from "../tools";
import {
  formatAssistantMessageText,
  formatDiscordResponseText,
  formatDiscordUserMessage,
  inlineDataUrls
} from "./format";
import type {
  DiscordChatRequest,
  DiscordChatResponse,
  DiscordGeneratedChatResponse
} from "./types";

export type DiscordSessionMemory = {
  appendMessage(message: UIMessage): Promise<void>;
  getHistory(): Promise<unknown[]>;
  getPathLength(): Promise<number>;
  clearMessages(): Promise<void>;
  refreshSystemPrompt(): Promise<string>;
  tools(): Promise<ToolSet>;
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
  const turn = await createDiscordAssistantTurn(
    env,
    session,
    sessionAffinity,
    request
  );
  await session.appendMessage(turn.assistantMessage);
  return turn.response;
}

export async function createDiscordAssistantTurn(
  env: Env,
  session: DiscordSessionMemory,
  sessionAffinity: string,
  request: DiscordChatRequest
): Promise<{
  response: DiscordChatResponse;
  generatedResponse: DiscordGeneratedChatResponse;
  assistantMessage: UIMessage;
}> {
  const workersai = createWorkersAI({ binding: env.AI });
  const history = (await session.getHistory()) as UIMessage[];
  const imageArtifacts: GeneratedImage[] = [];
  const directTools = {
    ...createDiscordTools(env, {
      discordRequest: request,
      onImageGenerated: (artifact) => imageArtifacts.push(artifact)
    }),
    ...(await session.tools())
  };
  const result = await generateText({
    model: workersai(CHAT_MODEL, {
      sessionAffinity
    }),
    providerOptions: REPLY_PROVIDER_OPTIONS,
    system: createDiscordTurnSystemPrompt(await session.refreshSystemPrompt()),
    messages: inlineDataUrls(await convertToModelMessages(history)),
    tools: {
      codemode: createDiscordCodeModeTool(env, directTools)
    },
    stopWhen: stepCountIs(5)
  });
  const assistantText = formatAssistantMessageText(result.text, imageArtifacts);
  const responseText = formatDiscordResponseText(result.text, imageArtifacts);

  const assistantMessage = createDiscordAssistantMessage(
    request,
    assistantText
  );
  const response = {
    content: responseText,
    attachments: imageArtifacts.map((artifact) => ({
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      r2Key: artifact.r2Key,
      base64: artifact.base64,
      description: `Generated image for: ${artifact.prompt}`
    }))
  };
  const generatedResponse: DiscordGeneratedChatResponse = {
    content: response.content,
    assistantMessageText: assistantText,
    attachments: response.attachments?.map((attachment) => {
      if (!attachment.r2Key) {
        throw new Error(
          `Generated attachment ${attachment.filename} is missing an R2 key.`
        );
      }
      return {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        r2Key: attachment.r2Key,
        description: attachment.description
      };
    }),
    generatedAt: new Date().toISOString()
  };

  return { response, generatedResponse, assistantMessage };
}

export async function hydrateDiscordGeneratedResponse(
  env: Env,
  generatedResponse: DiscordGeneratedChatResponse
): Promise<DiscordChatResponse> {
  return {
    content: generatedResponse.content,
    attachments: await Promise.all(
      (generatedResponse.attachments ?? []).map(async (attachment) => {
        const object = await env.ARTIFACTS_BUCKET.get(attachment.r2Key);
        if (!object) {
          throw new Error(`Missing R2 artifact ${attachment.r2Key}.`);
        }

        return {
          ...attachment,
          base64: bytesToBase64(new Uint8Array(await object.arrayBuffer()))
        };
      })
    )
  };
}

export function createDiscordAssistantMessage(
  request: DiscordChatRequest,
  text: string
): UIMessage {
  return {
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
    parts: [{ type: "text", text }]
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

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function createDiscordTurnSystemPrompt(contextPrompt: string) {
  if (!contextPrompt.trim()) return createSystemPrompt();
  return `${createSystemPrompt()}

${contextPrompt}`;
}

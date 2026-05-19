import { Agent } from "agents";
import { Session } from "agents/experimental/memory/session";
import { createCompactFunction } from "agents/experimental/memory/utils";
import {
  convertToModelMessages,
  generateText,
  stepCountIs,
  type ModelMessage,
  type UIMessage
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { DiscordChatRequest, DiscordChatResponse } from "./discord";
import type { GeneratedImage } from "./images";
import {
  CHAT_MODEL,
  COMPACTION_PROVIDER_OPTIONS,
  COMPACTION_TAIL_TOKEN_BUDGET,
  COMPACTION_TOKEN_THRESHOLD,
  REPLY_PROVIDER_OPTIONS
} from "./model";
import { createSystemPrompt } from "./prompts";
import { createDiscordTools } from "./tools";

/**
 * The AI SDK's downloadAssets step runs `new URL(data)` on every file
 * part's string data. Data URIs parse as valid URLs, so it tries to
 * HTTP-fetch them and fails. Decode to Uint8Array so the SDK treats
 * them as inline data instead.
 */
function inlineDataUrls(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "user" || typeof msg.content === "string") return msg;
    return {
      ...msg,
      content: msg.content.map((part) => {
        if (part.type !== "file" || typeof part.data !== "string") return part;
        const match = part.data.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return part;
        const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
        return { ...part, data: bytes, mediaType: match[1] };
      })
    };
  });
}

function formatDiscordUserMessage(request: DiscordChatRequest) {
  const lines = ["Discord user:"];
  if (request.user?.id) lines.push(`id: ${request.user.id}`);
  if (request.user?.displayName) {
    lines.push(`display_name: ${request.user.displayName}`);
  }

  return `${lines.join("\n")}

User message:
${request.text}`;
}

function formatImageArtifactMessage(artifacts: GeneratedImage[]) {
  if (artifacts.length === 0) return "";

  return artifacts
    .map(
      (artifact) =>
        `Generated image:\nprompt: ${artifact.prompt}\nmodel: ${artifact.model}\nsize: ${artifact.width}x${artifact.height}\nstatus: sent as attachment`
    )
    .join("\n\n");
}

function formatAssistantMessageText(text: string, artifacts: GeneratedImage[]) {
  const artifactMessage = formatImageArtifactMessage(artifacts);
  const trimmed = text.trim();

  if (trimmed && artifactMessage) return `${trimmed}\n\n${artifactMessage}`;
  return trimmed || artifactMessage || "I did not get a text response.";
}

function formatDiscordResponseText(text: string, artifacts: GeneratedImage[]) {
  const trimmed = text.trim();
  if (trimmed) return trimmed;
  if (artifacts.length === 1) return "Generated image.";
  if (artifacts.length > 1) return `Generated ${artifacts.length} images.`;
  return "I did not get a text response.";
}

export class ChatAgent extends Agent<Env> {
  private discordTurn = Promise.resolve();
  private session = Session.create(this)
    .onCompaction(
      createCompactFunction({
        summarize: async (prompt) => {
          const workersai = createWorkersAI({ binding: this.env.AI });
          const result = await generateText({
            model: workersai(CHAT_MODEL, {
              sessionAffinity: this.sessionAffinity
            }),
            providerOptions: COMPACTION_PROVIDER_OPTIONS,
            system:
              "Summarize Discord conversation history for future assistant context. Preserve factual details, user preferences, decisions, current state, and open items.",
            prompt
          });
          return result.text;
        },
        protectHead: 2,
        tailTokenBudget: COMPACTION_TAIL_TOKEN_BUDGET,
        minTailMessages: 6
      })
    )
    .compactAfter(COMPACTION_TOKEN_THRESHOLD);

  askFromDiscord(request: DiscordChatRequest): Promise<DiscordChatResponse> {
    const run = this.discordTurn.then(() => this.answerFromDiscord(request));
    this.discordTurn = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  resetFromDiscord(): Promise<DiscordChatResponse> {
    const run = this.discordTurn.then(() => {
      const messageCount = this.session.getPathLength();
      this.session.clearMessages();
      return {
        content:
          messageCount === 1
            ? "Reset context. Cleared 1 message."
            : `Reset context. Cleared ${messageCount} messages.`
      };
    });
    this.discordTurn = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async answerFromDiscord(
    request: DiscordChatRequest
  ): Promise<DiscordChatResponse> {
    const userMessage: UIMessage = {
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

    await this.session.appendMessage(userMessage);

    const workersai = createWorkersAI({ binding: this.env.AI });
    const history = this.session.getHistory() as UIMessage[];
    const imageArtifacts: GeneratedImage[] = [];
    const result = await generateText({
      model: workersai(CHAT_MODEL, {
        sessionAffinity: this.sessionAffinity
      }),
      providerOptions: REPLY_PROVIDER_OPTIONS,
      system: createSystemPrompt(),
      messages: inlineDataUrls(await convertToModelMessages(history)),
      tools: createDiscordTools(this.env, {
        onImageGenerated: (artifact) => imageArtifacts.push(artifact)
      }),
      stopWhen: stepCountIs(5)
    });
    const assistantText = formatAssistantMessageText(
      result.text,
      imageArtifacts
    );
    const responseText = formatDiscordResponseText(result.text, imageArtifacts);

    const assistantMessage: UIMessage = {
      id: `${userMessage.id}-assistant`,
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
    await this.session.appendMessage(assistantMessage);

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
}

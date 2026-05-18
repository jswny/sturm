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
import {
  CHAT_MODEL,
  COMPACTION_PROVIDER_OPTIONS,
  COMPACTION_TAIL_TOKEN_BUDGET,
  COMPACTION_TOKEN_THRESHOLD,
  REPLY_PROVIDER_OPTIONS,
  SYSTEM_PROMPT
} from "./model";
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

function extractAssistantText(message: UIMessage | undefined) {
  if (!message) return "";
  return message.parts
    .filter(
      (part): part is Extract<typeof part, { type: "text" }> =>
        part.type === "text"
    )
    .map((part) => part.text)
    .join("\n\n")
    .trim();
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
        userId: request.userId
      },
      parts: [{ type: "text", text: request.text }]
    };

    await this.session.appendMessage(userMessage);

    const workersai = createWorkersAI({ binding: this.env.AI });
    const history = this.session.getHistory() as UIMessage[];
    const result = await generateText({
      model: workersai(CHAT_MODEL, {
        sessionAffinity: this.sessionAffinity
      }),
      providerOptions: REPLY_PROVIDER_OPTIONS,
      system: SYSTEM_PROMPT,
      messages: inlineDataUrls(await convertToModelMessages(history)),
      tools: createDiscordTools(),
      stopWhen: stepCountIs(5)
    });

    const assistantMessage: UIMessage = {
      id: `${userMessage.id}-assistant`,
      role: "assistant",
      metadata: {
        source: "discord",
        interactionId: request.interactionId,
        guildId: request.guildId,
        channelId: request.channelId,
        userId: request.userId
      },
      parts: [{ type: "text", text: result.text }]
    };
    await this.session.appendMessage(assistantMessage);

    return { content: extractAssistantText(assistantMessage) };
  }
}

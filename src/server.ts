import { Agent } from "agents";
import { Session } from "agents/experimental/memory/session";
import { createCompactFunction } from "agents/experimental/memory/utils";
import {
  convertToModelMessages,
  generateText,
  stepCountIs,
  tool,
  type ModelMessage,
  type UIMessage
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import {
  handleDiscordRequest,
  type DiscordChatRequest,
  type DiscordChatResponse
} from "./discord";

const CHAT_MODEL = "@cf/moonshotai/kimi-k2.6";
const SYSTEM_PROMPT =
  "You are Sturm, a helpful assistant replying from a Discord slash command. Keep responses concise and Discord-friendly.";
const COMPACTION_TOKEN_THRESHOLD = 200_000;
const COMPACTION_TAIL_TOKEN_BUDGET = 64_000;
const REPLY_PROVIDER_OPTIONS = {
  "workers-ai": {
    reasoning_effort: "low",
    chat_template_kwargs: { thinking: true }
  }
} as const;
const COMPACTION_PROVIDER_OPTIONS = {
  "workers-ai": {
    reasoning_effort: null,
    chat_template_kwargs: { thinking: false }
  }
} as const;

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

function createDiscordTools() {
  return {
    getWeather: tool({
      description: "Get the current weather for a city",
      inputSchema: z.object({
        city: z.string().describe("City name")
      }),
      execute: async ({ city }) => {
        // Replace with a real weather API in production.
        const conditions = ["sunny", "cloudy", "rainy", "snowy"];
        const temp = Math.floor(Math.random() * 30) + 5;
        return {
          city,
          temperature: temp,
          condition: conditions[Math.floor(Math.random() * conditions.length)],
          unit: "celsius"
        };
      }
    }),

    calculate: tool({
      description: "Perform a math calculation with two numbers.",
      inputSchema: z.object({
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
        operator: z
          .enum(["+", "-", "*", "/", "%"])
          .describe("Arithmetic operator")
      }),
      execute: async ({ a, b, operator }) => {
        const ops: Record<string, (x: number, y: number) => number> = {
          "+": (x, y) => x + y,
          "-": (x, y) => x - y,
          "*": (x, y) => x * y,
          "/": (x, y) => x / y,
          "%": (x, y) => x % y
        };
        if (operator === "/" && b === 0) {
          return { error: "Division by zero" };
        }
        return {
          expression: `${a} ${operator} ${b}`,
          result: ops[operator](a, b)
        };
      }
    })
  };
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return (
      (await handleDiscordRequest(request, env, ctx)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

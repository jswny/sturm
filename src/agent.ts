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
import {
  editOriginalInteractionResponse,
  type DiscordChatRequest,
  type DiscordChatResponse,
  type DiscordResponseTarget,
  type DiscordUserContext
} from "./discord";
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

type DiscordQueueMeta = {
  nextSequence: number;
  scheduled: boolean;
  processing: boolean;
};

type DiscordQueuedChatJob = {
  type: "chat";
  sequence: number;
  interactionId: string;
  responseTarget: DiscordResponseTarget;
  request: DiscordChatRequest;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  userMessageAppended?: boolean;
  lastError?: string;
};

type DiscordQueuedResetJob = {
  type: "reset";
  sequence: number;
  interactionId: string;
  responseTarget: DiscordResponseTarget;
  guildId?: string;
  channelId?: string;
  userId?: string;
  user?: DiscordUserContext;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
};

type DiscordQueuedJob = DiscordQueuedChatJob | DiscordQueuedResetJob;

type DiscordInteractionRecord = {
  sequence: number;
  status: "pending" | "completed" | "failed";
  updatedAt: string;
};

export type DiscordQueuedChatInput = {
  request: DiscordChatRequest;
  responseTarget: DiscordResponseTarget;
};

export type DiscordQueuedResetInput = {
  interactionId: string;
  responseTarget: DiscordResponseTarget;
  guildId?: string;
  channelId?: string;
  userId?: string;
  user?: DiscordUserContext;
};

const DISCORD_QUEUE_META_KEY = "discord:queue:meta";
const DISCORD_JOB_PREFIX = "discord:queue:job:";
const DISCORD_INTERACTION_PREFIX = "discord:queue:interaction:";
const MAX_DISCORD_JOB_ATTEMPTS = 3;
const DISCORD_QUEUE_DRAIN_SECONDS = 13 * 60;
const DISCORD_QUEUE_DRAIN_PAYLOAD = { kind: "discord-queue-drain" } as const;

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

function getDefaultQueueMeta(): DiscordQueueMeta {
  return {
    nextSequence: 1,
    scheduled: false,
    processing: false
  };
}

function getDiscordJobKey(sequence: number) {
  return `${DISCORD_JOB_PREFIX}${sequence.toString().padStart(16, "0")}`;
}

function getDiscordInteractionKey(interactionId: string) {
  return `${DISCORD_INTERACTION_PREFIX}${interactionId}`;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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

  async enqueueDiscordChat(input: DiscordQueuedChatInput) {
    await this.enqueueDiscordJob({
      type: "chat",
      interactionId: input.request.interactionId,
      responseTarget: input.responseTarget,
      request: input.request
    });
  }

  async enqueueDiscordReset(input: DiscordQueuedResetInput) {
    await this.enqueueDiscordJob({
      type: "reset",
      interactionId: input.interactionId,
      responseTarget: input.responseTarget,
      guildId: input.guildId,
      channelId: input.channelId,
      userId: input.userId,
      user: input.user
    });
  }

  async processDiscordQueue(): Promise<void> {
    const run = this.discordTurn.then(() => this.drainDiscordQueue());
    this.discordTurn = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

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
      return this.clearDiscordSession();
    });
    this.discordTurn = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async enqueueDiscordJob(
    input:
      | {
          type: "chat";
          interactionId: string;
          responseTarget: DiscordResponseTarget;
          request: DiscordChatRequest;
        }
      | {
          type: "reset";
          interactionId: string;
          responseTarget: DiscordResponseTarget;
          guildId?: string;
          channelId?: string;
          userId?: string;
          user?: DiscordUserContext;
        }
  ) {
    const now = new Date().toISOString();
    const interactionKey = getDiscordInteractionKey(input.interactionId);

    await this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<DiscordInteractionRecord>(interactionKey);
      if (existing) return;

      const meta =
        (await txn.get<DiscordQueueMeta>(DISCORD_QUEUE_META_KEY)) ??
        getDefaultQueueMeta();
      const sequence = meta.nextSequence++;
      const job: DiscordQueuedJob =
        input.type === "chat"
          ? {
              type: "chat",
              sequence,
              interactionId: input.interactionId,
              responseTarget: input.responseTarget,
              request: input.request,
              attempts: 0,
              createdAt: now,
              updatedAt: now
            }
          : {
              type: "reset",
              sequence,
              interactionId: input.interactionId,
              responseTarget: input.responseTarget,
              guildId: input.guildId,
              channelId: input.channelId,
              userId: input.userId,
              user: input.user,
              attempts: 0,
              createdAt: now,
              updatedAt: now
            };

      await txn.put(DISCORD_QUEUE_META_KEY, meta);
      await txn.put(getDiscordJobKey(sequence), job);
      await txn.put<DiscordInteractionRecord>(interactionKey, {
        sequence,
        status: "pending",
        updatedAt: now
      });
    });

    await this.scheduleDiscordQueueDrain();
  }

  private async scheduleDiscordQueueDrain(delaySeconds = 0) {
    const shouldSchedule = await this.ctx.storage.transaction(async (txn) => {
      const meta =
        (await txn.get<DiscordQueueMeta>(DISCORD_QUEUE_META_KEY)) ??
        getDefaultQueueMeta();
      if (meta.scheduled || meta.processing) return false;

      meta.scheduled = true;
      await txn.put(DISCORD_QUEUE_META_KEY, meta);
      return true;
    });

    if (!shouldSchedule) return;

    try {
      await this.schedule(delaySeconds, "processDiscordQueue", {
        ...DISCORD_QUEUE_DRAIN_PAYLOAD,
        scheduledAt: new Date().toISOString()
      });
    } catch (error) {
      await this.ctx.storage.transaction(async (txn) => {
        const meta =
          (await txn.get<DiscordQueueMeta>(DISCORD_QUEUE_META_KEY)) ??
          getDefaultQueueMeta();
        meta.scheduled = false;
        await txn.put(DISCORD_QUEUE_META_KEY, meta);
      });
      throw error;
    }
  }

  private async drainDiscordQueue() {
    const startedAt = Date.now();
    await this.ctx.storage.transaction(async (txn) => {
      const meta =
        (await txn.get<DiscordQueueMeta>(DISCORD_QUEUE_META_KEY)) ??
        getDefaultQueueMeta();
      meta.scheduled = false;
      meta.processing = true;
      await txn.put(DISCORD_QUEUE_META_KEY, meta);
    });

    try {
      while (Date.now() - startedAt < DISCORD_QUEUE_DRAIN_SECONDS * 1000) {
        const job = await this.getNextDiscordJob();
        if (!job) return;

        const completed = await this.processDiscordJob(job);
        if (!completed) return;
      }
    } finally {
      await this.ctx.storage.transaction(async (txn) => {
        const meta =
          (await txn.get<DiscordQueueMeta>(DISCORD_QUEUE_META_KEY)) ??
          getDefaultQueueMeta();
        meta.processing = false;
        await txn.put(DISCORD_QUEUE_META_KEY, meta);
      });

      if (await this.hasPendingDiscordJobs()) {
        await this.scheduleDiscordQueueDrain(1);
      }
    }
  }

  private async getNextDiscordJob() {
    const jobs = await this.ctx.storage.list<DiscordQueuedJob>({
      prefix: DISCORD_JOB_PREFIX,
      limit: 1
    });
    return jobs.values().next().value as DiscordQueuedJob | undefined;
  }

  private async hasPendingDiscordJobs() {
    const jobs = await this.ctx.storage.list<DiscordQueuedJob>({
      prefix: DISCORD_JOB_PREFIX,
      limit: 1
    });
    return jobs.size > 0;
  }

  private async processDiscordJob(job: DiscordQueuedJob) {
    const attempt = job.attempts + 1;
    const updatedJob = {
      ...job,
      attempts: attempt,
      updatedAt: new Date().toISOString()
    } as DiscordQueuedJob;
    await this.ctx.storage.put(getDiscordJobKey(job.sequence), updatedJob);

    try {
      const response =
        updatedJob.type === "chat"
          ? await this.answerQueuedDiscordChat(updatedJob)
          : this.clearDiscordSession();

      await editOriginalInteractionResponse(
        updatedJob.responseTarget,
        response.content,
        response.attachments
      );
      await this.completeDiscordJob(updatedJob, "completed");
      return true;
    } catch (error) {
      const message = getErrorMessage(error);
      console.error("Discord queued job failed", {
        sequence: updatedJob.sequence,
        interactionId: updatedJob.interactionId,
        attempt,
        error: message
      });

      if (attempt >= MAX_DISCORD_JOB_ATTEMPTS) {
        try {
          await editOriginalInteractionResponse(
            updatedJob.responseTarget,
            "Sorry, I could not complete that request."
          );
        } catch (editError) {
          console.error("Discord queued job failure response failed", {
            sequence: updatedJob.sequence,
            interactionId: updatedJob.interactionId,
            error: getErrorMessage(editError)
          });
        }
        await this.completeDiscordJob(updatedJob, "failed");
        return true;
      }

      await this.ctx.storage.put(getDiscordJobKey(updatedJob.sequence), {
        ...updatedJob,
        lastError: message,
        updatedAt: new Date().toISOString()
      } satisfies DiscordQueuedJob);
      await this.scheduleDiscordQueueDrain(Math.min(attempt * 5, 30));
      return false;
    }
  }

  private async completeDiscordJob(
    job: DiscordQueuedJob,
    status: "completed" | "failed"
  ) {
    const now = new Date().toISOString();
    await this.ctx.storage.transaction(async (txn) => {
      await txn.delete(getDiscordJobKey(job.sequence));
      await txn.put<DiscordInteractionRecord>(
        getDiscordInteractionKey(job.interactionId),
        {
          sequence: job.sequence,
          status,
          updatedAt: now
        }
      );
    });
  }

  private async answerQueuedDiscordChat(
    job: DiscordQueuedChatJob
  ): Promise<DiscordChatResponse> {
    if (!job.userMessageAppended) {
      await this.session.appendMessage(
        this.createDiscordUserMessage(job.request)
      );
      await this.ctx.storage.put(getDiscordJobKey(job.sequence), {
        ...job,
        userMessageAppended: true,
        updatedAt: new Date().toISOString()
      } satisfies DiscordQueuedChatJob);
    }

    return this.createDiscordAssistantResponse(job.request);
  }

  private async answerFromDiscord(
    request: DiscordChatRequest
  ): Promise<DiscordChatResponse> {
    await this.session.appendMessage(this.createDiscordUserMessage(request));
    return this.createDiscordAssistantResponse(request);
  }

  private createDiscordUserMessage(request: DiscordChatRequest): UIMessage {
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

    return userMessage;
  }

  private async createDiscordAssistantResponse(
    request: DiscordChatRequest
  ): Promise<DiscordChatResponse> {
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

  private clearDiscordSession(): DiscordChatResponse {
    const messageCount = this.session.getPathLength();
    this.session.clearMessages();
    return {
      content:
        messageCount === 1
          ? "Reset context. Cleared 1 message."
          : `Reset context. Cleared ${messageCount} messages.`
    };
  }
}

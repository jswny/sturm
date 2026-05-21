import {
  Agent,
  type FiberContext,
  type FiberRecoveryContext,
  type QueueItem
} from "agents";
import { Session } from "agents/experimental/memory/session";
import { createCompactFunction } from "agents/experimental/memory/utils";
import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { editOriginalInteractionResponse } from "./discord/api";
import {
  DiscordInteractionStore,
  type DiscordInteractionChatInput,
  type DiscordInteractionChatJob,
  type DiscordInteractionJob,
  type DiscordInteractionResetInput
} from "./discord/interactions";
import {
  clearDiscordSession,
  createDiscordAssistantMessage,
  createDiscordAssistantResponse,
  createDiscordAssistantTurn,
  createDiscordUserMessage,
  hydrateDiscordGeneratedResponse
} from "./discord/turn";
import type { DiscordChatRequest, DiscordChatResponse } from "./discord/types";
import { getErrorMessage, logError, logInfo, logWarn } from "./logging";
import { getGuildIdFromConversationName, GuildMemoryProvider } from "./memory";
import {
  CHAT_MODEL,
  COMPACTION_PROVIDER_OPTIONS,
  COMPACTION_TAIL_TOKEN_BUDGET,
  COMPACTION_TOKEN_THRESHOLD
} from "./model";

const MAX_DISCORD_JOB_ATTEMPTS = 3;
const DISCORD_QUEUE_RETRY = {
  maxAttempts: MAX_DISCORD_JOB_ATTEMPTS,
  baseDelayMs: 5000,
  maxDelayMs: 30000
} as const;
const DISCORD_DEBUG_RESPONSE_TIMEOUT_MS = 14 * 60 * 1000;
const DISCORD_DEBUG_RESPONSE_POLL_MS = 100;
const DISCORD_DEFERRED_RESPONSE_SETTLE_MS = 500;
const DISCORD_JOB_FIBER_PREFIX = "discord-job:";

type DiscordInteractionQueuePayload = {
  interactionId: string;
};

type DiscordJobFiberPhase =
  | "starting"
  | "attempt-recorded"
  | "running"
  | "user-message-appended"
  | "generating-response"
  | "generated-response-saved"
  | "assistant-message-appended"
  | "rehydrating-generated-response"
  | "response-ready"
  | "response-delivered"
  | "completed"
  | "retry-scheduled"
  | "failed";

type DiscordJobFiberSnapshot = {
  sequence: number;
  interactionId: string;
  jobType: DiscordInteractionJob["type"];
  attempt?: number;
  phase: DiscordJobFiberPhase;
  updatedAt: string;
};

export class ChatAgent extends Agent<Env> {
  private discordTurn = Promise.resolve();
  private discordInteractions = new DiscordInteractionStore(this.ctx.storage);
  private session = Session.create(this)
    .withContext("guild_memory", {
      description:
        "Durable memory shared by Sturm across all channels in this Discord guild. Store only concise, stable, reusable server facts, preferences, decisions, and conventions.",
      maxTokens: 2000,
      provider: new GuildMemoryProvider(this.env.GuildMemory, () =>
        getGuildIdFromConversationName(this.name)
      )
    })
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

  async enqueueDiscordChat(input: DiscordInteractionChatInput) {
    const result = await this.discordInteractions.create(input);
    if (!result.created || !result.job) return;

    try {
      await this.queueDiscordInteraction(result.job.interactionId);
    } catch (error) {
      await this.discordInteractions.deleteCreatedInteraction(result.job);
      logError("Discord interaction queue failed", error, {
        sequence: result.job.sequence,
        interactionId: result.job.interactionId,
        jobType: result.job.type
      });
      throw error;
    }
  }

  async enqueueDiscordReset(input: DiscordInteractionResetInput) {
    const result = await this.discordInteractions.create(input);
    if (!result.created || !result.job) return;

    try {
      await this.queueDiscordInteraction(result.job.interactionId);
    } catch (error) {
      await this.discordInteractions.deleteCreatedInteraction(result.job);
      logError("Discord interaction queue failed", error, {
        sequence: result.job.sequence,
        interactionId: result.job.interactionId,
        jobType: result.job.type
      });
      throw error;
    }
  }

  async runDebugQueuedDiscordChat(
    request: DiscordChatRequest
  ): Promise<DiscordChatResponse> {
    await this.enqueueDiscordChat({
      responseTarget: { type: "debug", id: request.interactionId },
      request
    });
    return this.waitForDebugQueuedResponse(request.interactionId);
  }

  async runDebugQueuedDiscordReset(
    input: Omit<DiscordInteractionResetInput, "responseTarget">
  ): Promise<DiscordChatResponse> {
    await this.enqueueDiscordReset({
      ...input,
      responseTarget: { type: "debug", id: input.interactionId }
    });
    return this.waitForDebugQueuedResponse(input.interactionId);
  }

  async processDiscordInteraction(
    payload: DiscordInteractionQueuePayload,
    queueItem?: QueueItem
  ): Promise<void> {
    if (!payload?.interactionId) {
      logWarn("Discord queued interaction missing interactionId", {
        queueTaskId: queueItem?.id
      });
      return;
    }

    const run = this.discordTurn.then(() =>
      this.processQueuedDiscordInteraction(payload.interactionId, queueItem)
    );
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
    const run = this.discordTurn.then(() => clearDiscordSession(this.session));
    this.discordTurn = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  override async onFiberRecovered(ctx: FiberRecoveryContext) {
    if (!ctx.name.startsWith(DISCORD_JOB_FIBER_PREFIX)) {
      await super.onFiberRecovered(ctx);
      return;
    }

    const snapshot = getDiscordJobFiberSnapshot(ctx.snapshot);
    const interactionId =
      snapshot?.interactionId ??
      getInteractionIdFromDiscordJobFiberName(ctx.name);
    const active = interactionId
      ? await this.discordInteractions.hasActiveInteraction(interactionId)
      : false;
    logWarn("Recovered interrupted Discord job fiber", {
      fiberId: ctx.id,
      fiberName: ctx.name,
      fiberAgeMs: Date.now() - ctx.createdAt,
      sequence: snapshot?.sequence,
      interactionId,
      jobType: snapshot?.jobType,
      attempt: snapshot?.attempt,
      phase: snapshot?.phase,
      requeued: active
    });

    if (active && interactionId) {
      await this.queueDiscordInteraction(interactionId);
    }
  }

  private async queueDiscordInteraction(interactionId: string) {
    await this.queue(
      "processDiscordInteraction",
      { interactionId },
      {
        retry: DISCORD_QUEUE_RETRY
      }
    );
  }

  private async processQueuedDiscordInteraction(
    interactionId: string,
    queueItem?: QueueItem
  ) {
    const job =
      await this.discordInteractions.getJobByInteractionId(interactionId);
    if (!job) {
      logInfo("Discord queued interaction has no active job", {
        interactionId,
        queueTaskId: queueItem?.id
      });
      return;
    }

    try {
      await this.runFiber(getDiscordJobFiberName(job.interactionId), (fiber) =>
        this.processDiscordJobAttempt(job, fiber, queueItem?.id)
      );
    } finally {
      await this.discordInteractions.pruneCompletedInteractionRecords();
      await this.discordInteractions.pruneStaleDebugResults();
    }
  }

  private async processDiscordJobAttempt(
    job: DiscordInteractionJob,
    fiber: FiberContext,
    queueTaskId?: string
  ) {
    this.stashDiscordJobFiber(fiber, job, "starting");
    let updatedJob = await this.discordInteractions.recordAttempt(job);
    if (!updatedJob) {
      logInfo("Discord queued interaction disappeared before processing", {
        sequence: job.sequence,
        interactionId: job.interactionId,
        queueTaskId
      });
      return;
    }
    const attempt = updatedJob.attempts;
    this.stashDiscordJobFiber(fiber, updatedJob, "attempt-recorded", attempt);

    try {
      let response: DiscordChatResponse;
      this.stashDiscordJobFiber(fiber, updatedJob, "running", attempt);
      if (updatedJob.type === "chat") {
        const chatJob = updatedJob;
        const result = await this.answerQueuedDiscordChat(
          chatJob,
          fiber,
          attempt
        );
        updatedJob = result.job;
        response = result.response;
      } else {
        response = await clearDiscordSession(this.session);
      }

      this.stashDiscordJobFiber(fiber, updatedJob, "response-ready", attempt);
      await this.deliverDiscordJobResponse(updatedJob, response);
      this.stashDiscordJobFiber(
        fiber,
        updatedJob,
        "response-delivered",
        attempt
      );
      await this.discordInteractions.completeJob(updatedJob, "completed");
      this.stashDiscordJobFiber(fiber, updatedJob, "completed", attempt);
    } catch (error) {
      const message = getErrorMessage(error);
      logError("Discord queued job failed", error, {
        sequence: updatedJob.sequence,
        interactionId: updatedJob.interactionId,
        attempt,
        jobType: updatedJob.type,
        responseTargetType: updatedJob.responseTarget.type,
        queueTaskId
      });

      if (attempt >= MAX_DISCORD_JOB_ATTEMPTS) {
        await this.deliverDiscordJobFailure(updatedJob, message);
        await this.discordInteractions.completeJob(updatedJob, "failed");
        this.stashDiscordJobFiber(fiber, updatedJob, "failed", attempt);
        return;
      }

      await this.discordInteractions.putJob({
        ...updatedJob,
        lastError: message,
        updatedAt: new Date().toISOString()
      } satisfies DiscordInteractionJob);
      this.stashDiscordJobFiber(fiber, updatedJob, "retry-scheduled", attempt);
      throw error;
    }
  }

  private async deliverDiscordJobResponse(
    job: DiscordInteractionJob,
    response: DiscordChatResponse
  ) {
    if (job.responseTarget.type === "debug") {
      await this.discordInteractions.putDebugResult(job.responseTarget.id, {
        status: "completed",
        response
      });
      return;
    }

    await waitForDiscordDeferredResponse(job);
    logInfo("Editing Discord interaction response", {
      sequence: job.sequence,
      interactionId: job.interactionId,
      attachments: response.attachments?.length ?? 0
    });
    await editOriginalInteractionResponse(
      job.responseTarget,
      response.content,
      response.attachments
    );
  }

  private async deliverDiscordJobFailure(
    job: DiscordInteractionJob,
    error: string
  ) {
    if (job.responseTarget.type === "debug") {
      await this.discordInteractions.putDebugResult(job.responseTarget.id, {
        status: "failed",
        error
      });
      return;
    }

    await waitForDiscordDeferredResponse(job);
    try {
      await editOriginalInteractionResponse(
        job.responseTarget,
        "Sorry, I could not complete that request."
      );
    } catch (editError) {
      logError("Discord queued job failure response failed", editError, {
        sequence: job.sequence,
        interactionId: job.interactionId
      });
    }
  }

  private async waitForDebugQueuedResponse(targetId: string) {
    const deadline = Date.now() + DISCORD_DEBUG_RESPONSE_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const result = await this.discordInteractions.getDebugResult(targetId);
      if (!result) {
        await sleep(DISCORD_DEBUG_RESPONSE_POLL_MS);
        continue;
      }

      await this.discordInteractions.deleteDebugResult(targetId);
      if (result.status === "failed") {
        throw new Error(result.error);
      }
      return result.response;
    }

    throw new Error(`Debug queued response ${targetId} was not produced.`);
  }

  private async answerQueuedDiscordChat(
    job: DiscordInteractionChatJob,
    fiber: FiberContext,
    attempt: number
  ): Promise<{
    job: DiscordInteractionChatJob;
    response: DiscordChatResponse;
  }> {
    let updatedJob = job;

    if (!updatedJob.userMessageAppended) {
      await this.session.appendMessage(createDiscordUserMessage(job.request));
      updatedJob = {
        ...updatedJob,
        userMessageAppended: true,
        updatedAt: new Date().toISOString()
      };
      await this.discordInteractions.putJob(updatedJob);
      this.stashDiscordJobFiber(
        fiber,
        updatedJob,
        "user-message-appended",
        attempt
      );
    }

    if (updatedJob.generatedResponse) {
      const generatedResponse = updatedJob.generatedResponse;
      this.stashDiscordJobFiber(
        fiber,
        updatedJob,
        "rehydrating-generated-response",
        attempt
      );
      updatedJob = await this.appendQueuedDiscordAssistantMessage(updatedJob);
      return {
        job: updatedJob,
        response: await hydrateDiscordGeneratedResponse(
          this.env,
          generatedResponse
        )
      };
    }

    this.stashDiscordJobFiber(
      fiber,
      updatedJob,
      "generating-response",
      attempt
    );
    const turn = await createDiscordAssistantTurn(
      this.env,
      this.session,
      this.sessionAffinity,
      job.request
    );
    updatedJob = {
      ...updatedJob,
      generatedResponse: turn.generatedResponse,
      updatedAt: new Date().toISOString()
    };
    await this.discordInteractions.putJob(updatedJob);
    this.stashDiscordJobFiber(
      fiber,
      updatedJob,
      "generated-response-saved",
      attempt
    );

    await this.session.appendMessage(turn.assistantMessage);
    updatedJob = {
      ...updatedJob,
      assistantMessageAppended: true,
      updatedAt: new Date().toISOString()
    };
    await this.discordInteractions.putJob(updatedJob);
    this.stashDiscordJobFiber(
      fiber,
      updatedJob,
      "assistant-message-appended",
      attempt
    );

    return { job: updatedJob, response: turn.response };
  }

  private async appendQueuedDiscordAssistantMessage(
    job: DiscordInteractionChatJob
  ) {
    if (job.assistantMessageAppended) return job;
    if (!job.generatedResponse) return job;

    await this.session.appendMessage(
      createDiscordAssistantMessage(
        job.request,
        job.generatedResponse.assistantMessageText
      )
    );
    const updatedJob = {
      ...job,
      assistantMessageAppended: true,
      updatedAt: new Date().toISOString()
    } satisfies DiscordInteractionChatJob;
    await this.discordInteractions.putJob(updatedJob);
    return updatedJob;
  }

  private async answerFromDiscord(
    request: DiscordChatRequest
  ): Promise<DiscordChatResponse> {
    await this.session.appendMessage(createDiscordUserMessage(request));
    return this.keepAliveWhile(() =>
      createDiscordAssistantResponse(
        this.env,
        this.session,
        this.sessionAffinity,
        request
      )
    );
  }

  private stashDiscordJobFiber(
    fiber: FiberContext,
    job: DiscordInteractionJob,
    phase: DiscordJobFiberPhase,
    attempt?: number
  ) {
    fiber.stash({
      sequence: job.sequence,
      interactionId: job.interactionId,
      jobType: job.type,
      attempt,
      phase,
      updatedAt: new Date().toISOString()
    } satisfies DiscordJobFiberSnapshot);
  }
}

function getDiscordJobFiberName(interactionId: string) {
  return `${DISCORD_JOB_FIBER_PREFIX}${interactionId}`;
}

function getInteractionIdFromDiscordJobFiberName(name: string) {
  const interactionId = name.slice(DISCORD_JOB_FIBER_PREFIX.length);
  return interactionId || undefined;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDiscordDeferredResponse(job: DiscordInteractionJob) {
  if (job.responseTarget.type !== "discord") return;

  const createdAtMs = Date.parse(job.createdAt);
  if (!Number.isFinite(createdAtMs)) return;

  const waitMs =
    DISCORD_DEFERRED_RESPONSE_SETTLE_MS - (Date.now() - createdAtMs);
  if (waitMs > 0) await sleep(waitMs);
}

function getDiscordJobFiberSnapshot(
  snapshot: unknown
): DiscordJobFiberSnapshot | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const value = snapshot as Partial<DiscordJobFiberSnapshot>;
  if (
    typeof value.sequence !== "number" ||
    typeof value.interactionId !== "string" ||
    (value.jobType !== "chat" && value.jobType !== "reset") ||
    typeof value.phase !== "string"
  ) {
    return null;
  }

  return {
    sequence: value.sequence,
    interactionId: value.interactionId,
    jobType: value.jobType,
    attempt: value.attempt,
    phase: value.phase as DiscordJobFiberPhase,
    updatedAt:
      typeof value.updatedAt === "string"
        ? value.updatedAt
        : new Date(0).toISOString()
  };
}

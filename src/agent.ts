import { Agent, type FiberContext, type FiberRecoveryContext } from "agents";
import { Session } from "agents/experimental/memory/session";
import { createCompactFunction } from "agents/experimental/memory/utils";
import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { editOriginalInteractionResponse } from "./discord/api";
import {
  DiscordJobQueue,
  type DiscordQueuedChatInput,
  type DiscordQueuedChatJob,
  type DiscordQueuedJob,
  type DiscordQueuedResetInput
} from "./discord/queue";
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
const DISCORD_QUEUE_DRAIN_SECONDS = 13 * 60;
const DISCORD_QUEUE_SCHEDULED_STALE_MS = 2 * 60 * 1000;
const DISCORD_QUEUE_PROCESSING_STALE_MS = 20 * 60 * 1000;
const DISCORD_QUEUE_DRAIN_PAYLOAD = { kind: "discord-queue-drain" } as const;
const DISCORD_JOB_FIBER_PREFIX = "discord-job:";

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
  jobType: DiscordQueuedJob["type"];
  attempt?: number;
  phase: DiscordJobFiberPhase;
  updatedAt: string;
};

export class ChatAgent extends Agent<Env> {
  private discordTurn = Promise.resolve();
  private discordQueue = new DiscordJobQueue(this.ctx.storage);
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

  async enqueueDiscordChat(input: DiscordQueuedChatInput) {
    await this.discordQueue.enqueue(input);
    await this.scheduleDiscordQueueDrain();
  }

  async enqueueDiscordReset(input: DiscordQueuedResetInput) {
    await this.discordQueue.enqueue(input);
    await this.scheduleDiscordQueueDrain();
  }

  async runDebugQueuedDiscordChat(
    request: DiscordChatRequest
  ): Promise<DiscordChatResponse> {
    await this.enqueueDiscordChat({
      responseTarget: { type: "debug", id: request.interactionId },
      request
    });
    await this.processDiscordQueue();
    return this.getDebugQueuedResponse(request.interactionId);
  }

  async runDebugQueuedDiscordReset(
    input: Omit<DiscordQueuedResetInput, "responseTarget">
  ): Promise<DiscordChatResponse> {
    await this.enqueueDiscordReset({
      ...input,
      responseTarget: { type: "debug", id: input.interactionId }
    });
    await this.processDiscordQueue();
    return this.getDebugQueuedResponse(input.interactionId);
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
    const recoveryDecision = await this.discordQueue.recoverInterruptedDrain();
    logWarn("Recovered interrupted Discord job fiber", {
      fiberId: ctx.id,
      fiberName: ctx.name,
      fiberAgeMs: Date.now() - ctx.createdAt,
      sequence:
        snapshot?.sequence ?? getSequenceFromDiscordJobFiberName(ctx.name),
      interactionId: snapshot?.interactionId,
      jobType: snapshot?.jobType,
      attempt: snapshot?.attempt,
      phase: snapshot?.phase,
      wasScheduled: recoveryDecision.wasScheduled,
      wasProcessing: recoveryDecision.wasProcessing
    });

    if (await this.discordQueue.hasPendingJobs()) {
      await this.scheduleDiscordQueueDrain();
    }
  }

  private async scheduleDiscordQueueDrain(delaySeconds = 0) {
    const scheduleDecision = await this.discordQueue.markScheduledIfIdle({
      scheduledStaleMs: DISCORD_QUEUE_SCHEDULED_STALE_MS,
      processingStaleMs: DISCORD_QUEUE_PROCESSING_STALE_MS
    });
    if (
      scheduleDecision.recoveredScheduled ||
      scheduleDecision.recoveredProcessing
    ) {
      logInfo("Recovered stale Discord queue state", {
        recoveredScheduled: scheduleDecision.recoveredScheduled,
        recoveredProcessing: scheduleDecision.recoveredProcessing
      });
    }
    if (!scheduleDecision.shouldSchedule) return;

    try {
      await this.schedule(delaySeconds, "processDiscordQueue", {
        ...DISCORD_QUEUE_DRAIN_PAYLOAD,
        scheduledAt: new Date().toISOString()
      });
    } catch (error) {
      await this.discordQueue.markScheduleFailed();
      logError("Discord queue drain schedule failed", error, {
        delaySeconds
      });
      throw error;
    }
  }

  private async drainDiscordQueue() {
    const startedAt = Date.now();
    await this.discordQueue.markDrainStarted();

    try {
      while (Date.now() - startedAt < DISCORD_QUEUE_DRAIN_SECONDS * 1000) {
        const job = await this.discordQueue.getNextJob();
        if (!job) return;

        const completed = await this.processDiscordJob(job);
        if (!completed) return;
      }
    } finally {
      await this.discordQueue.markDrainFinished();
      await this.discordQueue.pruneCompletedInteractionRecords();
      await this.discordQueue.pruneStaleDebugResults();

      if (await this.discordQueue.hasPendingJobs()) {
        await this.scheduleDiscordQueueDrain(1);
      }
    }
  }

  private async processDiscordJob(job: DiscordQueuedJob) {
    return this.runFiber(getDiscordJobFiberName(job.sequence), async (fiber) =>
      this.processDiscordJobAttempt(job, fiber)
    );
  }

  private async processDiscordJobAttempt(
    job: DiscordQueuedJob,
    fiber: FiberContext
  ) {
    this.stashDiscordJobFiber(fiber, job, "starting");
    let updatedJob = await this.discordQueue.recordAttempt(job);
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
      await this.discordQueue.completeJob(updatedJob, "completed");
      this.stashDiscordJobFiber(fiber, updatedJob, "completed", attempt);
      return true;
    } catch (error) {
      const message = getErrorMessage(error);
      logError("Discord queued job failed", error, {
        sequence: updatedJob.sequence,
        interactionId: updatedJob.interactionId,
        attempt,
        jobType: updatedJob.type,
        responseTargetType: updatedJob.responseTarget.type
      });

      if (attempt >= MAX_DISCORD_JOB_ATTEMPTS) {
        await this.deliverDiscordJobFailure(updatedJob, message);
        await this.discordQueue.completeJob(updatedJob, "failed");
        this.stashDiscordJobFiber(fiber, updatedJob, "failed", attempt);
        return true;
      }

      await this.discordQueue.putJob({
        ...updatedJob,
        lastError: message,
        updatedAt: new Date().toISOString()
      } satisfies DiscordQueuedJob);
      await this.scheduleDiscordQueueDrain(Math.min(attempt * 5, 30));
      this.stashDiscordJobFiber(fiber, updatedJob, "retry-scheduled", attempt);
      return false;
    }
  }

  private async deliverDiscordJobResponse(
    job: DiscordQueuedJob,
    response: DiscordChatResponse
  ) {
    if (job.responseTarget.type === "debug") {
      await this.discordQueue.putDebugResult(job.responseTarget.id, {
        status: "completed",
        response
      });
      return;
    }

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

  private async deliverDiscordJobFailure(job: DiscordQueuedJob, error: string) {
    if (job.responseTarget.type === "debug") {
      await this.discordQueue.putDebugResult(job.responseTarget.id, {
        status: "failed",
        error
      });
      return;
    }

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

  private async getDebugQueuedResponse(targetId: string) {
    const result = await this.discordQueue.getDebugResult(targetId);
    await this.discordQueue.deleteDebugResult(targetId);
    if (!result) {
      throw new Error(`Debug queued response ${targetId} was not produced.`);
    }
    if (result.status === "failed") {
      throw new Error(result.error);
    }
    return result.response;
  }

  private async answerQueuedDiscordChat(
    job: DiscordQueuedChatJob,
    fiber: FiberContext,
    attempt: number
  ): Promise<{ job: DiscordQueuedChatJob; response: DiscordChatResponse }> {
    let updatedJob = job;

    if (!updatedJob.userMessageAppended) {
      await this.session.appendMessage(createDiscordUserMessage(job.request));
      updatedJob = {
        ...updatedJob,
        userMessageAppended: true,
        updatedAt: new Date().toISOString()
      };
      await this.discordQueue.putJob(updatedJob);
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
    await this.discordQueue.putJob(updatedJob);
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
    await this.discordQueue.putJob(updatedJob);
    this.stashDiscordJobFiber(
      fiber,
      updatedJob,
      "assistant-message-appended",
      attempt
    );

    return { job: updatedJob, response: turn.response };
  }

  private async appendQueuedDiscordAssistantMessage(job: DiscordQueuedChatJob) {
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
    } satisfies DiscordQueuedChatJob;
    await this.discordQueue.putJob(updatedJob);
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
    job: DiscordQueuedJob,
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

function getDiscordJobFiberName(sequence: number) {
  return `${DISCORD_JOB_FIBER_PREFIX}${sequence}`;
}

function getSequenceFromDiscordJobFiberName(name: string) {
  const sequence = Number(name.slice(DISCORD_JOB_FIBER_PREFIX.length));
  return Number.isFinite(sequence) ? sequence : undefined;
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

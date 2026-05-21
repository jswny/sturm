import { Agent } from "agents";
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
  createDiscordAssistantResponse,
  createDiscordUserMessage
} from "./discord/turn";
import type { DiscordChatRequest, DiscordChatResponse } from "./discord/types";
import { getErrorMessage, logError, logInfo } from "./logging";
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

export class ChatAgent extends Agent<Env> {
  private discordTurn = Promise.resolve();
  private discordQueue = new DiscordJobQueue(this.ctx.storage);
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
    const updatedJob = await this.discordQueue.recordAttempt(job);
    const attempt = updatedJob.attempts;

    try {
      const response =
        updatedJob.type === "chat"
          ? await this.answerQueuedDiscordChat(updatedJob)
          : await clearDiscordSession(this.session);

      await this.deliverDiscordJobResponse(updatedJob, response);
      await this.discordQueue.completeJob(updatedJob, "completed");
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
        return true;
      }

      await this.discordQueue.putJob({
        ...updatedJob,
        lastError: message,
        updatedAt: new Date().toISOString()
      } satisfies DiscordQueuedJob);
      await this.scheduleDiscordQueueDrain(Math.min(attempt * 5, 30));
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
    job: DiscordQueuedChatJob
  ): Promise<DiscordChatResponse> {
    if (!job.userMessageAppended) {
      await this.session.appendMessage(createDiscordUserMessage(job.request));
      await this.discordQueue.putJob({
        ...job,
        userMessageAppended: true,
        updatedAt: new Date().toISOString()
      } satisfies DiscordQueuedChatJob);
    }

    return createDiscordAssistantResponse(
      this.env,
      this.session,
      this.sessionAffinity,
      job.request
    );
  }

  private async answerFromDiscord(
    request: DiscordChatRequest
  ): Promise<DiscordChatResponse> {
    await this.session.appendMessage(createDiscordUserMessage(request));
    return createDiscordAssistantResponse(
      this.env,
      this.session,
      this.sessionAffinity,
      request
    );
  }
}

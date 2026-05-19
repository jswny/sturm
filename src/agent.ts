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
import {
  CHAT_MODEL,
  COMPACTION_PROVIDER_OPTIONS,
  COMPACTION_TAIL_TOKEN_BUDGET,
  COMPACTION_TOKEN_THRESHOLD
} from "./model";

const MAX_DISCORD_JOB_ATTEMPTS = 3;
const DISCORD_QUEUE_DRAIN_SECONDS = 13 * 60;
const DISCORD_QUEUE_DRAIN_PAYLOAD = { kind: "discord-queue-drain" } as const;

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

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
      return clearDiscordSession(this.session);
    });
    this.discordTurn = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async scheduleDiscordQueueDrain(delaySeconds = 0) {
    const shouldSchedule = await this.discordQueue.markScheduledIfIdle();
    if (!shouldSchedule) return;

    try {
      await this.schedule(delaySeconds, "processDiscordQueue", {
        ...DISCORD_QUEUE_DRAIN_PAYLOAD,
        scheduledAt: new Date().toISOString()
      });
    } catch (error) {
      await this.discordQueue.markScheduleFailed();
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
          : clearDiscordSession(this.session);

      await editOriginalInteractionResponse(
        updatedJob.responseTarget,
        response.content,
        response.attachments
      );
      await this.discordQueue.completeJob(updatedJob, "completed");
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

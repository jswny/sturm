import type {
  DiscordChatResponse,
  DiscordChatRequest,
  DiscordResponseTarget,
  DiscordUserContext
} from "./types";

type DiscordQueueMeta = {
  nextSequence: number;
  scheduled: boolean;
  processing: boolean;
};

export type DiscordQueuedChatJob = {
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

export type DiscordQueuedResetJob = {
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

export type DiscordQueuedJob = DiscordQueuedChatJob | DiscordQueuedResetJob;

type DiscordInteractionRecord = {
  sequence: number;
  status: "pending" | "completed" | "failed";
  updatedAt: string;
};

export type DiscordDebugQueuedResult =
  | {
      status: "completed";
      response: DiscordChatResponse;
      updatedAt: string;
    }
  | {
      status: "failed";
      error: string;
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
const DISCORD_DEBUG_RESULT_PREFIX = "discord:queue:debug-result:";
const INTERACTION_RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const INTERACTION_RECORD_PRUNE_BATCH_SIZE = 100;

export class DiscordJobQueue {
  constructor(private storage: DurableObjectStorage) {}

  async enqueue(input: DiscordQueuedChatInput | DiscordQueuedResetInput) {
    const now = new Date().toISOString();
    const interactionId =
      "request" in input ? input.request.interactionId : input.interactionId;
    const interactionKey = getDiscordInteractionKey(interactionId);

    await this.storage.transaction(async (txn) => {
      const existing = await txn.get<DiscordInteractionRecord>(interactionKey);
      if (existing) return;

      const meta =
        (await txn.get<DiscordQueueMeta>(DISCORD_QUEUE_META_KEY)) ??
        getDefaultQueueMeta();
      const sequence = meta.nextSequence++;
      const job = createDiscordQueuedJob(input, sequence, now);

      await txn.put(DISCORD_QUEUE_META_KEY, meta);
      await txn.put(getDiscordJobKey(sequence), job);
      await txn.put<DiscordInteractionRecord>(interactionKey, {
        sequence,
        status: "pending",
        updatedAt: now
      });
    });
  }

  async markScheduledIfIdle() {
    return this.storage.transaction(async (txn) => {
      const meta =
        (await txn.get<DiscordQueueMeta>(DISCORD_QUEUE_META_KEY)) ??
        getDefaultQueueMeta();
      if (meta.scheduled || meta.processing) return false;

      meta.scheduled = true;
      await txn.put(DISCORD_QUEUE_META_KEY, meta);
      return true;
    });
  }

  async markScheduleFailed() {
    await this.storage.transaction(async (txn) => {
      const meta =
        (await txn.get<DiscordQueueMeta>(DISCORD_QUEUE_META_KEY)) ??
        getDefaultQueueMeta();
      meta.scheduled = false;
      await txn.put(DISCORD_QUEUE_META_KEY, meta);
    });
  }

  async markDrainStarted() {
    await this.storage.transaction(async (txn) => {
      const meta =
        (await txn.get<DiscordQueueMeta>(DISCORD_QUEUE_META_KEY)) ??
        getDefaultQueueMeta();
      meta.scheduled = false;
      meta.processing = true;
      await txn.put(DISCORD_QUEUE_META_KEY, meta);
    });
  }

  async markDrainFinished() {
    await this.storage.transaction(async (txn) => {
      const meta =
        (await txn.get<DiscordQueueMeta>(DISCORD_QUEUE_META_KEY)) ??
        getDefaultQueueMeta();
      meta.processing = false;
      await txn.put(DISCORD_QUEUE_META_KEY, meta);
    });
  }

  async getNextJob() {
    const jobs = await this.storage.list<DiscordQueuedJob>({
      prefix: DISCORD_JOB_PREFIX,
      limit: 1
    });
    return jobs.values().next().value as DiscordQueuedJob | undefined;
  }

  async hasPendingJobs() {
    const jobs = await this.storage.list<DiscordQueuedJob>({
      prefix: DISCORD_JOB_PREFIX,
      limit: 1
    });
    return jobs.size > 0;
  }

  async recordAttempt(job: DiscordQueuedJob) {
    const updatedJob = {
      ...job,
      attempts: job.attempts + 1,
      updatedAt: new Date().toISOString()
    } as DiscordQueuedJob;
    await this.putJob(updatedJob);
    return updatedJob;
  }

  async putJob(job: DiscordQueuedJob) {
    await this.storage.put(getDiscordJobKey(job.sequence), job);
  }

  async completeJob(job: DiscordQueuedJob, status: "completed" | "failed") {
    const now = new Date().toISOString();
    await this.storage.transaction(async (txn) => {
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

  async pruneCompletedInteractionRecords(
    retentionMs = INTERACTION_RECORD_RETENTION_MS
  ) {
    const cutoffMs = Date.now() - retentionMs;
    const records = await this.storage.list<DiscordInteractionRecord>({
      prefix: DISCORD_INTERACTION_PREFIX,
      limit: INTERACTION_RECORD_PRUNE_BATCH_SIZE
    });
    const keysToDelete: string[] = [];

    for (const [key, record] of records) {
      if (record.status === "pending") continue;

      const updatedAtMs = Date.parse(record.updatedAt);
      if (!Number.isFinite(updatedAtMs)) continue;
      if (updatedAtMs < cutoffMs) keysToDelete.push(key);
    }

    if (keysToDelete.length > 0) {
      await this.storage.delete(keysToDelete);
    }

    return keysToDelete.length;
  }

  async putDebugResult(
    targetId: string,
    result:
      | { status: "completed"; response: DiscordChatResponse }
      | { status: "failed"; error: string }
  ) {
    await this.storage.put<DiscordDebugQueuedResult>(
      getDiscordDebugResultKey(targetId),
      {
        ...result,
        updatedAt: new Date().toISOString()
      } as DiscordDebugQueuedResult
    );
  }

  async getDebugResult(targetId: string) {
    return this.storage.get<DiscordDebugQueuedResult>(
      getDiscordDebugResultKey(targetId)
    );
  }

  async deleteDebugResult(targetId: string) {
    await this.storage.delete(getDiscordDebugResultKey(targetId));
  }
}

function createDiscordQueuedJob(
  input: DiscordQueuedChatInput | DiscordQueuedResetInput,
  sequence: number,
  now: string
): DiscordQueuedJob {
  if ("request" in input) {
    return {
      type: "chat",
      sequence,
      interactionId: input.request.interactionId,
      responseTarget: input.responseTarget,
      request: input.request,
      attempts: 0,
      createdAt: now,
      updatedAt: now
    };
  }

  return {
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

function getDiscordDebugResultKey(targetId: string) {
  return `${DISCORD_DEBUG_RESULT_PREFIX}${targetId}`;
}

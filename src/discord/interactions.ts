import type {
  DiscordChatResponse,
  DiscordChatRequest,
  DiscordGeneratedChatResponse,
  DiscordResponseTarget,
  DiscordUserContext
} from "./types";

type DiscordInteractionMeta = {
  nextSequence: number;
};

export type DiscordInteractionChatJob = {
  type: "chat";
  sequence: number;
  interactionId: string;
  responseTarget: DiscordResponseTarget;
  request: DiscordChatRequest;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  userMessageAppended?: boolean;
  assistantMessageAppended?: boolean;
  generatedResponse?: DiscordGeneratedChatResponse;
  lastError?: string;
};

export type DiscordInteractionResetJob = {
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

export type DiscordInteractionJob =
  | DiscordInteractionChatJob
  | DiscordInteractionResetJob;

type DiscordInteractionStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed";

type DiscordInteractionRecord = {
  sequence: number;
  status: DiscordInteractionStatus;
  updatedAt: string;
};

export type DiscordDebugResult =
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

export type DiscordInteractionChatInput = {
  request: DiscordChatRequest;
  responseTarget: DiscordResponseTarget;
};

export type DiscordInteractionResetInput = {
  interactionId: string;
  responseTarget: DiscordResponseTarget;
  guildId?: string;
  channelId?: string;
  userId?: string;
  user?: DiscordUserContext;
};

export type DiscordInteractionCreateResult = {
  created: boolean;
  job?: DiscordInteractionJob;
};

const DISCORD_INTERACTION_META_KEY = "discord:interaction:meta";
const DISCORD_JOB_PREFIX = "discord:interaction:job:";
const DISCORD_RECORD_PREFIX = "discord:interaction:record:";
const DISCORD_DEBUG_RESULT_PREFIX = "discord:interaction:debug-result:";
const INTERACTION_RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const INTERACTION_RECORD_PRUNE_BATCH_SIZE = 100;
const DEBUG_RESULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEBUG_RESULT_PRUNE_BATCH_SIZE = 100;

export class DiscordInteractionStore {
  constructor(private storage: DurableObjectStorage) {}

  async create(
    input: DiscordInteractionChatInput | DiscordInteractionResetInput
  ): Promise<DiscordInteractionCreateResult> {
    const now = new Date().toISOString();
    const interactionId =
      "request" in input ? input.request.interactionId : input.interactionId;
    const interactionKey = getDiscordInteractionRecordKey(interactionId);

    return this.storage.transaction(async (txn) => {
      const existing = await txn.get<DiscordInteractionRecord>(interactionKey);
      if (existing) return { created: false };

      const meta =
        (await txn.get<DiscordInteractionMeta>(DISCORD_INTERACTION_META_KEY)) ??
        getDefaultInteractionMeta();
      const sequence = meta.nextSequence++;
      const job = createDiscordInteractionJob(input, sequence, now);

      await txn.put(DISCORD_INTERACTION_META_KEY, meta);
      await txn.put(getDiscordJobKey(sequence), job);
      await txn.put<DiscordInteractionRecord>(interactionKey, {
        sequence,
        status: "queued",
        updatedAt: now
      });

      return { created: true, job };
    });
  }

  async deleteCreatedInteraction(job: DiscordInteractionJob) {
    await this.storage.transaction(async (txn) => {
      const recordKey = getDiscordInteractionRecordKey(job.interactionId);
      const record = await txn.get<DiscordInteractionRecord>(recordKey);
      if (record?.sequence !== job.sequence || record.status !== "queued") {
        return;
      }

      await txn.delete(getDiscordJobKey(job.sequence));
      await txn.delete(recordKey);
    });
  }

  async getJobByInteractionId(interactionId: string) {
    const record = await this.storage.get<DiscordInteractionRecord>(
      getDiscordInteractionRecordKey(interactionId)
    );
    if (!record || isTerminalInteractionStatus(record.status)) {
      return undefined;
    }

    return this.storage.get<DiscordInteractionJob>(
      getDiscordJobKey(record.sequence)
    );
  }

  async hasActiveInteraction(interactionId: string) {
    const record = await this.storage.get<DiscordInteractionRecord>(
      getDiscordInteractionRecordKey(interactionId)
    );
    return Boolean(record && !isTerminalInteractionStatus(record.status));
  }

  async recordAttempt(job: DiscordInteractionJob) {
    return this.storage.transaction(async (txn) => {
      const currentJob = await txn.get<DiscordInteractionJob>(
        getDiscordJobKey(job.sequence)
      );
      if (!currentJob) return undefined;

      const now = new Date().toISOString();
      const updatedJob = {
        ...currentJob,
        attempts: currentJob.attempts + 1,
        updatedAt: now
      } as DiscordInteractionJob;

      await txn.put(getDiscordJobKey(updatedJob.sequence), updatedJob);
      await txn.put<DiscordInteractionRecord>(
        getDiscordInteractionRecordKey(updatedJob.interactionId),
        {
          sequence: updatedJob.sequence,
          status: "processing",
          updatedAt: now
        }
      );

      return updatedJob;
    });
  }

  async putJob(job: DiscordInteractionJob) {
    const now = new Date().toISOString();
    await this.storage.transaction(async (txn) => {
      await txn.put(getDiscordJobKey(job.sequence), job);
      const recordKey = getDiscordInteractionRecordKey(job.interactionId);
      const record = await txn.get<DiscordInteractionRecord>(recordKey);
      if (!record || isTerminalInteractionStatus(record.status)) return;

      await txn.put<DiscordInteractionRecord>(recordKey, {
        ...record,
        updatedAt: now
      });
    });
  }

  async completeJob(
    job: DiscordInteractionJob,
    status: "completed" | "failed"
  ) {
    const now = new Date().toISOString();
    await this.storage.transaction(async (txn) => {
      await txn.delete(getDiscordJobKey(job.sequence));
      await txn.put<DiscordInteractionRecord>(
        getDiscordInteractionRecordKey(job.interactionId),
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
      prefix: DISCORD_RECORD_PREFIX,
      limit: INTERACTION_RECORD_PRUNE_BATCH_SIZE
    });
    const keysToDelete: string[] = [];

    for (const [key, record] of records) {
      if (!isTerminalInteractionStatus(record.status)) continue;

      const updatedAtMs = Date.parse(record.updatedAt);
      if (!Number.isFinite(updatedAtMs)) continue;
      if (updatedAtMs < cutoffMs) keysToDelete.push(key);
    }

    if (keysToDelete.length > 0) {
      await this.storage.delete(keysToDelete);
    }

    return keysToDelete.length;
  }

  async pruneStaleDebugResults(retentionMs = DEBUG_RESULT_RETENTION_MS) {
    const cutoffMs = Date.now() - retentionMs;
    const results = await this.storage.list<DiscordDebugResult>({
      prefix: DISCORD_DEBUG_RESULT_PREFIX,
      limit: DEBUG_RESULT_PRUNE_BATCH_SIZE
    });
    const keysToDelete: string[] = [];

    for (const [key, result] of results) {
      const updatedAtMs = Date.parse(result.updatedAt);
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
    await this.storage.put<DiscordDebugResult>(
      getDiscordDebugResultKey(targetId),
      {
        ...result,
        updatedAt: new Date().toISOString()
      } as DiscordDebugResult
    );
  }

  async getDebugResult(targetId: string) {
    return this.storage.get<DiscordDebugResult>(
      getDiscordDebugResultKey(targetId)
    );
  }

  async deleteDebugResult(targetId: string) {
    await this.storage.delete(getDiscordDebugResultKey(targetId));
  }
}

function createDiscordInteractionJob(
  input: DiscordInteractionChatInput | DiscordInteractionResetInput,
  sequence: number,
  now: string
): DiscordInteractionJob {
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

function getDefaultInteractionMeta(): DiscordInteractionMeta {
  return {
    nextSequence: 1
  };
}

function isTerminalInteractionStatus(status: DiscordInteractionStatus) {
  return status === "completed" || status === "failed";
}

function getDiscordJobKey(sequence: number) {
  return `${DISCORD_JOB_PREFIX}${sequence.toString().padStart(16, "0")}`;
}

function getDiscordInteractionRecordKey(interactionId: string) {
  return `${DISCORD_RECORD_PREFIX}${interactionId}`;
}

function getDiscordDebugResultKey(targetId: string) {
  return `${DISCORD_DEBUG_RESULT_PREFIX}${targetId}`;
}

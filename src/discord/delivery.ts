import {
  toStoredResponseArtifact,
  type ResponseArtifact,
  type StoredResponseArtifact
} from "../artifacts";
import {
  isTimestampBefore,
  pruneDurableStorageRecords
} from "../storage-prune";
import type {
  DiscordChatRequest,
  DiscordChatResponse,
  DiscordResponseTarget,
  DiscordUserContext
} from "./types";

type DiscordDeliveryMeta = {
  nextSequence: number;
};

type DiscordDeliveryStatus = "pending" | "running" | "delivered" | "failed";
export type DiscordDeliveryLifecycleState = "running" | "recovering";

export type DiscordDeliveryLifecycle = {
  state: DiscordDeliveryLifecycleState;
  updatedAt: string;
};

export type DiscordCodeModeExecutionReference = {
  executionId: string;
  status?: "completed" | "paused" | "error";
  toolCallId?: string;
  stepNumber?: number;
  durationMs?: number;
  recordedAt: string;
};

export type DiscordCodeModeExecutionReferenceInput = Omit<
  DiscordCodeModeExecutionReference,
  "recordedAt"
>;

export type DiscordChatDeliveryRecord = {
  type: "chat";
  sequence: number;
  correlationId: string;
  discordInteractionId?: string;
  responseTarget: DiscordResponseTarget;
  request: DiscordChatRequest;
  status: DiscordDeliveryStatus;
  lifecycle?: DiscordDeliveryLifecycle;
  createdAt: string;
  updatedAt: string;
  artifacts?: StoredResponseArtifact[];
  codeModeExecutions?: DiscordCodeModeExecutionReference[];
  componentPromptId?: string;
  error?: string;
};

export type DiscordResetDeliveryRecord = {
  type: "reset";
  sequence: number;
  correlationId: string;
  discordInteractionId?: string;
  responseTarget: DiscordResponseTarget;
  guildId?: string;
  channelId?: string;
  userId?: string;
  user?: DiscordUserContext;
  status: DiscordDeliveryStatus;
  lifecycle?: DiscordDeliveryLifecycle;
  createdAt: string;
  updatedAt: string;
  error?: string;
};

export type DiscordDeliveryRecord =
  | DiscordChatDeliveryRecord
  | DiscordResetDeliveryRecord;

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

export type DiscordDeliveryChatInput = {
  request: DiscordChatRequest;
  responseTarget: DiscordResponseTarget;
};

export type DiscordDeliveryResetInput = {
  correlationId: string;
  discordInteractionId?: string;
  responseTarget: DiscordResponseTarget;
  guildId?: string;
  channelId?: string;
  userId?: string;
  user?: DiscordUserContext;
};

export type DiscordDeliveryCreateResult = {
  created: boolean;
  record?: DiscordDeliveryRecord;
};

const DISCORD_DELIVERY_META_KEY = "discord:delivery:meta";
const DISCORD_DELIVERY_PREFIX = "discord:delivery:record:";
const DISCORD_DEBUG_RESULT_PREFIX = "discord:delivery:debug-result:";
const DELIVERY_RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DELIVERY_RECORD_PRUNE_BATCH_SIZE = 100;
const DEBUG_RESULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEBUG_RESULT_PRUNE_BATCH_SIZE = 100;
const CODE_MODE_EXECUTION_REFERENCE_LIMIT = 20;

export class DiscordDeliveryStore {
  constructor(private storage: DurableObjectStorage) {}

  async create(
    input: DiscordDeliveryChatInput | DiscordDeliveryResetInput
  ): Promise<DiscordDeliveryCreateResult> {
    const now = new Date().toISOString();
    const correlationId =
      "request" in input ? input.request.correlationId : input.correlationId;
    const deliveryKey = getDiscordDeliveryKey(correlationId);

    return this.storage.transaction(async (txn) => {
      const existing = await txn.get<DiscordDeliveryRecord>(deliveryKey);
      if (existing) return { created: false, record: existing };

      const meta =
        (await txn.get<DiscordDeliveryMeta>(DISCORD_DELIVERY_META_KEY)) ??
        getDefaultDeliveryMeta();
      const sequence = meta.nextSequence++;
      const record = createDiscordDeliveryRecord(input, sequence, now);

      await txn.put(DISCORD_DELIVERY_META_KEY, meta);
      await txn.put(deliveryKey, record);

      return { created: true, record };
    });
  }

  async deleteCreatedDelivery(record: DiscordDeliveryRecord) {
    await this.storage.transaction(async (txn) => {
      const key = getDiscordDeliveryKey(getDeliveryCorrelationId(record));
      const current = await txn.get<DiscordDeliveryRecord>(key);
      if (
        current?.sequence !== record.sequence ||
        current.status !== "pending"
      ) {
        return;
      }

      await txn.delete(key);
    });
  }

  async getDelivery(correlationId: string) {
    return this.storage.get<DiscordDeliveryRecord>(
      getDiscordDeliveryKey(correlationId)
    );
  }

  async markRunning(correlationId: string) {
    await this.updateDelivery(correlationId, (record) => {
      if (isTerminalDeliveryStatus(record.status)) return record;

      const now = new Date().toISOString();
      return {
        ...record,
        status: "running",
        lifecycle:
          record.lifecycle?.state === "recovering"
            ? record.lifecycle
            : {
                state: "running",
                updatedAt: now
              },
        updatedAt: now
      };
    });
  }

  async markRecovering(correlationId: string) {
    await this.updateDelivery(correlationId, (record) => {
      if (isTerminalDeliveryStatus(record.status)) return record;

      const now = new Date().toISOString();
      return {
        ...record,
        status: "running",
        lifecycle: {
          state: "recovering",
          updatedAt: now
        },
        updatedAt: now
      };
    });
  }

  async addArtifact(correlationId: string, artifact: ResponseArtifact) {
    await this.updateDelivery(correlationId, (record) => {
      if (record.type !== "chat" || isTerminalDeliveryStatus(record.status)) {
        return record;
      }

      return {
        ...record,
        artifacts: [
          ...(record.artifacts ?? []),
          toStoredResponseArtifact(artifact)
        ],
        updatedAt: new Date().toISOString()
      };
    });
  }

  async setComponentPrompt(correlationId: string, promptId: string) {
    await this.updateDelivery(correlationId, (record) => {
      if (record.type !== "chat" || isTerminalDeliveryStatus(record.status)) {
        return record;
      }

      return {
        ...record,
        componentPromptId: promptId,
        updatedAt: new Date().toISOString()
      };
    });
  }

  async addCodeModeExecution(
    correlationId: string,
    input: DiscordCodeModeExecutionReferenceInput
  ) {
    await this.updateDelivery(correlationId, (record) => {
      if (record.type !== "chat") return record;

      const now = new Date().toISOString();
      const nextReference = {
        ...input,
        recordedAt: now
      } satisfies DiscordCodeModeExecutionReference;
      const references = [...(record.codeModeExecutions ?? [])];
      const existingIndex = references.findIndex(
        (reference) => reference.executionId === input.executionId
      );
      if (existingIndex >= 0) {
        references[existingIndex] = {
          ...references[existingIndex],
          ...nextReference
        };
      } else {
        references.push(nextReference);
      }

      return {
        ...record,
        codeModeExecutions: references.slice(
          -CODE_MODE_EXECUTION_REFERENCE_LIMIT
        ),
        updatedAt: now
      };
    });
  }

  async completeDelivery(
    record: DiscordDeliveryRecord,
    status: Extract<DiscordDeliveryStatus, "delivered" | "failed">,
    error?: string
  ) {
    await this.storage.transaction(async (txn) => {
      const key = getDiscordDeliveryKey(getDeliveryCorrelationId(record));
      const current = await txn.get<DiscordDeliveryRecord>(key);
      if (!current || current.sequence !== record.sequence) return;

      const nextRecord = {
        ...current,
        status,
        error,
        updatedAt: new Date().toISOString()
      } as DiscordDeliveryRecord;
      delete nextRecord.lifecycle;

      await txn.put<DiscordDeliveryRecord>(key, nextRecord);
    });
  }

  async pruneCompletedDeliveryRecords(
    retentionMs = DELIVERY_RECORD_RETENTION_MS
  ) {
    const cutoffMs = Date.now() - retentionMs;
    return pruneDurableStorageRecords<DiscordDeliveryRecord>(this.storage, {
      prefix: DISCORD_DELIVERY_PREFIX,
      limit: DELIVERY_RECORD_PRUNE_BATCH_SIZE,
      shouldPrune: (record) =>
        isTerminalDeliveryStatus(record.status) &&
        isTimestampBefore(record.updatedAt, cutoffMs)
    });
  }

  async pruneStaleDebugResults(retentionMs = DEBUG_RESULT_RETENTION_MS) {
    const cutoffMs = Date.now() - retentionMs;
    return pruneDurableStorageRecords<DiscordDebugResult>(this.storage, {
      prefix: DISCORD_DEBUG_RESULT_PREFIX,
      limit: DEBUG_RESULT_PRUNE_BATCH_SIZE,
      shouldPrune: (result) => isTimestampBefore(result.updatedAt, cutoffMs)
    });
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

  private async updateDelivery(
    correlationId: string,
    update: (record: DiscordDeliveryRecord) => DiscordDeliveryRecord
  ) {
    await this.storage.transaction(async (txn) => {
      const key = getDiscordDeliveryKey(correlationId);
      const record = await txn.get<DiscordDeliveryRecord>(key);
      if (!record) return;

      await txn.put(key, update(record));
    });
  }
}

function createDiscordDeliveryRecord(
  input: DiscordDeliveryChatInput | DiscordDeliveryResetInput,
  sequence: number,
  now: string
): DiscordDeliveryRecord {
  if ("request" in input) {
    return {
      type: "chat",
      sequence,
      correlationId: input.request.correlationId,
      discordInteractionId: input.request.discordInteractionId,
      responseTarget: input.responseTarget,
      request: input.request,
      status: "pending",
      createdAt: now,
      updatedAt: now
    };
  }

  return {
    type: "reset",
    sequence,
    correlationId: input.correlationId,
    discordInteractionId: input.discordInteractionId,
    responseTarget: input.responseTarget,
    guildId: input.guildId,
    channelId: input.channelId,
    userId: input.userId,
    user: input.user,
    status: "pending",
    createdAt: now,
    updatedAt: now
  };
}

function getDefaultDeliveryMeta(): DiscordDeliveryMeta {
  return {
    nextSequence: 1
  };
}

function isTerminalDeliveryStatus(status: DiscordDeliveryStatus) {
  return status === "delivered" || status === "failed";
}

export function isTerminalDelivery(record: DiscordDeliveryRecord) {
  return isTerminalDeliveryStatus(record.status);
}

export function getDeliveryCorrelationId(record: DiscordDeliveryRecord) {
  return record.correlationId;
}

function getDiscordDeliveryKey(correlationId: string) {
  return `${DISCORD_DELIVERY_PREFIX}${correlationId}`;
}

function getDiscordDebugResultKey(targetId: string) {
  return `${DISCORD_DEBUG_RESULT_PREFIX}${targetId}`;
}

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

export type DiscordChatDeliveryRecord = {
  type: "chat";
  sequence: number;
  interactionId: string;
  responseTarget: DiscordResponseTarget;
  request: DiscordChatRequest;
  status: DiscordDeliveryStatus;
  lifecycle?: DiscordDeliveryLifecycle;
  createdAt: string;
  updatedAt: string;
  artifacts?: StoredResponseArtifact[];
  componentPromptId?: string;
  error?: string;
};

export type DiscordResetDeliveryRecord = {
  type: "reset";
  sequence: number;
  interactionId: string;
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
  interactionId: string;
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

export class DiscordDeliveryStore {
  constructor(private storage: DurableObjectStorage) {}

  async create(
    input: DiscordDeliveryChatInput | DiscordDeliveryResetInput
  ): Promise<DiscordDeliveryCreateResult> {
    const now = new Date().toISOString();
    const interactionId =
      "request" in input ? input.request.interactionId : input.interactionId;
    const deliveryKey = getDiscordDeliveryKey(interactionId);

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
      const key = getDiscordDeliveryKey(record.interactionId);
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

  async getDelivery(interactionId: string) {
    return this.storage.get<DiscordDeliveryRecord>(
      getDiscordDeliveryKey(interactionId)
    );
  }

  async markRunning(interactionId: string) {
    await this.updateDelivery(interactionId, (record) => {
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

  async markRecovering(interactionId: string) {
    await this.updateDelivery(interactionId, (record) => {
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

  async addArtifact(interactionId: string, artifact: ResponseArtifact) {
    await this.updateDelivery(interactionId, (record) => {
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

  async setComponentPrompt(interactionId: string, promptId: string) {
    await this.updateDelivery(interactionId, (record) => {
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

  async completeDelivery(
    record: DiscordDeliveryRecord,
    status: Extract<DiscordDeliveryStatus, "delivered" | "failed">,
    error?: string
  ) {
    await this.storage.transaction(async (txn) => {
      const key = getDiscordDeliveryKey(record.interactionId);
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
    interactionId: string,
    update: (record: DiscordDeliveryRecord) => DiscordDeliveryRecord
  ) {
    await this.storage.transaction(async (txn) => {
      const key = getDiscordDeliveryKey(interactionId);
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
      interactionId: input.request.interactionId,
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
    interactionId: input.interactionId,
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

function getDiscordDeliveryKey(interactionId: string) {
  return `${DISCORD_DELIVERY_PREFIX}${interactionId}`;
}

function getDiscordDebugResultKey(targetId: string) {
  return `${DISCORD_DEBUG_RESULT_PREFIX}${targetId}`;
}

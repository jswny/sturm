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
  correlationId: string;
  discordInteractionId?: string;
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
const DISCORD_ACTIVE_DELIVERY_PREFIX = "discord:delivery:active:";
const DISCORD_ACTIVE_INDEX_MIGRATION_CURSOR_KEY =
  "discord:delivery:active-index:v1:cursor";
const DISCORD_ACTIVE_INDEX_MIGRATION_COMPLETE_KEY =
  "discord:delivery:active-index:v1:complete";
const DISCORD_DEBUG_RESULT_PREFIX = "discord:delivery:debug-result:";
const DELIVERY_RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DELIVERY_RECORD_PRUNE_BATCH_SIZE = 100;
const ACTIVE_DELIVERY_LIST_LIMIT = 100;
const ACTIVE_DELIVERY_MIGRATION_BATCH_SIZE = 100;
const DEBUG_RESULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEBUG_RESULT_PRUNE_BATCH_SIZE = 100;

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
      await txn.put(getDiscordActiveDeliveryKey(correlationId), true);

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
      await txn.delete(
        getDiscordActiveDeliveryKey(getDeliveryCorrelationId(record))
      );
    });
  }

  async getDelivery(correlationId: string) {
    return this.storage.get<DiscordDeliveryRecord>(
      getDiscordDeliveryKey(correlationId)
    );
  }

  async listActiveDeliveryRecords(limit = ACTIVE_DELIVERY_LIST_LIMIT) {
    const activeEntries = await this.storage.list<boolean>({
      prefix: DISCORD_ACTIVE_DELIVERY_PREFIX,
      limit
    });
    const activeKeys = [...activeEntries.keys()];
    const deliveryKeys = activeKeys.map((key) =>
      getDiscordDeliveryKey(key.slice(DISCORD_ACTIVE_DELIVERY_PREFIX.length))
    );
    const indexedDeliveries =
      deliveryKeys.length > 0
        ? await this.storage.get<DiscordDeliveryRecord>(deliveryKeys)
        : new Map<string, DiscordDeliveryRecord>();
    const records: DiscordDeliveryRecord[] = [];
    const seen = new Set<string>();
    const staleActiveKeys: string[] = [];

    for (let index = 0; index < activeKeys.length; index++) {
      const activeKey = activeKeys[index];
      const deliveryKey = deliveryKeys[index];
      const record = indexedDeliveries.get(deliveryKey);
      if (!record || isTerminalDeliveryStatus(record.status)) {
        staleActiveKeys.push(activeKey);
        continue;
      }

      records.push(record);
      seen.add(record.correlationId);
    }
    if (staleActiveKeys.length > 0) {
      await this.storage.delete(staleActiveKeys);
    }

    const migratedRecords = await this.migrateActiveDeliveryIndex();
    for (const record of migratedRecords) {
      if (seen.has(record.correlationId)) continue;
      records.push(record);
      if (records.length >= limit) break;
    }

    return records;
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

  async updateChatRequest(correlationId: string, request: DiscordChatRequest) {
    await this.updateDelivery(correlationId, (record) => {
      if (record.type !== "chat" || isTerminalDeliveryStatus(record.status)) {
        return record;
      }

      return {
        ...record,
        request,
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
      await txn.delete(
        getDiscordActiveDeliveryKey(getDeliveryCorrelationId(record))
      );
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

  private async migrateActiveDeliveryIndex() {
    const migrationComplete = await this.storage.get<boolean>(
      DISCORD_ACTIVE_INDEX_MIGRATION_COMPLETE_KEY
    );
    if (migrationComplete) return [];

    const cursor = await this.storage.get<string>(
      DISCORD_ACTIVE_INDEX_MIGRATION_CURSOR_KEY
    );
    const page = await this.storage.list<DiscordDeliveryRecord>({
      prefix: DISCORD_DELIVERY_PREFIX,
      startAfter: cursor,
      limit: ACTIVE_DELIVERY_MIGRATION_BATCH_SIZE
    });
    if (page.size === 0) {
      await this.storage.put(DISCORD_ACTIVE_INDEX_MIGRATION_COMPLETE_KEY, true);
      await this.storage.delete(DISCORD_ACTIVE_INDEX_MIGRATION_CURSOR_KEY);
      return [];
    }

    const records: DiscordDeliveryRecord[] = [];
    const indexBackfill: Record<string, boolean> = {};
    let lastKey: string | undefined;
    for (const [key, record] of page) {
      lastKey = key;
      if (isTerminalDeliveryStatus(record.status)) continue;
      records.push(record);
      indexBackfill[getDiscordActiveDeliveryKey(record.correlationId)] = true;
    }
    if (Object.keys(indexBackfill).length > 0) {
      await this.storage.put(indexBackfill);
    }

    if (page.size < ACTIVE_DELIVERY_MIGRATION_BATCH_SIZE) {
      await this.storage.put(DISCORD_ACTIVE_INDEX_MIGRATION_COMPLETE_KEY, true);
      await this.storage.delete(DISCORD_ACTIVE_INDEX_MIGRATION_CURSOR_KEY);
    } else if (lastKey) {
      await this.storage.put(
        DISCORD_ACTIVE_INDEX_MIGRATION_CURSOR_KEY,
        lastKey
      );
    }

    return records;
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

function getDiscordActiveDeliveryKey(correlationId: string) {
  return `${DISCORD_ACTIVE_DELIVERY_PREFIX}${correlationId}`;
}

function getDiscordDebugResultKey(targetId: string) {
  return `${DISCORD_DEBUG_RESULT_PREFIX}${targetId}`;
}

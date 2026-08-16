import { DurableObject } from "cloudflare:workers";
import { formatGuildMemoryContext } from "./guild-memory-formatter";

const GUILD_MEMORY_CATALOG_ID = 1;

export type GuildMemoryKind = "guild" | "user" | "relationship";
export type GuildMemorySource = "discord_turn" | "ambient_channel";

export type GuildMemoryRecord = {
  memoryId: string;
  kind: GuildMemoryKind;
  source: GuildMemorySource;
  content: string;
  subjectUserIds: string[];
  assertedByUserId?: string;
  sourceCorrelationId?: string;
  createdAt: string;
};

export type GuildMemoryCatalog = {
  records: GuildMemoryRecord[];
  revision: number;
  epoch: number;
  updatedAt: string | null;
};

export type GuildMemoryAddMutation = {
  type: "add";
  kind: GuildMemoryKind;
  content: string;
  subjectUserIds: string[];
};

export type GuildMemoryDeleteMutation = {
  type: "delete";
  memoryId: string;
};

export type GuildMemoryMutation =
  | GuildMemoryAddMutation
  | GuildMemoryDeleteMutation;

export type GuildMemoryCommitInput = {
  correlationId: string;
  baseEpoch: number;
  source: GuildMemorySource;
  assertedByUserId?: string;
  mutations: GuildMemoryMutation[];
};

export type GuildMemoryCommitResult = {
  status: "committed";
  changed: boolean;
  addedCount: number;
  deletedCount: number;
};

export type GuildMemoryCommitConflict = {
  status: "conflict";
  reason: "reset" | "missing_records";
  missingMemoryIds?: string[];
};

export type GuildMemoryDeleteResult = GuildMemoryCatalog & {
  changed: boolean;
  deleted?: GuildMemoryRecord;
  requestedMemoryId: string;
};

export type GuildMemoryResetResult = GuildMemoryCatalog & {
  changed: boolean;
  deletedCount: number;
  previousRevision: number;
};

type StoredCatalogRow = {
  revision: number;
  epoch: number;
  next_ordinal: number;
  updated_at: string | null;
};

type StoredMemoryRow = {
  memory_id: string;
  kind: GuildMemoryKind;
  source: string;
  content: string;
  subject_user_ids: string;
  asserted_by_user_id: string | null;
  source_correlation_id: string | null;
  created_at: string;
};

type StoredCommitRow = {
  result_json: string;
};

export class GuildMemoryProvider {
  private lastRead: GuildMemoryCatalog | null = null;

  constructor(
    private namespace: DurableObjectNamespace<GuildMemoryObject>,
    private getGuildId: () => string | undefined
  ) {}

  async get(): Promise<string | null> {
    const catalog = await this.getCatalog();
    return formatGuildMemoryContext(catalog.records);
  }

  async getCatalog() {
    const guildId = this.requireGuildId();
    const catalog = await this.getObject(guildId).getMemoryCatalog();
    this.lastRead = catalog;
    return catalog;
  }

  async getCurrentRevision() {
    const guildId = this.requireGuildId();
    return this.getObject(guildId).getMemoryRevision();
  }

  getLastReadRevision() {
    return this.lastRead?.revision;
  }

  async commit(input: GuildMemoryCommitInput) {
    const guildId = this.requireGuildId();
    return this.getObject(guildId).commitMemoryChanges(input);
  }

  private getObject(guildId: string) {
    return getGuildMemoryObject(this.namespace, guildId);
  }

  private requireGuildId() {
    const guildId = this.getGuildId();
    if (!guildId) {
      throw new Error("Guild memory requires a guild-scoped Agent.");
    }
    return guildId;
  }
}

export class GuildMemoryObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.initializeStorage());
  }

  async getMemoryCatalog(): Promise<GuildMemoryCatalog> {
    return this.readCatalog();
  }

  async getMemoryRevision(): Promise<number> {
    return this.readCatalogRow().revision;
  }

  async commitMemoryChanges(
    input: GuildMemoryCommitInput
  ): Promise<GuildMemoryCommitResult | GuildMemoryCommitConflict> {
    if (!isGuildMemorySource(input.source)) {
      throw new Error("Guild memory commit requires a valid source.");
    }

    const existingCommit = this.ctx.storage.sql
      .exec<StoredCommitRow>(
        "SELECT result_json FROM guild_memory_commits WHERE correlation_id = ?",
        input.correlationId
      )
      .toArray()[0];
    if (existingCommit) {
      return parseStoredCommitResult(existingCommit.result_json);
    }

    const catalog = this.readCatalogRow();
    if (catalog.epoch !== input.baseEpoch) {
      return { status: "conflict", reason: "reset" };
    }

    const deleteIds = [
      ...new Set(
        input.mutations
          .filter(
            (mutation): mutation is GuildMemoryDeleteMutation =>
              mutation.type === "delete"
          )
          .map((mutation) => mutation.memoryId)
      )
    ];
    const missingMemoryIds = deleteIds.filter(
      (memoryId) => !this.getStoredMemoryRow(memoryId)
    );
    if (missingMemoryIds.length > 0) {
      return {
        status: "conflict",
        reason: "missing_records",
        missingMemoryIds
      };
    }

    let deletedCount = 0;
    for (const memoryId of deleteIds) {
      deletedCount += this.ctx.storage.sql.exec(
        "DELETE FROM guild_memory_records WHERE memory_id = ?",
        memoryId
      ).rowsWritten;
    }

    let nextOrdinal = catalog.next_ordinal;
    let addedCount = 0;
    const now = new Date().toISOString();
    for (const mutation of input.mutations) {
      if (mutation.type !== "add") continue;
      const prepared = prepareAddMutation(mutation);
      const result = this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO guild_memory_records (
          memory_id,
          ordinal,
          kind,
          source,
          content,
          subject_user_ids,
          asserted_by_user_id,
          source_correlation_id,
          created_at,
          dedupe_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        nextOrdinal,
        prepared.kind,
        input.source,
        prepared.content,
        JSON.stringify(prepared.subjectUserIds),
        input.assertedByUserId ?? null,
        input.correlationId,
        now,
        createMemoryDedupeKey(prepared)
      );
      if (result.rowsWritten > 0) {
        nextOrdinal += 1;
        addedCount += 1;
      }
    }

    const changed = addedCount > 0 || deletedCount > 0;
    const nextRevision = changed ? catalog.revision + 1 : catalog.revision;
    const updatedAt = changed ? now : catalog.updated_at;
    if (changed) {
      this.ctx.storage.sql.exec(
        `UPDATE guild_memory_catalog
         SET version = ?, next_ordinal = ?, updated_at = ?
         WHERE id = ?`,
        nextRevision,
        nextOrdinal,
        updatedAt,
        GUILD_MEMORY_CATALOG_ID
      );
    }

    const result = {
      status: "committed",
      changed,
      addedCount,
      deletedCount
    } satisfies GuildMemoryCommitResult;
    this.ctx.storage.sql.exec(
      `INSERT INTO guild_memory_commits (
        correlation_id,
        result_json,
        committed_at
      ) VALUES (?, ?, ?)`,
      input.correlationId,
      JSON.stringify(result),
      now
    );
    return result;
  }

  async deleteMemoryRecord(memoryId: string): Promise<GuildMemoryDeleteResult> {
    const requestedMemoryId = memoryId.trim();
    const current = this.readCatalogRow();
    const stored = this.getStoredMemoryRow(requestedMemoryId);
    if (!stored) {
      return {
        ...(await this.readCatalog()),
        changed: false,
        requestedMemoryId
      };
    }

    const deleted = parseStoredMemoryRow(stored);
    this.ctx.storage.sql.exec(
      "DELETE FROM guild_memory_records WHERE memory_id = ?",
      requestedMemoryId
    );
    const updatedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE guild_memory_catalog
       SET version = ?, updated_at = ?
       WHERE id = ?`,
      current.revision + 1,
      updatedAt,
      GUILD_MEMORY_CATALOG_ID
    );

    return {
      ...(await this.readCatalog()),
      changed: true,
      deleted,
      requestedMemoryId
    };
  }

  async resetMemory(): Promise<GuildMemoryResetResult> {
    const current = this.readCatalogRow();
    const deletedCount = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM guild_memory_records"
      )
      .one().count;
    this.ctx.storage.sql.exec("DELETE FROM guild_memory_records");

    const changed = deletedCount > 0;
    const nextRevision = changed ? current.revision + 1 : current.revision;
    const updatedAt = changed ? new Date().toISOString() : current.updated_at;
    this.ctx.storage.sql.exec(
      `UPDATE guild_memory_catalog
       SET version = ?, epoch = ?, updated_at = ?
       WHERE id = ?`,
      nextRevision,
      current.epoch + 1,
      updatedAt,
      GUILD_MEMORY_CATALOG_ID
    );

    return {
      ...(await this.readCatalog()),
      changed,
      deletedCount,
      previousRevision: current.revision
    };
  }

  private initializeStorage() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const schemaVersion = this.ctx.storage.sql
      .exec<{ version: number }>(
        "SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations"
      )
      .one().version;

    if (schemaVersion < 1) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS guild_memory_catalog (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL,
          epoch INTEGER NOT NULL,
          next_ordinal INTEGER NOT NULL,
          updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS guild_memory_records (
          memory_id TEXT PRIMARY KEY,
          ordinal INTEGER NOT NULL UNIQUE,
          kind TEXT NOT NULL CHECK (kind IN ('guild', 'user', 'relationship')),
          content TEXT NOT NULL,
          subject_user_ids TEXT NOT NULL,
          asserted_by_user_id TEXT,
          source_correlation_id TEXT,
          created_at TEXT NOT NULL,
          dedupe_key TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS guild_memory_commits (
          correlation_id TEXT PRIMARY KEY,
          result_json TEXT NOT NULL,
          committed_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO guild_memory_catalog (
          id,
          version,
          epoch,
          next_ordinal,
          updated_at
        ) VALUES (1, 0, 0, 1, NULL);
        INSERT INTO _sql_schema_migrations (id, applied_at)
        VALUES (1, datetime('now'));
      `);
    }

    if (schemaVersion < 2) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE guild_memory_records
          ADD COLUMN source TEXT NOT NULL DEFAULT 'discord_turn'
          CHECK (source IN ('discord_turn', 'ambient_channel'));
        UPDATE guild_memory_records
        SET source = 'ambient_channel'
        WHERE source_correlation_id LIKE 'ambient:%';
        INSERT INTO _sql_schema_migrations (id, applied_at)
        VALUES (2, datetime('now'));
      `);
    }
  }

  private readCatalog(): GuildMemoryCatalog {
    const catalog = this.readCatalogRow();
    const records = this.ctx.storage.sql
      .exec<StoredMemoryRow>(
        `SELECT
          memory_id,
          kind,
          source,
          content,
          subject_user_ids,
          asserted_by_user_id,
          source_correlation_id,
          created_at
         FROM guild_memory_records
         ORDER BY ordinal ASC`
      )
      .toArray()
      .map(parseStoredMemoryRow);
    return {
      records,
      revision: catalog.revision,
      epoch: catalog.epoch,
      updatedAt: catalog.updated_at
    };
  }

  private readCatalogRow() {
    return this.ctx.storage.sql
      .exec<StoredCatalogRow>(
        `SELECT version AS revision, epoch, next_ordinal, updated_at
         FROM guild_memory_catalog
         WHERE id = ?`,
        GUILD_MEMORY_CATALOG_ID
      )
      .one();
  }

  private getStoredMemoryRow(memoryId: string) {
    return this.ctx.storage.sql
      .exec<StoredMemoryRow>(
        `SELECT
          memory_id,
          kind,
          source,
          content,
          subject_user_ids,
          asserted_by_user_id,
          source_correlation_id,
          created_at
         FROM guild_memory_records
         WHERE memory_id = ?`,
        memoryId
      )
      .toArray()[0];
  }
}

function prepareAddMutation(mutation: GuildMemoryAddMutation) {
  const content = mutation.content.trim();
  if (!content) throw new Error("Guild memory content cannot be empty.");
  const subjectUserIds = [
    ...new Set(mutation.subjectUserIds.map((userId) => userId.trim()))
  ].filter(Boolean);

  if (mutation.kind === "guild" && subjectUserIds.length !== 0) {
    throw new Error("Guild memory cannot have subject user IDs.");
  }
  if (mutation.kind === "user" && subjectUserIds.length !== 1) {
    throw new Error("User memory requires exactly one subject user ID.");
  }
  if (mutation.kind === "relationship" && subjectUserIds.length < 2) {
    throw new Error(
      "Relationship memory requires at least two subject user IDs."
    );
  }

  return {
    kind: mutation.kind,
    content,
    subjectUserIds
  };
}

function createMemoryDedupeKey(input: {
  kind: GuildMemoryKind;
  content: string;
  subjectUserIds: string[];
}) {
  return JSON.stringify([
    input.kind,
    [...input.subjectUserIds].sort(),
    input.content.trim().toLocaleLowerCase()
  ]);
}

function parseStoredMemoryRow(row: StoredMemoryRow): GuildMemoryRecord {
  if (!isGuildMemorySource(row.source)) {
    throw new Error(`Invalid source for guild memory ${row.memory_id}.`);
  }
  const parsedSubjectUserIds = JSON.parse(row.subject_user_ids) as unknown;
  if (
    !Array.isArray(parsedSubjectUserIds) ||
    !parsedSubjectUserIds.every((value) => typeof value === "string")
  ) {
    throw new Error(`Invalid subject user IDs for memory ${row.memory_id}.`);
  }

  return {
    memoryId: row.memory_id,
    kind: row.kind,
    source: row.source,
    content: row.content,
    subjectUserIds: parsedSubjectUserIds,
    ...(row.asserted_by_user_id
      ? { assertedByUserId: row.asserted_by_user_id }
      : {}),
    ...(row.source_correlation_id
      ? { sourceCorrelationId: row.source_correlation_id }
      : {}),
    createdAt: row.created_at
  };
}

function isGuildMemorySource(value: string): value is GuildMemorySource {
  return value === "discord_turn" || value === "ambient_channel";
}

function parseStoredCommitResult(resultJson: string): GuildMemoryCommitResult {
  const stored = JSON.parse(resultJson) as Partial<GuildMemoryCommitResult>;
  if (
    stored.status !== "committed" ||
    typeof stored.changed !== "boolean" ||
    typeof stored.addedCount !== "number" ||
    typeof stored.deletedCount !== "number"
  ) {
    throw new Error("Invalid stored guild memory commit result.");
  }

  return {
    status: "committed",
    changed: stored.changed,
    addedCount: stored.addedCount,
    deletedCount: stored.deletedCount
  };
}

export function getGuildMemoryObjectName(guildId: string) {
  return `discord:guild:${guildId}:memory`;
}

export function getGuildMemoryObject(
  namespace: DurableObjectNamespace<GuildMemoryObject>,
  guildId: string
) {
  const id = namespace.idFromName(getGuildMemoryObjectName(guildId));
  return namespace.get(id);
}

export async function listGuildMemory(
  namespace: DurableObjectNamespace<GuildMemoryObject>,
  guildId: string
) {
  return getGuildMemoryObject(namespace, guildId).getMemoryCatalog();
}

export async function deleteGuildMemoryRecord(
  namespace: DurableObjectNamespace<GuildMemoryObject>,
  guildId: string,
  memoryId: string
) {
  return getGuildMemoryObject(namespace, guildId).deleteMemoryRecord(memoryId);
}

export async function resetGuildMemory(
  namespace: DurableObjectNamespace<GuildMemoryObject>,
  guildId: string
) {
  return getGuildMemoryObject(namespace, guildId).resetMemory();
}

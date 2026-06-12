import type { WritableContextProvider } from "agents/experimental/memory/session";
import { DurableObject } from "cloudflare:workers";
import { logWarn } from "./logging";

const GUILD_MEMORY_STATE_KEY = "guild-memory";

export type GuildMemorySnapshot = {
  content: string;
  version: number;
  updatedAt: string | null;
};

export type GuildMemoryEntry = {
  index: number;
  content: string;
};

export type GuildMemoryList = GuildMemorySnapshot & {
  entries: GuildMemoryEntry[];
};

export type GuildMemoryDeleteResult = GuildMemoryList & {
  changed: boolean;
  deleted?: GuildMemoryEntry;
  requestedIndex: number;
};

export type GuildMemoryResetResult = GuildMemoryList & {
  changed: boolean;
  deletedCount: number;
  previousVersion: number;
};

type GuildMemoryUpdate = {
  baseContent: string;
  baseVersion: number;
  nextContent: string;
};

export class GuildMemoryProvider implements WritableContextProvider {
  private lastRead: GuildMemorySnapshot | null = null;

  constructor(
    private namespace: DurableObjectNamespace<GuildMemoryObject>,
    private getGuildId: () => string | undefined
  ) {}

  async get(): Promise<string | null> {
    const guildId = this.requireGuildId();
    const snapshot = await this.getObject(guildId).getMemory();
    this.lastRead = snapshot;
    return snapshot.content;
  }

  async getCurrentVersion() {
    const guildId = this.requireGuildId();
    return this.getObject(guildId).getMemoryVersion();
  }

  getLastReadVersion() {
    return this.lastRead?.version;
  }

  async set(content: string): Promise<void> {
    const guildId = this.requireGuildId();
    const object = this.getObject(guildId);
    const base = this.lastRead ?? (await object.getMemory());
    const snapshot = await object.setMemory({
      baseContent: base.content,
      baseVersion: base.version,
      nextContent: content
    });
    this.lastRead = snapshot;
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
  async getMemory(): Promise<GuildMemorySnapshot> {
    return this.readMemory();
  }

  async getMemoryList(): Promise<GuildMemoryList> {
    return createGuildMemoryList(await this.readMemory());
  }

  async getMemoryVersion(): Promise<number> {
    const snapshot = await this.readMemory();
    return snapshot.version;
  }

  async setMemory(update: GuildMemoryUpdate): Promise<GuildMemorySnapshot> {
    const current = await this.readMemory();
    const baseContent = normalizeMemory(update.baseContent);
    const nextContent = normalizeMemory(update.nextContent);

    if (current.version === update.baseVersion) {
      return this.writeMemory(current, nextContent);
    }

    if (nextContent.startsWith(baseContent)) {
      const suffix = nextContent.slice(baseContent.length);
      const mergedContent = appendMemorySuffix(current.content, suffix);
      return this.writeMemory(current, mergedContent);
    }

    logWarn("Guild memory write conflict", {
      currentVersion: current.version,
      baseVersion: update.baseVersion,
      currentLength: current.content.length,
      baseLength: baseContent.length,
      nextLength: nextContent.length
    });

    throw new Error(
      "Guild memory changed while this turn was running. Reload memory and retry the edit."
    );
  }

  async deleteMemoryEntry(index: number): Promise<GuildMemoryDeleteResult> {
    const current = await this.readMemory();
    const currentList = createGuildMemoryList(current);
    const deleted = currentList.entries[index - 1];

    if (!Number.isInteger(index) || !deleted) {
      return {
        ...currentList,
        changed: false,
        requestedIndex: index
      };
    }

    const nextContent = currentList.entries
      .filter((entry) => entry.index !== index)
      .map((entry) => entry.content)
      .join("\n");
    const snapshot = await this.writeMemory(current, nextContent);

    return {
      ...createGuildMemoryList(snapshot),
      changed: snapshot.version !== current.version,
      deleted,
      requestedIndex: index
    };
  }

  async resetMemory(): Promise<GuildMemoryResetResult> {
    const current = await this.readMemory();
    const deletedCount = createGuildMemoryEntries(current.content).length;
    const snapshot = await this.writeMemory(current, "");

    return {
      ...createGuildMemoryList(snapshot),
      changed: snapshot.version !== current.version,
      deletedCount,
      previousVersion: current.version
    };
  }

  private async readMemory(): Promise<GuildMemorySnapshot> {
    const stored = await this.ctx.storage.get<GuildMemorySnapshot>(
      GUILD_MEMORY_STATE_KEY
    );
    return {
      content: stored?.content ?? "",
      version: stored?.version ?? 0,
      updatedAt: stored?.updatedAt ?? null
    };
  }

  private async writeMemory(
    current: GuildMemorySnapshot,
    content: string
  ): Promise<GuildMemorySnapshot> {
    const normalized = normalizeMemory(content);

    if (normalized === current.content) {
      return current;
    }

    const snapshot = {
      content: normalized,
      version: current.version + 1,
      updatedAt: new Date().toISOString()
    };
    await this.ctx.storage.put(GUILD_MEMORY_STATE_KEY, snapshot);
    return snapshot;
  }
}

function appendMemorySuffix(content: string, suffix: string) {
  const normalizedContent = normalizeMemory(content);
  const normalizedSuffix = suffix.trim();

  if (!normalizedSuffix) {
    return normalizedContent;
  }

  if (!normalizedContent) {
    return normalizedSuffix;
  }

  if (suffix.startsWith("\n")) {
    return normalizeMemory(`${normalizedContent}${suffix}`);
  }

  return normalizeMemory(`${normalizedContent}\n${suffix}`);
}

function normalizeMemory(content: string) {
  return content.trim();
}

function createGuildMemoryList(snapshot: GuildMemorySnapshot): GuildMemoryList {
  return {
    ...snapshot,
    entries: createGuildMemoryEntries(snapshot.content)
  };
}

function createGuildMemoryEntries(content: string): GuildMemoryEntry[] {
  return normalizeMemory(content)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => ({
      index: index + 1,
      content: line
    }));
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
  return getGuildMemoryObject(namespace, guildId).getMemoryList();
}

export async function deleteGuildMemoryEntry(
  namespace: DurableObjectNamespace<GuildMemoryObject>,
  guildId: string,
  index: number
) {
  return getGuildMemoryObject(namespace, guildId).deleteMemoryEntry(index);
}

export async function resetGuildMemory(
  namespace: DurableObjectNamespace<GuildMemoryObject>,
  guildId: string
) {
  return getGuildMemoryObject(namespace, guildId).resetMemory();
}

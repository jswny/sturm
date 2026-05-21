import type { WritableContextProvider } from "agents/experimental/memory/session";
import { DurableObject } from "cloudflare:workers";
import { logWarn } from "./logging";

const GUILD_MEMORY_STATE_KEY = "guild-memory";

type GuildMemorySnapshot = {
  content: string;
  version: number;
  updatedAt: string | null;
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
    const id = this.namespace.idFromName(getGuildMemoryObjectName(guildId));
    return this.namespace.get(id);
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

export function getGuildIdFromConversationName(name: string | undefined) {
  const match = name?.match(/^discord:guild:([^:]+):channel:[^:]+$/);
  return match?.[1];
}

export function getGuildMemoryObjectName(guildId: string) {
  return `discord:guild:${guildId}:memory`;
}

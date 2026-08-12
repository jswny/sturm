import { pruneDurableStorageRecords } from "../storage-prune";
import type { DiscordRestCacheMode } from "./rest-member-cache";
import { getDiscordGuildRolesGuildId } from "./rest-routes";

type DiscordGuildRolesCacheState = {
  body: string;
  updatedAt: number;
  expiresAt: number;
};

const DISCORD_GUILD_ROLES_CACHE_PREFIX = "guild-roles:";

export class DiscordGuildRolesCacheStore {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly ttlMs: number
  ) {}

  async get(guildId: string) {
    const key = getGuildRolesCacheKey(guildId);
    const cached = await this.storage.get<DiscordGuildRolesCacheState>(key);
    if (!cached) return undefined;

    if (cached.expiresAt <= Date.now()) {
      await this.storage.delete(key);
      return undefined;
    }

    return cached;
  }

  async updateFromRestResponse(
    method: string,
    path: string,
    body: string,
    cacheMode: DiscordRestCacheMode
  ) {
    if (cacheMode === "no-store") return undefined;

    const guildId = getDiscordGuildRolesGuildId(method, path);
    if (!guildId || !isDiscordGuildRolesResponse(body)) return undefined;

    const now = Date.now();
    const entry = {
      body,
      updatedAt: now,
      expiresAt: now + this.ttlMs
    } satisfies DiscordGuildRolesCacheState;
    await this.storage.put(getGuildRolesCacheKey(guildId), entry);
    return entry.expiresAt;
  }

  async pruneExpired(now = Date.now()) {
    await pruneDurableStorageRecords<DiscordGuildRolesCacheState>(
      this.storage,
      {
        prefix: DISCORD_GUILD_ROLES_CACHE_PREFIX,
        shouldPrune: (state) => state.expiresAt <= now
      }
    );
  }

  async getNextExpiry(now = Date.now()) {
    const entries = await this.storage.list<DiscordGuildRolesCacheState>({
      prefix: DISCORD_GUILD_ROLES_CACHE_PREFIX
    });
    let next: number | undefined;

    for (const entry of entries.values()) {
      if (entry.expiresAt > now) {
        next =
          next === undefined
            ? entry.expiresAt
            : Math.min(next, entry.expiresAt);
      }
    }
    return next;
  }
}

function getGuildRolesCacheKey(guildId: string) {
  return `${DISCORD_GUILD_ROLES_CACHE_PREFIX}${guildId}`;
}

function isDiscordGuildRolesResponse(body: string) {
  try {
    const roles = JSON.parse(body) as unknown;
    if (!Array.isArray(roles)) return false;

    return roles.every(
      (role) =>
        role !== null &&
        typeof role === "object" &&
        typeof (role as { id?: unknown }).id === "string" &&
        typeof (role as { name?: unknown }).name === "string" &&
        typeof (role as { position?: unknown }).position === "number"
    );
  } catch {
    return false;
  }
}

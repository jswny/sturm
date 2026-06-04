import {
  getDiscordGuildMemberSearchGuildId,
  getDiscordGuildMemberTarget,
  isDiscordSnowflake,
  type DiscordGuildMemberTarget
} from "./rest-routes";

export type DiscordRestCacheMode = "default" | "reload" | "no-store";

export type DiscordGuildMemberCacheState = {
  body: string;
  updatedAt: number;
  expiresAt: number;
};

type DiscordGuildMemberResponse = {
  user?: {
    id?: unknown;
  };
};

const DISCORD_GUILD_MEMBER_CACHE_PREFIX = "guild-member:";

export class DiscordGuildMemberCacheStore {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly ttlMs: number
  ) {}

  async get(target: DiscordGuildMemberTarget) {
    const key = getGuildMemberCacheKey(target.guildId, target.userId);
    const cached = await this.storage.get<DiscordGuildMemberCacheState>(key);
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

    const target = getDiscordGuildMemberTarget(method, path);
    if (target) {
      return this.storeGuildMemberResponse(target.guildId, target.userId, body);
    }

    const searchGuildId = getDiscordGuildMemberSearchGuildId(method, path);
    if (!searchGuildId) return undefined;

    return this.storeGuildMemberSearchResponse(searchGuildId, body);
  }

  async pruneExpired(now = Date.now()) {
    const entries = await this.storage.list<DiscordGuildMemberCacheState>({
      prefix: DISCORD_GUILD_MEMBER_CACHE_PREFIX
    });

    await Promise.all(
      [...entries]
        .filter(([, state]) => state.expiresAt <= now)
        .map(([key]) => this.storage.delete(key))
    );
  }

  async getNextExpiry(now = Date.now()) {
    const entries = await this.storage.list<DiscordGuildMemberCacheState>({
      prefix: DISCORD_GUILD_MEMBER_CACHE_PREFIX
    });
    let next: number | undefined;

    for (const entry of entries.values()) {
      if (entry.expiresAt > now) next = minTimestamp(next, entry.expiresAt);
    }

    return next;
  }

  private async storeGuildMemberSearchResponse(guildId: string, body: string) {
    const members = parseGuildMemberSearchResponse(body);
    if (!members) return undefined;

    const writes: Promise<number>[] = [];
    for (const member of members) {
      const userId = getGuildMemberResponseUserId(member);
      if (userId) {
        writes.push(
          this.storeGuildMember(guildId, userId, JSON.stringify(member))
        );
      }
    }
    const expiresAts = await Promise.all(writes);
    let next: number | undefined;
    for (const expiresAt of expiresAts) {
      next = minTimestamp(next, expiresAt);
    }
    return next;
  }

  private async storeGuildMemberResponse(
    guildId: string,
    userId: string,
    body: string
  ) {
    const member = parseGuildMemberResponse(body);
    if (!member || getGuildMemberResponseUserId(member) !== userId) {
      await this.storage.delete(getGuildMemberCacheKey(guildId, userId));
      return undefined;
    }

    return this.storeGuildMember(guildId, userId, body);
  }

  private async storeGuildMember(
    guildId: string,
    userId: string,
    body: string
  ) {
    const now = Date.now();
    const entry = {
      body,
      updatedAt: now,
      expiresAt: now + this.ttlMs
    } satisfies DiscordGuildMemberCacheState;
    await this.storage.put(getGuildMemberCacheKey(guildId, userId), entry);
    return entry.expiresAt;
  }
}

function getGuildMemberCacheKey(guildId: string, userId: string) {
  return `${DISCORD_GUILD_MEMBER_CACHE_PREFIX}${guildId}:${userId}`;
}

function parseGuildMemberSearchResponse(body: string) {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!Array.isArray(parsed)) return undefined;

    const members: DiscordGuildMemberResponse[] = [];
    for (const value of parsed) {
      const member = parseGuildMember(value);
      if (member) members.push(member);
    }
    return members;
  } catch {
    return undefined;
  }
}

function parseGuildMemberResponse(body: string) {
  try {
    return parseGuildMember(JSON.parse(body) as unknown);
  } catch {
    return undefined;
  }
}

function parseGuildMember(
  value: unknown
): DiscordGuildMemberResponse | undefined {
  if (!value || typeof value !== "object") return undefined;

  const member = value as DiscordGuildMemberResponse;
  return getGuildMemberResponseUserId(member) ? member : undefined;
}

function getGuildMemberResponseUserId(member: DiscordGuildMemberResponse) {
  const userId = member.user?.id;
  return typeof userId === "string" && isDiscordSnowflake(userId)
    ? userId
    : undefined;
}

function minTimestamp(current: number | undefined, next: number) {
  return current === undefined ? next : Math.min(current, next);
}

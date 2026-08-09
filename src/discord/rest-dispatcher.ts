import { DurableObject } from "cloudflare:workers";
import { readResponseTextWithLimit } from "../http";
import { logError, logWarn } from "../logging";
import { pruneDurableStorageRecords } from "../storage-prune";
import {
  DiscordGuildMemberCacheStore,
  type DiscordRestCacheMode
} from "./rest-member-cache";
import {
  canWaitForDiscordRestRetry,
  getDiscordRestNetworkBackoffMs,
  getDiscordRestRateLimitBody,
  getDiscordRestResetAfterMs,
  getDiscordRestRetryAfterMs
} from "./rest-rate-limits";
import {
  getDiscordGuildMemberTarget,
  getDiscordRestBucketRateLimitKey,
  getDiscordRestMajorResourceKey,
  getDiscordRestRouteKey
} from "./rest-routes";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_REST_OBJECT_NAME = "bot-rest";
const DEFAULT_MAX_WAIT_MS = 5_000;
const MAX_ATTEMPTS = 3;
const JOB_TTL_MS = 10 * 60 * 1000;
const BUCKET_ALIAS_TTL_MS = 24 * 60 * 60 * 1000;
const GUILD_MEMBER_CACHE_TTL_MS = 5 * 60 * 1000;
const DISCORD_REST_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

type DiscordRestEnv = Env & {
  DISCORD_TOKEN?: string;
};

export type DiscordRestRequest = {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  fields?: DiscordRestFormField[];
  files?: DiscordRestFile[];
  maxWaitMs?: number;
  cache?: DiscordRestCacheMode;
};

export type DiscordRestFormField = {
  name: string;
  value: string;
};

export type DiscordRestFile = {
  fieldName: string;
  filename: string;
  mimeType: string;
  base64: string;
};

export type DiscordRestResult =
  | {
      ok: true;
      status: number;
      body: string;
    }
  | {
      ok: false;
      retryable: boolean;
      status?: number;
      body?: string;
      code?: number;
      retryAfterMs?: number;
      error: string;
    };

type DiscordRestJob = {
  id: string;
  method: string;
  path: string;
  routeKey: string;
  majorResourceKey: string;
  status: "active" | "completed" | "failed" | "retryable";
  attempts: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

type RateLimitState = {
  resetAt: number;
  updatedAt: number;
};

type BucketAliasState = {
  rateLimitKey: string;
  updatedAt: number;
  expiresAt: number;
};

type RateLimitCheck =
  | { ok: true }
  | { ok: false; retryAfterMs: number; error: string };

export class DiscordRestDispatcher extends DurableObject<DiscordRestEnv> {
  private queueTails = new Map<string, Promise<void>>();
  private alarmUpdates = Promise.resolve();

  async request(input: DiscordRestRequest): Promise<DiscordRestResult> {
    const method = (input.method ?? "GET").toUpperCase();
    const cacheTarget = getDiscordGuildMemberTarget(method, input.path);
    if (
      method === "GET" &&
      cacheTarget &&
      input.cache !== "reload" &&
      input.cache !== "no-store"
    ) {
      const cached = await this.memberCache.get(cacheTarget);
      if (cached && this.env.DISCORD_TOKEN?.trim()) {
        return {
          ok: true,
          status: 200,
          body: cached.body
        };
      }
    }

    const routeKey = getDiscordRestRouteKey(method, input.path);
    const majorResourceKey = getDiscordRestMajorResourceKey(input.path);
    const now = Date.now();
    const job = {
      id: crypto.randomUUID(),
      method,
      path: input.path,
      routeKey,
      majorResourceKey,
      status: "active",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + JOB_TTL_MS
    } satisfies DiscordRestJob;

    await this.ctx.storage.put(getJobKey(job.id), job);
    await this.scheduleCleanupAlarm(job.expiresAt);

    const queueKey = await this.getQueueKey(job.routeKey);
    return this.enqueueJob(queueKey, () => this.processJob(job, input));
  }

  override async alarm() {
    try {
      await this.pruneExpiredJobs();
      await this.pruneExpiredRateLimits();
      await this.pruneExpiredBucketAliases();
      await this.pruneExpiredGuildMemberCacheEntries();
      await this.scheduleNextAlarm();
    } catch (error) {
      logError("Discord REST dispatcher alarm failed", error);
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  private get memberCache() {
    return new DiscordGuildMemberCacheStore(
      this.ctx.storage,
      GUILD_MEMBER_CACHE_TTL_MS
    );
  }

  private async processJob(
    job: DiscordRestJob,
    input: DiscordRestRequest
  ): Promise<DiscordRestResult> {
    const token = this.env.DISCORD_TOKEN?.trim();
    if (!token) {
      return this.finishJob(job, {
        ok: false,
        retryable: false,
        status: 500,
        error: "DISCORD_TOKEN is not configured."
      });
    }

    const maxWaitMs = input.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    const deadline = Date.now() + maxWaitMs;
    let attempts = 0;

    while (attempts < MAX_ATTEMPTS) {
      attempts += 1;
      job = await this.updateJobAttempts(job, attempts);

      const routeCheck = await this.waitForStoredRateLimit(
        await this.getRateLimitKeys(job.routeKey),
        deadline
      );
      if (!routeCheck.ok) {
        return this.finishJob(job, {
          ok: false,
          retryable: true,
          retryAfterMs: routeCheck.retryAfterMs,
          error: routeCheck.error
        });
      }

      const globalCheck = await this.waitForStoredRateLimit(
        ["global"],
        deadline
      );
      if (!globalCheck.ok) {
        return this.finishJob(job, {
          ok: false,
          retryable: true,
          retryAfterMs: globalCheck.retryAfterMs,
          error: globalCheck.error
        });
      }

      let response: Response;
      let body: string;
      try {
        const headers = new Headers(input.headers);
        headers.set("authorization", `Bot ${token}`);
        const fetchBody = createDiscordRestBody(input);
        if (fetchBody instanceof FormData) {
          headers.delete("content-type");
        }

        response = await fetch(`${DISCORD_API_BASE}${input.path}`, {
          method: job.method,
          headers,
          body: fetchBody,
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))
        });
        body = await readResponseTextWithLimit(
          response,
          DISCORD_REST_RESPONSE_MAX_BYTES
        );
      } catch (error) {
        const retryAfterMs = getDiscordRestNetworkBackoffMs(attempts);
        if (
          !canWaitForDiscordRestRetry(deadline, retryAfterMs) ||
          attempts >= MAX_ATTEMPTS
        ) {
          logWarn("Discord REST network request failed", {
            method: job.method,
            routeKey: job.routeKey,
            attempts,
            error: error instanceof Error ? error.message : String(error)
          });
          return this.finishJob(job, {
            ok: false,
            retryable: true,
            retryAfterMs,
            error: "Discord REST request failed before a response was received."
          });
        }
        await sleep(retryAfterMs);
        continue;
      }

      await this.storeRateLimitHeaders(job, response, body);

      if (response.status === 429) {
        const retryAfterMs = getDiscordRestRetryAfterMs(response, body);
        if (
          retryAfterMs !== undefined &&
          canWaitForDiscordRestRetry(deadline, retryAfterMs) &&
          attempts < MAX_ATTEMPTS
        ) {
          await sleep(retryAfterMs);
          continue;
        }

        return this.finishJob(job, {
          ok: false,
          retryable: true,
          status: response.status,
          body,
          code: getDiscordErrorCode(body),
          retryAfterMs,
          error: "Discord rate limited this request. It was not completed."
        });
      }

      if (response.status >= 500 && response.status < 600) {
        const retryAfterMs = getDiscordRestNetworkBackoffMs(attempts);
        if (
          canWaitForDiscordRestRetry(deadline, retryAfterMs) &&
          attempts < MAX_ATTEMPTS
        ) {
          await sleep(retryAfterMs);
          continue;
        }
      }

      if (!response.ok) {
        return this.finishJob(job, {
          ok: false,
          retryable: false,
          status: response.status,
          body,
          code: getDiscordErrorCode(body),
          error: `Discord API request failed: ${response.status} ${body}`
        });
      }

      await this.updateGuildMemberCache(job, body, input.cache ?? "default");

      return this.finishJob(job, {
        ok: true,
        status: response.status,
        body
      });
    }

    return this.finishJob(job, {
      ok: false,
      retryable: true,
      retryAfterMs: getDiscordRestNetworkBackoffMs(attempts),
      error: "Discord REST request did not complete within retry limits."
    });
  }

  private enqueueJob(queueKey: string, task: () => Promise<DiscordRestResult>) {
    const previous = this.queueTails.get(queueKey) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.queueTails.set(queueKey, tail);
    void tail.finally(() => {
      if (this.queueTails.get(queueKey) === tail) {
        this.queueTails.delete(queueKey);
      }
    });
    return run;
  }

  private async updateJobAttempts(job: DiscordRestJob, attempts: number) {
    const updated = {
      ...job,
      attempts,
      updatedAt: Date.now()
    } satisfies DiscordRestJob;
    await this.ctx.storage.put(getJobKey(job.id), updated);
    return updated;
  }

  private async finishJob(
    job: DiscordRestJob,
    result: DiscordRestResult
  ): Promise<DiscordRestResult> {
    const now = Date.now();
    const updated = {
      ...job,
      status: result.ok
        ? "completed"
        : result.retryable
          ? "retryable"
          : "failed",
      updatedAt: now,
      expiresAt: now + JOB_TTL_MS
    } satisfies DiscordRestJob;
    await this.ctx.storage.put(getJobKey(job.id), updated);
    await this.scheduleCleanupAlarm(updated.expiresAt);
    return result;
  }

  private async waitForStoredRateLimit(
    keys: string[],
    deadline: number
  ): Promise<RateLimitCheck> {
    for (const key of keys) {
      const state = await this.ctx.storage.get<RateLimitState>(
        getRateLimitKey(key)
      );
      if (!state) continue;

      const retryAfterMs = state.resetAt - Date.now();
      if (retryAfterMs <= 0) {
        await this.ctx.storage.delete(getRateLimitKey(key));
        continue;
      }

      if (!canWaitForDiscordRestRetry(deadline, retryAfterMs)) {
        return {
          ok: false,
          retryAfterMs,
          error: "Discord rate limited this route. It was not completed."
        };
      }

      await sleep(retryAfterMs);
    }

    return { ok: true };
  }

  private async storeRateLimitHeaders(
    job: DiscordRestJob,
    response: Response,
    body: string
  ) {
    const rateLimitKey = await this.getResponseRateLimitKey(job, response);
    const retryAfterMs = getDiscordRestRetryAfterMs(response, body);
    const remaining = Number(response.headers.get("x-ratelimit-remaining"));
    const resetAfterMs = getDiscordRestResetAfterMs(response);
    const isGlobal =
      response.headers.get("x-ratelimit-global") === "true" ||
      getDiscordRestRateLimitBody(body)?.global === true;

    if (response.status === 429 && retryAfterMs !== undefined) {
      await this.storeRateLimit(
        isGlobal ? "global" : rateLimitKey,
        Date.now() + retryAfterMs
      );
      return;
    }

    if (Number.isFinite(remaining) && remaining <= 0 && resetAfterMs) {
      await this.storeRateLimit(rateLimitKey, Date.now() + resetAfterMs);
    }
  }

  private async getRateLimitKeys(routeKey: string) {
    const aliasKey = getBucketAliasKey(routeKey);
    const alias = await this.ctx.storage.get<BucketAliasState>(aliasKey);
    if (!alias) return [routeKey];

    if (alias.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(aliasKey);
      return [routeKey];
    }

    return alias.rateLimitKey === routeKey
      ? [routeKey]
      : [alias.rateLimitKey, routeKey];
  }

  private async getQueueKey(routeKey: string) {
    return (await this.getRateLimitKeys(routeKey))[0] ?? routeKey;
  }

  private async getResponseRateLimitKey(
    job: DiscordRestJob,
    response: Response
  ) {
    const bucket = response.headers.get("x-ratelimit-bucket");
    if (!bucket) return job.routeKey;

    const rateLimitKey = getDiscordRestBucketRateLimitKey(
      job.majorResourceKey,
      bucket
    );
    await this.storeBucketAlias(job.routeKey, rateLimitKey);
    return rateLimitKey;
  }

  private async storeBucketAlias(routeKey: string, rateLimitKey: string) {
    const now = Date.now();
    const alias = {
      rateLimitKey,
      updatedAt: now,
      expiresAt: now + BUCKET_ALIAS_TTL_MS
    } satisfies BucketAliasState;
    await this.ctx.storage.put(getBucketAliasKey(routeKey), alias);
    await this.scheduleCleanupAlarm(alias.expiresAt);
  }

  private async storeRateLimit(key: string, resetAt: number) {
    const state = { resetAt, updatedAt: Date.now() } satisfies RateLimitState;
    await this.ctx.storage.put(getRateLimitKey(key), state);
    await this.scheduleCleanupAlarm(resetAt);
  }

  private async updateGuildMemberCache(
    job: DiscordRestJob,
    body: string,
    cacheMode: DiscordRestCacheMode
  ) {
    const expiresAt = await this.memberCache.updateFromRestResponse(
      job.method,
      job.path,
      body,
      cacheMode
    );
    if (expiresAt) await this.scheduleCleanupAlarm(expiresAt);
  }

  private async pruneExpiredJobs() {
    const now = Date.now();
    await pruneDurableStorageRecords<DiscordRestJob>(this.ctx.storage, {
      prefix: "job:",
      shouldPrune: (job) => job.expiresAt <= now
    });
  }

  private async pruneExpiredRateLimits() {
    const now = Date.now();
    await pruneDurableStorageRecords<RateLimitState>(this.ctx.storage, {
      prefix: "rate:",
      shouldPrune: (state) => state.resetAt <= now
    });
  }

  private async pruneExpiredBucketAliases() {
    const now = Date.now();
    await pruneDurableStorageRecords<BucketAliasState>(this.ctx.storage, {
      prefix: "bucket-alias:",
      shouldPrune: (state) => state.expiresAt <= now
    });
  }

  private async pruneExpiredGuildMemberCacheEntries() {
    await this.memberCache.pruneExpired();
  }

  private async scheduleCleanupAlarm(timestamp: number) {
    await this.enqueueAlarmUpdate(async () => {
      const current = await this.ctx.storage.getAlarm();
      if (!current || timestamp < current) {
        await this.ctx.storage.setAlarm(timestamp);
      }
    });
  }

  private async scheduleNextAlarm() {
    await this.enqueueAlarmUpdate(async () => {
      const now = Date.now();
      let next: number | undefined;

      const jobs = await this.ctx.storage.list<DiscordRestJob>({
        prefix: "job:"
      });
      for (const job of jobs.values()) {
        if (job.expiresAt > now) next = minTimestamp(next, job.expiresAt);
      }

      const limits = await this.ctx.storage.list<RateLimitState>({
        prefix: "rate:"
      });
      for (const state of limits.values()) {
        if (state.resetAt > now) next = minTimestamp(next, state.resetAt);
      }

      const aliases = await this.ctx.storage.list<BucketAliasState>({
        prefix: "bucket-alias:"
      });
      for (const alias of aliases.values()) {
        if (alias.expiresAt > now) next = minTimestamp(next, alias.expiresAt);
      }

      const memberCacheExpiry = await this.memberCache.getNextExpiry(now);
      if (memberCacheExpiry) next = minTimestamp(next, memberCacheExpiry);

      if (next) {
        await this.ctx.storage.setAlarm(next);
      } else {
        await this.ctx.storage.deleteAlarm();
      }
    });
  }

  private enqueueAlarmUpdate(task: () => Promise<void>) {
    const run = this.alarmUpdates.catch(() => undefined).then(task);
    this.alarmUpdates = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

export function getDiscordRestDispatcher(
  namespace: DurableObjectNamespace<DiscordRestDispatcher>
) {
  return namespace.get(namespace.idFromName(DISCORD_REST_OBJECT_NAME));
}

function getJobKey(id: string) {
  return `job:${id}`;
}

function getRateLimitKey(key: string) {
  return `rate:${key}`;
}

function getBucketAliasKey(routeKey: string) {
  return `bucket-alias:${routeKey}`;
}

function createDiscordRestBody(input: DiscordRestRequest) {
  if (!input.files?.length && !input.fields?.length) return input.body;

  const form = new FormData();
  if (input.body !== undefined) form.append("payload_json", input.body);
  for (const field of input.fields ?? []) {
    form.append(field.name, field.value);
  }
  for (const file of input.files ?? []) {
    form.append(
      file.fieldName,
      new File([base64ToBytes(file.base64)], file.filename, {
        type: file.mimeType
      })
    );
  }
  return form;
}

function base64ToBytes(base64: string) {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function getDiscordErrorCode(body: string) {
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed.code === "number" ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function minTimestamp(current: number | undefined, next: number) {
  return current === undefined ? next : Math.min(current, next);
}

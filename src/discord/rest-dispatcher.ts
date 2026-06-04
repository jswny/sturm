import { DurableObject } from "cloudflare:workers";
import { logError, logWarn } from "../logging";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_REST_OBJECT_NAME = "bot-rest";
const DEFAULT_MAX_WAIT_MS = 5_000;
const MAX_ATTEMPTS = 3;
const JOB_TTL_MS = 10 * 60 * 1000;
const BUCKET_ALIAS_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_FUDGE_MS = 100;

type DiscordRestEnv = Env & {
  DISCORD_TOKEN?: string;
};

export type DiscordRestRequest = {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  files?: DiscordRestFile[];
  maxWaitMs?: number;
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
    const routeKey = getRouteKey(method, input.path);
    const majorResourceKey = getMajorResourceKey(input.path);
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
      await this.scheduleNextAlarm();
    } catch (error) {
      logError("Discord REST dispatcher alarm failed", error);
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
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
          body: fetchBody
        });
        body = await response.text();
      } catch (error) {
        const retryAfterMs = getNetworkBackoffMs(attempts);
        if (!canWait(deadline, retryAfterMs) || attempts >= MAX_ATTEMPTS) {
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
        const retryAfterMs = getRetryAfterMs(response, body);
        if (
          retryAfterMs !== undefined &&
          canWait(deadline, retryAfterMs) &&
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
        const retryAfterMs = getNetworkBackoffMs(attempts);
        if (canWait(deadline, retryAfterMs) && attempts < MAX_ATTEMPTS) {
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

      return this.finishJob(job, {
        ok: true,
        status: response.status,
        body
      });
    }

    return this.finishJob(job, {
      ok: false,
      retryable: true,
      retryAfterMs: getNetworkBackoffMs(attempts),
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

      if (!canWait(deadline, retryAfterMs)) {
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
    const retryAfterMs = getRetryAfterMs(response, body);
    const remaining = Number(response.headers.get("x-ratelimit-remaining"));
    const resetAfterMs = getResetAfterMs(response);
    const isGlobal =
      response.headers.get("x-ratelimit-global") === "true" ||
      getDiscordRateLimitBody(body)?.global === true;

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

    const rateLimitKey = getBucketRateLimitKey(job.majorResourceKey, bucket);
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

  private async pruneExpiredJobs() {
    const now = Date.now();
    const jobs = await this.ctx.storage.list<DiscordRestJob>({
      prefix: "job:"
    });

    await Promise.all(
      [...jobs]
        .filter(([, job]) => job.expiresAt <= now)
        .map(([key]) => this.ctx.storage.delete(key))
    );
  }

  private async pruneExpiredRateLimits() {
    const now = Date.now();
    const limits = await this.ctx.storage.list<RateLimitState>({
      prefix: "rate:"
    });

    await Promise.all(
      [...limits]
        .filter(([, state]) => state.resetAt <= now)
        .map(([key]) => this.ctx.storage.delete(key))
    );
  }

  private async pruneExpiredBucketAliases() {
    const now = Date.now();
    const aliases = await this.ctx.storage.list<BucketAliasState>({
      prefix: "bucket-alias:"
    });

    await Promise.all(
      [...aliases]
        .filter(([, state]) => state.expiresAt <= now)
        .map(([key]) => this.ctx.storage.delete(key))
    );
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
  if (!input.files?.length) return input.body;

  const form = new FormData();
  if (input.body !== undefined) form.append("payload_json", input.body);
  for (const file of input.files) {
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

function getRouteKey(method: string, path: string) {
  const pathname = path.split("?")[0] ?? path;
  const parts = pathname.split("/").map((part, index, all) => {
    if (isMajorResourceId(index, all)) return part;
    if (isWebhookToken(index, all)) return ":webhookToken";
    if (/^\d+$/.test(part)) return ":id";
    return part;
  });
  return `${method.toUpperCase()} ${parts.join("/")}`;
}

function getMajorResourceKey(path: string) {
  const parts = getPathParts(path);
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index];
    const id = parts[index + 1];
    if (part === "channels") return `channel:${id}`;
    if (part === "guilds") return `guild:${id}`;
    if (part === "webhooks") {
      const token = parts[index + 2];
      return token ? `webhook:${id}:${stableHash(token)}` : `webhook:${id}`;
    }
  }

  return "none";
}

function getBucketRateLimitKey(majorResourceKey: string, bucket: string) {
  return `bucket:${majorResourceKey}:${bucket}`;
}

function getPathParts(path: string) {
  const pathname = path.split("?")[0] ?? path;
  return pathname.split("/").filter(Boolean);
}

function isMajorResourceId(index: number, parts: string[]) {
  return ["channels", "guilds", "webhooks"].includes(parts[index - 1] ?? "");
}

function isWebhookToken(index: number, parts: string[]) {
  return parts[index - 2] === "webhooks";
}

function getRetryAfterMs(response: Response, body: string) {
  const parsed = getDiscordRateLimitBody(body);
  if (typeof parsed?.retry_after === "number") {
    return Math.ceil(parsed.retry_after * 1000) + RATE_LIMIT_FUDGE_MS;
  }

  const header = Number(response.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) {
    return Math.ceil(header * 1000) + RATE_LIMIT_FUDGE_MS;
  }

  return undefined;
}

function getResetAfterMs(response: Response) {
  const header = Number(response.headers.get("x-ratelimit-reset-after"));
  if (!Number.isFinite(header) || header <= 0) return undefined;
  return Math.ceil(header * 1000) + RATE_LIMIT_FUDGE_MS;
}

function getDiscordRateLimitBody(body: string) {
  try {
    return JSON.parse(body) as {
      retry_after?: unknown;
      global?: unknown;
    };
  } catch {
    return undefined;
  }
}

function getDiscordErrorCode(body: string) {
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed.code === "number" ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

function getNetworkBackoffMs(attempts: number) {
  return Math.min(250 * 2 ** Math.max(0, attempts - 1), 2_000);
}

function canWait(deadline: number, retryAfterMs: number) {
  return Date.now() + retryAfterMs <= deadline;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function minTimestamp(current: number | undefined, next: number) {
  return current === undefined ? next : Math.min(current, next);
}

function stableHash(input: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

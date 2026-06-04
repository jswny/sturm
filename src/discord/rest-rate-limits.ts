const RATE_LIMIT_FUDGE_MS = 100;

export function getDiscordRestRetryAfterMs(response: Response, body: string) {
  const parsed = getDiscordRestRateLimitBody(body);
  if (typeof parsed?.retry_after === "number") {
    return Math.ceil(parsed.retry_after * 1000) + RATE_LIMIT_FUDGE_MS;
  }

  const header = Number(response.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) {
    return Math.ceil(header * 1000) + RATE_LIMIT_FUDGE_MS;
  }

  return undefined;
}

export function getDiscordRestResetAfterMs(response: Response) {
  const header = Number(response.headers.get("x-ratelimit-reset-after"));
  if (!Number.isFinite(header) || header <= 0) return undefined;
  return Math.ceil(header * 1000) + RATE_LIMIT_FUDGE_MS;
}

export function getDiscordRestRateLimitBody(body: string) {
  try {
    return JSON.parse(body) as {
      retry_after?: unknown;
      global?: unknown;
    };
  } catch {
    return undefined;
  }
}

export function getDiscordRestNetworkBackoffMs(attempts: number) {
  return Math.min(250 * 2 ** Math.max(0, attempts - 1), 2_000);
}

export function canWaitForDiscordRestRetry(
  deadline: number,
  retryAfterMs: number
) {
  return Date.now() + retryAfterMs <= deadline;
}

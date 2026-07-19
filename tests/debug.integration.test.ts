import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

type WorkerFetch = {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>;
};

type JsonRecord = Record<string, unknown>;

const worker = exports.default as unknown as WorkerFetch;

const surface = {
  type: "guild_channel",
  guildId: "test-guild",
  channelId: "test-channel"
} as const;

describe("debug integration", () => {
  it("handles debug status and reset without live AI", async () => {
    const correlationId = `debug-integration-${crypto.randomUUID()}`;
    const resetCorrelationId = `${correlationId}-reset`;

    const health = await requestJson("GET", "/");
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      ok: true,
      service: "sturm"
    });

    const missingStatus = await postJson("/debug/status", {
      surface,
      correlationId: `${correlationId}-missing`
    });
    expect(missingStatus.status).toBe(200);
    expect(missingStatus.body).toMatchObject({
      ok: true,
      delivery: null,
      submission: null,
      memoryReflection: null
    });

    const reset = await postJson("/debug/reset", {
      surface,
      correlationId: resetCorrelationId
    });
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({
      ok: true,
      correlationId: resetCorrelationId,
      queued: true
    });

    const resetResponse = expectString(reset.body.response, "reset response");
    expect(resetResponse.length).toBeGreaterThan(0);

    const resetStatus = await waitForDebugStatus(
      resetCorrelationId,
      (status) => getOptionalRecord(status, "delivery")?.status === "delivered"
    );
    expect(getRecord(resetStatus, "delivery")).toMatchObject({
      type: "reset",
      correlationId: resetCorrelationId,
      status: "delivered",
      responseTargetType: "debug"
    });
    expect(resetStatus.submission).toBeNull();
    expect(resetStatus.memoryReflection).toBeNull();
  });
});

async function waitForDebugStatus(
  correlationId: string,
  isReady: (status: JsonRecord) => boolean
) {
  const deadline = Date.now() + 180_000;
  let lastStatus: JsonRecord | undefined;

  while (Date.now() < deadline) {
    const status = await postJson("/debug/status", {
      surface,
      correlationId
    });
    expect(status.status).toBe(200);
    lastStatus = status.body;

    if (isReady(lastStatus)) return lastStatus;
    await sleep(500);
  }

  throw new Error(
    `Timed out waiting for debug status ${correlationId}: ${JSON.stringify(
      lastStatus
    )}`
  );
}

async function postJson(path: string, body: unknown) {
  return requestJson("POST", path, body);
}

async function requestJson(method: string, path: string, body?: unknown) {
  const response = await worker.fetch(
    new Request(`https://sturm.test${path}`, {
      method,
      headers:
        body === undefined
          ? undefined
          : {
              "content-type": "application/json"
            },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  );
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as unknown) : null;

  return {
    status: response.status,
    body: expectRecord(parsed, `${method} ${path} response`)
  };
}

function getRecord(source: JsonRecord, key: string) {
  return expectRecord(source[key], key);
}

function getOptionalRecord(source: JsonRecord, key: string) {
  const value = source[key];
  if (value === null || value === undefined) return null;
  return expectRecord(value, key);
}

function expectRecord(value: unknown, label: string): JsonRecord {
  expect(value, label).toBeTypeOf("object");
  expect(value, label).not.toBeNull();
  expect(Array.isArray(value), label).toBe(false);
  return value as JsonRecord;
}

function expectString(value: unknown, label: string) {
  expect(value, label).toBeTypeOf("string");
  return value as string;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

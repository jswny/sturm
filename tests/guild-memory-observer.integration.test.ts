import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import {
  getGuildMemoryObserverName,
  type GuildMemoryObserverAgent
} from "../src/guild-memory-observer";
import type { GuildMemoryChannelMessageEvidence } from "../src/guild-memory-reflection-evidence-snapshot";

type ObserverInternals = {
  reflectNextReadyAmbientChannel(guildId: string): Promise<void>;
  reflectChannelEvidence(input: {
    evidence: GuildMemoryChannelMessageEvidence[];
  }): Promise<{ status: "completed"; reflection: null }>;
};

describe("guild memory observer", () => {
  it("advances surviving backfill jobs and spooled messages together", async () => {
    const guildId = uniqueId("generation-guild");
    const removedChannelId = uniqueId("removed-channel");
    const survivingChannelId = uniqueId("surviving-channel");
    const backfillId = uniqueId("backfill");
    const observer = await createObserver(guildId);

    await runInDurableObject(
      observer,
      async (_instance: GuildMemoryObserverAgent, state) => {
        seedSource(state, removedChannelId);
        seedSource(state, survivingChannelId);
        seedBackfill(state, {
          backfillId,
          channelId: survivingChannelId,
          generation: 0
        });
        seedAmbientRetry(state, survivingChannelId, 0);
      }
    );

    await observer.disableSource({
      guildId,
      channelId: removedChannelId,
      boundarySnowflake: "1"
    });

    const result = await runInDurableObject(
      observer,
      async (_instance: GuildMemoryObserverAgent, state) => {
        const metadata = state.storage.sql
          .exec<{ generation: number }>(
            "SELECT generation FROM guild_memory_observer_metadata WHERE id = 1"
          )
          .one();
        const job = state.storage.sql
          .exec<{ generation: number; failure_count: number }>(
            `SELECT generation, failure_count
             FROM guild_memory_backfill_jobs
             WHERE backfill_id = ?`,
            backfillId
          )
          .one();
        const spool = state.storage.sql
          .exec<{ generation: number }>(
            `SELECT generation
             FROM guild_memory_backfill_messages
             WHERE backfill_id = ?`,
            backfillId
          )
          .one();
        const retry = state.storage.sql
          .exec<{ generation: number; failure_count: number }>(
            `SELECT generation, failure_count
             FROM guild_memory_ambient_retries
             WHERE channel_id = ?`,
            survivingChannelId
          )
          .one();
        const removedSourceCount = state.storage.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count
             FROM guild_memory_observer_sources
             WHERE channel_id = ?`,
            removedChannelId
          )
          .one().count;
        return { metadata, job, spool, retry, removedSourceCount };
      }
    );

    expect(result).toEqual({
      metadata: { generation: 1 },
      job: { generation: 1, failure_count: 0 },
      spool: { generation: 1 },
      retry: { generation: 1, failure_count: 1 },
      removedSourceCount: 0
    });
  });

  it("cools a failed ambient batch so another ready channel can proceed", async () => {
    const guildId = uniqueId("ambient-fairness-guild");
    const failingChannelId = uniqueId("failing-channel");
    const healthyChannelId = uniqueId("healthy-channel");
    const observer = await createObserver(guildId);

    const result = await runInDurableObject(
      observer,
      async (instance: GuildMemoryObserverAgent, state) => {
        seedSource(state, failingChannelId);
        seedSource(state, healthyChannelId);
        seedAmbientMessage(state, {
          channelId: failingChannelId,
          messageId: "101",
          sentAtUtc: new Date(Date.now() - 20 * 60_000).toISOString()
        });
        seedAmbientMessage(state, {
          channelId: healthyChannelId,
          messageId: "102",
          sentAtUtc: new Date(Date.now() - 15 * 60_000).toISOString()
        });

        const internals = instance as unknown as ObserverInternals;
        const calls: string[] = [];
        internals.reflectChannelEvidence = async (input) => {
          const channelId = input.evidence[0]?.channelId;
          if (!channelId) throw new Error("Missing ambient test evidence.");
          calls.push(channelId);
          if (channelId === failingChannelId) {
            throw new Error("Permanent ambient test failure.");
          }
          return { status: "completed", reflection: null };
        };

        await internals.reflectNextReadyAmbientChannel(guildId);
        await internals.reflectNextReadyAmbientChannel(guildId);

        const retry = state.storage.sql
          .exec<{ failure_count: number; retry_after_utc: string }>(
            `SELECT failure_count, retry_after_utc
             FROM guild_memory_ambient_retries
             WHERE channel_id = ?`,
            failingChannelId
          )
          .one();
        const pending = state.storage.sql
          .exec<{ channel_id: string; count: number }>(
            `SELECT channel_id, COUNT(*) AS count
             FROM guild_memory_observer_messages
             GROUP BY channel_id
             ORDER BY channel_id`
          )
          .toArray();
        return { calls, retry, pending };
      }
    );

    expect(result.calls).toEqual([failingChannelId, healthyChannelId]);
    expect(result.retry.failure_count).toBe(1);
    expect(Date.parse(result.retry.retry_after_utc)).toBeGreaterThan(
      Date.now()
    );
    expect(result.pending).toEqual([
      { channel_id: failingChannelId, count: 1 }
    ]);
  });

  it("drops only the failed ambient batch after three observer attempts", async () => {
    const guildId = uniqueId("ambient-terminal-guild");
    const channelId = uniqueId("terminal-channel");
    const observer = await createObserver(guildId);

    const result = await runInDurableObject(
      observer,
      async (instance: GuildMemoryObserverAgent, state) => {
        seedSource(state, channelId);
        seedAmbientMessage(state, {
          channelId,
          messageId: "201",
          sentAtUtc: new Date(Date.now() - 20 * 60_000).toISOString()
        });

        const internals = instance as unknown as ObserverInternals;
        let callCount = 0;
        internals.reflectChannelEvidence = async () => {
          callCount += 1;
          throw new Error("Permanent ambient test failure.");
        };

        for (let attempt = 1; attempt <= 3; attempt++) {
          await internals.reflectNextReadyAmbientChannel(guildId);
          if (attempt < 3) {
            state.storage.sql.exec(
              `UPDATE guild_memory_ambient_retries
               SET retry_after_utc = ?
               WHERE channel_id = ?`,
              new Date(Date.now() - 1_000).toISOString(),
              channelId
            );
          }
        }

        const pendingCount = state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM guild_memory_observer_messages"
          )
          .one().count;
        const retryCount = state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM guild_memory_ambient_retries"
          )
          .one().count;
        return { callCount, pendingCount, retryCount };
      }
    );

    expect(result).toEqual({ callCount: 3, pendingCount: 0, retryCount: 0 });
  });

  it("deduplicates delayed continuation schedules for one backfill", async () => {
    const guildId = uniqueId("schedule-guild");
    const channelId = uniqueId("schedule-channel");
    const backfillId = uniqueId("scheduled-backfill");
    const observer = await createObserver(guildId);

    await runInDurableObject(
      observer,
      async (_instance: GuildMemoryObserverAgent, state) => {
        seedSource(state, channelId);
        seedBackfill(state, { backfillId, channelId, generation: 0 });
        state.storage.sql.exec(
          `INSERT INTO guild_memory_reflection_lease (
            id,
            owner,
            expires_at_utc
          ) VALUES (1, ?, ?)`,
          "test-active-reflection",
          new Date(Date.now() + 60_000).toISOString()
        );
      }
    );

    await observer.processBackfill({ backfillId });
    await observer.processBackfill({ backfillId });

    const continuationCount = await runInDurableObject(
      observer,
      async (instance: GuildMemoryObserverAgent) => {
        const schedules = await instance.listSchedules({ type: "delayed" });
        return schedules.filter(
          (schedule) =>
            schedule.type === "delayed" &&
            schedule.callback === "processBackfill" &&
            isBackfillPayload(schedule.payload, backfillId)
        ).length;
      }
    );
    expect(continuationCount).toBe(1);
  });
});

async function createObserver(guildId: string) {
  const observer = await getAgentByName(
    env.GuildMemoryObserver,
    getGuildMemoryObserverName(guildId)
  );
  await observer.listSources(guildId);
  return observer;
}

function seedSource(state: DurableObjectState, channelId: string) {
  const now = new Date().toISOString();
  state.storage.sql.exec(
    `INSERT INTO guild_memory_observer_sources (
      channel_id,
      channel_name,
      cursor_message_id,
      backfill_boundary_message_id,
      enabled_at_utc,
      updated_at_utc,
      last_polled_at_utc,
      last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    channelId,
    channelId,
    "100",
    "100",
    now,
    now,
    now
  );
}

function seedBackfill(
  state: DurableObjectState,
  input: { backfillId: string; channelId: string; generation: number }
) {
  const now = new Date().toISOString();
  state.storage.sql.exec(
    `INSERT INTO guild_memory_backfill_jobs (
      backfill_id,
      channel_id,
      channel_name,
      generation,
      status,
      message_limit,
      scanned_message_count,
      collected_message_count,
      reflected_message_count,
      before_message_id,
      oldest_scanned_message_id,
      failure_count,
      step_lease_owner,
      step_lease_expires_at_utc,
      created_at_utc,
      updated_at_utc,
      completed_at_utc,
      last_error
    ) VALUES (?, ?, ?, ?, 'reflecting', 1, 1, 1, 0, ?, ?, 0, NULL, NULL, ?, ?, NULL, NULL)`,
    input.backfillId,
    input.channelId,
    input.channelId,
    input.generation,
    "100",
    "100",
    now,
    now
  );
  state.storage.sql.exec(
    `INSERT INTO guild_memory_backfill_messages (
      backfill_id,
      message_id,
      channel_id,
      channel_name,
      author_user_id,
      author_display_name,
      content,
      sent_at_utc,
      observed_at_utc,
      generation
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.backfillId,
    "50",
    input.channelId,
    input.channelId,
    "test-user",
    "Test User",
    "Durable backfill evidence",
    now,
    now,
    input.generation
  );
}

function seedAmbientMessage(
  state: DurableObjectState,
  input: { channelId: string; messageId: string; sentAtUtc: string }
) {
  state.storage.sql.exec(
    `INSERT INTO guild_memory_observer_messages (
      message_id,
      channel_id,
      channel_name,
      author_user_id,
      author_display_name,
      content,
      sent_at_utc,
      observed_at_utc,
      generation
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    input.messageId,
    input.channelId,
    input.channelId,
    "test-user",
    "Test User",
    "Durable ambient evidence",
    input.sentAtUtc,
    new Date().toISOString()
  );
}

function seedAmbientRetry(
  state: DurableObjectState,
  channelId: string,
  generation: number
) {
  const now = new Date().toISOString();
  state.storage.sql.exec(
    `INSERT INTO guild_memory_ambient_retries (
      channel_id,
      correlation_id,
      generation,
      failure_count,
      retry_after_utc,
      updated_at_utc,
      last_error
    ) VALUES (?, ?, ?, 1, ?, ?, ?)`,
    channelId,
    `ambient:test:${channelId}`,
    generation,
    now,
    now,
    "test retry"
  );
}

function isBackfillPayload(payload: unknown, backfillId: string) {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "backfillId" in payload &&
    payload.backfillId === backfillId
  );
}

function uniqueId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

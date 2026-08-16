import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import {
  getGuildMemoryObserverName,
  type GuildMemoryObserverAgent
} from "../src/guild-memory-observer";

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
        const removedSourceCount = state.storage.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count
             FROM guild_memory_observer_sources
             WHERE channel_id = ?`,
            removedChannelId
          )
          .one().count;
        return { metadata, job, spool, removedSourceCount };
      }
    );

    expect(result).toEqual({
      metadata: { generation: 1 },
      job: { generation: 1, failure_count: 0 },
      spool: { generation: 1 },
      removedSourceCount: 0
    });
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

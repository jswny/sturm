import { Agent } from "agents";
import { getChannelMessages } from "./discord/api";
import {
  compareDiscordSnowflakes,
  getOldestDiscordMessageId,
  readDiscordMessagesAfterCursor,
  readDiscordMessagesBeforeCursor
} from "./discord/channel-message-pagination";
import {
  CHANNEL_REFLECTION_CHUNK_POLICY,
  createChannelMessageEvidence,
  createChannelReflectionCorrelationId,
  selectChannelReflectionEvidence,
  type GuildMemoryStoredChannelMessage
} from "./guild-memory-channel-evidence";
import { GuildMemoryReflectionRunner } from "./guild-memory-reflection-runner";
import type { GuildMemoryChannelMessageEvidence } from "./guild-memory-reflection-evidence-snapshot";
import { getErrorMessage, logError, logInfo, logWarn } from "./logging";
import { GuildMemoryProvider } from "./memory";
import {
  createAmbientGuildMemoryReflectionSnapshot,
  createBackfillGuildMemoryReflectionSnapshot,
  GuildMemoryReflectionStore
} from "./memory-reflection";
import {
  CHAT_AI_GATEWAY_FLOWS,
  createChatModel,
  MEMORY_REFLECTION_PROVIDER_OPTIONS
} from "./model";
import { searchGuildMembers } from "./nickname";

const OBSERVER_POLL_INTERVAL_SECONDS = 60;
const OBSERVER_REFLECTION_MAX_WAIT_MS = 10 * 60 * 1_000;
const OBSERVER_MAX_POLL_PAGES = 10;
const OBSERVER_REFLECTION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const MEMORY_BACKFILL_DEFAULT_MESSAGE_LIMIT = 500;
export const MEMORY_BACKFILL_MAX_MESSAGE_LIMIT = 1_000;
const MEMORY_BACKFILL_PAGE_SIZE = 100;
const MEMORY_BACKFILL_NEXT_STEP_SECONDS = 2;
const MEMORY_BACKFILL_REFLECTION_DELAY_SECONDS = 60;
const MEMORY_BACKFILL_MAX_FAILURES = 3;
const MEMORY_BACKFILL_STEP_LEASE_MS = 15 * 60 * 1_000;
const MEMORY_REFLECTION_LEASE_MS = 15 * 60 * 1_000;

type ObserverMetadataRow = {
  guild_id: string;
  generation: number;
};

type ObserverSourceRow = {
  channel_id: string;
  channel_name: string | null;
  cursor_message_id: string;
  backfill_boundary_message_id: string | null;
  enabled_at_utc: string;
  updated_at_utc: string;
  last_polled_at_utc: string | null;
  last_error: string | null;
};

type ObserverPendingMessageRow = GuildMemoryStoredChannelMessage & {
  observed_at_utc: string;
  generation: number;
};

type PendingChannelSummaryRow = {
  channel_id: string;
  pending_count: number;
  pending_content_chars: number;
  oldest_sent_at_utc: string;
};

type ChannelReflectionInput = {
  guildId: string;
  correlationId: string;
  evidence: GuildMemoryChannelMessageEvidence[];
  assertCanCommit(): void;
} & ({ kind: "ambient" } | { kind: "backfill"; backfillId: string });

export type BackfillStatus =
  | "collecting"
  | "reflecting"
  | "completed"
  | "failed"
  | "canceled";

type BackfillJobRow = {
  backfill_id: string;
  channel_id: string;
  channel_name: string | null;
  generation: number;
  status: BackfillStatus;
  message_limit: number;
  scanned_message_count: number;
  collected_message_count: number;
  reflected_message_count: number;
  before_message_id: string;
  oldest_scanned_message_id: string | null;
  failure_count: number;
  step_lease_owner: string | null;
  step_lease_expires_at_utc: string | null;
  created_at_utc: string;
  updated_at_utc: string;
  completed_at_utc: string | null;
  last_error: string | null;
};

type ReflectionLeaseRow = {
  owner: string;
  expires_at_utc: string;
};

export type GuildMemorySourceInput = {
  guildId: string;
  channelId: string;
  channelName?: string;
  boundarySnowflake: string;
};

export type GuildMemorySourceMutationResult = {
  status: "enabled" | "already_enabled" | "disabled" | "not_enabled";
  channelId: string;
  channelName?: string;
};

export type GuildMemorySourceStatus = {
  channelId: string;
  channelName?: string;
  cursorMessageId: string;
  enabledAtUtc: string;
  updatedAtUtc: string;
  lastPolledAtUtc?: string;
  lastError?: string;
  pendingMessageCount: number;
  latestBackfill?: GuildMemoryBackfillStatus;
};

export type GuildMemoryBackfillStatus = {
  backfillId: string;
  status: BackfillStatus;
  messageLimit: number;
  scannedMessageCount: number;
  collectedMessageCount: number;
  reflectedMessageCount: number;
  createdAtUtc: string;
  updatedAtUtc: string;
  completedAtUtc?: string;
  lastError?: string;
};

export type StartGuildMemoryBackfillResult = {
  status: "started" | "already_running" | "source_not_enabled";
  channelId: string;
  channelName?: string;
  backfill?: GuildMemoryBackfillStatus;
};

export class GuildMemoryObserverAgent extends Agent<Env> {
  private memoryReflections = new GuildMemoryReflectionStore(this.ctx.storage);

  override async onStart(props?: Record<string, unknown>) {
    await super.onStart(props);
    this.initializeStorage();
    try {
      await this.ensureObserverPollSchedule();
    } catch (error) {
      logError("Guild memory observer schedule registration failed", error, {
        agentName: this.name
      });
    }
  }

  async enableSource(
    input: GuildMemorySourceInput
  ): Promise<GuildMemorySourceMutationResult> {
    this.requireGuild(input.guildId);
    const existing = this.getSource(input.channelId);
    if (existing) {
      return {
        status: "already_enabled",
        channelId: existing.channel_id,
        ...(existing.channel_name ? { channelName: existing.channel_name } : {})
      };
    }

    const latest = await getChannelMessages(this.env, input.channelId, {
      limit: 1
    });
    const cursorMessageId = latest[0]?.id ?? input.boundarySnowflake;
    const now = new Date().toISOString();
    this.sql`
      INSERT OR IGNORE INTO guild_memory_observer_sources (
        channel_id,
        channel_name,
        cursor_message_id,
        backfill_boundary_message_id,
        enabled_at_utc,
        updated_at_utc,
        last_polled_at_utc,
        last_error
      ) VALUES (
        ${input.channelId},
        ${input.channelName ?? null},
        ${cursorMessageId},
        ${cursorMessageId},
        ${now},
        ${now},
        ${now},
        NULL
      )
    `;

    logInfo("Guild memory observation source enabled", {
      agentName: this.name,
      guildId: input.guildId,
      channelId: input.channelId,
      cursorMessageId
    });
    return {
      status: "enabled",
      channelId: input.channelId,
      ...(input.channelName ? { channelName: input.channelName } : {})
    };
  }

  async startBackfill(input: {
    guildId: string;
    channelId: string;
    channelName?: string;
    messageLimit: number;
  }): Promise<StartGuildMemoryBackfillResult> {
    const metadata = this.requireGuild(input.guildId);
    const source = this.getSource(input.channelId);
    if (!source) {
      return {
        status: "source_not_enabled",
        channelId: input.channelId,
        ...(input.channelName ? { channelName: input.channelName } : {})
      };
    }
    if (
      !Number.isInteger(input.messageLimit) ||
      input.messageLimit < 1 ||
      input.messageLimit > MEMORY_BACKFILL_MAX_MESSAGE_LIMIT
    ) {
      throw new Error(
        `Memory backfill message limit must be from 1 to ${MEMORY_BACKFILL_MAX_MESSAGE_LIMIT}.`
      );
    }

    const active = this.getActiveBackfill(input.channelId);
    if (active) {
      return {
        status: "already_running",
        channelId: input.channelId,
        ...(source.channel_name ? { channelName: source.channel_name } : {}),
        backfill: formatBackfillStatus(active)
      };
    }

    this.discardFailedBackfills(input.channelId);
    const previous = this.getLatestCompletedBackfill(input.channelId);
    const beforeMessageId =
      previous?.oldest_scanned_message_id ??
      source.backfill_boundary_message_id ??
      discordSnowflakeAtEndOfTimestamp(source.enabled_at_utc);
    const backfillId = crypto.randomUUID();
    const now = new Date().toISOString();
    this.sql`
      INSERT INTO guild_memory_backfill_jobs (
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
      ) VALUES (
        ${backfillId},
        ${input.channelId},
        ${input.channelName ?? source.channel_name},
        ${metadata.generation},
        'collecting',
        ${input.messageLimit},
        0,
        0,
        0,
        ${beforeMessageId},
        NULL,
        0,
        NULL,
        NULL,
        ${now},
        ${now},
        NULL,
        NULL
      )
    `;
    await this.scheduleBackfill(backfillId, 1);
    const job = this.requireBackfill(backfillId);
    logInfo("Guild memory channel backfill started", {
      agentName: this.name,
      guildId: input.guildId,
      channelId: input.channelId,
      backfillId,
      messageLimit: input.messageLimit,
      beforeMessageId
    });
    return {
      status: "started",
      channelId: input.channelId,
      ...(job.channel_name ? { channelName: job.channel_name } : {}),
      backfill: formatBackfillStatus(job)
    };
  }

  async disableSource(
    input: GuildMemorySourceInput
  ): Promise<GuildMemorySourceMutationResult> {
    const metadata = this.requireGuild(input.guildId);
    const existing = this.getSource(input.channelId);
    if (!existing) {
      return {
        status: "not_enabled",
        channelId: input.channelId,
        ...(input.channelName ? { channelName: input.channelName } : {})
      };
    }

    this.sql`
      DELETE FROM guild_memory_observer_messages
      WHERE channel_id = ${input.channelId}
    `;
    const nextGeneration = metadata.generation + 1;
    this.sql`
      DELETE FROM guild_memory_backfill_messages
      WHERE backfill_id IN (
        SELECT backfill_id
        FROM guild_memory_backfill_jobs
        WHERE channel_id = ${input.channelId}
      )
    `;
    this.sql`
      DELETE FROM guild_memory_backfill_jobs
      WHERE channel_id = ${input.channelId}
    `;
    this.sql`
      DELETE FROM guild_memory_observer_sources
      WHERE channel_id = ${input.channelId}
    `;
    this.advanceObservationGeneration(metadata.generation, nextGeneration);
    logInfo("Guild memory observation source disabled", {
      agentName: this.name,
      guildId: input.guildId,
      channelId: input.channelId
    });
    return {
      status: "disabled",
      channelId: input.channelId,
      ...(existing.channel_name ? { channelName: existing.channel_name } : {})
    };
  }

  async listSources(guildId: string): Promise<GuildMemorySourceStatus[]> {
    this.requireGuild(guildId);
    const sources = this.sql<ObserverSourceRow & { pending_count: number }>`
      SELECT
        source.channel_id,
        source.channel_name,
        source.cursor_message_id,
        source.backfill_boundary_message_id,
        source.enabled_at_utc,
        source.updated_at_utc,
        source.last_polled_at_utc,
        source.last_error,
        COUNT(message.message_id) AS pending_count
      FROM guild_memory_observer_sources AS source
      LEFT JOIN guild_memory_observer_messages AS message
        ON message.channel_id = source.channel_id
      GROUP BY source.channel_id
      ORDER BY source.enabled_at_utc ASC, source.channel_id ASC
    `;
    return sources.map((source) => {
      const latestBackfill = this.getLatestBackfill(source.channel_id);
      return {
        channelId: source.channel_id,
        ...(source.channel_name ? { channelName: source.channel_name } : {}),
        cursorMessageId: source.cursor_message_id,
        enabledAtUtc: source.enabled_at_utc,
        updatedAtUtc: source.updated_at_utc,
        ...(source.last_polled_at_utc
          ? { lastPolledAtUtc: source.last_polled_at_utc }
          : {}),
        ...(source.last_error ? { lastError: source.last_error } : {}),
        pendingMessageCount: source.pending_count,
        ...(latestBackfill
          ? { latestBackfill: formatBackfillStatus(latestBackfill) }
          : {})
      };
    });
  }

  async resetObservationBoundary(input: {
    guildId: string;
    boundarySnowflake: string;
  }) {
    const metadata = this.requireGuild(input.guildId);
    const now = new Date().toISOString();
    this.sql`DELETE FROM guild_memory_observer_messages`;
    this.sql`DELETE FROM guild_memory_backfill_messages`;
    this.sql`DELETE FROM guild_memory_backfill_jobs`;
    this.sql`
      UPDATE guild_memory_observer_sources
      SET
        cursor_message_id = ${input.boundarySnowflake},
        backfill_boundary_message_id = ${input.boundarySnowflake},
        updated_at_utc = ${now},
        last_error = NULL
    `;
    this.sql`
      UPDATE guild_memory_observer_metadata
      SET generation = ${metadata.generation + 1}
      WHERE id = 1
    `;
    logInfo("Guild memory observation reset boundary advanced", {
      agentName: this.name,
      guildId: input.guildId,
      generation: metadata.generation + 1,
      boundarySnowflake: input.boundarySnowflake
    });
  }

  async pollMemorySources() {
    const metadata = this.getMetadata();
    if (!metadata) return;

    const sources = this.sql<ObserverSourceRow>`
      SELECT
        channel_id,
        channel_name,
        cursor_message_id,
        backfill_boundary_message_id,
        enabled_at_utc,
        updated_at_utc,
        last_polled_at_utc,
        last_error
      FROM guild_memory_observer_sources
      ORDER BY channel_id ASC
    `;

    for (const source of sources) {
      await this.pollSource(metadata.guild_id, source);
    }

    await this.reflectNextReadyAmbientChannel(metadata.guild_id);
    const activeBackfill = this.getOldestActiveBackfill();
    if (activeBackfill) {
      await this.processBackfill({ backfillId: activeBackfill.backfill_id });
    }
    await this.memoryReflections.pruneTerminalRecords(
      OBSERVER_REFLECTION_RETENTION_MS
    );
  }

  private async pollSource(guildId: string, source: ObserverSourceRow) {
    try {
      const fetched = await readDiscordMessagesAfterCursor(
        this.env,
        source.channel_id,
        source.cursor_message_id,
        OBSERVER_MAX_POLL_PAGES
      );
      const currentSource = this.getSource(source.channel_id);
      const currentMetadata = this.getMetadata();
      if (!currentSource || !currentMetadata) return;

      const freshMessages = fetched
        .filter(
          (message) =>
            compareDiscordSnowflakes(
              message.id,
              currentSource.cursor_message_id
            ) > 0
        )
        .sort((left, right) => compareDiscordSnowflakes(left.id, right.id));
      const observedAtUtc = new Date().toISOString();
      for (const message of freshMessages) {
        const evidence = createChannelMessageEvidence(message, {
          channelId: currentSource.channel_id,
          ...(currentSource.channel_name
            ? { channelName: currentSource.channel_name }
            : {})
        });
        if (!evidence) continue;
        this.sql`
          INSERT OR IGNORE INTO guild_memory_observer_messages (
            message_id,
            channel_id,
            channel_name,
            author_user_id,
            author_display_name,
            content,
            sent_at_utc,
            observed_at_utc,
            generation
          ) VALUES (
            ${evidence.messageId},
            ${evidence.channelId},
            ${evidence.channelName ?? null},
            ${evidence.authorUserId},
            ${evidence.authorDisplayName ?? null},
            ${evidence.content},
            ${evidence.sentAtUtc},
            ${observedAtUtc},
            ${currentMetadata.generation}
          )
        `;
      }

      const newestMessageId = freshMessages.at(-1)?.id;
      const nextCursor = newestMessageId ?? currentSource.cursor_message_id;
      this.sql`
        UPDATE guild_memory_observer_sources
        SET
          cursor_message_id = ${nextCursor},
          updated_at_utc = ${observedAtUtc},
          last_polled_at_utc = ${observedAtUtc},
          last_error = NULL
        WHERE channel_id = ${source.channel_id}
      `;
      if (freshMessages.length > 0) {
        logInfo("Guild memory observer ingested Discord messages", {
          agentName: this.name,
          guildId,
          channelId: source.channel_id,
          fetchedCount: freshMessages.length,
          cursorMessageId: nextCursor
        });
      }
    } catch (error) {
      const now = new Date().toISOString();
      const message = truncateError(getErrorMessage(error));
      this.sql`
        UPDATE guild_memory_observer_sources
        SET
          updated_at_utc = ${now},
          last_polled_at_utc = ${now},
          last_error = ${message}
        WHERE channel_id = ${source.channel_id}
      `;
      logWarn("Guild memory observer channel poll failed", {
        agentName: this.name,
        guildId,
        channelId: source.channel_id,
        error: message
      });
    }
  }

  private async reflectNextReadyAmbientChannel(guildId: string) {
    const metadata = this.requireGuild(guildId);
    const readyChannel = this.getReadyAmbientChannel(metadata.generation);
    if (!readyChannel) return;

    const rows = this.sql<ObserverPendingMessageRow>`
      SELECT
        message_id,
        channel_id,
        channel_name,
        author_user_id,
        author_display_name,
        content,
        sent_at_utc,
        observed_at_utc,
        generation
      FROM guild_memory_observer_messages
      WHERE
        generation = ${metadata.generation}
        AND channel_id = ${readyChannel.channel_id}
      ORDER BY sent_at_utc ASC, message_id ASC
      LIMIT ${CHANNEL_REFLECTION_CHUNK_POLICY.maxMessages}
    `;
    const evidence = selectChannelReflectionEvidence(rows);
    if (evidence.length === 0) return;

    const correlationId = createChannelReflectionCorrelationId(
      "ambient",
      `${guildId}:${readyChannel.channel_id}`,
      evidence
    );
    const assertCanCommit = () => {
      const current = this.requireGuild(guildId);
      if (
        current.generation !== metadata.generation ||
        !this.getSource(readyChannel.channel_id)
      ) {
        throw new Error(
          "Guild memory observation boundary changed while reflection was running."
        );
      }
    };

    try {
      const result = await this.reflectChannelEvidence({
        kind: "ambient",
        guildId,
        correlationId,
        evidence,
        assertCanCommit
      });
      if (result.status === "busy") return;
      try {
        assertCanCommit();
      } catch {
        return;
      }
      for (const message of evidence) {
        this.sql`
          DELETE FROM guild_memory_observer_messages
          WHERE
            message_id = ${message.messageId}
            AND channel_id = ${readyChannel.channel_id}
            AND generation = ${metadata.generation}
        `;
      }
      const reflection = result.reflection;
      logInfo("Guild memory observer reflected ambient messages", {
        agentName: this.name,
        guildId,
        channelId: readyChannel.channel_id,
        correlationId,
        messageCount: evidence.length,
        changed: reflection?.changed ?? false,
        operation: reflection?.operation,
        addedCount:
          reflection && "addedCount" in reflection
            ? reflection.addedCount
            : undefined,
        deletedCount:
          reflection && "deletedCount" in reflection
            ? reflection.deletedCount
            : undefined,
        attempts: reflection?.attempts
      });
    } catch (error) {
      logWarn("Guild memory observer reflection failed", {
        agentName: this.name,
        guildId,
        channelId: readyChannel.channel_id,
        correlationId,
        messageCount: evidence.length,
        error: getErrorMessage(error)
      });
    }
  }

  private getReadyAmbientChannel(generation: number) {
    const cutoffUtc = new Date(
      Date.now() - OBSERVER_REFLECTION_MAX_WAIT_MS
    ).toISOString();
    return this.sql<PendingChannelSummaryRow>`
      SELECT
        channel_id,
        COUNT(*) AS pending_count,
        SUM(
          CASE
            WHEN LENGTH(TRIM(content)) <= ${CHANNEL_REFLECTION_CHUNK_POLICY.maxMessageChars}
              THEN LENGTH(TRIM(content))
            ELSE ${CHANNEL_REFLECTION_CHUNK_POLICY.maxMessageChars + CHANNEL_REFLECTION_CHUNK_POLICY.truncationMarker.length}
          END
        ) AS pending_content_chars,
        MIN(sent_at_utc) AS oldest_sent_at_utc
      FROM guild_memory_observer_messages
      WHERE generation = ${generation}
      GROUP BY channel_id
      HAVING
        COUNT(*) >= ${CHANNEL_REFLECTION_CHUNK_POLICY.maxMessages}
        OR pending_content_chars >= ${CHANNEL_REFLECTION_CHUNK_POLICY.maxContentChars}
        OR MIN(sent_at_utc) <= ${cutoffUtc}
      ORDER BY oldest_sent_at_utc ASC, channel_id ASC
      LIMIT 1
    `[0];
  }

  private async reflectChannelEvidence(input: ChannelReflectionInput) {
    const leaseOwner = `${input.kind}:${crypto.randomUUID()}`;
    if (!this.tryAcquireReflectionLease(leaseOwner)) {
      return { status: "busy" } as const;
    }
    const snapshot =
      input.kind === "ambient"
        ? createAmbientGuildMemoryReflectionSnapshot(
            input.correlationId,
            input.guildId,
            input.evidence
          )
        : createBackfillGuildMemoryReflectionSnapshot(
            input.correlationId,
            input.guildId,
            input.backfillId,
            input.evidence
          );
    const runner = new GuildMemoryReflectionRunner({
      store: this.memoryReflections,
      getProvider: () =>
        new GuildMemoryProvider(this.env.GuildMemory, () => input.guildId),
      createModel: () =>
        createChatModel(
          this.env,
          CHAT_AI_GATEWAY_FLOWS.memoryReflection,
          { correlationId: input.correlationId, guildId: input.guildId },
          this.name
        ),
      searchGuildMembers: (_snapshot, query) =>
        searchGuildMembers(this.env, { guildId: input.guildId }, query),
      assertCanCommit: () => input.assertCanCommit(),
      providerOptions: MEMORY_REFLECTION_PROVIDER_OPTIONS
    });

    try {
      return {
        status: "completed",
        reflection: await runner.run(snapshot)
      } as const;
    } finally {
      this.releaseReflectionLease(leaseOwner);
    }
  }

  async processBackfill(payload: { backfillId: string }) {
    const initial = this.getBackfill(payload.backfillId);
    if (!initial || !isActiveBackfill(initial.status)) return;

    const stepOwner = crypto.randomUUID();
    if (!this.tryAcquireBackfillStepLease(initial.backfill_id, stepOwner)) {
      return;
    }

    let nextDelaySeconds: number | undefined;
    try {
      const job = this.requireBackfill(initial.backfill_id);
      const metadata = this.getMetadata();
      if (
        !metadata ||
        metadata.generation !== job.generation ||
        !this.getSource(job.channel_id)
      ) {
        this.cancelBackfill(job.backfill_id, "observation_boundary_changed");
        return;
      }

      nextDelaySeconds =
        job.status === "collecting"
          ? await this.collectBackfillPage(job)
          : await this.reflectBackfillBatch(metadata.guild_id, job);
      this.sql`
        UPDATE guild_memory_backfill_jobs
        SET failure_count = 0, last_error = NULL
        WHERE backfill_id = ${job.backfill_id}
      `;
    } catch (error) {
      const current = this.getBackfill(initial.backfill_id);
      if (!current || !isActiveBackfill(current.status)) return;
      if (current.generation !== initial.generation) {
        nextDelaySeconds = MEMORY_BACKFILL_NEXT_STEP_SECONDS;
        logInfo("Guild memory channel backfill generation advanced", {
          agentName: this.name,
          backfillId: current.backfill_id,
          channelId: current.channel_id,
          previousGeneration: initial.generation,
          generation: current.generation
        });
      } else {
        const failureCount = current.failure_count + 1;
        const message = truncateError(getErrorMessage(error));
        const now = new Date().toISOString();
        if (failureCount >= MEMORY_BACKFILL_MAX_FAILURES) {
          this.sql`
            UPDATE guild_memory_backfill_jobs
            SET
              status = 'failed',
              failure_count = ${failureCount},
              updated_at_utc = ${now},
              completed_at_utc = ${now},
              last_error = ${message}
            WHERE backfill_id = ${current.backfill_id}
          `;
        } else {
          this.sql`
            UPDATE guild_memory_backfill_jobs
            SET
              failure_count = ${failureCount},
              updated_at_utc = ${now},
              last_error = ${message}
            WHERE backfill_id = ${current.backfill_id}
          `;
          nextDelaySeconds = MEMORY_BACKFILL_REFLECTION_DELAY_SECONDS;
        }
        logWarn("Guild memory channel backfill step failed", {
          agentName: this.name,
          backfillId: current.backfill_id,
          channelId: current.channel_id,
          failureCount,
          terminal: failureCount >= MEMORY_BACKFILL_MAX_FAILURES,
          error: message
        });
      }
    } finally {
      this.releaseBackfillStepLease(initial.backfill_id, stepOwner);
    }

    if (nextDelaySeconds !== undefined) {
      await this.scheduleBackfill(initial.backfill_id, nextDelaySeconds);
    }
  }

  private async collectBackfillPage(job: BackfillJobRow) {
    const remaining = job.message_limit - job.scanned_message_count;
    if (remaining <= 0) {
      this.markBackfillReflecting(job.backfill_id);
      return MEMORY_BACKFILL_NEXT_STEP_SECONDS;
    }

    const requested = Math.min(MEMORY_BACKFILL_PAGE_SIZE, remaining);
    const page = await readDiscordMessagesBeforeCursor(
      this.env,
      job.channel_id,
      job.before_message_id,
      requested
    );
    const current = this.requireBackfill(job.backfill_id);
    const metadata = this.getMetadata();
    if (
      !metadata ||
      current.generation !== job.generation ||
      metadata.generation !== job.generation ||
      current.status !== "collecting"
    ) {
      throw new Error("Backfill boundary changed while paging Discord.");
    }

    let collectedCount = 0;
    const observedAtUtc = new Date().toISOString();
    for (const message of page) {
      const evidence = createChannelMessageEvidence(message, {
        channelId: current.channel_id,
        ...(current.channel_name ? { channelName: current.channel_name } : {})
      });
      if (!evidence) continue;
      collectedCount += this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO guild_memory_backfill_messages (
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
        current.backfill_id,
        evidence.messageId,
        evidence.channelId,
        evidence.channelName ?? null,
        evidence.authorUserId,
        evidence.authorDisplayName ?? null,
        evidence.content,
        evidence.sentAtUtc,
        observedAtUtc,
        current.generation
      ).rowsWritten;
    }

    const oldestMessageId =
      page.length > 0
        ? getOldestDiscordMessageId(page)
        : current.before_message_id;
    const scannedMessageCount = current.scanned_message_count + page.length;
    const collectionComplete =
      page.length < requested || scannedMessageCount >= current.message_limit;
    this.sql`
      UPDATE guild_memory_backfill_jobs
      SET
        status = ${collectionComplete ? "reflecting" : "collecting"},
        scanned_message_count = ${scannedMessageCount},
        collected_message_count = collected_message_count + ${collectedCount},
        before_message_id = ${oldestMessageId},
        oldest_scanned_message_id = ${oldestMessageId},
        updated_at_utc = ${observedAtUtc}
      WHERE backfill_id = ${current.backfill_id}
    `;
    logInfo("Guild memory channel backfill paged Discord messages", {
      agentName: this.name,
      backfillId: current.backfill_id,
      channelId: current.channel_id,
      fetchedCount: page.length,
      collectedCount,
      scannedMessageCount,
      messageLimit: current.message_limit,
      collectionComplete
    });
    return MEMORY_BACKFILL_NEXT_STEP_SECONDS;
  }

  private async reflectBackfillBatch(guildId: string, job: BackfillJobRow) {
    if (this.hasReadyAmbientChannel(job.generation)) {
      await this.reflectNextReadyAmbientChannel(guildId);
      return MEMORY_BACKFILL_REFLECTION_DELAY_SECONDS;
    }

    const rows = this.sql<GuildMemoryStoredChannelMessage>`
      SELECT
        message_id,
        channel_id,
        channel_name,
        author_user_id,
        author_display_name,
        content,
        sent_at_utc
      FROM guild_memory_backfill_messages
      WHERE
        backfill_id = ${job.backfill_id}
        AND generation = ${job.generation}
      ORDER BY sent_at_utc ASC, message_id ASC
      LIMIT ${CHANNEL_REFLECTION_CHUNK_POLICY.maxMessages}
    `;
    const evidence = selectChannelReflectionEvidence(rows);
    if (evidence.length === 0) {
      this.completeBackfill(job.backfill_id);
      return undefined;
    }

    const correlationId = createChannelReflectionCorrelationId(
      "backfill",
      job.backfill_id,
      evidence
    );
    const assertCanCommit = () => {
      const currentMetadata = this.requireGuild(guildId);
      const currentJob = this.requireBackfill(job.backfill_id);
      if (
        currentMetadata.generation !== job.generation ||
        currentJob.generation !== job.generation ||
        currentJob.status !== "reflecting" ||
        !this.getSource(job.channel_id)
      ) {
        throw new Error(
          "Guild memory backfill boundary changed while reflection was running."
        );
      }
    };

    const result = await this.reflectChannelEvidence({
      kind: "backfill",
      guildId,
      correlationId,
      backfillId: job.backfill_id,
      evidence,
      assertCanCommit
    });
    if (result.status === "busy") {
      return MEMORY_BACKFILL_REFLECTION_DELAY_SECONDS;
    }
    try {
      assertCanCommit();
    } catch {
      return undefined;
    }
    let reflectedCount = 0;
    for (const message of evidence) {
      reflectedCount += this.ctx.storage.sql.exec(
        `DELETE FROM guild_memory_backfill_messages
         WHERE backfill_id = ? AND message_id = ? AND generation = ?`,
        job.backfill_id,
        message.messageId,
        job.generation
      ).rowsWritten;
    }
    const now = new Date().toISOString();
    this.sql`
      UPDATE guild_memory_backfill_jobs
      SET
        reflected_message_count = reflected_message_count + ${reflectedCount},
        updated_at_utc = ${now}
      WHERE backfill_id = ${job.backfill_id}
    `;
    const reflection = result.reflection;
    logInfo("Guild memory channel backfill reflected messages", {
      agentName: this.name,
      guildId,
      backfillId: job.backfill_id,
      channelId: job.channel_id,
      correlationId,
      messageCount: reflectedCount,
      changed: reflection?.changed ?? false,
      operation: reflection?.operation,
      attempts: reflection?.attempts
    });
    return MEMORY_BACKFILL_REFLECTION_DELAY_SECONDS;
  }

  private hasReadyAmbientChannel(generation: number) {
    return Boolean(this.getReadyAmbientChannel(generation));
  }

  private tryAcquireReflectionLease(owner: string) {
    const current = this.sql<ReflectionLeaseRow>`
      SELECT owner, expires_at_utc
      FROM guild_memory_reflection_lease
      WHERE id = 1
    `[0];
    const nowMs = Date.now();
    if (current && Date.parse(current.expires_at_utc) > nowMs) return false;
    const expiresAtUtc = new Date(
      nowMs + MEMORY_REFLECTION_LEASE_MS
    ).toISOString();
    this.sql`
      INSERT INTO guild_memory_reflection_lease (id, owner, expires_at_utc)
      VALUES (1, ${owner}, ${expiresAtUtc})
      ON CONFLICT(id) DO UPDATE SET
        owner = excluded.owner,
        expires_at_utc = excluded.expires_at_utc
    `;
    return true;
  }

  private releaseReflectionLease(owner: string) {
    this.sql`
      DELETE FROM guild_memory_reflection_lease
      WHERE id = 1 AND owner = ${owner}
    `;
  }

  private tryAcquireBackfillStepLease(backfillId: string, owner: string) {
    const now = new Date();
    const expiresAtUtc = new Date(
      now.getTime() + MEMORY_BACKFILL_STEP_LEASE_MS
    ).toISOString();
    return (
      this.ctx.storage.sql.exec(
        `UPDATE guild_memory_backfill_jobs
         SET step_lease_owner = ?, step_lease_expires_at_utc = ?
         WHERE
           backfill_id = ?
           AND status IN ('collecting', 'reflecting')
           AND (
             step_lease_owner IS NULL
             OR step_lease_expires_at_utc IS NULL
             OR step_lease_expires_at_utc <= ?
           )`,
        owner,
        expiresAtUtc,
        backfillId,
        now.toISOString()
      ).rowsWritten > 0
    );
  }

  private releaseBackfillStepLease(backfillId: string, owner: string) {
    this.ctx.storage.sql.exec(
      `UPDATE guild_memory_backfill_jobs
       SET step_lease_owner = NULL, step_lease_expires_at_utc = NULL
       WHERE backfill_id = ? AND step_lease_owner = ?`,
      backfillId,
      owner
    );
  }

  private async scheduleBackfill(backfillId: string, delaySeconds: number) {
    await this.schedule(
      delaySeconds,
      "processBackfill",
      { backfillId },
      { idempotent: true }
    );
  }

  private advanceObservationGeneration(
    currentGeneration: number,
    nextGeneration: number
  ) {
    this.ctx.storage.transactionSync(() => {
      this.sql`
        UPDATE guild_memory_observer_messages
        SET generation = ${nextGeneration}
        WHERE generation = ${currentGeneration}
      `;
      this.sql`
        UPDATE guild_memory_backfill_messages
        SET generation = ${nextGeneration}
        WHERE
          generation = ${currentGeneration}
          AND backfill_id IN (
            SELECT backfill_id
            FROM guild_memory_backfill_jobs
            WHERE
              generation = ${currentGeneration}
              AND status IN ('collecting', 'reflecting')
          )
      `;
      this.sql`
        UPDATE guild_memory_backfill_jobs
        SET generation = ${nextGeneration}
        WHERE
          generation = ${currentGeneration}
          AND status IN ('collecting', 'reflecting')
      `;
      this.sql`
        UPDATE guild_memory_observer_metadata
        SET generation = ${nextGeneration}
        WHERE id = 1 AND generation = ${currentGeneration}
      `;
    });
  }

  private async ensureObserverPollSchedule() {
    const intervalSchedules = await this.listSchedules({ type: "interval" });
    for (const schedule of intervalSchedules) {
      if (
        schedule.type === "interval" &&
        schedule.callback === "pollMemorySources" &&
        schedule.intervalSeconds !== OBSERVER_POLL_INTERVAL_SECONDS
      ) {
        await this.cancelSchedule(schedule.id);
      }
    }
    await this.scheduleEvery(
      OBSERVER_POLL_INTERVAL_SECONDS,
      "pollMemorySources"
    );
  }

  private markBackfillReflecting(backfillId: string) {
    const now = new Date().toISOString();
    this.sql`
      UPDATE guild_memory_backfill_jobs
      SET status = 'reflecting', updated_at_utc = ${now}
      WHERE backfill_id = ${backfillId} AND status = 'collecting'
    `;
  }

  private completeBackfill(backfillId: string) {
    const now = new Date().toISOString();
    this.sql`
      UPDATE guild_memory_backfill_jobs
      SET
        status = 'completed',
        updated_at_utc = ${now},
        completed_at_utc = ${now},
        last_error = NULL
      WHERE backfill_id = ${backfillId} AND status = 'reflecting'
    `;
    const job = this.requireBackfill(backfillId);
    logInfo("Guild memory channel backfill completed", {
      agentName: this.name,
      backfillId,
      channelId: job.channel_id,
      scannedMessageCount: job.scanned_message_count,
      collectedMessageCount: job.collected_message_count,
      reflectedMessageCount: job.reflected_message_count
    });
  }

  private cancelBackfill(backfillId: string, reason: string) {
    const now = new Date().toISOString();
    this.sql`
      DELETE FROM guild_memory_backfill_messages
      WHERE backfill_id = ${backfillId}
    `;
    this.sql`
      UPDATE guild_memory_backfill_jobs
      SET
        status = 'canceled',
        updated_at_utc = ${now},
        completed_at_utc = ${now},
        last_error = ${reason}
      WHERE
        backfill_id = ${backfillId}
        AND status IN ('collecting', 'reflecting')
    `;
  }

  private initializeStorage() {
    this.sql`
      CREATE TABLE IF NOT EXISTS guild_memory_observer_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        guild_id TEXT NOT NULL,
        generation INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS guild_memory_observer_sources (
        channel_id TEXT PRIMARY KEY,
        channel_name TEXT,
        cursor_message_id TEXT NOT NULL,
        backfill_boundary_message_id TEXT,
        enabled_at_utc TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL,
        last_polled_at_utc TEXT,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS guild_memory_observer_messages (
        message_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        channel_name TEXT,
        author_user_id TEXT NOT NULL,
        author_display_name TEXT,
        content TEXT NOT NULL,
        sent_at_utc TEXT NOT NULL,
        observed_at_utc TEXT NOT NULL,
        generation INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS guild_memory_observer_messages_generation_time
      ON guild_memory_observer_messages (
        generation,
        observed_at_utc,
        sent_at_utc
      );
      CREATE INDEX IF NOT EXISTS guild_memory_observer_messages_channel_time
      ON guild_memory_observer_messages (
        generation,
        channel_id,
        sent_at_utc,
        message_id
      );
      CREATE INDEX IF NOT EXISTS guild_memory_observer_messages_channel_age
      ON guild_memory_observer_messages (
        generation,
        channel_id,
        observed_at_utc
      );
      CREATE TABLE IF NOT EXISTS guild_memory_backfill_jobs (
        backfill_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        channel_name TEXT,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN (
            'collecting',
            'reflecting',
            'completed',
            'failed',
            'canceled'
          )
        ),
        message_limit INTEGER NOT NULL,
        scanned_message_count INTEGER NOT NULL,
        collected_message_count INTEGER NOT NULL,
        reflected_message_count INTEGER NOT NULL,
        before_message_id TEXT NOT NULL,
        oldest_scanned_message_id TEXT,
        failure_count INTEGER NOT NULL,
        step_lease_owner TEXT,
        step_lease_expires_at_utc TEXT,
        created_at_utc TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL,
        completed_at_utc TEXT,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS guild_memory_backfill_jobs_channel_created
      ON guild_memory_backfill_jobs (channel_id, created_at_utc DESC);
      CREATE INDEX IF NOT EXISTS guild_memory_backfill_jobs_status_created
      ON guild_memory_backfill_jobs (status, created_at_utc ASC);
      CREATE TABLE IF NOT EXISTS guild_memory_backfill_messages (
        backfill_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_name TEXT,
        author_user_id TEXT NOT NULL,
        author_display_name TEXT,
        content TEXT NOT NULL,
        sent_at_utc TEXT NOT NULL,
        observed_at_utc TEXT NOT NULL,
        generation INTEGER NOT NULL,
        PRIMARY KEY (backfill_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS guild_memory_backfill_messages_job_time
      ON guild_memory_backfill_messages (
        backfill_id,
        generation,
        sent_at_utc,
        message_id
      );
      CREATE TABLE IF NOT EXISTS guild_memory_reflection_lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owner TEXT NOT NULL,
        expires_at_utc TEXT NOT NULL
      );
    `;

    const sourceColumns = this.ctx.storage.sql
      .exec<{ name: string }>(
        "PRAGMA table_info(guild_memory_observer_sources)"
      )
      .toArray();
    if (
      !sourceColumns.some(
        (column) => column.name === "backfill_boundary_message_id"
      )
    ) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE guild_memory_observer_sources ADD COLUMN backfill_boundary_message_id TEXT"
      );
    }
    const sourcesWithoutBoundary = this.sql<
      Pick<
        ObserverSourceRow,
        "channel_id" | "enabled_at_utc" | "cursor_message_id"
      >
    >`
      SELECT channel_id, enabled_at_utc, cursor_message_id
      FROM guild_memory_observer_sources
      WHERE backfill_boundary_message_id IS NULL
    `;
    for (const source of sourcesWithoutBoundary) {
      const boundaryMessageId = discordSnowflakeAtEndOfTimestamp(
        source.enabled_at_utc
      );
      this.sql`
        UPDATE guild_memory_observer_sources
        SET backfill_boundary_message_id = ${boundaryMessageId}
        WHERE channel_id = ${source.channel_id}
      `;
    }
  }

  private getMetadata() {
    return this.sql<ObserverMetadataRow>`
      SELECT guild_id, generation
      FROM guild_memory_observer_metadata
      WHERE id = 1
    `[0];
  }

  private requireGuild(guildId: string) {
    const existing = this.getMetadata();
    if (!existing) {
      this.sql`
        INSERT INTO guild_memory_observer_metadata (id, guild_id, generation)
        VALUES (1, ${guildId}, 0)
      `;
      return { guild_id: guildId, generation: 0 } satisfies ObserverMetadataRow;
    }
    if (existing.guild_id !== guildId) {
      throw new Error("Guild memory observer identity does not match guild.");
    }
    return existing;
  }

  private getSource(channelId: string) {
    return this.sql<ObserverSourceRow>`
      SELECT
        channel_id,
        channel_name,
        cursor_message_id,
        backfill_boundary_message_id,
        enabled_at_utc,
        updated_at_utc,
        last_polled_at_utc,
        last_error
      FROM guild_memory_observer_sources
      WHERE channel_id = ${channelId}
    `[0];
  }

  private getBackfill(backfillId: string) {
    return this.sql<BackfillJobRow>`
      SELECT *
      FROM guild_memory_backfill_jobs
      WHERE backfill_id = ${backfillId}
    `[0];
  }

  private requireBackfill(backfillId: string) {
    const job = this.getBackfill(backfillId);
    if (!job) throw new Error(`Unknown guild memory backfill ${backfillId}.`);
    return job;
  }

  private getActiveBackfill(channelId: string) {
    return this.sql<BackfillJobRow>`
      SELECT *
      FROM guild_memory_backfill_jobs
      WHERE
        channel_id = ${channelId}
        AND status IN ('collecting', 'reflecting')
      ORDER BY created_at_utc ASC
      LIMIT 1
    `[0];
  }

  private getOldestActiveBackfill() {
    return this.sql<BackfillJobRow>`
      SELECT *
      FROM guild_memory_backfill_jobs
      WHERE status IN ('collecting', 'reflecting')
      ORDER BY created_at_utc ASC
      LIMIT 1
    `[0];
  }

  private getLatestBackfill(channelId: string) {
    return this.sql<BackfillJobRow>`
      SELECT *
      FROM guild_memory_backfill_jobs
      WHERE channel_id = ${channelId}
      ORDER BY created_at_utc DESC
      LIMIT 1
    `[0];
  }

  private getLatestCompletedBackfill(channelId: string) {
    return this.sql<BackfillJobRow>`
      SELECT *
      FROM guild_memory_backfill_jobs
      WHERE channel_id = ${channelId} AND status = 'completed'
      ORDER BY created_at_utc DESC
      LIMIT 1
    `[0];
  }

  private discardFailedBackfills(channelId: string) {
    this.sql`
      DELETE FROM guild_memory_backfill_messages
      WHERE backfill_id IN (
        SELECT backfill_id
        FROM guild_memory_backfill_jobs
        WHERE channel_id = ${channelId} AND status = 'failed'
      )
    `;
    this.sql`
      DELETE FROM guild_memory_backfill_jobs
      WHERE channel_id = ${channelId} AND status = 'failed'
    `;
  }
}

function truncateError(error: string) {
  return error.length <= 500 ? error : `${error.slice(0, 500)}…`;
}

function isActiveBackfill(status: BackfillStatus) {
  return status === "collecting" || status === "reflecting";
}

function formatBackfillStatus(job: BackfillJobRow): GuildMemoryBackfillStatus {
  return {
    backfillId: job.backfill_id,
    status: job.status,
    messageLimit: job.message_limit,
    scannedMessageCount: job.scanned_message_count,
    collectedMessageCount: job.collected_message_count,
    reflectedMessageCount: job.reflected_message_count,
    createdAtUtc: job.created_at_utc,
    updatedAtUtc: job.updated_at_utc,
    ...(job.completed_at_utc ? { completedAtUtc: job.completed_at_utc } : {}),
    ...(job.last_error ? { lastError: job.last_error } : {})
  };
}

function discordSnowflakeAtEndOfTimestamp(timestampUtc: string) {
  const discordEpochMs = 1_420_070_400_000n;
  const timestampMs = BigInt(Date.parse(timestampUtc));
  if (timestampMs < discordEpochMs) {
    throw new Error("Cannot create a Discord cursor before the Discord epoch.");
  }
  return (
    ((timestampMs - discordEpochMs) << 22n) |
    ((1n << 22n) - 1n)
  ).toString();
}

export function getGuildMemoryObserverName(guildId: string) {
  return `discord:guild:${guildId}:memory-observer`;
}

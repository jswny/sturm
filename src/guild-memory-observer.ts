import { Agent } from "agents";
import type { RESTGetAPIChannelMessagesResult } from "discord-api-types/v10";
import { getChannelMessages } from "./discord/api";
import { GuildMemoryReflectionRunner } from "./guild-memory-reflection-runner";
import type { GuildMemoryAmbientMessageEvidence } from "./guild-memory-reflection-evidence-snapshot";
import { getErrorMessage, logError, logInfo, logWarn } from "./logging";
import { GuildMemoryProvider } from "./memory";
import {
  createAmbientGuildMemoryReflectionSnapshot,
  GuildMemoryReflectionStore
} from "./memory-reflection";
import {
  CHAT_AI_GATEWAY_FLOWS,
  createChatModel,
  MEMORY_REFLECTION_PROVIDER_OPTIONS
} from "./model";
import { searchGuildMembers } from "./nickname";

const OBSERVER_POLL_INTERVAL_SECONDS = 10 * 60;
const OBSERVER_REFLECTION_MESSAGE_THRESHOLD = 30;
const OBSERVER_REFLECTION_MAX_WAIT_MS = 60 * 60 * 1_000;
const OBSERVER_REFLECTION_MAX_MESSAGES = 50;
const OBSERVER_REFLECTION_MAX_CONTENT_CHARS = 24_000;
const OBSERVER_MAX_MESSAGE_CHARS = 2_000;
const OBSERVER_MAX_POLL_PAGES = 10;
const OBSERVER_REFLECTION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

type ObserverMetadataRow = {
  guild_id: string;
  generation: number;
};

type ObserverSourceRow = {
  channel_id: string;
  channel_name: string | null;
  cursor_message_id: string;
  enabled_at_utc: string;
  updated_at_utc: string;
  last_polled_at_utc: string | null;
  last_error: string | null;
};

type ObserverPendingMessageRow = {
  message_id: string;
  channel_id: string;
  channel_name: string | null;
  author_user_id: string;
  author_display_name: string | null;
  content: string;
  sent_at_utc: string;
  observed_at_utc: string;
  generation: number;
};

type PendingSummaryRow = {
  pending_count: number;
  oldest_observed_at_utc: string | null;
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
};

export class GuildMemoryObserverAgent extends Agent<Env> {
  private memoryReflections = new GuildMemoryReflectionStore(this.ctx.storage);

  override async onStart(props?: Record<string, unknown>) {
    await super.onStart(props);
    this.initializeStorage();
    try {
      await this.scheduleEvery(
        OBSERVER_POLL_INTERVAL_SECONDS,
        "pollMemorySources"
      );
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
        enabled_at_utc,
        updated_at_utc,
        last_polled_at_utc,
        last_error
      ) VALUES (
        ${input.channelId},
        ${input.channelName ?? null},
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
    this.sql`
      DELETE FROM guild_memory_observer_sources
      WHERE channel_id = ${input.channelId}
    `;
    this.sql`
      UPDATE guild_memory_observer_messages
      SET generation = ${metadata.generation + 1}
      WHERE generation = ${metadata.generation}
    `;
    this.sql`
      UPDATE guild_memory_observer_metadata
      SET generation = ${metadata.generation + 1}
      WHERE id = 1
    `;
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
    return this.sql<ObserverSourceRow & { pending_count: number }>`
      SELECT
        source.channel_id,
        source.channel_name,
        source.cursor_message_id,
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
    `.map((source) => ({
      channelId: source.channel_id,
      ...(source.channel_name ? { channelName: source.channel_name } : {}),
      cursorMessageId: source.cursor_message_id,
      enabledAtUtc: source.enabled_at_utc,
      updatedAtUtc: source.updated_at_utc,
      ...(source.last_polled_at_utc
        ? { lastPolledAtUtc: source.last_polled_at_utc }
        : {}),
      ...(source.last_error ? { lastError: source.last_error } : {}),
      pendingMessageCount: source.pending_count
    }));
  }

  async resetObservationBoundary(input: {
    guildId: string;
    boundarySnowflake: string;
  }) {
    const metadata = this.requireGuild(input.guildId);
    const now = new Date().toISOString();
    this.sql`DELETE FROM guild_memory_observer_messages`;
    this.sql`
      UPDATE guild_memory_observer_sources
      SET
        cursor_message_id = ${input.boundarySnowflake},
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

    await this.reflectPendingMessages(metadata.guild_id);
    await this.memoryReflections.pruneTerminalRecords(
      OBSERVER_REFLECTION_RETENTION_MS
    );
  }

  private async pollSource(guildId: string, source: ObserverSourceRow) {
    try {
      const fetched = await this.readMessagesSinceCursor(
        source.channel_id,
        source.cursor_message_id
      );
      const currentSource = this.getSource(source.channel_id);
      const currentMetadata = this.getMetadata();
      if (!currentSource || !currentMetadata) return;

      const freshMessages = fetched
        .filter(
          (message) =>
            compareSnowflakes(message.id, currentSource.cursor_message_id) > 0
        )
        .sort((left, right) => compareSnowflakes(left.id, right.id));
      const observedAtUtc = new Date().toISOString();
      for (const message of freshMessages) {
        const evidence = createAmbientMessageEvidence(message, currentSource);
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

  private async readMessagesSinceCursor(
    channelId: string,
    cursorMessageId: string
  ) {
    const firstPage = await getChannelMessages(this.env, channelId, {
      limit: 100,
      afterMessageId: cursorMessageId
    });
    if (firstPage.length < 100) return firstPage;

    const messages = new Map(firstPage.map((message) => [message.id, message]));
    let oldestMessageId = getOldestMessageId(firstPage);
    for (let page = 1; page < OBSERVER_MAX_POLL_PAGES; page++) {
      const nextPage = await getChannelMessages(this.env, channelId, {
        limit: 100,
        beforeMessageId: oldestMessageId
      });
      for (const message of nextPage) {
        if (compareSnowflakes(message.id, cursorMessageId) > 0) {
          messages.set(message.id, message);
        }
      }

      if (
        nextPage.length < 100 ||
        nextPage.some(
          (message) => compareSnowflakes(message.id, cursorMessageId) <= 0
        )
      ) {
        return [...messages.values()];
      }
      oldestMessageId = getOldestMessageId(nextPage);
    }

    throw new Error(
      `Channel backlog exceeded ${OBSERVER_MAX_POLL_PAGES * 100} messages; cursor was not advanced.`
    );
  }

  private async reflectPendingMessages(guildId: string) {
    const metadata = this.requireGuild(guildId);
    const summary = this.sql<PendingSummaryRow>`
      SELECT
        COUNT(*) AS pending_count,
        MIN(observed_at_utc) AS oldest_observed_at_utc
      FROM guild_memory_observer_messages
      WHERE generation = ${metadata.generation}
    `[0];
    if (!summary || summary.pending_count === 0) return;

    const oldestObservedAtMs = summary.oldest_observed_at_utc
      ? Date.parse(summary.oldest_observed_at_utc)
      : Date.now();
    const readyByCount =
      summary.pending_count >= OBSERVER_REFLECTION_MESSAGE_THRESHOLD;
    const readyByAge =
      Date.now() - oldestObservedAtMs >= OBSERVER_REFLECTION_MAX_WAIT_MS;
    if (!readyByCount && !readyByAge) return;

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
      WHERE generation = ${metadata.generation}
      ORDER BY sent_at_utc ASC, message_id ASC
      LIMIT ${OBSERVER_REFLECTION_MAX_MESSAGES}
    `;
    const evidence = selectReflectionEvidence(rows);
    if (evidence.length === 0) return;

    const correlationId = createAmbientCorrelationId(guildId, evidence);
    const snapshot = createAmbientGuildMemoryReflectionSnapshot(
      correlationId,
      guildId,
      evidence
    );
    const runner = new GuildMemoryReflectionRunner({
      store: this.memoryReflections,
      getProvider: () =>
        new GuildMemoryProvider(this.env.GuildMemory, () => guildId),
      createModel: () =>
        createChatModel(
          this.env,
          CHAT_AI_GATEWAY_FLOWS.memoryReflection,
          { correlationId, guildId },
          this.name
        ),
      searchGuildMembers: (_snapshot, query) =>
        searchGuildMembers(this.env, { guildId }, query),
      assertCanCommit: () => {
        const current = this.requireGuild(guildId);
        if (current.generation !== metadata.generation) {
          throw new Error(
            "Guild memory observation boundary changed while reflection was running."
          );
        }
      },
      providerOptions: MEMORY_REFLECTION_PROVIDER_OPTIONS
    });

    try {
      const reflection = await runner.run(snapshot);
      const current = this.requireGuild(guildId);
      if (current.generation !== metadata.generation) return;
      for (const message of evidence) {
        this.sql`
          DELETE FROM guild_memory_observer_messages
          WHERE
            message_id = ${message.messageId}
            AND generation = ${metadata.generation}
        `;
      }
      logInfo("Guild memory observer reflected ambient messages", {
        agentName: this.name,
        guildId,
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
        correlationId,
        messageCount: evidence.length,
        error: getErrorMessage(error)
      });
    }
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
    `;
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
        enabled_at_utc,
        updated_at_utc,
        last_polled_at_utc,
        last_error
      FROM guild_memory_observer_sources
      WHERE channel_id = ${channelId}
    `[0];
  }
}

function createAmbientMessageEvidence(
  message: RESTGetAPIChannelMessagesResult[number],
  source: ObserverSourceRow
): GuildMemoryAmbientMessageEvidence | null {
  const content = message.content.trim();
  if (!content || message.author.bot || message.webhook_id) return null;
  const authorDisplayName =
    message.author.global_name?.trim() || message.author.username.trim();
  return {
    messageId: message.id,
    channelId: source.channel_id,
    ...(source.channel_name ? { channelName: source.channel_name } : {}),
    authorUserId: message.author.id,
    ...(authorDisplayName ? { authorDisplayName } : {}),
    content,
    sentAtUtc: new Date(message.timestamp).toISOString()
  };
}

function selectReflectionEvidence(rows: ObserverPendingMessageRow[]) {
  const evidence: GuildMemoryAmbientMessageEvidence[] = [];
  let contentChars = 0;
  for (const row of rows) {
    const content = truncateContent(row.content, OBSERVER_MAX_MESSAGE_CHARS);
    if (
      evidence.length > 0 &&
      contentChars + content.length > OBSERVER_REFLECTION_MAX_CONTENT_CHARS
    ) {
      break;
    }
    evidence.push({
      messageId: row.message_id,
      channelId: row.channel_id,
      ...(row.channel_name ? { channelName: row.channel_name } : {}),
      authorUserId: row.author_user_id,
      ...(row.author_display_name
        ? { authorDisplayName: row.author_display_name }
        : {}),
      content,
      sentAtUtc: row.sent_at_utc
    });
    contentChars += content.length;
  }
  return evidence;
}

function createAmbientCorrelationId(
  guildId: string,
  messages: GuildMemoryAmbientMessageEvidence[]
) {
  const first = messages[0];
  const last = messages.at(-1);
  if (!first || !last) {
    throw new Error("Ambient memory reflection requires at least one message.");
  }
  return `ambient:${guildId}:${first.messageId}:${last.messageId}:${messages.length}`;
}

function getOldestMessageId(messages: RESTGetAPIChannelMessagesResult) {
  const oldest = messages.reduce((current, message) =>
    compareSnowflakes(message.id, current.id) < 0 ? message : current
  );
  return oldest.id;
}

function compareSnowflakes(left: string, right: string) {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function truncateContent(content: string, maxLength: number) {
  const trimmed = content.trim();
  return trimmed.length <= maxLength
    ? trimmed
    : `${trimmed.slice(0, maxLength)}\n[truncated]`;
}

function truncateError(error: string) {
  return error.length <= 500 ? error : `${error.slice(0, 500)}…`;
}

export function getGuildMemoryObserverName(guildId: string) {
  return `discord:guild:${guildId}:memory-observer`;
}

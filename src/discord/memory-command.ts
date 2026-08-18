import {
  ApplicationCommandOptionType,
  PermissionFlagsBits,
  type APIEmbed,
  type APIChatInputApplicationCommandInteraction
} from "discord-api-types/v10";
import { getAgentByName } from "agents";
import {
  editOriginalInteractionResponse,
  editOriginalInteractionResponseWithEmbeds
} from "./api";
import { hasDiscordPermission } from "./permissions";
import type {
  DiscordResponseAttachment,
  DiscordWebhookResponseTarget
} from "./types";
import {
  deleteGuildMemoryRecord,
  listGuildMemory,
  resetGuildMemory,
  type GuildMemoryCatalog,
  type GuildMemoryDeleteResult,
  type GuildMemoryRecord,
  type GuildMemoryResetResult
} from "../memory";
import {
  getGuildMemoryObserverName,
  MEMORY_BACKFILL_DEFAULT_MESSAGE_LIMIT,
  type StartGuildMemoryBackfillResult,
  type GuildMemorySourceMutationResult,
  type GuildMemorySourceStatus
} from "../guild-memory-observer";

type MemoryCommandEnv = Env;

export async function runMemoryCommand(
  interaction: APIChatInputApplicationCommandInteraction,
  env: MemoryCommandEnv,
  guildId: string,
  currentChannelId: string
) {
  const responseTarget = getResponseTarget(interaction);

  if (
    !hasDiscordPermission(
      interaction.member?.permissions,
      PermissionFlagsBits.ManageGuild
    )
  ) {
    await editOriginalInteractionResponse(
      responseTarget,
      "You need Manage Server permission to use /memory."
    );
    return;
  }

  const subcommand = getSubcommandName(interaction);
  const subcommandGroup = getSubcommandGroupName(interaction);

  if (subcommandGroup === "source") {
    const sourceCommand = getNestedSubcommandName(interaction);
    const observer = await getGuildMemoryObserver(env, guildId);
    if (sourceCommand === "view") {
      const sources = await observer.listSources(guildId);
      await deliverMemorySourceView(responseTarget, sources);
      return;
    }

    if (sourceCommand === "enable" || sourceCommand === "disable") {
      const channel = getSourceChannelOption(interaction, currentChannelId);
      const input = {
        guildId,
        channelId: channel.id,
        ...(channel.name ? { channelName: channel.name } : {}),
        boundarySnowflake: interaction.id
      };
      const result =
        sourceCommand === "enable"
          ? await observer.enableSource(input)
          : await observer.disableSource(input);
      await editOriginalInteractionResponse(
        responseTarget,
        formatMemorySourceMutationResult(result)
      );
      return;
    }

    if (sourceCommand === "backfill") {
      const channel = getSourceChannelOption(interaction, currentChannelId);
      const messageLimit =
        getNestedIntegerOption(interaction, "messages") ??
        MEMORY_BACKFILL_DEFAULT_MESSAGE_LIMIT;
      const result = await observer.startBackfill({
        guildId,
        channelId: channel.id,
        ...(channel.name ? { channelName: channel.name } : {}),
        messageLimit
      });
      await editOriginalInteractionResponse(
        responseTarget,
        formatMemoryBackfillResult(result)
      );
      return;
    }

    await editOriginalInteractionResponse(
      responseTarget,
      "Unknown memory source subcommand."
    );
    return;
  }

  if (subcommand === "view") {
    const result = await listGuildMemory(env.GuildMemory, guildId);
    await deliverMemoryCommandResult(responseTarget, formatMemoryView(result));
    return;
  }

  if (subcommand === "delete") {
    const memoryId = getStringSubcommandOption(interaction, "id");
    if (!memoryId) {
      await editOriginalInteractionResponse(
        responseTarget,
        "Missing memory ID."
      );
      return;
    }

    const result = await deleteGuildMemoryRecord(
      env.GuildMemory,
      guildId,
      memoryId
    );
    await deliverMemoryCommandResult(
      responseTarget,
      formatMemoryDeleteResult(result)
    );
    return;
  }

  if (subcommand === "reset") {
    const observer = await getGuildMemoryObserver(env, guildId);
    await observer.resetObservationBoundary({
      guildId,
      boundarySnowflake: interaction.id
    });
    const result = await resetGuildMemory(env.GuildMemory, guildId);
    await editOriginalInteractionResponse(
      responseTarget,
      formatMemoryResetResult(result)
    );
    return;
  }

  await editOriginalInteractionResponse(
    responseTarget,
    "Unknown memory subcommand."
  );
}

function getSubcommandName(
  interaction: APIChatInputApplicationCommandInteraction
) {
  return getSubcommandOption(interaction)?.name ?? "";
}

function getSubcommandGroupName(
  interaction: APIChatInputApplicationCommandInteraction
) {
  const option = interaction.data.options?.[0];
  return option?.type === ApplicationCommandOptionType.SubcommandGroup
    ? option.name
    : "";
}

function getNestedSubcommandName(
  interaction: APIChatInputApplicationCommandInteraction
) {
  return getNestedSubcommandOption(interaction)?.name ?? "";
}

function getStringSubcommandOption(
  interaction: APIChatInputApplicationCommandInteraction,
  name: string
) {
  const option = getSubcommandOption(interaction)?.options?.find(
    (item) => item.name === name
  );
  if (option?.type !== ApplicationCommandOptionType.String) return undefined;
  return option.value;
}

function getSubcommandOption(
  interaction: APIChatInputApplicationCommandInteraction
) {
  const option = interaction.data.options?.[0];
  if (option?.type !== ApplicationCommandOptionType.Subcommand) {
    return undefined;
  }

  return option;
}

function getNestedSubcommandOption(
  interaction: APIChatInputApplicationCommandInteraction
) {
  const group = interaction.data.options?.[0];
  if (group?.type !== ApplicationCommandOptionType.SubcommandGroup) {
    return undefined;
  }
  const option = group.options?.[0];
  return option?.type === ApplicationCommandOptionType.Subcommand
    ? option
    : undefined;
}

function getSourceChannelOption(
  interaction: APIChatInputApplicationCommandInteraction,
  currentChannelId: string
) {
  const option = getNestedSubcommandOption(interaction)?.options?.find(
    (item) => item.name === "channel"
  );
  if (option?.type !== ApplicationCommandOptionType.Channel) {
    return {
      id: currentChannelId,
      ...(interaction.channel?.name ? { name: interaction.channel.name } : {})
    };
  }
  const id = String(option.value);
  const resolved = interaction.data.resolved?.channels?.[id];
  return {
    id,
    ...(resolved?.name ? { name: resolved.name } : {})
  };
}

function getNestedIntegerOption(
  interaction: APIChatInputApplicationCommandInteraction,
  name: string
) {
  const option = getNestedSubcommandOption(interaction)?.options?.find(
    (item) => item.name === name
  );
  if (option?.type !== ApplicationCommandOptionType.Integer) return undefined;
  return option.value;
}

async function getGuildMemoryObserver(env: Env, guildId: string) {
  return getAgentByName(
    env.GuildMemoryObserver,
    getGuildMemoryObserverName(guildId)
  );
}

function getResponseTarget(
  interaction: APIChatInputApplicationCommandInteraction
): DiscordWebhookResponseTarget {
  return {
    type: "discord",
    applicationId: interaction.application_id,
    token: interaction.token
  };
}

async function deliverMemoryCommandResult(
  target: DiscordWebhookResponseTarget,
  content: string
) {
  if (content.length <= 1900) {
    await editOriginalInteractionResponse(target, content);
    return;
  }

  await editOriginalInteractionResponse(
    target,
    createMemoryAttachmentSummary(),
    [
      {
        filename: "guild-memory.txt",
        mimeType: "text/plain;charset=utf-8",
        base64: utf8ToBase64(content),
        description: "Guild memory entries"
      } satisfies DiscordResponseAttachment
    ]
  );
}

async function deliverMemorySourceView(
  target: DiscordWebhookResponseTarget,
  sources: GuildMemorySourceStatus[]
) {
  const embed = formatMemorySourceViewEmbed(sources);
  if ((embed.fields?.length ?? 0) <= 25 && getEmbedTextLength(embed) <= 6000) {
    await editOriginalInteractionResponseWithEmbeds(target, [embed]);
    return;
  }

  await editOriginalInteractionResponse(
    target,
    "There are too many memory sources to fit in one embed. The full source status is attached.",
    [
      {
        filename: "memory-sources.txt",
        mimeType: "text/plain;charset=utf-8",
        base64: utf8ToBase64(formatMemorySourceViewText(sources)),
        description: "Ambient memory source status"
      } satisfies DiscordResponseAttachment
    ]
  );
}

function formatMemoryView(result: GuildMemoryCatalog) {
  const lines = [
    `Guild memory: ${result.records.length} records`,
    `revision: ${result.revision}`,
    `updated_at_utc: ${result.updatedAt ?? "never"}`
  ];

  if (result.records.length === 0) {
    lines.push("", "No guild memory records.");
    return lines.join("\n");
  }

  lines.push(
    "",
    ...result.records.map((record, index) => formatMemoryRecord(record, index))
  );
  return lines.join("\n");
}

function formatMemoryDeleteResult(result: GuildMemoryDeleteResult) {
  if (!result.deleted) {
    return [
      `No guild memory record exists with ID ${result.requestedMemoryId}.`,
      `current_records: ${result.records.length}`,
      "Run /memory view to see current IDs."
    ].join("\n");
  }

  return [
    `Deleted guild memory record ${result.deleted.memoryId}.`,
    `revision: ${result.revision}`,
    `remaining_records: ${result.records.length}`,
    "",
    "Deleted record:",
    formatMemoryRecord(result.deleted)
  ].join("\n");
}

function formatMemoryResetResult(result: GuildMemoryResetResult) {
  if (!result.changed) {
    return [
      "Guild memory was already empty.",
      `revision: ${result.revision}`,
      "deleted_entries: 0",
      "Pending ambient observations were cleared; enabled sources will resume from this reset boundary."
    ].join("\n");
  }

  return [
    "Guild memory reset.",
    `revision: ${result.previousRevision} -> ${result.revision}`,
    `deleted_entries: ${result.deletedCount}`,
    "Pending ambient observations were cleared; enabled sources will resume from this reset boundary."
  ].join("\n");
}

function formatMemorySourceMutationResult(
  result: GuildMemorySourceMutationResult
) {
  const channel = `<#${result.channelId}>`;
  switch (result.status) {
    case "enabled":
      return `${channel} is now an ambient memory source. Sturm will observe only new human messages.`;
    case "already_enabled":
      return `${channel} is already an ambient memory source.`;
    case "disabled":
      return `${channel} is no longer an ambient memory source. Its pending observations were discarded.`;
    case "not_enabled":
      return `${channel} was not an ambient memory source.`;
  }
}

function formatMemorySourceViewEmbed(
  sources: GuildMemorySourceStatus[]
): APIEmbed {
  if (sources.length === 0) {
    return {
      title: "Memory sources",
      description: "No ambient memory source channels are enabled.",
      color: 0x5865f2
    };
  }

  return {
    title: "Memory sources",
    description: `${formatCount(sources.length)} ${sources.length === 1 ? "channel is" : "channels are"} feeding guild memory.`,
    color: sources.some(
      (source) => source.lastError || source.latestBackfill?.lastError
    )
      ? 0xfee75c
      : 0x5865f2,
    fields: sources.map((source) => ({
      name: `<#${source.channelId}>`,
      value: formatMemorySourceField(source)
    })),
    footer: {
      text: "Latest backfill shown for each channel"
    }
  };
}

function formatMemorySourceViewText(sources: GuildMemorySourceStatus[]) {
  return [
    `Memory sources: ${sources.length}`,
    "",
    ...sources.flatMap((source) => {
      const lines = [
        `<#${source.channelId}>`,
        `  pending: ${source.pendingMessageCount}`,
        `  last poll: ${source.lastPolledAtUtc ?? "never"}`
      ];
      if (source.lastError) lines.push(`  observer error: ${source.lastError}`);
      if (source.latestBackfill) {
        const backfill = source.latestBackfill;
        lines.push(
          `  backfill: ${backfill.status}`,
          `  scanned: ${backfill.scannedMessageCount} / ${backfill.messageLimit}`,
          `  eligible: ${backfill.collectedMessageCount}`,
          `  reflected: ${backfill.reflectedMessageCount}`
        );
        if (backfill.lastError) {
          lines.push(`  backfill error: ${backfill.lastError}`);
        }
      }
      return lines;
    })
  ].join("\n");
}

function getEmbedTextLength(embed: APIEmbed) {
  return (
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.footer?.text.length ?? 0) +
    (embed.author?.name.length ?? 0) +
    (embed.fields?.reduce(
      (total, field) => total + field.name.length + field.value.length,
      0
    ) ?? 0)
  );
}

function formatMemorySourceField(source: GuildMemorySourceStatus) {
  const lines = [
    `**Live collection** · Pending **${formatCount(source.pendingMessageCount)}** · Last poll ${formatDiscordRelativeTimestamp(source.lastPolledAtUtc)}`
  ];

  if (source.lastError) {
    lines.push(`⚠️ ${truncateEmbedFieldLine(source.lastError)}`);
  }

  const backfill = source.latestBackfill;
  if (backfill) {
    lines.push(
      `**Backfill** · ${formatBackfillStatus(backfill.status)} · Scanned **${formatCount(backfill.scannedMessageCount)} / ${formatCount(backfill.messageLimit)}**`,
      `Eligible **${formatCount(backfill.collectedMessageCount)}** · Reflected **${formatCount(backfill.reflectedMessageCount)}**`
    );
    if (backfill.lastError) {
      lines.push(`⚠️ ${truncateEmbedFieldLine(backfill.lastError)}`);
    }
  }

  return lines.join("\n");
}

function formatBackfillStatus(status: string) {
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  switch (status) {
    case "completed":
      return `✅ ${label}`;
    case "failed":
      return `❌ ${label}`;
    case "canceled":
      return `⏹️ ${label}`;
    default:
      return `⏳ ${label}`;
  }
}

function formatDiscordRelativeTimestamp(timestamp: string | undefined) {
  if (!timestamp) return "never";
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) return "unknown";
  return `<t:${Math.floor(milliseconds / 1000)}:R>`;
}

function formatCount(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function truncateEmbedFieldLine(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}…`;
}

function formatMemoryBackfillResult(result: StartGuildMemoryBackfillResult) {
  const channel = `<#${result.channelId}>`;
  if (result.status === "source_not_enabled") {
    return `${channel} is not an ambient memory source. Enable it first with /memory source enable.`;
  }
  const backfill = result.backfill;
  if (!backfill) {
    return `${channel} backfill status is unavailable.`;
  }
  if (result.status === "already_running") {
    return [
      `${channel} already has a memory backfill in progress.`,
      `status: ${backfill.status}`,
      `scanned_messages: ${backfill.scannedMessageCount}/${backfill.messageLimit}`,
      `eligible_messages: ${backfill.collectedMessageCount}`,
      `reflected_messages: ${backfill.reflectedMessageCount}`
    ].join("\n");
  }
  return [
    `Started a memory backfill for ${channel}.`,
    `message_cap: ${backfill.messageLimit}`,
    "Collection pages backward, then reflects the captured messages oldest-to-newest.",
    "Run /memory source view to check progress."
  ].join("\n");
}

function formatMemoryRecord(record: GuildMemoryRecord, index?: number) {
  const prefix = index === undefined ? "" : `${index + 1}. `;
  const subjects =
    record.subjectUserIds.length > 0
      ? ` subjects=${record.subjectUserIds.join(",")}`
      : "";
  const assertedBy = record.assertedByUserId
    ? ` assertedBy=${record.assertedByUserId}`
    : "";
  return `${prefix}[${record.memoryId}] [${record.kind} source=${record.source}${subjects}${assertedBy}] ${record.content}`;
}

function createMemoryAttachmentSummary() {
  return "Guild memory is too long for one Discord message. Attached the full record view as guild-memory.txt.";
}

function utf8ToBase64(content: string) {
  const bytes = new TextEncoder().encode(content);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

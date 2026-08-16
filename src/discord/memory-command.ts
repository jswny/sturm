import {
  ApplicationCommandOptionType,
  PermissionFlagsBits,
  type APIChatInputApplicationCommandInteraction
} from "discord-api-types/v10";
import { getAgentByName } from "agents";
import { editOriginalInteractionResponse } from "./api";
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
      await deliverMemoryCommandResult(
        responseTarget,
        formatMemorySourceView(sources)
      );
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

function formatMemorySourceView(sources: GuildMemorySourceStatus[]) {
  if (sources.length === 0) {
    return "No ambient memory source channels are enabled.";
  }
  return [
    `Ambient memory sources: ${sources.length}`,
    "",
    ...sources.map((source) => {
      const status = source.lastError
        ? `error=${source.lastError}`
        : `last_polled_at_utc=${source.lastPolledAtUtc ?? "never"}`;
      return [
        `<#${source.channelId}>`,
        `pending_messages=${source.pendingMessageCount}`,
        status
      ].join(" | ");
    })
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
  return `${prefix}[${record.memoryId}] [${record.kind}${subjects}${assertedBy}] ${record.content}`;
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

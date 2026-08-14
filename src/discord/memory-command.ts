import {
  ApplicationCommandOptionType,
  PermissionFlagsBits,
  type APIChatInputApplicationCommandInteraction
} from "discord-api-types/v10";
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

type MemoryCommandEnv = Env;

export async function runMemoryCommand(
  interaction: APIChatInputApplicationCommandInteraction,
  env: MemoryCommandEnv,
  guildId: string
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

  if (subcommand === "view") {
    const result = await listGuildMemory(env.GuildMemory, guildId);
    await deliverMemoryCommandResult(responseTarget, formatMemoryView(result));
    return;
  }

  if (subcommand === "delete") {
    let memoryId = getStringSubcommandOption(interaction, "id");
    const legacyIndex = getIntegerSubcommandOption(interaction, "index");
    if (!memoryId && legacyIndex !== undefined) {
      const catalog = await listGuildMemory(env.GuildMemory, guildId);
      memoryId = catalog.records[legacyIndex - 1]?.memoryId;
      if (!memoryId) {
        await editOriginalInteractionResponse(
          responseTarget,
          `No guild memory record exists at legacy index ${legacyIndex}. Run /memory view to see current records.`
        );
        return;
      }
    }
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

function getIntegerSubcommandOption(
  interaction: APIChatInputApplicationCommandInteraction,
  name: string
) {
  const option = getSubcommandOption(interaction)?.options?.find(
    (item) => item.name === name
  );
  if (option?.type !== ApplicationCommandOptionType.Integer) return undefined;
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
      "deleted_entries: 0"
    ].join("\n");
  }

  return [
    "Guild memory reset.",
    `revision: ${result.previousRevision} -> ${result.revision}`,
    `deleted_entries: ${result.deletedCount}`
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

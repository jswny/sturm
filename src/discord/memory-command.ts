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
  deleteGuildMemoryEntry,
  listGuildMemory,
  resetGuildMemory,
  type GuildMemoryDeleteResult,
  type GuildMemoryEntry,
  type GuildMemoryList,
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
    const index = getIntegerSubcommandOption(interaction, "index");
    if (index === undefined) {
      await editOriginalInteractionResponse(
        responseTarget,
        "Missing memory entry index."
      );
      return;
    }

    const result = await deleteGuildMemoryEntry(
      env.GuildMemory,
      guildId,
      index
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

function formatMemoryView(result: GuildMemoryList) {
  const lines = [
    `Guild memory: ${result.entries.length} entries`,
    `version: ${result.version}`,
    `updated_at_utc: ${result.updatedAt ?? "never"}`
  ];

  if (result.entries.length === 0) {
    lines.push("", "No guild memory entries.");
    return lines.join("\n");
  }

  lines.push("", ...result.entries.map(formatMemoryEntry));
  return lines.join("\n");
}

function formatMemoryDeleteResult(result: GuildMemoryDeleteResult) {
  if (!result.deleted) {
    return [
      `No guild memory entry exists at index ${result.requestedIndex}.`,
      `current_entries: ${result.entries.length}`,
      "Run /memory view to see current indexes."
    ].join("\n");
  }

  return [
    `Deleted guild memory entry ${result.deleted.index}.`,
    `version: ${result.version}`,
    `remaining_entries: ${result.entries.length}`,
    "",
    "Deleted entry:",
    formatMemoryEntry(result.deleted)
  ].join("\n");
}

function formatMemoryResetResult(result: GuildMemoryResetResult) {
  if (!result.changed) {
    return [
      "Guild memory was already empty.",
      `version: ${result.version}`,
      "deleted_entries: 0"
    ].join("\n");
  }

  return [
    "Guild memory reset.",
    `version: ${result.previousVersion} -> ${result.version}`,
    `deleted_entries: ${result.deletedCount}`
  ].join("\n");
}

function formatMemoryEntry(entry: GuildMemoryEntry) {
  return `${entry.index}. ${entry.content}`;
}

function createMemoryAttachmentSummary() {
  return "Guild memory is too long for one Discord message. Attached the full view as guild-memory.txt.";
}

function utf8ToBase64(content: string) {
  const bytes = new TextEncoder().encode(content);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

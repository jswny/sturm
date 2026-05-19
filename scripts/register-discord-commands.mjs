import { existsSync, readFileSync } from "node:fs";
import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType
} from "discord-api-types/v10";

loadDevVars();

const token = process.env.DISCORD_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
const guildId = process.env.DISCORD_TEST_GUILD_ID;
const scope = getRegistrationScope();

if (!token) {
  throw new Error("DISCORD_TOKEN is required.");
}

if (!applicationId) {
  throw new Error("DISCORD_APPLICATION_ID is required.");
}

const commands = [
  {
    name: "c",
    description: "Chat with Sturm",
    type: ApplicationCommandType.ChatInput,
    options: [
      {
        name: "text",
        description: "Text to send to Sturm",
        type: ApplicationCommandOptionType.String,
        required: true
      }
    ]
  },
  {
    name: "reset",
    description: "Reset context for this channel or DM",
    type: ApplicationCommandType.ChatInput,
    // Manage Messages. DMs are still allowed through command contexts.
    default_member_permissions: "8192"
  }
];

const registeredCommands =
  scope === "global"
    ? commands.map((command) => ({
        ...command,
        integration_types: [ApplicationIntegrationType.GuildInstall],
        contexts: [InteractionContextType.Guild, InteractionContextType.BotDM]
      }))
    : commands;

const url =
  scope === "guild"
    ? `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${applicationId}/commands`;

const response = await fetch(url, {
  method: "PUT",
  headers: {
    authorization: `Bot ${token}`,
    "content-type": "application/json"
  },
  body: JSON.stringify(registeredCommands)
});

const body = await response.text();
if (!response.ok) {
  throw new Error(`Command registration failed: ${response.status} ${body}`);
}

console.log(
  scope === "guild"
    ? `Registered /c in test guild ${guildId}.`
    : "Registered /c globally with guild and bot DM contexts."
);

function getRegistrationScope() {
  if (process.argv.includes("--global")) return "global";

  if (process.argv.includes("--guild")) {
    if (!guildId) {
      throw new Error("DISCORD_TEST_GUILD_ID is required for --guild.");
    }
    return "guild";
  }

  if (process.env.DISCORD_COMMAND_SCOPE) {
    const commandScope = process.env.DISCORD_COMMAND_SCOPE.toLowerCase();
    if (commandScope !== "guild" && commandScope !== "global") {
      throw new Error("DISCORD_COMMAND_SCOPE must be either guild or global.");
    }
    if (commandScope === "guild" && !guildId) {
      throw new Error("DISCORD_TEST_GUILD_ID is required for guild scope.");
    }
    return commandScope;
  }

  return "global";
}

function loadDevVars() {
  if (!existsSync(".dev.vars")) return;

  const lines = readFileSync(".dev.vars", "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

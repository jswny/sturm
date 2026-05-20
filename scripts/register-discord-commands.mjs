import { existsSync, readFileSync } from "node:fs";
import {
  ApplicationCommandOptionType,
  ApplicationCommandType
} from "discord-api-types/v10";

loadDevVars();

const token = process.env.DISCORD_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
const guildId = getGuildId();

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

const url = `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`;

const response = await fetch(url, {
  method: "PUT",
  headers: {
    authorization: `Bot ${token}`,
    "content-type": "application/json"
  },
  body: JSON.stringify(commands)
});

const body = await response.text();
if (!response.ok) {
  throw new Error(`Command registration failed: ${response.status} ${body}`);
}

console.log(`Registered /c and /reset in guild ${guildId}.`);

function getGuildId() {
  const args = process.argv.slice(2);
  const guildFlagIndex = args.indexOf("--guild");
  if (guildFlagIndex !== -1) {
    const guildId = args[guildFlagIndex + 1];
    if (guildId) return guildId;
  }

  const positionalGuildId = args.find((arg) => !arg.startsWith("-"));
  if (positionalGuildId) return positionalGuildId;

  throw new Error("Usage: npm run discord:register -- <guild-id>");
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

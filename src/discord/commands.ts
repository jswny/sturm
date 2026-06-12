import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  PermissionFlagsBits,
  type RESTPutAPIApplicationGuildCommandsJSONBody
} from "discord-api-types/v10";

export const C_COMMAND = {
  name: "c",
  description: "Chat with Sturm",
  type: ApplicationCommandType.ChatInput,
  options: [
    {
      name: "text",
      description: "Text to send to Sturm",
      type: ApplicationCommandOptionType.String,
      required: true
    },
    {
      name: "image",
      description: "Optional image attachment for Sturm",
      type: ApplicationCommandOptionType.Attachment,
      required: false
    }
  ]
} as const satisfies RESTPutAPIApplicationGuildCommandsJSONBody[number];

export const RESET_COMMAND = {
  name: "reset",
  description: "Reset context for this channel",
  type: ApplicationCommandType.ChatInput,
  default_member_permissions: "8192"
} as const satisfies RESTPutAPIApplicationGuildCommandsJSONBody[number];

export const MEMORY_COMMAND = {
  name: "memory",
  description: "Manage guild memory",
  type: ApplicationCommandType.ChatInput,
  default_member_permissions: String(PermissionFlagsBits.ManageGuild),
  options: [
    {
      name: "view",
      description: "View guild memory entries",
      type: ApplicationCommandOptionType.Subcommand
    },
    {
      name: "delete",
      description: "Delete a guild memory entry by index",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "index",
          description: "One-based memory entry index to delete",
          type: ApplicationCommandOptionType.Integer,
          min_value: 1,
          required: true
        }
      ]
    },
    {
      name: "reset",
      description: "Reset guild memory",
      type: ApplicationCommandOptionType.Subcommand
    }
  ]
} as const satisfies RESTPutAPIApplicationGuildCommandsJSONBody[number];

export const GUILD_COMMANDS = [
  C_COMMAND,
  RESET_COMMAND,
  MEMORY_COMMAND
] as const satisfies RESTPutAPIApplicationGuildCommandsJSONBody;

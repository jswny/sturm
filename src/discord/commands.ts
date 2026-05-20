import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
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
    }
  ]
} as const satisfies RESTPutAPIApplicationGuildCommandsJSONBody[number];

export const RESET_COMMAND = {
  name: "reset",
  description: "Reset context for this channel or DM",
  type: ApplicationCommandType.ChatInput,
  // Manage Messages. DMs are still allowed through command contexts.
  default_member_permissions: "8192"
} as const satisfies RESTPutAPIApplicationGuildCommandsJSONBody[number];

export const GUILD_COMMANDS = [
  C_COMMAND,
  RESET_COMMAND
] as const satisfies RESTPutAPIApplicationGuildCommandsJSONBody;

import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ChannelType,
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
      description: "Delete a guild memory record by ID",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "id",
          description: "Memory ID shown by /memory view",
          type: ApplicationCommandOptionType.String,
          required: true
        }
      ]
    },
    {
      name: "reset",
      description: "Reset guild memory",
      type: ApplicationCommandOptionType.Subcommand
    },
    {
      name: "source",
      description: "Manage ambient memory source channels",
      type: ApplicationCommandOptionType.SubcommandGroup,
      options: [
        {
          name: "enable",
          description: "Build memory from new messages in a channel",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "channel",
              description: "Channel to observe; defaults to this channel",
              type: ApplicationCommandOptionType.Channel,
              channel_types: [
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement,
                ChannelType.AnnouncementThread,
                ChannelType.PublicThread,
                ChannelType.PrivateThread
              ],
              required: false
            }
          ]
        },
        {
          name: "disable",
          description: "Stop building memory from a channel",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "channel",
              description:
                "Channel to stop observing; defaults to this channel",
              type: ApplicationCommandOptionType.Channel,
              channel_types: [
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement,
                ChannelType.AnnouncementThread,
                ChannelType.PublicThread,
                ChannelType.PrivateThread
              ],
              required: false
            }
          ]
        },
        {
          name: "view",
          description: "View ambient memory source channels",
          type: ApplicationCommandOptionType.Subcommand
        }
      ]
    }
  ]
} as const satisfies RESTPutAPIApplicationGuildCommandsJSONBody[number];

export const GUILD_COMMANDS = [
  C_COMMAND,
  RESET_COMMAND,
  MEMORY_COMMAND
] as const satisfies RESTPutAPIApplicationGuildCommandsJSONBody;

export const ApplicationCommandOptionType = {
  Subcommand: 1,
  SubcommandGroup: 2,
  String: 3,
  Integer: 4,
  Channel: 7,
  Attachment: 11
} as const;

export const ApplicationCommandType = {
  ChatInput: 1
} as const;

export const InteractionResponseType = {
  Pong: 1,
  ChannelMessageWithSource: 4,
  DeferredChannelMessageWithSource: 5
} as const;

export const InteractionType = {
  Ping: 1,
  ApplicationCommand: 2
} as const;

export const MessageFlags = {
  Ephemeral: 64
} as const;

export const ChannelType = {
  GuildText: 0,
  GuildVoice: 2,
  GuildCategory: 4,
  GuildAnnouncement: 5,
  AnnouncementThread: 10,
  PublicThread: 11,
  PrivateThread: 12,
  GuildStageVoice: 13,
  GuildDirectory: 14,
  GuildForum: 15,
  GuildMedia: 16
} as const;

export const MessageSearchSortMode = {
  Timestamp: "timestamp",
  Relevance: "relevance"
} as const;

export const PermissionFlagsBits = {
  Administrator: 8n,
  ManageGuild: 32n,
  ManageMessages: 8192n,
  ManageNicknames: 134217728n,
  ModerateMembers: 1099511627776n
} as const;

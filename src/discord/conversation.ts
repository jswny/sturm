export type DiscordGuildChannelLocation = {
  guildId: string;
  channelId: string;
};

const DISCORD_GUILD_CHANNEL_CONVERSATION_PATTERN =
  /^discord:guild:([^:]+):channel:[^:]+$/;

export function getDiscordGuildChannelConversationName(
  location: DiscordGuildChannelLocation
) {
  return `discord:guild:${location.guildId}:channel:${location.channelId}`;
}

export function getGuildIdFromDiscordConversationName(
  name: string | undefined
) {
  const match = name?.match(DISCORD_GUILD_CHANNEL_CONVERSATION_PATTERN);
  return match?.[1];
}

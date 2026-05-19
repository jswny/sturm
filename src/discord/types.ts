export type DiscordChatRequest = {
  interactionId: string;
  text: string;
  guildId?: string;
  channelId?: string;
  userId?: string;
  user?: DiscordUserContext;
};

export type DiscordChatResponse = {
  content: string;
  attachments?: DiscordResponseAttachment[];
};

export type DiscordResponseTarget = {
  applicationId: string;
  token: string;
};

export type DiscordResponseAttachment = {
  filename: string;
  mimeType: string;
  base64: string;
  description?: string;
};

export type DiscordUserContext = {
  id: string;
  displayName?: string;
};

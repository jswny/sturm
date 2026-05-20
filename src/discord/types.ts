export type DiscordChatRequest = {
  interactionId: string;
  text: string;
  guildId?: string;
  channelId?: string;
  userId?: string;
  user?: DiscordUserContext;
  userPermissions?: string;
};

export type DiscordChatResponse = {
  content: string;
  attachments?: DiscordResponseAttachment[];
};

export type DiscordResponseTarget =
  | DiscordWebhookResponseTarget
  | DiscordDebugResponseTarget;

export type DiscordWebhookResponseTarget = {
  type: "discord";
  applicationId: string;
  token: string;
};

export type DiscordDebugResponseTarget = {
  type: "debug";
  id: string;
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

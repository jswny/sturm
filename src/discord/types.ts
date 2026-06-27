import type {
  APIMessageTopLevelComponent,
  MessageFlags
} from "discord-api-types/v10";
import type { StoredResponseArtifact } from "../artifacts";

export type DiscordChatRequest = {
  correlationId: string;
  discordInteractionId?: string;
  sourceCorrelationId?: string;
  sourceInteractionId?: string;
  text: string;
  emptyResponseBehavior?: "fallback" | "suppress";
  guildId?: string;
  channelId?: string;
  channel?: DiscordChannelContext;
  attachments?: DiscordRequestAttachment[];
  artifacts?: StoredResponseArtifact[];
  app?: DiscordAppContext;
  appPermissions?: DiscordPermissionContext;
  userId?: string;
  user?: DiscordUserContext;
  userPermissions?: string;
};

export type DiscordSourceTurnContext = Pick<
  DiscordChatRequest,
  | "guildId"
  | "channelId"
  | "channel"
  | "app"
  | "appPermissions"
  | "userId"
  | "user"
  | "userPermissions"
>;

export type DiscordChatResponse = {
  content: string;
  attachments?: DiscordResponseAttachment[];
  components?: APIMessageTopLevelComponent[];
  flags?: MessageFlags;
};

export type DiscordGeneratedChatResponse = {
  content: string;
  assistantMessageText: string;
  attachments?: DiscordGeneratedResponseAttachment[];
  generatedAt: string;
};

export type DiscordResponseTarget =
  | DiscordWebhookResponseTarget
  | DiscordDebugResponseTarget
  | DiscordChannelMessageTarget;

export type DiscordWebhookResponseTarget = {
  type: "discord";
  applicationId: string;
  token: string;
};

export type DiscordDebugResponseTarget = {
  type: "debug";
  id: string;
};

export type DiscordChannelMessageTarget = {
  type: "channel_message";
  channelId: string;
};

export type DiscordResponseAttachment = {
  filename: string;
  mimeType: string;
  artifactKey?: string;
  sha256?: string;
  base64: string;
  description?: string;
};

export type DiscordGeneratedResponseAttachment = Omit<
  DiscordResponseAttachment,
  "base64" | "artifactKey"
> & {
  artifactKey: string;
};

export type DiscordUserContext = {
  id: string;
  displayName?: string;
};

export type DiscordChannelContext = {
  id: string;
  guildId?: string;
  name?: string;
  type?: number;
  typeName?: string;
  topic?: string;
  parentId?: string;
  nsfw?: boolean;
  slowmodeSeconds?: number;
};

export type DiscordAppContext = {
  applicationId?: string;
  botUserId?: string;
};

export type DiscordRequestAttachment = {
  id: string;
  artifactId?: string;
  artifactKey?: string;
  sha256?: string;
  storedAt?: string;
  filename: string;
  mimeType?: string;
  sizeBytes: number;
  url: string;
  width?: number;
  height?: number;
  description?: string;
};

export type DiscordPermissionContext = {
  raw: string;
  names: string[];
};

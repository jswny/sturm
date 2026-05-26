import {
  ChannelType,
  type APIChatInputApplicationCommandInteraction
} from "discord-api-types/v10";
import {
  createDiscordPermissionContext,
  formatDiscordPermissions
} from "./permissions";
import type { DiscordChannelContext, DiscordChatRequest } from "./types";

type UnknownRecord = Record<string, unknown>;

export function createDiscordRuntimeContext(
  interaction: APIChatInputApplicationCommandInteraction
): Pick<DiscordChatRequest, "channel" | "appPermissions"> {
  return {
    channel: createDiscordChannelContext(interaction),
    appPermissions: createDiscordPermissionContext(interaction.app_permissions)
  };
}

export function formatDiscordRuntimeContext(request: DiscordChatRequest) {
  const sections = [
    formatDiscordChannelContext(request.channel),
    formatDiscordAppContext(request)
  ].filter(Boolean);

  return sections.join("\n\n");
}

function createDiscordChannelContext(
  interaction: APIChatInputApplicationCommandInteraction
): DiscordChannelContext {
  const channel = interaction.channel as UnknownRecord | undefined;
  return omitUndefined({
    id: interaction.channel_id,
    guildId: interaction.guild_id ?? getString(channel, "guild_id"),
    name: getString(channel, "name"),
    type: getNumber(channel, "type"),
    typeName: formatChannelType(getNumber(channel, "type")),
    topic: getString(channel, "topic"),
    parentId: getString(channel, "parent_id"),
    nsfw: getBoolean(channel, "nsfw"),
    slowmodeSeconds: getNumber(channel, "rate_limit_per_user")
  });
}

function formatDiscordChannelContext(
  channel: DiscordChannelContext | undefined
) {
  if (!channel) return "";

  const lines = [
    "Current Discord channel:",
    `guild_id: ${channel.guildId}`,
    `channel_id: ${channel.id}`,
    `channel_name: ${channel.name}`,
    `channel_type: ${channel.typeName ?? channel.type}`,
    `topic: ${channel.topic}`,
    `parent_id: ${channel.parentId}`,
    `nsfw: ${formatBoolean(channel.nsfw)}`,
    `slowmode_seconds: ${channel.slowmodeSeconds}`
  ];

  return lines.filter(hasValue).join("\n");
}

function formatDiscordAppContext(request: DiscordChatRequest) {
  const lines = [
    "Current Discord app context:",
    request.appPermissions
      ? `bot_permissions: ${formatDiscordPermissions(request.appPermissions)}`
      : ""
  ].filter(Boolean);

  return lines.length > 1 ? lines.join("\n") : "";
}

function formatChannelType(type: number | undefined) {
  if (type === undefined) return undefined;

  switch (type) {
    case ChannelType.GuildText:
      return "guild_text";
    case ChannelType.GuildVoice:
      return "guild_voice";
    case ChannelType.GuildCategory:
      return "guild_category";
    case ChannelType.GuildAnnouncement:
      return "guild_announcement";
    case ChannelType.AnnouncementThread:
      return "announcement_thread";
    case ChannelType.PublicThread:
      return "public_thread";
    case ChannelType.PrivateThread:
      return "private_thread";
    case ChannelType.GuildStageVoice:
      return "guild_stage_voice";
    case ChannelType.GuildDirectory:
      return "guild_directory";
    case ChannelType.GuildForum:
      return "guild_forum";
    case ChannelType.GuildMedia:
      return "guild_media";
    default:
      return `unknown_${type}`;
  }
}

function getString(record: UnknownRecord | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getNumber(record: UnknownRecord | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function getBoolean(record: UnknownRecord | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function formatBoolean(value: boolean | undefined) {
  if (value === undefined) return undefined;
  return value ? "true" : "false";
}

function hasValue(line: string) {
  return !line.endsWith(": undefined");
}

function omitUndefined<T extends Record<string, unknown>>(input: T) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as T;
}

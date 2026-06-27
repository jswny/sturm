import type { DiscordChatRequest, DiscordSourceTurnContext } from "./types";

export function createDiscordSourceTurnContext(
  request: DiscordChatRequest
): DiscordSourceTurnContext {
  return removeUndefined({
    guildId: request.guildId,
    channelId: request.channelId,
    channel: request.channel,
    app: request.app,
    appPermissions: request.appPermissions,
    userId: request.userId,
    user: request.user,
    userPermissions: request.userPermissions
  });
}

export function applyDiscordSourceTurnContext(
  request: DiscordChatRequest,
  sourceContext: DiscordSourceTurnContext | undefined
): DiscordChatRequest {
  if (!sourceContext) return request;

  return removeUndefined({
    ...request,
    guildId: request.guildId ?? sourceContext.guildId,
    channelId: request.channelId ?? sourceContext.channelId,
    channel: request.channel ?? sourceContext.channel,
    app: request.app ?? sourceContext.app,
    appPermissions: request.appPermissions ?? sourceContext.appPermissions,
    userId: request.userId ?? sourceContext.userId,
    user: request.user ?? sourceContext.user,
    userPermissions: request.userPermissions ?? sourceContext.userPermissions
  });
}

function removeUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as T;
}

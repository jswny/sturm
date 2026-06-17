import { getAgentByName } from "agents";
import { getDiscordGuildChannelConversationName } from "./discord/conversation";
import { createDiscordPermissionContext } from "./discord/permissions";
import type {
  DiscordAppContext,
  DiscordChannelContext,
  DiscordPermissionContext,
  DiscordRequestAttachment
} from "./discord/types";
import { logWarn } from "./logging";

type DebugEnv = Env & {
  DISCORD_APPLICATION_ID?: string;
  STURM_DEBUG_ENABLED?: string;
};

type DebugSurface = {
  type: "guild_channel";
  guildId: string;
  channelId: string;
};

type DebugUser = {
  id: string;
  displayName?: string;
};

type DebugChatPayload = {
  surface: DebugSurface;
  user: DebugUser;
  text: string;
  interactionId?: string;
  channel?: Partial<DiscordChannelContext>;
  attachments?: DiscordRequestAttachment[];
  permissions?: {
    user?: string;
    app?: string;
    appNames?: string[];
  };
};

type DebugResetPayload = {
  surface: DebugSurface;
  interactionId?: string;
};

type DebugStatusPayload = {
  surface: DebugSurface;
  interactionId: string;
};

export async function handleDebugRequest(
  request: Request,
  env: DebugEnv
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/debug/")) return null;

  if (!isDebugEnabled(env)) {
    return json({ error: "Debug endpoints are disabled." }, { status: 404 });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    if (url.pathname === "/debug/chat") {
      return replyToDebugChat(await readJson<DebugChatPayload>(request), env);
    }

    if (url.pathname === "/debug/reset") {
      return replyToDebugReset(await readJson<DebugResetPayload>(request), env);
    }

    if (url.pathname === "/debug/status") {
      return replyToDebugStatus(
        await readJson<DebugStatusPayload>(request),
        env
      );
    }
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }

  return json({ error: "Unknown debug endpoint" }, { status: 404 });
}

function isDebugEnabled(env: DebugEnv) {
  return env.STURM_DEBUG_ENABLED?.trim().toLowerCase() === "true";
}

async function replyToDebugChat(payload: DebugChatPayload, env: DebugEnv) {
  const error = validateDebugChatPayload(payload);
  if (error) return json({ error }, { status: 400 });

  const conversationName = getDiscordGuildChannelConversationName(
    payload.surface
  );
  const agent = await getAgentByName(env.ChatAgent, conversationName);
  const interactionId = payload.interactionId ?? crypto.randomUUID();
  const response = await agent.runDebugQueuedDiscordChat({
    interactionId,
    text: payload.text.trim(),
    guildId: payload.surface.guildId,
    channelId: payload.surface.channelId,
    channel: createDebugChannelContext(payload),
    attachments: payload.attachments,
    app: createDebugAppContext(env),
    appPermissions: createDebugAppPermissions(payload),
    userId: payload.user.id,
    user: payload.user,
    userPermissions: payload.permissions?.user
  });

  return json({
    ok: true,
    conversationName,
    interactionId,
    queued: true,
    response: response.content,
    attachments: response.attachments?.map((attachment) => ({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      artifactKey: attachment.artifactKey,
      sha256: attachment.sha256,
      description: attachment.description,
      base64: attachment.base64,
      dataUrl: `data:${attachment.mimeType};base64,${attachment.base64}`
    }))
  });
}

async function replyToDebugReset(payload: DebugResetPayload, env: DebugEnv) {
  const error = validateDebugSurface(payload.surface);
  if (error) return json({ error }, { status: 400 });

  const conversationName = getDiscordGuildChannelConversationName(
    payload.surface
  );
  const agent = await getAgentByName(env.ChatAgent, conversationName);
  const interactionId = payload.interactionId ?? crypto.randomUUID();
  const response = await agent.runDebugQueuedDiscordReset({
    interactionId,
    guildId: payload.surface.guildId,
    channelId: payload.surface.channelId
  });

  return json({
    ok: true,
    conversationName,
    interactionId,
    queued: true,
    response: response.content
  });
}

async function replyToDebugStatus(payload: DebugStatusPayload, env: DebugEnv) {
  const error = validateDebugStatusPayload(payload);
  if (error) return json({ error }, { status: 400 });

  const conversationName = getDiscordGuildChannelConversationName(
    payload.surface
  );
  const agent = await getAgentByName(env.ChatAgent, conversationName);
  const status = await agent.getDebugDiscordStatus(payload.interactionId);

  return json({
    ok: true,
    conversationName,
    interactionId: payload.interactionId,
    ...status
  });
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch (error) {
    logWarn("Debug request JSON parse failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    throw new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }
}

function validateDebugChatPayload(payload: DebugChatPayload) {
  if (!payload || typeof payload !== "object") return "Missing request body.";

  const surfaceError = validateDebugSurface(payload.surface);
  if (surfaceError) return surfaceError;

  if (!payload.user || typeof payload.user !== "object") {
    return "Missing user.";
  }

  if (!payload.user.id) return "Missing user.id.";

  if (!payload.text?.trim()) return "Missing text.";

  return null;
}

function validateDebugStatusPayload(payload: DebugStatusPayload) {
  if (!payload || typeof payload !== "object") return "Missing request body.";

  const surfaceError = validateDebugSurface(payload.surface);
  if (surfaceError) return surfaceError;

  if (!payload.interactionId?.trim()) return "Missing interactionId.";

  return null;
}

function validateDebugSurface(surface: DebugSurface | undefined) {
  if (!surface || typeof surface !== "object") return "Missing surface.";

  if (surface.type !== "guild_channel") {
    return "surface.type must be guild_channel.";
  }
  if (!surface.guildId) return "Missing surface.guildId.";
  if (!surface.channelId) return "Missing surface.channelId.";
  return null;
}

function createDebugChannelContext(
  payload: DebugChatPayload
): DiscordChannelContext {
  return {
    type: 0,
    typeName: "guild_text",
    ...payload.channel,
    id: payload.surface.channelId,
    guildId: payload.surface.guildId
  };
}

function createDebugAppPermissions(
  payload: DebugChatPayload
): DiscordPermissionContext | undefined {
  const raw = payload.permissions?.app;
  if (!raw) return undefined;

  if (!payload.permissions?.appNames) {
    return createDiscordPermissionContext(raw);
  }

  return {
    raw,
    names: payload.permissions.appNames
  };
}

function createDebugAppContext(env: DebugEnv): DiscordAppContext | undefined {
  const applicationId = env.DISCORD_APPLICATION_ID?.trim();
  if (!applicationId) return undefined;
  return { applicationId };
}

function json(body: unknown, init?: ResponseInit) {
  return Response.json(body, init);
}

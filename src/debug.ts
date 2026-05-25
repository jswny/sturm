import { getAgentByName } from "agents";
import { logWarn } from "./logging";

type DebugEnv = Env & {
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
  permissions?: {
    user?: string;
  };
};

type DebugResetPayload = {
  surface: DebugSurface;
  interactionId?: string;
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

  const conversationName = getDebugConversationName(payload.surface);
  const agent = await getAgentByName(env.ChatAgent, conversationName);
  const interactionId = payload.interactionId ?? crypto.randomUUID();
  const response = await agent.runDebugQueuedDiscordChat({
    interactionId,
    text: payload.text.trim(),
    guildId: payload.surface.guildId,
    channelId: payload.surface.channelId,
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

  const conversationName = getDebugConversationName(payload.surface);
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

function validateDebugSurface(surface: DebugSurface | undefined) {
  if (!surface || typeof surface !== "object") return "Missing surface.";

  if (surface.type !== "guild_channel") {
    return "surface.type must be guild_channel.";
  }
  if (!surface.guildId) return "Missing surface.guildId.";
  if (!surface.channelId) return "Missing surface.channelId.";
  return null;
}

function getDebugConversationName(surface: DebugSurface) {
  return `discord:guild:${surface.guildId}:channel:${surface.channelId}`;
}

function json(body: unknown, init?: ResponseInit) {
  return Response.json(body, init);
}

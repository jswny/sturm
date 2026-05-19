import { getAgentByName } from "agents";

type DebugEnv = Env & {
  STURM_DEBUG_TOKEN?: string;
};

type DebugSurface =
  | {
      type: "guild_channel";
      guildId: string;
      channelId: string;
    }
  | {
      type: "dm";
      userId: string;
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
};

type DebugResetPayload = {
  surface: DebugSurface;
};

export async function handleDebugRequest(
  request: Request,
  env: DebugEnv
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/debug/")) return null;

  const authResponse = authorizeDebugRequest(request, env);
  if (authResponse) return authResponse;

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

function authorizeDebugRequest(request: Request, env: DebugEnv) {
  const token = env.STURM_DEBUG_TOKEN?.trim();
  if (!token) {
    return json({ error: "Debug endpoints are disabled." }, { status: 503 });
  }

  const expected = `Bearer ${token}`;
  if (request.headers.get("authorization") !== expected) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

async function replyToDebugChat(payload: DebugChatPayload, env: DebugEnv) {
  const error = validateDebugChatPayload(payload);
  if (error) return json({ error }, { status: 400 });

  const conversationName = getDebugConversationName(payload.surface);
  const agent = await getAgentByName(env.ChatAgent, conversationName);
  const response = await agent.askFromDiscord({
    interactionId: payload.interactionId ?? crypto.randomUUID(),
    text: payload.text.trim(),
    guildId:
      payload.surface.type === "guild_channel"
        ? payload.surface.guildId
        : undefined,
    channelId:
      payload.surface.type === "guild_channel"
        ? payload.surface.channelId
        : undefined,
    userId: payload.user.id,
    user: payload.user
  });

  return json({
    ok: true,
    conversationName,
    response: response.content
  });
}

async function replyToDebugReset(payload: DebugResetPayload, env: DebugEnv) {
  const error = validateDebugSurface(payload.surface);
  if (error) return json({ error }, { status: 400 });

  const conversationName = getDebugConversationName(payload.surface);
  const agent = await getAgentByName(env.ChatAgent, conversationName);
  const response = await agent.resetFromDiscord();

  return json({
    ok: true,
    conversationName,
    response: response.content
  });
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
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

  if (
    payload.surface.type === "dm" &&
    payload.surface.userId !== payload.user.id
  ) {
    return "DM surface userId must match user.id.";
  }

  if (!payload.text?.trim()) return "Missing text.";

  return null;
}

function validateDebugSurface(surface: DebugSurface | undefined) {
  if (!surface || typeof surface !== "object") return "Missing surface.";

  if (surface.type === "guild_channel") {
    if (!surface.guildId) return "Missing surface.guildId.";
    if (!surface.channelId) return "Missing surface.channelId.";
    return null;
  }

  if (surface.type === "dm") {
    if (!surface.userId) return "Missing surface.userId.";
    return null;
  }

  return "surface.type must be guild_channel or dm.";
}

function getDebugConversationName(surface: DebugSurface) {
  if (surface.type === "guild_channel") {
    return `discord:guild:${surface.guildId}:channel:${surface.channelId}`;
  }

  return `discord:dm:${surface.userId}`;
}

function json(body: unknown, init?: ResponseInit) {
  return Response.json(body, init);
}

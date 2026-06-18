import { getAgentByName } from "agents";
import type { CodeModeInspectionRequest } from "./codemode-inspection";
import {
  DiscordApiError,
  type DiscordApiEnv,
  getCurrentUserGuilds,
  overwriteGuildApplicationCommands
} from "./discord/api";
import { GUILD_COMMANDS } from "./discord/commands";
import { getDiscordGuildChannelConversationName } from "./discord/conversation";
import { logError, logInfo, logWarn } from "./logging";

type AdminEnv = DiscordApiEnv & {
  DISCORD_APPLICATION_ID?: string;
};

type AdminGuildChannelSurface = {
  type: "guild_channel";
  guildId: string;
  channelId: string;
};

type CodeModeInspectPayload = CodeModeInspectionRequest & {
  surface: AdminGuildChannelSurface;
};

type RegisterCommandsResult = {
  guildId: string;
  guildName: string;
  ok: boolean;
  registeredCommands?: string[];
  error?: string;
};

export async function handleAdminRequest(
  request: Request,
  env: AdminEnv
): Promise<Response | null> {
  const url = new URL(request.url);
  if (isRegisterCommandsPath(url.pathname)) {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    return registerCommandsInAllGuilds(env);
  }

  if (isCodeModeInspectPath(url.pathname)) {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    try {
      return inspectCodeMode(
        await readJson<CodeModeInspectPayload>(request),
        env
      );
    } catch (error) {
      if (error instanceof Response) return error;
      throw error;
    }
  }

  return null;
}

function isRegisterCommandsPath(pathname: string) {
  return (
    pathname === "/api/admin/register-commands" ||
    pathname === "/api/admin/register-commands/"
  );
}

function isCodeModeInspectPath(pathname: string) {
  return (
    pathname === "/api/admin/codemode/inspect" ||
    pathname === "/api/admin/codemode/inspect/"
  );
}

async function inspectCodeMode(payload: CodeModeInspectPayload, env: AdminEnv) {
  const error = validateCodeModeInspectPayload(payload);
  if (error) return Response.json({ error }, { status: 400 });

  const conversationName = getDiscordGuildChannelConversationName(
    payload.surface
  );
  const agent = await getAgentByName(env.ChatAgent, conversationName);
  const codeMode = await agent.inspectCodeModeRuntime({
    limit: payload.limit,
    executionId: payload.executionId,
    interactionId: payload.interactionId,
    previewMaxChars: payload.previewMaxChars
  });

  return Response.json({
    ok: true,
    conversationName,
    surface: payload.surface,
    codeMode
  });
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch (error) {
    logWarn("Admin request JSON parse failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    throw new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }
}

function validateCodeModeInspectPayload(payload: CodeModeInspectPayload) {
  if (!payload || typeof payload !== "object") return "Missing request body.";

  const surfaceError = validateAdminGuildChannelSurface(payload.surface);
  if (surfaceError) return surfaceError;

  if (payload.limit !== undefined && !isIntegerInRange(payload.limit, 1, 50)) {
    return "limit must be an integer from 1 through 50.";
  }

  if (
    payload.previewMaxChars !== undefined &&
    !isIntegerInRange(payload.previewMaxChars, 100, 4000)
  ) {
    return "previewMaxChars must be an integer from 100 through 4000.";
  }

  if (
    payload.executionId !== undefined &&
    (typeof payload.executionId !== "string" || !payload.executionId.trim())
  ) {
    return "executionId must be a non-empty string.";
  }

  if (
    payload.interactionId !== undefined &&
    (typeof payload.interactionId !== "string" || !payload.interactionId.trim())
  ) {
    return "interactionId must be a non-empty string.";
  }

  return null;
}

function validateAdminGuildChannelSurface(
  surface: AdminGuildChannelSurface | undefined
) {
  if (!surface || typeof surface !== "object") return "Missing surface.";
  if (surface.type !== "guild_channel") {
    return "surface.type must be guild_channel.";
  }
  if (!surface.guildId) return "Missing surface.guildId.";
  if (!surface.channelId) return "Missing surface.channelId.";
  return null;
}

function isIntegerInRange(value: unknown, min: number, max: number) {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

async function registerCommandsInAllGuilds(env: AdminEnv) {
  const applicationId = env.DISCORD_APPLICATION_ID?.trim();
  const token = env.DISCORD_TOKEN?.trim();

  if (!applicationId) {
    logWarn("Discord command registration missing application ID");
    return Response.json(
      { ok: false, error: "DISCORD_APPLICATION_ID is not configured." },
      { status: 500 }
    );
  }

  if (!token) {
    logWarn("Discord command registration missing bot token");
    return Response.json(
      { ok: false, error: "DISCORD_TOKEN is not configured." },
      { status: 500 }
    );
  }

  let guilds: Awaited<ReturnType<typeof getCurrentUserGuilds>>;
  try {
    guilds = await getCurrentUserGuilds(env);
  } catch (error) {
    logDiscordAdminFailure("Discord guild list fetch failed", error, {
      operation: "registerCommands"
    });
    return Response.json(
      { ok: false, error: formatDiscordAdminError(error) },
      { status: 502 }
    );
  }
  const commandNames = GUILD_COMMANDS.map((command) => command.name);
  const results: RegisterCommandsResult[] = [];

  logInfo("Registering Discord guild commands", {
    guildCount: guilds.length,
    commands: commandNames
  });

  for (const guild of guilds) {
    try {
      const commands = await overwriteGuildApplicationCommands(
        env,
        applicationId,
        guild.id,
        GUILD_COMMANDS
      );
      results.push({
        guildId: guild.id,
        guildName: guild.name,
        ok: true,
        registeredCommands: commands.map((command) => command.name)
      });
    } catch (error) {
      const message = formatDiscordAdminError(error);
      logDiscordAdminFailure(
        "Discord guild command registration failed",
        error,
        {
          guildId: guild.id,
          guildName: guild.name
        }
      );
      results.push({
        guildId: guild.id,
        guildName: guild.name,
        ok: false,
        error: message
      });
    }
  }

  const failures = results.filter((result) => !result.ok);
  return Response.json({
    ok: failures.length === 0,
    guildCount: guilds.length,
    successCount: results.length - failures.length,
    failureCount: failures.length,
    commandNames,
    results
  });
}

function logDiscordAdminFailure(
  message: string,
  error: unknown,
  context: Record<string, unknown>
) {
  if (error instanceof DiscordApiError) {
    logWarn(message, {
      ...context,
      discordStatus: error.status,
      discordCode: error.code,
      error: formatDiscordAdminError(error)
    });
    return;
  }

  logError(message, error, context);
}

function formatDiscordAdminError(error: unknown) {
  if (error instanceof DiscordApiError) {
    return `Discord API error ${error.status}.`;
  }

  return error instanceof Error ? error.message : String(error);
}

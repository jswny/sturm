import {
  DiscordApiError,
  getCurrentUserGuilds,
  overwriteGuildApplicationCommands
} from "./discord/api";
import { GUILD_COMMANDS } from "./discord/commands";
import { logInfo, logWarn } from "./logging";

type AdminEnv = Env & {
  DISCORD_APPLICATION_ID?: string;
  DISCORD_TOKEN?: string;
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
  if (
    url.pathname !== "/api/admin/register-commands" &&
    url.pathname !== "/api/admin/register-commands/"
  ) {
    return null;
  }

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  return registerCommandsInAllGuilds(env);
}

async function registerCommandsInAllGuilds(env: AdminEnv) {
  const applicationId = env.DISCORD_APPLICATION_ID?.trim();
  const token = env.DISCORD_TOKEN?.trim();

  if (!applicationId) {
    return Response.json(
      { ok: false, error: "DISCORD_APPLICATION_ID is not configured." },
      { status: 500 }
    );
  }

  if (!token) {
    return Response.json(
      { ok: false, error: "DISCORD_TOKEN is not configured." },
      { status: 500 }
    );
  }

  const guilds = await getCurrentUserGuilds(token);
  const commandNames = GUILD_COMMANDS.map((command) => command.name);
  const results: RegisterCommandsResult[] = [];

  logInfo("Registering Discord guild commands", {
    guildCount: guilds.length,
    commands: commandNames
  });

  for (const guild of guilds) {
    try {
      const commands = await overwriteGuildApplicationCommands(
        token,
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
      logWarn("Discord guild command registration failed", {
        guildId: guild.id,
        guildName: guild.name,
        error: message
      });
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

function formatDiscordAdminError(error: unknown) {
  if (error instanceof DiscordApiError) {
    return `Discord API error ${error.status}.`;
  }

  return error instanceof Error ? error.message : String(error);
}

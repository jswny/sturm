import { handleAdminRequest } from "./admin";
import { handleDebugRequest } from "./debug";
import { handleDiscordRequest } from "./discord";
import { logError } from "./logging";

export { ChatAgent } from "./agent";
export { GuildMemoryObject } from "./memory";

type ServerEnv = Env & {
  DISCORD_APPLICATION_ID?: string;
  DISCORD_TOKEN?: string;
  STURM_DEBUG_TOKEN?: string;
};

export default {
  async fetch(request: Request, env: ServerEnv, ctx: ExecutionContext) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/" && request.method === "GET") {
        return Response.json({
          ok: true,
          service: "sturm",
          discordApplicationId: env.DISCORD_APPLICATION_ID ?? null,
          timestamp: new Date().toISOString()
        });
      }

      return (
        (await handleAdminRequest(request, env)) ||
        (await handleDebugRequest(request, env)) ||
        (await handleDiscordRequest(request, env, ctx)) ||
        new Response("Not found", { status: 404 })
      );
    } catch (error) {
      logError("Worker request failed", error, {
        method: request.method,
        path: url.pathname
      });
      throw error;
    }
  }
} satisfies ExportedHandler<Env>;

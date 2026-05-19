import { handleDebugRequest } from "./debug";
import { handleDiscordRequest } from "./discord";

export { ChatAgent } from "./agent";

type ServerEnv = Env & {
  DISCORD_APPLICATION_ID?: string;
  STURM_DEBUG_TOKEN?: string;
};

export default {
  async fetch(request: Request, env: ServerEnv) {
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") {
      return Response.json({
        ok: true,
        service: "sturm",
        discordApplicationId: env.DISCORD_APPLICATION_ID ?? null,
        timestamp: new Date().toISOString()
      });
    }

    return (
      (await handleDebugRequest(request, env)) ||
      (await handleDiscordRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

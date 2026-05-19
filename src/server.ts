import { handleDiscordRequest } from "./discord";

export { ChatAgent } from "./agent";

type ServerEnv = Env & {
  DISCORD_APPLICATION_ID?: string;
};

export default {
  async fetch(request: Request, env: ServerEnv, ctx: ExecutionContext) {
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
      (await handleDiscordRequest(request, env, ctx)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

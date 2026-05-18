import { handleDiscordRequest } from "./discord";

export { ChatAgent } from "./agent";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return (
      (await handleDiscordRequest(request, env, ctx)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

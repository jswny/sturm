interface Env {
  GATEWAY_QUEUE: Queue;
  GATEWAY_SHARED_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const auth = request.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${env.GATEWAY_SHARED_SECRET}`) {
      return new Response("unauthorized", { status: 401 });
    }

    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    const text = await request.text();
    try {
      JSON.parse(text);
    } catch {
      return new Response("invalid json", { status: 400 });
    }

    await env.GATEWAY_QUEUE.send(text);
    return new Response(null, { status: 204 });
  },
};

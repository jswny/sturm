import { append, history, normalizeMessageCreate, stubFor } from "channel-buffer";

interface Env {
  CHANNEL_BUFFER: DurableObjectNamespace;
  BUFFER_SIZE?: string;
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const body = typeof message.body === "string" ? message.body : JSON.stringify(message.body);
      let parsed: unknown;

      try {
        parsed = JSON.parse(body);
      } catch {
        console.log(body);
        continue;
      }

      const item = normalizeMessageCreate(parsed);
      if (!item) {
        console.log(body);
        continue;
      }

      console.log(
        `MESSAGE_CREATE channel=${item.channel_id} author=${item.author_id} id=${item.message_id}`,
      );

      const stub = stubFor(item.channel_id, env);
      try {
        const res = await append(stub, item);
        if (!res.ok) {
          console.log(`buffer append failed channel=${item.channel_id} status=${res.status}`);
        }
        const histRes = await history(stub, 5);
        if (histRes.ok) {
          const hist = await histRes.json();
          console.log(
            `history channel=${item.channel_id} size=${Array.isArray(hist) ? hist.length : 0}`,
            hist,
          );
        }
      } catch (error) {
        console.log(`buffer append error channel=${item.channel_id} error=${error}`);
      }
    }
  },
};

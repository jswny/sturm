export interface BufferItem {
  role: "user" | "assistant";
  author_id: string;
  author_name: string;
  content: string;
  message_id: string;
  timestamp: string;
  channel_id: string;
}

interface EnvWithBuffer {
  CHANNEL_BUFFER: DurableObjectNamespace;
}

interface EnvWithSize {
  BUFFER_SIZE?: string;
}

export class ChannelBuffer {
  private readonly state: DurableObjectState;
  private readonly capacity: number;
  private messages: BufferItem[] = [];
  private ready: Promise<void>;

  constructor(state: DurableObjectState, env: EnvWithSize) {
    this.state = state;
    this.capacity = parseInt(env.BUFFER_SIZE ?? "40", 10) || 40;
    this.ready = this.load();
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/append") {
      const body = await request.json<BufferItem>().catch(() => null);
      if (!body || !isValidItem(body)) return new Response("invalid item", { status: 400 });
      this.append(body);
      await this.persist();
      return new Response(null, { status: 204 });
    }

    if (request.method === "GET" && url.pathname === "/history") {
      const limit = parseInt(url.searchParams.get("limit") ?? "", 10);
      const capped =
        Number.isFinite(limit) && limit > 0 ? Math.min(limit, this.capacity) : this.capacity;
      const items = takeFromEnd(this.messages, capped);
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (request.method === "POST" && url.pathname === "/reset") {
      this.messages = [];
      await this.persist();
      return new Response(null, { status: 204 });
    }

    return new Response("not found", { status: 404 });
  }

  private append(item: BufferItem) {
    this.messages.push(item);
    while (this.messages.length > this.capacity) {
      this.messages.shift();
    }
  }

  private async load() {
    const stored = await this.state.storage.get<BufferItem[]>("messages");
    if (Array.isArray(stored)) {
      this.messages = stored;
    }
  }

  private persist() {
    return this.state.storage.put("messages", this.messages);
  }
}

export function stubFor(channelId: string, env: EnvWithBuffer) {
  const id = env.CHANNEL_BUFFER.idFromName(channelId);
  return env.CHANNEL_BUFFER.get(id);
}

export async function append(stub: DurableObjectStub, item: BufferItem) {
  return stub.fetch("https://channel-buffer/append", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(item),
  });
}

export async function history(stub: DurableObjectStub, limit?: number) {
  const url = new URL("https://channel-buffer/history");
  if (limit && limit > 0) url.searchParams.set("limit", String(limit));
  return stub.fetch(url);
}

export function normalizeMessageCreate(payload: unknown): BufferItem | null {
  if (!isRecord(payload)) return null;
  if (payload.t !== "MESSAGE_CREATE") return null;
  const data = payload.d;
  if (!isRecord(data)) return null;

  const channelId = asString(data.channel_id);
  if (!channelId) return null;

  const author = isRecord(data.author) ? data.author : {};
  const authorId = asString(author.id) || "unknown";
  const authorName = asString(author.global_name) || asString(author.username) || authorId;
  const role: BufferItem["role"] = author.bot ? "assistant" : "user";
  const content = messageContent(data);
  const messageId = asString(data.id) || "";
  const timestamp = asString(data.timestamp) || new Date().toISOString();

  return {
    role,
    author_id: authorId,
    author_name: authorName,
    content,
    message_id: messageId,
    timestamp,
    channel_id: channelId,
  };
}

function messageContent(data: Record<string, unknown>) {
  const content = asString(data.content);
  if (content && content.trim() !== "") return content;

  const attachments = Array.isArray(data.attachments) ? data.attachments : [];
  if (attachments.length === 0) return "";

  const names = attachments
    .map((att) =>
      isRecord(att) ? asString(att.filename) || asString(att.url) || "attachment" : null,
    )
    .filter((v): v is string => Boolean(v));

  if (names.length === 0) return "[attachment]";
  return `[attachments: ${names.join(", ")}]`;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidItem(item: BufferItem) {
  return (
    typeof item.channel_id === "string" &&
    typeof item.role === "string" &&
    typeof item.author_id === "string" &&
    typeof item.author_name === "string" &&
    typeof item.content === "string" &&
    typeof item.message_id === "string" &&
    typeof item.timestamp === "string"
  );
}

function takeFromEnd<T>(list: T[], limit: number) {
  if (list.length <= limit) return [...list];
  return list.slice(list.length - limit);
}

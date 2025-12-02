import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type APIGatewayBotInfo,
  GatewayDispatchEvents,
  type GatewayIdentifyData,
  GatewayIntentBits,
  type GatewayMessageCreateDispatchData,
  GatewayOpcodes,
  type GatewayReadyDispatchData,
  type GatewayReceivePayload,
  type GatewayResumeData,
  type GatewaySendPayload,
} from "discord-api-types/v10";
import WebSocket from "ws";

type IntentsBitfield = number;

export interface GatewayOptions {
  token: string;
  intents: IntentsBitfield;
  shardId?: number;
  shardCount?: number;
  identifyProperties?: GatewayIdentifyData["properties"];
  forwardMessage?: (message: GatewayMessageCreateDispatchData) => void | Promise<void>;
}

type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting";

const GATEWAY_VERSION = 10;
const DEFAULT_PROPERTIES: GatewayIdentifyData["properties"] = {
  os: process.platform,
  browser: "sturm-discord-gateway",
  device: "sturm-discord-gateway",
};

export class DiscordGatewayClient {
  private readonly token: string;
  private readonly intents: IntentsBitfield;
  private readonly shardId: number;
  private readonly shardCount: number;
  private readonly identifyProperties: GatewayIdentifyData["properties"];
  private readonly forwardMessage?: GatewayOptions["forwardMessage"];

  private ws?: WebSocket;
  private state: ConnectionState = "idle";
  private gatewayUrl?: string;
  private sessionId?: string;
  private lastSequence: number | null = null;
  private heartbeatInterval?: NodeJS.Timeout;
  private heartbeatAckPending = false;
  private lastHeartbeatAt = 0;
  private reconnectAttempts = 0;
  private botUserId?: string;

  constructor(options: GatewayOptions) {
    this.token = options.token;
    this.intents = options.intents;
    this.shardId = options.shardId ?? 0;
    this.shardCount = options.shardCount ?? 1;
    this.identifyProperties = options.identifyProperties ?? DEFAULT_PROPERTIES;
    this.forwardMessage = options.forwardMessage;
  }

  async start() {
    this.state = "connecting";
    await this.connectAndListen();
  }

  async stop() {
    this.state = "idle";
    this.clearHeartbeat();
    this.ws?.close(1000, "shutdown");
  }

  private async connectAndListen() {
    this.gatewayUrl ??= await this.fetchGatewayUrl();
    const url = `${this.gatewayUrl}?v=${GATEWAY_VERSION}&encoding=json`;

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.state = "connected";
      console.info("[gateway] websocket connected");
    });

    this.ws.on("message", (raw) => {
      this.handleMessage(raw.toString()).catch((error) => {
        console.error("[gateway] error handling payload", error);
      });
    });

    this.ws.on("close", (code, reason) => {
      console.warn(`[gateway] websocket closed code=${code} reason=${reason.toString() || "none"}`);
      this.clearHeartbeat();
      if (this.state === "idle") return; // intentional stop
      this.state = "reconnecting";
      this.scheduleReconnect(code).catch((error) => {
        console.error("[gateway] reconnect failed", error);
      });
    });

    this.ws.on("error", (error) => {
      console.error("[gateway] websocket error", error);
    });
  }

  private async handleMessage(message: string) {
    const payload: GatewayReceivePayload = JSON.parse(message);
    this.lastSequence = payload.s ?? this.lastSequence;

    switch (payload.op) {
      case GatewayOpcodes.Dispatch:
        await this.handleDispatch(payload);
        break;
      case GatewayOpcodes.Heartbeat:
        this.sendHeartbeat();
        break;
      case GatewayOpcodes.Reconnect:
        console.info("[gateway] received RECONNECT opcode");
        this.reconnectNow();
        break;
      case GatewayOpcodes.InvalidSession:
        this.sessionId =
          payload.d && typeof payload.d === "boolean" && payload.d ? this.sessionId : undefined;
        this.lastSequence = null;
        console.warn("[gateway] INVALID_SESSION; attempting identify after backoff");
        await sleep(this.jitter(1000, 5000));
        this.identify();
        break;
      case GatewayOpcodes.Hello:
        this.onHello(payload);
        break;
      case GatewayOpcodes.HeartbeatAck:
        this.onHeartbeatAck();
        break;
      default:
        console.debug("[gateway] unhandled opcode");
    }
  }

  private async handleDispatch(payload: GatewayReceivePayload) {
    if (payload.op !== GatewayOpcodes.Dispatch || !payload.t) return;

    if (payload.t === GatewayDispatchEvents.Ready) {
      const data = payload.d as GatewayReadyDispatchData;
      this.sessionId = data.session_id;
      this.botUserId = data.user.id;
      console.info(`[gateway] READY session=${this.sessionId}`);
      return;
    }

    if (payload.t === GatewayDispatchEvents.MessageCreate) {
      const data = payload.d as GatewayMessageCreateDispatchData;

      // ignore DMs and self messages
      if (!data.guild_id) return;
      if (this.botUserId && data.author?.id === this.botUserId) return;

      console.info(
        `[gateway] MESSAGE_CREATE guild=${data.guild_id} channel=${data.channel_id} author=${data.author?.id} content=${JSON.stringify(
          data.content,
        )}`,
      );

      if (this.forwardMessage) {
        await this.forwardMessage(data);
      }
      return;
    }
  }

  private onHello(payload: GatewayReceivePayload) {
    if (payload.op !== GatewayOpcodes.Hello || !payload.d || typeof payload.d !== "object") return;
    const heartbeatInterval =
      "heartbeat_interval" in payload.d && typeof payload.d.heartbeat_interval === "number"
        ? payload.d.heartbeat_interval
        : undefined;
    if (heartbeatInterval === undefined) {
      console.error("[gateway] HELLO missing heartbeat interval");
      return;
    }
    this.startHeartbeat(heartbeatInterval);

    if (this.sessionId && this.lastSequence !== null) {
      this.resume();
      return;
    }
    this.identify();
  }

  private identify() {
    const payload: GatewaySendPayload = {
      op: GatewayOpcodes.Identify,
      d: {
        token: this.token,
        intents: this.intents,
        properties: this.identifyProperties,
        shard: [this.shardId, this.shardCount],
      },
    };
    this.send(payload);
    console.info("[gateway] sent IDENTIFY");
  }

  private resume() {
    if (this.sessionId === undefined || this.lastSequence === null) {
      this.identify();
      return;
    }

    const payload: GatewaySendPayload = {
      op: GatewayOpcodes.Resume,
      d: {
        token: this.token,
        session_id: this.sessionId,
        seq: this.lastSequence,
      } satisfies GatewayResumeData,
    };
    this.send(payload);
    console.info("[gateway] sent RESUME");
  }

  private startHeartbeat(intervalMs: number) {
    this.clearHeartbeat();
    this.heartbeatAckPending = false;
    this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), intervalMs);
    // send an immediate heartbeat to prime ack tracking
    this.sendHeartbeat();
    console.info(`[gateway] heartbeat every ${intervalMs}ms`);
  }

  private clearHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  private sendHeartbeat() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.heartbeatAckPending) {
      console.warn("[gateway] missed HEARTBEAT_ACK; forcing reconnect");
      this.reconnectNow();
      return;
    }

    this.send({ op: GatewayOpcodes.Heartbeat, d: this.lastSequence ?? null });
    this.heartbeatAckPending = true;
    this.lastHeartbeatAt = Date.now();
  }

  private onHeartbeatAck() {
    this.heartbeatAckPending = false;
    const rtt = Date.now() - this.lastHeartbeatAt;
    console.debug(`[gateway] HEARTBEAT_ACK rtt=${rtt}ms`);
  }

  private send(payload: GatewaySendPayload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  private reconnectNow() {
    if (!this.ws) return;
    this.ws.removeAllListeners();
    this.clearHeartbeat();
    this.ws.close(1012, "reconnect");
  }

  private async scheduleReconnect(closeCode: number) {
    if (!this.shouldReconnect(closeCode)) {
      console.error(`[gateway] not reconnecting; close code ${closeCode} is fatal`);
      return;
    }

    this.reconnectAttempts += 1;
    const delay = this.backoff(this.reconnectAttempts);
    console.info(`[gateway] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    await sleep(delay);
    await this.connectAndListen();
  }

  private shouldReconnect(code: number) {
    // fatal codes per Discord docs
    const fatal = [4004, 4010, 4011, 4012, 4013, 4014];
    return !fatal.includes(code);
  }

  private backoff(attempt: number) {
    const base = 1000 * Math.min(attempt, 6); // cap growth
    return this.jitter(base, base + 4000);
  }

  private jitter(min: number, max: number) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private async fetchGatewayUrl() {
    const res = await fetch("https://discord.com/api/v10/gateway/bot", {
      headers: { Authorization: `Bot ${this.token}` },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to fetch gateway URL: ${res.status} ${res.statusText} ${body}`);
    }
    const data = (await res.json()) as APIGatewayBotInfo;
    console.info(`[gateway] shard suggestion ${data.shards}`);
    return data.url;
  }
}

export const REQUIRED_INTENTS: IntentsBitfield =
  GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent;

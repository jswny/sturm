import process from "node:process";
import { config as loadEnv } from "dotenv";
import { DiscordGatewayClient, REQUIRED_INTENTS } from "./gateway.js";

const shutdownSignals = ["SIGINT", "SIGTERM"] as const;

// Load env from current working directory (.env).
loadEnv();

function handleFatal(error: unknown) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : `${error}`;
  console.error(`[discord-gateway] fatal error -> ${message}`);
  process.exitCode = 1;
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

async function waitForShutdown() {
  await new Promise<void>((resolve) => {
    shutdownSignals.forEach((signal) => {
      process.once(signal, () => {
        console.info(`[discord-gateway] received ${signal}, shutting down`);
        resolve();
      });
    });
  });
}

async function main() {
  console.info("[discord-gateway] starting up");

  const token = requireEnv("DISCORD_TOKEN");
  const shardId = process.env.SHARD_ID ? Number(process.env.SHARD_ID) : undefined;
  const shardCount = process.env.SHARD_COUNT ? Number(process.env.SHARD_COUNT) : undefined;

  const client = new DiscordGatewayClient({
    token,
    intents: REQUIRED_INTENTS,
    shardId,
    shardCount,
  });

  await client.start();
  await waitForShutdown();
  await client.stop();

  console.info("[discord-gateway] exited cleanly");
}

process.on("unhandledRejection", handleFatal);
process.on("uncaughtException", handleFatal);

main().catch(handleFatal);

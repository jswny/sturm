import "dotenv/config";
import process from "node:process";

const shutdownSignals = ["SIGINT", "SIGTERM"] as const;

function handleFatal(error: unknown) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : `${error}`;
  console.error(`[discord-gateway] fatal error -> ${message}`);
  process.exitCode = 1;
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

  await waitForShutdown();

  console.info("[discord-gateway] exited cleanly");
}

process.on("unhandledRejection", handleFatal);
process.on("uncaughtException", handleFatal);

main().catch(handleFatal);

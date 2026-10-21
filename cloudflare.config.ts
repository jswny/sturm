import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/server.ts" with { type: "cf-worker" };

export default defineConfig(({ mode }) => {
  const workerDefinition = {
    name: "sturm",
    compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    exports: {
      ChatAgent: exports.durableObject({ storage: "sqlite" }),
      GuildMemoryObject: exports.durableObject({ storage: "sqlite" }),
      GuildMemoryObserverAgent: exports.durableObject({ storage: "sqlite" }),
      DiscordRestDispatcher: exports.durableObject({ storage: "sqlite" })
    }
  };

  return {
    worker: {
      ...workerDefinition,
      workersDev: false,
      previewUrls: false,
      domains: ["sturm.j1.io"],
      observability: {
        enabled: true,
        logs: {
          enabled: true,
          invocationLogs: true
        },
        traces: {
          enabled: true
        }
      },
      env: {
        ...(mode === "development"
          ? { STURM_DEBUG_ENABLED: bindings.text("true") }
          : {}),
        DISCORD_APPLICATION_ID: bindings.secret(),
        DISCORD_PUBLIC_KEY: bindings.secret(),
        DISCORD_TOKEN: bindings.secret(),
        KAGI_API_KEY: bindings.secret(),
        ARTIFACTS_BUCKET: bindings.r2({
          name: "sturm-artifacts"
        }),
        ChatAgent: bindings.durableObject<typeof workerDefinition, "ChatAgent">(
          {
            worker: workerDefinition,
            exportName: "ChatAgent"
          }
        ),
        GuildMemory: bindings.durableObject<
          typeof workerDefinition,
          "GuildMemoryObject"
        >({
          worker: workerDefinition,
          exportName: "GuildMemoryObject"
        }),
        GuildMemoryObserver: bindings.durableObject<
          typeof workerDefinition,
          "GuildMemoryObserverAgent"
        >({
          worker: workerDefinition,
          exportName: "GuildMemoryObserverAgent"
        }),
        DiscordRest: bindings.durableObject<
          typeof workerDefinition,
          "DiscordRestDispatcher"
        >({
          worker: workerDefinition,
          exportName: "DiscordRestDispatcher"
        }),
        AI: bindings.ai({
          dev: {
            remote: true
          }
        }),
        BROWSER: bindings.browser({
          dev: {
            remote: true
          }
        }),
        IMAGES: bindings.images({
          dev: {
            remote: true
          }
        }),
        LOADER: bindings.workerLoader()
      }
    }
  };
});

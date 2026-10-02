import { bindings, defineConfig, exports } from "cf/config";

/**
 * Secret-like files were detected but not read or migrated: .dev.vars.example. Only `secrets.required` entries are migrated.
 * @see https://developers.cloudflare.com/workers/configuration/secrets/
 */

export default defineConfig(({ mode }) => ({
  worker: {
    name: "sturm",
    compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/server.ts",
    exports: {
      ChatAgent: exports.durableObject({ storage: "sqlite" }),
      GuildMemoryObject: exports.durableObject({ storage: "sqlite" }),
      GuildMemoryObserverAgent: exports.durableObject({ storage: "sqlite" }),
      DiscordRestDispatcher: exports.durableObject({ storage: "sqlite" })
    },
    workersDev: false,
    previewUrls: false,
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
    domains: ["sturm.j1.io"],
    env: {
      ...(mode === "development"
        ? { STURM_DEBUG_ENABLED: bindings.text("true") }
        : {}),
      ARTIFACTS_BUCKET: bindings.r2({
        name: "sturm-artifacts"
      }),
      ChatAgent: bindings.durableObject({
        worker: "sturm",
        exportName: "ChatAgent"
      }),
      GuildMemory: bindings.durableObject({
        worker: "sturm",
        exportName: "GuildMemoryObject"
      }),
      GuildMemoryObserver: bindings.durableObject({
        worker: "sturm",
        exportName: "GuildMemoryObserverAgent"
      }),
      DiscordRest: bindings.durableObject({
        worker: "sturm",
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
}));

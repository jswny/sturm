import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const runDebugAiIntegration =
  process.env.STURM_RUN_DEBUG_AI_INTEGRATION === "true";
const runPromptReplay = process.env.STURM_RUN_PROMPT_REPLAY === "true";

export default defineConfig({
  resolve: {
    alias: {
      // The Workers test evaluator does not see discord-api-types CJS enum
      // re-exports reliably. Production builds keep normal package resolution.
      "discord-api-types/v10": fileURLToPath(
        new URL("./tests/shims/discord-api-types-v10.ts", import.meta.url)
      )
    }
  },
  plugins: [
    cloudflareTest({
      remoteBindings: true,
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          STURM_DEBUG_ENABLED: "true"
        }
      }
    })
  ],
  test: {
    exclude: [
      ...configDefaults.exclude,
      ...(runDebugAiIntegration ? [] : ["tests/debug-ai.integration.test.ts"]),
      ...(runPromptReplay ? [] : ["tests/prompt-replay.benchmark.test.ts"])
    ],
    include: ["tests/**/*.test.ts"],
    testTimeout: 240_000
  }
});

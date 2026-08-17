import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const runDebugAiIntegration =
  process.env.STURM_RUN_DEBUG_AI_INTEGRATION === "true";
const runPromptReplay = process.env.STURM_RUN_PROMPT_REPLAY === "true";
const optInTestFiles = [
  ...(runDebugAiIntegration ? ["tests/debug-ai.integration.test.ts"] : []),
  ...(runPromptReplay ? ["tests/prompt-replay.benchmark.test.ts"] : [])
];
const useRemoteBindings = optInTestFiles.length > 0;

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
      remoteBindings: useRemoteBindings,
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          STURM_DEBUG_ENABLED: "true"
        }
      }
    })
  ],
  test: {
    // Each opt-in suite is normally its own one-file run. If both are explicitly
    // enabled together, serialize their remote-binding runtimes during teardown.
    fileParallelism: optInTestFiles.length <= 1,
    exclude: [
      ...configDefaults.exclude,
      ...(useRemoteBindings
        ? []
        : [
            "tests/debug-ai.integration.test.ts",
            "tests/prompt-replay.benchmark.test.ts"
          ])
    ],
    include: useRemoteBindings ? optInTestFiles : ["tests/**/*.test.ts"],
    testTimeout: 240_000
  }
});

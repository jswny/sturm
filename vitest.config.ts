import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

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
    include: ["tests/**/*.test.ts"],
    testTimeout: 240_000
  }
});

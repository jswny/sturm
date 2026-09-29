import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  plugins: [
    cloudflare({
      config:
        command === "serve"
          ? { vars: { STURM_DEBUG_ENABLED: "true" } }
          : undefined
    })
  ],
  build: { sourcemap: true },
  server: { port: 8787, strictPort: true }
}));

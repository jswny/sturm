import { createBrowserTools } from "@cloudflare/think/tools/browser";

export type BrowserEnv = {
  BROWSER: Fetcher;
  LOADER: WorkerLoader;
};

const BROWSER_TOOL_TIMEOUT_MS = 30_000;

export function createRenderedPageTools(env: BrowserEnv) {
  return createBrowserTools({
    browser: env.BROWSER,
    loader: env.LOADER,
    timeout: BROWSER_TOOL_TIMEOUT_MS
  });
}

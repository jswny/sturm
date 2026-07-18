import { createBrowserRuntime } from "@cloudflare/think/tools/browser";
import type { BrowserBinding } from "agents/browser";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { BROWSER_EXECUTION_TIMEOUT_MS } from "../model";

export type BrowserToolEnv = {
  BROWSER: BrowserBinding;
  LOADER: WorkerLoader;
};

const BROWSER_CONNECTOR_HINT = [
  "Chrome DevTools Protocol browser automation.",
  'Use one object argument for connector calls: cdp.send({ method: "Target.createTarget", params: { url } }), cdp.attachToTarget({ targetId }), then cdp.send({ method: "Page.navigate", params: { url }, sessionId }).',
  'Do not use positional calls like cdp.send("Page.navigate", params), and do not stringify the cdp connector.'
].join(" ");

const BROWSER_EXECUTE_DESCRIPTION = [
  "Run an async JavaScript arrow function in a sandbox with access to a live browser through the cdp connector.",
  "Use this only when a task needs rendered page state, browser interaction, screenshots, or CDP inspection.",
  "Return the small result needed for the final answer.",
  "Available globals are cdp, codemode, and standard JavaScript. Do not use imports, require, process, Node.js APIs, or TypeScript-only syntax such as type annotations, interfaces, or generics.",
  BROWSER_CONNECTOR_HINT
].join("\n");

const browserExecuteInputSchema = z.object({
  code: z
    .string()
    .describe(
      "Async JavaScript arrow function that uses the cdp connector and returns the browser inspection result."
    )
});

export function createBrowserAutomationTools(
  env: BrowserToolEnv,
  ctx: DurableObjectState
): ToolSet {
  return {
    browser_execute: tool({
      description: BROWSER_EXECUTE_DESCRIPTION,
      inputSchema: browserExecuteInputSchema,
      execute: async (input, options) => {
        // Keep browser automation as the only code-execution-style tool, but
        // create the Code Mode runtime lazily so normal turns do not initialize
        // Browser Run or Worker Loader plumbing when the tool is unused.
        const { runtime } = createBrowserRuntime({
          ctx,
          browser: env.BROWSER,
          loader: env.LOADER,
          session: { mode: "dynamic" },
          timeout: BROWSER_EXECUTION_TIMEOUT_MS
        });
        const browserExecute = runtime.tool({
          connectorHints: { cdp: BROWSER_CONNECTOR_HINT }
        });
        if (!browserExecute.execute) {
          throw new Error("browser_execute tool is not executable.");
        }
        return browserExecute.execute(input, options);
      }
    })
  };
}

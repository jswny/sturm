import { createExecuteTool } from "@cloudflare/think/tools/execute";
import {
  createWorkspaceStateBackend,
  type WorkspaceFsLike
} from "@cloudflare/shell";
import type { ToolSet } from "ai";

export type CodeModeEnv = {
  BROWSER: Fetcher;
  LOADER: WorkerLoader;
};

const CODEMODE_TIMEOUT_MS = 30_000;

export function createDiscordCodeModeTool(
  env: CodeModeEnv,
  tools: ToolSet,
  workspace: WorkspaceFsLike,
  ctx: DurableObjectState
) {
  const codeModeTool = createExecuteTool({
    ctx,
    tools,
    state: createWorkspaceStateBackend(workspace),
    browser: env.BROWSER,
    loader: env.LOADER,
    timeout: CODEMODE_TIMEOUT_MS,
    globalOutbound: null
  });
  const execute = codeModeTool.execute;
  if (!execute) return codeModeTool;

  return {
    ...codeModeTool,
    execute: async (...args: Parameters<typeof execute>) => {
      const output = await execute(...args);
      return {
        ...output,
        code_executed_at_utc: new Date().toISOString()
      };
    }
  };
}

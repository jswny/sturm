import {
  createExecuteRuntime,
  type ExecuteRuntime
} from "@cloudflare/think/tools/execute";
import {
  createWorkspaceStateBackend,
  type WorkspaceFsLike
} from "@cloudflare/shell";
import type { BrowserBinding } from "agents/browser";
import type { ToolSet } from "ai";

export type CodeModeEnv = {
  BROWSER: BrowserBinding;
  LOADER: WorkerLoader;
};

const CODEMODE_TIMEOUT_MS = 30_000;

export type DiscordCodeModeRuntime = {
  tool: ExecuteRuntime["tool"];
  runtime: ExecuteRuntime["runtime"];
};

export function createDiscordCodeModeRuntime(
  env: CodeModeEnv,
  tools: ToolSet,
  workspace: WorkspaceFsLike,
  ctx: DurableObjectState
) {
  const codeModeRuntime = createExecuteRuntime({
    ctx,
    tools,
    state: createWorkspaceStateBackend(workspace),
    browser: env.BROWSER,
    loader: env.LOADER,
    timeout: CODEMODE_TIMEOUT_MS,
    globalOutbound: null
  });
  return {
    ...codeModeRuntime,
    tool: addCodeModeExecutionTimestamp(codeModeRuntime.tool)
  };
}

export function createDiscordCodeModeTool(
  env: CodeModeEnv,
  tools: ToolSet,
  workspace: WorkspaceFsLike,
  ctx: DurableObjectState
) {
  return createDiscordCodeModeRuntime(env, tools, workspace, ctx).tool;
}

function addCodeModeExecutionTimestamp(tool: ExecuteRuntime["tool"]) {
  const execute = tool.execute;
  if (!execute) return tool;

  return {
    ...tool,
    execute: async (...args: Parameters<typeof execute>) => {
      const output = await execute(...args);
      return {
        ...output,
        code_executed_at_utc: new Date().toISOString()
      };
    }
  };
}

import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";
import type { ToolSet } from "ai";

export type CodeModeEnv = {
  LOADER: WorkerLoader;
};

const CODEMODE_TIMEOUT_MS = 30_000;

const CODEMODE_DESCRIPTION = `Write JavaScript code to call Sturm tools when a response needs tool-backed information or actions.
Use this for external work such as web search, URL summarization, archiving, image generation, Discord nickname changes, guild memory updates, or any workflow that needs multiple tool calls, conditionals, loops, retries, or result composition.
The code must be an async arrow function. Call available tools through the codemode namespace, await every tool call, and return a concise result object or string for the assistant to explain.
Do not attempt direct network access; use the provided tools.

Available tool API:
{{types}}`;

export function createDiscordCodeModeTool(env: CodeModeEnv, tools: ToolSet) {
  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    timeout: CODEMODE_TIMEOUT_MS,
    globalOutbound: null
  });

  return createCodeTool({
    tools,
    executor,
    description: CODEMODE_DESCRIPTION
  });
}

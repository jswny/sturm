import { createExecuteTool } from "@cloudflare/think/tools/execute";
import {
  createWorkspaceStateBackend,
  type WorkspaceFsLike
} from "@cloudflare/shell";
import type { ToolSet } from "ai";

export type CodeModeEnv = {
  LOADER: WorkerLoader;
};

const CODEMODE_TIMEOUT_MS = 30_000;

const CODEMODE_DESCRIPTION = `Write JavaScript code to call Sturm tools when a response needs tool-backed information or actions.
Use this for external work such as web search, rendered page inspection, URL summarization, archiving, image generation, Discord member lookup, Discord nickname changes, guild memory updates, or any workflow that needs multiple tool calls, conditionals, loops, retries, or result composition.
Choose tools by what evidence they can observe: use web search for broad discovery and research, URL summarization for a known URL's text/content, and rendered page inspection for the live rendered DOM, page state, screenshots, browser-visible content, console/network behavior, or other browser-only evidence.
Use the persistent channel workspace through state.* when work benefits from a virtual filesystem. Do not use state.* as a memory system. Use guild_memory as the only long-term memory mechanism, and only for concise cross-channel facts. Inspect existing files before overwriting or deleting them. Users cannot browse workspace paths directly, so return or summarize any file content the user needs to see, and use exportWorkspaceFile when a workspace file should be sent as an attachment.
The code must be an async arrow function. Call available tools through the codemode namespace, await every tool call, and return a concise result object or string for the assistant to explain.
For rendered page workflows, keep every action that depends on the same page state inside one browser_execute call; each browser_execute call starts a fresh browser session.
Do not attempt direct network access; use the provided tools.

Available tool API:
{{types}}`;

export function createDiscordCodeModeTool(
  env: CodeModeEnv,
  tools: ToolSet,
  workspace: WorkspaceFsLike
) {
  return createExecuteTool({
    tools,
    state: createWorkspaceStateBackend(workspace),
    loader: env.LOADER,
    timeout: CODEMODE_TIMEOUT_MS,
    globalOutbound: null,
    description: CODEMODE_DESCRIPTION
  });
}

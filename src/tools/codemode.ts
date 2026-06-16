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

const CODEMODE_DESCRIPTION = `Write JavaScript code to call Sturm tools when a response needs tool-backed information or actions.
Use this for external work such as web search, rendered page inspection, URL summarization, archiving, image generation, Discord current-channel message search, Discord member lookup, Discord nickname changes, Discord emoji or sticker creation from attachments, Discord temporary mutes and unmutes, scheduled channel task creation/replacement/cancellation, Discord user confirmation/selection prompts, or any workflow that needs multiple tool calls, conditionals, loops, retries, or result composition.
Choose tools by what evidence they can observe: use web search for broad discovery and research, URL summarization for a known URL's text/content, and rendered page inspection for the live rendered DOM, page state, screenshots, browser-visible content, console/network behavior, or other browser-only evidence.
Use the persistent channel workspace through state.* when work benefits from a virtual filesystem. Do not use state.* as a memory system; persistent guild memory is maintained outside Code Mode. Inspect existing files before overwriting or deleting them. Users cannot browse workspace paths directly, so return or summarize any file content the user needs to see, and use exportWorkspaceFile when a workspace file should be sent as an attachment.
The code must be an async arrow function. Code Mode is the only exposed top-level tool; every API listed below is available only inside that Code Mode function. Call chat tools through the tools namespace, workspace APIs through the state namespace, and browser/CDP APIs through the cdp namespace. Await every tool call and return a concise result object or string for the assistant to explain.
Use this pattern for rendered page work:
const { targetId } = await cdp.send({
  method: "Target.createTarget",
  params: { url: "https://example.com" }
});
const { sessionId } = await cdp.attachToTarget({ targetId });
const result = await cdp.send({
  method: "Runtime.evaluate",
  params: {
    expression: "document.body.innerText",
    returnByValue: true
  },
  sessionId
});
await cdp.send({
  method: "Target.closeTarget",
  params: { targetId }
});
return result.result.value;
Use cdp.spec when you need to look up Chrome DevTools Protocol command shapes.
Do not attempt direct network access; use the provided tools.

Available tool API:
{{types}}`;

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
    globalOutbound: null,
    description: CODEMODE_DESCRIPTION
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

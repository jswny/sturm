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
Use this for external work such as web search, rendered page inspection, URL summarization, archiving, image generation, Discord current-channel message search, Discord member lookup, Discord nickname changes, Discord emoji or sticker creation from attachments, Discord temporary mutes and unmutes, scheduled channel tasks, or any workflow that needs multiple tool calls, conditionals, loops, retries, or result composition.
Choose tools by what evidence they can observe: use web search for broad discovery and research, URL summarization for a known URL's text/content, and rendered page inspection for the live rendered DOM, page state, screenshots, browser-visible content, console/network behavior, or other browser-only evidence.
Use the persistent channel workspace through state.* when work benefits from a virtual filesystem. Do not use state.* as a memory system; persistent guild memory is maintained outside Code Mode. Inspect existing files before overwriting or deleting them. Users cannot browse workspace paths directly, so return or summarize any file content the user needs to see, and use exportWorkspaceFile when a workspace file should be sent as an attachment.
The code must be an async arrow function. Call available tools through the codemode namespace, await every tool call, and return a concise result object or string for the assistant to explain.
Browser tools are nested code tools. In the outer Code Mode function, never call cdp or spec directly because they do not exist there. Define an inner async arrow function, pass inner.toString() to the browser tool, and do not invoke the inner function in the outer Code Mode function.
Use this pattern for rendered page work:
const browserCode = async () => {
  const { targetId } = await cdp.send("Target.createTarget", {
    url: "https://example.com"
  });
  const sessionId = await cdp.attachToTarget(targetId);
  const result = await cdp.send("Runtime.evaluate", {
    expression: "document.body.innerText",
    returnByValue: true
  }, { sessionId });
  await cdp.send("Target.closeTarget", { targetId });
  return result.result.value;
};
const html = await codemode.browser_execute({ code: browserCode.toString() });
Use the same inner.toString() pattern with codemode.browser_search; spec is only available inside that inner function.
For rendered page workflows, keep every action that depends on the same page state inside one browser_execute call; each browser_execute call starts a fresh browser session.
Do not attempt direct network access; use the provided tools.

Available tool API:
{{types}}`;

export function createDiscordCodeModeTool(
  env: CodeModeEnv,
  tools: ToolSet,
  workspace: WorkspaceFsLike
) {
  const codeModeTool = createExecuteTool({
    tools,
    state: createWorkspaceStateBackend(workspace),
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

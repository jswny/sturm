import type { ToolExecutionOptions, ToolSet } from "ai";
import { editOriginalInteractionResponse } from "./api";
import type {
  DiscordResponseTarget,
  DiscordWebhookResponseTarget
} from "./types";
import { logWarn } from "../logging";

const DISCORD_PROGRESS_INITIAL_SETTLE_MS = 500;
const DISCORD_PROGRESS_MIN_EDIT_INTERVAL_MS = 1_500;
const DISCORD_PROGRESS_MAX_LINES = 7;

export type DiscordProgressEvent =
  | {
      type: "phase";
      label: string;
    }
  | {
      type: "tool";
      label: string;
      status: "started" | "finished" | "failed";
    };

export type DiscordProgressReporter = {
  report(event: DiscordProgressEvent): Promise<void>;
};

type DiscordProgressOptions = {
  createdAt: string;
  correlationId: string;
  sequence: number;
};

export function createDiscordProgressReporter(
  target: DiscordResponseTarget,
  options: DiscordProgressOptions
): DiscordProgressReporter | undefined {
  if (target.type !== "discord") return undefined;
  return new DiscordInteractionProgressReporter(target, options);
}

export function withProgressTools(
  tools: ToolSet,
  reporter: DiscordProgressReporter | undefined
): ToolSet {
  if (!reporter) return tools;

  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => {
      const execute = definition.execute;
      if (typeof execute !== "function") return [name, definition];

      return [
        name,
        {
          ...definition,
          execute: async (input: unknown, options?: ToolExecutionOptions) => {
            const label = getToolProgressLabel(name);
            await reporter.report({ type: "tool", label, status: "started" });

            try {
              const output = await execute(
                input,
                options as ToolExecutionOptions
              );
              await reporter.report({
                type: "tool",
                label,
                status: isToolFailureOutput(output) ? "failed" : "finished"
              });
              return output;
            } catch (error) {
              await reporter.report({ type: "tool", label, status: "failed" });
              throw error;
            }
          }
        }
      ];
    })
  ) as ToolSet;
}

// Expected operational failures are often returned to the model as data.
function isToolFailureOutput(output: unknown) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false;
  }

  const result = output as Record<string, unknown>;
  return (
    result.ok === false ||
    result.success === false ||
    (typeof result.error === "string" && result.error.trim().length > 0)
  );
}

class DiscordInteractionProgressReporter implements DiscordProgressReporter {
  private readonly startedAt = Date.now();
  private lastEditAt = 0;
  private lines: string[] = [];

  constructor(
    private readonly target: DiscordWebhookResponseTarget,
    private readonly options: DiscordProgressOptions
  ) {}

  async report(event: DiscordProgressEvent) {
    const line = renderProgressEvent(event);
    if (!line) return;

    this.appendLine(line);
    if (!this.shouldEditNow()) return;

    await this.waitUntilDeferredResponseSettled();
    try {
      await editOriginalInteractionResponse(this.target, this.render());
      this.lastEditAt = Date.now();
    } catch (error) {
      logWarn("Discord progress response edit failed", {
        sequence: this.options.sequence,
        correlationId: this.options.correlationId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private appendLine(line: string) {
    if (this.lines.at(-1) === line) return;
    this.lines.push(line);
    this.lines = this.lines.slice(-DISCORD_PROGRESS_MAX_LINES);
  }

  private shouldEditNow() {
    if (this.lastEditAt === 0) return true;
    return (
      Date.now() - this.lastEditAt >= DISCORD_PROGRESS_MIN_EDIT_INTERVAL_MS
    );
  }

  private async waitUntilDeferredResponseSettled() {
    const createdAtMs = Date.parse(this.options.createdAt);
    const baseTime = Number.isFinite(createdAtMs)
      ? createdAtMs
      : this.startedAt;
    const waitMs = DISCORD_PROGRESS_INITIAL_SETTLE_MS - (Date.now() - baseTime);
    if (waitMs > 0) await sleep(waitMs);
  }

  private render() {
    return ["Thinking...", ...this.lines.map((line) => `- ${line}`)].join("\n");
  }
}

function renderProgressEvent(event: DiscordProgressEvent) {
  if (event.type === "phase") return event.label;

  if (event.status === "started") return `Using ${event.label}`;
  if (event.status === "finished") return `Finished ${event.label}`;
  return `${capitalize(event.label)} failed`;
}

function getToolProgressLabel(toolName: string) {
  if (toolName === "browser_execute") return "browser";

  return toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

function capitalize(value: string) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

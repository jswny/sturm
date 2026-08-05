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
      toolCallId: string;
      toolName: string;
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

  let fallbackToolCallSequence = 0;

  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => {
      const execute = definition.execute;
      if (typeof execute !== "function") return [name, definition];

      return [
        name,
        {
          ...definition,
          execute: async (
            input: unknown,
            options?: ToolExecutionOptions<unknown>
          ) => {
            const toolCallId =
              options?.toolCallId ?? `${name}:${fallbackToolCallSequence++}`;
            await reporter.report({
              type: "tool",
              toolCallId,
              toolName: name,
              status: "started"
            });

            try {
              const output = await execute(
                input,
                options as ToolExecutionOptions<unknown>
              );
              await reporter.report({
                type: "tool",
                toolCallId,
                toolName: name,
                status: isToolFailureOutput(output) ? "failed" : "finished"
              });
              return output;
            } catch (error) {
              await reporter.report({
                type: "tool",
                toolCallId,
                toolName: name,
                status: "failed"
              });
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
  private lines: ProgressLine[] = [];

  constructor(
    private readonly target: DiscordWebhookResponseTarget,
    private readonly options: DiscordProgressOptions
  ) {}

  async report(event: DiscordProgressEvent) {
    const line = renderProgressEvent(event);
    if (!this.upsertLine(line)) return;
    if (!this.shouldEditNow(event)) return;

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

  private upsertLine(line: ProgressLine) {
    if (line.key) {
      const existingIndex = this.lines.findIndex(
        (candidate) => candidate.key === line.key
      );
      if (existingIndex >= 0) {
        if (this.lines[existingIndex].text === line.text) return false;
        this.lines[existingIndex] = line;
        return true;
      }
    } else if (this.lines.at(-1)?.text === line.text) {
      return false;
    }

    this.lines.push(line);
    this.lines = this.lines.slice(-DISCORD_PROGRESS_MAX_LINES);
    return true;
  }

  private shouldEditNow(event: DiscordProgressEvent) {
    // A fast failure must not remain hidden behind an earlier started update.
    if (event.type === "tool" && event.status === "failed") return true;
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
    return ["Thinking...", ...this.lines.map((line) => `- ${line.text}`)].join(
      "\n"
    );
  }
}

type ProgressLine = {
  key?: string;
  text: string;
};

type ToolProgressCopy = Record<
  Extract<DiscordProgressEvent, { type: "tool" }>["status"],
  string
>;

const TOOL_PROGRESS_COPY: Readonly<Record<string, ToolProgressCopy>> = {
  archiveUrl: {
    started: "Creating an archive link",
    finished: "Created an archive link",
    failed: "Archive link creation failed"
  },
  webSearch: {
    started: "Searching the web",
    finished: "Searched the web",
    failed: "Web search failed"
  },
  summarizeUrl: {
    started: "Reading the page",
    finished: "Read the page",
    failed: "Page reading failed"
  },
  searchDiscordMessages: {
    started: "Searching channel history",
    finished: "Searched channel history",
    failed: "Channel history search failed"
  },
  searchGuildMembers: {
    started: "Finding server members",
    finished: "Found server members",
    failed: "Server member search failed"
  },
  setNicknamePostfix: {
    started: "Updating a nickname",
    finished: "Updated a nickname",
    failed: "Nickname update failed"
  },
  clearNicknamePostfix: {
    started: "Updating a nickname",
    finished: "Updated a nickname",
    failed: "Nickname update failed"
  },
  muteGuildMember: {
    started: "Applying a member timeout",
    finished: "Applied a member timeout",
    failed: "Member timeout failed"
  },
  unmuteGuildMember: {
    started: "Removing a member timeout",
    finished: "Removed a member timeout",
    failed: "Member timeout removal failed"
  },
  createGuildEmojiFromArtifact: {
    started: "Creating an emoji",
    finished: "Created an emoji",
    failed: "Emoji creation failed"
  },
  createGuildStickerFromArtifact: {
    started: "Creating a sticker",
    finished: "Created a sticker",
    failed: "Sticker creation failed"
  },
  scheduleChannelTask: {
    started: "Scheduling a channel task",
    finished: "Scheduled a channel task",
    failed: "Channel task scheduling failed"
  },
  listScheduledChannelTasks: {
    started: "Reading scheduled tasks",
    finished: "Read scheduled tasks",
    failed: "Scheduled task lookup failed"
  },
  updateScheduledChannelTask: {
    started: "Updating a scheduled task",
    finished: "Updated a scheduled task",
    failed: "Scheduled task update failed"
  },
  cancelScheduledChannelTask: {
    started: "Cancelling a scheduled task",
    finished: "Cancelled a scheduled task",
    failed: "Scheduled task cancellation failed"
  },
  askUserToConfirm: {
    started: "Preparing a confirmation prompt",
    finished: "Prepared a confirmation prompt",
    failed: "Confirmation prompt setup failed"
  },
  askUserToSelect: {
    started: "Preparing a selection prompt",
    finished: "Prepared a selection prompt",
    failed: "Selection prompt setup failed"
  },
  generateImage: {
    started: "Generating an image",
    finished: "Generated an image",
    failed: "Image generation failed"
  },
  exportWorkspaceFile: {
    started: "Preparing a file attachment",
    finished: "Prepared a file attachment",
    failed: "File attachment preparation failed"
  },
  browser_execute: {
    started: "Using the browser",
    finished: "Finished using the browser",
    failed: "Browser task failed"
  }
};

const DEFAULT_TOOL_PROGRESS_COPY: ToolProgressCopy = {
  started: "Using a tool",
  finished: "Finished using a tool",
  failed: "Tool failed"
};

function renderProgressEvent(event: DiscordProgressEvent) {
  if (event.type === "phase") return { text: event.label };

  const copy = TOOL_PROGRESS_COPY[event.toolName] ?? DEFAULT_TOOL_PROGRESS_COPY;
  return {
    key: `tool:${event.toolCallId}`,
    text: copy[event.status]
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

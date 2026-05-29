import { tool } from "ai";
import { z } from "zod";
import type {
  CancelScheduledChannelTaskResult,
  ListScheduledChannelTasksResult,
  ScheduleChannelTaskResult,
  ScheduledTaskController
} from "../scheduled-tasks";

const scheduleResultSchema = z.object({
  ok: z.boolean(),
  scheduleId: z.string().optional(),
  taskId: z.string().optional(),
  type: z.string().optional(),
  nextRunAt: z.string().optional(),
  recurring: z.boolean().optional(),
  instruction: z.string().optional(),
  error: z.string().optional()
});

const scheduledTaskSummarySchema = z.object({
  scheduleId: z.string(),
  taskId: z.string().optional(),
  guildId: z.string().optional(),
  channelId: z.string().optional(),
  type: z.string(),
  nextRunAt: z.string(),
  recurring: z.boolean(),
  instruction: z.string().optional(),
  createdByUserId: z.string().optional(),
  createdAt: z.string().optional()
});

const listResultSchema = z.object({
  ok: z.boolean(),
  schedules: z.array(scheduledTaskSummarySchema).optional(),
  error: z.string().optional()
});

const cancelResultSchema = z.object({
  ok: z.boolean(),
  scheduleId: z.string(),
  cancelled: z.boolean().optional(),
  error: z.string().optional()
});

export function createScheduledTaskTools(
  controller: ScheduledTaskController | undefined
) {
  return {
    scheduleChannelTask: tool({
      description:
        "Schedule an instruction to run later in the current Discord channel or thread. The scheduled task will re-enter this same persistent channel session and post its result as a normal bot message. Use exact ISO 8601 timestamps with timezone for mode 'at'; ask a follow-up if the user's intended time or timezone is ambiguous.",
      inputSchema: z.object({
        instruction: z
          .string()
          .min(1)
          .describe(
            "The instruction Sturm should carry out when the task runs"
          ),
        mode: z
          .enum(["delay", "at", "cron", "interval"])
          .describe(
            "delay runs after delaySeconds, at runs at runAt, cron runs on a UTC cron expression, interval repeats every intervalSeconds"
          ),
        delaySeconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Required when mode is delay"),
        runAt: z
          .string()
          .optional()
          .describe(
            "Required when mode is at. ISO 8601 timestamp with timezone, for example 2026-05-26T18:30:00-04:00"
          ),
        cron: z
          .string()
          .optional()
          .describe(
            "Required when mode is cron. Five-field cron expression in UTC: minute hour day month weekday. Recurring tasks cannot run more than once per hour"
          ),
        intervalSeconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Required when mode is interval. Must be at least 3600 seconds"
          )
      }),
      outputSchema: scheduleResultSchema,
      execute: async (input) =>
        controller?.schedule(input) ??
        ({
          ok: false,
          error: "Scheduling is unavailable outside a Discord channel turn."
        } satisfies ScheduleChannelTaskResult),
      toModelOutput: ({ output }) => ({
        type: "text",
        value: formatScheduleResult(output)
      })
    }),
    listScheduledChannelTasks: tool({
      description:
        "List scheduled tasks for the current Discord channel or thread.",
      inputSchema: z.object({}),
      outputSchema: listResultSchema,
      execute: async () =>
        controller?.list() ??
        ({
          ok: false,
          error: "Scheduling is unavailable outside a Discord channel turn."
        } satisfies ListScheduledChannelTasksResult),
      toModelOutput: ({ output }) => ({
        type: "text",
        value: formatListResult(output)
      })
    }),
    cancelScheduledChannelTask: tool({
      description:
        "Cancel a scheduled task in the current Discord channel or thread by schedule ID. The caller can cancel tasks they created; callers with Manage Messages can cancel any channel task.",
      inputSchema: z.object({
        scheduleId: z.string().min(1).describe("Schedule ID to cancel")
      }),
      outputSchema: cancelResultSchema,
      execute: async ({ scheduleId }) =>
        controller?.cancel(scheduleId) ??
        ({
          ok: false,
          scheduleId,
          error: "Scheduling is unavailable outside a Discord channel turn."
        } satisfies CancelScheduledChannelTaskResult),
      toModelOutput: ({ output }) => ({
        type: "text",
        value: formatCancelResult(output)
      })
    })
  };
}

function formatScheduleResult(output: ScheduleChannelTaskResult) {
  if (!output.ok) return `Scheduled task creation failed: ${output.error}`;

  return [
    "Scheduled channel task created.",
    `schedule_id: ${output.scheduleId}`,
    `task_id: ${output.taskId}`,
    `type: ${output.type}`,
    `next_run_at: ${output.nextRunAt}`,
    `recurring: ${output.recurring ? "yes" : "no"}`,
    `instruction: ${output.instruction}`
  ].join("\n");
}

function formatListResult(output: ListScheduledChannelTasksResult) {
  if (!output.ok) return `Scheduled task listing failed: ${output.error}`;

  const schedules = output.schedules ?? [];
  if (schedules.length === 0) {
    return "No scheduled channel tasks found.";
  }

  return [
    `Scheduled channel tasks: ${schedules.length}`,
    ...schedules.map((schedule, index) =>
      [
        `${index + 1}. ${schedule.scheduleId}`,
        `   task_id: ${schedule.taskId}`,
        schedule.guildId ? `   guild_id: ${schedule.guildId}` : "",
        schedule.channelId ? `   channel_id: ${schedule.channelId}` : "",
        `   type: ${schedule.type}`,
        `   next_run_at: ${schedule.nextRunAt}`,
        `   recurring: ${schedule.recurring ? "yes" : "no"}`,
        schedule.createdByUserId
          ? `   created_by_user_id: ${schedule.createdByUserId}`
          : "",
        schedule.createdAt ? `   created_at: ${schedule.createdAt}` : "",
        schedule.instruction ? `   instruction: ${schedule.instruction}` : ""
      ]
        .filter(Boolean)
        .join("\n")
    )
  ].join("\n");
}

function formatCancelResult(output: CancelScheduledChannelTaskResult) {
  if (!output.ok) {
    return `Scheduled task cancellation failed for ${output.scheduleId}: ${output.error}`;
  }

  return output.cancelled
    ? `Scheduled channel task cancelled: ${output.scheduleId}`
    : `Scheduled channel task not found: ${output.scheduleId}`;
}

import { tool } from "ai";
import { z } from "zod";
import {
  MIN_RECURRING_SCHEDULE_SECONDS,
  type CancelScheduledChannelTaskResult,
  type ListScheduledChannelTasksResult,
  type UpdateScheduledChannelTaskResult,
  type ScheduleChannelTaskResult,
  type ScheduledTaskController
} from "../scheduled-tasks";

const MIN_DELAY_SECONDS = 1;

const DELAY_SECONDS_DESCRIPTION = `Required when mode is delay. Must be an integer number of seconds, at least ${MIN_DELAY_SECONDS}.`;
const INTERVAL_SECONDS_DESCRIPTION = `Required when mode is interval. Must be an integer number of seconds, at least ${MIN_RECURRING_SCHEDULE_SECONDS}.`;

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

const updateResultSchema = z.object({
  ok: z.boolean(),
  scheduleId: z.string(),
  updated: z.boolean().optional(),
  oldScheduleId: z.string().optional(),
  oldTaskId: z.string().optional(),
  oldScheduleCancelled: z.boolean().optional(),
  newScheduleId: z.string().optional(),
  newTaskId: z.string().optional(),
  newScheduleCancelled: z.boolean().optional(),
  type: z.string().optional(),
  nextRunAt: z.string().optional(),
  recurring: z.boolean().optional(),
  instruction: z.string().optional(),
  warning: z.string().optional(),
  error: z.string().optional()
});

type ScheduleTaskToolResult = z.infer<typeof scheduleResultSchema>;
type ListScheduledTasksToolResult = z.infer<typeof listResultSchema>;
type CancelScheduledTaskToolResult = z.infer<typeof cancelResultSchema>;
type UpdateScheduledTaskToolResult = z.infer<typeof updateResultSchema>;

export function createScheduledTaskTools(
  controller: ScheduledTaskController | undefined
) {
  return {
    scheduleChannelTask: tool({
      description:
        "Schedule an instruction to run later in the current Discord channel or thread. Creating a schedule is the acceptance step: call this tool only after deciding Sturm can complete the instruction as a normal immediate channel response. If Sturm would refuse the instruction now, refuse now instead of scheduling it. A scheduled task is treated as accepted when it later runs; execution should complete it unless current external state, permissions, or tool/API failures make completion impossible. The scheduled task will re-enter this same persistent channel session and post its result as a normal bot message. Use exact ISO 8601 timestamps with timezone for mode 'at'; ask a follow-up if the user's intended time or timezone is ambiguous. In the final response, use scheduleId as the user-facing handle when a handle is needed; taskId is internal and should be omitted unless the user explicitly asks for diagnostic details.",
      inputSchema: z.object({
        instruction: z
          .string()
          .min(1)
          .describe(
            "The instruction Sturm has accepted and should carry out when the task runs. Do not schedule instructions Sturm would refuse as an immediate channel response."
          ),
        mode: z
          .enum(["delay", "at", "cron", "interval"])
          .describe(
            "delay runs after delaySeconds, at runs at runAt, cron runs on a UTC cron expression, interval repeats every intervalSeconds"
          ),
        delaySeconds: z
          .number()
          .int()
          .min(MIN_DELAY_SECONDS)
          .optional()
          .describe(DELAY_SECONDS_DESCRIPTION),
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
          .min(MIN_RECURRING_SCHEDULE_SECONDS)
          .optional()
          .describe(INTERVAL_SECONDS_DESCRIPTION)
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
        value: formatScheduleTaskOutput(output)
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
        value: formatListScheduledTasksOutput(output)
      })
    }),
    updateScheduledChannelTask: tool({
      description:
        "Update an existing scheduled task in the current Discord channel or thread by schedule ID. Use this when a user asks to edit, update, reschedule, or change a scheduled task. Cloudflare schedules are not edited in place, so Sturm creates the revised schedule and then cancels the old schedule internally. The caller can update tasks they created; callers with Manage Messages can update any channel task. Updating preserves the original task creator and does not transfer ownership to the caller performing the update. Omit instruction to keep the existing instruction. Omit mode and timing fields to keep the existing time or recurrence. Provide mode whenever changing timing. A successful update returns a new scheduleId because Cloudflare assigns a new schedule ID; use that new scheduleId as the user-facing handle when a handle is needed. taskId is internal and should be omitted unless the user explicitly asks for diagnostic details.",
      inputSchema: z.object({
        scheduleId: z.string().min(1).describe("Schedule ID to update"),
        instruction: z
          .string()
          .optional()
          .describe(
            "Updated instruction. Omit to keep the current scheduled instruction."
          ),
        mode: z
          .enum(["delay", "at", "cron", "interval"])
          .optional()
          .describe(
            "delay runs after delaySeconds, at runs at runAt, cron runs on a UTC cron expression, interval repeats every intervalSeconds. Omit to keep the existing timing."
          ),
        delaySeconds: z
          .number()
          .int()
          .min(MIN_DELAY_SECONDS)
          .optional()
          .describe(DELAY_SECONDS_DESCRIPTION),
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
          .min(MIN_RECURRING_SCHEDULE_SECONDS)
          .optional()
          .describe(INTERVAL_SECONDS_DESCRIPTION)
      }),
      outputSchema: updateResultSchema,
      execute: async (input) =>
        controller?.update(input) ??
        ({
          ok: false,
          scheduleId: input.scheduleId,
          error: "Scheduling is unavailable outside a Discord channel turn."
        } satisfies UpdateScheduledChannelTaskResult),
      toModelOutput: ({ output }) => ({
        type: "text",
        value: formatUpdateScheduledTaskOutput(output)
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
        value: formatCancelScheduledTaskOutput(output)
      })
    })
  };
}

function formatScheduleTaskOutput(output: ScheduleTaskToolResult) {
  if (!output.ok) {
    return `Scheduled task creation failed: ${output.error ?? "Unknown error."}`;
  }

  const lines = ["Scheduled task created."];
  if (output.scheduleId) lines.push(`scheduleId: ${output.scheduleId}`);
  if (output.type) lines.push(`type: ${output.type}`);
  if (output.nextRunAt) lines.push(`nextRunAt: ${output.nextRunAt}`);
  if (output.recurring !== undefined) {
    lines.push(`recurring: ${output.recurring ? "yes" : "no"}`);
  }
  if (output.instruction) lines.push(`instruction: ${output.instruction}`);
  lines.push(
    "Final response guidance: confirm the schedule and use scheduleId as the user-facing handle when a handle is needed. Do not expose taskId unless the user explicitly asks for diagnostics."
  );
  return lines.join("\n");
}

function formatListScheduledTasksOutput(output: ListScheduledTasksToolResult) {
  if (!output.ok) {
    return `Scheduled task list failed: ${output.error ?? "Unknown error."}`;
  }

  const schedules = output.schedules ?? [];
  if (schedules.length === 0) {
    return "No scheduled tasks are active for this channel.";
  }

  return [
    `Scheduled tasks: ${schedules.length}`,
    ...schedules.map((schedule) =>
      [
        `- scheduleId: ${schedule.scheduleId}`,
        `type: ${schedule.type}`,
        `nextRunAt: ${schedule.nextRunAt}`,
        `recurring: ${schedule.recurring ? "yes" : "no"}`,
        schedule.instruction
          ? `instruction: ${schedule.instruction}`
          : undefined
      ]
        .filter(Boolean)
        .join("; ")
    ),
    "Final response guidance: summarize the active schedules. Use scheduleId as the user-facing handle; omit taskId and channel/guild internals unless requested."
  ].join("\n");
}

function formatUpdateScheduledTaskOutput(
  output: UpdateScheduledTaskToolResult
) {
  if (!output.ok) {
    return [
      "Scheduled task update failed.",
      `scheduleId: ${output.scheduleId}`,
      `error: ${output.error ?? "Unknown error."}`
    ].join("\n");
  }

  if (output.updated === false) {
    return [
      "Scheduled task was not updated because no matching active schedule was found.",
      `scheduleId: ${output.scheduleId}`,
      "Final response guidance: tell the user no active scheduled task matched that scheduleId."
    ].join("\n");
  }

  const lines = ["Scheduled task updated."];
  if (output.oldScheduleId)
    lines.push(`oldScheduleId: ${output.oldScheduleId}`);
  if (output.newScheduleId) lines.push(`scheduleId: ${output.newScheduleId}`);
  if (!output.newScheduleId) lines.push(`scheduleId: ${output.scheduleId}`);
  if (output.type) lines.push(`type: ${output.type}`);
  if (output.nextRunAt) lines.push(`nextRunAt: ${output.nextRunAt}`);
  if (output.recurring !== undefined) {
    lines.push(`recurring: ${output.recurring ? "yes" : "no"}`);
  }
  if (output.instruction) lines.push(`instruction: ${output.instruction}`);
  if (output.warning) lines.push(`warning: ${output.warning}`);
  lines.push(
    "Final response guidance: confirm the update and use the new scheduleId as the user-facing handle. Do not expose task IDs unless the user explicitly asks for diagnostics."
  );
  return lines.join("\n");
}

function formatCancelScheduledTaskOutput(
  output: CancelScheduledTaskToolResult
) {
  if (!output.ok) {
    return [
      "Scheduled task cancellation failed.",
      `scheduleId: ${output.scheduleId}`,
      `error: ${output.error ?? "Unknown error."}`
    ].join("\n");
  }

  if (output.cancelled === false) {
    return [
      "Scheduled task was not cancelled because no matching active schedule was found.",
      `scheduleId: ${output.scheduleId}`,
      "Final response guidance: tell the user no active scheduled task matched that scheduleId."
    ].join("\n");
  }

  return [
    "Scheduled task cancelled.",
    `scheduleId: ${output.scheduleId}`,
    `cancelled: ${output.cancelled ? "yes" : "no"}`,
    "Final response guidance: briefly confirm cancellation. Do not expose task IDs unless the user explicitly asks for diagnostics."
  ].join("\n");
}

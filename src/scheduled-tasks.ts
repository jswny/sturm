import type { Schedule } from "agents";
import type {
  DiscordAppContext,
  DiscordChannelContext,
  DiscordPermissionContext,
  DiscordUserContext
} from "./discord/types";

export const SCHEDULED_CHANNEL_TASK_CALLBACK = "runScheduledChannelTask";
export const MIN_RECURRING_SCHEDULE_SECONDS = 60 * 60;

export type ScheduledChannelTaskPayload = {
  kind: "discord_channel_task";
  taskId: string;
  guildId: string;
  channelId: string;
  channel?: DiscordChannelContext;
  app?: DiscordAppContext;
  appPermissions?: DiscordPermissionContext;
  createdByUserId?: string;
  createdByUser?: DiscordUserContext;
  instruction: string;
  createdAt: string;
};

export type ScheduledChannelTaskSchedule =
  Schedule<ScheduledChannelTaskPayload>;

export type ScheduleChannelTaskInput = {
  instruction: string;
  mode: "delay" | "at" | "cron" | "interval";
  delaySeconds?: number;
  runAt?: string;
  cron?: string;
  intervalSeconds?: number;
};

export type UpdateScheduledChannelTaskInput = {
  scheduleId: string;
  instruction?: string;
  mode?: ScheduleChannelTaskInput["mode"];
  delaySeconds?: number;
  runAt?: string;
  cron?: string;
  intervalSeconds?: number;
};

export type ScheduledTaskController = {
  schedule(input: ScheduleChannelTaskInput): Promise<ScheduleChannelTaskResult>;
  list(): Promise<ListScheduledChannelTasksResult>;
  cancel(scheduleId: string): Promise<CancelScheduledChannelTaskResult>;
  update(
    input: UpdateScheduledChannelTaskInput
  ): Promise<UpdateScheduledChannelTaskResult>;
};

export type ScheduleChannelTaskResult = {
  ok: boolean;
  scheduleId?: string;
  taskId?: string;
  type?: string;
  nextRunAt?: string;
  recurring?: boolean;
  instruction?: string;
  error?: string;
};

export type ListScheduledChannelTasksResult = {
  ok: boolean;
  schedules?: ScheduledChannelTaskSummary[];
  error?: string;
};

export type CancelScheduledChannelTaskResult = {
  ok: boolean;
  scheduleId: string;
  cancelled?: boolean;
  error?: string;
};

export type UpdateScheduledChannelTaskResult = {
  ok: boolean;
  scheduleId: string;
  updated?: boolean;
  oldScheduleId?: string;
  oldTaskId?: string;
  oldScheduleCancelled?: boolean;
  newScheduleId?: string;
  newTaskId?: string;
  newScheduleCancelled?: boolean;
  type?: string;
  nextRunAt?: string;
  recurring?: boolean;
  instruction?: string;
  warning?: string;
  error?: string;
};

export type ScheduledChannelTaskSummary = {
  scheduleId: string;
  taskId?: string;
  guildId?: string;
  channelId?: string;
  type: string;
  nextRunAt: string;
  recurring: boolean;
  instruction?: string;
  createdByUserId?: string;
  createdAt?: string;
};

export function createScheduledChannelTaskUserText(
  payload: ScheduledChannelTaskPayload
) {
  const lines = [
    "An accepted scheduled task for this Discord channel is now due.",
    `task_id: ${payload.taskId}`,
    payload.createdByUserId
      ? `created_by_user_id: ${payload.createdByUserId}`
      : "",
    payload.createdByUser?.displayName
      ? `created_by_display_name: ${payload.createdByUser.displayName}`
      : "",
    `accepted_at: ${payload.createdAt}`,
    "",
    "This instruction was vetted when the schedule was created. Execute it now as the creator's ordinary channel request and post the result to the channel. Do not re-decide whether to accept the request; only report failure if current external state, permissions, or tool/API errors prevent completion:",
    payload.instruction
  ];

  return lines.filter((line) => line !== "").join("\n");
}

export function summarizeScheduledChannelTask(
  schedule: Schedule<unknown>
): ScheduledChannelTaskSummary | undefined {
  if (schedule.callback !== SCHEDULED_CHANNEL_TASK_CALLBACK) return undefined;
  const payload = getScheduledChannelTaskPayload(schedule.payload);
  if (!payload) return undefined;

  return {
    scheduleId: schedule.id,
    taskId: payload.taskId,
    guildId: payload.guildId,
    channelId: payload.channelId,
    type: schedule.type,
    nextRunAt: new Date(schedule.time * 1000).toISOString(),
    recurring: schedule.type === "cron" || schedule.type === "interval",
    instruction: payload.instruction,
    createdByUserId: payload.createdByUserId,
    createdAt: payload.createdAt
  };
}

export function getScheduledChannelTaskPayload(
  value: unknown
): ScheduledChannelTaskPayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const payload = value as Partial<ScheduledChannelTaskPayload>;

  if (payload.kind !== "discord_channel_task") return undefined;
  if (typeof payload.taskId !== "string") return undefined;
  if (typeof payload.guildId !== "string") return undefined;
  if (typeof payload.channelId !== "string") return undefined;
  if (typeof payload.instruction !== "string") return undefined;
  if (typeof payload.createdAt !== "string") return undefined;

  return payload as ScheduledChannelTaskPayload;
}

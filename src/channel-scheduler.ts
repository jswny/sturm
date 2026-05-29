import type { Schedule } from "agents";
import { PermissionFlagsBits } from "discord-api-types/v10";
import { hasDiscordPermission } from "./discord/permissions";
import type { DiscordChatRequest } from "./discord/types";
import { getErrorMessage, logError } from "./logging";
import {
  getScheduledChannelTaskPayload,
  SCHEDULED_CHANNEL_TASK_CALLBACK,
  summarizeScheduledChannelTask,
  type CancelScheduledChannelTaskResult,
  type ListScheduledChannelTasksResult,
  type ScheduleChannelTaskInput,
  type ScheduleChannelTaskResult,
  type ScheduledChannelTaskPayload,
  type ScheduledChannelTaskSchedule,
  type ScheduledTaskController
} from "./scheduled-tasks";

const MIN_RECURRING_SCHEDULE_SECONDS = 60 * 60;

export type ChannelSchedulerHost = {
  agentName: string;
  scheduleChannelTask(
    when: Date | string | number,
    payload: ScheduledChannelTaskPayload
  ): Promise<ScheduledChannelTaskSchedule>;
  scheduleChannelTaskEvery(
    intervalSeconds: number,
    payload: ScheduledChannelTaskPayload
  ): Promise<ScheduledChannelTaskSchedule>;
  listSchedules(): Promise<Schedule<unknown>[]>;
  getScheduleById(scheduleId: string): Promise<Schedule<unknown> | undefined>;
  cancelSchedule(scheduleId: string): Promise<boolean>;
};

export function createChannelScheduledTaskController(
  host: ChannelSchedulerHost,
  turn: DiscordChatRequest
): ScheduledTaskController {
  return {
    schedule: (input) => scheduleDiscordChannelTask(host, turn, input),
    list: () => listDiscordChannelTasks(host, turn),
    cancel: (scheduleId) => cancelDiscordChannelTask(host, turn, scheduleId)
  };
}

async function scheduleDiscordChannelTask(
  host: ChannelSchedulerHost,
  turn: DiscordChatRequest,
  input: ScheduleChannelTaskInput
): Promise<ScheduleChannelTaskResult> {
  const instruction = input.instruction.trim();
  if (!instruction) {
    return {
      ok: false,
      error: "Scheduled task instruction cannot be empty."
    };
  }

  if (!turn.guildId || !turn.channelId) {
    return {
      ok: false,
      error: "Scheduled tasks require a Discord guild channel context."
    };
  }

  const when = getScheduleWhen(input);
  if (!when.ok) return when;

  const payload = {
    kind: "discord_channel_task",
    taskId: crypto.randomUUID(),
    guildId: turn.guildId,
    channelId: turn.channelId,
    channel: turn.channel,
    appPermissions: turn.appPermissions,
    createdByUserId: turn.userId,
    createdByUser: turn.user,
    instruction,
    createdAt: new Date().toISOString()
  } satisfies ScheduledChannelTaskPayload;

  try {
    const schedule =
      input.mode === "interval" && typeof when.value === "number"
        ? await host.scheduleChannelTaskEvery(when.value, payload)
        : await host.scheduleChannelTask(when.value, payload);

    return {
      ok: true,
      scheduleId: schedule.id,
      taskId: payload.taskId,
      type: schedule.type,
      nextRunAt: new Date(schedule.time * 1000).toISOString(),
      recurring: schedule.type === "cron" || schedule.type === "interval",
      instruction
    };
  } catch (error) {
    logError("Scheduled channel task creation failed", error, {
      agentName: host.agentName,
      guildId: turn.guildId,
      channelId: turn.channelId,
      mode: input.mode
    });
    return {
      ok: false,
      error: getErrorMessage(error)
    };
  }
}

async function listDiscordChannelTasks(
  host: ChannelSchedulerHost,
  turn: DiscordChatRequest
): Promise<ListScheduledChannelTasksResult> {
  try {
    const summaries = (await host.listSchedules())
      .map(summarizeScheduledChannelTask)
      .filter((summary) => summary !== undefined)
      .filter(
        (summary) => !turn.channelId || summary.channelId === turn.channelId
      )
      .sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt));

    return {
      ok: true,
      schedules: summaries
    };
  } catch (error) {
    logError("Scheduled channel task listing failed", error, {
      agentName: host.agentName,
      guildId: turn.guildId,
      channelId: turn.channelId
    });
    return {
      ok: false,
      error: getErrorMessage(error)
    };
  }
}

async function cancelDiscordChannelTask(
  host: ChannelSchedulerHost,
  turn: DiscordChatRequest,
  scheduleId: string
): Promise<CancelScheduledChannelTaskResult> {
  const preparedScheduleId = scheduleId.trim();
  if (!preparedScheduleId) {
    return {
      ok: false,
      scheduleId,
      error: "Schedule ID cannot be empty."
    };
  }

  try {
    const schedule = await host.getScheduleById(preparedScheduleId);
    if (!schedule) {
      return {
        ok: true,
        scheduleId: preparedScheduleId,
        cancelled: false
      };
    }

    const payload = getScheduledChannelTaskPayload(schedule.payload);
    if (
      schedule.callback !== SCHEDULED_CHANNEL_TASK_CALLBACK ||
      !payload ||
      payload.channelId !== turn.channelId
    ) {
      return {
        ok: false,
        scheduleId: preparedScheduleId,
        error: "That schedule is not a scheduled task for this channel."
      };
    }

    const callerCreatedTask =
      Boolean(payload.createdByUserId) &&
      payload.createdByUserId === turn.userId;
    const callerCanManageMessages = hasDiscordPermission(
      turn.userPermissions,
      PermissionFlagsBits.ManageMessages
    );

    if (!callerCreatedTask && !callerCanManageMessages) {
      return {
        ok: false,
        scheduleId: preparedScheduleId,
        error:
          "Only the task creator or a caller with Manage Messages can cancel that scheduled task."
      };
    }

    return {
      ok: true,
      scheduleId: preparedScheduleId,
      cancelled: await host.cancelSchedule(preparedScheduleId)
    };
  } catch (error) {
    logError("Scheduled channel task cancellation failed", error, {
      agentName: host.agentName,
      guildId: turn.guildId,
      channelId: turn.channelId,
      scheduleId: preparedScheduleId
    });
    return {
      ok: false,
      scheduleId: preparedScheduleId,
      error: getErrorMessage(error)
    };
  }
}

function getScheduleWhen(
  input: ScheduleChannelTaskInput
): { ok: true; value: Date | string | number } | { ok: false; error: string } {
  switch (input.mode) {
    case "delay": {
      const delaySeconds = getPositiveInteger(input.delaySeconds);
      if (!delaySeconds) {
        return {
          ok: false,
          error: "delaySeconds must be a positive integer when mode is delay."
        };
      }
      return { ok: true, value: delaySeconds };
    }
    case "at": {
      const runAt = input.runAt?.trim();
      if (!runAt) {
        return {
          ok: false,
          error: "runAt is required when mode is at."
        };
      }
      if (!hasIsoTimezone(runAt)) {
        return {
          ok: false,
          error:
            "runAt must include an explicit timezone offset or Z suffix, for example 2026-05-26T18:30:00-04:00."
        };
      }

      const date = new Date(runAt);
      if (!Number.isFinite(date.getTime())) {
        return {
          ok: false,
          error: "runAt must be a valid ISO 8601 timestamp."
        };
      }
      if (date.getTime() <= Date.now()) {
        return {
          ok: false,
          error: "runAt must be in the future."
        };
      }
      return { ok: true, value: date };
    }
    case "cron": {
      const cron = input.cron?.trim();
      if (!cron) {
        return {
          ok: false,
          error: "cron is required when mode is cron."
        };
      }
      if (cron.split(/\s+/).length !== 5) {
        return {
          ok: false,
          error:
            "cron must be a five-field expression: minute hour day month weekday."
        };
      }
      if (!isHourlyOrLessFrequentCron(cron)) {
        return {
          ok: false,
          error: "Recurring cron schedules cannot run more than once per hour."
        };
      }
      return { ok: true, value: cron };
    }
    case "interval": {
      const intervalSeconds = getPositiveInteger(input.intervalSeconds);
      if (!intervalSeconds) {
        return {
          ok: false,
          error:
            "intervalSeconds must be a positive integer when mode is interval."
        };
      }
      if (intervalSeconds < MIN_RECURRING_SCHEDULE_SECONDS) {
        return {
          ok: false,
          error: "intervalSeconds must be at least 3600 for recurring tasks."
        };
      }
      return { ok: true, value: intervalSeconds };
    }
  }
}

function getPositiveInteger(value: number | undefined) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function hasIsoTimezone(value: string) {
  return /(?:z|[+-]\d{2}:\d{2})$/i.test(value);
}

function isHourlyOrLessFrequentCron(cron: string) {
  const [minute, hour] = cron.split(/\s+/);
  if (!minute || !hour) return false;
  if (minute === "*" || minute.includes("/")) return false;
  if (hour.includes("/")) {
    const interval = Number(hour.split("/")[1]);
    if (Number.isFinite(interval) && interval < 1) return false;
  }
  return true;
}

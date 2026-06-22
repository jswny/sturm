import type { Schedule } from "agents";
import { PermissionFlagsBits } from "discord-api-types/v10";
import { requireDiscordPermission } from "./discord/permissions";
import type { DiscordChatRequest } from "./discord/types";
import { getErrorMessage, logError } from "./logging";
import {
  getScheduledChannelTaskPayload,
  MIN_RECURRING_SCHEDULE_SECONDS,
  SCHEDULED_CHANNEL_TASK_CALLBACK,
  summarizeScheduledChannelTask,
  type CancelScheduledChannelTaskResult,
  type ListScheduledChannelTasksResult,
  type ReplaceScheduledChannelTaskInput,
  type ReplaceScheduledChannelTaskResult,
  type ScheduleChannelTaskInput,
  type ScheduleChannelTaskResult,
  type ScheduledChannelTaskPayload,
  type ScheduledChannelTaskSchedule,
  type ScheduledTaskController
} from "./scheduled-tasks";

type ScheduleTimingInput = Omit<ScheduleChannelTaskInput, "instruction">;

type PreparedScheduleWhen = {
  mode: ScheduleChannelTaskInput["mode"];
  value: Date | string | number;
};

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
    cancel: (scheduleId) => cancelDiscordChannelTask(host, turn, scheduleId),
    replace: (input) => replaceDiscordChannelTask(host, turn, input)
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

  const payload = createScheduledChannelTaskPayload(turn, instruction);

  try {
    const schedule = await createScheduledChannelTaskSchedule(
      host,
      when.value,
      payload
    );

    return createScheduleChannelTaskResult(schedule, payload);
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

    const target = getScheduledChannelTaskMutationTarget(
      schedule,
      turn,
      "cancel"
    );
    if (!target.ok) {
      return {
        ok: false,
        scheduleId: preparedScheduleId,
        error: target.error
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

async function replaceDiscordChannelTask(
  host: ChannelSchedulerHost,
  turn: DiscordChatRequest,
  input: ReplaceScheduledChannelTaskInput
): Promise<ReplaceScheduledChannelTaskResult> {
  const preparedScheduleId = input.scheduleId.trim();
  if (!preparedScheduleId) {
    return {
      ok: false,
      scheduleId: input.scheduleId,
      error: "Schedule ID cannot be empty."
    };
  }

  try {
    const schedule = await host.getScheduleById(preparedScheduleId);
    if (!schedule) {
      return {
        ok: true,
        scheduleId: preparedScheduleId,
        replaced: false
      };
    }

    const target = getScheduledChannelTaskMutationTarget(
      schedule,
      turn,
      "replace"
    );
    if (!target.ok) {
      return {
        ok: false,
        scheduleId: preparedScheduleId,
        error: target.error
      };
    }

    const replacement = prepareReplacementScheduledChannelTask(
      turn,
      input,
      target.payload,
      schedule
    );
    if (!replacement.ok) {
      return {
        ok: false,
        scheduleId: preparedScheduleId,
        oldScheduleId: preparedScheduleId,
        oldTaskId: target.payload.taskId,
        error: replacement.error
      };
    }

    const replacementSchedule = await createScheduledChannelTaskSchedule(
      host,
      replacement.when,
      replacement.payload
    );
    const replacementFields = createReplacementScheduleFields(
      replacementSchedule,
      replacement.payload
    );

    let oldScheduleCancelled: boolean;
    try {
      oldScheduleCancelled = await host.cancelSchedule(preparedScheduleId);
    } catch (error) {
      const replacementCancelled = await cancelReplacementSchedule(
        host,
        replacementSchedule.id
      );
      logError(
        "Scheduled channel task replacement cancellation failed",
        error,
        {
          agentName: host.agentName,
          guildId: turn.guildId,
          channelId: turn.channelId,
          scheduleId: preparedScheduleId,
          newScheduleId: replacementSchedule.id,
          replacementCancelled
        }
      );
      return {
        ok: false,
        scheduleId: preparedScheduleId,
        oldScheduleId: preparedScheduleId,
        oldTaskId: target.payload.taskId,
        oldScheduleCancelled: false,
        ...replacementFields,
        replacementCancelled,
        error: `Original schedule cancellation failed after replacement creation: ${getErrorMessage(error)}`
      };
    }

    if (!oldScheduleCancelled) {
      return {
        ok: true,
        scheduleId: preparedScheduleId,
        replaced: true,
        oldScheduleId: preparedScheduleId,
        oldTaskId: target.payload.taskId,
        oldScheduleCancelled: false,
        ...replacementFields,
        warning:
          "Original schedule was no longer available after the replacement was created, so the replacement was kept."
      };
    }

    return {
      ok: true,
      scheduleId: preparedScheduleId,
      replaced: true,
      oldScheduleId: preparedScheduleId,
      oldTaskId: target.payload.taskId,
      oldScheduleCancelled: true,
      ...replacementFields
    };
  } catch (error) {
    logError("Scheduled channel task replacement failed", error, {
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
  input: ScheduleTimingInput
): { ok: true; value: PreparedScheduleWhen } | { ok: false; error: string } {
  switch (input.mode) {
    case "delay": {
      const delaySeconds = getPositiveInteger(input.delaySeconds);
      if (!delaySeconds) {
        return {
          ok: false,
          error: "delaySeconds must be a positive integer when mode is delay."
        };
      }
      return { ok: true, value: { mode: "delay", value: delaySeconds } };
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
      return { ok: true, value: { mode: "at", value: date } };
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
      return { ok: true, value: { mode: "cron", value: cron } };
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
      return { ok: true, value: { mode: "interval", value: intervalSeconds } };
    }
  }
}

function createScheduledChannelTaskPayload(
  turn: DiscordChatRequest,
  instruction: string
) {
  if (!turn.guildId || !turn.channelId) {
    throw new Error("Scheduled tasks require a Discord guild channel context.");
  }

  return {
    kind: "discord_channel_task",
    taskId: crypto.randomUUID(),
    guildId: turn.guildId,
    channelId: turn.channelId,
    channel: turn.channel,
    app: turn.app,
    appPermissions: turn.appPermissions,
    createdByUserId: turn.userId,
    createdByUser: turn.user,
    instruction,
    createdAt: new Date().toISOString()
  } satisfies ScheduledChannelTaskPayload;
}

async function createScheduledChannelTaskSchedule(
  host: ChannelSchedulerHost,
  when: PreparedScheduleWhen,
  payload: ScheduledChannelTaskPayload
) {
  return when.mode === "interval" && typeof when.value === "number"
    ? host.scheduleChannelTaskEvery(when.value, payload)
    : host.scheduleChannelTask(when.value, payload);
}

function createScheduleChannelTaskResult(
  schedule: ScheduledChannelTaskSchedule,
  payload: ScheduledChannelTaskPayload
): ScheduleChannelTaskResult {
  return {
    ok: true,
    scheduleId: schedule.id,
    taskId: payload.taskId,
    type: schedule.type,
    nextRunAt: new Date(schedule.time * 1000).toISOString(),
    recurring: schedule.type === "cron" || schedule.type === "interval",
    instruction: payload.instruction
  };
}

function createReplacementScheduleFields(
  schedule: ScheduledChannelTaskSchedule,
  payload: ScheduledChannelTaskPayload
) {
  return {
    newScheduleId: schedule.id,
    newTaskId: payload.taskId,
    type: schedule.type,
    nextRunAt: new Date(schedule.time * 1000).toISOString(),
    recurring: schedule.type === "cron" || schedule.type === "interval",
    instruction: payload.instruction
  } satisfies Pick<
    ReplaceScheduledChannelTaskResult,
    | "newScheduleId"
    | "newTaskId"
    | "type"
    | "nextRunAt"
    | "recurring"
    | "instruction"
  >;
}

function getScheduledChannelTaskMutationTarget(
  schedule: Schedule<unknown>,
  turn: DiscordChatRequest,
  action: "cancel" | "replace"
):
  | { ok: true; payload: ScheduledChannelTaskPayload }
  | { ok: false; error: string } {
  const payload = getScheduledChannelTaskPayload(schedule.payload);
  if (
    schedule.callback !== SCHEDULED_CHANNEL_TASK_CALLBACK ||
    !payload ||
    payload.channelId !== turn.channelId
  ) {
    return {
      ok: false,
      error: "That schedule is not a scheduled task for this channel."
    };
  }

  const callerCreatedTask =
    Boolean(payload.createdByUserId) && payload.createdByUserId === turn.userId;

  if (!callerCreatedTask) {
    const permission = requireDiscordPermission(
      turn.userPermissions,
      PermissionFlagsBits.ManageMessages,
      {
        deniedMessage: `Only the task creator or a caller with Manage Messages can ${action} that scheduled task.`
      }
    );

    if (!permission.ok) {
      return {
        ok: false,
        error: permission.error
      };
    }
  }

  return { ok: true, payload };
}

function prepareReplacementScheduledChannelTask(
  turn: DiscordChatRequest,
  input: ReplaceScheduledChannelTaskInput,
  existingPayload: ScheduledChannelTaskPayload,
  existingSchedule: Schedule<unknown>
):
  | {
      ok: true;
      payload: ScheduledChannelTaskPayload;
      when: PreparedScheduleWhen;
    }
  | { ok: false; error: string } {
  const hasInstructionChange = input.instruction !== undefined;
  const hasTimingChange =
    input.mode !== undefined || hasReplacementTimingFields(input);

  if (!hasInstructionChange && !hasTimingChange) {
    return {
      ok: false,
      error: "Provide an instruction change, timing change, or both."
    };
  }

  const instruction = getReplacementInstruction(input, existingPayload);
  if (!instruction.ok) return instruction;

  const when = getReplacementScheduleWhen(input, existingSchedule);
  if (!when.ok) return when;

  return {
    ok: true,
    payload: createScheduledChannelTaskPayload(turn, instruction.value),
    when: when.value
  };
}

function getReplacementInstruction(
  input: ReplaceScheduledChannelTaskInput,
  existingPayload: ScheduledChannelTaskPayload
): { ok: true; value: string } | { ok: false; error: string } {
  if (input.instruction === undefined) {
    return { ok: true, value: existingPayload.instruction };
  }

  const instruction = input.instruction.trim();
  if (!instruction) {
    return {
      ok: false,
      error: "Replacement scheduled task instruction cannot be empty."
    };
  }
  return { ok: true, value: instruction };
}

function getReplacementScheduleWhen(
  input: ReplaceScheduledChannelTaskInput,
  existingSchedule: Schedule<unknown>
): { ok: true; value: PreparedScheduleWhen } | { ok: false; error: string } {
  if (input.mode) {
    return getScheduleWhen({
      mode: input.mode,
      delaySeconds: input.delaySeconds,
      runAt: input.runAt,
      cron: input.cron,
      intervalSeconds: input.intervalSeconds
    });
  }

  if (hasReplacementTimingFields(input)) {
    return {
      ok: false,
      error: "mode is required when changing scheduled task timing."
    };
  }

  return getExistingScheduleWhen(existingSchedule);
}

function getExistingScheduleWhen(
  schedule: Schedule<unknown>
): { ok: true; value: PreparedScheduleWhen } | { ok: false; error: string } {
  switch (schedule.type) {
    case "scheduled":
    case "delayed": {
      const date = new Date(schedule.time * 1000);
      if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
        return {
          ok: false,
          error:
            "Existing one-time schedule is no longer in the future; provide a new runAt time."
        };
      }
      return { ok: true, value: { mode: "at", value: date } };
    }
    case "cron":
      return { ok: true, value: { mode: "cron", value: schedule.cron } };
    case "interval":
      return {
        ok: true,
        value: { mode: "interval", value: schedule.intervalSeconds }
      };
  }
}

function hasReplacementTimingFields(input: ReplaceScheduledChannelTaskInput) {
  return (
    input.delaySeconds !== undefined ||
    input.runAt !== undefined ||
    input.cron !== undefined ||
    input.intervalSeconds !== undefined
  );
}

async function cancelReplacementSchedule(
  host: ChannelSchedulerHost,
  scheduleId: string
) {
  try {
    return await host.cancelSchedule(scheduleId);
  } catch (error) {
    logError("Scheduled channel task replacement cleanup failed", error, {
      agentName: host.agentName,
      scheduleId
    });
    return false;
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

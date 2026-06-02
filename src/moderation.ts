import { PermissionFlagsBits } from "discord-api-types/v10";
import { modifyGuildMemberTimeout } from "./discord/api";
import type { DiscordApiEnv } from "./discord/api";
import {
  createDiscordMemberActionFailureFields,
  formatDiscordMemberActionError,
  logDiscordMemberActionFailure,
  validateDiscordMemberActionContext,
  type DiscordMemberActionContext
} from "./discord/member-actions";

const MIN_TEMPORARY_MUTE_SECONDS = 5;
const MAX_TEMPORARY_MUTE_SECONDS = 5 * 60;

export type ModerationEnv = DiscordApiEnv;

export type ModerationRequestContext = DiscordMemberActionContext;

export type TemporaryMuteResponse = {
  ok: boolean;
  action: "muted";
  guildId?: string;
  callerUserId?: string;
  targetUserId?: string;
  targetDisplayName?: string;
  durationSeconds?: number;
  communicationDisabledUntil?: string;
  reason?: string;
  error?: string;
};

export async function temporarilyMuteGuildMember(
  env: ModerationEnv,
  context: ModerationRequestContext,
  targetUserId: string,
  durationSeconds: number,
  reason: string
): Promise<TemporaryMuteResponse> {
  const guard = validateTemporaryMuteContext(
    env,
    context,
    targetUserId,
    durationSeconds,
    reason
  );
  if (guard.error) {
    return temporaryMuteFailure(context, guard.targetUserId, guard.error);
  }

  const guildId = context.guildId ?? "";
  const communicationDisabledUntil = new Date(
    Date.now() + guard.durationSeconds * 1000
  ).toISOString();

  try {
    const member = await modifyGuildMemberTimeout(
      env,
      guildId,
      guard.targetUserId,
      communicationDisabledUntil,
      createAuditLogReason(context, guard.reason, guard.durationSeconds)
    );

    return {
      ok: true,
      action: "muted",
      guildId,
      callerUserId: context.userId,
      targetUserId: guard.targetUserId,
      targetDisplayName: member.user
        ? (member.nick ?? member.user.global_name ?? member.user.username)
        : undefined,
      durationSeconds: guard.durationSeconds,
      communicationDisabledUntil,
      reason: guard.reason
    };
  } catch (error) {
    logTemporaryMuteFailure(error, context, guard.targetUserId);
    return temporaryMuteFailure(
      context,
      guard.targetUserId,
      formatTemporaryMuteError(error)
    );
  }
}

function validateTemporaryMuteContext(
  env: ModerationEnv,
  context: ModerationRequestContext,
  targetUserId: string | undefined,
  durationSeconds: number,
  reason: string
): {
  targetUserId: string;
  durationSeconds: number;
  reason: string;
  error?: string;
} {
  const preparedReason = reason.trim();
  const memberGuard = validateDiscordMemberActionContext(env, context, {
    targetUserId,
    missingGuildError: "Temporary mutes require a server context.",
    permission: PermissionFlagsBits.ModerateMembers,
    permissionError:
      "You need Discord's Moderate Members permission to request a temporary mute.",
    requireSnowflake: true
  });

  if (memberGuard.error)
    return {
      targetUserId: memberGuard.targetUserId,
      durationSeconds,
      reason: preparedReason,
      error: memberGuard.error
    };

  if (!Number.isFinite(durationSeconds)) {
    return {
      targetUserId: memberGuard.targetUserId,
      durationSeconds,
      reason: preparedReason,
      error: "durationSeconds must be a finite number."
    };
  }

  const preparedDurationSeconds = Math.trunc(durationSeconds);
  if (
    preparedDurationSeconds < MIN_TEMPORARY_MUTE_SECONDS ||
    preparedDurationSeconds > MAX_TEMPORARY_MUTE_SECONDS
  ) {
    return {
      targetUserId: memberGuard.targetUserId,
      durationSeconds: preparedDurationSeconds,
      reason: preparedReason,
      error: `Temporary mute duration must be between ${MIN_TEMPORARY_MUTE_SECONDS} and ${MAX_TEMPORARY_MUTE_SECONDS} seconds.`
    };
  }

  if (!preparedReason) {
    return {
      targetUserId: memberGuard.targetUserId,
      durationSeconds: preparedDurationSeconds,
      reason: preparedReason,
      error: "A short reason is required for the temporary mute."
    };
  }

  return {
    targetUserId: memberGuard.targetUserId,
    durationSeconds: preparedDurationSeconds,
    reason: preparedReason.slice(0, 200)
  };
}

function createAuditLogReason(
  context: ModerationRequestContext,
  reason: string,
  durationSeconds: number
) {
  return [
    "Sturm temporary mute",
    `caller=${context.userId ?? "unknown"}`,
    `duration=${durationSeconds}s`,
    `reason=${reason}`
  ].join("; ");
}

function temporaryMuteFailure(
  context: ModerationRequestContext,
  targetUserId: string | undefined,
  error: string
): TemporaryMuteResponse {
  return {
    ok: false,
    action: "muted",
    ...createDiscordMemberActionFailureFields(context, targetUserId),
    error
  };
}

function logTemporaryMuteFailure(
  error: unknown,
  context: ModerationRequestContext,
  targetUserId: string
) {
  logDiscordMemberActionFailure({
    apiLogMessage: "Discord temporary mute API request failed",
    operationLogMessage: "Discord temporary mute operation failed",
    error,
    context,
    targetUserId,
    formatError: formatTemporaryMuteError
  });
}

function formatTemporaryMuteError(error: unknown) {
  return formatDiscordMemberActionError(error, {
    forbidden:
      "Discord rejected the temporary mute. The bot may be missing Moderate Members, the target may be the server owner or an administrator, or role hierarchy may block timing out that member.",
    notFound: "Discord could not find that guild member.",
    validationField: "communication_disabled_until",
    validationErrorPrefix: "Discord rejected the temporary mute duration",
    invalidRequest: "Discord rejected the temporary mute request as invalid."
  });
}

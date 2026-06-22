import { PermissionFlagsBits } from "discord-api-types/v10";
import { modifyGuildMemberTimeout } from "./discord/api";
import type { DiscordApiEnv } from "./discord/api";
import { resolveDiscordMemberDisplayName } from "./discord/display-name";
import {
  createDiscordMemberActionFailureFields,
  formatDiscordMemberActionError,
  logDiscordMemberActionFailure,
  validateDiscordMemberActionContext,
  type DiscordMemberActionContext
} from "./discord/member-actions";

export type ModerationEnv = DiscordApiEnv;

export type ModerationRequestContext = DiscordMemberActionContext;

export const MODERATION_REASON_MIN_CHARS = 1;
export const MODERATION_REASON_MAX_CHARS = 200;

type ModerationAction = "muted" | "unmuted";

type ModerationResponse<Action extends ModerationAction> = {
  ok: boolean;
  action: Action;
  guildId?: string;
  callerUserId?: string;
  targetUserId?: string;
  targetDisplayName?: string;
  reason?: string;
  error?: string;
};

export type MuteResponse = ModerationResponse<"muted"> & {
  durationSeconds?: number;
  communicationDisabledUntil?: string;
};

export type UnmuteResponse = ModerationResponse<"unmuted">;

type ModerationResponseFor<Action extends ModerationAction> =
  Action extends "muted" ? MuteResponse : UnmuteResponse;

type PreparedModerationTarget = {
  targetUserId: string;
  error?: string;
};

type PreparedModerationReason = {
  reason: string;
  error?: string;
};

type ModerationOperation<Action extends ModerationAction> = {
  action: Action;
  targetUserId: string;
  reason: string;
  communicationDisabledUntil: string | null;
  auditLogLabel: string;
  apiLogMessage: string;
  operationLogMessage: string;
  formatError(error: unknown): string;
  auditLogFields?: string[];
  responseFields?: Record<string, unknown>;
};

export async function muteGuildMember(
  env: ModerationEnv,
  context: ModerationRequestContext,
  targetUserId: string,
  durationSeconds: number,
  reason: string
): Promise<MuteResponse> {
  const guard = validateTemporaryMuteContext(
    env,
    context,
    targetUserId,
    reason
  );
  if (guard.error) {
    return moderationFailure("muted", context, guard.targetUserId, guard.error);
  }

  const communicationDisabledUntil = new Date(
    Date.now() + durationSeconds * 1000
  ).toISOString();

  return applyGuildMemberTimeoutChange(env, context, {
    action: "muted",
    targetUserId: guard.targetUserId,
    reason: guard.reason,
    communicationDisabledUntil,
    auditLogLabel: "Sturm temporary mute",
    auditLogFields: [`duration=${durationSeconds}s`],
    apiLogMessage: "Discord temporary mute API request failed",
    operationLogMessage: "Discord temporary mute operation failed",
    formatError: formatTemporaryMuteError,
    responseFields: {
      durationSeconds,
      communicationDisabledUntil
    }
  });
}

export async function unmuteGuildMember(
  env: ModerationEnv,
  context: ModerationRequestContext,
  targetUserId: string,
  reason: string
): Promise<UnmuteResponse> {
  const guard = validateUnmuteContext(env, context, targetUserId, reason);
  if (guard.error) {
    return moderationFailure(
      "unmuted",
      context,
      guard.targetUserId,
      guard.error
    );
  }

  return applyGuildMemberTimeoutChange(env, context, {
    action: "unmuted",
    targetUserId: guard.targetUserId,
    reason: guard.reason,
    communicationDisabledUntil: null,
    auditLogLabel: "Sturm unmute",
    apiLogMessage: "Discord unmute API request failed",
    operationLogMessage: "Discord unmute operation failed",
    formatError: formatUnmuteError
  });
}

function validateTemporaryMuteContext(
  env: ModerationEnv,
  context: ModerationRequestContext,
  targetUserId: string | undefined,
  reason: string
): {
  targetUserId: string;
  reason: string;
  error?: string;
} {
  const preparedReason = reason.trim();
  const targetGuard = validateModerationTarget(env, context, targetUserId, {
    missingGuildError: "Temporary mutes require a server context.",
    permissionError:
      "You need Discord's Moderate Members permission to request a temporary mute."
  });

  if (targetGuard.error)
    return {
      targetUserId: targetGuard.targetUserId,
      reason: preparedReason,
      error: targetGuard.error
    };

  const reasonGuard = validateModerationReason(
    preparedReason,
    "A short reason is required for the temporary mute."
  );
  if (reasonGuard.error) {
    return {
      targetUserId: targetGuard.targetUserId,
      reason: reasonGuard.reason,
      error: reasonGuard.error
    };
  }

  return {
    targetUserId: targetGuard.targetUserId,
    reason: reasonGuard.reason
  };
}

function validateUnmuteContext(
  env: ModerationEnv,
  context: ModerationRequestContext,
  targetUserId: string | undefined,
  reason: string
): {
  targetUserId: string;
  reason: string;
  error?: string;
} {
  const targetGuard = validateModerationTarget(env, context, targetUserId, {
    missingGuildError: "Unmutes require a server context.",
    permissionError:
      "You need Discord's Moderate Members permission to request an unmute."
  });
  const reasonGuard = validateModerationReason(
    reason,
    "A short reason is required for the unmute."
  );

  if (targetGuard.error)
    return {
      targetUserId: targetGuard.targetUserId,
      reason: reasonGuard.reason,
      error: targetGuard.error
    };
  if (reasonGuard.error)
    return {
      targetUserId: targetGuard.targetUserId,
      reason: reasonGuard.reason,
      error: reasonGuard.error
    };

  return {
    targetUserId: targetGuard.targetUserId,
    reason: reasonGuard.reason
  };
}

function validateModerationTarget(
  env: ModerationEnv,
  context: ModerationRequestContext,
  targetUserId: string | undefined,
  options: { missingGuildError: string; permissionError: string }
): PreparedModerationTarget {
  return validateDiscordMemberActionContext(env, context, {
    targetUserId,
    missingGuildError: options.missingGuildError,
    permission: PermissionFlagsBits.ModerateMembers,
    permissionError: options.permissionError,
    requireSnowflake: true
  });
}

function validateModerationReason(
  reason: string,
  emptyReasonError: string
): PreparedModerationReason {
  const preparedReason = reason.trim();
  if (!preparedReason) {
    return { reason: preparedReason, error: emptyReasonError };
  }

  return { reason: preparedReason.slice(0, MODERATION_REASON_MAX_CHARS) };
}

async function applyGuildMemberTimeoutChange<Action extends ModerationAction>(
  env: ModerationEnv,
  context: ModerationRequestContext,
  operation: ModerationOperation<Action>
): Promise<ModerationResponseFor<Action>> {
  const guildId = context.guildId ?? "";

  try {
    const member = await modifyGuildMemberTimeout(
      env,
      guildId,
      operation.targetUserId,
      operation.communicationDisabledUntil,
      createModerationAuditLogReason(context, operation)
    );

    return {
      ok: true,
      action: operation.action,
      guildId,
      callerUserId: context.userId,
      targetUserId: operation.targetUserId,
      targetDisplayName: resolveDiscordMemberDisplayName(member),
      reason: operation.reason,
      ...operation.responseFields
    } as ModerationResponseFor<Action>;
  } catch (error) {
    logModerationFailure(error, context, operation);
    return moderationFailure(
      operation.action,
      context,
      operation.targetUserId,
      operation.formatError(error)
    );
  }
}

function createModerationAuditLogReason<Action extends ModerationAction>(
  context: ModerationRequestContext,
  operation: ModerationOperation<Action>
) {
  return [
    operation.auditLogLabel,
    `caller=${context.userId ?? "unknown"}`,
    ...(operation.auditLogFields ?? []),
    `reason=${operation.reason}`
  ].join("; ");
}

function moderationFailure<Action extends ModerationAction>(
  action: Action,
  context: ModerationRequestContext,
  targetUserId: string | undefined,
  error: string
): ModerationResponseFor<Action> {
  return {
    ok: false,
    action,
    ...createDiscordMemberActionFailureFields(context, targetUserId),
    error
  } as ModerationResponseFor<Action>;
}

function logModerationFailure<Action extends ModerationAction>(
  error: unknown,
  context: ModerationRequestContext,
  operation: ModerationOperation<Action>
) {
  logDiscordMemberActionFailure({
    apiLogMessage: operation.apiLogMessage,
    operationLogMessage: operation.operationLogMessage,
    error,
    context,
    targetUserId: operation.targetUserId,
    formatError: operation.formatError
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

function formatUnmuteError(error: unknown) {
  return formatDiscordMemberActionError(error, {
    forbidden:
      "Discord rejected the unmute. The bot may be missing Moderate Members, the target may be the server owner or an administrator, or role hierarchy may block editing that member.",
    notFound: "Discord could not find that guild member.",
    validationField: "communication_disabled_until",
    validationErrorPrefix: "Discord rejected the unmute request",
    invalidRequest: "Discord rejected the unmute request as invalid."
  });
}

import type { DiscordApiEnv } from "./api";
import { DiscordApiError } from "./api";
import { requireDiscordPermission } from "./permissions";
import { logError, logWarn } from "../logging";

export type DiscordMemberActionContext = {
  guildId?: string;
  userId?: string;
  userPermissions?: string;
};

type DiscordMemberActionValidationOptions = {
  targetUserId: string | undefined;
  missingGuildError: string;
  permission: bigint;
  permissionError: string;
  requireSnowflake?: boolean;
};

type DiscordMemberActionErrorOptions = {
  forbidden: string;
  notFound: string;
  validationField?: string;
  validationErrorPrefix?: string;
  invalidRequest: string;
};

export function validateDiscordMemberActionContext(
  env: DiscordApiEnv,
  context: DiscordMemberActionContext,
  options: DiscordMemberActionValidationOptions
): { targetUserId: string; error?: string } {
  const targetUserId = options.targetUserId?.trim() || "";

  if (!env.DISCORD_TOKEN?.trim()) {
    return {
      targetUserId,
      error: "DISCORD_TOKEN is not configured."
    };
  }

  if (!context.guildId) {
    return {
      targetUserId,
      error: options.missingGuildError
    };
  }

  if (!context.userId) {
    return {
      targetUserId,
      error: "Could not identify the Discord user who invoked the command."
    };
  }

  if (!targetUserId) {
    return {
      targetUserId,
      error: "targetUserId is required. Search for the user first if needed."
    };
  }

  if (options.requireSnowflake && !/^\d{8,}$/.test(targetUserId)) {
    return {
      targetUserId,
      error: "targetUserId must be a raw Discord user ID."
    };
  }

  const permission = requireDiscordPermission(
    context.userPermissions,
    options.permission,
    { deniedMessage: options.permissionError }
  );
  if (!permission.ok) {
    return {
      targetUserId,
      error: permission.error
    };
  }

  return { targetUserId };
}

export function createDiscordMemberActionFailureFields(
  context: DiscordMemberActionContext,
  targetUserId: string | undefined
) {
  return {
    guildId: context.guildId,
    callerUserId: context.userId,
    targetUserId
  };
}

export function logDiscordMemberActionFailure(input: {
  apiLogMessage: string;
  operationLogMessage: string;
  error: unknown;
  context: DiscordMemberActionContext;
  targetUserId: string;
  formatError(error: unknown): string;
  extra?: Record<string, unknown>;
}) {
  const logContext = {
    ...input.extra,
    guildId: input.context.guildId,
    callerUserId: input.context.userId,
    targetUserId: input.targetUserId
  };

  if (input.error instanceof DiscordApiError) {
    logWarn(input.apiLogMessage, {
      ...logContext,
      discordStatus: input.error.status,
      discordCode: input.error.code,
      error: input.formatError(input.error)
    });
    return;
  }

  logError(input.operationLogMessage, input.error, logContext);
}

export function formatDiscordMemberActionError(
  error: unknown,
  options: DiscordMemberActionErrorOptions
) {
  if (error instanceof DiscordApiError) {
    if (error.status === 403) return options.forbidden;
    if (error.status === 404) return options.notFound;

    if (error.code === 50_035) {
      const validationError = options.validationField
        ? getDiscordValidationError(error.body, options.validationField)
        : undefined;
      if (validationError && options.validationErrorPrefix) {
        return `${options.validationErrorPrefix}: ${validationError}`;
      }

      return options.invalidRequest;
    }

    return `Discord API error ${error.status}.`;
  }

  return error instanceof Error ? error.message : String(error);
}

function getDiscordValidationError(body: string, field: string) {
  try {
    const parsed = JSON.parse(body) as {
      errors?: Record<string, { _errors?: { message?: string }[] }>;
    };
    const error = parsed.errors?.[field]?._errors?.find((item) =>
      Boolean(item.message)
    );
    return error?.message;
  } catch {
    return undefined;
  }
}

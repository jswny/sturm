import { PermissionFlagsBits } from "discord-api-types/v10";
import {
  DiscordApiError,
  getGuildMember,
  modifyGuildMemberNickname,
  searchGuildMembers as searchDiscordGuildMembers
} from "./discord/api";
import { hasDiscordPermission } from "./discord/permissions";
import { logError, logWarn } from "./logging";

const SPECIAL_SPACE = " ";

export type NicknameEnv = {
  DISCORD_TOKEN?: string;
};

export type NicknameRequestContext = {
  guildId?: string;
  userId?: string;
  userPermissions?: string;
};

export type NicknameResponse = {
  ok: boolean;
  action: "set" | "cleared";
  guildId?: string;
  callerUserId?: string;
  targetUserId?: string;
  oldNickname?: string;
  baseNickname?: string;
  postfix?: string;
  convertedPostfix?: string;
  newNickname?: string;
  changed?: boolean;
  error?: string;
};

export type GuildMemberSearchResult = {
  ok: boolean;
  guildId?: string;
  query: string;
  results?: GuildMemberSearchMatch[];
  error?: string;
};

export type GuildMemberSearchMatch = {
  id: string;
  username: string;
  globalName?: string;
  nickname?: string;
  displayName: string;
  bot: boolean;
};

export async function searchGuildMembers(
  env: NicknameEnv,
  context: NicknameRequestContext,
  query: string,
  limit = 5
): Promise<GuildMemberSearchResult> {
  const preparedQuery = query.trim();
  if (!preparedQuery) {
    return {
      ok: false,
      guildId: context.guildId,
      query,
      error: "Guild member search query cannot be empty."
    };
  }

  if (!env.DISCORD_TOKEN?.trim()) {
    return {
      ok: false,
      guildId: context.guildId,
      query: preparedQuery,
      error: "DISCORD_TOKEN is not configured."
    };
  }

  if (!context.guildId) {
    return {
      ok: false,
      query: preparedQuery,
      error: "Guild member search requires a server context."
    };
  }

  const preparedLimit = Math.max(1, Math.min(limit, 10));

  try {
    const members = await searchDiscordGuildMembers(
      env.DISCORD_TOKEN.trim(),
      context.guildId,
      preparedQuery,
      preparedLimit
    );

    return {
      ok: true,
      guildId: context.guildId,
      query: preparedQuery,
      results: members.map((member) => {
        const globalName = member.user.global_name ?? undefined;
        const nickname = member.nick ?? undefined;
        return {
          id: member.user.id,
          username: member.user.username,
          globalName,
          nickname,
          displayName: nickname ?? globalName ?? member.user.username,
          bot: member.user.bot ?? false
        };
      })
    };
  } catch (error) {
    logGuildMemberSearchFailure(error, context, preparedQuery);
    return {
      ok: false,
      guildId: context.guildId,
      query: preparedQuery,
      error: formatGuildMemberSearchError(error)
    };
  }
}

export async function setNicknamePostfix(
  env: NicknameEnv,
  context: NicknameRequestContext,
  targetUserId: string,
  postfix: string
): Promise<NicknameResponse> {
  const preparedPostfix = postfix.trim();
  if (!preparedPostfix) {
    return failure(
      "set",
      context,
      targetUserId,
      "Nickname postfix cannot be empty."
    );
  }

  const guard = validateNicknameContext(env, context, targetUserId);
  if (guard.error)
    return failure("set", context, guard.targetUserId, guard.error);

  try {
    const token = env.DISCORD_TOKEN?.trim() ?? "";
    const guildId = context.guildId ?? "";
    const member = await getGuildMember(token, guildId, guard.targetUserId);
    const oldNickname =
      member.nick ?? member.user.global_name ?? member.user.username;
    const baseNickname = parseBaseNickname(oldNickname);
    if (!baseNickname) {
      return failure(
        "set",
        context,
        guard.targetUserId,
        "Could not determine the base nickname to preserve."
      );
    }

    const convertedPostfix = convertPostfix(preparedPostfix);
    const newNickname = `${baseNickname}${SPECIAL_SPACE}${convertedPostfix}`;
    await modifyGuildMemberNickname(
      token,
      guildId,
      guard.targetUserId,
      newNickname
    );

    return {
      ok: true,
      action: "set",
      guildId,
      callerUserId: context.userId,
      targetUserId: guard.targetUserId,
      oldNickname,
      baseNickname,
      postfix: preparedPostfix,
      convertedPostfix,
      newNickname,
      changed: newNickname !== oldNickname
    };
  } catch (error) {
    logNicknameOperationFailure("set", error, context, guard.targetUserId);
    return failure(
      "set",
      context,
      guard.targetUserId,
      formatNicknameError(error)
    );
  }
}

export async function clearNicknamePostfix(
  env: NicknameEnv,
  context: NicknameRequestContext,
  targetUserId: string
): Promise<NicknameResponse> {
  const guard = validateNicknameContext(env, context, targetUserId);
  if (guard.error)
    return failure("cleared", context, guard.targetUserId, guard.error);

  try {
    const token = env.DISCORD_TOKEN?.trim() ?? "";
    const guildId = context.guildId ?? "";
    const member = await getGuildMember(token, guildId, guard.targetUserId);
    const oldNickname =
      member.nick ?? member.user.global_name ?? member.user.username;
    const baseNickname = parseBaseNickname(oldNickname);
    if (!baseNickname) {
      return failure(
        "cleared",
        context,
        guard.targetUserId,
        "Could not determine the base nickname to preserve."
      );
    }

    if (!oldNickname.includes(SPECIAL_SPACE)) {
      return {
        ok: true,
        action: "cleared",
        guildId,
        callerUserId: context.userId,
        targetUserId: guard.targetUserId,
        oldNickname,
        baseNickname,
        newNickname: oldNickname,
        changed: false
      };
    }

    await modifyGuildMemberNickname(
      token,
      guildId,
      guard.targetUserId,
      baseNickname
    );

    return {
      ok: true,
      action: "cleared",
      guildId,
      callerUserId: context.userId,
      targetUserId: guard.targetUserId,
      oldNickname,
      baseNickname,
      newNickname: baseNickname,
      changed: baseNickname !== oldNickname
    };
  } catch (error) {
    logNicknameOperationFailure("cleared", error, context, guard.targetUserId);
    return failure(
      "cleared",
      context,
      guard.targetUserId,
      formatNicknameError(error)
    );
  }
}

function validateNicknameContext(
  env: NicknameEnv,
  context: NicknameRequestContext,
  targetUserId: string | undefined
): { targetUserId: string; error?: string } {
  const resolvedTargetUserId = targetUserId?.trim() || "";

  if (!env.DISCORD_TOKEN?.trim()) {
    return {
      targetUserId: resolvedTargetUserId,
      error: "DISCORD_TOKEN is not configured."
    };
  }

  if (!context.guildId) {
    return {
      targetUserId: resolvedTargetUserId,
      error: "Nickname changes require a server context."
    };
  }

  if (!context.userId) {
    return {
      targetUserId: resolvedTargetUserId,
      error: "Could not identify the Discord user who invoked the command."
    };
  }

  if (!resolvedTargetUserId) {
    return {
      targetUserId: resolvedTargetUserId,
      error: "targetUserId is required. Search for the user first if needed."
    };
  }

  if (
    !hasDiscordPermission(
      context.userPermissions,
      PermissionFlagsBits.ManageNicknames
    )
  ) {
    return {
      targetUserId: resolvedTargetUserId,
      error: "You need Discord's Manage Nicknames permission to use this tool."
    };
  }

  return { targetUserId: resolvedTargetUserId };
}

function parseBaseNickname(nickname: string) {
  return nickname
    .split(SPECIAL_SPACE)
    .map((part) => part.trim())
    .filter(Boolean)[0];
}

function convertPostfix(postfix: string) {
  return Array.from(postfix)
    .map((char) => {
      const codepoint = char.codePointAt(0);
      if (codepoint === undefined) return char;
      if (codepoint === 104) return "ℎ";
      if (codepoint >= 65 && codepoint <= 90) {
        return String.fromCodePoint(codepoint - 65 + 0x1d434);
      }
      if (codepoint >= 97 && codepoint <= 122) {
        return String.fromCodePoint(codepoint - 97 + 0x1d44e);
      }
      return char;
    })
    .join("");
}

function failure(
  action: NicknameResponse["action"],
  context: NicknameRequestContext,
  targetUserId: string | undefined,
  error: string
): NicknameResponse {
  return {
    ok: false,
    action,
    guildId: context.guildId,
    callerUserId: context.userId,
    targetUserId,
    error
  };
}

function logNicknameOperationFailure(
  action: NicknameResponse["action"],
  error: unknown,
  context: NicknameRequestContext,
  targetUserId: string
) {
  const logContext = {
    action,
    guildId: context.guildId,
    callerUserId: context.userId,
    targetUserId
  };

  if (error instanceof DiscordApiError) {
    logWarn("Discord nickname API request failed", {
      ...logContext,
      discordStatus: error.status,
      discordCode: error.code,
      error: formatNicknameError(error)
    });
    return;
  }

  logError("Discord nickname operation failed", error, logContext);
}

function logGuildMemberSearchFailure(
  error: unknown,
  context: NicknameRequestContext,
  query: string
) {
  const logContext = {
    guildId: context.guildId,
    callerUserId: context.userId,
    query
  };

  if (error instanceof DiscordApiError) {
    logWarn("Discord guild member search API request failed", {
      ...logContext,
      discordStatus: error.status,
      discordCode: error.code,
      error: formatGuildMemberSearchError(error)
    });
    return;
  }

  logError("Discord guild member search failed", error, logContext);
}

function formatGuildMemberSearchError(error: unknown) {
  if (error instanceof DiscordApiError) {
    if (error.status === 403) {
      return "Discord rejected the guild member search. The bot may be missing access to that server.";
    }

    if (error.status === 404) {
      return "Discord could not find that guild.";
    }

    return `Discord API error ${error.status}.`;
  }

  return error instanceof Error ? error.message : String(error);
}

function formatNicknameError(error: unknown) {
  if (error instanceof DiscordApiError) {
    if (error.status === 403) {
      return "Discord rejected the nickname change. The bot may be missing Manage Nicknames, or role hierarchy may block editing that member.";
    }

    if (error.status === 404) {
      return "Discord could not find that guild member.";
    }

    if (error.code === 50_035) {
      const nicknameError = getDiscordValidationError(error.body, "nick");
      if (nicknameError) {
        return `Discord rejected the nickname value: ${nicknameError}`;
      }

      return "Discord rejected the request as invalid.";
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

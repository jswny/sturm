import { PermissionFlagsBits } from "discord-api-types/v10";
import {
  DiscordApiError,
  getGuildMember,
  modifyGuildMemberNickname,
  searchGuildMembers as searchDiscordGuildMembers
} from "./discord/api";
import type { DiscordApiEnv } from "./discord/api";
import { resolveDiscordMemberDisplayName } from "./discord/display-name";
import {
  createDiscordMemberActionFailureFields,
  formatDiscordMemberActionError,
  logDiscordMemberActionFailure,
  validateDiscordMemberActionContext,
  type DiscordMemberActionContext
} from "./discord/member-actions";
import { logError, logWarn } from "./logging";

const SPECIAL_SPACE = " ";
export const GUILD_MEMBER_SEARCH_MIN_LIMIT = 1;
export const GUILD_MEMBER_SEARCH_MAX_LIMIT = 10;
export const GUILD_MEMBER_SEARCH_DEFAULT_LIMIT = 5;

export type NicknameEnv = DiscordApiEnv;

export type NicknameRequestContext = DiscordMemberActionContext;

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
  limit = GUILD_MEMBER_SEARCH_DEFAULT_LIMIT
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

  const preparedLimit = Math.max(
    GUILD_MEMBER_SEARCH_MIN_LIMIT,
    Math.min(limit, GUILD_MEMBER_SEARCH_MAX_LIMIT)
  );

  try {
    const members = await searchDiscordGuildMembers(
      env,
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
          displayName: resolveDiscordMemberDisplayName(member),
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
    const guildId = context.guildId ?? "";
    const member = await getGuildMember(env, guildId, guard.targetUserId, {
      cache: "reload"
    });
    const oldNickname = resolveDiscordMemberDisplayName(member);
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
      env,
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
    const guildId = context.guildId ?? "";
    const member = await getGuildMember(env, guildId, guard.targetUserId, {
      cache: "reload"
    });
    const oldNickname = resolveDiscordMemberDisplayName(member);
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
      env,
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
  return validateDiscordMemberActionContext(env, context, {
    targetUserId,
    missingGuildError: "Nickname changes require a server context.",
    permission: PermissionFlagsBits.ManageNicknames,
    permissionError:
      "You need Discord's Manage Nicknames permission to use this tool."
  });
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
    ...createDiscordMemberActionFailureFields(context, targetUserId),
    error
  };
}

function logNicknameOperationFailure(
  action: NicknameResponse["action"],
  error: unknown,
  context: NicknameRequestContext,
  targetUserId: string
) {
  logDiscordMemberActionFailure({
    apiLogMessage: "Discord nickname API request failed",
    operationLogMessage: "Discord nickname operation failed",
    error,
    context,
    targetUserId,
    formatError: formatNicknameError,
    extra: { action }
  });
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
  return formatDiscordMemberActionError(error, {
    forbidden:
      "Discord rejected the nickname change. The bot may be missing Manage Nicknames, or role hierarchy may block editing that member.",
    notFound: "Discord could not find that guild member.",
    validationField: "nick",
    validationErrorPrefix: "Discord rejected the nickname value",
    invalidRequest: "Discord rejected the request as invalid."
  });
}

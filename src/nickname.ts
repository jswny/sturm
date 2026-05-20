import { PermissionFlagsBits } from "discord-api-types/v10";
import {
  DiscordApiError,
  getGuildMember,
  modifyGuildMemberNickname
} from "./discord/api";
import { hasDiscordPermission } from "./discord/permissions";

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

export async function setNicknamePostfix(
  env: NicknameEnv,
  context: NicknameRequestContext,
  targetUserId: string | undefined,
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
  targetUserId?: string
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
  const resolvedTargetUserId = targetUserId?.trim() || context.userId || "";

  if (!env.DISCORD_TOKEN?.trim()) {
    return {
      targetUserId: resolvedTargetUserId,
      error: "DISCORD_TOKEN is not configured."
    };
  }

  if (!context.guildId) {
    return {
      targetUserId: resolvedTargetUserId,
      error: "Nickname changes only work in a server, not in DMs."
    };
  }

  if (!context.userId) {
    return {
      targetUserId: resolvedTargetUserId,
      error: "Could not identify the Discord user who invoked the command."
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

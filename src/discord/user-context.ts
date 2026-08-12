import type { APIRole } from "discord-api-types/v10";
import type { DiscordUserContext } from "./types";

export const MAX_DISCORD_USER_ROLE_NAMES = 20;

export function normalizeDiscordMemberJoinedAt(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;

  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime())
    ? undefined
    : timestamp.toISOString();
}

export function resolveDiscordUserRoleNames(
  user: DiscordUserContext,
  guildId: string,
  guildRoles: APIRole[]
): DiscordUserContext {
  const assignedRoleIds = new Set(user.roleIds ?? []);
  const roleNames: string[] = [];
  const seenRoleNames = new Set<string>();

  const assignedRoles = guildRoles
    .filter(
      (role) =>
        role.id !== guildId &&
        assignedRoleIds.has(role.id) &&
        Boolean(role.name.trim())
    )
    .sort((left, right) => right.position - left.position);

  for (const role of assignedRoles) {
    const roleName = normalizeDiscordRoleName(role.name);
    if (!roleName || seenRoleNames.has(roleName)) continue;

    seenRoleNames.add(roleName);
    roleNames.push(roleName);
    if (roleNames.length >= MAX_DISCORD_USER_ROLE_NAMES) break;
  }

  return removeRoleIds({
    ...user,
    roles: roleNames.length > 0 ? roleNames : undefined
  });
}

export function removeDiscordUserRoleIds(
  user: DiscordUserContext
): DiscordUserContext {
  return removeRoleIds(user);
}

function normalizeDiscordRoleName(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 100);
}

function removeRoleIds(user: DiscordUserContext) {
  const { roleIds: _roleIds, ...resolvedUser } = user;
  return resolvedUser;
}

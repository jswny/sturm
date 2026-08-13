import {
  type APIChatInputApplicationCommandInteraction,
  type APIMessageComponentInteraction,
  type APIRole
} from "discord-api-types/v10";
import { resolveDiscordMemberDisplayName } from "./display-name";
import type {
  DiscordUserIdentitySnapshot,
  DiscordUserSnapshot,
  PendingDiscordUserSnapshot
} from "./types";

const MAX_DISCORD_USER_ROLE_NAMES = 20;

type DiscordUserSnapshotInteraction =
  | APIChatInputApplicationCommandInteraction
  | APIMessageComponentInteraction;

export function createPendingDiscordUserSnapshot(
  interaction: DiscordUserSnapshotInteraction
): PendingDiscordUserSnapshot | undefined {
  const user = interaction.member?.user ?? interaction.user;
  if (!user?.id) return undefined;

  return {
    id: user.id,
    displayName: interaction.member
      ? resolveDiscordMemberDisplayName(interaction.member)
      : undefined,
    roleIds: interaction.member?.roles.filter(
      (roleId): roleId is string =>
        typeof roleId === "string" && Boolean(roleId)
    ),
    joinedAtUtc: normalizeDiscordMemberJoinedAt(interaction.member?.joined_at)
  };
}

export function createDiscordUserIdentitySnapshot(
  interaction: DiscordUserSnapshotInteraction
): DiscordUserIdentitySnapshot | undefined {
  const user = interaction.member?.user ?? interaction.user;
  if (!user?.id) return undefined;

  return {
    id: user.id,
    displayName: interaction.member
      ? resolveDiscordMemberDisplayName(interaction.member)
      : undefined
  };
}

export function hasPendingDiscordUserRoleIds(
  user: PendingDiscordUserSnapshot | DiscordUserSnapshot
): user is PendingDiscordUserSnapshot & { roleIds: string[] } {
  return "roleIds" in user && Boolean(user.roleIds?.length);
}

export function resolveDiscordUserSnapshot(
  user: PendingDiscordUserSnapshot,
  guildId: string,
  guildRoles: APIRole[]
): DiscordUserSnapshot {
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

  return {
    id: user.id,
    displayName: user.displayName,
    roles: roleNames.length > 0 ? roleNames : undefined,
    joinedAtUtc: user.joinedAtUtc
  };
}

export function toDiscordUserSnapshot(
  user: PendingDiscordUserSnapshot | DiscordUserSnapshot
): DiscordUserSnapshot {
  return {
    id: user.id,
    displayName: user.displayName,
    roles: "roles" in user ? user.roles : undefined,
    joinedAtUtc: user.joinedAtUtc
  };
}

function normalizeDiscordMemberJoinedAt(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;

  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime())
    ? undefined
    : timestamp.toISOString();
}

function normalizeDiscordRoleName(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 100);
}

import { PermissionFlagsBits } from "discord-api-types/v10";
import type { DiscordPermissionContext } from "./types";

const DISCORD_PERMISSION_LABELS = createDiscordPermissionLabels();

export function hasDiscordPermission(
  permissions: string | undefined,
  permission: bigint
) {
  const parsed = parseDiscordPermissionBits(permissions);
  if (parsed === undefined) return false;

  return (
    (parsed & PermissionFlagsBits.Administrator) ===
      PermissionFlagsBits.Administrator || (parsed & permission) === permission
  );
}

export function createDiscordPermissionContext(
  permissions: string | undefined
): DiscordPermissionContext | undefined {
  if (!permissions) return undefined;

  const parsed = parseDiscordPermissionBits(permissions);
  if (parsed === undefined) {
    return { raw: permissions, names: [] };
  }

  return {
    raw: permissions,
    names: getDiscordPermissionNames(parsed)
  };
}

export function formatDiscordPermissions(
  permissions: DiscordPermissionContext | undefined
) {
  if (!permissions) return "";
  return permissions.names.length > 0 ? permissions.names.join(", ") : "none";
}

export function getDiscordPermissionNames(permissions: bigint) {
  return DISCORD_PERMISSION_LABELS.filter(
    ([permission]) => (permissions & permission) === permission
  ).map(([, label]) => label);
}

export function parseDiscordPermissionBits(permissions: string | undefined) {
  if (!permissions) return undefined;

  try {
    return BigInt(permissions);
  } catch {
    return undefined;
  }
}

function createDiscordPermissionLabels(): Array<[bigint, string]> {
  const labelsByValue = new Map<bigint, string>();

  for (const [name, value] of Object.entries(PermissionFlagsBits)) {
    if (typeof value === "bigint") {
      labelsByValue.set(value, name);
    }
  }

  return Array.from(labelsByValue.entries()).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}

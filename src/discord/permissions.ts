import { PermissionFlagsBits } from "discord-api-types/v10";
import type { DiscordPermissionContext } from "./types";

const DISCORD_PERMISSION_LABELS = createDiscordPermissionLabels();

type DiscordPermissionRequirement = { ok: true } | { ok: false; error: string };

export function hasDiscordPermission(
  permissions: string | undefined,
  permission: bigint
) {
  const parsed = parseDiscordPermissionBits(permissions);
  return hasParsedDiscordPermission(parsed, permission);
}

export function requireDiscordPermission(
  permissions: string | undefined,
  permission: bigint,
  options: { deniedMessage: string; permissionLabel?: string }
): DiscordPermissionRequirement {
  const parsed = parseDiscordPermissionBits(permissions);
  if (hasParsedDiscordPermission(parsed, permission)) return { ok: true };

  const requiredPermission =
    options.permissionLabel ?? getDiscordPermissionDisplayName(permission);

  return {
    ok: false,
    error: [
      `Permission denied: ${formatSentence(options.deniedMessage)}`,
      `Required permission: ${requiredPermission}. Administrator also satisfies this requirement.`,
      `Caller permissions: ${formatDeniedCallerPermissions(permissions, parsed)}.`
    ].join(" ")
  };
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

function hasParsedDiscordPermission(
  parsed: bigint | undefined,
  permission: bigint
) {
  if (parsed === undefined) return false;

  return (
    (parsed & PermissionFlagsBits.Administrator) ===
      PermissionFlagsBits.Administrator || (parsed & permission) === permission
  );
}

function getDiscordPermissionDisplayName(permission: bigint) {
  const label = DISCORD_PERMISSION_LABELS.find(
    ([value]) => value === permission
  )?.[1];

  return label
    ? formatDiscordPermissionName(label)
    : `permission ${permission}`;
}

function formatDeniedCallerPermissions(
  permissions: string | undefined,
  parsed: bigint | undefined
) {
  if (!permissions) return "unavailable";
  if (parsed === undefined) {
    return `unrecognized permission bitset: ${permissions}`;
  }

  const names = getDiscordPermissionNames(parsed).map(
    formatDiscordPermissionName
  );
  return names.length > 0 ? names.join(", ") : "none";
}

function formatDiscordPermissionName(name: string) {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

function formatSentence(value: string) {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

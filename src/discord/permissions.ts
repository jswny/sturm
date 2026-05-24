import { PermissionFlagsBits } from "discord-api-types/v10";

export function hasDiscordPermission(
  permissions: string | undefined,
  permission: bigint
) {
  if (!permissions) return false;

  try {
    const parsed = BigInt(permissions);
    return (
      (parsed & PermissionFlagsBits.Administrator) ===
        PermissionFlagsBits.Administrator ||
      (parsed & permission) === permission
    );
  } catch {
    return false;
  }
}

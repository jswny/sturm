import type { DiscordUserSnapshot } from "./types";

export function formatDiscordUserSnapshot(
  snapshot: DiscordUserSnapshot | undefined
) {
  const lines = ["Discord user:"];
  if (snapshot?.id) lines.push(`id: ${snapshot.id}`);
  if (snapshot?.displayName) {
    lines.push(`display_name: ${snapshot.displayName}`);
  }
  if (snapshot?.roles?.length) {
    lines.push(`roles: ${JSON.stringify(snapshot.roles)}`);
  }
  if (snapshot?.joinedAtUtc) {
    lines.push(`joined_at_utc: ${snapshot.joinedAtUtc}`);
  }
  return lines.join("\n");
}

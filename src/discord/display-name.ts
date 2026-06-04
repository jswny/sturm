type DiscordDisplayNameUser = {
  username: string;
  global_name?: string | null;
};

type DiscordDisplayNameMember = {
  nick?: string | null;
  user: DiscordDisplayNameUser;
};

export function resolveDiscordMemberDisplayName(
  member: DiscordDisplayNameMember
) {
  return (
    cleanDisplayName(member.nick) ??
    cleanDisplayName(member.user.global_name) ??
    member.user.username
  );
}

function cleanDisplayName(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

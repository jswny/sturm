import { getGuildMember, type DiscordApiEnv } from "./api";
import { resolveDiscordMemberDisplayName } from "./display-name";
import type { DiscordChannelMessage } from "./message-format";

export async function resolveDiscordMessageAuthorDisplayNames(
  env: DiscordApiEnv,
  guildId: string | undefined,
  messages: readonly DiscordChannelMessage[],
  maxWaitMs: number
) {
  if (!guildId) return new Map<string, string>();

  const authorIds = [
    ...new Set(
      messages
        .filter((message) => !message.webhook_id)
        .map((message) => message.author.id)
    )
  ];
  const results = await Promise.all(
    authorIds.map(async (authorId) => {
      try {
        const member = await getGuildMember(env, guildId, authorId, {
          maxWaitMs
        });
        return [authorId, resolveDiscordMemberDisplayName(member)] as const;
      } catch {
        return undefined;
      }
    })
  );

  return new Map(results.filter((entry) => entry !== undefined));
}

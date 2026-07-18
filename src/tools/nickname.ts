import { tool } from "ai";
import { z } from "zod";
import {
  GUILD_MEMBER_SEARCH_DEFAULT_LIMIT,
  GUILD_MEMBER_SEARCH_MAX_LIMIT,
  GUILD_MEMBER_SEARCH_MIN_LIMIT,
  clearNicknamePostfix,
  setNicknamePostfix,
  searchGuildMembers,
  type NicknameEnv,
  type NicknameRequestContext
} from "../nickname";

const nicknameResponseSchema = z.object({
  ok: z.boolean().describe("Whether the nickname operation succeeded"),
  action: z.enum(["set", "cleared"]),
  guildId: z.string().optional(),
  callerUserId: z.string().optional(),
  targetUserId: z.string().optional(),
  oldNickname: z.string().optional(),
  baseNickname: z.string().optional(),
  postfix: z.string().optional(),
  convertedPostfix: z.string().optional(),
  newNickname: z.string().optional(),
  changed: z.boolean().optional(),
  error: z.string().optional()
});

const guildMemberSearchResponseSchema = z.object({
  ok: z.boolean().describe("Whether the guild member search succeeded"),
  guildId: z.string().optional(),
  query: z.string(),
  results: z
    .array(
      z.object({
        id: z.string().describe("Discord user ID"),
        username: z.string(),
        globalName: z.string().optional(),
        nickname: z.string().optional(),
        displayName: z.string(),
        bot: z.boolean()
      })
    )
    .optional(),
  error: z.string().optional()
});

type NicknameToolResponse = z.infer<typeof nicknameResponseSchema>;
type GuildMemberSearchToolResponse = z.infer<
  typeof guildMemberSearchResponseSchema
>;

export function createNicknameTools(
  env: NicknameEnv,
  context: NicknameRequestContext
) {
  return {
    searchGuildMembers: tool({
      description:
        "Search for Discord guild members in the current server by username or nickname prefix. Use this to resolve a person's name into a Discord user ID before calling nickname or moderation tools. If there are multiple plausible matches, ask the user which member they meant.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe("Username or guild nickname prefix to search for"),
        limit: z
          .number()
          .int()
          .min(GUILD_MEMBER_SEARCH_MIN_LIMIT)
          .max(GUILD_MEMBER_SEARCH_MAX_LIMIT)
          .default(GUILD_MEMBER_SEARCH_DEFAULT_LIMIT)
          .describe(
            `Maximum number of matches to return, from ${GUILD_MEMBER_SEARCH_MIN_LIMIT} to ${GUILD_MEMBER_SEARCH_MAX_LIMIT} inclusive`
          )
      }),
      outputSchema: guildMemberSearchResponseSchema,
      execute: async ({ query, limit }) =>
        searchGuildMembers(env, context, query, limit),
      toModelOutput: ({ output }) => ({
        type: "text",
        value: formatGuildMemberSearchOutput(output)
      })
    }),
    setNicknamePostfix: tool({
      description:
        "Set or replace the managed Discord nickname postfix for a guild member. The tool preserves the member's base nickname and replaces any existing managed postfix with the requested postfix; it does not stack multiple postfixes. Requires the /c caller to have Discord's Manage Nicknames permission. targetUserId is required; use a raw Discord user ID. If the user provided a mention like <@123>, use 123. If the user provided a name, call searchGuildMembers first to resolve it.",
      inputSchema: z.object({
        targetUserId: z.string().min(1).describe("Discord user ID to edit"),
        postfix: z
          .string()
          .min(1)
          .describe(
            "The managed nickname postfix to set. Replaces any existing managed postfix while preserving the user's base nickname."
          )
      }),
      outputSchema: nicknameResponseSchema,
      execute: async ({ targetUserId, postfix }) =>
        setNicknamePostfix(env, context, targetUserId, postfix),
      toModelOutput: ({ output }) => ({
        type: "text",
        value: formatNicknameOutput(output)
      })
    }),
    clearNicknamePostfix: tool({
      description:
        "Clear a Discord nickname postfix for a guild member. Requires the /c caller to have Discord's Manage Nicknames permission. targetUserId is required; use a raw Discord user ID. If the user provided a mention like <@123>, use 123. If the user provided a name, call searchGuildMembers first to resolve it.",
      inputSchema: z.object({
        targetUserId: z.string().min(1).describe("Discord user ID to edit")
      }),
      outputSchema: nicknameResponseSchema,
      execute: async ({ targetUserId }) =>
        clearNicknamePostfix(env, context, targetUserId),
      toModelOutput: ({ output }) => ({
        type: "text",
        value: formatNicknameOutput(output)
      })
    })
  };
}

function formatGuildMemberSearchOutput(output: GuildMemberSearchToolResponse) {
  if (!output.ok) {
    return `Guild member search failed: ${output.error ?? "Unknown error."}`;
  }

  const results = output.results ?? [];
  if (results.length === 0) {
    return `No guild members matched "${output.query}".`;
  }

  return [
    `Guild member search results for "${output.query}": ${results.length}`,
    ...results.map((member) =>
      [
        `- displayName: ${member.displayName}`,
        `userId: ${member.id}`,
        `username: ${member.username}`,
        member.nickname ? `nickname: ${member.nickname}` : undefined,
        member.globalName ? `globalName: ${member.globalName}` : undefined,
        member.bot ? "bot: yes" : undefined
      ]
        .filter(Boolean)
        .join("; ")
    ),
    "Final response guidance: if exactly one result is clearly the intended person, use userId for follow-up Discord tools. If multiple matches are plausible, ask the user to choose."
  ].join("\n");
}

function formatNicknameOutput(output: NicknameToolResponse) {
  if (!output.ok) {
    return `Nickname ${output.action} failed: ${output.error ?? "Unknown error."}`;
  }

  const lines = [`Nickname postfix ${output.action}.`];
  if (output.targetUserId) lines.push(`targetUserId: ${output.targetUserId}`);
  if (output.oldNickname) lines.push(`oldNickname: ${output.oldNickname}`);
  if (output.baseNickname) lines.push(`baseNickname: ${output.baseNickname}`);
  if (output.postfix) lines.push(`postfix: ${output.postfix}`);
  if (output.convertedPostfix) {
    lines.push(`convertedPostfix: ${output.convertedPostfix}`);
  }
  if (output.newNickname) lines.push(`newNickname: ${output.newNickname}`);
  if (output.changed !== undefined) {
    lines.push(`changed: ${output.changed ? "yes" : "no"}`);
  }
  lines.push(
    "Final response guidance: briefly confirm the nickname result. Do not expose caller/guild internals unless the user explicitly asks for diagnostics."
  );
  return lines.join("\n");
}

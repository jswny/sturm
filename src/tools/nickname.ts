import { tool } from "ai";
import { z } from "zod";
import {
  clearNicknamePostfix,
  setNicknamePostfix,
  type NicknameEnv,
  type NicknameRequestContext,
  type NicknameResponse
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

export function createNicknameTools(
  env: NicknameEnv,
  context: NicknameRequestContext
) {
  return {
    setNicknamePostfix: tool({
      description:
        "Set a Discord nickname postfix for a guild member. Requires the /c caller to have Discord's Manage Nicknames permission. Use a Discord user ID for targetUserId; if the user provided a mention like <@123>, use 123. If no target is specified and the user is asking about themselves, omit targetUserId to target the caller.",
      inputSchema: z.object({
        targetUserId: z
          .string()
          .optional()
          .describe(
            "Discord user ID to edit. Omit only when the target is the /c caller."
          ),
        postfix: z
          .string()
          .min(1)
          .describe("The nickname postfix to append after the user's base name")
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
        "Clear a Discord nickname postfix for a guild member. Requires the /c caller to have Discord's Manage Nicknames permission. Use a Discord user ID for targetUserId; if the user provided a mention like <@123>, use 123. If no target is specified and the user is asking about themselves, omit targetUserId to target the caller.",
      inputSchema: z.object({
        targetUserId: z
          .string()
          .optional()
          .describe(
            "Discord user ID to edit. Omit only when the target is the /c caller."
          )
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

function formatNicknameOutput(output: NicknameResponse) {
  if (!output.ok) {
    return `Nickname ${output.action} failed: ${output.error}`;
  }

  if (output.action === "cleared" && !output.changed) {
    return "No nickname postfix was set, so nothing changed.";
  }

  if (output.action === "cleared") {
    return `Nickname postfix cleared. New nickname: ${output.newNickname}`;
  }

  return [
    "Nickname postfix set.",
    `Target user ID: ${output.targetUserId}`,
    `Base nickname: ${output.baseNickname}`,
    `Postfix: ${output.postfix}`,
    `Converted postfix: ${output.convertedPostfix}`,
    `New nickname: ${output.newNickname}`
  ].join("\n");
}

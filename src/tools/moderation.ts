import { tool } from "ai";
import { z } from "zod";
import {
  MODERATION_REASON_MAX_CHARS,
  MODERATION_REASON_MIN_CHARS,
  muteGuildMember,
  unmuteGuildMember,
  type ModerationEnv,
  type ModerationRequestContext
} from "../moderation";

const MIN_TEMPORARY_MUTE_SECONDS = 60;
const MAX_TEMPORARY_MUTE_DAYS = 28;
const MAX_TEMPORARY_MUTE_SECONDS = MAX_TEMPORARY_MUTE_DAYS * 24 * 60 * 60;
const TEMPORARY_MUTE_DURATION_DESCRIPTION = `Temporary mute duration in seconds, from ${MIN_TEMPORARY_MUTE_SECONDS} to ${MAX_TEMPORARY_MUTE_SECONDS} inclusive (${MAX_TEMPORARY_MUTE_DAYS} days). If the user did not specify a duration, choose an appropriate value within this range based on the request and reason.`;
const MODERATION_REASON_DESCRIPTION = `Short justification, from ${MODERATION_REASON_MIN_CHARS} to ${MODERATION_REASON_MAX_CHARS} characters`;

const moderationResponseFields = {
  ok: z.boolean(),
  guildId: z.string().optional(),
  callerUserId: z.string().optional(),
  targetUserId: z.string().optional(),
  targetDisplayName: z.string().optional(),
  reason: z.string().optional(),
  error: z.string().optional()
};

const muteResponseSchema = z.object({
  ...moderationResponseFields,
  ok: moderationResponseFields.ok.describe(
    "Whether the temporary mute succeeded"
  ),
  action: z.literal("muted"),
  durationSeconds: z.number().int().optional(),
  communicationDisabledUntil: z.string().optional()
});

const unmuteResponseSchema = z.object({
  ...moderationResponseFields,
  ok: moderationResponseFields.ok.describe("Whether the unmute succeeded"),
  action: z.literal("unmuted")
});

export function createModerationTools(
  env: ModerationEnv,
  context: ModerationRequestContext
) {
  return {
    muteGuildMember: tool({
      description: `Temporarily mute, also called timeout, a Discord guild member. Requires the /c caller to have Discord's Moderate Members permission. targetUserId is required; use a raw Discord user ID. If the user provided a mention like <@123>, use 123. If the user provided a name, call searchGuildMembers first to resolve it. If the user did not specify a duration, choose an appropriate duration from ${MIN_TEMPORARY_MUTE_SECONDS} to ${MAX_TEMPORARY_MUTE_SECONDS} seconds inclusive (${MAX_TEMPORARY_MUTE_DAYS} days) based on the request and reason.`,
      inputSchema: z.object({
        targetUserId: z.string().min(1).describe("Discord user ID to mute"),
        durationSeconds: z
          .number()
          .int()
          .min(MIN_TEMPORARY_MUTE_SECONDS)
          .max(MAX_TEMPORARY_MUTE_SECONDS)
          .describe(TEMPORARY_MUTE_DURATION_DESCRIPTION),
        reason: z
          .string()
          .min(MODERATION_REASON_MIN_CHARS)
          .max(MODERATION_REASON_MAX_CHARS)
          .describe(MODERATION_REASON_DESCRIPTION)
      }),
      outputSchema: muteResponseSchema,
      execute: async ({ targetUserId, durationSeconds, reason }) =>
        muteGuildMember(env, context, targetUserId, durationSeconds, reason)
    }),
    unmuteGuildMember: tool({
      description:
        "Remove an active Discord temporary mute, also called a timeout, from a guild member. This only clears Discord's communication timeout; it does not change roles or channel-specific permission overwrites. Requires the /c caller to have Discord's Moderate Members permission. targetUserId is required; use a raw Discord user ID. If the user provided a mention like <@123>, use 123. If the user provided a name, call searchGuildMembers first to resolve it.",
      inputSchema: z.object({
        targetUserId: z.string().min(1).describe("Discord user ID to unmute"),
        reason: z
          .string()
          .min(MODERATION_REASON_MIN_CHARS)
          .max(MODERATION_REASON_MAX_CHARS)
          .describe(MODERATION_REASON_DESCRIPTION)
      }),
      outputSchema: unmuteResponseSchema,
      execute: async ({ targetUserId, reason }) =>
        unmuteGuildMember(env, context, targetUserId, reason)
    })
  };
}

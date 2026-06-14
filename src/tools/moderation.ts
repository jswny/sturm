import { tool } from "ai";
import { z } from "zod";
import {
  muteGuildMember,
  unmuteGuildMember,
  type ModerationEnv,
  type ModerationRequestContext,
  type MuteResponse,
  type UnmuteResponse
} from "../moderation";

type ModerationToolResponse = MuteResponse | UnmuteResponse;

const MIN_TEMPORARY_MUTE_SECONDS = 60;
const MAX_TEMPORARY_MUTE_SECONDS = 28 * 24 * 60 * 60;

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
      description:
        "Temporarily mute, also called timeout, a Discord guild member. Requires the /c caller to have Discord's Moderate Members permission. targetUserId is required; use a raw Discord user ID. If the user provided a mention like <@123>, use 123. If the user provided a name, call searchGuildMembers first to resolve it. If the user did not specify a duration, choose an appropriate duration within the durationSeconds schema range based on the request and reason.",
      inputSchema: z.object({
        targetUserId: z.string().min(1).describe("Discord user ID to mute"),
        durationSeconds: z
          .number()
          .int()
          .min(MIN_TEMPORARY_MUTE_SECONDS)
          .max(MAX_TEMPORARY_MUTE_SECONDS)
          .describe(
            "Temporary mute duration in seconds. If the user did not specify a duration, choose an appropriate value within this field's schema limits based on the request and reason."
          ),
        reason: z
          .string()
          .min(1)
          .max(200)
          .describe("Short justification for the mute")
      }),
      outputSchema: muteResponseSchema,
      execute: async ({ targetUserId, durationSeconds, reason }) =>
        muteGuildMember(env, context, targetUserId, durationSeconds, reason),
      toModelOutput: ({ output }) => ({
        type: "text",
        value: formatModerationOutput(output, {
          failurePrefix: "Temporary mute failed",
          successHeader: "Temporary mute applied.",
          extraLines: [
            `Duration: ${output.durationSeconds} seconds`,
            `Muted until: ${output.communicationDisabledUntil}`
          ]
        })
      })
    }),
    unmuteGuildMember: tool({
      description:
        "Remove an active Discord temporary mute, also called a timeout, from a guild member. This only clears Discord's communication timeout; it does not change roles or channel-specific permission overwrites. Requires the /c caller to have Discord's Moderate Members permission. targetUserId is required; use a raw Discord user ID. If the user provided a mention like <@123>, use 123. If the user provided a name, call searchGuildMembers first to resolve it.",
      inputSchema: z.object({
        targetUserId: z.string().min(1).describe("Discord user ID to unmute"),
        reason: z
          .string()
          .min(1)
          .max(200)
          .describe("Short justification for the unmute")
      }),
      outputSchema: unmuteResponseSchema,
      execute: async ({ targetUserId, reason }) =>
        unmuteGuildMember(env, context, targetUserId, reason),
      toModelOutput: ({ output }) => ({
        type: "text",
        value: formatModerationOutput(output, {
          failurePrefix: "Unmute failed",
          successHeader: "Unmute applied."
        })
      })
    })
  };
}

function formatModerationOutput(
  output: ModerationToolResponse,
  options: {
    failurePrefix: string;
    successHeader: string;
    extraLines?: string[];
  }
) {
  if (!output.ok) {
    return `${options.failurePrefix}: ${output.error}`;
  }

  return [
    options.successHeader,
    `Target user ID: ${output.targetUserId}`,
    output.targetDisplayName
      ? `Target display name: ${output.targetDisplayName}`
      : "",
    ...(options.extraLines ?? []),
    `Reason: ${output.reason}`
  ]
    .filter(Boolean)
    .join("\n");
}

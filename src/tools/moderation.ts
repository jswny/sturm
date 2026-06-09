import { tool } from "ai";
import { z } from "zod";
import {
  temporarilyMuteGuildMember,
  type ModerationEnv,
  type ModerationRequestContext,
  type TemporaryMuteResponse
} from "../moderation";

const temporaryMuteResponseSchema = z.object({
  ok: z.boolean().describe("Whether the temporary mute succeeded"),
  action: z.literal("muted"),
  guildId: z.string().optional(),
  callerUserId: z.string().optional(),
  targetUserId: z.string().optional(),
  targetDisplayName: z.string().optional(),
  durationSeconds: z.number().int().optional(),
  communicationDisabledUntil: z.string().optional(),
  reason: z.string().optional(),
  error: z.string().optional()
});

export function createModerationTools(
  env: ModerationEnv,
  context: ModerationRequestContext
) {
  return {
    temporarilyMuteGuildMember: tool({
      description:
        "Temporarily mute, also called timeout, a Discord guild member for up to 1 hour. Requires the /c caller to have Discord's Moderate Members permission. targetUserId is required; use a raw Discord user ID. If the user provided a mention like <@123>, use 123. If the user provided a name, call searchGuildMembers first to resolve it. If the user did not specify a duration, choose an appropriate duration up to the 1-hour cap based on the request and reason.",
      inputSchema: z.object({
        targetUserId: z.string().min(1).describe("Discord user ID to mute"),
        durationSeconds: z
          .number()
          .int()
          .min(5)
          .max(3600)
          .describe(
            "Temporary mute duration from 5 to 3600 seconds. If the user did not specify a duration, choose an appropriate duration up to the 1-hour cap based on the request and reason."
          ),
        reason: z
          .string()
          .min(1)
          .max(200)
          .describe("Short justification for the mute")
      }),
      outputSchema: temporaryMuteResponseSchema,
      execute: async ({ targetUserId, durationSeconds, reason }) =>
        temporarilyMuteGuildMember(
          env,
          context,
          targetUserId,
          durationSeconds,
          reason
        ),
      toModelOutput: ({ output }) => ({
        type: "text",
        value: formatTemporaryMuteOutput(output)
      })
    })
  };
}

function formatTemporaryMuteOutput(output: TemporaryMuteResponse) {
  if (!output.ok) {
    return `Temporary mute failed: ${output.error}`;
  }

  return [
    "Temporary mute applied.",
    `Target user ID: ${output.targetUserId}`,
    output.targetDisplayName
      ? `Target display name: ${output.targetDisplayName}`
      : "",
    `Duration: ${output.durationSeconds} seconds`,
    `Muted until: ${output.communicationDisabledUntil}`,
    `Reason: ${output.reason}`
  ]
    .filter(Boolean)
    .join("\n");
}

import { tool } from "ai";
import { z } from "zod";
import {
  EMOJI_NAME_MAX_CHARS,
  EMOJI_NAME_MIN_CHARS,
  createGuildEmojiFromArtifact,
  type CreateEmojiFromArtifactResponse,
  type EmojiEnv,
  type EmojiRequestContext
} from "../emojis";

const EMOJI_INPUT_NAME_MAX_CHARS = 64;

const createEmojiResponseSchema = z.object({
  ok: z.boolean().describe("Whether the emoji was created"),
  action: z.literal("created_emoji"),
  emojiId: z.string().optional().describe("Created Discord emoji ID"),
  guildId: z.string().optional().describe("Discord guild ID"),
  callerUserId: z.string().optional().describe("Discord user ID of the caller"),
  sourceArtifactId: z.string().optional().describe("Source artifact ID"),
  sourceArtifactSource: z
    .string()
    .optional()
    .describe("Source artifact provenance"),
  sourceFilename: z.string().optional().describe("Source artifact filename"),
  name: z.string().optional().describe("Created emoji name"),
  shortcode: z.string().optional().describe("Created emoji shortcode"),
  mention: z.string().optional().describe("Created custom emoji mention text"),
  processedMimeType: z
    .literal("image/png")
    .optional()
    .describe("Processed emoji MIME type"),
  processedSizeBytes: z
    .number()
    .int()
    .optional()
    .describe("Processed emoji byte size"),
  width: z.literal(128).optional().describe("Processed emoji width"),
  height: z.literal(128).optional().describe("Processed emoji height"),
  error: z.string().optional().describe("Error message when creation failed")
});

export function createEmojiTools(env: EmojiEnv, context: EmojiRequestContext) {
  return {
    createGuildEmojiFromArtifact: tool({
      description:
        "Create a static Discord guild emoji from an image artifact. Use the listed artifact_id. Use only when the user provides an emoji name or the request makes one obvious; a normal text follow-up is fine if the later tool call uses the same durable artifact_id. The caller must have Discord's Create Guild Expressions permission. The tool resizes without cropping to a 128x128 transparent PNG, sanitizes the supplied name to Discord's emoji name format, and uploads it to the current guild.",
      inputSchema: z.object({
        artifact_id: z
          .string()
          .min(1)
          .describe("artifact_id for an image artifact."),
        name: z
          .string()
          .min(EMOJI_NAME_MIN_CHARS)
          .max(EMOJI_INPUT_NAME_MAX_CHARS)
          .optional()
          .describe(
            `Semantic emoji name from the user request, from ${EMOJI_NAME_MIN_CHARS} to ${EMOJI_INPUT_NAME_MAX_CHARS} characters before sanitization. Spaces are allowed; the final Discord emoji name is sanitized and capped at ${EMOJI_NAME_MAX_CHARS} characters.`
          )
      }),
      outputSchema: createEmojiResponseSchema,
      execute: async (input) =>
        createGuildEmojiFromArtifact(env, context, {
          artifactId: input.artifact_id,
          name: input.name
        }),
      toModelOutput: ({ output }) => ({
        type: "text",
        value: formatCreateEmojiOutput(output)
      })
    })
  };
}

function formatCreateEmojiOutput(output: CreateEmojiFromArtifactResponse) {
  if (!output.ok) {
    return `Emoji creation failed: ${output.error}`;
  }

  return [
    "Emoji created.",
    `Emoji ID: ${output.emojiId}`,
    `Name: ${output.name}`,
    `Shortcode: ${output.shortcode}`,
    output.mention ? `Mention: ${output.mention}` : "",
    `Source artifact: ${output.sourceFilename} (${output.sourceArtifactId}, ${output.sourceArtifactSource})`,
    `Processed size: ${output.processedSizeBytes} bytes`,
    "The emoji is now available in the current Discord server."
  ]
    .filter(Boolean)
    .join("\n");
}

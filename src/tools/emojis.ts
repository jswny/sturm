import { tool } from "ai";
import { z } from "zod";
import {
  EMOJI_NAME_MAX_CHARS,
  EMOJI_NAME_MIN_CHARS,
  createGuildEmojiFromArtifact,
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
        "Create a static Discord guild emoji from an image artifact. Use the listed artifactId. Use only when the user provides an emoji name or the request makes one obvious; a normal text follow-up is fine if the later tool call uses the same durable artifactId. The caller must have Discord's Create Guild Expressions permission. The tool resizes without cropping to a 128x128 transparent PNG, sanitizes the supplied name to Discord's emoji name format, and uploads it to the current guild. After a successful call, treat the emoji as available in the current Discord server. In the final response, mention the emoji by name, shortcode, or mention when useful; do not expose source artifact IDs or internal processing details unless the user explicitly asks for diagnostic details.",
      inputSchema: z.object({
        artifactId: z
          .string()
          .min(1)
          .describe("artifactId for an image artifact."),
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
          artifactId: input.artifactId,
          name: input.name
        })
    })
  };
}

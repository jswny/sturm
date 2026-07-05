import { tool } from "ai";
import { z } from "zod";
import {
  STICKER_DESCRIPTION_MAX_CHARS,
  STICKER_DESCRIPTION_MIN_CHARS,
  STICKER_NAME_MAX_CHARS,
  STICKER_NAME_MIN_CHARS,
  STICKER_TAGS_MAX_TOTAL_CHARS,
  createGuildStickerFromArtifact,
  type StickerEnv,
  type StickerRequestContext
} from "../stickers";

const STICKER_TAG_MIN_CHARS = 1;
const STICKER_TAG_MAX_CHARS = 50;
const STICKER_TAG_MAX_COUNT = 20;

const createStickerResponseSchema = z.object({
  ok: z.boolean().describe("Whether the sticker was created"),
  action: z.literal("created_sticker"),
  stickerId: z.string().optional().describe("Created Discord sticker ID"),
  guildId: z.string().optional().describe("Discord guild ID"),
  callerUserId: z.string().optional().describe("Discord user ID of the caller"),
  sourceArtifactId: z.string().optional().describe("Source artifact ID"),
  sourceArtifactSource: z
    .string()
    .optional()
    .describe("Source artifact provenance"),
  sourceFilename: z.string().optional().describe("Source artifact filename"),
  name: z.string().optional().describe("Created sticker name"),
  description: z.string().optional().describe("Created sticker description"),
  tags: z.array(z.string()).optional().describe("Created sticker tags"),
  processedMimeType: z
    .literal("image/png")
    .optional()
    .describe("Processed sticker MIME type"),
  processedSizeBytes: z
    .number()
    .int()
    .optional()
    .describe("Processed sticker byte size"),
  width: z.literal(320).optional().describe("Processed sticker width"),
  height: z.literal(320).optional().describe("Processed sticker height"),
  error: z.string().optional().describe("Error message when creation failed")
});

const createStickerInputSchema = z.object({
  artifactId: z.string().min(1).describe("artifactId for an image artifact."),
  name: z
    .string()
    .min(STICKER_NAME_MIN_CHARS)
    .max(STICKER_NAME_MAX_CHARS)
    .optional()
    .describe(
      `Discord sticker name, from ${STICKER_NAME_MIN_CHARS} to ${STICKER_NAME_MAX_CHARS} characters after sanitization`
    ),
  description: z
    .string()
    .min(STICKER_DESCRIPTION_MIN_CHARS)
    .max(STICKER_DESCRIPTION_MAX_CHARS)
    .optional()
    .describe(
      `Short sticker description inferred from the request, from ${STICKER_DESCRIPTION_MIN_CHARS} to ${STICKER_DESCRIPTION_MAX_CHARS} characters`
    ),
  tags: z
    .array(z.string().min(STICKER_TAG_MIN_CHARS).max(STICKER_TAG_MAX_CHARS))
    .max(STICKER_TAG_MAX_COUNT)
    .optional()
    .describe(
      `Optional Discord search tags for this sticker; provide up to ${STICKER_TAG_MAX_COUNT} short tags totaling at most ${STICKER_TAGS_MAX_TOTAL_CHARS} characters when comma-separated. Sturm will infer tags from the sticker name when omitted.`
    )
});

export function createStickerTools(
  env: StickerEnv,
  context: StickerRequestContext
) {
  return {
    createGuildStickerFromArtifact: tool({
      description:
        "Create a static Discord guild sticker from an image artifact. Use the listed artifactId. Use only when the user provides a sticker name or the request makes one obvious; a normal text follow-up is fine if the later tool call uses the same durable artifactId. The caller must have Discord's Create Guild Expressions permission. The tool resizes without cropping to a 320x320 transparent PNG and uploads it to the current guild. Infer a description and tags when the user does not provide them. After a successful call, treat the sticker as available in the current Discord server. In the final response, mention the sticker by name when useful; do not expose source artifact IDs or internal processing details unless the user explicitly asks for diagnostic details.",
      inputSchema: createStickerInputSchema,
      outputSchema: createStickerResponseSchema,
      execute: async (input) =>
        createGuildStickerFromArtifact(env, context, {
          artifactId: input.artifactId,
          name: input.name,
          description: input.description,
          tags: input.tags
        })
    })
  };
}

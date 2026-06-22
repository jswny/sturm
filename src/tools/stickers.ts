import { tool } from "ai";
import { z } from "zod";
import {
  STICKER_DESCRIPTION_MAX_CHARS,
  STICKER_DESCRIPTION_MIN_CHARS,
  STICKER_NAME_MAX_CHARS,
  STICKER_NAME_MIN_CHARS,
  STICKER_TAGS_MAX_TOTAL_CHARS,
  createGuildStickerFromAttachment,
  type CreateStickerFromAttachmentResponse,
  type StickerEnv,
  type StickerRequestContext
} from "../stickers";

const STICKER_TAG_MIN_CHARS = 1;
const STICKER_TAG_MAX_CHARS = 50;
const STICKER_TAG_MIN_COUNT = 1;
const STICKER_TAG_MAX_COUNT = 20;

const createStickerResponseSchema = z.object({
  ok: z.boolean().describe("Whether the sticker was created"),
  action: z.literal("created_sticker"),
  stickerId: z.string().optional().describe("Created Discord sticker ID"),
  guildId: z.string().optional().describe("Discord guild ID"),
  callerUserId: z.string().optional().describe("Discord user ID of the caller"),
  sourceAttachmentId: z.string().optional().describe("Source /c attachment ID"),
  sourceFilename: z.string().optional().describe("Source attachment filename"),
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

export function createStickerTools(
  env: StickerEnv,
  context: StickerRequestContext
) {
  return {
    createGuildStickerFromAttachment: tool({
      description:
        "Create a static Discord guild sticker from one image attachment on the current /c request. Use only when the user provides a sticker name or the request makes one obvious; otherwise ask for a name first. The caller must have Discord's Create Guild Expressions permission. The tool resizes without cropping to a 320x320 transparent PNG and uploads it to the current guild. Infer a description and one or more short Discord search tags when the user does not provide them; tags are required and must not be omitted.",
      inputSchema: z.object({
        attachmentId: z
          .string()
          .min(1)
          .describe("ID of the current /c image attachment to use"),
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
          .array(
            z.string().min(STICKER_TAG_MIN_CHARS).max(STICKER_TAG_MAX_CHARS)
          )
          .min(STICKER_TAG_MIN_COUNT)
          .max(STICKER_TAG_MAX_COUNT)
          .describe(
            `One or more short Discord search tags for this sticker; provide ${STICKER_TAG_MIN_COUNT} to ${STICKER_TAG_MAX_COUNT} tags, each ${STICKER_TAG_MIN_CHARS} to ${STICKER_TAG_MAX_CHARS} characters, totaling at most ${STICKER_TAGS_MAX_TOTAL_CHARS} characters when comma-separated. Infer them from the user request and image when not explicitly provided.`
          )
      }),
      outputSchema: createStickerResponseSchema,
      execute: async (input) =>
        createGuildStickerFromAttachment(env, context, input),
      toModelOutput: ({ output }) => ({
        type: "text",
        value: formatCreateStickerOutput(output)
      })
    })
  };
}

function formatCreateStickerOutput(
  output: CreateStickerFromAttachmentResponse
) {
  if (!output.ok) {
    return `Sticker creation failed: ${output.error}`;
  }

  return [
    "Sticker created.",
    `Sticker ID: ${output.stickerId}`,
    `Name: ${output.name}`,
    `Description: ${output.description}`,
    `Tags: ${output.tags?.join(", ")}`,
    `Source attachment: ${output.sourceFilename} (${output.sourceAttachmentId})`,
    `Processed size: ${output.processedSizeBytes} bytes`,
    "The sticker is now available in the current Discord server."
  ]
    .filter(Boolean)
    .join("\n");
}

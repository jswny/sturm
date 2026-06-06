import { tool } from "ai";
import { z } from "zod";
import {
  createGuildStickerFromAttachment,
  type CreateStickerFromAttachmentResponse,
  type StickerEnv,
  type StickerRequestContext
} from "../stickers";

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
        "Create a static Discord guild sticker from one image attachment on the current /c request. Use only when the user provides a sticker name or the request makes one obvious; otherwise ask for a name first. The caller must have Discord's Create Guild Expressions permission. The tool resizes without cropping to a 320x320 transparent PNG and uploads it to the current guild. Infer description and tags when the user does not provide them.",
      inputSchema: z.object({
        attachmentId: z
          .string()
          .min(1)
          .describe("ID of the current /c image attachment to use"),
        name: z
          .string()
          .min(2)
          .max(30)
          .optional()
          .describe("Discord sticker name"),
        description: z
          .string()
          .min(2)
          .max(100)
          .optional()
          .describe("Short sticker description inferred from the request"),
        tags: z
          .array(z.string().min(1).max(50))
          .max(20)
          .optional()
          .describe("Search tags inferred from the sticker name and request")
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

import { tool } from "ai";
import { z } from "zod";
import {
  createGuildEmojiFromAttachment,
  type CreateEmojiFromAttachmentResponse,
  type EmojiEnv,
  type EmojiRequestContext
} from "../emojis";

const createEmojiResponseSchema = z.object({
  ok: z.boolean().describe("Whether the emoji was created"),
  action: z.literal("created_emoji"),
  emojiId: z.string().optional().describe("Created Discord emoji ID"),
  guildId: z.string().optional().describe("Discord guild ID"),
  callerUserId: z.string().optional().describe("Discord user ID of the caller"),
  sourceAttachmentId: z.string().optional().describe("Source /c attachment ID"),
  sourceFilename: z.string().optional().describe("Source attachment filename"),
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
    createGuildEmojiFromAttachment: tool({
      description:
        "Create a static Discord guild emoji from one image attachment on the current /c request. Use only when the user provides an emoji name or the request makes one obvious; otherwise ask for a name first. The caller must have Discord's Create Guild Expressions permission. The tool resizes without cropping to a 128x128 transparent PNG, sanitizes the supplied name to Discord's emoji name format, and uploads it to the current guild.",
      inputSchema: z.object({
        attachmentId: z
          .string()
          .min(1)
          .describe("ID of the current /c image attachment to use"),
        name: z
          .string()
          .min(2)
          .max(64)
          .optional()
          .describe(
            "Semantic emoji name from the user request; spaces are allowed and will be sanitized"
          )
      }),
      outputSchema: createEmojiResponseSchema,
      execute: async (input) =>
        createGuildEmojiFromAttachment(env, context, input),
      toModelOutput: ({ output }) => ({
        type: "text",
        value: formatCreateEmojiOutput(output)
      })
    })
  };
}

function formatCreateEmojiOutput(output: CreateEmojiFromAttachmentResponse) {
  if (!output.ok) {
    return `Emoji creation failed: ${output.error}`;
  }

  return [
    "Emoji created.",
    `Emoji ID: ${output.emojiId}`,
    `Name: ${output.name}`,
    `Shortcode: ${output.shortcode}`,
    output.mention ? `Mention: ${output.mention}` : "",
    `Source attachment: ${output.sourceFilename} (${output.sourceAttachmentId})`,
    `Processed size: ${output.processedSizeBytes} bytes`,
    "The emoji is now available in the current Discord server."
  ]
    .filter(Boolean)
    .join("\n");
}

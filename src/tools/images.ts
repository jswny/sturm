import { tool } from "ai";
import { z } from "zod";
import { generateImage, type ImageAspectRatio, type ImageEnv } from "../images";
import type { ResponseArtifact } from "../artifacts";
import { DEFAULT_IMAGE_ASPECT_RATIO, DEFAULT_IMAGE_RESOLUTION } from "../model";

const imageAspectRatioSchema = z.enum([
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9"
]);
const imageResolutionSchema = z.enum(["1K", "2K", "4K"]);

const generateImageResponseSchema = z.object({
  success: z.boolean().describe("Whether image generation completed"),
  attached: z
    .boolean()
    .optional()
    .describe(
      "Whether the generated image was attached to the final Discord/debug response"
    ),
  artifactId: z
    .string()
    .optional()
    .describe(
      "Tool-only generated image artifact handle for same-turn follow-up artifact tools. Do not include in final chat text."
    ),
  aspectRatio: imageAspectRatioSchema
    .optional()
    .describe("Generated image aspect ratio"),
  resolution: imageResolutionSchema
    .optional()
    .describe("Generated image resolution tier"),
  error: z.string().optional().describe("Error message when generation failed")
});

type ImageRequestContext = {
  correlationId?: string;
  guildId?: string;
  channelId?: string;
};

export function createImageTools(
  env: ImageEnv,
  options: {
    onArtifactCreated?: (artifact: ResponseArtifact) => void | Promise<void>;
    discordRequest?: ImageRequestContext;
  } = {}
) {
  return {
    generateImage: tool({
      description:
        "Generate an image from a text prompt and attach it to the response. Use when the user asks you to create, draw, render, or generate an image. Sturm automatically attaches successful generated images to the final Discord/debug response. In the final chat response, briefly say the image is attached; do not include Markdown image syntax, attachment:// URLs, file links, filenames, raw artifact IDs, hashes, provider/model metadata, prompt dumps, or other internal references unless the user explicitly asks for diagnostic details. The returned artifactId is only a tool handle for same-turn follow-up artifact tools such as sticker or emoji creation.",
      inputSchema: z.object({
        prompt: z
          .string()
          .min(1)
          .describe("Detailed visual prompt for the image generator"),
        aspectRatio: imageAspectRatioSchema
          .optional()
          .describe(
            `Image aspect ratio. Default ${DEFAULT_IMAGE_ASPECT_RATIO}. Use 1:1 unless the user asks for portrait, landscape, wide, tall, or a specific ratio.`
          ),
        resolution: imageResolutionSchema
          .optional()
          .describe(
            `Image resolution tier. Default ${DEFAULT_IMAGE_RESOLUTION}. Use higher values only when the user asks for high resolution or extra detail.`
          )
      }),
      outputSchema: generateImageResponseSchema,
      execute: async ({ prompt, aspectRatio, resolution }) => {
        const { artifact, response } = await generateImage(
          env,
          {
            prompt,
            aspectRatio: aspectRatio as ImageAspectRatio | undefined,
            resolution
          },
          {
            correlation: getImageGenerationCorrelation(options.discordRequest)
          }
        );
        if (artifact) await options.onArtifactCreated?.(artifact);
        return response;
      }
    })
  };
}

function getImageGenerationCorrelation(request: ImageRequestContext = {}) {
  return {
    correlationId: request.correlationId,
    guildId: request.guildId,
    channelId: request.channelId
  };
}

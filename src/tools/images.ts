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
  artifactId: z.string().optional().describe("Generated image artifact ID"),
  sha256: z.string().optional().describe("Generated image SHA-256 hash"),
  prompt: z.string().describe("The prompt used to generate the image"),
  model: z.string().describe("The image generation model"),
  aspectRatio: imageAspectRatioSchema.describe("Generated image aspect ratio"),
  resolution: imageResolutionSchema.describe("Generated image resolution tier"),
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
        "Generate an image from a text prompt and attach it to the response. Use when the user asks you to create, draw, render, or generate an image. Sturm automatically attaches successful generated images to the final Discord/debug response, so do not include Markdown image syntax, attachment:// URLs, file links, raw artifact IDs, hashes, or other internal references in the final chat response unless the user explicitly asks for diagnostic details. If later code needs the generated artifact details, keep or return the structured tool result instead of rerunning generation.",
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

import { tool } from "ai";
import { z } from "zod";
import {
  generateImage,
  type GeneratedImage,
  type GenerateImageResponse,
  type ImageEnv
} from "../images";

const generateImageResponseSchema = z.object({
  id: z.string().optional().describe("Generated image artifact ID"),
  r2Key: z.string().optional().describe("Stored image object key"),
  prompt: z.string().describe("The prompt used to generate the image"),
  model: z.string().describe("The image generation model"),
  width: z.number().describe("Generated image width in pixels"),
  height: z.number().describe("Generated image height in pixels"),
  error: z.string().optional().describe("Error message when generation failed")
});

function formatGenerateImageOutput(output: GenerateImageResponse) {
  if (output.error) {
    return `Image generation failed: ${output.error}`;
  }

  const lines = [
    `Generated image artifact: ${output.id}`,
    `Prompt: ${output.prompt}`,
    `Model: ${output.model}`,
    `Size: ${output.width}x${output.height}`,
    "The image will be attached to the response. Do not include raw image data in the chat response."
  ];
  if (output.r2Key) lines.splice(1, 0, `Stored image key: ${output.r2Key}`);
  return lines.join("\n");
}

export function createImageTools(
  env: ImageEnv,
  options: {
    onImageGenerated?: (artifact: GeneratedImage) => void;
  } = {}
) {
  return {
    generateImage: tool({
      description:
        "Generate an image from a text prompt and attach it to the response. Use when the user asks you to create, draw, render, or generate an image.",
      inputSchema: z.object({
        prompt: z
          .string()
          .min(1)
          .describe("Detailed visual prompt for the image generator"),
        width: z
          .enum(["512", "768", "1024"])
          .optional()
          .describe("Image width in pixels"),
        height: z
          .enum(["512", "768", "1024"])
          .optional()
          .describe("Image height in pixels")
      }),
      outputSchema: generateImageResponseSchema,
      execute: async ({ prompt, width, height }) => {
        const { artifact, response } = await generateImage(
          env,
          prompt,
          width ? Number(width) : undefined,
          height ? Number(height) : undefined
        );
        if (artifact) options.onImageGenerated?.(artifact);
        return response;
      },
      toModelOutput: ({ output }) => ({
        type: "text",
        value: formatGenerateImageOutput(output)
      })
    })
  };
}

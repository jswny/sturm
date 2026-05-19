import { tool } from "ai";
import { z } from "zod";
import {
  generateImage,
  type GeneratedImage,
  type GenerateImageResponse
} from "./images";
import {
  searchWeb,
  summarizeUrl,
  type SearchEnv,
  type SearchResponse,
  type UrlSummaryResponse
} from "./search";

const searchResultSchema = z.object({
  title: z.string().describe("Reference title"),
  url: z.string().describe("Reference URL"),
  snippet: z.string().optional().describe("Reference snippet")
});

const searchResponseSchema = z.object({
  query: z.string().describe("The query sent to web search"),
  answer: z.string().optional().describe("The synthesized web-backed answer"),
  results: z
    .array(searchResultSchema)
    .describe("References used by web search"),
  error: z.string().optional().describe("Error message when search failed")
});

const urlSummaryResponseSchema = z.object({
  url: z.string().describe("The summarized URL"),
  summary: z.string().optional().describe("The URL summary"),
  error: z
    .string()
    .optional()
    .describe("Error message when summarization failed")
});

const generateImageResponseSchema = z.object({
  id: z.string().optional().describe("Generated image artifact ID"),
  prompt: z.string().describe("The prompt used to generate the image"),
  model: z.string().describe("The image generation model"),
  width: z.number().describe("Generated image width in pixels"),
  height: z.number().describe("Generated image height in pixels"),
  error: z.string().optional().describe("Error message when generation failed")
});

function formatWebSearchOutput(output: SearchResponse) {
  if (output.error) {
    return `Web search failed: ${output.error}`;
  }

  const references = output.results
    .map((result, index) => {
      const snippet = result.snippet ? `\nSnippet: ${result.snippet}` : "";
      return `[${index + 1}] ${result.title}\nURL: ${result.url}${snippet}`;
    })
    .join("\n\n");

  return [
    `Web search answer for: ${output.query}`,
    "",
    output.answer ? `Answer:\n${output.answer}` : "Answer: No answer returned.",
    "",
    references ? `References:\n${references}` : "References: none returned."
  ].join("\n");
}

function formatUrlSummaryOutput(output: UrlSummaryResponse) {
  if (output.error) {
    return `URL summarization failed: ${output.error}`;
  }

  return [
    `URL summary for: ${output.url}`,
    "",
    output.summary
      ? `Summary:\n${output.summary}`
      : "Summary: No summary returned."
  ].join("\n");
}

function formatGenerateImageOutput(output: GenerateImageResponse) {
  if (output.error) {
    return `Image generation failed: ${output.error}`;
  }

  return [
    `Generated image artifact: ${output.id}`,
    `Prompt: ${output.prompt}`,
    `Model: ${output.model}`,
    `Size: ${output.width}x${output.height}`,
    "The image will be attached to the response. Do not include raw image data in the chat response."
  ].join("\n");
}

export function createDiscordTools(
  env: SearchEnv,
  options: {
    onImageGenerated?: (artifact: GeneratedImage) => void;
  } = {}
) {
  return {
    webSearch: tool({
      description:
        "Search the web for current facts, recent events, external sources, or anything the user asks you to look up. Returns a synthesized web-backed answer plus reference URLs.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe("The complete web search question to ask")
      }),
      outputSchema: searchResponseSchema,
      execute: async ({ query }) => searchWeb(env, query),
      toModelOutput: ({ output }) => ({
        type: "text",
        value: formatWebSearchOutput(output)
      })
    }),

    summarizeUrl: tool({
      description:
        "Summarize the content at a specific URL. Use when the user asks to summarize, explain, or extract the main points from a link.",
      inputSchema: z.object({
        url: z.string().url().describe("The complete URL to summarize")
      }),
      outputSchema: urlSummaryResponseSchema,
      execute: async ({ url }) => summarizeUrl(env, url),
      toModelOutput: ({ output }) => ({
        type: "text",
        value: formatUrlSummaryOutput(output)
      })
    }),

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

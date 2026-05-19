import { tool } from "ai";
import { z } from "zod";
import { searchWeb, type SearchEnv, type SearchResponse } from "./search";

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

export function createDiscordTools(env: SearchEnv) {
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
    })
  };
}

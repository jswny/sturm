import { tool } from "ai";
import { z } from "zod";
import { searchWeb, summarizeUrl, type SearchEnv } from "../search";

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

type SearchToolResponse = z.infer<typeof searchResponseSchema>;
type UrlSummaryToolResponse = z.infer<typeof urlSummaryResponseSchema>;

export function createSearchTools(env: SearchEnv) {
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
        value: formatSearchOutput(output)
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
    })
  };
}

function formatSearchOutput(output: SearchToolResponse) {
  if (output.error) {
    return [
      "Web search failed.",
      `query: ${output.query}`,
      `error: ${output.error}`
    ].join("\n");
  }

  const lines = [`Web search query: ${output.query}`];
  if (output.answer) lines.push(`Answer: ${output.answer}`);
  if (output.results.length > 0) {
    lines.push("Sources:");
    for (const result of output.results) {
      lines.push(
        [
          `- ${result.title}`,
          result.url,
          result.snippet ? `snippet: ${result.snippet}` : undefined
        ]
          .filter(Boolean)
          .join(" | ")
      );
    }
  }
  lines.push(
    "Final response guidance: answer from the search result and include source URLs when useful or requested."
  );
  return lines.join("\n");
}

function formatUrlSummaryOutput(output: UrlSummaryToolResponse) {
  if (output.error) {
    return [
      "URL summarization failed.",
      `url: ${output.url}`,
      `error: ${output.error}`
    ].join("\n");
  }

  return [
    `URL summarized: ${output.url}`,
    output.summary ? `Summary: ${output.summary}` : "Summary: unavailable",
    "Final response guidance: answer from the summary and cite the URL when useful."
  ].join("\n");
}

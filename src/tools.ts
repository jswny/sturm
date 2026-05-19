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
    }),

    getWeather: tool({
      description: "Get the current weather for a city",
      inputSchema: z.object({
        city: z.string().describe("City name")
      }),
      execute: async ({ city }) => {
        // Replace with a real weather API in production.
        const conditions = ["sunny", "cloudy", "rainy", "snowy"];
        const temp = Math.floor(Math.random() * 30) + 5;
        return {
          city,
          temperature: temp,
          condition: conditions[Math.floor(Math.random() * conditions.length)],
          unit: "celsius"
        };
      }
    }),

    calculate: tool({
      description: "Perform a math calculation with two numbers.",
      inputSchema: z.object({
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
        operator: z
          .enum(["+", "-", "*", "/", "%"])
          .describe("Arithmetic operator")
      }),
      execute: async ({ a, b, operator }) => {
        const ops: Record<string, (x: number, y: number) => number> = {
          "+": (x, y) => x + y,
          "-": (x, y) => x - y,
          "*": (x, y) => x * y,
          "/": (x, y) => x / y,
          "%": (x, y) => x % y
        };
        if (operator === "/" && b === 0) {
          return { error: "Division by zero" };
        }
        return {
          expression: `${a} ${operator} ${b}`,
          result: ops[operator](a, b)
        };
      }
    })
  };
}

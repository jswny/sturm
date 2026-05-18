import { tool } from "ai";
import { z } from "zod";

export function createDiscordTools() {
  return {
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

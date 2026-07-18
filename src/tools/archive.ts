import { tool } from "ai";
import { z } from "zod";
import { archiveUrl } from "../archive";

const archiveUrlResponseSchema = z.object({
  originalUrl: z.string().describe("The URL requested for archiving"),
  preparedUrl: z
    .string()
    .optional()
    .describe("The URL after optional query parameter stripping"),
  archiveUrl: z
    .string()
    .optional()
    .describe("The archive.today latest URL for the prepared URL"),
  queryParamsPreserved: z
    .boolean()
    .describe("Whether query parameters were preserved"),
  error: z.string().optional().describe("Error message when archiving failed")
});

type ArchiveUrlToolResponse = z.infer<typeof archiveUrlResponseSchema>;

export function createArchiveTools() {
  return {
    archiveUrl: tool({
      description:
        "Create an archive.today latest URL for a web page. Use when the user asks to archive, preserve, or create an archive link for a URL. By default, strips query parameters to avoid tracking links unless the user explicitly asks to preserve them.",
      inputSchema: z.object({
        url: z.string().url().describe("The complete URL to archive"),
        preserveQueryParams: z
          .boolean()
          .default(false)
          .describe(
            "Whether to preserve query parameters. Default false unless the user asks to keep query params."
          )
      }),
      outputSchema: archiveUrlResponseSchema,
      execute: async ({ url, preserveQueryParams }) =>
        archiveUrl(url, preserveQueryParams),
      toModelOutput: ({ output }) => ({
        type: "text",
        value: formatArchiveUrlOutput(output)
      })
    })
  };
}

function formatArchiveUrlOutput(output: ArchiveUrlToolResponse) {
  if (output.error) {
    return [
      "Archive link creation failed.",
      `originalUrl: ${output.originalUrl}`,
      `error: ${output.error}`
    ].join("\n");
  }

  return [
    "Archive link created.",
    `originalUrl: ${output.originalUrl}`,
    output.preparedUrl ? `preparedUrl: ${output.preparedUrl}` : undefined,
    output.archiveUrl ? `archiveUrl: ${output.archiveUrl}` : undefined,
    `queryParamsPreserved: ${output.queryParamsPreserved ? "yes" : "no"}`,
    "Final response guidance: give the archiveUrl to the user. Mention query stripping only if relevant."
  ]
    .filter(Boolean)
    .join("\n");
}

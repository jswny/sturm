import { generateObject, type ModelMessage } from "ai";
import { z } from "zod";
import type { StoredResponseArtifact } from "../artifacts";
import { getErrorMessage, logWarn } from "../logging";
import { stripModelThinkingTraces } from "../model-output";
import {
  ARTIFACT_SUMMARY_PROVIDER_OPTIONS,
  CHAT_AI_GATEWAY_FLOWS,
  createChatModel,
  REPLY_CHAT_TIMEOUT_MS
} from "../model";
import type { DiscordChatRequest } from "./types";

const IMAGE_SUMMARY_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_SUMMARY_MAX_CHARS = 600;
const IMAGE_SUMMARY_MAX_OUTPUT_TOKENS = 192;

const SUPPORTED_IMAGE_SUMMARY_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);

const imageSummarySchema = z.object({
  summary: z
    .string()
    .describe(
      "A 2-3 sentence summary of visible image content for future conversation context."
    )
});

export type DiscordArtifactSummaryEnv = Pick<Env, "AI" | "ARTIFACTS_BUCKET">;

export async function summarizeDiscordArtifacts(
  env: DiscordArtifactSummaryEnv,
  request: DiscordChatRequest,
  sessionAffinity: string | undefined
): Promise<DiscordChatRequest> {
  const imageArtifacts = request.artifacts?.filter(
    shouldSummarizeImageArtifact
  );
  if (!imageArtifacts?.length) return request;

  const summaries = await Promise.all(
    imageArtifacts.map((artifact) =>
      summarizeDiscordImageArtifact(env, request, artifact, sessionAffinity)
    )
  );
  const summaryById = new Map(
    summaries.flatMap((result) =>
      result.summary ? [[result.artifactId, result.summary]] : []
    )
  );
  if (summaryById.size === 0) return request;

  return {
    ...request,
    artifacts: request.artifacts?.map((artifact) => {
      const visualSummary = summaryById.get(artifact.id);
      return visualSummary ? { ...artifact, visualSummary } : artifact;
    })
  };
}

function shouldSummarizeImageArtifact(
  artifact: StoredResponseArtifact
): artifact is StoredResponseArtifact<"discord_attachment"> {
  return (
    artifact.source === "discord_attachment" &&
    !artifact.visualSummary &&
    isSupportedImageMimeType(normalizeMimeType(artifact.mimeType))
  );
}

async function summarizeDiscordImageArtifact(
  env: DiscordArtifactSummaryEnv,
  request: DiscordChatRequest,
  artifact: StoredResponseArtifact<"discord_attachment">,
  sessionAffinity: string | undefined
): Promise<{ artifactId: string; summary?: string }> {
  try {
    const object = await env.ARTIFACTS_BUCKET.get(artifact.artifactKey);
    if (!object?.body) {
      logWarn("Image artifact summary skipped missing artifact", {
        correlationId: request.correlationId,
        artifactId: artifact.id,
        artifactKey: artifact.artifactKey,
        filename: artifact.filename
      });
      return { artifactId: artifact.id };
    }

    if (object.size > IMAGE_SUMMARY_MAX_BYTES) {
      logWarn("Image artifact summary skipped oversized artifact", {
        correlationId: request.correlationId,
        artifactId: artifact.id,
        artifactKey: artifact.artifactKey,
        filename: artifact.filename,
        sizeBytes: object.size,
        maxBytes: IMAGE_SUMMARY_MAX_BYTES
      });
      return { artifactId: artifact.id };
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    const storedMimeType = normalizeMimeType(headers.get("content-type"));
    const mediaType = isSupportedImageMimeType(storedMimeType)
      ? storedMimeType
      : normalizeMimeType(artifact.mimeType);
    if (!isSupportedImageMimeType(mediaType)) {
      return { artifactId: artifact.id };
    }

    const bytes = new Uint8Array(await object.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > IMAGE_SUMMARY_MAX_BYTES) {
      return { artifactId: artifact.id };
    }

    const model = createChatModel(
      env,
      CHAT_AI_GATEWAY_FLOWS.artifactSummary,
      {
        correlationId: request.correlationId,
        guildId: request.guildId,
        channelId: request.channelId
      },
      sessionAffinity
    );
    const result = await generateObject({
      model,
      providerOptions: ARTIFACT_SUMMARY_PROVIDER_OPTIONS,
      system:
        "You summarize images for future conversation context. Respond only with the image summary.",
      schema: imageSummarySchema,
      schemaName: "imageSummary",
      schemaDescription:
        "A concise summary of visible image content and important visible text.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                `filename: ${artifact.filename}`,
                `mimeType: ${artifact.mimeType}`,
                artifact.metadata.width && artifact.metadata.height
                  ? `dimensions: ${artifact.metadata.width}x${artifact.metadata.height}`
                  : "",
                "Summarize the image in 2-3 concise sentences.",
                "Describe visible content and important visible text.",
                "Use generic labels for private people. App, bot, product, and channel names are OK.",
                "Respond with the summary and nothing else."
              ]
                .filter(Boolean)
                .join("\n")
            },
            {
              type: "file",
              data: bytes,
              filename: artifact.filename,
              mediaType
            }
          ]
        }
      ] satisfies ModelMessage[],
      maxOutputTokens: IMAGE_SUMMARY_MAX_OUTPUT_TOKENS,
      timeout: REPLY_CHAT_TIMEOUT_MS
    });

    const summary = normalizeVisualSummary(result.object.summary);
    if (!summary) {
      logWarn("Image artifact summary produced no usable summary", {
        correlationId: request.correlationId,
        discordInteractionId: request.discordInteractionId,
        artifactId: artifact.id,
        artifactKey: artifact.artifactKey,
        filename: artifact.filename
      });
    }

    return {
      artifactId: artifact.id,
      summary
    };
  } catch (error) {
    logWarn("Image artifact summary failed", {
      correlationId: request.correlationId,
      discordInteractionId: request.discordInteractionId,
      artifactId: artifact.id,
      artifactKey: artifact.artifactKey,
      filename: artifact.filename,
      error: getErrorMessage(error)
    });
    return { artifactId: artifact.id };
  }
}

function normalizeVisualSummary(value: string) {
  const summary = clampVisualSummary(
    normalizeVisualSummaryWhitespace(stripModelThinkingTraces(value))
  );
  return summary || undefined;
}

function normalizeVisualSummaryWhitespace(value: string) {
  return value
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clampVisualSummary(value: string) {
  if (value.length <= IMAGE_SUMMARY_MAX_CHARS) return value;

  const truncated = value.slice(0, IMAGE_SUMMARY_MAX_CHARS).trimEnd();
  const lastSpace = truncated.lastIndexOf(" ");
  const wordSafe =
    lastSpace > Math.floor(IMAGE_SUMMARY_MAX_CHARS * 0.7)
      ? truncated.slice(0, lastSpace)
      : truncated;
  const cleaned = wordSafe
    .replace(/[\s,;:-]+$/g, "")
    .replace(/\b(?:and|or|with|of|to|a|the|in|on)$/i, "")
    .trim();
  return /[.!?)]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

function normalizeMimeType(value: string | null | undefined) {
  return value?.split(";")[0]?.trim().toLowerCase();
}

function isSupportedImageMimeType(
  value: string | undefined
): value is "image/png" | "image/jpeg" | "image/webp" | "image/gif" {
  return Boolean(value && SUPPORTED_IMAGE_SUMMARY_MIME_TYPES.has(value));
}

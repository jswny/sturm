import type { FilePart, ModelMessage, TextPart } from "ai";
import { getErrorMessage, logWarn } from "../logging";
import type { StoredResponseArtifact } from "../artifacts";
import type { DiscordChatRequest } from "./types";

export const CURRENT_TURN_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const SUPPORTED_CURRENT_TURN_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);

type CurrentTurnImagePart = TextPart | FilePart;

type CurrentTurnImageOptions = {
  artifactBucket?: R2Bucket;
  maxBytes?: number;
};

export async function addCurrentTurnImagesToModelMessages(
  messages: ModelMessage[],
  request: DiscordChatRequest,
  options: CurrentTurnImageOptions = {}
): Promise<ModelMessage[]> {
  const artifacts = request.artifacts?.filter(isCurrentTurnImageArtifact);
  if (!artifacts?.length) return messages;

  const parts = (
    await Promise.all(
      artifacts.map((artifact) =>
        createCurrentTurnImagePart(artifact, request, options)
      )
    )
  ).filter((part) => part !== undefined);

  if (parts.length === 0) return messages;
  return appendPartsToLatestUserMessage(messages, parts);
}

async function createCurrentTurnImagePart(
  artifact: StoredResponseArtifact<"discord_attachment">,
  request: DiscordChatRequest,
  options: CurrentTurnImageOptions
): Promise<CurrentTurnImagePart | undefined> {
  const maxBytes = options.maxBytes ?? CURRENT_TURN_IMAGE_MAX_BYTES;
  const declaredMimeType = normalizeMimeType(artifact.mimeType);
  if (!isSupportedCurrentTurnImageMimeType(declaredMimeType)) {
    return createArtifactStatusPart(
      artifact,
      "not provided as visual input because its MIME type is unsupported"
    );
  }

  try {
    if (!options.artifactBucket) {
      return createArtifactStatusPart(
        artifact,
        "not provided as visual input because artifact storage is unavailable"
      );
    }

    const object = await options.artifactBucket.get(artifact.artifactKey);
    if (!object?.body) {
      logWarn("Discord current-turn image artifact was missing", {
        correlationId: request.correlationId,
        discordInteractionId: request.discordInteractionId,
        artifactId: artifact.id,
        artifactKey: artifact.artifactKey,
        filename: artifact.filename
      });
      return createArtifactStatusPart(
        artifact,
        "not provided as visual input because the stored artifact is unavailable"
      );
    }

    if (object.size > maxBytes) {
      return createArtifactStatusPart(
        artifact,
        `not provided as visual input because it is larger than ${maxBytes} bytes`
      );
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    const storedMimeType = normalizeMimeType(headers.get("content-type"));
    const mediaType = isSupportedCurrentTurnImageMimeType(storedMimeType)
      ? storedMimeType
      : declaredMimeType;

    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength === 0) {
      return createArtifactStatusPart(
        artifact,
        "not provided as visual input because the stored artifact is empty"
      );
    }
    if (bytes.byteLength > maxBytes) {
      return createArtifactStatusPart(
        artifact,
        `not provided as visual input because it is larger than ${maxBytes} bytes`
      );
    }

    return {
      type: "file",
      data: bytes,
      filename: artifact.filename,
      mediaType
    };
  } catch (error) {
    logWarn("Discord current-turn image artifact read failed", {
      correlationId: request.correlationId,
      discordInteractionId: request.discordInteractionId,
      artifactId: artifact.id,
      artifactKey: artifact.artifactKey,
      filename: artifact.filename,
      error: getErrorMessage(error)
    });
    return createArtifactStatusPart(
      artifact,
      "not provided as visual input because the stored artifact could not be read"
    );
  }
}

function appendPartsToLatestUserMessage(
  messages: ModelMessage[],
  parts: CurrentTurnImagePart[]
): ModelMessage[] {
  const targetIndex = findLatestUserMessageIndex(messages);
  if (targetIndex < 0) return messages;

  return messages.map((message, index) => {
    if (index !== targetIndex || message.role !== "user") return message;
    return {
      ...message,
      content:
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }, ...parts]
          : [...message.content, ...parts]
    };
  });
}

function findLatestUserMessageIndex(messages: ModelMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") return index;
  }
  return -1;
}

function createArtifactStatusPart(
  artifact: StoredResponseArtifact<"discord_attachment">,
  status: string
): TextPart {
  return {
    type: "text",
    text: [
      "Current /c image attachment status:",
      `artifactId: ${artifact.id}`,
      `filename: ${artifact.filename}`,
      `status: ${status}.`
    ].join("\n")
  };
}

function isCurrentTurnImageArtifact(
  artifact: StoredResponseArtifact
): artifact is StoredResponseArtifact<"discord_attachment"> {
  return (
    artifact.source === "discord_attachment" &&
    isSupportedCurrentTurnImageMimeType(normalizeMimeType(artifact.mimeType))
  );
}

function normalizeMimeType(value: string | null | undefined) {
  return value?.split(";")[0]?.trim().toLowerCase();
}

function isSupportedCurrentTurnImageMimeType(
  mimeType: string | undefined
): mimeType is "image/png" | "image/jpeg" | "image/webp" | "image/gif" {
  return Boolean(
    mimeType && SUPPORTED_CURRENT_TURN_IMAGE_MIME_TYPES.has(mimeType)
  );
}

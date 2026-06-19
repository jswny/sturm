import type { FilePart, ModelMessage, TextPart } from "ai";
import { getErrorMessage, logWarn } from "../logging";
import type { DiscordChatRequest, DiscordRequestAttachment } from "./types";

export const CURRENT_TURN_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const CURRENT_TURN_IMAGE_FETCH_TIMEOUT_MS = 5_000;

const SUPPORTED_CURRENT_TURN_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);

type CurrentTurnImagePart = TextPart | FilePart;

type CurrentTurnImageOptions = {
  fetchAttachment?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
};

export async function addCurrentTurnImagesToModelMessages(
  messages: ModelMessage[],
  request: DiscordChatRequest,
  options: CurrentTurnImageOptions = {}
): Promise<ModelMessage[]> {
  if (!request.attachments?.length) return messages;

  const parts = (
    await Promise.all(
      request.attachments.map((attachment) =>
        createCurrentTurnImagePart(attachment, request, options)
      )
    )
  ).filter((part) => part !== undefined);

  if (parts.length === 0) return messages;
  return appendPartsToLatestUserMessage(messages, parts);
}

async function createCurrentTurnImagePart(
  attachment: DiscordRequestAttachment,
  request: DiscordChatRequest,
  options: CurrentTurnImageOptions
): Promise<CurrentTurnImagePart | undefined> {
  const maxBytes = options.maxBytes ?? CURRENT_TURN_IMAGE_MAX_BYTES;
  const declaredMimeType = normalizeMimeType(attachment.mimeType);
  if (!isSupportedCurrentTurnImageMimeType(declaredMimeType)) {
    return createAttachmentStatusPart(
      attachment,
      "not provided as visual input because its MIME type is unsupported"
    );
  }

  if (attachment.sizeBytes > maxBytes) {
    return createAttachmentStatusPart(
      attachment,
      `not provided as visual input because it is larger than ${maxBytes} bytes`
    );
  }

  const sourceUrl = attachment.proxyUrl ?? attachment.url;
  try {
    const response = await (options.fetchAttachment ?? fetch)(sourceUrl, {
      headers: { accept: declaredMimeType ?? "image/*" },
      signal: createTimeoutSignal(options.timeoutMs)
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logWarn("Discord current-turn image fetch failed", {
        correlationId: request.correlationId,
        discordInteractionId: request.discordInteractionId,
        attachmentId: attachment.id,
        filename: attachment.filename,
        status: response.status,
        body: body.slice(0, 200)
      });
      return createAttachmentStatusPart(
        attachment,
        `could not be fetched for visual input (${response.status})`
      );
    }

    const responseMimeType = normalizeMimeType(
      response.headers.get("content-type")
    );
    const mediaType = isSupportedCurrentTurnImageMimeType(responseMimeType)
      ? responseMimeType
      : declaredMimeType;
    if (!isSupportedCurrentTurnImageMimeType(mediaType)) {
      return createAttachmentStatusPart(
        attachment,
        "not provided as visual input because Discord returned an unsupported image type"
      );
    }

    const contentLength = getContentLength(response.headers);
    if (contentLength !== undefined && contentLength > maxBytes) {
      return createAttachmentStatusPart(
        attachment,
        `not provided as visual input because Discord returned more than ${maxBytes} bytes`
      );
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      return createAttachmentStatusPart(
        attachment,
        "not provided as visual input because Discord returned an empty image"
      );
    }
    if (bytes.byteLength > maxBytes) {
      return createAttachmentStatusPart(
        attachment,
        `not provided as visual input because Discord returned more than ${maxBytes} bytes`
      );
    }

    return {
      type: "file",
      data: bytes,
      filename: attachment.filename,
      mediaType
    };
  } catch (error) {
    logWarn("Discord current-turn image fetch threw", {
      correlationId: request.correlationId,
      discordInteractionId: request.discordInteractionId,
      attachmentId: attachment.id,
      filename: attachment.filename,
      error: getErrorMessage(error)
    });
    return createAttachmentStatusPart(
      attachment,
      "could not be fetched for visual input"
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

function createAttachmentStatusPart(
  attachment: DiscordRequestAttachment,
  status: string
): TextPart {
  return {
    type: "text",
    text: [
      "Current /c image attachment status:",
      `id: ${attachment.id}`,
      `filename: ${attachment.filename}`,
      `status: ${status}.`
    ].join("\n")
  };
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

function getContentLength(headers: Headers) {
  const value = headers.get("content-length");
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function createTimeoutSignal(timeoutMs: number | undefined) {
  const ms = timeoutMs ?? CURRENT_TURN_IMAGE_FETCH_TIMEOUT_MS;
  if (ms <= 0) return undefined;
  return AbortSignal.timeout(ms);
}

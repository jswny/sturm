import {
  sanitizeArtifactFilename,
  storeResponseArtifact,
  toStoredResponseArtifact,
  type ArtifactEnv,
  type DiscordAttachmentArtifactMetadata,
  type StoredResponseArtifact
} from "../artifacts";
import { readResponseBytesWithLimit, readResponseTextWithLimit } from "../http";
import { getErrorMessage, logWarn } from "../logging";
import type { DiscordChatRequest, DiscordRequestAttachment } from "./types";

export type DiscordAttachmentArtifactEnv = ArtifactEnv;

const DISCORD_ATTACHMENT_ARTIFACT_PREFIX = "attachments/discord";
const DISCORD_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const DISCORD_ATTACHMENT_FETCH_TIMEOUT_MS = 15_000;
const DISCORD_ATTACHMENT_ERROR_MAX_BYTES = 16 * 1024;

export async function freezeDiscordRequestAttachments(
  env: DiscordAttachmentArtifactEnv,
  request: DiscordChatRequest
): Promise<DiscordChatRequest> {
  if (!request.attachments?.length) return request;

  const results = await Promise.all(
    request.attachments.map((attachment) =>
      freezeDiscordRequestAttachment(env, request, attachment)
    )
  );
  const attachments = results.map((result) => result.attachment);
  const artifacts = mergeStoredArtifacts([
    ...(request.artifacts ?? []),
    ...results
      .map((result) => result.artifact)
      .filter((artifact) => artifact !== undefined)
  ]);

  return {
    ...request,
    attachments,
    artifacts: artifacts.length ? artifacts : request.artifacts
  };
}

async function freezeDiscordRequestAttachment(
  env: DiscordAttachmentArtifactEnv,
  request: DiscordChatRequest,
  attachment: DiscordRequestAttachment
): Promise<{
  attachment: DiscordRequestAttachment;
  artifact?: StoredResponseArtifact<"discord_attachment">;
}> {
  if (attachment.artifactKey && attachment.sha256) {
    const artifactId = createDiscordAttachmentArtifactId(request, attachment);
    const updatedAttachment = { ...attachment, artifactId };
    return {
      attachment: updatedAttachment,
      artifact: createStoredDiscordAttachmentArtifact(
        request,
        updatedAttachment
      )
    };
  }

  if (attachment.sizeBytes > DISCORD_ATTACHMENT_MAX_BYTES) {
    logWarn("Discord attachment was too large to freeze", {
      correlationId: request.correlationId,
      discordInteractionId: request.discordInteractionId,
      attachmentId: attachment.id,
      filename: attachment.filename,
      sizeBytes: attachment.sizeBytes,
      maxBytes: DISCORD_ATTACHMENT_MAX_BYTES
    });
    return { attachment };
  }

  try {
    const fetched = await fetchAttachmentBytes(attachment);
    if (!fetched.ok) {
      logWarn("Discord attachment freeze fetch failed", {
        correlationId: request.correlationId,
        discordInteractionId: request.discordInteractionId,
        attachmentId: attachment.id,
        filename: attachment.filename,
        error: fetched.error
      });
      return { attachment };
    }

    if (fetched.bytes.byteLength > DISCORD_ATTACHMENT_MAX_BYTES) {
      logWarn("Discord attachment freeze exceeded byte limit", {
        correlationId: request.correlationId,
        discordInteractionId: request.discordInteractionId,
        attachmentId: attachment.id,
        filename: attachment.filename,
        sizeBytes: fetched.bytes.byteLength,
        maxBytes: DISCORD_ATTACHMENT_MAX_BYTES
      });
      return { attachment };
    }

    const artifactId = createDiscordAttachmentArtifactId(request, attachment);
    const storedAt = new Date().toISOString();
    const mimeType =
      normalizeMimeType(fetched.mimeType) ??
      normalizeMimeType(attachment.mimeType) ??
      "application/octet-stream";
    const artifact = await storeResponseArtifact(env, {
      id: artifactId,
      source: "discord_attachment",
      filename: attachment.filename,
      mimeType,
      artifactKey: createDiscordAttachmentArtifactKey(request, attachment),
      keyPrefix: DISCORD_ATTACHMENT_ARTIFACT_PREFIX,
      bytes: fetched.bytes,
      metadata: {
        guildId: request.guildId,
        channelId: request.channelId,
        correlationId: request.correlationId,
        discordInteractionId: request.discordInteractionId,
        discordAttachmentId: attachment.id,
        sourceUrl: attachment.url,
        width: attachment.width,
        height: attachment.height
      } satisfies DiscordAttachmentArtifactMetadata,
      description: `Discord attachment from turn ${request.correlationId}: ${attachment.filename}`
    });

    return {
      attachment: {
        ...attachment,
        artifactId: artifact.id,
        artifactKey: artifact.artifactKey,
        sha256: artifact.sha256,
        storedAt,
        mimeType: attachment.mimeType ?? artifact.mimeType,
        sizeBytes: attachment.sizeBytes || fetched.bytes.byteLength
      },
      artifact: toStoredResponseArtifact(
        artifact
      ) as StoredResponseArtifact<"discord_attachment">
    };
  } catch (error) {
    logWarn("Discord attachment freeze failed", {
      correlationId: request.correlationId,
      discordInteractionId: request.discordInteractionId,
      attachmentId: attachment.id,
      filename: attachment.filename,
      error: getErrorMessage(error)
    });
    return { attachment };
  }
}

function createDiscordAttachmentArtifactId(
  request: DiscordChatRequest,
  attachment: DiscordRequestAttachment
) {
  return `turn:${request.correlationId}:attachment:${attachment.id}`;
}

function createStoredDiscordAttachmentArtifact(
  request: DiscordChatRequest,
  attachment: DiscordRequestAttachment
): StoredResponseArtifact<"discord_attachment"> | undefined {
  if (!attachment.artifactId || !attachment.artifactKey || !attachment.sha256) {
    return undefined;
  }

  return {
    id: attachment.artifactId,
    source: "discord_attachment",
    filename: sanitizeArtifactFilename(attachment.filename, "attachment.bin"),
    mimeType:
      normalizeMimeType(attachment.mimeType) ?? "application/octet-stream",
    artifactKey: attachment.artifactKey,
    sha256: attachment.sha256,
    description: `Discord attachment from turn ${request.correlationId}: ${attachment.filename}`,
    metadata: {
      guildId: request.guildId,
      channelId: request.channelId,
      correlationId: request.correlationId,
      discordInteractionId: request.discordInteractionId,
      discordAttachmentId: attachment.id,
      sourceUrl: attachment.url,
      width: attachment.width,
      height: attachment.height
    }
  };
}

function createDiscordAttachmentArtifactKey(
  request: DiscordChatRequest,
  attachment: DiscordRequestAttachment
) {
  const date = new Date().toISOString().slice(0, 10);
  const filename = sanitizeArtifactFilename(
    attachment.filename,
    "attachment.bin"
  );
  return [
    DISCORD_ATTACHMENT_ARTIFACT_PREFIX,
    date,
    sanitizePathSegment(request.guildId ?? "unknown-guild"),
    sanitizePathSegment(request.channelId ?? "unknown-channel"),
    sanitizePathSegment(request.correlationId),
    `${sanitizePathSegment(attachment.id)}-${filename}`
  ].join("/");
}

async function fetchAttachmentBytes(
  attachment: DiscordRequestAttachment
): Promise<
  | {
      ok: true;
      bytes: Uint8Array;
      mimeType?: string;
    }
  | { ok: false; error: string }
> {
  if (attachment.url.startsWith("data:")) {
    return decodeDataUrl(attachment.url);
  }

  const response = await fetch(attachment.url, {
    headers: { accept: attachment.mimeType ?? "*/*" },
    signal: AbortSignal.timeout(DISCORD_ATTACHMENT_FETCH_TIMEOUT_MS)
  });
  if (!response.ok) {
    const body = await readResponseTextWithLimit(
      response,
      DISCORD_ATTACHMENT_ERROR_MAX_BYTES
    ).catch(() => "");
    return {
      ok: false,
      error: `${response.status} ${body.slice(0, 200)}`.trim()
    };
  }

  return {
    ok: true,
    bytes: await readResponseBytesWithLimit(
      response,
      DISCORD_ATTACHMENT_MAX_BYTES
    ),
    mimeType: response.headers.get("content-type") ?? undefined
  };
}

function decodeDataUrl(url: string) {
  const match = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) return { ok: false as const, error: "invalid data URL" };

  const mimeType = match[1] || undefined;
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? "";
  const bytes = isBase64
    ? Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(payload));

  return { ok: true as const, bytes, mimeType };
}

function normalizeMimeType(value: string | null | undefined) {
  return value?.split(";")[0]?.trim().toLowerCase();
}

function sanitizePathSegment(value: string) {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9._=-]+/g, "_")
      .slice(0, 120) || "unknown"
  );
}

function mergeStoredArtifacts(
  artifacts: StoredResponseArtifact[]
): StoredResponseArtifact[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    if (seen.has(artifact.id)) return false;
    seen.add(artifact.id);
    return true;
  });
}

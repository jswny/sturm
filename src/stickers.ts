import { type APISticker } from "discord-api-types/v10";
import { createGuildSticker, type DiscordApiEnv } from "./discord/api";
import type { DiscordRequestAttachment } from "./discord/types";
import {
  prepareStaticExpressionAttachment,
  STATIC_EXPRESSION_MIME_TYPE,
  type StaticExpressionRequestContext,
  transformStaticAttachmentImage
} from "./expression-images";
import { getErrorMessage } from "./logging";

const STICKER_SIZE_PX = 320;
const MAX_STICKER_BYTES = 512 * 1024;
const STATIC_STICKER_FILENAME = "sticker.png";
const FALLBACK_DESCRIPTION = "Sticker created by Sturm";
export const STICKER_NAME_MIN_CHARS = 2;
export const STICKER_NAME_MAX_CHARS = 30;
export const STICKER_DESCRIPTION_MIN_CHARS = 2;
export const STICKER_DESCRIPTION_MAX_CHARS = 100;
export const STICKER_TAGS_MAX_TOTAL_CHARS = 200;

export type StickerEnv = DiscordApiEnv;

export type StickerRequestContext = StaticExpressionRequestContext;

export type CreateStickerFromAttachmentResponse = {
  ok: boolean;
  action: "created_sticker";
  stickerId?: string;
  guildId?: string;
  callerUserId?: string;
  sourceAttachmentId?: string;
  sourceFilename?: string;
  name?: string;
  description?: string;
  tags?: string[];
  processedMimeType?: "image/png";
  processedSizeBytes?: number;
  width?: 320;
  height?: 320;
  error?: string;
};

type CreateStickerInput = {
  attachmentId: string;
  name?: string;
  description?: string;
  tags: string[];
};

type PreparedStickerMetadata = {
  name: string;
  description: string;
  tags: string[];
  tagsText: string;
};

type PrepareStickerMetadataResult =
  | { ok: true; metadata: PreparedStickerMetadata }
  | {
      ok: false;
      error: string;
      name?: string;
      description?: string;
      tags?: string[];
    };

export async function createGuildStickerFromAttachment(
  env: StickerEnv,
  context: StickerRequestContext,
  input: CreateStickerInput
): Promise<CreateStickerFromAttachmentResponse> {
  const prepared = prepareStaticExpressionAttachment(
    context,
    input.attachmentId,
    {
      targetName: "sticker",
      targetNamePlural: "stickers"
    }
  );
  const baseResponse = {
    ok: false,
    action: "created_sticker",
    ...prepared.baseFields
  } satisfies CreateStickerFromAttachmentResponse;

  if (!prepared.ok) {
    return {
      ...baseResponse,
      error: prepared.error
    };
  }

  const metadataResult = prepareStickerMetadata(input, prepared.attachment);
  if (!metadataResult.ok) {
    return {
      ...baseResponse,
      name: metadataResult.name,
      description: metadataResult.description,
      tags: metadataResult.tags,
      error: metadataResult.error
    };
  }
  const { metadata } = metadataResult;

  const processed = await transformStaticAttachmentImage(prepared.attachment, {
    targetName: "sticker",
    sizePx: STICKER_SIZE_PX,
    maxBytes: MAX_STICKER_BYTES
  });
  if (!processed.ok) {
    return {
      ...baseResponse,
      name: metadata.name,
      description: metadata.description,
      tags: metadata.tags,
      error: processed.error
    };
  }

  try {
    const sticker = (await createGuildSticker(env, prepared.guildId, {
      name: metadata.name,
      description: metadata.description,
      tags: metadata.tagsText,
      filename: STATIC_STICKER_FILENAME,
      mimeType: STATIC_EXPRESSION_MIME_TYPE,
      base64: processed.image.base64,
      reason: `Sticker created by ${context.userId ?? "unknown user"} through Sturm`
    })) as APISticker;

    return {
      ok: true,
      action: "created_sticker",
      stickerId: sticker.id,
      guildId: prepared.guildId,
      callerUserId: context.userId,
      sourceAttachmentId: prepared.attachment.id,
      sourceFilename: prepared.attachment.filename,
      name: metadata.name,
      description: metadata.description,
      tags: metadata.tags,
      processedMimeType: STATIC_EXPRESSION_MIME_TYPE,
      processedSizeBytes: processed.image.sizeBytes,
      width: STICKER_SIZE_PX,
      height: STICKER_SIZE_PX
    };
  } catch (error) {
    return {
      ...baseResponse,
      name: metadata.name,
      description: metadata.description,
      tags: metadata.tags,
      processedMimeType: STATIC_EXPRESSION_MIME_TYPE,
      processedSizeBytes: processed.image.sizeBytes,
      width: STICKER_SIZE_PX,
      height: STICKER_SIZE_PX,
      error: `Discord sticker upload failed: ${getErrorMessage(error)}`
    };
  }
}

function prepareStickerMetadata(
  input: CreateStickerInput,
  attachment: DiscordRequestAttachment
): PrepareStickerMetadataResult {
  const name = sanitizeStickerName(input.name);
  if (!name) {
    return {
      ok: false,
      error:
        "A sticker name is required. Ask the user for a name when they did not provide one and the request does not make one obvious."
    };
  }

  const description =
    sanitizeStickerDescription(input.description) ??
    inferStickerDescription(name, attachment);
  const tagsResult = sanitizeStickerTags(input.tags);
  if (!tagsResult.ok) {
    return {
      ok: false,
      name,
      description,
      error: tagsResult.error
    };
  }
  const { tags, tagsText } = tagsResult;

  return { ok: true, metadata: { name, description, tags, tagsText } };
}

function sanitizeStickerTags(
  values: string[] | undefined
):
  | { ok: true; tags: string[]; tagsText: string }
  | { ok: false; error: string } {
  if (!values?.length) {
    return {
      ok: false,
      error:
        "Sticker tags are required. Provide one or more short Discord search tags."
    };
  }

  const tags: string[] = [];

  for (const value of values) {
    const tag = value
      .trim()
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!tag || tags.includes(tag)) continue;
    tags.push(tag);
  }

  const tagsText = tags.join(", ");
  if (!tagsText) {
    return {
      ok: false,
      error:
        "Sticker tags are required. Provide one or more valid Discord search tags."
    };
  }

  if (tagsText.length > STICKER_TAGS_MAX_TOTAL_CHARS) {
    return {
      ok: false,
      error: `Sticker tags are too long. Provide shorter tags totaling at most ${STICKER_TAGS_MAX_TOTAL_CHARS} characters.`
    };
  }

  return { ok: true, tags, tagsText };
}

function sanitizeStickerName(value: string | undefined) {
  const name = value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, STICKER_NAME_MAX_CHARS);

  return name && name.length >= STICKER_NAME_MIN_CHARS ? name : undefined;
}

function sanitizeStickerDescription(value: string | undefined) {
  const description = value?.trim();
  if (!description) return undefined;
  if (description.length < STICKER_DESCRIPTION_MIN_CHARS) return undefined;
  return description.slice(0, STICKER_DESCRIPTION_MAX_CHARS);
}

function inferStickerDescription(
  name: string,
  attachment: DiscordRequestAttachment
) {
  const words = splitWords(name).join(" ");
  const fallback = words
    ? `${capitalize(words)} sticker`
    : FALLBACK_DESCRIPTION;
  return (
    sanitizeStickerDescription(attachment.description) ??
    fallback.slice(0, STICKER_DESCRIPTION_MAX_CHARS)
  );
}

function splitWords(value: string) {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

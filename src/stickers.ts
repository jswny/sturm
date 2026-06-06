import { PermissionFlagsBits, type APISticker } from "discord-api-types/v10";
import { createGuildSticker, type DiscordApiEnv } from "./discord/api";
import { hasDiscordPermission } from "./discord/permissions";
import type {
  DiscordChatRequest,
  DiscordRequestAttachment
} from "./discord/types";
import {
  isSupportedStaticImageAttachment,
  STATIC_EXPRESSION_MIME_TYPE,
  transformStaticAttachmentImage
} from "./expression-images";
import { getErrorMessage } from "./logging";

const STICKER_SIZE_PX = 320;
const MAX_STICKER_BYTES = 512 * 1024;
const STATIC_STICKER_FILENAME = "sticker.png";
const FALLBACK_DESCRIPTION = "Sticker created by Sturm";
const FALLBACK_TAG = "sticker";

export type StickerEnv = DiscordApiEnv;

export type StickerRequestContext = Pick<
  DiscordChatRequest,
  "guildId" | "userId" | "userPermissions" | "attachments"
>;

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
  tags?: string[];
};

type PreparedStickerMetadata = {
  name: string;
  description: string;
  tags: string[];
  tagsText: string;
};

export async function createGuildStickerFromAttachment(
  env: StickerEnv,
  context: StickerRequestContext,
  input: CreateStickerInput
): Promise<CreateStickerFromAttachmentResponse> {
  const attachment = context.attachments?.find(
    (item) => item.id === input.attachmentId
  );
  const baseResponse = {
    ok: false,
    action: "created_sticker",
    guildId: context.guildId,
    callerUserId: context.userId,
    sourceAttachmentId: input.attachmentId,
    sourceFilename: attachment?.filename
  } satisfies CreateStickerFromAttachmentResponse;

  if (!context.guildId) {
    return {
      ...baseResponse,
      error: "Stickers can only be created in a Discord server."
    };
  }

  if (
    !hasDiscordPermission(
      context.userPermissions,
      PermissionFlagsBits.CreateGuildExpressions
    )
  ) {
    return {
      ...baseResponse,
      error:
        "You need Discord's Create Guild Expressions permission to create stickers."
    };
  }

  if (!attachment) {
    return {
      ...baseResponse,
      error: "That attachment was not found on the current /c request."
    };
  }

  if (!isSupportedStaticImageAttachment(attachment)) {
    return {
      ...baseResponse,
      error:
        "Only static PNG, JPEG, WebP, or GIF image attachments can be made into stickers."
    };
  }

  const metadata = prepareStickerMetadata(input, attachment);
  if (!metadata) {
    return {
      ...baseResponse,
      error:
        "A sticker name is required. Ask the user for a name when they did not provide one and the request does not make one obvious."
    };
  }

  const processed = await transformStaticAttachmentImage(attachment, {
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
    const sticker = (await createGuildSticker(env, context.guildId, {
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
      guildId: context.guildId,
      callerUserId: context.userId,
      sourceAttachmentId: attachment.id,
      sourceFilename: attachment.filename,
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
): PreparedStickerMetadata | null {
  const name = sanitizeStickerName(input.name);
  if (!name) return null;

  const description =
    sanitizeStickerDescription(input.description) ??
    inferStickerDescription(name, attachment);
  const tags = sanitizeStickerTags(input.tags, name, attachment);
  const tagsText = tags.join(", ");
  if (!tagsText || tagsText.length > 200) return null;

  return { name, description, tags, tagsText };
}

function sanitizeStickerName(value: string | undefined) {
  const name = value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);

  return name && name.length >= 2 ? name : undefined;
}

function sanitizeStickerDescription(value: string | undefined) {
  const description = value?.trim();
  if (!description) return undefined;
  if (description.length < 2) return undefined;
  return description.slice(0, 100);
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
    sanitizeStickerDescription(attachment.description) ?? fallback.slice(0, 100)
  );
}

function sanitizeStickerTags(
  values: string[] | undefined,
  name: string,
  attachment: DiscordRequestAttachment
) {
  const candidates = [
    ...(values ?? []),
    ...splitWords(name),
    ...splitWords(attachment.filename),
    FALLBACK_TAG
  ];
  const tags: string[] = [];

  for (const candidate of candidates) {
    const tag = candidate
      .trim()
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!tag || tags.includes(tag)) continue;

    const next = [...tags, tag].join(", ");
    if (next.length > 200) break;
    tags.push(tag);
  }

  return tags.length > 0 ? tags : [FALLBACK_TAG];
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

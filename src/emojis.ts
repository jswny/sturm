import { type APIEmoji } from "discord-api-types/v10";
import { createGuildEmoji, type DiscordApiEnv } from "./discord/api";
import {
  createDataUri,
  prepareStaticExpressionAttachment,
  STATIC_EXPRESSION_MIME_TYPE,
  type StaticExpressionRequestContext,
  transformStaticAttachmentImage
} from "./expression-images";
import { getErrorMessage } from "./logging";

const EMOJI_SIZE_PX = 128;
const MAX_EMOJI_BYTES = 256 * 1024;
export const EMOJI_NAME_MIN_CHARS = 2;
export const EMOJI_NAME_MAX_CHARS = 32;

export type EmojiEnv = DiscordApiEnv;

export type EmojiRequestContext = StaticExpressionRequestContext;

export type CreateEmojiFromAttachmentResponse = {
  ok: boolean;
  action: "created_emoji";
  emojiId?: string;
  guildId?: string;
  callerUserId?: string;
  sourceAttachmentId?: string;
  sourceFilename?: string;
  name?: string;
  shortcode?: string;
  mention?: string;
  processedMimeType?: "image/png";
  processedSizeBytes?: number;
  width?: 128;
  height?: 128;
  error?: string;
};

type CreateEmojiInput = {
  attachmentId: string;
  name?: string;
};

export async function createGuildEmojiFromAttachment(
  env: EmojiEnv,
  context: EmojiRequestContext,
  input: CreateEmojiInput
): Promise<CreateEmojiFromAttachmentResponse> {
  const prepared = prepareStaticExpressionAttachment(
    context,
    input.attachmentId,
    {
      targetName: "emoji",
      targetNamePlural: "emojis"
    }
  );
  const baseResponse = {
    ok: false,
    action: "created_emoji",
    ...prepared.baseFields
  } satisfies CreateEmojiFromAttachmentResponse;

  if (!prepared.ok) {
    return {
      ...baseResponse,
      error: prepared.error
    };
  }

  const name = sanitizeEmojiName(input.name);
  if (!name) {
    return {
      ...baseResponse,
      error:
        "An emoji name is required. Ask the user for a name when they did not provide one and the request does not make one obvious."
    };
  }

  const processed = await transformStaticAttachmentImage(prepared.attachment, {
    targetName: "emoji",
    sizePx: EMOJI_SIZE_PX,
    maxBytes: MAX_EMOJI_BYTES
  });
  if (!processed.ok) {
    return {
      ...baseResponse,
      name,
      error: processed.error
    };
  }

  try {
    const emoji = (await createGuildEmoji(env, prepared.guildId, {
      name,
      image: createDataUri(STATIC_EXPRESSION_MIME_TYPE, processed.image.base64),
      reason: `Emoji created by ${context.userId ?? "unknown user"} through Sturm`
    })) as APIEmoji;
    const createdName = emoji.name ?? name;

    return {
      ok: true,
      action: "created_emoji",
      emojiId: emoji.id ?? undefined,
      guildId: prepared.guildId,
      callerUserId: context.userId,
      sourceAttachmentId: prepared.attachment.id,
      sourceFilename: prepared.attachment.filename,
      name: createdName,
      shortcode: `:${createdName}:`,
      mention: emoji.id ? `<:${createdName}:${emoji.id}>` : undefined,
      processedMimeType: STATIC_EXPRESSION_MIME_TYPE,
      processedSizeBytes: processed.image.sizeBytes,
      width: EMOJI_SIZE_PX,
      height: EMOJI_SIZE_PX
    };
  } catch (error) {
    return {
      ...baseResponse,
      name,
      processedMimeType: STATIC_EXPRESSION_MIME_TYPE,
      processedSizeBytes: processed.image.sizeBytes,
      width: EMOJI_SIZE_PX,
      height: EMOJI_SIZE_PX,
      error: `Discord emoji upload failed: ${getErrorMessage(error)}`
    };
  }
}

function sanitizeEmojiName(value: string | undefined) {
  const name = value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, EMOJI_NAME_MAX_CHARS);

  return name && name.length >= EMOJI_NAME_MIN_CHARS ? name : undefined;
}

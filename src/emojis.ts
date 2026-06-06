import { PermissionFlagsBits, type APIEmoji } from "discord-api-types/v10";
import { createGuildEmoji, type DiscordApiEnv } from "./discord/api";
import { hasDiscordPermission } from "./discord/permissions";
import type { DiscordChatRequest } from "./discord/types";
import {
  createDataUri,
  isSupportedStaticImageAttachment,
  STATIC_EXPRESSION_MIME_TYPE,
  transformStaticAttachmentImage
} from "./expression-images";
import { getErrorMessage } from "./logging";

const EMOJI_SIZE_PX = 128;
const MAX_EMOJI_BYTES = 256 * 1024;

export type EmojiEnv = DiscordApiEnv;

export type EmojiRequestContext = Pick<
  DiscordChatRequest,
  "guildId" | "userId" | "userPermissions" | "attachments"
>;

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
  const attachment = context.attachments?.find(
    (item) => item.id === input.attachmentId
  );
  const baseResponse = {
    ok: false,
    action: "created_emoji",
    guildId: context.guildId,
    callerUserId: context.userId,
    sourceAttachmentId: input.attachmentId,
    sourceFilename: attachment?.filename
  } satisfies CreateEmojiFromAttachmentResponse;

  if (!context.guildId) {
    return {
      ...baseResponse,
      error: "Emojis can only be created in a Discord server."
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
        "You need Discord's Create Guild Expressions permission to create emojis."
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
        "Only static PNG, JPEG, WebP, or GIF image attachments can be made into emojis."
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

  const processed = await transformStaticAttachmentImage(attachment, {
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
    const emoji = (await createGuildEmoji(env, context.guildId, {
      name,
      image: createDataUri(STATIC_EXPRESSION_MIME_TYPE, processed.image.base64),
      reason: `Emoji created by ${context.userId ?? "unknown user"} through Sturm`
    })) as APIEmoji;
    const createdName = emoji.name ?? name;

    return {
      ok: true,
      action: "created_emoji",
      emojiId: emoji.id ?? undefined,
      guildId: context.guildId,
      callerUserId: context.userId,
      sourceAttachmentId: attachment.id,
      sourceFilename: attachment.filename,
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
    .slice(0, 32);

  return name && name.length >= 2 ? name : undefined;
}

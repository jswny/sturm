import { PermissionFlagsBits } from "discord-api-types/v10";
import { requireDiscordPermission } from "./discord/permissions";
import type {
  DiscordChatRequest,
  DiscordRequestAttachment
} from "./discord/types";
import { logWarn } from "./logging";

export const STATIC_EXPRESSION_MIME_TYPE = "image/png";

const TRANSFORM_QUALITIES: Array<number | undefined> = [
  undefined,
  90,
  70,
  50,
  30
];

export type StaticExpressionImage = {
  base64: string;
  sizeBytes: number;
};

export type StaticExpressionRequestContext = Pick<
  DiscordChatRequest,
  "guildId" | "userId" | "userPermissions" | "attachments"
>;

export type StaticExpressionBaseFields = {
  guildId?: string;
  callerUserId?: string;
  sourceAttachmentId?: string;
  sourceFilename?: string;
};

type PrepareStaticExpressionAttachmentOptions = {
  targetName: string;
  targetNamePlural: string;
};

export function prepareStaticExpressionAttachment(
  context: StaticExpressionRequestContext,
  attachmentId: string,
  options: PrepareStaticExpressionAttachmentOptions
):
  | {
      ok: true;
      guildId: string;
      attachment: DiscordRequestAttachment;
      baseFields: StaticExpressionBaseFields;
    }
  | {
      ok: false;
      baseFields: StaticExpressionBaseFields;
      error: string;
    } {
  const attachment = context.attachments?.find(
    (item) => item.id === attachmentId
  );
  const baseFields = {
    guildId: context.guildId,
    callerUserId: context.userId,
    sourceAttachmentId: attachmentId,
    sourceFilename: attachment?.filename
  } satisfies StaticExpressionBaseFields;

  if (!context.guildId) {
    return {
      ok: false,
      baseFields,
      error: `${capitalize(options.targetNamePlural)} can only be created in a Discord server.`
    };
  }

  const permission = requireDiscordPermission(
    context.userPermissions,
    PermissionFlagsBits.CreateGuildExpressions,
    {
      deniedMessage: `You need Discord's Create Guild Expressions permission to create ${options.targetNamePlural}.`
    }
  );
  if (!permission.ok) {
    return {
      ok: false,
      baseFields,
      error: permission.error
    };
  }

  if (!attachment) {
    return {
      ok: false,
      baseFields,
      error: "That attachment was not found on the current /c request."
    };
  }

  if (!isSupportedStaticImageAttachment(attachment)) {
    return {
      ok: false,
      baseFields,
      error: `Only static PNG, JPEG, WebP, or GIF image attachments can be made into ${options.targetNamePlural}.`
    };
  }

  return {
    ok: true,
    guildId: context.guildId,
    attachment,
    baseFields
  };
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function isSupportedStaticImageAttachment(
  attachment: DiscordRequestAttachment
) {
  const mimeType = attachment.mimeType?.toLowerCase();
  if (
    mimeType === "image/png" ||
    mimeType === "image/jpeg" ||
    mimeType === "image/webp" ||
    mimeType === "image/gif"
  ) {
    return true;
  }

  return /\.(png|jpe?g|webp|gif)$/i.test(attachment.filename);
}

export async function transformStaticAttachmentImage(
  attachment: DiscordRequestAttachment,
  options: {
    targetName: string;
    sizePx: number;
    maxBytes: number;
  }
): Promise<
  { ok: true; image: StaticExpressionImage } | { ok: false; error: string }
> {
  let lastSizeBytes: number | undefined;
  const sourceUrl = attachment.proxyUrl ?? attachment.url;

  for (const quality of TRANSFORM_QUALITIES) {
    const imageOptions: RequestInitCfPropertiesImage = {
      anim: false,
      background: "rgba(0,0,0,0)",
      fit: "pad",
      format: "png",
      height: options.sizePx,
      metadata: "none",
      width: options.sizePx,
      ...(quality === undefined ? {} : { quality })
    };

    const response = await fetch(
      new Request(sourceUrl, {
        headers: { accept: STATIC_EXPRESSION_MIME_TYPE }
      }),
      {
        cf: {
          image: imageOptions
        }
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logWarn("Discord expression image transform failed", {
        targetName: options.targetName,
        attachmentId: attachment.id,
        filename: attachment.filename,
        status: response.status,
        body: body.slice(0, 200)
      });
      return {
        ok: false,
        error: `Cloudflare could not transform that image into a ${options.targetName}.`
      };
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    lastSizeBytes = bytes.byteLength;
    if (bytes.byteLength <= options.maxBytes) {
      return {
        ok: true,
        image: {
          base64: bytesToBase64(bytes),
          sizeBytes: bytes.byteLength
        }
      };
    }
  }

  return {
    ok: false,
    error: `The processed ${options.targetName} was still too large${
      lastSizeBytes ? ` (${lastSizeBytes} bytes)` : ""
    }. Discord ${options.targetName}s must be at most ${options.maxBytes} bytes.`
  };
}

export function createDataUri(mimeType: string, base64: string) {
  return `data:${mimeType};base64,${base64}`;
}

function bytesToBase64(bytes: Uint8Array) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return btoa(binary);
}

import { PermissionFlagsBits } from "discord-api-types/v10";
import type { StoredResponseArtifact } from "./artifacts";
import { requireDiscordPermission } from "./discord/permissions";
import type { DiscordChatRequest } from "./discord/types";
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

export type StaticExpressionImageEnv = {
  ARTIFACTS_BUCKET: R2Bucket;
  IMAGES: ImagesBinding;
};

export type StaticExpressionRequestContext = Pick<
  DiscordChatRequest,
  "guildId" | "userId" | "userPermissions" | "artifacts"
>;

export type StaticExpressionBaseFields = {
  guildId?: string;
  callerUserId?: string;
  sourceArtifactId?: string;
  sourceArtifactSource?: StoredResponseArtifact["source"];
  sourceFilename?: string;
};

export type StaticExpressionSource = {
  artifactId: string;
  source: StoredResponseArtifact["source"];
  filename: string;
  mimeType?: string;
  artifactKey?: string;
  sha256?: string;
  width?: number;
  height?: number;
  description?: string;
};

type PrepareStaticExpressionArtifactOptions = {
  targetName: string;
  targetNamePlural: string;
};

export function prepareStaticExpressionArtifact(
  context: StaticExpressionRequestContext,
  artifactId: string,
  options: PrepareStaticExpressionArtifactOptions
):
  | {
      ok: true;
      guildId: string;
      artifact: StaticExpressionSource;
      baseFields: StaticExpressionBaseFields;
    }
  | {
      ok: false;
      baseFields: StaticExpressionBaseFields;
      error: string;
    } {
  const storedArtifact = context.artifacts?.find((item) =>
    matchesArtifactId(item, artifactId)
  );
  const artifact = storedArtifact
    ? toStaticExpressionSource(storedArtifact)
    : undefined;
  const baseFields = {
    guildId: context.guildId,
    callerUserId: context.userId,
    sourceArtifactId: artifactId,
    sourceArtifactSource: artifact?.source,
    sourceFilename: artifact?.filename
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

  if (!artifact) {
    return {
      ok: false,
      baseFields,
      error:
        "That artifact reference is not available in the current conversation context. Use a listed artifactId, or ask the user to reattach the image."
    };
  }

  if (!isSupportedStaticImageArtifact(artifact)) {
    return {
      ok: false,
      baseFields,
      error: `Only static PNG, JPEG, WebP, or GIF image artifacts can be made into ${options.targetNamePlural}.`
    };
  }

  return {
    ok: true,
    guildId: context.guildId,
    artifact,
    baseFields
  };
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function isSupportedStaticImageArtifact(
  artifact: StaticExpressionSource
) {
  const mimeType = artifact.mimeType?.toLowerCase();
  if (
    mimeType === "image/png" ||
    mimeType === "image/jpeg" ||
    mimeType === "image/webp" ||
    mimeType === "image/gif"
  ) {
    return true;
  }

  return /\.(png|jpe?g|webp|gif)$/i.test(artifact.filename);
}

export async function transformStaticArtifactImage(
  env: StaticExpressionImageEnv,
  artifact: StaticExpressionSource,
  options: {
    targetName: string;
    sizePx: number;
    maxBytes: number;
  }
): Promise<
  { ok: true; image: StaticExpressionImage } | { ok: false; error: string }
> {
  let lastSizeBytes: number | undefined;
  for (const quality of TRANSFORM_QUALITIES) {
    const source = await openStaticArtifactImageSource(
      env,
      artifact,
      options.targetName
    );
    if (!source.ok) {
      return {
        ok: false,
        error: source.error
      };
    }

    let transformed: ImageTransformationResult;
    try {
      transformed = await env.IMAGES.input(source.body)
        .transform({
          background: "rgba(0,0,0,0)",
          fit: "pad",
          height: options.sizePx,
          width: options.sizePx
        })
        .output({
          anim: false,
          format: STATIC_EXPRESSION_MIME_TYPE,
          ...(quality === undefined ? {} : { quality })
        });
    } catch (error) {
      logWarn("Discord expression image transform failed", {
        targetName: options.targetName,
        artifactId: artifact.artifactId,
        source: artifact.source,
        filename: artifact.filename,
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        ok: false,
        error: `Cloudflare could not transform that image into a ${options.targetName}.`
      };
    }

    const buffer = await new Response(transformed.image()).arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const contentType = transformed.contentType();
    lastSizeBytes = bytes.byteLength;
    if (!isPng(bytes, contentType)) {
      logWarn("Discord expression image transform returned non-PNG bytes", {
        targetName: options.targetName,
        artifactId: artifact.artifactId,
        source: artifact.source,
        filename: artifact.filename,
        contentType,
        sizeBytes: bytes.byteLength,
        signature: getByteSignature(bytes)
      });
      return {
        ok: false,
        error: `Cloudflare did not return a valid PNG for that ${options.targetName}.`
      };
    }

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

function matchesArtifactId(
  artifact: StoredResponseArtifact,
  artifactId: string
) {
  return artifact.id === artifactId;
}

function toStaticExpressionSource(
  artifact: StoredResponseArtifact
): StaticExpressionSource {
  const dimensions = getArtifactDimensions(artifact);
  return {
    artifactId: artifact.id,
    source: artifact.source,
    filename: artifact.filename,
    mimeType: artifact.mimeType,
    artifactKey: artifact.artifactKey,
    sha256: artifact.sha256,
    width: dimensions?.width,
    height: dimensions?.height,
    description: artifact.description
  };
}

function getArtifactDimensions(artifact: StoredResponseArtifact) {
  switch (artifact.source) {
    case "discord_attachment":
      return artifact.metadata.width && artifact.metadata.height
        ? { width: artifact.metadata.width, height: artifact.metadata.height }
        : undefined;
    case "image_generation":
      return artifact.metadata.width && artifact.metadata.height
        ? { width: artifact.metadata.width, height: artifact.metadata.height }
        : undefined;
    case "workspace_export":
      return undefined;
  }
}

async function openStaticArtifactImageSource(
  env: StaticExpressionImageEnv,
  artifact: StaticExpressionSource,
  targetName: string
): Promise<
  | { ok: true; body: ReadableStream }
  | {
      ok: false;
      error: string;
    }
> {
  if (artifact.artifactKey) {
    const object = await env.ARTIFACTS_BUCKET.get(artifact.artifactKey);
    if (object?.body) return { ok: true, body: object.body };

    logWarn("Discord expression image artifact was missing", {
      targetName,
      artifactId: artifact.artifactId,
      source: artifact.source,
      artifactKey: artifact.artifactKey,
      filename: artifact.filename
    });
  }

  return {
    ok: false,
    error: `The stored image artifact was unavailable for that ${targetName}.`
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

function isPng(bytes: Uint8Array, contentType: string) {
  return (
    contentType.toLowerCase().split(";")[0].trim() ===
      STATIC_EXPRESSION_MIME_TYPE &&
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function getByteSignature(bytes: Uint8Array) {
  return Array.from(bytes.slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join(" ");
}

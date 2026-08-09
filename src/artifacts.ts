export type ArtifactEnv = Env & {
  ARTIFACTS_BUCKET: R2Bucket;
};

export type ResponseArtifactSource = keyof ResponseArtifactMetadataBySource;

export type ImageGenerationArtifactMetadata = {
  prompt: string;
  model: string;
  width?: number;
  height?: number;
  aspectRatio?: string;
  outputFormat?: string;
  resolution?: string;
};

export type WorkspaceExportArtifactMetadata = {
  workspacePath: string;
};

export type DiscordAttachmentArtifactMetadata = {
  guildId?: string;
  channelId?: string;
  correlationId: string;
  discordInteractionId?: string;
  discordAttachmentId: string;
  sourceUrl: string;
  width?: number;
  height?: number;
};

export type ResponseArtifactMetadataBySource = {
  discord_attachment: DiscordAttachmentArtifactMetadata;
  image_generation: ImageGenerationArtifactMetadata;
  workspace_export: WorkspaceExportArtifactMetadata;
};

type StoredResponseArtifactBase = {
  id: string;
  filename: string;
  mimeType: string;
  artifactKey: string;
  sha256: string;
  description?: string;
  visualSummary?: string;
};

export type StoredResponseArtifact<
  Source extends ResponseArtifactSource = ResponseArtifactSource
> = Source extends ResponseArtifactSource
  ? StoredResponseArtifactBase & {
      source: Source;
      metadata: ResponseArtifactMetadataBySource[Source];
    }
  : never;

export type ResponseArtifact<
  Source extends ResponseArtifactSource = ResponseArtifactSource
> = Source extends ResponseArtifactSource
  ? StoredResponseArtifact<Source> & {
      base64: string;
    }
  : never;

export type StoreResponseArtifactInput<
  Source extends ResponseArtifactSource = ResponseArtifactSource
> = Source extends ResponseArtifactSource
  ? Omit<StoredResponseArtifact<Source>, "id" | "artifactKey" | "sha256"> & {
      id?: string;
      artifactKey?: string;
      bytes: Uint8Array;
      base64?: string;
      keyPrefix: string;
    }
  : never;

export type HydrateStoredArtifactsOptions = {
  maxArtifacts?: number;
  maxTotalBytes?: number;
};

export async function storeResponseArtifact<
  Source extends ResponseArtifactSource
>(
  env: ArtifactEnv,
  input: StoreResponseArtifactInput<Source>
): Promise<ResponseArtifact<Source>> {
  const id = input.id ?? crypto.randomUUID();
  const filename = sanitizeArtifactFilename(input.filename, `${id}.bin`);
  const artifactKey =
    input.artifactKey ?? createDatedArtifactKey(input.keyPrefix, id, filename);
  const sha256 = await hashSha256(input.bytes);

  await env.ARTIFACTS_BUCKET.put(artifactKey, input.bytes, {
    httpMetadata: {
      contentType: input.mimeType
    }
  });

  return {
    id,
    source: input.source,
    filename,
    mimeType: input.mimeType,
    artifactKey,
    sha256,
    description: input.description,
    visualSummary: input.visualSummary,
    metadata: input.metadata,
    base64: input.base64 ?? bytesToBase64(input.bytes)
  } as ResponseArtifact<Source>;
}

export async function hydrateStoredArtifacts(
  env: ArtifactEnv,
  storedArtifacts: StoredResponseArtifact[] = [],
  options: HydrateStoredArtifactsOptions = {}
): Promise<ResponseArtifact[]> {
  if (
    options.maxArtifacts !== undefined &&
    storedArtifacts.length > options.maxArtifacts
  ) {
    throw new Error(
      `Response has ${storedArtifacts.length} artifacts; the limit is ${options.maxArtifacts}.`
    );
  }

  const artifacts: ResponseArtifact[] = [];
  let totalBytes = 0;
  for (const stored of storedArtifacts) {
    const object = await env.ARTIFACTS_BUCKET.get(stored.artifactKey);
    if (!object) {
      throw new Error(`Missing response artifact ${stored.artifactKey}.`);
    }

    totalBytes += object.size;
    if (
      options.maxTotalBytes !== undefined &&
      totalBytes > options.maxTotalBytes
    ) {
      throw new Error(
        `Response artifacts exceed the ${options.maxTotalBytes} byte limit.`
      );
    }

    artifacts.push({
      ...stored,
      base64: bytesToBase64(new Uint8Array(await object.arrayBuffer()))
    });
  }
  return artifacts;
}

export function toStoredResponseArtifact(
  artifact: ResponseArtifact
): StoredResponseArtifact {
  const { base64: _base64, ...stored } = artifact;
  return stored;
}

export function sanitizeArtifactFilename(filename: string, fallback: string) {
  const basename = getBasename(filename.trim()) || fallback;
  const sanitized = basename
    .replace(/[^\w.()+@ -]/g, "_")
    .replace(/\s+/g, "-")
    .slice(0, 120)
    .replace(/^\.+$/, "");

  return sanitized || fallback;
}

export function getBasename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string) {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

async function hashSha256(bytes: Uint8Array) {
  const digestInput = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    digestInput.buffer as ArrayBuffer
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function createDatedArtifactKey(prefix: string, id: string, filename: string) {
  const date = new Date().toISOString().slice(0, 10);
  return `${prefix}/${date}/${id}-${filename}`;
}

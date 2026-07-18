import { logError, logWarn, getErrorMessage } from "./logging";
import {
  storeResponseArtifact,
  type ArtifactEnv,
  type ResponseArtifact,
  type ImageGenerationArtifactMetadata
} from "./artifacts";
import {
  CHAT_AI_GATEWAY_FLOWS,
  CHAT_AI_GATEWAY_ID,
  DEFAULT_IMAGE_ASPECT_RATIO,
  DEFAULT_IMAGE_RESOLUTION,
  IMAGE_GENERATION_GOOGLE_SEARCH,
  IMAGE_GENERATION_IMAGE_SEARCH,
  IMAGE_GENERATION_MODEL,
  IMAGE_GENERATION_OUTPUT_FORMAT,
  IMAGE_GENERATION_TIMEOUT_MS,
  createChatAiGatewayMetadata,
  type ChatAiGatewayCorrelation
} from "./model";

export type ImageEnv = ArtifactEnv;

export type GeneratedImage = ResponseArtifact<"image_generation">;

export type ImageAspectRatio =
  | "1:1"
  | "2:3"
  | "3:2"
  | "3:4"
  | "4:3"
  | "4:5"
  | "5:4"
  | "9:16"
  | "16:9"
  | "21:9";
export type ImageResolution = "1K" | "2K" | "4K";

export type GenerateImageInput = {
  prompt: string;
  aspectRatio?: ImageAspectRatio;
  resolution?: ImageResolution;
};

export type GenerateImageOptions = {
  correlation?: ChatAiGatewayCorrelation;
};

export type GenerateImageResponse = {
  success: boolean;
  attached?: boolean;
  artifactId?: string;
  aspectRatio?: ImageAspectRatio;
  resolution?: ImageResolution;
  error?: string;
};

type NanoBananaImageResponse = {
  result?: {
    image?: unknown;
  };
  state?: unknown;
};

export const IMAGE_MODEL = IMAGE_GENERATION_MODEL;

export async function generateImage(
  env: ImageEnv,
  input: GenerateImageInput,
  options: GenerateImageOptions = {}
): Promise<{ artifact?: GeneratedImage; response: GenerateImageResponse }> {
  const request = normalizeGenerateImageInput(input);
  const { prompt, aspectRatio, resolution } = request;
  const outputFormat = IMAGE_GENERATION_OUTPUT_FORMAT;

  let result: NanoBananaImageResponse;
  try {
    result = (await env.AI.run(
      IMAGE_MODEL,
      {
        prompt,
        aspect_ratio: aspectRatio,
        output_format: outputFormat,
        resolution,
        google_search: IMAGE_GENERATION_GOOGLE_SEARCH,
        image_search: IMAGE_GENERATION_IMAGE_SEARCH
      },
      {
        gateway: {
          id: CHAT_AI_GATEWAY_ID,
          skipCache: true,
          requestTimeoutMs: IMAGE_GENERATION_TIMEOUT_MS,
          metadata: createChatAiGatewayMetadata(
            CHAT_AI_GATEWAY_FLOWS.imageGeneration,
            options.correlation ?? {}
          )
        }
      }
    )) as NanoBananaImageResponse;
  } catch (error) {
    logError("AI Gateway image generation failed", error, {
      model: IMAGE_MODEL,
      aiGatewayLogId: env.AI.aiGatewayLogId,
      aspectRatio,
      googleSearch: IMAGE_GENERATION_GOOGLE_SEARCH,
      imageSearch: IMAGE_GENERATION_IMAGE_SEARCH,
      outputFormat,
      resolution
    });
    return {
      response: {
        success: false,
        attached: false,
        aspectRatio,
        resolution,
        error: "AI Gateway image generation failed."
      }
    };
  }

  const imageUrl = getGeneratedImageUrl(result);
  if (!imageUrl) {
    logWarn("AI Gateway image generation returned no image URL", {
      model: IMAGE_MODEL,
      aiGatewayLogId: env.AI.aiGatewayLogId,
      state: result.state,
      aspectRatio,
      googleSearch: IMAGE_GENERATION_GOOGLE_SEARCH,
      imageSearch: IMAGE_GENERATION_IMAGE_SEARCH,
      outputFormat,
      resolution
    });
    return {
      response: {
        success: false,
        attached: false,
        aspectRatio,
        resolution,
        error: "AI Gateway image generation returned no image."
      }
    };
  }

  let downloaded: DownloadedImage;
  try {
    downloaded = await downloadGeneratedImage(imageUrl);
  } catch (error) {
    logError("AI Gateway generated image download failed", error, {
      model: IMAGE_MODEL,
      aiGatewayLogId: env.AI.aiGatewayLogId,
      aspectRatio,
      googleSearch: IMAGE_GENERATION_GOOGLE_SEARCH,
      imageSearch: IMAGE_GENERATION_IMAGE_SEARCH,
      outputFormat,
      resolution
    });
    return {
      response: {
        success: false,
        attached: false,
        aspectRatio,
        resolution,
        error: "Generated image could not be downloaded."
      }
    };
  }

  const id = crypto.randomUUID();
  const filename = `${id}-generated-image.${downloaded.extension}`;

  try {
    const artifact = (await storeResponseArtifact(env, {
      id,
      source: "image_generation",
      mimeType: downloaded.mimeType,
      filename,
      artifactKey: createGeneratedImageArtifactKey(filename),
      keyPrefix: "images/generated",
      bytes: downloaded.bytes,
      metadata: {
        prompt,
        model: IMAGE_MODEL,
        aspectRatio,
        resolution
      } satisfies ImageGenerationArtifactMetadata,
      description: `Generated image for: ${prompt}`
    })) as GeneratedImage;

    return {
      artifact,
      response: {
        success: true,
        attached: true,
        artifactId: artifact.id,
        aspectRatio,
        resolution
      }
    };
  } catch (error) {
    logError("Generated image artifact storage failed", error, {
      model: IMAGE_MODEL,
      artifactKey: createGeneratedImageArtifactKey(filename),
      aiGatewayLogId: env.AI.aiGatewayLogId,
      aspectRatio,
      googleSearch: IMAGE_GENERATION_GOOGLE_SEARCH,
      imageSearch: IMAGE_GENERATION_IMAGE_SEARCH,
      outputFormat,
      resolution
    });
    return {
      response: {
        success: false,
        attached: false,
        aspectRatio,
        resolution,
        error: "Generated image could not be stored."
      }
    };
  }
}

type NormalizedGenerateImageInput = Required<
  Pick<GenerateImageInput, "prompt" | "aspectRatio" | "resolution">
>;

type DownloadedImage = {
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
};

function normalizeGenerateImageInput(
  input: GenerateImageInput
): NormalizedGenerateImageInput {
  return {
    prompt: input.prompt,
    aspectRatio: input.aspectRatio ?? DEFAULT_IMAGE_ASPECT_RATIO,
    resolution: input.resolution ?? DEFAULT_IMAGE_RESOLUTION
  };
}

function getGeneratedImageUrl(result: NanoBananaImageResponse) {
  const image = result.result?.image;
  if (typeof image !== "string") return undefined;
  const trimmed = image.trim();
  return trimmed || undefined;
}

async function downloadGeneratedImage(
  imageUrl: string
): Promise<DownloadedImage> {
  let response: Response;
  try {
    response = await fetch(imageUrl);
  } catch (error) {
    throw new Error(`Image download request failed: ${getErrorMessage(error)}`);
  }

  if (!response.ok) {
    throw new Error(`Image download failed with HTTP ${response.status}.`);
  }

  const mimeType = getRequiredJpegMimeType(
    response.headers.get("content-type")
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error("Image download returned an empty body.");
  }

  return {
    bytes,
    mimeType,
    extension: "jpg"
  };
}

function getRequiredJpegMimeType(contentType: string | null) {
  const mimeType = contentType?.split(";")[0]?.trim().toLowerCase();
  if (mimeType !== "image/jpeg") {
    throw new Error(
      `Image download returned unsupported content type ${contentType ?? "missing"}.`
    );
  }
  return mimeType;
}

function createGeneratedImageArtifactKey(filename: string) {
  const date = new Date().toISOString().slice(0, 10);
  return `images/generated/${date}/${filename}`;
}

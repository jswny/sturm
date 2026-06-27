import { logError, logWarn } from "./logging";
import {
  base64ToBytes,
  storeResponseArtifact,
  type ArtifactEnv,
  type ResponseArtifact,
  type ImageGenerationArtifactMetadata
} from "./artifacts";

export type ImageEnv = ArtifactEnv;

export type GeneratedImage = ResponseArtifact<"image_generation">;

export type GenerateImageResponse = {
  artifactId?: string;
  sha256?: string;
  prompt: string;
  model: string;
  width: number;
  height: number;
  error?: string;
};

type FluxImageResponse = {
  image?: string;
};

export const IMAGE_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";

function getImageFormat(base64: string) {
  if (base64.startsWith("/9j/")) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }

  if (base64.startsWith("iVBOR")) {
    return { mimeType: "image/png", extension: "png" };
  }

  return { mimeType: "application/octet-stream", extension: "bin" };
}

export async function generateImage(
  env: ImageEnv,
  prompt: string,
  width = 1024,
  height = 1024
): Promise<{ artifact?: GeneratedImage; response: GenerateImageResponse }> {
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", String(width));
  form.append("height", String(height));

  const formResponse = new Response(form);
  const body = formResponse.body;
  const contentType = formResponse.headers.get("content-type");

  if (!body || !contentType) {
    logWarn("Workers AI image generation request preparation failed", {
      model: IMAGE_MODEL,
      hasBody: Boolean(body),
      hasContentType: Boolean(contentType)
    });
    return {
      response: {
        prompt,
        model: IMAGE_MODEL,
        width,
        height,
        error: "Could not prepare image generation request."
      }
    };
  }

  let result: FluxImageResponse;
  try {
    result = (await env.AI.run(IMAGE_MODEL, {
      multipart: {
        body: body as unknown as object,
        contentType
      }
    })) as FluxImageResponse;
  } catch (error) {
    logError("Workers AI image generation failed", error, {
      model: IMAGE_MODEL,
      width,
      height
    });
    return {
      response: {
        prompt,
        model: IMAGE_MODEL,
        width,
        height,
        error: "Workers AI image generation failed."
      }
    };
  }

  if (!result.image) {
    logWarn("Workers AI image generation returned no image", {
      model: IMAGE_MODEL,
      width,
      height
    });
    return {
      response: {
        prompt,
        model: IMAGE_MODEL,
        width,
        height,
        error: "Workers AI image generation returned no image."
      }
    };
  }

  const id = crypto.randomUUID();
  const format = getImageFormat(result.image);
  const filename = `${id}-generated-image.${format.extension}`;
  const bytes = base64ToBytes(result.image);

  try {
    const artifact = (await storeResponseArtifact(env, {
      id,
      source: "image_generation",
      mimeType: format.mimeType,
      filename,
      artifactKey: createGeneratedImageArtifactKey(filename),
      keyPrefix: "images/generated",
      base64: result.image,
      bytes,
      metadata: {
        prompt,
        model: IMAGE_MODEL,
        width,
        height
      } satisfies ImageGenerationArtifactMetadata,
      description: `Generated image for: ${prompt}`
    })) as GeneratedImage;

    return {
      artifact,
      response: {
        artifactId: artifact.id,
        sha256: artifact.sha256,
        prompt,
        model: IMAGE_MODEL,
        width,
        height
      }
    };
  } catch (error) {
    logError("Generated image artifact storage failed", error, {
      model: IMAGE_MODEL,
      artifactKey: createGeneratedImageArtifactKey(filename),
      width,
      height
    });
    return {
      response: {
        prompt,
        model: IMAGE_MODEL,
        width,
        height,
        error: "Generated image could not be stored."
      }
    };
  }
}

function createGeneratedImageArtifactKey(filename: string) {
  const date = new Date().toISOString().slice(0, 10);
  return `images/generated/${date}/${filename}`;
}

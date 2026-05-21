import { logError, logWarn } from "./logging";

export type ImageEnv = Env & {
  ARTIFACTS_BUCKET: R2Bucket;
};

export type GeneratedImage = {
  id: string;
  prompt: string;
  model: string;
  mimeType: string;
  filename: string;
  r2Key: string;
  base64: string;
  width: number;
  height: number;
};

export type GenerateImageResponse = {
  id?: string;
  r2Key?: string;
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
  const filename = `sturm-${id}.${format.extension}`;
  const artifact = {
    id,
    prompt,
    model: IMAGE_MODEL,
    mimeType: format.mimeType,
    filename,
    r2Key: createGeneratedImageKey(id, format.extension),
    base64: result.image,
    width,
    height
  };

  try {
    await env.ARTIFACTS_BUCKET.put(
      artifact.r2Key,
      base64ToBytes(artifact.base64),
      {
        httpMetadata: {
          contentType: artifact.mimeType
        }
      }
    );
  } catch (error) {
    logError("Generated image R2 storage failed", error, {
      model: IMAGE_MODEL,
      r2Key: artifact.r2Key,
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

  return {
    artifact,
    response: {
      id,
      r2Key: artifact.r2Key,
      prompt,
      model: IMAGE_MODEL,
      width,
      height
    }
  };
}

function createGeneratedImageKey(id: string, extension: string) {
  const date = new Date().toISOString().slice(0, 10);
  return `images/generated/${date}/${id}.${extension}`;
}

function base64ToBytes(base64: string) {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

export type ImageEnv = Env;

export type GeneratedImage = {
  id: string;
  prompt: string;
  model: string;
  mimeType: string;
  filename: string;
  base64: string;
  width: number;
  height: number;
};

export type GenerateImageResponse = {
  id?: string;
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
    console.error("Workers AI image generation failed", {
      error: error instanceof Error ? error.message : String(error)
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
  const artifact = {
    id,
    prompt,
    model: IMAGE_MODEL,
    mimeType: format.mimeType,
    filename: `sturm-${id}.${format.extension}`,
    base64: result.image,
    width,
    height
  };

  return {
    artifact,
    response: {
      id,
      prompt,
      model: IMAGE_MODEL,
      width,
      height
    }
  };
}

export class BodyTooLargeError extends Error {
  constructor(
    readonly maxBytes: number,
    message = `Body exceeded the ${maxBytes} byte limit.`
  ) {
    super(message);
    this.name = "BodyTooLargeError";
  }
}

export async function readRequestTextWithLimit(
  request: Request,
  maxBytes: number
) {
  assertContentLengthWithinLimit(request.headers, maxBytes);
  return new TextDecoder().decode(
    await readStreamBytesWithLimit(request.body, maxBytes)
  );
}

export async function readResponseBytesWithLimit(
  response: Response,
  maxBytes: number
) {
  try {
    assertContentLengthWithinLimit(response.headers, maxBytes);
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    throw error;
  }
  return readStreamBytesWithLimit(response.body, maxBytes);
}

export async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number
) {
  return new TextDecoder().decode(
    await readResponseBytesWithLimit(response, maxBytes)
  );
}

function assertContentLengthWithinLimit(headers: Headers, maxBytes: number) {
  const value = headers.get("content-length");
  if (!value) return;

  const length = Number(value);
  if (Number.isFinite(length) && length >= 0 && length > maxBytes) {
    throw new BodyTooLargeError(maxBytes);
  }
}

async function readStreamBytesWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number
) {
  if (!stream) return new Uint8Array();

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("Body limit exceeded.").catch(() => undefined);
        throw new BodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

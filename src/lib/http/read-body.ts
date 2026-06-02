/**
 * Read a request body as text with a hard byte ceiling.
 *
 * `Request.json()` / `.text()` buffer the entire body into memory with no
 * cap, and a `Content-Length` pre-check is bypassable with chunked
 * transfer encoding (no/short length). This reader consumes the body
 * stream incrementally and aborts as soon as the accumulated size exceeds
 * `maxBytes`, so a multi-megabyte chunked upload cannot OOM the process.
 */

export class BodyTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

export async function readBodyTextWithLimit(
  req: Request,
  maxBytes: number,
): Promise<string> {
  if (!req.body) {
    // No stream (e.g. empty body) — fall back to the buffered read, which
    // is already bounded by the absence of content.
    const text = await req.text();
    if (Buffer.byteLength(text) > maxBytes) throw new BodyTooLargeError(maxBytes);
    return text;
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

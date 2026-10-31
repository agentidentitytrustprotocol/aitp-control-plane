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
  // Decoded the way `Request.text()` decodes (WHATWG UTF-8 decode: a leading
  // BOM is stripped, invalid sequences become U+FFFD), so swapping a route
  // from `req.text()` to this reader changes no accepted body.
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

/**
 * Body ceilings, one per route class (issue #150).
 *
 * MANIFEST_BODY_MAX_BYTES: `POST /api/registry/enroll` (public) and
 * `POST /api/registry/agents`, whose body is a ManifestEnvelope. It matches
 * aitp-rs's `DEFAULT_MAX_MANIFEST_BYTES` (256 KiB, `transport/client.rs`), the
 * size the SDK's own client accepts for a fetched Manifest, so no Manifest the
 * SDK would accept is refused here. Real ones are well under 1 KiB.
 *
 * ADMIN_JSON_MAX_BYTES: the admin JSON routes (`readJsonObject`). Their bodies
 * are a handful of short fields.
 */
export const MANIFEST_BODY_MAX_BYTES = 256 * 1024;
export const ADMIN_JSON_MAX_BYTES = 64 * 1024;

export type LimitedBodyResult =
  | { ok: true; text: string }
  | { ok: false; response: Response };

/** The `413` every bounded route answers, same body as `POST /api/events`. */
export function payloadTooLarge(maxBytes: number): Response {
  return Response.json(
    { error: `request body exceeds ${maxBytes} bytes`, code: 'PAYLOAD_TOO_LARGE' },
    { status: 413 },
  );
}

/**
 * Read the body with `readBodyTextWithLimit`, or yield the `413` for the
 * caller to return as-is. A declared `Content-Length` over the ceiling is
 * refused before a byte is read; the streaming ceiling still applies when the
 * header is absent or understated (chunked).
 */
export async function readLimitedBody(
  req: Request,
  maxBytes: number,
): Promise<LimitedBodyResult> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, response: payloadTooLarge(maxBytes) };
  }
  try {
    return { ok: true, text: await readBodyTextWithLimit(req, maxBytes) };
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return { ok: false, response: payloadTooLarge(maxBytes) };
    }
    throw err;
  }
}

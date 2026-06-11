import { BodyTooLargeError, readBodyTextWithLimit } from './read-body';

/** Build a Request whose body streams the given chunks one read() at a
 * time, so the byte-ceiling logic is exercised incrementally rather than
 * buffered all at once. */
function streamingRequest(chunks: Uint8Array[]): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  // `duplex: 'half'` is required by the WHATWG fetch spec when a Request
  // carries a ReadableStream body.
  return new Request('http://x', {
    method: 'POST',
    body: stream,
    // @ts-expect-error duplex is valid at runtime but missing from the DOM lib types
    duplex: 'half',
  });
}

const enc = new TextEncoder();

describe('readBodyTextWithLimit', () => {
  it('returns the full body when under the limit', async () => {
    const req = streamingRequest([enc.encode('hello'), enc.encode(' world')]);
    await expect(readBodyTextWithLimit(req, 100)).resolves.toBe('hello world');
  });

  it('reassembles multi-byte UTF-8 split across chunk boundaries', async () => {
    // '€' is 3 bytes (e2 82 ac); split it across two stream reads to prove
    // the reader concatenates raw bytes before decoding, not per-chunk.
    const euro = enc.encode('€'); // [0xe2, 0x82, 0xac]
    const req = streamingRequest([euro.slice(0, 1), euro.slice(1)]);
    await expect(readBodyTextWithLimit(req, 100)).resolves.toBe('€');
  });

  it('throws BodyTooLargeError once the stream exceeds the ceiling', async () => {
    // Each chunk is 4 bytes; the third pushes total to 12 > 10.
    const req = streamingRequest([
      enc.encode('aaaa'),
      enc.encode('bbbb'),
      enc.encode('cccc'),
    ]);
    await expect(readBodyTextWithLimit(req, 10)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it('accepts a body exactly at the limit (boundary is inclusive)', async () => {
    const req = streamingRequest([enc.encode('12345')]);
    await expect(readBodyTextWithLimit(req, 5)).resolves.toBe('12345');
  });

  it('rejects a body one byte over the limit', async () => {
    const req = streamingRequest([enc.encode('123456')]);
    await expect(readBodyTextWithLimit(req, 5)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it('falls back to buffered read when the request has no stream body', async () => {
    const req = new Request('http://x', { method: 'POST', body: 'plain' });
    // Some runtimes expose a stream even for string bodies; only assert the
    // contract (returns the text) which holds on both paths.
    await expect(readBodyTextWithLimit(req, 100)).resolves.toBe('plain');
  });

  it('enforces the limit on the buffered (no-stream) fallback path', async () => {
    // A GET-like Request with a manually nulled body forces the fallback
    // branch deterministically.
    const req = new Request('http://x', { method: 'GET' });
    Object.defineProperty(req, 'body', { value: null });
    Object.defineProperty(req, 'text', {
      value: async () => 'x'.repeat(20),
    });
    await expect(readBodyTextWithLimit(req, 10)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it('carries the configured maxBytes on the error', () => {
    const err = new BodyTooLargeError(2048);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BodyTooLargeError');
    expect(err.maxBytes).toBe(2048);
    expect(err.message).toContain('2048');
  });
});

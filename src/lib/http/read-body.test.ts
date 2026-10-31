import { BodyTooLargeError, readBodyTextWithLimit, readLimitedBody } from './read-body';

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

describe('readBodyTextWithLimit decodes like Request.text()', () => {
  it.each([
    ['a leading BOM', new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])],
    ['an invalid sequence', new Uint8Array([0x7b, 0xff, 0x7d])],
  ])('%s', async (_name, bytes) => {
    const expected = await new Request('http://x', { method: 'POST', body: bytes }).text();
    await expect(readBodyTextWithLimit(streamingRequest([bytes]), 100)).resolves.toBe(expected);
  });
});

describe('readBodyTextWithLimit on an endless stream', () => {
  it('stops pulling and cancels the stream once over the ceiling', async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = new Request('http://x', {
      method: 'POST',
      body: stream,
      // @ts-expect-error duplex is valid at runtime but missing from the DOM lib types
      duplex: 'half',
    });
    await expect(readBodyTextWithLimit(req, 4096)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(cancelled).toBe(true);
    // 5 chunks cross 4096; a small read-ahead is the stream's, not ours.
    expect(pulls).toBeLessThan(10);
  });
});

describe('readLimitedBody', () => {
  it('returns the text under the ceiling', async () => {
    const r = await readLimitedBody(new Request('http://x', { method: 'POST', body: 'abc' }), 3);
    expect(r).toEqual({ ok: true, text: 'abc' });
  });

  it('answers 413 PAYLOAD_TOO_LARGE one byte over', async () => {
    const r = await readLimitedBody(new Request('http://x', { method: 'POST', body: 'abcd' }), 3);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(413);
    await expect(r.response.json()).resolves.toEqual({
      error: 'request body exceeds 3 bytes',
      code: 'PAYLOAD_TOO_LARGE',
    });
  });

  it('refuses a declared Content-Length over the ceiling without reading', async () => {
    const req = new Request('http://x', {
      method: 'POST',
      body: 'ab',
      headers: { 'content-length': '999' },
    });
    const r = await readLimitedBody(req, 3);
    expect(r.ok).toBe(false);
    expect(req.bodyUsed).toBe(false);
  });

  it('still enforces the ceiling when Content-Length understates the body', async () => {
    const req = streamingRequest([enc.encode('abcd')]);
    const r = await readLimitedBody(
      new Request(req, { headers: { 'content-length': '1' } }),
      3,
    );
    expect(r.ok).toBe(false);
  });

  it('rethrows a stream fault that is not about size', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('socket reset'));
      },
    });
    const req = new Request('http://x', {
      method: 'POST',
      body: stream,
      // @ts-expect-error duplex is valid at runtime but missing from the DOM lib types
      duplex: 'half',
    });
    await expect(readLimitedBody(req, 10)).rejects.toThrow('socket reset');
  });
});

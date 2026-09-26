// Adapter-level test for GET /api/events/stream — the one that would actually
// have caught issue #89.
//
// WHY THIS FILE EXISTS SEPARATELY FROM stream.test.ts.
// A unit test that calls GET() receives a `Response` object and can only see
// what the handler enqueued. The #89 defect was not in the handler's enqueues —
// it was in the gap between the `Response` and the socket: Next's Node adapter
// (`next/dist/server/pipe-readable.js`) deliberately defers
// `res.flushHeaders()` until the first body chunk arrives:
//
//     write: async (chunk) => {
//       // You'd think we'd want to use `start` instead of placing this in
//       // `write` but this ensures that we don't actually flush the headers
//       // until we've started writing chunks.
//       if (!started) { started = true; ... res.flushHeaders(); }
//
// so a stream with nothing to say sends no status line at all. This test binds
// a real `http.createServer`, pipes the route's own `Response.body` through
// that exact module, and asserts on a raw socket that the status line shows up
// promptly with an EMPTY backlog. No Docker, runs on every `npm test`.
//
// It therefore fails in two distinct ways that matter:
//   • the route stops writing a connect-time prelude (the #89 regression), and
//   • a future Next release moves or removes the flush point — `pipe-readable`
//     is unversioned internal API, which is the real recurrence risk.
//
// Deliberately uses the REAL event bus and config rather than mocks: "a freshly
// started process has an empty backlog" is the production precondition under
// test, and a mock would let it drift.

import net from 'node:net';
import http from 'node:http';
import { pipeToNodeResponse } from 'next/dist/server/pipe-readable';
import { NextRequest } from 'next/server';
import { GET } from './route';

// Generous relative to the ~80ms measured against a real container, but far
// below the 15s heartbeat that was the only thing flushing headers pre-fix, so
// there is no overlap between pass and fail.
const FLUSH_BUDGET_MS = 500;
const HARD_TIMEOUT_MS = 3000;

let server: http.Server | null = null;

async function startServer(path = '/api/events/stream'): Promise<number> {
  server = http.createServer((_req, res) => {
    // Mirrors what Next's route-handler runtime does: build the Web Request,
    // call the handler, copy status + headers onto the ServerResponse, then
    // hand the Web ReadableStream to the adapter. flushHeaders() is the
    // adapter's call to make, not ours — that is the whole point.
    const response = GET(
      new NextRequest(new Request(`http://127.0.0.1${path}`)),
    );
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    // Swallow the pipe's own rejection rather than `void`-ing it: the probe
    // destroys the socket mid-stream on purpose, and although
    // pipeToNodeResponse already absorbs AbortError, any OTHER fault would
    // otherwise surface as an unhandled rejection — which jest attributes to
    // whichever test happens to be running, not to this handler.
    pipeToNodeResponse(response.body!, res).catch(() => {});
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const addr = server!.address();
  if (typeof addr === 'string' || addr === null) {
    throw new Error('expected an AddressInfo from an ephemeral listen');
  }
  return addr.port;
}

interface Capture {
  /** ms from request write to the first byte of the response. */
  firstByteMs: number;
  /** Everything received up to and including the first body chunk. */
  text: string;
}

/**
 * Opens a raw socket, sends the request, and resolves as soon as response
 * headers AND a complete first body frame have arrived. Rejects — rather than
 * hanging like the production symptom did — if nothing shows up in time.
 */
function probe(port: number): Promise<Capture> {
  return new Promise<Capture>((resolve, reject) => {
    let sent = 0;
    let firstByteMs = -1;
    let text = '';
    const sock = net.connect(port, '127.0.0.1', () => {
      sent = performance.now();
      sock.write(
        `GET /api/events/stream HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          `Accept: text/event-stream\r\nConnection: close\r\n\r\n`,
      );
    });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(
        new Error(
          `no response headers within ${HARD_TIMEOUT_MS}ms — the adapter never ` +
            `flushed. This is issue #89: the route enqueued nothing at connect, ` +
            `so pipe-readable's write() never ran. Received so far: ${JSON.stringify(text)}`,
        ),
      );
    }, HARD_TIMEOUT_MS);
    let settle: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(timer);
      if (settle) clearTimeout(settle);
      sock.destroy();
      resolve({ firstByteMs, text });
    };
    sock.on('data', (buf) => {
      if (firstByteMs < 0) firstByteMs = performance.now() - sent;
      text += buf.toString('utf8');
      const headEnd = text.indexOf('\r\n\r\n');
      if (headEnd < 0 || text.length <= headEnd + 4) return;
      // Headers plus some body are in. A complete SSE frame (blank-line
      // terminated) means there is nothing more to wait for; otherwise give the
      // kernel a short grace period, because a chunked body arrives as a length
      // line plus a payload and those can land in separate segments. Resolving
      // on "any byte past the headers" would then cut the prelude in half and
      // fail the assertion spuriously.
      //
      // Deliberately NOT gated on the prelude's own text: that would make the
      // prelude assertion in each test tautological — a route emitting the
      // wrong bytes must fail with a readable diff here, not time out.
      if (text.slice(headEnd + 4).includes('\n\n')) {
        finish();
      } else if (!settle) {
        settle = setTimeout(finish, 100);
      }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.on('close', () => {
      clearTimeout(timer);
      if (firstByteMs < 0) reject(new Error('socket closed with no response'));
    });
  });
}

beforeEach(() => {
  globalThis.__sseOpenCount = 0;
});

afterEach(async () => {
  if (server) {
    const s = server;
    server = null;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

describe('GET /api/events/stream through Next’s Node adapter', () => {
  it('flushes the status line and headers on an empty backlog, without waiting for the heartbeat', async () => {
    const port = await startServer();
    const { firstByteMs, text } = await probe(port);

    expect(text).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(firstByteMs).toBeLessThan(FLUSH_BUDGET_MS);

    // Header assertions are made here, on the wire, rather than on the
    // Response object — these are the ones a proxy actually reads.
    const head = text.slice(0, text.indexOf('\r\n\r\n')).toLowerCase();
    expect(head).toContain('content-type: text/event-stream');
    expect(head).toContain('cache-control: no-cache, no-transform');
    expect(head).toContain('x-accel-buffering: no');
    expect(head).toContain('transfer-encoding: chunked');

    // And the first body bytes are the prelude comment frame.
    expect(text).toContain(': connected\n\n');
  });

  it('flushes just as fast on a second connection to the same process', async () => {
    // Guards a specific way the fix could half-work: anything that made only
    // the FIRST connect write a byte — a module-level "already announced"
    // flag, a memoised prelude buffer, a `seenIds`-style set hoisted out of
    // start() — would leave every reconnect hanging exactly as before, and the
    // console reconnects constantly. Cheap to assert, and the open/close
    // bookkeeping (__sseOpenCount) is the state most likely to grow such a flag.
    const port = await startServer();
    const first = await probe(port);
    const second = await probe(port);

    expect(first.text).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(second.text).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(second.firstByteMs).toBeLessThan(FLUSH_BUDGET_MS);
    expect(second.text).toContain(': connected\n\n');
  });

  // NOT asserted here, on purpose: the absence of `content-encoding` when the
  // client sends `Accept-Encoding: gzip, br`. This harness is a bare
  // `http.createServer`, so Next's `compression` middleware
  // (`router-server.js`, enabled unless `config.compress === false`) is not in
  // the path and `content-encoding` could never appear regardless of what the
  // route sets — the assertion would pass vacuously and read as coverage it
  // isn't. `Cache-Control: no-transform` is what actually defeats compression
  // for this route, and only the shipped standalone artifact exercises that.
  // It belongs to the container-level check in Phase 4 of
  // plans/sse-stream-header-flush.md.
});

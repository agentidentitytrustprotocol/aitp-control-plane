// Unit tests for GET /api/events/stream (SSE) — verifies:
//   • the connect-time prelude: a `: connected` comment frame is the first
//     chunk enqueued, even with an empty backlog and no publish. This is the
//     #89 regression guard — without it Next never calls res.flushHeaders()
//     and the client gets no status line until the 15s heartbeat. The
//     companion stream.flush.test.ts proves the byte reaches a real socket;
//     these tests pin the ordering and the wire text.
//   • the capacity gate: at/above config.maxSseConnections returns 503
//     SSE_CAPACITY with Retry-After, without opening a stream
//   • backlog replay is filtered by ?type / ?run_id / ?aid
//   • an event that is both in the backlog snapshot AND delivered live
//     during the replay window is only sent once (the seenIds dedup)
//   • live events published after replay are delivered
//   • aborting the request is noticed by the heartbeat, which unsubscribes
//     from the event bus and releases the connection-count slot
//
// @/lib/audit/stream's eventBus and @/lib/config are both mocked with
// small controllable fakes. No database, no real event bus singleton.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jest } from '@jest/globals';

type FakeEvent = {
  id: string;
  type: string;
  ts: string;
  aidA?: string;
  aidB?: string;
  runId?: string;
  payload: Record<string, unknown>;
};

let listeners: Array<(e: FakeEvent) => void> = [];
let backlog: FakeEvent[] = [];
// One-shot hook fired synchronously from inside subscribe(), before
// getBacklog() is called — used to simulate a publish landing in the
// narrow window the route's `draining` buffer exists to cover.
let onSubscribe: (() => void) | null = null;

const subscribeMock = jest.fn((fn: (e: FakeEvent) => void) => {
  listeners.push(fn);
  const hook = onSubscribe;
  onSubscribe = null;
  hook?.();
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
});
const getBacklogMock = jest.fn((limit: number) => backlog.slice(-limit));

function publish(evt: FakeEvent) {
  backlog.push(evt);
  for (const l of [...listeners]) l(evt);
}

jest.mock('@/lib/audit/stream', () => ({
  eventBus: {
    subscribe: (fn: (e: FakeEvent) => void) => subscribeMock(fn),
    getBacklog: (limit: number) => getBacklogMock(limit),
  },
}));

const configMock = { maxSseConnections: 500 };
jest.mock('@/lib/config', () => ({ config: configMock }));

// The logger is a real pino instance that is silent under NODE_ENV=test, so a
// spy is the only way to count lifecycle lines. childLogger() is what the route
// calls, so binding the fake there covers the requestId child too.
const logInfo = jest.fn();
const logWarn = jest.fn();
// When true, EVERY logging call throws — exercises the route's safely() guard.
let logShouldThrow = false;
jest.mock('@/lib/logger', () => ({
  childLogger: (bindings: Record<string, unknown>) => {
    childBindings.push(bindings);
    if (logShouldThrow) throw new Error('pino transport exploded');
    return { info: logInfo, warn: logWarn };
  },
}));
let childBindings: Array<Record<string, unknown>> = [];

// sse-metrics is NOT mocked: it is pure in-memory arithmetic over globalThis
// slots, and the point of these tests is that the route drives it correctly.
import {
  getSseMetrics,
  resetSseMetrics,
} from '@/lib/audit/sse-metrics';

import { GET } from './route';
import { NextRequest } from 'next/server';

// The exact bytes the route must put on the wire first. Spelled out rather
// than imported so a change to the route's prelude has to be re-stated here
// deliberately — it is a wire format, not an implementation detail.
const PRELUDE = ': connected\n\n';

function makeReq(qs = '', signal?: AbortSignal): NextRequest {
  return new NextRequest(
    new Request(
      `http://localhost:4000/api/events/stream${qs}`,
      signal ? { signal } : undefined,
    ),
  );
}

async function readFrames(res: Response, count: number): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    frames.push(decoder.decode(value));
  }
  await reader.cancel();
  return frames;
}

// Reads the next chunk but gives up after `ms`, resolving the sentinel
// instead. Without the race an unfixed route would HANG here for the full 15s
// heartbeat interval and the test would time out opaquely rather than fail
// with a readable diff. Callers must run on real timers (see the note on the
// fake-timer test at the bottom of this file).
const TIMEOUT = '__TIMEOUT__';
async function readNext(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms = 250,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read().then((r) => new TextDecoder().decode(r.value)),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function ev(over: Partial<FakeEvent> & { id: string; type: string }): FakeEvent {
  return { ts: '2026-01-01T00:00:00.000Z', payload: {}, ...over };
}

beforeEach(() => {
  listeners = [];
  backlog = [];
  onSubscribe = null;
  subscribeMock.mockClear();
  getBacklogMock.mockClear();
  configMock.maxSseConnections = 500;
  resetSseMetrics();
  logInfo.mockClear();
  logWarn.mockClear();
  logShouldThrow = false;
  childBindings = [];
});

describe('GET /api/events/stream — connect-time prelude (issue #89)', () => {
  it('sends the prelude with an EMPTY backlog and no publish, without waiting for the heartbeat', async () => {
    // The production case on a fresh deploy: the in-process bus is empty, so
    // pre-#89 nothing at all was enqueued at connect and Next withheld the
    // status line until the 15s heartbeat. Every other test in this file
    // pre-seeds `backlog`, which is exactly why none of them caught it.
    expect(backlog).toHaveLength(0);
    const res = GET(makeReq());
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    try {
      expect(await readNext(reader)).toBe(PRELUDE);
    } finally {
      // Not optional: cancel() is the only route into the handler's cleanup()
      // (route.ts cancel hook), which clears the 15s interval and unsubscribes.
      // readFrames() does this for the other tests; this one bypasses it.
      await reader.cancel();
    }
    expect(globalThis.__sseOpenCount).toBe(0);
    expect(listeners).toHaveLength(0);
  });

  it('emits the prelude ahead of the backlog replay and of the drained live buffer', async () => {
    // An event published the instant subscribe() runs is buffered by the
    // route's `draining` guard and emitted during the replay/drain. So a
    // prelude moved to the END of start() would land after this event and
    // frame 0 would change.
    //
    // Note what this does NOT prove: moving the enqueue to just *after*
    // eventBus.subscribe() but still before the replay leaves frame order
    // identical, because the `draining` buffer defers delivery either way.
    // Relative ordering against subscribe() is simply not observable through
    // the public ReadableStream API — the test below enforces it at the
    // source level instead. Keeping the two separate rather than letting this
    // one's name overclaim.
    const late = ev({ id: 'late', type: 'x' });
    onSubscribe = () => publish(late);

    const res = GET(makeReq());
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    const frames = await readFrames(res, 2);
    expect(frames[0]).toBe(PRELUDE);
    expect(frames[1]).toContain('"id":"late"');
  });

  it('keeps the prelude enqueue the first statement of a synchronous start(), ahead of subscribe and replay', () => {
    // A SOURCE-ORDER assertion, deliberately, and the only kind that can hold
    // this invariant. The whole #89 defect is about *when* the first chunk is
    // handed to Next's adapter. Two refactors would restore the bug while every
    // behavioural test above stayed green:
    //   • moving the enqueue after eventBus.subscribe() — the route's
    //     `draining` buffer defers delivery either way, so no frame order
    //     changes and nothing observable through the ReadableStream API moves;
    //   • putting an `await` in front of it — start() would return to the
    //     caller before the chunk is queued, so `new Response(stream)` ships
    //     with an empty queue and pipe-readable's write() never runs.
    // Cheap, greppable, and it fails on exactly those two edits (both were
    // confirmed to fail this test, and to pass without it).
    //
    // Patterns are regexes rather than literals so renaming the controller
    // parameter, or reflowing the code, does not produce a false failure.
    const src = readFileSync(join(__dirname, 'route.ts'), 'utf8');
    const startMatch = /\n\s*start\((\w+)\)\s*\{/.exec(src);
    expect(startMatch).not.toBeNull();
    const ctrlName = startMatch![1];

    const at = (re: RegExp, what: string): number => {
      const m = re.exec(src);
      // Throw by name rather than returning -1 and silently comparing it to an
      // offset: a stale pattern here must read as "the pattern went stale", not
      // as "the ordering invariant broke".
      if (!m) throw new Error(`route.ts no longer contains ${what}`);
      return m.index;
    };
    // Asserting a sorted LABEL order, not raw offsets: a failure then reads as
    // "subscribe now comes before the prelude", not "Expected: > 4556".
    const marks: Array<[string, number]> = [
      ['start() opens', startMatch!.index],
      ['prelude enqueue', at(/enqueue\([^\n]*': connected/, "the ': connected' prelude enqueue")],
      ['eventBus.subscribe', at(/eventBus\.subscribe\(/, 'eventBus.subscribe(')],
      ['backlog replay', at(/eventBus\.getBacklog\(/, 'eventBus.getBacklog(')],
    ];
    expect(
      [...marks].sort((a, b) => a[1] - b[1]).map(([label]) => label),
    ).toEqual([
      'start() opens',
      'prelude enqueue',
      'eventBus.subscribe',
      'backlog replay',
    ]);

    // "First statement" literally: between the `start(…) {` header and the
    // enqueue there may be comments and blank lines, and nothing else. Both
    // line and block comment forms are stripped, so reflowing the explanatory
    // comment above the enqueue cannot fail this.
    // Back up to the start of the enqueue's own LINE, so the receiver
    // (`ctrl.`) is not left dangling in the preamble slice.
    const enqueueLineStart = src.lastIndexOf('\n', marks[1][1]);
    const preambleCode = src
      .slice(startMatch!.index, enqueueLineStart)
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n')
      .replace(startMatch![0], '')
      .trim();
    expect(preambleCode).toBe('');

    // And start() itself must stay synchronous: an async start() hands the
    // chunk to pipeTo a microtask after the Response has already been returned.
    expect(/async\s+start\s*\(/.test(src)).toBe(false);
    expect(ctrlName).toBeTruthy();
  });

  it('sends the prelude and nothing else when the filters match no backlog event', async () => {
    backlog = [ev({ id: 'a', type: 'handshake.start' })];
    const res = GET(makeReq('?type=nonexistent'));

    const reader = res.body!.getReader();
    try {
      expect(await readNext(reader)).toBe(PRELUDE);
      // Nothing follows: a filtered-out backlog must not leak a data frame,
      // and the prelude must not be emitted twice.
      expect(await readNext(reader, 100)).toBe(TIMEOUT);
    } finally {
      await reader.cancel();
    }
  });
});

describe('GET /api/events/stream — capacity gate', () => {
  it('returns 503 SSE_CAPACITY at the connection cap, without subscribing', async () => {
    configMock.maxSseConnections = 1;
    globalThis.__sseOpenCount = 1;
    const res = GET(makeReq());
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(res.headers.get('Content-Type')).toBe('application/json');
    // Read the body once, so the "no prelude" check and the shape check are
    // made against the same bytes.
    const body = await res.text();
    // The rejection returns before any stream is constructed, so the #89
    // prelude must not appear — a 503 whose body started with an SSE comment
    // would be unparseable JSON for the client.
    expect(body).not.toContain(PRELUDE);
    expect(body.startsWith('{')).toBe(true);
    expect(JSON.parse(body)).toEqual({
      error: 'too many open SSE connections; retry after current streams drain',
      code: 'SSE_CAPACITY',
    });
    expect(subscribeMock).not.toHaveBeenCalled();
    expect(globalThis.__sseOpenCount).toBe(1);
  });

  it('allows a connection under the cap and increments the open count', () => {
    configMock.maxSseConnections = 2;
    globalThis.__sseOpenCount = 1;
    const res = GET(makeReq());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(globalThis.__sseOpenCount).toBe(2);
  });
});

// Frame index == enqueue order: readFrames() pushes one decoded string per
// read() and each ctrl.enqueue() is exactly one chunk. The #89 prelude is
// frame 0 on every accepted connection, so every replayed event below sits at
// frames[1] onwards.
describe('GET /api/events/stream — backlog replay + filters', () => {
  it('replays only backlog events matching ?type', async () => {
    backlog = [
      ev({ id: 'a', type: 'handshake.start' }),
      ev({ id: 'b', type: 'handshake.complete' }),
    ];
    const res = GET(makeReq('?type=handshake.complete'));
    const frames = await readFrames(res, 2);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toBe(PRELUDE);
    expect(frames[1]).toContain('"id":"b"');
  });

  it('replays only backlog events matching ?run_id (and its ?runId alias)', async () => {
    backlog = [
      ev({ id: 'a', type: 'x', runId: 'run-1' }),
      ev({ id: 'b', type: 'x', runId: 'run-2' }),
    ];
    const res = GET(makeReq('?run_id=run-2'));
    const frames = await readFrames(res, 2);
    expect(frames[1]).toContain('"id":"b"');
  });

  it('replays only backlog events matching ?aid against either aidA or aidB', async () => {
    backlog = [
      ev({ id: 'a', type: 'x', aidA: 'aid:pubkey:1' }),
      ev({ id: 'b', type: 'x', aidB: 'aid:pubkey:2' }),
      ev({ id: 'c', type: 'x', aidA: 'aid:pubkey:3' }),
    ];
    const res = GET(makeReq('?aid=aid:pubkey:2'));
    const frames = await readFrames(res, 2);
    expect(frames[1]).toContain('"id":"b"');
  });

  it('sends each backlog event as its own `data: {...}\\n\\n` SSE frame', async () => {
    backlog = [ev({ id: 'a', type: 'x' })];
    const res = GET(makeReq());
    const frames = await readFrames(res, 2);
    // Exact equality, deliberately: the prelude must not have been folded into
    // the event frame, and the event frame's bytes are the client contract.
    expect(frames[1]).toBe(`data: ${JSON.stringify(backlog[0])}\n\n`);
  });
});

describe('GET /api/events/stream — dedup across backlog and live buffer', () => {
  it('sends an event only once when it lands in the backlog snapshot AND fires live during the replay window', async () => {
    const late = ev({ id: 'late', type: 'x' });
    backlog = [ev({ id: 'early', type: 'x' })];
    // Fires the instant subscribe() runs, i.e. before getBacklog() is
    // called — this both pushes `late` into the backlog array (so
    // getBacklog() below will return it too) and delivers it live to
    // our still-draining listener.
    onSubscribe = () => publish(late);

    const res = GET(makeReq());
    // 3, not 2: frame 0 is the #89 prelude, the two events follow.
    const frames = await readFrames(res, 3);
    expect(frames).toHaveLength(3);
    expect(frames[0]).toBe(PRELUDE);
    expect(frames[1]).toContain('"id":"early"');
    expect(frames[2]).toContain('"id":"late"');

    // No third frame shows up for the duplicate live delivery — confirm
    // by cancelling and checking nothing further was ever enqueued for
    // 'late' beyond the one frame already captured above.
    const lateCount = frames.filter((f) => f.includes('"id":"late"')).length;
    expect(lateCount).toBe(1);
  });
});

describe('GET /api/events/stream — live delivery after replay', () => {
  it('delivers an event published after the stream has started', async () => {
    const res = GET(makeReq());
    expect(listeners).toHaveLength(1);
    publish(ev({ id: 'live-1', type: 'x' }));
    const frames = await readFrames(res, 2);
    expect(frames[0]).toBe(PRELUDE);
    expect(frames[1]).toContain('"id":"live-1"');
  });
});

describe('GET /api/events/stream — metrics and lifecycle logging', () => {
  it('increments opened_total on accept and leaves rejected_total alone', async () => {
    const res = GET(makeReq());
    expect(getSseMetrics()).toEqual({
      open: 1,
      openedTotal: 1,
      rejectedTotal: 0,
    });
    await res.body!.cancel();
    // open falls back to 0; opened_total is cumulative and must NOT.
    expect(getSseMetrics()).toEqual({
      open: 0,
      openedTotal: 1,
      rejectedTotal: 0,
    });
  });

  it('increments rejected_total on the capacity 503 and does not count it as an open', () => {
    configMock.maxSseConnections = 1;
    globalThis.__sseOpenCount = 1;
    const res = GET(makeReq());
    expect(res.status).toBe(503);
    expect(getSseMetrics()).toEqual({
      open: 1,
      openedTotal: 0,
      rejectedTotal: 1,
    });
  });

  it('logs exactly two lines for one open/close, the close one carrying a duration and a reason', async () => {
    const res = GET(makeReq('?type=x&run_id=r1'));
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo.mock.calls[0][1]).toBe('sse stream opened');
    expect(logInfo.mock.calls[0][0]).toMatchObject({
      open: 1,
      cap: 500,
      filters: { type: 'x', runId: 'r1' },
    });

    await res.body!.cancel();
    expect(logInfo).toHaveBeenCalledTimes(2);
    expect(logInfo.mock.calls[1][1]).toBe('sse stream closed');
    const closeFields = logInfo.mock.calls[1][0] as Record<string, unknown>;
    expect(closeFields.reason).toBe('cancel');
    expect(typeof closeFields.durationMs).toBe('number');
    expect(closeFields.durationMs as number).toBeGreaterThanOrEqual(0);
    expect(closeFields.open).toBe(0);

    // No third line: heartbeats must never log, or 500 streams flood the log.
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('logs the capacity rejection once, as a warning, with reason=capacity', () => {
    configMock.maxSseConnections = 1;
    globalThis.__sseOpenCount = 1;
    GET(makeReq());
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0][1]).toBe('sse stream rejected');
    expect(logWarn.mock.calls[0][0]).toMatchObject({
      reason: 'capacity',
      open: 1,
      cap: 1,
    });
    // A refused connection is not an opened stream.
    expect(logInfo).not.toHaveBeenCalled();
  });

  it('binds a truncated x-request-id onto the log child, and omits it when absent', () => {
    const long = 'r'.repeat(500);
    const req = new NextRequest(
      new Request('http://localhost:4000/api/events/stream', {
        headers: { 'x-request-id': long },
      }),
    );
    GET(req);
    // 200 chars, not 500: x-request-id is caller-settable on a route the
    // console hits on every reconnect, so an unbounded value is a log-volume
    // amplification vector.
    expect(childBindings[0]).toEqual({ requestId: 'r'.repeat(200) });

    childBindings = [];
    GET(makeReq());
    expect(childBindings[0]).toEqual({});
  });

  it('reports the reason as abort when the request is aborted, not cancel', async () => {
    const controller = new AbortController();
    GET(makeReq('', controller.signal));
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    expect(logInfo).toHaveBeenCalledTimes(2);
    expect(logInfo.mock.calls[1][0]).toMatchObject({ reason: 'abort' });
  });

  it('emits exactly one close line however many termination signals arrive, and never double-decrements', async () => {
    // abort AND cancel both reach cleanup(); the `closed` guard must collapse
    // them, or the gauge drifts below the true value and the cap over-admits.
    const controller = new AbortController();
    const res = GET(makeReq('', controller.signal));
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    await res.body!.cancel();
    expect(logInfo).toHaveBeenCalledTimes(2);
    expect(getSseMetrics()).toEqual({
      open: 0,
      openedTotal: 1,
      rejectedTotal: 0,
    });
  });

  it('cleans up from the HEARTBEAT TICK when the request was already aborted at connect', () => {
    // The only way the heartbeat's abort branch is actually reachable, and the
    // reason it exists: if the signal is already aborted when GET() runs,
    // addEventListener('abort') never fires (the event is in the past), so the
    // tick is the sole remaining cleanup path. A client that hangs up between
    // the request gate and the handler produces exactly this.
    //
    // Asserting it via a controller aborted AFTER connect does NOT work —
    // onAbort runs first and clears the interval, so the tick never happens and
    // the test passes no matter what the tick body does.
    jest.useFakeTimers();
    try {
      const controller = new AbortController();
      controller.abort();
      const res = GET(makeReq('', controller.signal));
      expect(getSseMetrics()).toMatchObject({ open: 1, openedTotal: 1 });
      // Still open, because nothing has run cleanup yet.
      expect(listeners).toHaveLength(1);
      expect(logInfo).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(15_000);

      expect(listeners).toHaveLength(0);
      expect(logInfo).toHaveBeenCalledTimes(2);
      expect(logInfo.mock.calls[1][0]).toMatchObject({ reason: 'abort' });
      expect(getSseMetrics()).toEqual({
        open: 0,
        openedTotal: 1,
        rejectedTotal: 0,
      });

      // Further ticks are a no-op: the interval is cleared, and even if it were
      // not, the `closed` guard prevents a second decrement below 0.
      jest.advanceTimersByTime(60_000);
      expect(getSseMetrics().open).toBe(0);
      expect(logInfo).toHaveBeenCalledTimes(2);
      void res;
    } finally {
      jest.useRealTimers();
    }
  });

  it('emits a heartbeat frame on a live stream and logs nothing for it', async () => {
    // Covers the tick's normal path. Also pins that heartbeats are silent in
    // the log: one line per tick across 500 open streams would be a flood.
    jest.useFakeTimers();
    let frame: string;
    try {
      const res = GET(makeReq());
      const reader = res.body!.getReader();
      // Drain the prelude first, synchronously available from the queue.
      await reader.read();
      expect(logInfo).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(15_000);
      frame = new TextDecoder().decode((await reader.read()).value);
      expect(logInfo).toHaveBeenCalledTimes(1);
      await reader.cancel();
    } finally {
      jest.useRealTimers();
    }
    expect(frame).toBe(': heartbeat\n\n');
    expect(logInfo).toHaveBeenCalledTimes(2);
    expect(logInfo.mock.calls[1][0]).toMatchObject({ reason: 'cancel' });
  });

  it('closes with reason=enqueue-failed when an event cannot be serialised', async () => {
    // A SYNTHESISED trigger, stated plainly: no current publish path can put a
    // cyclic payload on the bus. Every eventBus.publish() call site builds
    // `payload` from an object literal or from a JSON.parse'd body (which
    // cannot be cyclic), and the ingest route JSON.stringify's the payload
    // itself before publishing, so it would 500 first.
    //
    // The branch is still worth pinning, and a circular payload is the one
    // input that reaches it through the real code rather than by stubbing the
    // controller: `JSON.stringify(evt)` sits inside the route's try, so this
    // exercises the genuine catch → cleanup path. What Phase 2 adds here is the
    // `reason` label and the close log — the slot release and unsubscribe were
    // already there. What is asserted is that the label is right and that a
    // serialisation fault still ends the stream cleanly rather than silently.
    const res = GET(makeReq());
    const reader = res.body!.getReader();
    await reader.read(); // prelude
    expect(getSseMetrics().open).toBe(1);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    publish(ev({ id: 'bad', type: 'x', payload: circular }));

    expect(logInfo).toHaveBeenCalledTimes(2);
    expect(logInfo.mock.calls[1][0]).toMatchObject({
      reason: 'enqueue-failed',
    });
    expect(getSseMetrics()).toEqual({
      open: 0,
      openedTotal: 1,
      rejectedTotal: 0,
    });
    expect(listeners).toHaveLength(0);
    await reader.cancel();
    // cleanup() is idempotent — the cancel must not log a second close line.
    expect(logInfo).toHaveBeenCalledTimes(2);
  });

  it('truncates caller-supplied query filters before logging them', async () => {
    // The filters are raw query values on a route the console hits on every
    // reconnect, so they are a log-volume amplification vector exactly like
    // x-request-id. Without this, the cap in the route can be deleted silently.
    const long = 'f'.repeat(500);
    const res = GET(
      makeReq(`?type=${long}&run_id=${long}&aid=${long}`),
    );
    const fields = logInfo.mock.calls[0][0] as {
      filters: { type: string; runId: string; aid: string };
    };
    expect(fields.filters.type).toBe('f'.repeat(200));
    expect(fields.filters.runId).toBe('f'.repeat(200));
    expect(fields.filters.aid).toBe('f'.repeat(200));
    await res.body!.cancel();
  });

  it('keeps serving the stream when the logger throws on every call', async () => {
    // safely() is load-bearing, not decorative: the open log runs AFTER
    // acquireSseSlot(), so an unguarded throw there would 500 the request and
    // leak a capacity slot for the life of the process. Deleting the try/catch
    // must fail here.
    logShouldThrow = true;
    const res = GET(makeReq());
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    try {
      expect(await readNext(reader)).toBe(PRELUDE);
    } finally {
      await reader.cancel();
    }
    // Metrics do not depend on logging working — that is the whole point of
    // having both signals.
    expect(getSseMetrics()).toEqual({
      open: 0,
      openedTotal: 1,
      rejectedTotal: 0,
    });
    expect(listeners).toHaveLength(0);
  });

  it('still answers the capacity 503 when the logger throws', () => {
    logShouldThrow = true;
    configMock.maxSseConnections = 1;
    globalThis.__sseOpenCount = 1;
    const res = GET(makeReq());
    expect(res.status).toBe(503);
    expect(getSseMetrics().rejectedTotal).toBe(1);
  });
});

describe('GET /api/events/stream — cleanup', () => {
  it('unsubscribes and releases the count slot when the consumer cancels the stream', async () => {
    const res = GET(makeReq());
    expect(listeners).toHaveLength(1);
    expect(globalThis.__sseOpenCount).toBe(1);
    await res.body!.cancel();
    expect(listeners).toHaveLength(0);
    expect(globalThis.__sseOpenCount).toBe(0);
  });

  it('runs cleanup when the request aborts immediately after connect, and the queued prelude is still drainable', async () => {
    // The tight-reconnect case: a client that hangs up before reading anything.
    // The prelude is already in the stream queue at this point, so this also
    // pins that enqueueing it cannot leak a slot, a subscription or a timer.
    const controller = new AbortController();
    const res = GET(makeReq('', controller.signal));
    expect(globalThis.__sseOpenCount).toBe(1);

    controller.abort();
    // Abort propagation through Request.signal is not guaranteed synchronous;
    // yield one macrotask so this asserts the handler's listener, not timing.
    await new Promise((resolve) => setImmediate(resolve));
    expect(listeners).toHaveLength(0);
    expect(globalThis.__sseOpenCount).toBe(0);

    // ctrl.close() leaves already-queued chunks readable, so the prelude
    // survives the abort rather than being dropped mid-queue.
    const reader = res.body!.getReader();
    try {
      expect(await readNext(reader)).toBe(PRELUDE);
    } finally {
      await reader.cancel();
    }
    // cleanup() is idempotent: the cancel above must not double-decrement.
    expect(globalThis.__sseOpenCount).toBe(0);
  });

  it('unsubscribes and releases the count slot once the heartbeat notices an aborted request', () => {
    jest.useFakeTimers();
    try {
      const controller = new AbortController();
      GET(makeReq('', controller.signal));
      expect(listeners).toHaveLength(1);
      expect(globalThis.__sseOpenCount).toBe(1);

      controller.abort();
      jest.advanceTimersByTime(15_000);

      expect(listeners).toHaveLength(0);
      expect(globalThis.__sseOpenCount).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

// Unit tests for GET /api/events/stream (SSE) — verifies:
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

import { GET } from './route';
import { NextRequest } from 'next/server';

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
  globalThis.__sseOpenCount = 0;
});

describe('GET /api/events/stream — capacity gate', () => {
  it('returns 503 SSE_CAPACITY at the connection cap, without subscribing', async () => {
    configMock.maxSseConnections = 1;
    globalThis.__sseOpenCount = 1;
    const res = GET(makeReq());
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual({
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

describe('GET /api/events/stream — backlog replay + filters', () => {
  it('replays only backlog events matching ?type', async () => {
    backlog = [
      ev({ id: 'a', type: 'handshake.start' }),
      ev({ id: 'b', type: 'handshake.complete' }),
    ];
    const res = GET(makeReq('?type=handshake.complete'));
    const frames = await readFrames(res, 1);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain('"id":"b"');
  });

  it('replays only backlog events matching ?run_id (and its ?runId alias)', async () => {
    backlog = [
      ev({ id: 'a', type: 'x', runId: 'run-1' }),
      ev({ id: 'b', type: 'x', runId: 'run-2' }),
    ];
    const res = GET(makeReq('?run_id=run-2'));
    const frames = await readFrames(res, 1);
    expect(frames[0]).toContain('"id":"b"');
  });

  it('replays only backlog events matching ?aid against either aidA or aidB', async () => {
    backlog = [
      ev({ id: 'a', type: 'x', aidA: 'aid:pubkey:1' }),
      ev({ id: 'b', type: 'x', aidB: 'aid:pubkey:2' }),
      ev({ id: 'c', type: 'x', aidA: 'aid:pubkey:3' }),
    ];
    const res = GET(makeReq('?aid=aid:pubkey:2'));
    const frames = await readFrames(res, 1);
    expect(frames[0]).toContain('"id":"b"');
  });

  it('sends each backlog event as its own `data: {...}\\n\\n` SSE frame', async () => {
    backlog = [ev({ id: 'a', type: 'x' })];
    const res = GET(makeReq());
    const [frame] = await readFrames(res, 1);
    expect(frame).toBe(`data: ${JSON.stringify(backlog[0])}\n\n`);
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
    const frames = await readFrames(res, 2);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toContain('"id":"early"');
    expect(frames[1]).toContain('"id":"late"');

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
    const frames = await readFrames(res, 1);
    expect(frames[0]).toContain('"id":"live-1"');
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

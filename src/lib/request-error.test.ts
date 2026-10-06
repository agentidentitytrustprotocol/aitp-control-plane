// Unit tests for the `onRequestError` body — issue #114.
//
// THESE ASSERT THE EMITTED JSON, not a mock call, and that is the whole design
// of this file. The defect being fixed is "the failure is reported on a channel
// that is not JSON, ignores LOG_LEVEL and carries no request id", so a test that
// checked `loggerMock.error` was called with an object would be asserting the
// wrong layer: it would pass on a line pino never serialized, on a field pino
// dropped, and on an `err` that serialized to `{}`. Every expectation below runs
// through real pino and reads the actual line.
//
// HOW THE CAPTURE WORKS. `src/lib/logger.ts` memoizes on `globalThis.__logger`
// (`globalThis.__logger ?? (globalThis.__logger = buildLogger())`), so installing
// an instance there BEFORE that module is first required makes it the process
// logger. Hence the module under test is pulled in with a dynamic import inside
// `beforeAll`, after the install — a top-level `import` would be hoisted above
// it by the CommonJS transform and would get the real, silent test logger.
//
// The capturing instance is configured like `buildLogger()`'s PRODUCTION branch
// (level formatter, ISO timestamps) rather than with pino's defaults, so the
// JSON asserted here is the shape an operator actually receives — `"level":
// "error"`, not `"level": 50`.

import pino from 'pino';
import { jest } from '@jest/globals';

/** Every line the process logger has written this run, raw. */
const lines: string[] = [];
/** Set to make the log write itself fail, for the swallow tests. */
let writeThrows = false;

const mutableGlobal = globalThis as Record<string, unknown>;
mutableGlobal.__logger = pino(
  {
    level: 'trace',
    base: { service: 'aitp-control-plane' },
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  {
    write(line: string) {
      if (writeThrows) throw new Error('log destination exploded');
      lines.push(line);
    },
  },
);

const recordExceptionMock = jest.fn((_e: unknown) => {});
const setStatusMock = jest.fn((_s: unknown) => {});
let activeSpan: unknown = {
  recordException: (e: unknown) => recordExceptionMock(e),
  setStatus: (s: unknown) => setStatusMock(s),
};
jest.mock('@opentelemetry/api', () => ({
  trace: { getActiveSpan: () => activeSpan },
  SpanStatusCode: { ERROR: 2, OK: 1, UNSET: 0 },
}));

type Mod = typeof import('./request-error');
let reportRequestError: Mod['reportRequestError'];

beforeAll(async () => {
  ({ reportRequestError } = await import('./request-error'));
});

const savedOtel = process.env.OTEL_ENABLED;
const mutableEnv = process.env as Record<string, string | undefined>;

beforeEach(() => {
  lines.length = 0;
  writeThrows = false;
  recordExceptionMock.mockClear();
  setStatusMock.mockClear();
  activeSpan = {
    recordException: (e: unknown) => recordExceptionMock(e),
    setStatus: (s: unknown) => setStatusMock(s),
  };
  delete mutableEnv.OTEL_ENABLED;
});

afterAll(() => {
  if (savedOtel === undefined) delete mutableEnv.OTEL_ENABLED;
  else mutableEnv.OTEL_ENABLED = savedOtel;
});

/** The one line this call emitted, parsed. Fails loudly on 0 or 2+. */
function soleLine(): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

const req = (over: Partial<Parameters<Mod['reportRequestError']>[1]> = {}) => ({
  path: '/api/events/history',
  method: 'GET',
  headers: { 'x-request-id': 'cp-abc-123' } as NodeJS.Dict<string | string[]>,
  ...over,
});

const ctx = (over: Partial<Parameters<Mod['reportRequestError']>[2]> = {}) => ({
  routerKind: 'App Router' as const,
  routePath: '/api/events/history',
  routeType: 'route' as const,
  revalidateReason: undefined,
  ...over,
});

describe('reportRequestError', () => {
  it('emits exactly one error line naming the route, method and request id', async () => {
    await reportRequestError(new Error('connect ECONNREFUSED'), req(), ctx());
    const line = soleLine();
    expect(line.level).toBe('error');
    expect(line.msg).toBe('unhandled route error');
    expect(line.route).toBe('/api/events/history');
    expect(line.method).toBe('GET');
    expect(line.requestId).toBe('cp-abc-123');
    expect(line.routerKind).toBe('App Router');
    expect(line.routeType).toBe('route');
    // The correlation promise in docs/api.md is about `x-request-id`; assert the
    // line is actually JSON-parseable rather than trusting the parse above to
    // have been a formality.
    expect(typeof line.time).toBe('string');
  });

  it('serializes the error with type, message and stack', async () => {
    // The point of routing this through pino rather than console: `err` becomes
    // a structured object. A plain `{ err }` on a non-pino channel stringifies
    // to `{}` and loses the stack entirely.
    await reportRequestError(new TypeError('boom'), req(), ctx());
    const err = soleLine().err as Record<string, unknown>;
    expect(err.type).toBe('TypeError');
    expect(err.message).toBe('boom');
    expect(String(err.stack)).toContain('boom');
  });

  it('logs a non-Error throw rather than dropping the fault', async () => {
    // `error` is typed `unknown` by Next, and a route can `throw 'string'`. The
    // fault must still be visible.
    await reportRequestError('just a string', req(), ctx());
    expect(soleLine().msg).toBe('unhandled route error');
  });

  it('caps the request id at 200 characters', async () => {
    // `x-request-id` is caller-settable and this hook fires on public routes, so
    // an unbounded value is a log-volume amplification vector by itself. Same
    // bound as enroll/route.ts and events/stream/route.ts.
    const headers = { 'x-request-id': 'z'.repeat(5000) };
    await reportRequestError(new Error('x'), req({ headers }), ctx());
    expect(soleLine().requestId).toHaveLength(200);
  });

  it('omits requestId entirely when the header is absent or empty', async () => {
    for (const headers of [{}, { 'x-request-id': '' }]) {
      lines.length = 0;
      await reportRequestError(new Error('x'), req({ headers }), ctx());
      // `in`, not `toBeUndefined()`: the latter also passes on a present key
      // whose value is undefined, which is a different JSON line.
      expect('requestId' in soleLine()).toBe(false);
    }
  });

  it('reads the first value of a repeated x-request-id header', async () => {
    // Node surfaces a duplicated header as an array; `Headers.get()` in the
    // route handlers reads one value, so this must agree with them.
    const headers = { 'x-request-id': ['first', 'second'] };
    await reportRequestError(new Error('x'), req({ headers }), ctx());
    expect(soleLine().requestId).toBe('first');
  });

  it('strips the query string from the logged path', async () => {
    // /api/events/history takes aid / session_id / run_id filters: caller-
    // supplied identifiers, unbounded, on a route an attacker can reach.
    await reportRequestError(
      new Error('x'),
      req({ path: '/api/events/history?aid=did:example:victim&limit=1' }),
      ctx(),
    );
    const line = soleLine();
    expect(line.path).toBe('/api/events/history');
    expect(lines[0]).not.toContain('did:example:victim');
  });

  it('caps the logged path too', async () => {
    await reportRequestError(
      new Error('x'),
      req({ path: `/api/${'p'.repeat(5000)}` }),
      ctx(),
    );
    expect(String(soleLine().path)).toHaveLength(200);
  });

  it('never puts a credential from the header dict in the line', async () => {
    // THE security assertion in this file. Next hands the hook the complete
    // request header set, which carries a bearer API key on every gated route
    // and the enrollment token on POST /api/registry/enroll. Only x-request-id
    // is read. A future "just log the headers for context" edit fails here.
    const headers = {
      'x-request-id': 'cp-1',
      authorization: 'Bearer super-secret-api-key',
      cookie: 'session=super-secret-cookie',
      'x-aitp-namespace': 'tenant-a',
    };
    await reportRequestError(new Error('x'), req({ headers }), ctx());
    expect(lines[0]).not.toContain('super-secret-api-key');
    expect(lines[0]).not.toContain('super-secret-cookie');
    expect('headers' in soleLine()).toBe(false);
    expect('authorization' in soleLine()).toBe(false);
  });

  it('includes revalidateReason only when Next supplies one', async () => {
    await reportRequestError(new Error('x'), req(), ctx());
    expect('revalidateReason' in soleLine()).toBe(false);
    lines.length = 0;
    await reportRequestError(new Error('x'), req(), ctx({ revalidateReason: 'stale' }));
    expect(soleLine().revalidateReason).toBe('stale');
  });

  describe('never throws', () => {
    // Next catches a throw from the hook and reports it with
    // `console.error('Error in instrumentation.onRequestError:', err)` — so
    // throwing loses the structured line AND emits a second unstructured one,
    // the exact defect this module fixes. On the Edge call path Next has no
    // try/catch at the calling frame at all, and the hook is awaited before the
    // response is sent.

    /** A request whose `headers` read throws, so the failure is in OUR code and
     *  does not depend on any pino internal. */
    function hostileRequest() {
      const r = { path: '/api/x', method: 'GET' } as Record<string, unknown>;
      Object.defineProperty(r, 'headers', {
        get() {
          throw new Error('headers exploded');
        },
      });
      return r as unknown as Parameters<Mod['reportRequestError']>[1];
    }

    it('resolves when building the line throws', async () => {
      await expect(reportRequestError(new Error('x'), hostileRequest(), ctx())).resolves
        .toBeUndefined();
      expect(lines).toHaveLength(0);
    });

    it('resolves when the log destination itself throws', async () => {
      writeThrows = true;
      await expect(reportRequestError(new Error('x'), req(), ctx())).resolves.toBeUndefined();
    });

    it('still marks the span when the log throws, and vice versa', async () => {
      // The two halves are guarded SEPARATELY and the log goes first, so one
      // fault must not cost the other signal — enroll/route.ts's recordFailure
      // rationale, applied here.
      mutableEnv.OTEL_ENABLED = 'true';
      await reportRequestError(new Error('x'), hostileRequest(), ctx());
      expect(lines).toHaveLength(0);
      expect(recordExceptionMock).toHaveBeenCalledTimes(1);

      recordExceptionMock.mockClear();
      activeSpan = {
        recordException: () => {
          throw new Error('span exploded');
        },
        setStatus: (s: unknown) => setStatusMock(s),
      };
      await reportRequestError(new Error('x'), req(), ctx());
      expect(soleLine().msg).toBe('unhandled route error');
    });
  });

  describe('OpenTelemetry', () => {
    it('touches no span at all when OTEL_ENABLED is not "true"', async () => {
      // Tracing is off by default, and the disabled path must pay neither the
      // dynamic import nor the span lookup on every fault.
      for (const value of [undefined, 'false', '1', 'TRUE']) {
        if (value === undefined) delete mutableEnv.OTEL_ENABLED;
        else mutableEnv.OTEL_ENABLED = value;
        await reportRequestError(new Error('x'), req(), ctx());
        expect(recordExceptionMock).not.toHaveBeenCalled();
        expect(setStatusMock).not.toHaveBeenCalled();
      }
    });

    it('records the exception on the active span when tracing is on', async () => {
      // Next already sets the span status to ERROR for a 5xx. What it never does
      // is recordException — so without this the trace shows an errored request
      // with nothing in it about the error.
      mutableEnv.OTEL_ENABLED = 'true';
      const err = new Error('connect ECONNREFUSED');
      await reportRequestError(err, req(), ctx());
      expect(recordExceptionMock).toHaveBeenCalledWith(err);
      expect(setStatusMock).toHaveBeenCalledWith({ code: 2 });
    });

    it('passes a non-Error throw to recordException as a string', async () => {
      // recordException's signature takes an Exception, not `unknown`.
      mutableEnv.OTEL_ENABLED = 'true';
      await reportRequestError({ weird: true }, req(), ctx());
      expect(recordExceptionMock).toHaveBeenCalledWith('[object Object]');
    });

    it('is a no-op when there is no active span', async () => {
      mutableEnv.OTEL_ENABLED = 'true';
      activeSpan = undefined;
      await expect(reportRequestError(new Error('x'), req(), ctx())).resolves.toBeUndefined();
      expect(soleLine().msg).toBe('unhandled route error');
    });
  });
});

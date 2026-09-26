// Unit tests for src/lib/config.ts — currently scoped to SSE_HEARTBEAT_MS,
// because that is the one setting in this file where a plausible typo is a
// self-inflicted outage rather than a wrong number.
//
// THE TRAP THIS PINS, from both ends. Either bound of readHeartbeatMs, if it
// went missing, produces the same failure: a heartbeat frame on every open
// stream roughly every millisecond — a CPU spin and a bandwidth flood on every
// connected client, from one character in an env var.
//
// Low end: `readNumber` returns its default only for a MISSING or non-numeric
// value, because it tests `if (!v)` on the raw *string* and `"0"` is a truthy
// string. So `SSE_HEARTBEAT_MS=0` reaches the config as a finite `0` and `=-5`
// as `-5`, and Node raises a setInterval delay of <= 0 to 1 ms.
//
// High end: setInterval keeps its delay in a signed 32-bit int, so anything
// above 2147483647 overflows and Node RESETS the delay to 1 ms — an
// extra-zeros typo meaning "basically never" lands in the same place as `0`.
//
// So 0 / negative / non-numeric / overflowing each gets its own explicit case,
// and every case asserts the EFFECTIVE interval rather than merely the absence
// of a crash.
//
// The config object is frozen at module load, so each case re-imports the
// module with jest.resetModules() after setting the env.

import { jest } from '@jest/globals';

async function loadHeartbeatMs(value?: string): Promise<number> {
  if (value === undefined) delete process.env.SSE_HEARTBEAT_MS;
  else process.env.SSE_HEARTBEAT_MS = value;
  jest.resetModules();
  const mod = await import('./config');
  return mod.config.sseHeartbeatMs;
}

const DEFAULT_MS = 15_000;
const FLOOR_MS = 1_000;
/** Node's TIMEOUT_MAX: above this, setInterval resets the delay to 1ms. */
const CEILING_MS = 2_147_483_647;

afterEach(() => {
  delete process.env.SSE_HEARTBEAT_MS;
  jest.resetModules();
});

describe('config.sseHeartbeatMs', () => {
  it('defaults to 15s when SSE_HEARTBEAT_MS is unset', async () => {
    await expect(loadHeartbeatMs()).resolves.toBe(DEFAULT_MS);
  });

  it('honours an explicit value above the floor', async () => {
    await expect(loadHeartbeatMs('2000')).resolves.toBe(2000);
    await expect(loadHeartbeatMs('45000')).resolves.toBe(45_000);
  });

  it('clamps 0 to the floor instead of busy-looping', async () => {
    // The headline case: "0" is truthy as a string, so it is NOT caught by
    // readNumber's `if (!v)` guard and arrives as a finite 0.
    await expect(loadHeartbeatMs('0')).resolves.toBe(FLOOR_MS);
  });

  it('clamps a negative value to the floor', async () => {
    await expect(loadHeartbeatMs('-5')).resolves.toBe(FLOOR_MS);
    await expect(loadHeartbeatMs('-100000')).resolves.toBe(FLOOR_MS);
  });

  it('falls back to the default for a non-numeric value', async () => {
    // Different case from 0/-5 on purpose: there is no operator intent to
    // preserve in "abc", so the default is the right answer rather than the
    // floor. Either way the effective interval is safe.
    await expect(loadHeartbeatMs('abc')).resolves.toBe(DEFAULT_MS);
    await expect(loadHeartbeatMs('')).resolves.toBe(DEFAULT_MS);
    // Infinity is not finite, so readNumber rejects it too — otherwise it would
    // survive Math.max and become an interval that never fires.
    await expect(loadHeartbeatMs('Infinity')).resolves.toBe(DEFAULT_MS);
    await expect(loadHeartbeatMs('NaN')).resolves.toBe(DEFAULT_MS);
  });

  it('clamps a value between 1 and the floor up to the floor', async () => {
    // 500ms would not busy-loop, but it is still 30x faster than anything a
    // 30-60s edge idle timeout needs, so it is bounded for the same reason.
    await expect(loadHeartbeatMs('1')).resolves.toBe(FLOOR_MS);
    await expect(loadHeartbeatMs('500')).resolves.toBe(FLOOR_MS);
    await expect(loadHeartbeatMs('999')).resolves.toBe(FLOOR_MS);
  });

  it('floors a fractional value to whole milliseconds', async () => {
    await expect(loadHeartbeatMs('1500.7')).resolves.toBe(1500);
  });

  it('clamps a value past setInterval\'s 2^31-1 limit down to the ceiling', async () => {
    // The mirror image of the `0` case, and the more dangerous of the two
    // because the symptom is inverted: `setInterval` keeps its delay in a
    // signed 32-bit int, so anything above 2147483647 overflows and Node RESETS
    // THE DELAY TO 1 ms. An extra-zeros typo meaning "basically never" would
    // therefore flood every open stream. Measured before the ceiling existed:
    // ~80 heartbeat ticks per 100 ms at both of these inputs.
    await expect(loadHeartbeatMs('2147483648')).resolves.toBe(CEILING_MS);
    await expect(loadHeartbeatMs('15000000000')).resolves.toBe(CEILING_MS);
    await expect(loadHeartbeatMs('1e21')).resolves.toBe(CEILING_MS);
    // Past Number.MAX_SAFE_INTEGER too, where the parse itself loses precision.
    await expect(loadHeartbeatMs('9007199254740993')).resolves.toBe(CEILING_MS);
    // The boundary itself is untouched — the ceiling clamps, it does not reject.
    await expect(loadHeartbeatMs('2147483647')).resolves.toBe(CEILING_MS);
  });

  it('keeps the retry: hint all-ASCII-digits for every input', async () => {
    // The route interpolates this value straight into `retry: <ms>` (see
    // route.ts). Per the SSE spec a client must IGNORE a retry value that is not
    // all digits, and `String(1e21)` is "1e+21" — so an unclamped large value
    // would silently drop the reconnect hint as well as spinning the timer.
    for (const raw of ['1e21', '2147483648', '1e400', '0', '-5', undefined]) {
      const ms = await loadHeartbeatMs(raw);
      expect(String(ms)).toMatch(/^[0-9]+$/);
    }
  });

  it('warns at boot above 60s, but does not override the operator', async () => {
    // A heartbeat slower than the edge's idle timeout silently reintroduces
    // dropped streams, and the symptom (a console reconnecting on a fixed
    // cadence) looks like a network problem. So it warns — and deliberately
    // does NOT clamp, because a long or absent idle timeout is a legitimate
    // deployment. The JEST_WORKER_ID guard is what normally keeps boot warnings
    // out of test output, so it has to come off to observe this.
    const worker = process.env.JEST_WORKER_ID;
    delete process.env.JEST_WORKER_ID;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env.SSE_HEARTBEAT_MS = '120000';
      jest.resetModules();
      const mod = await import('./config');
      // Not clamped down to 60s or to the default.
      expect(mod.config.sseHeartbeatMs).toBe(120_000);
      const messages = warn.mock.calls.map((c) => String(c[0]));
      expect(
        messages.some(
          (m) =>
            m.includes('SSE_HEARTBEAT_MS=120000') &&
            m.includes('effective SSE heartbeat is 120000ms') &&
            m.includes('60000'),
        ),
      ).toBe(true);
      // Not a clamp, so it must not claim to be one.
      expect(messages.some((m) => m.includes('clamped'))).toBe(false);
    } finally {
      warn.mockRestore();
      if (worker !== undefined) process.env.JEST_WORKER_ID = worker;
    }
  });

  it('stays silent at and below 60s', async () => {
    const worker = process.env.JEST_WORKER_ID;
    delete process.env.JEST_WORKER_ID;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env.SSE_HEARTBEAT_MS = '60000';
      jest.resetModules();
      const mod = await import('./config');
      expect(mod.config.sseHeartbeatMs).toBe(60_000);
      // The boundary is exclusive: 60000 is fine, 60001 is not.
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('SSE_HEARTBEAT_MS')),
      ).toBe(false);
    } finally {
      warn.mockRestore();
      if (worker !== undefined) process.env.JEST_WORKER_ID = worker;
    }
  });

  it('says so at boot when it clamps an overflowing value down', async () => {
    // The clamp must not be silent: the operator wrote one number and the server
    // is running another, and the two differ by orders of magnitude. The warning
    // names both, and says what the unclamped behaviour would have been.
    const worker = process.env.JEST_WORKER_ID;
    delete process.env.JEST_WORKER_ID;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env.SSE_HEARTBEAT_MS = '15000000000';
      jest.resetModules();
      const mod = await import('./config');
      expect(mod.config.sseHeartbeatMs).toBe(CEILING_MS);
      const messages = warn.mock.calls.map((c) => String(c[0]));
      expect(
        messages.some(
          (m) =>
            m.includes('SSE_HEARTBEAT_MS=15000000000') &&
            m.includes('clamped to 2147483647ms') &&
            m.includes('1ms'),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
      if (worker !== undefined) process.env.JEST_WORKER_ID = worker;
    }
  });

  it('echoes the raw value into the boot warning trimmed and bounded', async () => {
    // The warning quotes an env var back at the operator, so it gets the same
    // treatment as any other copied-in value: whitespace-trimmed (Number()
    // ignores surrounding whitespace, so "\n70000\n" is a live value and would
    // otherwise put a raw newline inside the log line) and length-bounded with a
    // marker, so a truncated value cannot read as a complete one. The clamp
    // clause has to survive truncation too — it is decided on the untruncated
    // string, because Number('1000…(truncated)') is NaN.
    const worker = process.env.JEST_WORKER_ID;
    delete process.env.JEST_WORKER_ID;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env.SSE_HEARTBEAT_MS = '\n70000\n';
      jest.resetModules();
      let mod = await import('./config');
      expect(mod.config.sseHeartbeatMs).toBe(70_000);
      // Picked by content, not by index: with JEST_WORKER_ID unset the API_KEYS
      // boot warning fires first.
      const heartbeatWarning = (): string =>
        warn.mock.calls
          .map((c) => String(c[0]))
          .find((m) => m.includes('SSE heartbeat')) ?? '';

      let msg = heartbeatWarning();
      expect(msg).toContain('SSE_HEARTBEAT_MS=70000');
      expect(msg).not.toContain('\n');

      // 45 characters, and far above the ceiling.
      warn.mockClear();
      const huge = `1${'0'.repeat(44)}`;
      process.env.SSE_HEARTBEAT_MS = huge;
      jest.resetModules();
      mod = await import('./config');
      expect(mod.config.sseHeartbeatMs).toBe(CEILING_MS);
      msg = heartbeatWarning();
      expect(msg).toContain('…(truncated)');
      expect(msg).not.toContain(huge);
      expect(msg).toContain('clamped to 2147483647ms');
    } finally {
      warn.mockRestore();
      if (worker !== undefined) process.env.JEST_WORKER_ID = worker;
    }
  });

  it('is always an integer inside setInterval\'s usable range', async () => {
    // The property that actually matters, asserted over every case above at
    // once: the value handed to setInterval is a whole number of milliseconds,
    // no smaller than the floor and no larger than the range setInterval can
    // represent. The upper assertion is the load-bearing one — an earlier
    // version of this test asserted only `>= FLOOR_MS`, and since
    // `Number.isInteger(1e21)` is true and `1e21 >= 1000`, it passed happily on
    // the very inputs that made the timer fire every millisecond. The input list
    // is therefore part of the test: it must contain values that overflow.
    for (const raw of [
      undefined,
      '0',
      '-5',
      'abc',
      '',
      '1',
      '999',
      '1500.7',
      '2000',
      'Infinity',
      'NaN',
      '1e400',
      '0x10',
      '2147483648',
      '15000000000',
      '1e21',
      '9007199254740993',
      '-1e21',
    ]) {
      const ms = await loadHeartbeatMs(raw);
      expect(Number.isInteger(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(FLOOR_MS);
      expect(ms).toBeLessThanOrEqual(CEILING_MS);
    }
  });
});

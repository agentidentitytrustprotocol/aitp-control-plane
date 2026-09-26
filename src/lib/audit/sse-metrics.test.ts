// Unit tests for the SSE lifecycle counters — verifies:
//   • a scrape before the stream route has ever been evaluated (all three
//     globalThis slots still `undefined`) reports zeros rather than NaN or a
//     missing series. This is the `?? 0` path, and it is the whole reason the
//     fallbacks are there: a missing series reads as "no data" to an alert
//     rule, not as "none yet" — the exact blind spot behind issue #89.
//   • acquire counts an open AND raises the gauge in one step, release lowers
//     only the gauge, and the gauge floors at 0.
//
// No mocks: the module is pure arithmetic over globalThis slots.

import {
  acquireSseSlot,
  getSseMetrics,
  getSseOpenCount,
  recordSseRejected,
  releaseSseSlot,
  resetSseMetrics,
} from './sse-metrics';

/** The pristine pre-first-request state: the slots do not exist at all. */
function clearSlots(): void {
  delete globalThis.__sseOpenCount;
  delete globalThis.__sseOpenedTotal;
  delete globalThis.__sseRejectedTotal;
}

afterEach(() => {
  resetSseMetrics();
});

describe('SSE metrics — a fresh process, before any request', () => {
  it('reports zeros for all three series rather than undefined or NaN', () => {
    clearSlots();
    expect(getSseMetrics()).toEqual({
      open: 0,
      openedTotal: 0,
      rejectedTotal: 0,
    });
    expect(getSseOpenCount()).toBe(0);
  });

  it('counts from zero when each mutator is the first thing to touch its slot', () => {
    clearSlots();
    expect(acquireSseSlot()).toBe(1);
    clearSlots();
    recordSseRejected();
    expect(getSseMetrics().rejectedTotal).toBe(1);
    clearSlots();
    // Release on an absent slot must floor at 0, not produce -1: a negative
    // gauge would also let the capacity cap over-admit.
    releaseSseSlot();
    expect(getSseOpenCount()).toBe(0);
  });
});

describe('SSE metrics — accounting', () => {
  it('raises the gauge and the cumulative counter together on acquire', () => {
    resetSseMetrics();
    expect(acquireSseSlot()).toBe(1);
    expect(acquireSseSlot()).toBe(2);
    expect(getSseMetrics()).toEqual({
      open: 2,
      openedTotal: 2,
      rejectedTotal: 0,
    });
  });

  it('lowers only the gauge on release — opened_total is cumulative', () => {
    resetSseMetrics();
    acquireSseSlot();
    acquireSseSlot();
    releaseSseSlot();
    expect(getSseMetrics()).toEqual({
      open: 1,
      openedTotal: 2,
      rejectedTotal: 0,
    });
  });

  it('floors the gauge at 0 on an extra release', () => {
    resetSseMetrics();
    acquireSseSlot();
    releaseSseSlot();
    releaseSseSlot();
    releaseSseSlot();
    expect(getSseOpenCount()).toBe(0);
    expect(getSseMetrics().openedTotal).toBe(1);
  });

  it('returns a copy, so a scrape cannot mutate the counters it is reading', () => {
    resetSseMetrics();
    acquireSseSlot();
    const snap = getSseMetrics();
    snap.open = 99;
    snap.openedTotal = 99;
    expect(getSseMetrics()).toEqual({
      open: 1,
      openedTotal: 1,
      rejectedTotal: 0,
    });
  });

  it('counts rejections without touching the open or opened series', () => {
    resetSseMetrics();
    recordSseRejected();
    recordSseRejected();
    expect(getSseMetrics()).toEqual({
      open: 0,
      openedTotal: 0,
      rejectedTotal: 2,
    });
  });
});

import { rateLimiter } from './rate-limit';

describe('rateLimiter', () => {
  beforeEach(() => rateLimiter.reset());

  it('allows requests under the limit', () => {
    for (let i = 0; i < 5; i++) {
      const decision = rateLimiter.check('test', 'key1', 5, 60_000);
      expect(decision.allowed).toBe(true);
      expect(decision.remaining).toBe(5 - (i + 1));
    }
  });

  it('blocks once the limit is reached and counts the drop', () => {
    for (let i = 0; i < 3; i++) rateLimiter.check('test', 'key1', 3, 60_000);
    const blocked = rateLimiter.check('test', 'key1', 3, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(rateLimiter.getDropTotals()).toEqual({ test: 1 });
  });

  it('isolates keys within the same bucket', () => {
    for (let i = 0; i < 5; i++) rateLimiter.check('test', 'keyA', 5, 60_000);
    const blockedA = rateLimiter.check('test', 'keyA', 5, 60_000);
    const allowedB = rateLimiter.check('test', 'keyB', 5, 60_000);
    expect(blockedA.allowed).toBe(false);
    expect(allowedB.allowed).toBe(true);
  });

  it('counts drops per bucket name independently', () => {
    for (let i = 0; i < 2; i++) rateLimiter.check('bucket-x', 'k', 1, 60_000);
    for (let i = 0; i < 3; i++) rateLimiter.check('bucket-y', 'k', 1, 60_000);
    expect(rateLimiter.getDropTotals()).toEqual({
      'bucket-x': 1,
      'bucket-y': 2,
    });
  });

  it('treats limit=0 as disabled (always allows, no drops)', () => {
    for (let i = 0; i < 100; i++) {
      const d = rateLimiter.check('disabled', 'k', 0, 60_000);
      expect(d.allowed).toBe(true);
    }
    expect(rateLimiter.getDropTotals()).toEqual({});
  });

  it('gc() drops only buckets whose window has already expired', () => {
    const realDateNow = Date.now;
    let t = 1_000_000;
    Date.now = () => t;
    try {
      rateLimiter.check('test', 'stale', 5, 1000); // resetAt = t + 1000
      t += 1001; // stale's window is now in the past
      rateLimiter.check('test', 'fresh', 5, 1000); // resetAt = new t + 1000

      rateLimiter.gc();

      // 'stale' was collected: the next check for it starts a fresh
      // window (count 1 of 5) rather than reusing a stale bucket.
      const staleAfterGc = rateLimiter.check('test', 'stale', 1, 1000);
      expect(staleAfterGc.allowed).toBe(true);
      expect(staleAfterGc.remaining).toBe(0);

      // 'fresh' survived gc and keeps its accumulated count.
      const freshAfterGc = rateLimiter.check('test', 'fresh', 5, 1000);
      expect(freshAfterGc.remaining).toBe(3);
    } finally {
      Date.now = realDateNow;
    }
  });

  it('refills after the window elapses', () => {
    const realDateNow = Date.now;
    let t = 1_000_000;
    Date.now = () => t;
    try {
      for (let i = 0; i < 2; i++) rateLimiter.check('test', 'k', 2, 1000);
      expect(rateLimiter.check('test', 'k', 2, 1000).allowed).toBe(false);
      t += 1001;
      expect(rateLimiter.check('test', 'k', 2, 1000).allowed).toBe(true);
    } finally {
      Date.now = realDateNow;
    }
  });
});

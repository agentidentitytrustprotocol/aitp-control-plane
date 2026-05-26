import { webhookBreaker } from './circuit-breaker';

describe('webhookBreaker', () => {
  beforeEach(() => webhookBreaker.reset_all());

  it('starts closed', () => {
    expect(webhookBreaker.shouldAttempt('a')).toBe(true);
    expect(webhookBreaker.getSnapshot('a').state).toBe('closed');
  });

  it('opens after threshold consecutive failures', () => {
    for (let i = 0; i < 5; i++) webhookBreaker.recordFailure('a');
    expect(webhookBreaker.getSnapshot('a').state).toBe('open');
    expect(webhookBreaker.shouldAttempt('a')).toBe(false);
  });

  it('resets failure counter on success', () => {
    for (let i = 0; i < 3; i++) webhookBreaker.recordFailure('a');
    webhookBreaker.recordSuccess('a');
    expect(webhookBreaker.getSnapshot('a').failures).toBe(0);
    expect(webhookBreaker.getSnapshot('a').state).toBe('closed');
  });

  it('moves open → half_open after reset timeout, allows one probe', () => {
    const realNow = Date.now;
    let t = 1_000_000_000;
    Date.now = () => t;
    try {
      for (let i = 0; i < 5; i++) webhookBreaker.recordFailure('a');
      expect(webhookBreaker.shouldAttempt('a')).toBe(false);
      t += 60_001;
      expect(webhookBreaker.shouldAttempt('a')).toBe(true);
      expect(webhookBreaker.getSnapshot('a').state).toBe('half_open');
      // A concurrent caller sees probeInFlight=true and is rejected.
      expect(webhookBreaker.shouldAttempt('a')).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  it('probe success closes the circuit', () => {
    const realNow = Date.now;
    let t = 1_000_000_000;
    Date.now = () => t;
    try {
      for (let i = 0; i < 5; i++) webhookBreaker.recordFailure('a');
      t += 60_001;
      webhookBreaker.shouldAttempt('a'); // claim probe
      webhookBreaker.recordSuccess('a');
      expect(webhookBreaker.getSnapshot('a').state).toBe('closed');
    } finally {
      Date.now = realNow;
    }
  });

  it('probe failure re-opens the circuit and restarts the timer', () => {
    const realNow = Date.now;
    let t = 1_000_000_000;
    Date.now = () => t;
    try {
      for (let i = 0; i < 5; i++) webhookBreaker.recordFailure('a');
      t += 60_001;
      webhookBreaker.shouldAttempt('a'); // claim probe
      webhookBreaker.recordFailure('a');
      expect(webhookBreaker.getSnapshot('a').state).toBe('open');
      expect(webhookBreaker.shouldAttempt('a')).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  it('manual reset re-closes the circuit', () => {
    for (let i = 0; i < 5; i++) webhookBreaker.recordFailure('a');
    webhookBreaker.reset('a');
    expect(webhookBreaker.getSnapshot('a').state).toBe('closed');
    expect(webhookBreaker.shouldAttempt('a')).toBe(true);
  });
});

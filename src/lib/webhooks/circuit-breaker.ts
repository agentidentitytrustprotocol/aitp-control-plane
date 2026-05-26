/**
 * Per-webhook circuit breaker.
 *
 * Without this a misbehaving subscriber (5xx, timeouts) eats the
 * full retry budget on every event, choking the dispatcher under
 * sustained failure. The breaker short-circuits new attempts once a
 * threshold of consecutive failures is reached, then probes
 * periodically (half-open) before fully closing the circuit again.
 *
 * State machine:
 *   closed     → failures < threshold; attempts proceed
 *   open       → threshold reached; attempts rejected immediately
 *   half_open  → reset timeout elapsed; allow exactly one probe
 *                  → on probe success: closed
 *                  → on probe failure: open (reset timer restarts)
 *
 * State is in-memory per process. For multi-instance deployments add
 * a shared backing store later (Redis) — for v1 each instance carries
 * its own view of which subscribers are misbehaving.
 */

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerSnapshot {
  state: BreakerState;
  failures: number;
  consecutiveSuccesses: number;
  openedAt: number | null;
  nextProbeAt: number | null;
}

export interface BreakerConfig {
  failureThreshold: number; // consecutive failures to open
  resetTimeoutMs: number; // open → half_open after this
  successThresholdToClose: number; // half_open → closed after N successes
}

const DEFAULT_CONFIG: BreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
  successThresholdToClose: 1,
};

interface BreakerEntry {
  state: BreakerState;
  failures: number;
  consecutiveSuccesses: number;
  openedAt: number | null;
  // When half_open, only one probe is allowed at a time. This flag is
  // set when a probe is claimed and cleared on its outcome.
  probeInFlight: boolean;
}

class WebhookCircuitBreaker {
  private states = new Map<string, BreakerEntry>();
  private config: BreakerConfig;

  constructor(config: Partial<BreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Decide whether the caller may issue a delivery attempt. Returns
   * `false` when the circuit is open (and the reset timer hasn't
   * elapsed). When the reset timer has elapsed, the first caller to
   * call `shouldAttempt` transitions the entry to half_open and
   * claims the probe — any concurrent caller sees `false`. */
  shouldAttempt(webhookId: string): boolean {
    const e = this.entry(webhookId);
    if (e.state === 'closed') return true;
    if (e.state === 'open') {
      if (
        e.openedAt !== null &&
        Date.now() - e.openedAt >= this.config.resetTimeoutMs
      ) {
        e.state = 'half_open';
        e.probeInFlight = true;
        return true;
      }
      return false;
    }
    // half_open
    if (e.probeInFlight) return false;
    e.probeInFlight = true;
    return true;
  }

  recordSuccess(webhookId: string): void {
    const e = this.entry(webhookId);
    e.probeInFlight = false;
    if (e.state === 'half_open') {
      e.consecutiveSuccesses += 1;
      if (e.consecutiveSuccesses >= this.config.successThresholdToClose) {
        e.state = 'closed';
        e.failures = 0;
        e.openedAt = null;
      }
      return;
    }
    e.failures = 0;
    e.consecutiveSuccesses = 0;
  }

  recordFailure(webhookId: string): void {
    const e = this.entry(webhookId);
    e.probeInFlight = false;
    e.consecutiveSuccesses = 0;
    e.failures += 1;
    if (
      e.state === 'closed' &&
      e.failures >= this.config.failureThreshold
    ) {
      e.state = 'open';
      e.openedAt = Date.now();
    } else if (e.state === 'half_open') {
      e.state = 'open';
      e.openedAt = Date.now();
    }
  }

  /** Manually re-arm the breaker (admin action). */
  reset(webhookId: string): void {
    this.states.set(webhookId, {
      state: 'closed',
      failures: 0,
      consecutiveSuccesses: 0,
      openedAt: null,
      probeInFlight: false,
    });
  }

  getSnapshot(webhookId: string): BreakerSnapshot {
    const e = this.entry(webhookId);
    const nextProbeAt =
      e.state === 'open' && e.openedAt !== null
        ? e.openedAt + this.config.resetTimeoutMs
        : null;
    return {
      state: e.state,
      failures: e.failures,
      consecutiveSuccesses: e.consecutiveSuccesses,
      openedAt: e.openedAt,
      nextProbeAt,
    };
  }

  /** Snapshot of all known breakers; useful for /api/metrics. */
  getAllSnapshots(): Record<string, BreakerSnapshot> {
    const out: Record<string, BreakerSnapshot> = {};
    for (const id of this.states.keys()) out[id] = this.getSnapshot(id);
    return out;
  }

  /** Test-only — clear everything. */
  reset_all(): void {
    this.states.clear();
  }

  private entry(webhookId: string): BreakerEntry {
    let e = this.states.get(webhookId);
    if (!e) {
      e = {
        state: 'closed',
        failures: 0,
        consecutiveSuccesses: 0,
        openedAt: null,
        probeInFlight: false,
      };
      this.states.set(webhookId, e);
    }
    return e;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __webhookBreaker: WebhookCircuitBreaker | undefined;
}

export const webhookBreaker: WebhookCircuitBreaker =
  globalThis.__webhookBreaker ??
  (globalThis.__webhookBreaker = new WebhookCircuitBreaker({
    failureThreshold: parseInt(
      process.env.WEBHOOK_BREAKER_FAILURE_THRESHOLD ?? '5',
      10,
    ),
    resetTimeoutMs: parseInt(
      process.env.WEBHOOK_BREAKER_RESET_MS ?? '60000',
      10,
    ),
  }));

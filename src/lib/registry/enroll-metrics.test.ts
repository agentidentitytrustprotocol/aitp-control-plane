// Unit tests for the enrollment failure counter. The load-bearing property is
// the CARDINALITY BOUND: the label derives from caller-supplied input, so an
// unbounded label would make /api/metrics a time-series bomb. That is asserted
// with 200 distinct unknown codes, not with a comment.
//
// Note the deliberate asymmetry this file exists to protect: an unknown code
// is allowlisted-away to `other` HERE, while `sdkVerifyCode` passes the same
// value through verbatim to the wire. Opposite rules, because the SDK owns the
// wire vocabulary and we own our cardinality.

import {
  ENROLL_FAILURE_LABELS,
  getEnrollFailureTotals,
  recordEnrollFailure,
  resetEnrollFailureTotals,
} from './enroll-metrics';

beforeEach(() => {
  resetEnrollFailureTotals();
});

describe('enroll failure counter', () => {
  it('pre-seeds every label at 0 at MODULE LOAD, before any reset', () => {
    // Deliberately loaded in isolation rather than reusing the top-level
    // import: `resetEnrollFailureTotals()` in beforeEach re-seeds every key, so
    // a test that reads the shared instance cannot distinguish a real
    // module-load pre-seed from the reset having created the keys. This is the
    // only test that observes true fresh-process state.
    //
    // It matters beyond a missing series: the increment would compute
    // `undefined + 1` on an unseeded key, so the FIRST failure would emit a
    // `NaN` sample — an unparseable scrape line, silently.
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fresh = require('./enroll-metrics') as typeof import('./enroll-metrics');
      const totals = fresh.getEnrollFailureTotals();
      expect(Object.keys(totals).sort()).toEqual(
        [...fresh.ENROLL_FAILURE_LABELS].sort(),
      );
      for (const label of fresh.ENROLL_FAILURE_LABELS) {
        expect(totals[label]).toBe(0);
      }
    });
  });

  it('never emits a non-finite total, even for the first failure recorded', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fresh = require('./enroll-metrics') as typeof import('./enroll-metrics');
      fresh.recordEnrollFailure('signature_invalid');
      const totals = fresh.getEnrollFailureTotals();
      expect(totals.signature_invalid).toBe(1);
      for (const value of Object.values(totals)) {
        expect(Number.isFinite(value)).toBe(true);
      }
    });
  });

  it('resets every label back to 0 without dropping keys', () => {
    recordEnrollFailure('expired');
    recordEnrollFailure(undefined);
    resetEnrollFailureTotals();
    const totals = getEnrollFailureTotals();
    expect(Object.keys(totals).sort()).toEqual([...ENROLL_FAILURE_LABELS].sort());
    expect(Object.values(totals).every((v) => v === 0)).toBe(true);
  });

  it('bounds the label set at exactly ten', () => {
    expect(ENROLL_FAILURE_LABELS).toHaveLength(10);
    expect(new Set(ENROLL_FAILURE_LABELS).size).toBe(10);
  });

  it.each([
    'signature_invalid',
    'pop_failed',
    'aid_mismatch',
    'expired',
    'version_unknown',
    'identity_hint_malformed',
    'incompatible_identity_type',
    'malformed',
  ])('gives %s its own series', (code) => {
    recordEnrollFailure(code);
    expect(getEnrollFailureTotals()[code]).toBe(1);
    expect(getEnrollFailureTotals().other).toBe(0);
    expect(getEnrollFailureTotals().none).toBe(0);
  });

  it('counts a failure with no SDK code as `none`', () => {
    // This is how our own aid / 5-minute guards show up on a dashboard.
    recordEnrollFailure(undefined);
    expect(getEnrollFailureTotals().none).toBe(1);
    expect(getEnrollFailureTotals().other).toBe(0);
  });

  it('collapses 200 distinct unknown codes into the single `other` series', () => {
    // THE cardinality assertion. Without the allowlist this would create 200
    // time series from one caller's input.
    for (let i = 0; i < 200; i += 1) {
      recordEnrollFailure(`novel_code_${i}`);
    }
    const totals = getEnrollFailureTotals();
    expect(totals.other).toBe(200);
    expect(Object.keys(totals)).toHaveLength(10);
  });

  it('never grows the key set, whatever it is fed', () => {
    const hostile = [
      'x'.repeat(500),
      'code with spaces',
      'quote"injection',
      'newline\ninjection',
      '{"json":"ish"}',
      'aitp_control_plane_enroll_verification_failures{code="spoof"} 999',
      '',
      '../../etc/passwd',
    ];
    for (const code of hostile) recordEnrollFailure(code);
    const totals = getEnrollFailureTotals();
    expect(Object.keys(totals).sort()).toEqual([...ENROLL_FAILURE_LABELS].sort());
    expect(totals.other).toBe(hostile.length);
  });

  it('accumulates across calls and keeps series independent', () => {
    recordEnrollFailure('expired');
    recordEnrollFailure('expired');
    recordEnrollFailure('signature_invalid');
    recordEnrollFailure(undefined);
    recordEnrollFailure('who_knows');
    const totals = getEnrollFailureTotals();
    expect(totals.expired).toBe(2);
    expect(totals.signature_invalid).toBe(1);
    expect(totals.none).toBe(1);
    expect(totals.other).toBe(1);
    expect(totals.pop_failed).toBe(0);
  });

  it('returns a copy, so a scrape cannot mutate the counters', () => {
    recordEnrollFailure('expired');
    const snapshot = getEnrollFailureTotals();
    snapshot.expired = 9999;
    snapshot.injected = 1;
    const fresh = getEnrollFailureTotals();
    expect(fresh.expired).toBe(1);
    expect('injected' in fresh).toBe(false);
  });

  it('is case-sensitive, so a differently-cased code is `other` not a new series', () => {
    recordEnrollFailure('SIGNATURE_INVALID');
    const totals = getEnrollFailureTotals();
    expect(totals.other).toBe(1);
    expect(totals.signature_invalid).toBe(0);
  });
});

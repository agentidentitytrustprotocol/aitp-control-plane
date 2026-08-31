/**
 * Call `fn` (expected to invoke one of the SDK's void-returning,
 * synchronously-throwing verifiers, e.g. `verifyRevocationList` or
 * `verifyManifestJson`) and assert it threw with exactly `code`.
 *
 * These verifiers are NOT Promises, so `await expect(...).rejects` silently
 * never asserts, and a bare `.toThrow()` passes on the wrong error — this
 * throws loudly if `fn` does not throw at all.
 *
 * Shared by `src/e2e/revocation-flow.integration.test.ts` and
 * `src/lib/identity/cp-manifest.integration.test.ts` so the two call sites
 * don't drift.
 */
export function expectVerifyCode(fn: () => void, code: string): void {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    expect((err as { code?: unknown }).code).toBe(code);
  }
  if (!threw) {
    throw new Error(`expected fn to throw with code "${code}", but it did not throw`);
  }
}

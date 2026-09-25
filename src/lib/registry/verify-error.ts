/**
 * The two error primitives the enrollment path needs to tell "the caller's
 * manifest is bad" apart from "this service is broken", and to say *why*
 * without branching on prose.
 *
 * Two error sources reach `POST /api/registry/enroll`, and they are
 * identified by two deliberately different mechanisms so that neither can
 * masquerade as the other:
 *
 *  1. The `aitp` SDK's `verifyManifestJson` throws an error carrying a
 *     lowercase_snake `.code` string. The authoritative value set lives in
 *     the SDK's own docstring (`node_modules/aitp/index.d.ts`), and
 *     deliberately nowhere in this file (see the invariant below). That
 *     docstring says the code is the contract and the wording is not, so
 *     `sdkVerifyCode` is the single place in production code that knows
 *     where that code lives. SDK errors propagate untouched — wrapping them
 *     would disarm `enrollment.test.ts`'s forward-compat guard, which
 *     exists to notice the SDK moving `.code`.
 *  2. `enrollment.ts` rejects some manifests itself (a non-AID
 *     `manifest.aid`, a TTL inside the registration guard), and those
 *     rejections are what `ManifestRejectedError` is for: its `cpCode`
 *     carries a value from *this repo's* SCREAMING_SNAKE taxonomy. It
 *     deliberately does NOT define a `code` property — colliding with the
 *     SDK's would let our own errors satisfy the guard that watches the
 *     SDK's contract. Note that `enrollment.ts` does not throw it yet: it
 *     still throws plain `Error`s, and switches over once the route is ready
 *     to discriminate on the class. Until then `ManifestRejectedError` is
 *     defined and tested but unused in production.
 *
 * `sdkVerifyCode` is defensive rather than trusting because its return
 * value is destined for a public, unauthenticated response body, and it
 * must never throw: it runs inside a `catch`, where a throw would turn a
 * clean 400 into an unhandled 500.
 *
 * This file names no SDK code value, ever — that is a permanent, greppable
 * invariant. Unknown codes pass through verbatim because the SDK owns that
 * vocabulary (the set already grew from five to eight inside this repo's
 * lifetime, `aitp` is a 0.x caret dependency, and the SDK exports no union
 * or enum to check an allowlist against). Where cardinality must be bounded
 * instead — a Prometheus label, whose values are a time-series dimension —
 * an allowlist is required, and it must NOT live here: it belongs beside the
 * metric that needs it, so that this file's invariant survives and the two
 * opposite rules are visibly computed in two different modules.
 */

/**
 * Upper bound on a code we are willing to echo. The longest code the SDK
 * documents today is 26 characters; 64 is a bound so that no future SDK
 * change — or unrelated library throwing an `Error` with a fat `.code` —
 * can turn our error body into an echo channel for unbounded
 * attacker-influenced data.
 */
const MAX_VERIFY_CODE_LENGTH = 64;

/**
 * Read the `aitp` SDK's failure code off an unknown thrown value.
 *
 * Returns the code only when it is a non-blank string within the length
 * bound; `undefined` for everything else — a missing property, a non-string
 * value, a blank string (branchable-looking but meaningless), an
 * over-long value (a *truncated* code is a wrong code a client may match
 * against; absence is honest), or a getter that throws.
 *
 * A recognized code is returned **verbatim**, never normalized: the SDK owns
 * this vocabulary, so an unknown value must survive intact rather than be
 * reshaped by us.
 */
export function sdkVerifyCode(err: unknown): string | undefined {
  if (err === null || err === undefined) return undefined;
  let raw: unknown;
  try {
    raw = (err as { code?: unknown }).code;
  } catch {
    // A throwing getter must not escape: this runs inside a catch block.
    return undefined;
  }
  if (typeof raw !== 'string') return undefined;
  // Blank, not merely empty. `''` and `'   '` are the same defect — a
  // machine-readable field that looks branchable and means nothing — and the
  // bound is checked on the raw length so trimming can never smuggle an
  // over-long value through.
  if (raw.trim().length === 0) return undefined;
  if (raw.length > MAX_VERIFY_CODE_LENGTH) return undefined;
  return raw;
}

/**
 * A manifest this service rejected on its own — not via the SDK.
 *
 * Follows the repo's existing lib-thrown / route-mapped error idiom
 * (`BodyTooLargeError`, `UnsafeWebhookUrlError`, `InvalidFilterError`):
 * extend `Error`, set `this.name`, and carry the structured detail in a
 * field rather than encoding it in the message.
 *
 * `cpCode` holds a value from this repo's SCREAMING_SNAKE response-code
 * taxonomy (`MANIFEST_INVALID`, `MANIFEST_EXPIRED`). It is intentionally
 * not called `code`: see the file header.
 */
export class ManifestRejectedError extends Error {
  constructor(
    message: string,
    public readonly cpCode: string,
  ) {
    super(message);
    this.name = 'ManifestRejectedError';
  }
}

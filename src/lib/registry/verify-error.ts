/**
 * The error primitives the enrollment path needs to tell "the caller's
 * manifest is bad" apart from "this service is broken", and to say *why*
 * without branching on prose.
 *
 * THREE error sources reach `POST /api/registry/enroll`, not two. This file
 * used to say two, and the miscount was the defect (issue #102): it counted
 * the sources that are *meant* to produce a manifest verdict and missed the
 * one that merely looks like one.
 *
 *  1. The `aitp` SDK's `verifyManifestJson` throws an error carrying a
 *     lowercase_snake `.code` string. The authoritative value set lives in
 *     the SDK's own docstring (`node_modules/aitp/index.d.ts`), and
 *     deliberately nowhere in this file (see the invariant below). That
 *     docstring says the code is the contract and the wording is not, so
 *     `sdkVerifyCode` is the single place in production code that knows
 *     where that code lives. SDK errors still propagate UNTOUCHED — see
 *     `markSdkVerifyFailure`, which records provenance without altering the
 *     error — because wrapping them would disarm `enrollment.test.ts`'s
 *     forward-compat guard, which exists to notice the SDK moving `.code`.
 *  2. `enrollment.ts` rejects some manifests itself (a non-AID
 *     `manifest.aid`, a TTL inside the registration guard), and those
 *     rejections are what `ManifestRejectedError` is for: its `cpCode`
 *     carries a value from *this repo's* SCREAMING_SNAKE taxonomy. It
 *     deliberately does NOT define a `code` property — colliding with the
 *     SDK's would let our own errors satisfy the guard that watches the
 *     SDK's contract.
 *  3. NODE ITSELF, and anything else in the call. `node:crypto`'s
 *     `randomUUID` and `createHmac`, and `Buffer.from`, all throw errors
 *     carrying a *string* `.code`, and `EnrollmentService.verifyAndIssueToken`
 *     calls all three while minting the token — i.e. AFTER the SDK has
 *     already accepted the manifest and the caller has been proven blameless.
 *     Source 3 is not a manifest verdict at all; it is this service breaking.
 *
 * Sources 1 and 3 are INDISTINGUISHABLE BY SHAPE, which is why provenance is
 * no longer inferred from shape. `sdkVerifyCode` used to answer for any value
 * carrying a plausible `.code`, so a `createHmac` fault was published as
 * `400 MANIFEST_INVALID {verifyCode: "ERR_CRYPTO_INVALID_DIGEST"}` — a server
 * fault reported as the caller's, with an internal message echoed to an
 * unauthenticated caller and a fabricated `verifyCode` attributed to the SDK.
 * That is the same defect class as #69 and #91, and #99's lesson one layer
 * out: identify an error by what it IS, never by where it was thrown or by a
 * property it happens to carry.
 *
 * So each source is now identified POSITIVELY, by a mechanism the other two
 * cannot satisfy: source 2 by its class, source 1 by an explicit mark applied
 * at the SDK call site, and source 3 by being neither — which makes it
 * propagate to a 500 by construction rather than by anyone remembering to
 * order statements carefully.
 *
 * `sdkVerifyCode` is defensive rather than trusting because its return
 * value is destined for a public, unauthenticated response body, and it
 * must never throw: it runs inside a `catch`, where a throw would turn a
 * clean 400 into an unhandled 500.
 *
 * This file names no SDK code value, ever — that is a permanent, greppable
 * invariant, and it is why source 1 is identified by provenance rather than by
 * checking the code against an allowlist. Unknown codes pass through verbatim
 * because the SDK owns that vocabulary (the set already grew from five to eight
 * inside this repo's lifetime, `aitp` is a 0.x caret dependency, and the SDK
 * exports no union or enum to check an allowlist against). Where cardinality
 * must be bounded instead — a Prometheus label, whose values are a time-series
 * dimension — an allowlist is required, and it must NOT live here: it belongs
 * beside the metric that needs it, so that this file's invariant survives and
 * the two opposite rules are visibly computed in two different modules.
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
 * The thrown values that came out of the SDK's verifier.
 *
 * A registry rather than a property on the error, and a `WeakSet` rather than a
 * `Map`, for reasons that are all about not disturbing the error itself:
 *
 *  - The SDK's error propagates with its identity, its `.code`, its message and
 *    its stack intact, so `enrollment.test.ts`'s forward-compat guard still
 *    reads `.code` off the object the SDK ACTUALLY threw (a wrapper would make
 *    that guard read through `.cause`, testing our plumbing as much as the
 *    SDK's contract), and `route.ts` still echoes the SDK's own prose.
 *  - Marking cannot fail on a frozen or sealed error. `Object.defineProperty`
 *    would throw; `WeakSet.add` does not care.
 *  - Weak, so an entry cannot outlive the error it describes. No growth, no
 *    cleanup, nothing to bound.
 *
 * WHAT THIS RELIES ON, stated because it is a real constraint: `enrollment.ts`
 * (which marks) and `enroll/route.ts` (which reads) must hold the same instance
 * of this module. They do, and that is not a new requirement — `route.ts`
 * already does `err instanceof ManifestRejectedError` on a class this module
 * exports and `enrollment.ts` constructs, which needs exactly the same thing
 * and has been shipping since #69. Webpack keys modules by resolved path, so
 * the two different specifiers (`@/lib/registry/verify-error` and
 * `./verify-error`) are one module.
 */
const sdkVerifyFailures = new WeakSet<object>();

/**
 * Whether the brand registry can hold `err` at all.
 *
 * Shared by `markSdkVerifyFailure` and `sdkVerifyCode` deliberately: a `WeakSet`
 * keys on object identity, so a thrown primitive can never be marked, and if the
 * two functions disagreed about what is markable a value could be marked and
 * then not found. One predicate, so they cannot drift.
 */
function isBrandable(err: unknown): err is object {
  return err !== null && (typeof err === 'object' || typeof err === 'function');
}

/**
 * Record that `err` came out of the `aitp` SDK's verifier — the one fact
 * `sdkVerifyCode` cannot work out for itself.
 *
 * Call this ONLY in a `catch` wrapped around a call to the SDK's own
 * verification function, and nowhere else: the whole value of the mark is that
 * it is applied by the single frame that knows what it called. Marking anything
 * else re-opens issue #102 by hand.
 *
 * FORGETTING TO MARK A NEW CALL SITE fails in the safe direction and loudly. A
 * genuine manifest rejection degrades from `400 MANIFEST_INVALID` to a `500`,
 * which is this repo's settled preference (never report a server fault as the
 * caller's — #69, #91, #99), and `src/e2e/flow.integration.test.ts` drives a real
 * SDK rejection through the real route and requires the 400, so CI says so.
 *
 * A no-op for a thrown primitive, which is not a loss: a primitive carries no
 * `.code` for `sdkVerifyCode` to read either. Never throws — like
 * `sdkVerifyCode` it runs inside a `catch`, where a throw would turn a clean
 * 400 into an unhandled 500.
 */
export function markSdkVerifyFailure(err: unknown): void {
  if (isBrandable(err)) sdkVerifyFailures.add(err);
}

/**
 * Read the `aitp` SDK's failure code off a thrown value that
 * `markSdkVerifyFailure` has attested came from the SDK's verifier.
 *
 * Returns `undefined` for anything UNMARKED, however SDK-shaped it looks. That
 * gate is the fix for issue #102 and it is checked first: Node's own errors
 * carry string `.code`s (`ERR_CRYPTO_INVALID_DIGEST`, `ERR_OSSL_EVP_UNSUPPORTED`,
 * `ERR_OUT_OF_RANGE`, …), `verifyAndIssueToken` calls `randomUUID`, `Buffer.from`
 * and `createHmac` while minting the token, and before the gate every one of
 * those faults was published as the caller's bad manifest with a fabricated
 * `verifyCode`. Provenance is not inferable from shape, so it is not inferred.
 *
 * For a marked value, returns the code only when it is a non-blank string within
 * the length bound; `undefined` for everything else — a missing property, a
 * non-string value, a blank string (branchable-looking but meaningless), an
 * over-long value (a *truncated* code is a wrong code a client may match
 * against; absence is honest), or a getter that throws.
 *
 * A recognized code is returned **verbatim**, never normalized: the SDK owns
 * this vocabulary, so an unknown value must survive intact rather than be
 * reshaped by us. Note the division of labour with the gate above — provenance
 * is ours to establish, the code's *value* is the SDK's to define.
 */
export function sdkVerifyCode(err: unknown): string | undefined {
  // Provenance FIRST, and by explicit mark rather than by shape.
  if (!isBrandable(err) || !sdkVerifyFailures.has(err)) return undefined;
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

# aitp-playground — absorbing the aitp 0.5.0 signing-input change

**Target repo:** `agentidentitytrustprotocol/aitp-playground`
**Written in:** `aitp-control-plane` (per `/plan`'s cross-repo rule — plans stay where
they're written; the target repo *reads* this file, it is never written into)
**Tracking issue:** `aitp-playground#46`
**Companion (issuer side, shipped):** `aitp-control-plane` PR #46 (`cd35220`), issue #44
**Date:** 2026-08-25 · **Refreshed:** 2026-08-27 (**[R3]**, see header)
**Revised:** 2026-08-25 — verification pass against all five sibling checkouts. Every
factual claim in the original draft held. The revision closes five open items that turned
out to be checkable (marked **RESOLVED** in place), widens Phase 3 to cover the published
image, adds an unblocked **Phase 2B** (manifest verification), and corrects two acceptance
criteria in Phases 5–6 that were not implementable as written. **Phase 5 is rewritten** from
"file an issue upstream" into an implementation phase in `aitp-rs` — it is a Tier C
conformance gap in two shipped SDKs, not a favour to this repo. A new **Adjacent in-flight
work** section records `aitp-rs#89`/`#88`/`#87` and `aitp-verifier-py#12`, whose shared
acceptance criteria add a third signing-input assertion to Phase 2. Changes are called out
inline as **[REV]**.

**One correction to a prior revision, carried openly:** an earlier pass asserted that
`aitp-rs` needed a *new* `TctError::IssuerMismatch` variant. It does not — the variant
already exists (`crates/aitp-tct/src/error.rs:12-19`); `verify_revocation_list` just returns
the wrong one. Phase 5 now states the actual one-line fix.

**[F] Second adversarial pass, 2026-08-25** — every file:line claim re-verified against all
five sibling checkouts, the spec repo, PyPI, and GitHub (issue/PR/run state). The substance
of both prior passes held; the errors found were local and are fixed in place, marked
**[F]**: the AID scheme in Phase 2 (`aid:pubkey:`, not `did:aitp:`), the size of the JCS
copy (189 lines, not ~40), Phase 2B's file list (`aitp_server.py` never ingests a peer
manifest — both blind sites are in `agent_admin.py`), Q3's "only one issue" claim (stale
since #87/#88 opened), and drifted line numbers in `docker.yml`, `agent_admin.py`, and
`producer.ts`. Three additions, each because it was checkably missing: RFC-AITP-0008 §1.5's
transition-window MAY (rejecting the wrapped form is family policy, stricter than the spec's
floor), an expired-manifest failure mode in Phase 2B, and a fourth blind ingest — the CP's
own registry — in Enterprise concerns.

**[R3] Refresh, 2026-08-27 — the plan is COMPLETE; reconciled against the repo.**
All eight phases are shipped. Phase 2B's `Status: TODO` was **stale**, not outstanding — it
landed in `aitp-playground#47` (`3107e8f`), flipped in place below with evidence. Every
`PENDING.md` item is closed, `aitp-playground#46` is **CLOSED**, and the repo has **no open
issues**.

What moved underneath this plan since it was written:

| Then (2026-08-25) | Now (2026-08-27) |
|---|---|
| `aitp-sdk>=0.5.0` floor (Phase 1) | **`>=0.7.0`** (`pyproject.toml:37`) |
| `verify_revocation_list` unbound — Phase 5's whole subject | Bound and **published in 0.6.0**; called at `agents/base/revocation_refresh.py:117` |
| Failure causes were prose | **0.6.0/0.7.0 ship typed errors with a stable `.code`** on both the revocation and manifest paths |
| — | **New work beyond this plan:** `#50` (`c7f8fc1`) enforces delegation revocation and branches on those SDK error codes. Enabled by 0.7.0; not a phase here |

**Upstream vindicated Decision D1 rather than invalidating it.** `aitp-rs`'s 0.6.0 binding
notes keep `VerifyRevocationListContext` at `{expected_issuer, now}` and state that
`published_at` staleness belongs to the caller, because "collapsing authenticity and
freshness into one switch is how a `soft_fail` mode ends up reporting a *forged* snapshot as
not-revoked" — D1's two-axis split, reached independently. It is live in
`src/aitp_playground/config.py:61,68` as `revocation_fail_mode="fail_closed"` /
`revocation_max_staleness_secs=300`.

**One residual, found by this refresh — see the new Phase 8.** `agents/` verifies; `src/`
does not. `src/aitp_playground/cp_client/client.py:206` still parses a snapshot
signature-blind, and its own docstring says so while citing two references that are now
closed.

---

---

## Context

`aitp` 0.5.0 moved the JCS signing input from the transport wrapper to the inner artifact
body, for **revocation snapshots** and **session trust bundles** (manifests already signed
inner and are the control case). `aitp-rs` CHANGELOG is explicit that no dual-accept
exists: an artifact signed by ≤0.4.x will not verify under 0.5.0 and vice versa.

`aitp-rs` dispatches two independent `aitp-released` events — one to `aitp-control-plane`
(npm, the snapshot **issuer**) and one to `aitp-playground` (PyPI `aitp-sdk`, nominally the
snapshot **verifier**). The issuer side has shipped and is verified end-to-end against the
published image. The playground side merged its bump as **#45** (`5789098`, uv.lock only)
and its post-merge `Docker` run — including the full `docker-compose e2e` stack — went
**green** (run `32816438510`, 5m55s, success).

### The record needs correcting before any work is planned

Issue #46 and the upstream cross-repo plan both assume the playground is a snapshot
*verifier* that would break fail-closed on a convention flip. **Reading the code, that is
not true.** The green e2e run is not luck; it is the direct consequence of facts 1–4 below.
Facts 5–6 were added by the 2026-08-25 verification pass: they did not cause the green run,
but they are the same defect class found in adjacent code, and one of them is not blocked.

1. **The playground never verifies a revocation snapshot signature — anywhere.**
   `src/aitp_playground/cp_client/client.py:206` `fetch_revocation_list()` does
   `r.json()`, reaches for `data["revocation_list"]["entries"]`, and returns the `jti`
   strings. The `signature` sibling is never read. `agents/base/agent_admin.py:648` — the
   path the `revocation-via-cp` scenario actually exercises — does the identical
   signature-blind parse. Both comment the shape as "the signed envelope"; neither checks
   the signing.

2. **The Python SDK cannot verify one.** `aitp-tct` exposes `verify_revocation_list` and
   `revocation_signing_bytes` in Rust (`crates/aitp-tct/src/revocation.rs:118`,`:87`), but
   the bindings expose **only the signing half**: `aitp.pyi` has `sign_revocation_list`
   (`AitpAgent`), `verify_tct`, `verify_session_bundle`, `verify_manifest_json`,
   `verify_delegation*` — and no revocation verify. The Node binding has the same gap,
   which is precisely why the control plane's own test had to hand-roll a verifier.
   Issue #46's first checkbox — "assert `verify_revocation_snapshot`" — **is not
   implementable against `aitp-sdk` as it stands.**

3. **`aitp-verifier` is not on PyPI** (404). It exists only as a sibling checkout, pinned
   by SHA inside `aitp-rs` CI. Its `verify_revocation_snapshot` is already on the 0.5.0
   convention (`aitp_verifier/revocation.py` → `sha256(canonicalize(body))`), so it is a
   usable oracle — but not an installable dependency today.

4. **The e2e stack does not test the wheel this repo ships — and neither does the image it
   publishes. [REV]** `Dockerfile:37-50` builds the SDK with `maturin` from the sibling
   `../aitp-rs` **source tree**, and `.github/workflows/docker.yml:117` checks out
   `aitp-rs` at whatever `main` is. So `pyproject.toml`'s `aitp-sdk>=0.4.0` and `uv.lock`'s
   resolved version are **inert in e2e**. The suite that could catch a convention mismatch
   is structurally incapable of observing the pinned version, in either direction.

   The original draft stopped there. It is worse: `docker.yml:46-50 [F]` performs the *same*
   unpinned `aitp-rs`-at-`main` checkout for the **`build-and-push`** job, which pushes
   `ghcr.io/agentidentitytrustprotocol/aitp-playground:latest` on every main push
   (`docker.yml:93` [F]). **The published container embeds an unreleased, unpinned,
   unreproducible SDK.** That — not the e2e gap — is why #45 (`uv.lock` only) had no effect
   whatsoever on the deployed artifact. See Phase 3, whose scope this widens.

5. **The blindness is not confined to revocation, and one instance is not blocked. [REV]**
   Peer *manifests* are ingested unverified at two sites. `agent_admin.py:419` takes
   `delegatee_aid = delegatee_manifest["aid"]` straight out of an unauthenticated fetch and
   issues a delegation to it. `build_hello` deserializes the peer `ManifestEnvelope` and
   uses `peer_manifest.aid` without checking the envelope signature
   (`aitp-rs/bindings/aitp-py/src/session.rs:161-165`) — the SDK does not verify manifests
   implicitly; `verify_manifest_json` is a separate call the playground never makes.
   Unlike revocation, **`verify_manifest_json` is already bound** (`aitp.pyi:206`), so this
   one is fixable today with no upstream dependency. New **Phase 2B**.

6. **A third consumer in the family is equally blind, and says otherwise on screen. [REV]**
   `aitp-ui-console` fetches the snapshot (`src/hooks/use-trust.ts:130`,
   `src/components/config/cp-identity.tsx:33`) and renders **"· signed by CP" on the mere
   presence of a `signature` field** (`cp-identity.tsx:114`). It has no AITP SDK dependency
   at all (`package.json`). A verification claim shown to a human operator, backed by a
   truthiness check on a JSON key. Out of scope for this plan's phases, but it changes the
   Long-term posture argument and strengthens the Node half of Phase 5.

So the playground did not "absorb 0.5.0" — it is *indifferent* to the signing convention,
and #45 merging green proves the indifference rather than the compatibility.

### What that actually costs

The upside of the correction is that there is no live availability incident to chase; the
scenario works. The downside is worse than the one that was feared:

- **A trust boundary the docs claim exists, doesn't.** `docs/aitp-integration.md:67` states
  "no envelope is parsed, canonicalized, or signed outside the SDK," and `:340` lists
  "Verify a signature" under *what you can ignore — the SDK should be doing it*. The
  revocation path parses an envelope outside the SDK and verifies nothing. The
  `revocation-via-cp` scenario text (`scenario.yaml`, step `revoke`) tells the reader the
  audience refreshes "from the **signed** `/.well-known/aitp-revocation-list`". The
  signature is decorative in this repo.
- **The deny-set is attacker-controllable to the extent the transport is.** Anything that
  can answer as the CP can *suppress* revocations (return `entries: []`) or *inject* them
  (DoS a live agent). RFC-AITP-0008's whole distribution model is that the snapshot's
  signature is what makes an untrusted fetch safe. `agent_admin.py:634` [F] even sends a
  `Bearer` token to a public endpoint — treating transport auth as the control, which it
  is not.
- **The unverified-manifest path decides *who a delegation is issued to*. [REV]** A peer
  that can answer at `delegatee_manifest_url` substitutes its own AID and receives the
  delegation, scope and all (`agent_admin.py:419-424`). Severity is comparable to the
  revocation hole and the fix is not blocked on anything — which is why Phase 2B is
  sequenced ahead of Phase 6 rather than filed as a follow-up.
- **This is a demo harness whose job is to be exemplary.** It is the reference for how an
  integrator wires AITP. Modelling "fetch the signed list, ignore the signature" is the
  more expensive failure precisely because it works.

The plan below therefore has **three** tracks that should not be conflated **[REV]**:
**make the convention observable** (an interlock, cheap, no upstream dependency — Phase 2);
**make the verification real where it already can be** (manifests — Phase 2B, unblocked,
because `verify_manifest_json` is bound today); and **make the verification real where it
cannot yet be** (revocation snapshots — Phase 6, blocked on an SDK binding that does not
exist). The draft collapsed the last two and, by doing so, put an unblocked security fix
behind an upstream dependency it does not have.

### One deliberate carve-out, stated up front

Phase 2 adds a verifier **written by hand, in test code, using `cryptography` + a local
JCS**. That is a direct exception to this repo's own boundary rule, and it is the correct
one: a test where the SDK both signs and verifies is circular — it passes under *any*
self-consistent convention, including a wrong one, which is exactly how the wrapped form
survived a full release upstream. The oracle must be independent of the thing under test.
The exception is narrow — **test code only, never `src/` or `agents/`** — and Phase 7
writes it into the boundary doc so it reads as a decision rather than a violation.

---

## Phases

### Phase 1 — Pin the SDK floor to the convention the repo actually ships

**Status:** DONE (2026-08-25, verifier Sonnet, 1 round, PASS)
**Depends on:** nothing
**Delivers:** `pyproject.toml` states a floor that matches the wire format in `uv.lock`, so
a 0.4.x resolution is a resolver error rather than a silent, signature-blind downgrade.

**Files:** `pyproject.toml`

**Approach.** Raise `"aitp-sdk>=0.4.0"` → `"aitp-sdk>=0.5.0"` and extend the existing
block comment (which already documents the 0.3.0 floor as "the compact-JWS SDK; the pre-0.3
wheels are wire-incompatible") with the same reasoning for 0.5.0: the JCS signing input
moved to the inner body, ≤0.4.x snapshots and bundles are wire-incompatible with ≥0.5.0,
and the floor is what records that. The comment is the right home because it is already the
place a reader looks for "why this floor".

**Rejected: an upper cap (`>=0.5.0,<0.6.0`).** It converts the next SDK major into a
`uv lock` resolution failure — a message about version ranges, at bump time, that says
nothing about signing conventions. Phases 2–4 make the same event fail as a named test with
a diagnostic. A cap also silently defeats the `bump-aitp` automation rather than exercising
it. Take the floor, get the diagnostic from the interlock. Reconsider only if Phase 5 stalls
indefinitely and the interlock never ships.

**[IMPL] Also fixed in this phase, unplanned:** the block comment claimed "Floor pinned to
0.3.0" while the dependency read `>=0.4.0` — a pre-existing drift confirmed against
`git show HEAD:pyproject.toml`. The rewritten comment records both real floors (0.3.0
compact-JWS, 0.5.0 inner-body) rather than layering a new one on a false one. Every factual
claim in it was checked against `aitp-rs/CHANGELOG.md`, including "No dual-accept is
implemented" verbatim.

**Edge cases & failure modes.** `uv.lock` already resolves 0.5.0, so `uv sync --locked`
stays green and no lockfile churn is expected — if the lock *does* change, that is a signal
worth reading, not noise to commit past. The Docker build ignores `pyproject`'s floor
entirely (it installs the maturin-built wheel before `pip install -e .`), so this phase has
no effect on the e2e stack; that gap is Phase 3's problem, not this one's.

**Acceptance criteria.**
1. `pyproject.toml` reads `"aitp-sdk>=0.5.0"`.
2. The floor comment names the inner-body change and why ≤0.4.x is wire-incompatible.
3. ~~`uv sync --locked` succeeds with **no** modification to `uv.lock`.~~
   **[IMPL] This criterion was wrong and is superseded.** It is unsatisfiable together with
   criterion 1: `uv.lock` mirrors the *declared specifier string* in
   `[package.metadata].requires-dist`, so editing `pyproject.toml`'s specifier makes the lock
   stale by construction and `uv sync --locked` refuses until `uv lock` regenerates that one
   line. Reproduced during verification. The criterion that actually carries the intent:
   **`uv.lock`'s resolved `aitp-sdk` version does not move, and no other package's resolution
   changes** — verified byte-for-byte on the `[[package]] name = "aitp-sdk"` block
   (`0.5.0` before and after) with a 1-line total lock diff.
4. `uv run pytest` is green; `uv run ruff check src agents tests` is clean.

**Tests.** No new test — the assertion is the lockfile-consistency check in CI
(`ci.yml:53`, `uv sync --locked`).

**Docs.** None.

---

### Phase 2 — A signing-convention interlock in the fast unit suite

**Status:** DONE (2026-08-25, verifier Fable, 1 round, PASS)
**Depends on:** Phase 1
**Delivers:** A test that fails, by name, on **every PR** if the installed `aitp-sdk` moves
its revocation signing input again. This is the interlock issue #46 asks for, at a tier
that needs no control plane, no Docker, and no network.

**Files:** `tests/unit/test_revocation_signing_convention.py` (new)

**Approach.** The Python SDK *can* mint (`AitpAgent.sign_revocation_list(entries,
expires_in_secs) -> str`, `aitp.pyi:163`) even though it cannot verify. So:

1. `aitp.AitpAgent.generate()`, then `sign_revocation_list([...])` → parse the envelope JSON.
2. Recover the issuer's raw Ed25519 public key from the `aid:pubkey:` AID in
   `envelope["revocation_list"]["issuer"]` and load it with `cryptography` (already a base
   dependency, `pyproject.toml`). **[F — corrected: there is no `did:aitp:` scheme.** AIDs
   are `aid:pubkey:<43-char-b64url>` (Ed25519 implicit) or the tagged
   `aid:pubkey:ed25519:`/`p256:` forms (`aitp-rs/crates/aitp-core/src/aid.rs:17-21`); the
   committed vector's issuer is the legacy form
   (`tests/schemas/known-answer/signed-examples/revocation/kat-keypair-001-snapshot.json:16`).]
3. Assert **both halves**, mirroring `aitp-rs`'s
   `served_snapshot_signature_is_over_the_inner_body_not_the_wrapper` and the control
   plane's `SIGNING_INPUTS.innerBody` / `.wrapped` pair:
   - `verify(sig, sha256(jcs(env["revocation_list"])))` → **succeeds**
   - `verify(sig, sha256(jcs({"revocation_list": env["revocation_list"]})))` → **fails**
   - **[REV]** `verify(sig, sha256(jcs({**env["revocation_list"], "signature": env["signature"]})))`
     → **fails** — the signature is never a member of its own signing input. Added from the
     shared criteria in "Adjacent in-flight work": `aitp-verifier-py#12` is the live proof
     that a canonicalize-the-body line can be correct *by accident* right up until a
     `signature` member moves into that body. Revocation keeps `signature` as a **sibling**
     (RFC-AITP-0001 §5.4.1), so this assertion is what pins that it stays one.
4. Name both shapes explicitly (a `SIGNING_INPUTS`-style mapping, not an inline expression).
   The wrapped form is not dead code — it is the shape being *excluded*, and an exclusion
   nobody writes down silently stops being tested.

The JCS canonicalizer: **copy `aitp_verifier/jcs.py` into the test module's own helper**
rather than importing it. It is 189 lines of RFC 8785 [F — the draft said ~40; the ECMA
number-serialization half is the bulk, and the copy is priced at its real size in Long-term
posture], `aitp-verifier` is not installable
from PyPI (404), and a git/path dependency on a sibling checkout would make the unit suite
depend on a repo that is not checked out in `ci.yml`'s runner. Carry the provenance in a
comment. Revisit if `aitp-verifier` is ever published.

**Rejected: verifying with the SDK.** Circular, as argued in Context — it would pass under
the wrapped convention too, which is the exact failure being designed out.

**Rejected: making this an e2e test against a real CP.** That belongs in Phase 4 and answers
a different question (do issuer and verifier *agree*). This one answers "what does the
installed wheel emit", needs nothing running, and runs in the 1m44s CI job on every PR.
Both are wanted; this is the one that gates a bump PR.

**[F] Rejected: extending the interlock to session bundles — the *other* artifact 0.5.0
moved.** Considered and declined, with a revisit trigger. The bundle path is not analogous:
the playground's only bundle sites already route sign *and* verify through the SDK at one
place (`agent_admin.py:344` `aitp.verify_session_bundle`), no bundle ever crosses an
implementation boundary in this stack (the CP neither mints nor consumes them), and the
in-flight spec correction (`aitp-rs#89`, see Adjacent in-flight work) changes vendored
schemas/fixtures only — `SessionTrustBundle` already carries `signature` in the body
(`crates/aitp-session-bundle/src/types.rs:29`) and `SessionBundleEnvelope` has no sibling
slot (`:41-44`), so there is no pending wire flip to pin. Revisit the moment a bundle is
exchanged with a second implementation; until then the bundle half of a hand-rolled oracle
is weight without a failure mode to catch.

**Why this phase is load-bearing *today*, which the draft understated. [REV]** `ci.yml`'s
`test` job installs from PyPI via `uv sync --locked` and says so explicitly — "aitp-sdk
ships manylinux wheels on PyPI, so the full suite … runs here. No local Rust toolchain or
maturin build needed" (`ci.yml:50-53`). That job is therefore **the only place in the repo
that exercises the pinned wheel at all** while Phase 3 is outstanding, and it is the reason
criterion 6's mutation check (install `0.4.1`, watch it go red) is a two-command exercise
rather than a Docker rebuild. It also settles Q4: Phase 2 lands first because the tier it
lands in already works.

**Edge cases & failure modes.**
- **Non-vacuity is the whole point.** The negative assertion must be shown to discriminate,
  not merely to pass. Prove it during implementation by constructing a wrapped-form-signed
  envelope by hand (sign `sha256(jcs({"revocation_list": body}))` with a local key) and
  confirming the `wrapped` predicate returns `True` for it. Do not ship the negative
  assertion on the strength of reasoning alone.
- **Feature-gated wheels.** `sign_revocation_list` is on `AitpAgent` in the default build.
  If a `--no-default-features` wheel could lack it, guard with
  `pytest.importorskip`/`hasattr` in the style of `tests/unit/test_sdk_blocked_features.py:33`
  — but **skip loudly**, never silently, or the interlock quietly stops interlocking.
- **P-256 AIDs.** Scope to Ed25519 (what the CP issues, `CP_AID_SEED_HEX`). Note the
  limitation in the test docstring rather than half-supporting a suite that is not exercised.
- **`decode_tagged_signature` — RESOLVED, no tag handling needed in scope. [REV]**
  `Signature::algorithm` treats a `p256.` prefix as the *only* tag and defaults untagged to
  Ed25519 (`aitp-rs/crates/aitp-crypto/src/keys.rs:510-518`), and `sign_revocation_list`
  emits `sig.into_string()` verbatim (`crates/aitp-tct/src/revocation.rs:103`). So an
  Ed25519 envelope carries a **bare base64url** payload. Still assert the absence of a
  prefix rather than assuming it, so a future P-256 scope-widening fails loudly.

**HARD CONSTRAINT.** Every expected value is derived from the minted envelope. **No digest,
signature, or canonical byte string is ever pasted in from failure output.** Pinning program
output as the expected value is the bug class this entire effort exists to remove.

**Acceptance criteria.**
1. A test named for the property (e.g.
   `test_revocation_snapshot_signature_is_over_the_inner_body_not_the_wrapper`), so a
   regression names itself in CI output.
2. **[REV]** All **three** signing inputs are named constructs; the wrapped form and the
   self-inclusive form appear **only** as subjects of negative assertions.
3. The negative assertion is demonstrated non-vacuous (see Edge cases) and the
   demonstration is recorded in the PR description.
4. No hard-coded digests, signatures, or canonical bytes anywhere in the diff.
5. It runs in the default `uv run pytest` path — no marker, no env gate, no `AITP_*` flag.
6. **Mutation check:** with `aitp-sdk==0.4.1` installed, the test goes **RED**; restored to
   0.5.0 it goes **GREEN**. A test that cannot fail is the thing being fixed — run it, do
   not reason about it. Leave `uv.lock` clean afterwards.

**Tests.** This phase *is* the test. It must also not perturb `tests/unit/test_cp_client.py`
(which mocks transport and asserts parse shape only) — that file should be unchanged.

**[IMPL] What implementation revealed.**

1. **Criterion 6's mutation check silently no-ops the obvious way.** `uv run` re-syncs the
   venv to `uv.lock` before executing, so `uv pip install 'aitp-sdk==0.4.1' && uv run pytest`
   quietly tests **0.5.0** and reports green — the exact false-confidence failure this phase
   exists to remove, reproduced in the act of checking for it. Use
   `uv run --no-sync`. Restore with `uv sync --locked`.
2. **The empirical convention table** (probed under both wheels, not reasoned):
   `0.4.1 -> wrapped=True, inner_body=False`; `0.5.0 -> inner_body=True, wrapped=False`.
   The interlock discriminates the intended thing in both directions.
3. **`self_inclusive` cannot be shown non-vacuous by construction, and that is structural.**
   Firing it needs `sig = Sign(sha256(jcs(body ∪ {"signature": sig})))` — a fixed point no
   signer can produce. The plan's [REV] text implied the same by-construction proof as
   `wrapped`; it does not exist. Implemented instead as: a distinctness check across all
   three inputs (so no assertion aliases another), a `"signature" not in body` shape guard,
   and a test that records *why* the stronger proof is absent. The assertion remains
   worthwhile — it guards a convention change, not a forgeable artifact.
4. **The vendored canonicalizer is 201 lines**, stdlib-only, byte-identical to
   `aitp_verifier/jcs.py` below the provenance header (verified programmatically by the
   verifier, with `# ruff: noqa` confirmed to be hiding nothing).
5. **Accepted residual:** a `skipif` skip keeps CI green — `pytest -q` with no `-ra` shows
   `N skipped` and never prints the reason. "Loud" here means loud-when-read. Logged in
   `ASSUMPTIONS.md`; a CI-failing guard would be a different design than the plan chose.

**Docs.** None yet; Phase 7 records the boundary carve-out once the shape is settled.

---

### Phase 2B — Verify peer manifests at both ingest sites [REV — new phase]

**Status:** DONE (shipped in `aitp-playground#47` / `3107e8f`; status corrected by the
**[R3]** refresh on 2026-08-27, which found it had been left at TODO).

**[R3] Evidence, checked against the tree.** Both ingest sites the phase named are covered,
through a shared `_verify_peer_manifest` helper rather than two call sites:
- Handshake: `agents/base/agent_admin.py:78` — `aitp.verify_manifest_json(envelope_json)`.
- Delegation: `agents/base/agent_admin.py:516` — `_verify_peer_manifest(r.text, …)` called
  **before** `delegatee_aid = delegatee_manifest["aid"]` is read, which is the ordering the
  phase insisted on. The in-code comment states the reason in the phase's own terms:
  *"Verify BEFORE reading the AID: this value is the delegation's recipient."*

Covered by `tests/unit/test_manifest_verification.py` (358 lines in #47, +67 in #50).
**Depends on:** nothing (deliberately not Phase 1 — it is orthogonal to the SDK floor)
**Delivers:** The playground stops trusting an unauthenticated fetch to tell it *who it is
delegating to*. This is the one real security fix in the whole plan that is **not blocked
on an upstream binding**, which is why it is sequenced here rather than after Phase 6.

**Files:** `agents/base/agent_admin.py` (both ingest sites — the handshake caller
`/admin/connect` at `:71-93` *and* the delegation site; **[F — corrected:** the prior list
named `aitp_server.py` as the handshake caller, but `aitp_server.py` never ingests a peer
manifest — it only serves the agent's own at `aitp_server.py:86-88`]),
`src/aitp_playground/trust/resolver.py` (see edge cases), `tests/unit/` (new test module)

**Approach.** Two call sites ingest a `ManifestEnvelope` and read `aid` out of it without
checking the signature:

1. `agent_admin.py:415-424` — fetches `delegatee_manifest_url`, takes
   `r.json()["manifest"]["aid"]`, and passes it to `agent.build_delegation(...)` as the
   delegatee. A peer that can answer at that URL substitutes its own AID and receives the
   delegation.
2. The handshake path (`agent_admin.py:85-93`) hands the raw `peer_manifest_json` to
   `session.build_hello(...)`. The SDK does **not** verify it — `build_hello` does
   `serde_json::from_str::<ManifestEnvelope>` and uses `peer_manifest.aid` directly
   (`aitp-rs/bindings/aitp-py/src/session.rs:161-165`). The mutual handshake does then
   force the peer to prove control of *that* AID, so the substitution is not silent at the
   crypto layer — but it is a substitution, and the manifest signature is what binds
   AID↔endpoint in the first place.

Call `aitp.verify_manifest_json(envelope_json)` (`aitp.pyi:206`; raises on failure) at both,
**before** any field is read out of the envelope. This is a pure addition — no new
dependency, no upstream ask, and it moves work *back* inside the SDK boundary rather than
carving another hole in it.

**Rejected: verifying only the delegation site.** The handshake site is where an integrator
reading this repo learns the pattern; leaving it blind teaches the wrong shape even though
the handshake happens to survive it.

**Rejected: bundling this into Phase 6.** Phase 6 is blocked on Phase 5 for an unknown
duration. Attaching an unblocked fix to a blocked phase is how it does not ship.

**Edge cases & failure modes.**
- **What `verify_manifest_json` actually checks.** It verifies the envelope's signature
  against the key embedded in the manifest's own `aid` — self-certifying, not
  trust-anchored. It proves the manifest was minted by the holder of that AID; it does
  **not** prove that AID is the peer you meant. For `did:web` resolution
  (`trust/resolver.py:33-51`), the binding to a *name* comes from the DID document, which
  is fetched over plain HTTP under `AITP_DIDWEB_INSECURE_HOSTS` in the federated stack.
  Say this in the docstring; do not let the phase read as more than it is.
- **[F] It also checks more than the signature: expiry.** The binding builds
  `VerifyManifestContext { now: Timestamp::now() }` (`bindings/aitp-py/src/manifest.rs:19-23`),
  so an *expired* peer manifest — previously ingested without complaint — now aborts the
  delegation/handshake too. Scenario agents mint fresh manifests, so happy paths are
  unaffected, but the rejection event must name expiry distinctly from a signature failure
  (the same fetch-vs-verify legibility discipline as Phase 6), and the binding takes no
  `now` override, so tests exercise expiry with a short-TTL minted manifest, not a mocked
  clock.
- **Failure behaviour.** A manifest that does not verify must abort the delegation/handshake
  with a 4xx naming the cause — not fall through to an unverified AID. Emit a distinct
  event so it cannot be read as a transport blip (same discipline as Phase 6's Observability
  requirement).
- **Existing fixtures.** Any test or scenario that hand-builds a manifest dict rather than
  minting one through the SDK will now fail. That is the interlock working; fix the
  fixtures to mint, do not relax the check.
- **`--no-default-features` wheels.** `verify_manifest_json` is unconditional in
  `bindings/aitp-py/src/manifest.rs` (not behind a Cargo feature), so no `hasattr` probe is
  needed — unlike `verify_delegation_multihop`.

**Acceptance criteria.**
1. Both ingest sites call `verify_manifest_json` before reading any envelope field.
2. A manifest signed by a key other than the one in its own `aid` → request rejected, named
   event emitted, **no delegation minted**. Demonstrated non-vacuous per Phase 2's
   discipline: mint a valid envelope, tamper one byte of `manifest`, watch it fail.
3. A tampered `aid` (so signature and embedded key disagree) → rejected.
4. The happy paths — `intra-org` delegation scenarios and the federated `did:web` stack —
   stay green with no fixture relaxation.
5. No canonicalization or signature check is hand-rolled; it routes through the SDK.

**Tests.** Unit: one module covering criteria 2–3 at both sites. Integration: existing
delegation + handshake e2e must stay green unmodified.

**Docs.** Folded into Phase 7 (`docs/aitp-integration.md:67` is false for this reason too).

---

### Phase 3 — Make the e2e stack — and the published image — use the pinned wheel [REV]

**Status:** DONE (2026-08-25, verifier Sonnet, 2 rounds, PASS)
**Depends on:** Phase 1
**Delivers:** Two things, and the second is the larger one. (a) The `docker-compose e2e`
stack runs the pinned `aitp-sdk`, so a pin/behaviour mismatch is observable at all — today
it is not, in either direction. (b) **The image published to GHCR stops embedding an
unpinned `aitp-rs@main` build. [REV]** `build-and-push` performs the same sibling checkout
(`docker.yml:46-50 [F]`) and pushes `:latest` on main (`:93` [F]), so the shipped container's SDK is
whatever `aitp-rs` happened to be at build time — unreleased, unpinned, unreproducible. The
Dockerfile change fixes both because both jobs share the Dockerfile; the draft treated this
as a test-fidelity phase only, and it is also a supply-chain-provenance phase.

**Files:** `Dockerfile`, `docker-compose.test.yml`, `.github/workflows/docker.yml`
(**both** the `build-and-push` and `e2e` jobs **[REV]**), `internal_docs/docker.md`,
`internal_docs/testing.md`

**Approach.** Give the SDK stage a mode switch (build arg, e.g. `AITP_SDK_SOURCE=pypi|path`)
and make **`pypi` the default for CI e2e**: install `aitp-sdk` resolved from `uv.lock`
instead of `maturin build`-ing `../aitp-rs`. Keep the `path` mode — building unreleased SDK
source is a real local-development need (`pyproject.toml`'s comment already documents the
`[tool.uv.sources]` override for exactly this) and `aitp-rs` may legitimately want to test
its own `main` against a live playground.

With `pypi` as the e2e default, the `Checkout sibling aitp-rs` step
(`.github/workflows/docker.yml:117`) becomes unnecessary for that path — dropping it removes
a cross-repo coupling *and* the Rust compile from e2e wall-clock. **[REV]** Apply the same
default to `build-and-push` and drop its sibling checkout (`docker.yml:46-50 [F]`) as well;
otherwise the published image keeps its unpinned SDK while only the test stack is fixed,
which is the worst of the three possible outcomes.

**Three preconditions the draft flagged as unknown are now checked — all clear. [REV]**
- *Wheel matrix.* PyPI serves `aitp_sdk-0.5.0-cp39-abi3-manylinux_2_17_x86_64.whl` (plus
  aarch64 and both macOS arches). `abi3-py39` covers the image's `python3.12` and `ci.yml`'s
  3.11/3.13 matrix. **No sdist fallback risk on `linux/amd64`** — but still fail the build
  loudly on a source fallback rather than compiling quietly, because that guard is what
  makes the next release's matrix regression visible.
- *Feature parity.* The PyPI wheel is built with **default** features
  (`aitp-rs/.github/workflows/aitp-py-release.yml:11`) and the Dockerfile runs plain
  `maturin build --release` (`Dockerfile:51`), also default
  (`renewal, session-bundle, spki-pinning, multihop-delegation`). `/capabilities` is
  identical across the two paths. Keep the before/after comparison in the acceptance
  criteria anyway — it costs one call and it is what will catch the day that stops being
  true.
- *Does `aitp-rs` depend on this path build?* **No.** The only aitp-rs→playground coupling
  in either repo is the post-publish `repository_dispatch` notify
  (`aitp-py-release.yml:134-160`); nothing in aitp-rs's CI builds or runs the playground.
  Dropping the sibling checkout costs aitp-rs zero coverage, so the `path` mode is retained
  for local development only, not to preserve an upstream guarantee.

**Why this is right, not merely convenient.** A test stack that cannot observe the version
under test is not a weaker interlock — it is a **misleading** one. It reports green about a
build nobody ships. That is worse than having no e2e job, because it is read as coverage.

**Rejected: leaving the source build and pinning `aitp-rs` by SHA.** Tests a different
artifact from the shipped one, and adds a second pin to keep in sync with `uv.lock`.

**Edge cases & failure modes.**
- **Wheel availability — RESOLVED for 0.5.0, keep the guard. [REV]** See the preconditions
  block above. Retain the loud-failure-on-source-fallback guard regardless; it is cheap and
  it is what makes a future matrix regression visible instead of silently reintroducing a
  Rust toolchain.
- **Feature parity — RESOLVED, keep the comparison. [REV]** Both paths are default-features.
  Still compare `/capabilities` across the switch: a scenario silently self-skipping because
  a feature vanished would look like a pass.
- **Image-tag semantics change under (b). [REV]** After this phase, `:latest` means "the
  pinned SDK", where before it meant "aitp-rs main as of build time". Anyone diagnosing
  against an older tag is looking at a different SDK than its `uv.lock` claims. Note it in
  `internal_docs/docker.md` alongside the mode switch.
- **Build cache.** The `--mount=type=cache` targets for the Rust build become dead weight on
  the `pypi` path; remove them from that branch.
- **Local-dev break.** Anyone running `docker compose -f docker-compose.test.yml up` expecting
  the sibling source build gets PyPI instead. Both `internal_docs/docker.md` and
  `internal_docs/testing.md` must state the switch and how to select `path`.

**Acceptance criteria.**
1. Default e2e build installs `aitp-sdk` at the `uv.lock`-resolved version.
2. The running container's `aitp.__version__` (or equivalent) is **asserted** to equal the
   locked version — printed logs are not an assertion.
3. `AITP_SDK_SOURCE=path` still builds from `../aitp-rs` and is documented.
4. The full `docker-compose.test.yml` stack passes on the `pypi` path, `revocation-via-cp`
   included.
5. `GET /capabilities` is unchanged between the two paths, or the difference is documented
   and deliberate.
6. No Rust toolchain is installed on the default e2e path.
7. **[REV]** `build-and-push` uses the `pypi` path too, and its sibling `aitp-rs` checkout
   (`docker.yml:46-50 [F]`) is removed. The pushed image's `aitp.__version__` equals `uv.lock`'s
   resolved version — asserted, not logged.
8. **[REV]** Rebuilding the same commit twice yields the same SDK version. Today it does not,
   and that is the defect this criterion retires.

**[IMPL] What implementation revealed.**

1. **A regression this phase introduced, caught in verification.** Dropping the sibling
   `aitp-rs` checkout is correct for `build-and-push` but **wrong for `e2e`**:
   `Dockerfile.cp-e2e:46-48` compiles the **control plane's** own napi binding from
   `aitp-rs` source — a dependency entirely separate from the playground's SDK, because the
   CP repo checks in only a `darwin-arm64` `.node`. Removing it would have failed the
   `aitp-cp` image in CI. Local testing could not see this: `aitp-rs` exists on disk here
   regardless of what CI checks out. Restored to `e2e` only.
2. **`aitp-cp` is a symlink to `aitp-control-plane`.** Switching branches in one changes the
   control plane the e2e stack builds. CI has no such coupling (fresh checkout per path).
3. **Criterion 4 is unverifiable on an arm64 host** — the CP image fails to build with
   `bindings.lockfileTryAcquireSync is not a function` (a Next.js/`@next/swc` native-binding
   fault), reproduced with `--no-cache`, before the playground image is reached. Tracked as
   `PENDING.md` P5; CI runs it on `linux/amd64`.
4. **`aitp` exposes no `__version__`.** The plan's criterion 2 said "`aitp.__version__` (or
   equivalent)" — the equivalent is `importlib.metadata.version("aitp-sdk")`, which
   `/capabilities` already reports.
5. **Verified empirically against real images:** pinned wheel installed (`0.5.0`, matching
   `uv.lock`); `/capabilities` **byte-identical** across `pypi` and `path` builds; `path`
   still compiles; no `cargo`/`rustc`/`maturin` on the default path.

**Tests.** Existing `tests/integration/test_protocol_e2e.py` must stay green. Add the
version assertion from criterion 2 as a real check (extend
`_check_revocation_via_cp`-adjacent setup, or a dedicated `test_sdk_version_matches_lock`).

**Docs.** `internal_docs/docker.md`, `internal_docs/testing.md`.

---

### Phase 4 — Run the e2e stack pre-merge on SDK-bump PRs

**Status:** DONE (2026-08-25, verifier Sonnet, PASS with criterion 4 deferred)
**Depends on:** Phase 3 (running e2e on a PR is only meaningful once it tests the pinned wheel)
**Delivers:** The cross-implementation check runs **before** an SDK bump merges, not after.

**Files:** `.github/workflows/docker.yml`

**Approach.** The `e2e` job is currently `if: github.event_name == 'push' && github.ref ==
'refs/heads/main'` (`docker.yml:106`) — deliberate, since the stack is expensive and most PRs
do not need it. Widen the condition to also fire on a pull request that touches the SDK pin:
either `dorny/paths-filter` on `uv.lock`/`pyproject.toml` (the pattern `aitp-rs` already
uses in its own CI) or a branch-name match on what `aitp-ci`'s `bump-consume` opens. Prefer
the paths-filter — it also catches a hand-edited pin, and does not depend on a branch naming
convention owned by another repo.

**Why it matters here specifically.** `auto-merge.yml` runs on `pull_request` and delegates
to `aitp-ci`'s shared auto-merge. A bump PR that is green **auto-merges unattended**. The
only reason the issuer half did not roll unnoticed is that the control plane happened to have
a red integration test. Post-merge e2e detects; **pre-merge e2e prevents** — and with
auto-merge armed, detection lands after the change is already on `main`.

**Edge cases & failure modes.**
- **Cost.** The stack is ~6 minutes and pulls two sibling repos. Scope the trigger tightly to
  pin changes; do not widen it to all PRs.
- **Fork PRs.** The e2e job reads `secrets.OPENAI_API_KEY` (`docker.yml:145`). On a fork PR
  the secret is absent — already handled (LLM tests self-skip, protocol e2e still runs), but
  confirm the *job* does not hard-fail on the missing secret.
- **Do not let this become a merge deadlock.** If the CP half of a coordinated flip has not
  shipped, this job goes red for a correct reason. That is the design — but the failure
  message must say so, or someone will disable the job instead of sequencing the rollout.
- **Auto-merge interaction.** Confirm the widened job is actually a *required* check for
  auto-merge; a green-but-not-required job blocks nothing.

**Acceptance criteria.**
1. A PR touching `uv.lock` or `pyproject.toml` runs `docker-compose e2e`.
2. A PR touching neither does **not** (verify on an unrelated PR — a job that always runs is
   a cost regression, not a win).
3. Pushes to `main` still run it, unchanged.
4. The job is required for auto-merge on bump PRs, demonstrated rather than assumed.

**Tests.** CI-configuration change; the evidence is observed job behaviour on a real PR of
each kind, recorded in the PR description.

**[IMPL] What implementation revealed.**

1. **Criterion 4 is unmet and cannot be met from inside this diff.** `docker-compose e2e` is
   absent from `main`'s required status checks (only lint, the two test matrices, and
   integration are), so the widened job runs pre-merge and blocks nothing. Adding it is a
   repo-wide branch-protection change affecting every contributor — recorded as `PENDING.md`
   P7 with the reproduction and the skipped-vs-required trap, not silently applied.
2. **The filter should be `uv.lock` alone, not `uv.lock` + `pyproject.toml`.** Phase 1
   established that uv mirrors the declared specifier into `[package.metadata].requires-dist`,
   so *any* dependency edit necessarily moves `uv.lock`. Adding `pyproject.toml` buys nothing
   and costs a ~6-minute two-checkout job on every `[tool.ruff]` or LLM-extras bump — the cost
   regression criterion 2 exists to prevent.
3. **`needs:` on a filter job silently weakens the push path.** Gating `e2e` on `changes`
   means a transient failure of the filter turns into "e2e did not run on main". `always()`
   in the condition restores independence.

**Docs.** `internal_docs/testing.md` — when e2e runs and why.

---

### Phase 5 — Bind `verify_revocation_list` in the Python and Node SDKs [REV — rewritten]

**Status:** DONE (2026-08-25, verifier Fable, 2 rounds, PASS). Implemented in `aitp-rs` on
`feat/bind-verify-revocation-list`.
**Depends on:** nothing
**Delivers:** The prerequisite for Phase 6, and — independently of this plan — the missing
half of a Tier C conformance operation in two shipped SDKs.

**Files (all in `aitp-rs`):** `crates/aitp-tct/src/revocation.rs`,
`bindings/aitp-py/src/revocation.rs`, `bindings/aitp-py/src/lib.rs`,
`bindings/aitp-py/aitp.pyi`, `bindings/aitp-node/src/tct.rs` (or a new `revocation.rs`),
`bindings/aitp-node/index.d.ts`, `CHANGELOG.md`. **None in `aitp-playground`.**

**[REV] Why this stopped being an issue-to-file.** The original draft treated `aitp-rs` as an
upstream third party — "open an issue; do not implement here". That framing does not survive
contact with two facts:

1. **The same person owns `aitp-rs`.** Filing an issue against yourself is a TODO with
   ceremony. The cross-repo rule this plan follows is about where *plans* live, not about
   pretending a sibling checkout is someone else's project.
2. **It is not a feature request — it is a conformance gap.** `verify_revocation_snapshot`
   is a **Tier C conformance operation** (`aitp-rs/docs/conformance.md:129`), implemented by
   the reference adapter (`crates/aitp-rs-adapter/src/lib.rs:162`, advertised at `:209`). The
   spec's own schema says conformant implementations "MUST verify as committed, without
   re-minting" against `known-answer/signed-examples/revocation/`
   (`tests/schemas/aitp-revocation-list.schema.json:69`). The Rust library can do this. The
   Python and Node SDKs cannot. **Any** Python or Node consumer of AITP revocation is
   therefore structurally unable to be a conformant verifier — the playground is one
   instance, not the reason.

Shipping `sign_revocation_list` in both bindings without its verify half is a library defect
on its own terms. Phase 6 is the beneficiary, not the justification.

**Approach.** Four changes, all additive except one error-classification fix.

1. **Bind `verify_revocation_list` (Python).** `bindings/aitp-py/src/revocation.rs` already
   carries the hard part — `parse_entries` and the body/envelope construction for the sign
   path. The verify side is: deserialize `RevocationListEnvelope` from JSON, parse
   `expected_issuer` into an `Aid`, build `VerifyRevocationListContext::new(&aid, now)`,
   call through, map the error. Accept an optional `now_unix_secs` for testability, matching
   `verify_session_bundle`'s existing shape (`index.d.ts:86`).
2. **Node parity**, same surface. Sign currently lives in `agent.rs:381`; verify is a free
   function, so it belongs in `tct.rs` or a new `revocation.rs` alongside
   `verifySessionBundle`.
3. **Fix the error classification — one line, and the variant already exists. [REV]** An
   earlier revision of this plan claimed upstream needed a *new* `IssuerMismatch` variant.
   **That was wrong.** `TctError::IssuerMismatch` exists and is documented for exactly this
   case — "RFC-AITP-0008 §3.3 requires verifiers to establish this issuer-key binding before
   consulting any revocation source" (`crates/aitp-tct/src/error.rs:12-19`).
   `verify_revocation_list` simply returns the wrong one: `TctError::CnfMalformed` at
   `revocation.rs:128`, under a comment reading "chosen rather than introducing a new error
   variant for v0.1" — stale, since `IssuerMismatch` was added later for TCTs. Return
   `IssuerMismatch` and delete the comment. `TctError` is `#[non_exhaustive]`
   (`error.rs:5`), so nothing about this is breaking for downstream matchers.
4. **Give the binding a machine-readable failure cause.** Phase 6's `cause` field needs
   `signature_invalid | issuer_mismatch | version_unknown | expired | malformed` to be
   recoverable *without* string-matching exception messages — the pin-the-program-output
   anti-pattern Phase 2's HARD CONSTRAINT bans. The Python binding registers **no exception
   classes at all** today (`bindings/aitp-py/src/lib.rs:38-60`); everything is a
   `PyValueError`/`PyRuntimeError` carrying a formatted string. Introduce one exception via
   `create_exception!` with a stable `.code` attribute and **scope it to this function** —
   do not rewrite the binding's whole error surface in this phase. Node: throw an `Error`
   carrying a `code` property.

**Optional, cheap, worth doing:** bind `revocation_signing_bytes` too. It was added in 0.5.0
precisely so "callers needing the exact signed bytes do not reconstruct the shape themselves"
(`CHANGELOG.md`), and the callers who most need it — independent verifiers, the console —
are on the far side of a binding that does not exist.

**Decided: do NOT add a staleness knob to the Rust context. [REV]** The draft assumed binding
`verify_revocation_list` means "deciding the Python surface for staleness policy". There is
no staleness policy upstream to bind: `VerifyRevocationListContext` is exactly
`{expected_issuer, now}` (`revocation.rs:150-166`), and verify checks `expires_at` while
**never reading `published_at`** (`:124-130`). That is correct and should stay correct —
RFC-AITP-0008 puts freshness policy at the consuming peer, and `aitp_verifier`'s collapsed
single `fail_mode` switch is the cautionary tale D1 rejects. **Document it instead**: state
in the binding docstring and `aitp.pyi` that verify establishes authenticity and non-expiry
only, and that `published_at` staleness is the caller's. Zero code; it makes Phase 6's Axis B
a deliberate division of labour rather than a gap someone later "fixes" by collapsing.

**Node parity is not a nicety.** `aitp-ui-console` is a *third* blind consumer
(`use-trust.ts:130`, `cp-identity.tsx:33`) that renders "signed by CP" off a truthiness check
on the `signature` key (`cp-identity.tsx:114`) and carries no AITP dependency at all. It is
the strongest available evidence that the missing binding — not repo-level carelessness — is
the cause, and it is the consumer the Node half would actually unblock.

**Sizing, from reading the code.** Python verify ~40 lines (helpers exist); Node ~40; the
error fix 1 line plus a stale comment; the exception class ~15 lines including registration;
`revocation_signing_bytes` ~10; staleness zero. One PR, roughly a day.

**Rejected: hand-rolling verification in `aitp-playground/src/`.** It would put a third
hand-rolled JCS canonicalizer into the family, in *production* code, in the repo whose entire
purpose is to model correct integration — and it would leave the SDK defect in place for
every other consumer. Phase 2's test-only carve-out is narrow by design and does not extend
here.

**Rejected: publishing `aitp-verifier` to PyPI and depending on it.** It is an independent
conformance oracle; making it a production dependency destroys the independence that makes it
useful as an oracle, and it is 404 on PyPI today.

**Sequencing: build it in parallel, do not gate on it. [REV]** Phases 2, 2B and 3 all ship
without this. Phase 6 picks it up when it lands. Starting it early matters because it is the
long pole, not because anything else waits on it.

**Edge cases & failure modes.**
- **`VerifyRevocationListContext` is `#[non_exhaustive]` with a `::new()` constructor**, so
  future knobs stay additive — that is exactly why declining the staleness knob now costs
  nothing later.
- **`aitp_verifier.revocation.verify_revocation_snapshot`** is the semantic reference for
  *which checks* to run — **not** for its policy shape. Its single `fail_mode` collapses
  authenticity and freshness, and under `soft_fail` reports a *forged* snapshot as
  not-revoked (`aitp-verifier-py/aitp_verifier/revocation.py:42-44`). Do not reproduce that
  collapse in the binding; D1 rejects it, and a binding that hard-codes it would force the
  playground to push back rather than absorb it.
- **Version check ordering.** `verify_revocation_list` checks `version != PROTOCOL_VERSION`
  first (`:121-123`), so a `version_unknown` cause preempts signature checking. That is the
  right order; make sure the bound cause reflects it rather than reporting
  `signature_invalid` for a version mismatch.
- **Feature gating.** Keep verify ungated, as sign is — a `--no-default-features` wheel that
  can sign but not verify would recreate this exact asymmetry in miniature.

**Acceptance criteria.**
1. `aitp.verify_revocation_list(envelope_json, expected_issuer_aid, now_unix_secs=None)`
   exists in the Python SDK and is declared in `aitp.pyi`; the Node equivalent exists and is
   declared in `index.d.ts`.
2. A snapshot signed over the **wrapped** form is **rejected** by both bindings; the
   inner-body form verifies. (Same innerBody/wrapped pair as Phase 2 — the assertion the
   whole family lacked.)
3. Each of `signature_invalid | issuer_mismatch | version_unknown | expired | malformed` is
   recoverable from the raised error **without parsing its message**, in both bindings.
4. Issuer mismatch reports `issuer_mismatch`, not `malformed` — i.e. `revocation.rs:128`
   returns `TctError::IssuerMismatch`, with a Rust unit test pinning it.
5. Both bindings verify the committed vector at
   `tests/schemas/known-answer/signed-examples/revocation/` **as committed, without
   re-minting** — the conformance requirement that motivated the phase.
6. The docstring and `aitp.pyi` state that verify covers authenticity and `expires_at` only,
   and that `published_at` staleness belongs to the caller.
7. `CHANGELOG.md` records the addition and the error-classification fix.

**Tests.** Rust: a unit test pinning criterion 4. Bindings: the Python and Node test suites
each gain the criterion-2 pair and the criterion-5 committed-vector check. Do **not** satisfy
criterion 5 by minting with the same SDK and verifying it back — that is the circularity
Phase 2's Context section is about, and it is what let the 0.5.0 divergence ship.

**[IMPL] What implementation revealed.**

1. **Node's cause channel was wrong on the first pass, in the exact way this phase exists to
   prevent.** `Error::new(Status::GenericFailure, format!("{code}: {message}"))` makes
   `error.code` **always** `"GenericFailure"` — the cause was recoverable only by parsing
   `error.message`, i.e. the binding shipped the anti-pattern it was written to remove, with
   a code comment claiming otherwise. Fixed with `Env::throw_error(&msg, Some(code))` +
   `Status::PendingException`. Verified live: `err.code` is now the cause and the message
   carries no prefix.
2. **`TctError::IssuerMismatch` already existed** (`crates/aitp-tct/src/error.rs`) — the plan's
   earlier claim that a new variant was needed was wrong. One-line fix at `revocation.rs:134`.
3. **One emitted value did move.** The conformance adapter maps through `tct_error_code`, so a
   revocation issuer mismatch now reports `TCT_SIGNATURE_INVALID` instead of
   `INVALID_ENVELOPE`. No fixture pins it (`rev-001`..`rev-004` cover staleness, soft-fail,
   success, ordering), but "matching callers are unaffected" was too strong and the CHANGELOG
   now says so.
4. **pyo3 0.22's `create_exception!` trips `unexpected_cfgs`**, which fails CI's
   `clippy -D warnings`. Scoped an `#[allow]` to a private module rather than loosening the
   lint crate-wide.
5. **`aitp-example-two-agents::demo_runs_end_to_end` is flaky** — it binds port `:0`, drops the
   listeners, then rebinds in child processes (TOCTOU) with a fixed 300ms sleep. Pre-existing,
   unrelated to this phase; noted so the next red run is not misdiagnosed.

**Docs.** `bindings/aitp-py/aitp.pyi`, `bindings/aitp-node/index.d.ts`, `CHANGELOG.md`. Note
in `docs/conformance.md` that the bindings now cover the `verify_revocation_snapshot`
operation, if that table tracks binding coverage.

---

### Phase 6 — Verify the snapshot in the production revocation path

**Status:** DONE (2026-08-26, verifier Fable, both axes). Axis A `43bfffe`, Axis B
`94a4826`, floor bump `037ae5f`. 490 tests pass with zero skips against `aitp-sdk` 0.6.0.
**Depends on:** Phase 5 (SDK binding), Phase 2 (the convention interlock lands first)
**Delivers:** The playground actually enforces RFC-AITP-0008's trust model, per Decision D1:
an unverifiable snapshot is *discarded* — never applied, never trusted — and the absence of
a fresh snapshot is handled `fail_closed` under an explicit staleness budget. The deny-set
stops being transport-trusting.

**Files:** `src/aitp_playground/cp_client/client.py`, `agents/base/agent_admin.py`,
`agents/base/aitp_server.py`, `src/aitp_playground/config.py`,
`tests/unit/test_cp_client.py`, `tests/integration/test_protocol_e2e.py`,
**and [REV]** `src/aitp_playground/hosting/bootstrap.py`, `docker-compose.test.yml`,
`internal_docs/` env reference — see "Expected-issuer configuration" below: a `Settings`
field alone does not reach the agents.

**Approach.** Implements Decision D1's two axes. Read D1 first — the axes are not
interchangeable and the code must keep them separate.

**[REV] Prerequisite the draft assumed away: the deny-set is a monotonic union, not a
snapshot.** `agent_admin.py:657` does `revoked_jtis.add(jti_val)` into the *same* `set` that
local `/admin/revoke-tct` writes (`:499`) and that `aitp_server.py:334` enforces against.
Nothing is ever removed, and no snapshot metadata is retained. Three phrases in this phase
presuppose structure that does not exist:

- "*the previously verified snapshot stays current*" — there is no snapshot object to keep
  current. Introduce one: `{published_at, expires_at, entries}`, replaced wholesale on each
  successful verify, which is also what makes Axis B's freshness check possible at all.
- "*entries never merge*" — under a union, a discard is accidentally safe (nothing was going
  to be removed anyway), but it is safe for the wrong reason and stops being safe the moment
  snapshot semantics land. A snapshot is the issuer's *complete current* deny-set, not an
  increment.
- "*locally-revoked jtis are enforced in every snapshot state*" — only true if local and
  CP-derived revocations are **separate sets**, unioned at enforcement time. Today they are
  one set, so replacing it wholesale would silently drop local revocations.

This is the largest un-costed item in the phase and it touches shared state in
`aitp_server.py`, not just the two ingest sites the Approach names. Do it first; Axes A and B
are straightforward on top of it and unimplementable underneath it.

*Axis A — verify-or-discard at both ingest sites.* Route both signature-blind parses
(`client.py:206`, `agent_admin.py:606`) through the SDK's verify call, keyed on a pinned
expected-issuer AID. Any verification failure — bad signature, wrong issuer, unknown
`version`, malformed envelope, `expires_at` in the past — discards the snapshot outright:
the deny-set is not modified, the previously verified snapshot (if any) stays current, and a
new `revocation.verify_failed` event fires with a `cause` field
(`signature_invalid | issuer_mismatch | version_unknown | expired | malformed`). Transport
failure keeps the existing `revocation.refresh_failed` event; the two events never alias
(the Observability requirement). This axis has no mode knob — RFC-AITP-0008 §1.5's discard
is a MUST (`rfcs/RFC-AITP-0008-revocation.md:107`).

*Axis B — freshness policy.* On each successful verify, record the snapshot's
`published_at` and `expires_at`. New settings in `config.py` (`Settings`, pydantic):
`revocation_fail_mode: str = "fail_closed"` (the spec's schema default) and
`revocation_max_staleness_secs: int = 300` (the RFC §3 example value; the timing envelope
below is why it holds in this stack). Add a background refresh task (cadence
`revocation_poll_secs`, default 60) for agents with a CP configured — RFC §1.4 says a
consuming peer SHOULD poll, and without a cadence a staleness deadline is either meaningless
or a time bomb for long-running scenarios. Enforcement (`aitp_server.py:334` area): when a
CP is configured and the last verified snapshot is stale — `now - published_at >
max_staleness_secs`, or `now >= expires_at` — `fail_closed` rejects presented TCTs with a
403 whose detail names the degraded revocation state (distinct from a deny-list hit);
`soft_fail` (explicit opt-in) keeps serving from the last verified deny-set and emits a
degraded-state event — RFC §3.1 requires the degraded state to be logged. Locally-revoked
jtis (`/admin/revoke-tct`) are enforced in every snapshot state; they never depend on the CP.

*No CP configured* (`revocation-demo`, or `CP_BASE_URL` unset): local-only deny-set, which
is the family's explicitly-named unchecked posture
(`accept_unchecked_revocation_dangerous`, `bindings/aitp-node/src/tct.rs:110`). Log it once
at startup so it reads as a decision, not an accident.

`aitp_verifier.revocation.verify_revocation_snapshot` remains the semantic reference for the
individual checks (issuer, signature, freshness) — but **not** for its policy shape: its
single `fail_mode` collapses both axes, and under `soft_fail` it reports a *forged* snapshot
as not-revoked (`aitp_verifier/revocation.py:42-44`). Do not copy that collapse; see D1.

**Edge cases & failure modes.**
- **Expected-issuer configuration.** Verification without a pinned expected issuer is
  near-worthless — any key can sign a list. The playground must learn the CP's AID (settings,
  or the CP manifest at bootstrap). **This is the substantive design work of the phase**, not
  a detail: it is the difference between checking a signature and checking the *right*
  signature. Discovery without pinning reintroduces the hole in a new shape (Long-term
  posture).

  **[REV] It is also more plumbing than `config.py` suggests.** There is no `cp_aid` setting
  today (`config.py` has `cp_base_url` and `cp_api_key` only), and agents are **separate
  processes** that read CP config from `bootstrap["cp"]`, written by
  `hosting/bootstrap.py:39-43` from `Settings` at spawn time — `agent_admin.py:624-629`
  reads it from there, never from `Settings`. So the pin must be threaded
  `Settings → cp_block → bootstrap → agent_admin`, plus the compose env
  (`docker-compose.test.yml`) and the env reference in `internal_docs/`. The CP side is
  cooperative: it serves `/.well-known/aitp-manifest` carrying its AID, and `CP_AID_SEED_HEX`
  makes that AID deterministic in compose — so the demo can pin a known value rather than
  trusting first use.
- **[REV] `cp_base_url` is caller-supplied, and that must not extend to the pin.**
  `/admin/refresh-revocations` accepts `cp_base_url` (and `cp_api_key`) **from the request
  body** (`agent_admin.py:624-629`), falling back to bootstrap. Today that is an
  arbitrary-URL fetch whose result lands directly in the deny-set. After this phase, the URL
  may stay overridable but the **expected-issuer AID must not be** — a body-supplied pin
  turns verification back into a formality and reintroduces exactly the hole being closed.
  Same for `/admin/enroll-with-cp`'s override (`:528`). State it as a rule, and test it.
- **[REV] Cause fidelity is only as good as Phase 5's error surface.** Criteria 1–4 below
  each name a distinct `cause`, and both prerequisites live in Phase 5: the Python binding
  has no typed exceptions (`bindings/aitp-py/src/lib.rs:38-60`), and `verify_revocation_list`
  reports an issuer mismatch as `TctError::CnfMalformed`
  (`crates/aitp-tct/src/revocation.rs:128`) even though `IssuerMismatch` exists
  (`error.rs:12-19`). If Phase 5 lands with only the verify binding and neither fix, **do
  not** recover causes by string-matching exception messages — collapse to the causes that
  are honestly distinguishable, say so in the event schema, and keep Phase 5's remainder
  open. A `cause` field that guesses is worse than one that abstains.
- **Timing envelope for the staleness budget.** The CP re-signs at most every 60s
  (`producer.ts:43` [F]), so a served snapshot's `published_at` can already be ~60s old; the
  poll cadence adds up to another 60s; same-host container skew is small but nonzero. A 300s
  budget covers 60+60+skew with better than 2x margin, and the signed `expires_at` defaults
  to 3600s (`config.ts:33`), so expiry is never the binding constraint in the demo. The
  compose healthcheck worst cases (`docker-compose.test.yml`: CP 5s interval × 30 retries +
  15s start_period) are start-up serialization, not mid-run outages — scenarios begin only
  after the CP is healthy, so `fail_closed` does not convert stack start-up into flake.
- **A CP DB outage looks like "nothing revoked" — by the CP's choice.** `producer.ts`
  publishes an empty *signed* list when its DB read fails. That snapshot verifies, and the
  playground MUST accept it — an empty verified list is a meaningful assertion (RFC §1.5,
  "Empty lists are signed"). The suppression window there is the CP's to own; do not "fix"
  it playground-side by treating empty entries as suspect.
- **Envelope-tolerant parsing becomes a liability.** `client.py:232`'s
  `data.get("revocation_list") or data` fallback exists so "small CP shape changes don't
  break the demo" (`docs/control-plane.md:198`). Once the signature is checked, that
  tolerance is a downgrade path. Tighten the parse to the exact §1.5 envelope in the same
  commit; a wrapper-less response is `malformed`, not a second accepted shape.
- **Poll-loop telemetry discipline.** A 60s poll against a down CP is one
  `revocation.refresh_failed` per minute per agent. Emit on state *change* (ok→failing,
  failing→ok) plus a low-frequency heartbeat, or the stream drowns the one
  `verify_failed` that matters.
- **Rollout ordering, again.** Turning on verification makes the playground a real verifier
  for the first time — from that point on, the issuer/verifier rollout window described in
  issue #46 becomes genuinely load-bearing. Phase 4's pre-merge gate should be in place first.

**Acceptance criteria.** (Causes per D1; each asserted separately, at both ingest sites, and
each negative case demonstrated non-vacuous per the Phase 2 discipline.)
1. Tampered `entries` (valid envelope shape, modified body) → discarded,
   `revocation.verify_failed` with `cause=signature_invalid`, deny-set unchanged.
2. An envelope signed over the **wrapped** form → discarded, `cause=signature_invalid`.
3. An envelope correctly self-signed by a *different* key than the pinned CP AID →
   discarded, `cause=issuer_mismatch` — proving the issuer pin does work beyond the
   signature check.
4. `expires_at` in the past → discarded, `cause=expired`; previously verified entries remain
   enforced.
5. Unfetchable CP → `revocation.refresh_failed` only, never `verify_failed`; within the
   staleness budget, capability calls behave exactly as before the outage.
6. Beyond the staleness budget under `fail_closed` (default): presented TCTs get 403 with a
   degraded-state detail distinct from a deny-list hit. Under `soft_fail` (explicitly set):
   calls proceed on the last verified deny-set and a degraded-state event is emitted. Drive
   the clock or shrink the budget in-test; do not sleep.
7. `soft_fail` never applies to Axis A: with `revocation_fail_mode=soft_fail`, a forged
   snapshot is still discarded and its entries never merge — the assertion that keeps the
   axes separate.
8. Local revocations keep enforcing in every snapshot state, degraded included.
9. `intra-org/revocation-via-cp` passes end-to-end against a real CP with verification on
   and default settings.
10. No canonicalization or signature verification is hand-rolled in `src/` or `agents/` — it
    routes through the SDK. (Test code keeps its Phase-2 carve-out.)
11. **[REV]** CP-derived and locally-revoked jtis are held in **separate** sets, unioned at
    enforcement. A verified snapshot **replaces** the CP set wholesale — assert that a jti
    present in snapshot N and absent from N+1 stops being CP-denied, while a locally-revoked
    jti survives both. This is the criterion that proves the union was actually decomposed
    rather than left in place.
12. **[REV]** A body-supplied `cp_base_url` pointing at an attacker-controlled endpoint that
    serves a well-formed, correctly self-signed snapshot is **rejected** with
    `cause=issuer_mismatch` (or the honest collapsed cause per the Phase 5 caveat) and does
    not modify the deny-set. The expected-issuer AID is not overridable from the request body.

**Tests.** Unit: one test per acceptance cause, at both call sites; forged inputs are minted
with the Phase 2 test-only signer, never pasted from output. Integration:
`test_protocol_e2e.py::_check_revocation_via_cp` extended to assert that
`revocation.list_fetched` now carries `verified: true` and the pinned issuer AID — the event
is the proof that verification ran, not merely that entries arrived.

**[IMPL] What implementation revealed — three of the plan's own statements were wrong.**

1. **"CP configured ⇒ `fail_closed` default" is too coarse.** Applied literally it rejects
   every capability call on any deployment that has not set `CP_AID` — which is every
   deployment at the moment the setting ships. The boundary is *`can_verify`*: a CP **and** a
   pinned issuer. "Verification was never configured" and "configured but currently stale"
   are different states, and only the second is degraded. A federated e2e test caught this,
   not review.
2. **But the SDK's capability must NOT be part of that boundary.** Folding
   `hasattr(aitp, "verify_revocation_list")` into `can_verify` silently downgrades a
   deployment that *did* opt in but runs an old wheel — a capability probe treated as
   consent, which is the posture this phase exists to remove. Pin set + old SDK ⇒ **degraded**.
3. **The poll must refresh after a short grace period** — not after a full interval (which
   leaves a `fail_closed` agent 403ing for `poll_secs` after start-up, making D1's
   "start-up is not flake" claim false) and not immediately (which connects to a socket
   uvicorn has not bound yet, because the loop refreshes via this agent's own admin route).

Also: an unrecognized `fail_mode` now fails closed — §3.1 requires an explicit opt-in for
availability-first behaviour, and a typo is not one. And `CP_AID` had to be pinned in
`docker-compose.test.yml` (derived from the stack's deterministic `CP_AID_SEED_HEX`), without
which the shipped stack runs unchecked and the CP half of `revocation-via-cp` goes quiet
rather than failing.

**Docs.** `docs/control-plane.md`, `docs/aitp-integration.md`.

---

### Phase 7 — Correct the docs that describe a boundary the code does not hold

**Status:** DONE (2026-08-25, verifier Opus, 2 rounds, PASS) — the corrective half shipped;
the "verification is real" claims for revocation still track Phase 6.
**Depends on:** Phase 2 for the carve-out; Phase 2B for the manifest half of the `:67`
correction **[REV]**; Phase 6 for the revocation half and the "verification is real" claims
**Delivers:** Docs that match the code, including the honest interim state.

**Files:** `docs/aitp-integration.md`, `docs/control-plane.md`,
`scenarios/intra-org/revocation-via-cp/1.0.0/scenario.yaml`

**Approach.** Three corrections, and they should not wait for Phase 6 — a doc that overstates
a security property is worse while the gap is open than after it closes:

1. `docs/aitp-integration.md:67` — "no envelope is parsed, canonicalized, or signed outside
   the SDK" is false today for **two** reasons, not one **[REV]**: the revocation envelope is
   parsed outside it (Phase 6), *and* the peer-manifest envelope is parsed outside it at the
   delegation and handshake sites (Phase 2B). Phase 2B makes half the sentence true on its
   own schedule; keep the caveat scoped to whichever half is still open rather than deleting
   it wholesale when the first one lands.
2. `docs/aitp-integration.md:340` — "Verify a signature" sits under *what you can ignore*.
   Add the Phase 2 carve-out: **test code may hand-roll a verifier, and must, when the SDK is
   the thing under test.** Without this the interlock reads as a violation and someone
   "fixes" it into circularity.
3. `scenario.yaml` (`revoke` step) and `docs/control-plane.md:116` describe the audience
   pulling "the **signed** list". True of what the CP emits; misleading about what the
   playground checks. Say what is verified, in the present tense, whichever phase is current.
4. **[REV]** Document what manifest verification does and does not establish once Phase 2B
   lands: `verify_manifest_json` proves the envelope was minted by the holder of the AID it
   embeds — self-certifying, not trust-anchored. It does not prove that AID is the peer you
   meant; for `did:web` that binding comes from the DID document, fetched over plain HTTP
   under `AITP_DIDWEB_INSECURE_HOSTS` in the federated stack
   (`trust/resolver.py:10-30`). Overstating this is the same failure as the sentence at `:67`.

**Edge cases & failure modes.** Interim wording must not read as a vulnerability
advertisement, nor bury the gap. Describe the property and its status — "the CP signs the
snapshot; the playground does not yet verify the signature (tracked in #46)" — and delete
the caveat when Phase 6 lands.

**Acceptance criteria.**
1. No doc claims a verification the code does not perform.
2. The boundary rule names the test-code exception and why it exists.
3. Scenario text matches observable behaviour.
4. Every interim caveat carries an issue reference so it is removable, not permanent.

**Tests.** None (docs).

**Docs.** This phase is the docs.

---

### Phase 8 — Close the second revocation ingest, in `src/` [R3 — new phase]

**Status:** TODO — the only outstanding work in this plan.
**Depends on:** nothing. Phase 5's binding shipped in 0.6.0 and the floor is already
`>=0.7.0`, so there is no upstream blocker.

**Delivers.** One story about snapshot trust in this repo instead of two contradictory ones.

**The finding.** Phase 6 verified *"the production revocation path"* — and it did, in
`agents/`. There is a **second** ingest, in `src/`, that Phase 6 never covered:

```
src/aitp_playground/cp_client/client.py:206   fetch_revocation_list()
    inner = data.get("revocation_list") or data      # :236 — signature never checked
```

Its docstring is explicit — *"**The signature is not checked** … the deny-set this populates
is only as trustworthy as the transport that delivered it (aitp-playground#46, PENDING.md
P8)"* — and **both references it defers to are now closed**: `#46` is CLOSED, and P8 is
struck through as *"CLOSED 2026-08-26 · Resolved by: aitp-sdk 0.6.0 published; floor raised;
both axes shipped"*. The comment points a reader at resolved tickets as the reason a hole is
still open.

**Severity: low today, and stating why matters more than the rating.** `fetch_revocation_list`
has **no production callers** — only `tests/unit/test_cp_client.py`. Verified by grep across
every `*.py` outside `.venv`. So this is not a live bypass of the deny-set; the enforcing
path is `agents/base/revocation_refresh.py`, which verifies.

That is exactly what makes it worth closing rather than noting. It is a method that *looks*
like the way to fetch revocations, sits in the client an integrator would reach for first,
and carries a docstring disclaiming verification on the authority of two closed tickets. It
becomes a real vulnerability on the day someone wires it up — and nothing in the repo would
flag that.

**Approach — decide which of two, do not do both.**

1. **Delete it.** Dead code whose only consumers are its own tests. The honest option if
   nothing is meant to call it. Cheapest, and removes the trap outright.
2. **Verify it**, matching `revocation_refresh.py`: call
   `aitp.verify_revocation_list(envelope_json, expected_issuer)` before reading `entries`,
   branch on the typed `.code` (0.6.0+), and discard on failure per RFC-AITP-0008 §1.5 —
   Axis A of Decision D1, unconditionally, with no `fail_mode` switch at this layer.

**Recommendation: (1), delete.** Two ingest paths for the same artifact is the condition
that produced this divergence in the first place, and `RevocationState` in `agents/` is
already the single place that owns snapshot trust. Re-verifying a second path preserves the
duplication that caused the problem. Choose (2) only if a caller is actually planned.

**Do NOT simply update the docstring.** Rewording it to cite the *current* state leaves the
hole and removes the marker pointing at it — strictly worse than today.

**Acceptance criteria.**
1. `grep -rn 'revocation_list' src/ --include='*.py'` returns either nothing, or only lines
   inside a verified path.
2. No docstring anywhere in `src/` or `agents/` states that a signature is unchecked. (This
   is the check that would have caught the drift: the claim outlived the condition.)
3. No reference to `aitp-playground#46` or `PENDING.md P8` survives as a *justification* —
   both are closed.
4. If (2) was chosen: a forged-envelope test proves the path rejects, mirroring
   `tests/unit/test_revocation_freshness.py:233`.
5. `uv run pytest` green; the e2e stack unaffected either way, since nothing calls it.

**Docs.** The boundary doc Phase 7 corrected names `agents/` as where snapshot trust lives.
Whichever option is taken, that statement becomes unambiguous rather than approximately
true.

---

## Long-term posture

**The real defect is upstream and structural.** Both SDK bindings expose
`sign_revocation_list`; neither exposes `verify_revocation_list`. **Three** independent repos
**[REV]** then did the locally-reasonable thing — `aitp-control-plane` hand-rolled a verifier
in a test, `aitp-playground` skipped verification entirely, and `aitp-ui-console` renders
"signed by CP" off the presence of a JSON key — and a signing-convention change crossed a
whole release family with one accidental interlock standing in its way. Phases 1–4 are the
right work regardless, but only Phase 5 removes the cause. **If exactly one phase ships, make
it Phase 5** — built, not filed, and built whole: the binding alone, without the
error-classification fix and the machine-readable cause, produces something Phase 6 cannot
build against. **[REV]**

**[REV] But Phase 5 is not the only unblocked security work, and the draft's ordering hid
that.** Phase 6 is the plan's real security deliverable and it sits behind an upstream
binding of unknown latency. **Phase 2B is comparable in severity — it decides who a
delegation is issued to — and is blocked on nothing**, because `verify_manifest_json` is
already bound. Recommended order: **2 → 2B → 3 → 5 (started in parallel) [F] → 4 → 6 → 7**.
Phase 2 is the cheapest interlock and runs in the tier that already works; 2B is the
cheapest real fix; 3 retires the unpinned published image; starting Phase 5's build early
[F — "5's issue" was left over from before its rewrite; there is no issue to file] matters
precisely because it is the long pole.

**One-way doors.**
- *Phase 1's floor* — reversible in one line.
- *Phase 3's default build source* — reversible, but it changes what "e2e passed" has meant
  historically. Say so in the PR; do not let old green runs be read as new coverage.
  **[REV]** It also changes what every published image tag means: before, `:latest` embedded
  `aitp-rs@main`-at-build-time; after, it embeds the pinned wheel. Old tags are not
  retroactively reproducible and should not be diagnosed against as if they were.
- *Phase 2B* **[REV]** — two-way in the code (one call, removable), but one-way in the
  fixtures: any test or scenario that hand-builds a manifest dict must start minting through
  the SDK, and that is the correct direction to be stuck in.
- *Phase 6's fail mode* — **decided in D1, and the door is narrower than feared.** The
  one-way half is the decomposition itself: unverifiable snapshots are discarded
  unconditionally (a spec MUST), and the shipped default for a missing fresh snapshot is
  `fail_closed` (the spec's schema default). The remaining half — the Axis B mode knob —
  is deliberately two-way: a settings flip, logged and documented, not a redesign.
- *Phase 6's expected-issuer source* — pinning to a config value versus discovering it from
  the CP manifest is a trust-model decision, not plumbing. Discovery without pinning
  reintroduces the hole in a new shape.

**Debt being taken deliberately.** Phase 2 duplicates ~190 lines [F] of JCS into test code. That
is priced: it buys independence from the artifact under test, and the alternative — a git
dependency on an unpublished sibling — is worse. If `aitp-verifier` is ever published to
PyPI, replace the copy with a dev-group dependency and delete the helper.

---

## Adjacent in-flight work — the same defect class, one artifact over [REV]

**[R3] `aitp-control-plane#60` — the same defect class, one repo over.** Filed 2026-08-27
after the 0.5.0 -> 0.7.0 bump. `aitp-rs`'s changelog named three downstream repos that
worked around the missing verify binding: *"one hand-rolled a verifier in a test, one
skipped verification entirely, one rendered 'signed by CP' from the presence of a JSON
key."* This plan's repo was the **skipped-verification** one, now fixed. The control plane
is the **hand-rolled-in-a-test** one.

Worth reading alongside this plan's own carve-out, because #60 reaches the *opposite*
conclusion from the same premise and both are right. The carve-out keeps a hand-written
oracle in Phase 2 **because** an SDK-signs/SDK-verifies test is circular. #60 argues the
control plane should **add** the SDK verifier alongside its hand-rolled one rather than
replace it — same reasoning, applied to a repo that already has the independent half. The
shared rule: *never let the only verifier be the thing that produced the artifact.*

Spec `45b5ef9` moves the **session bundle's** `signature` from a sibling of the
`{"session_bundle": …}` wrapper into the inner body, matching what RFC-AITP-0010 §3 always
specified — the schema and all three `bundle-*` fixtures had followed the schema instead.
That is the same failure shape this plan exists for (a signing-input placement divergence
that self-consistency hid), it is in flight right now, and it interacts with this plan in one
dangerous way. Recorded here so neither effort surprises the other.

### `aitp-rs#89` — adopt AITP spec @ `45b5ef9`

**The load-bearing instruction is: do not merge on the green Rust tests.** Two checks are red
— `vendored schemas in sync` and `conformance fixtures` — and both are *correct*, not flaky.
The PR as opened bumps `tests/schemas/SPEC_VERSION` only; every test job passes because it is
still running against the **old vendored copy**. The drift check is the only job actually
looking at the new spec. A green Rust suite here is evidence of nothing.

The fix is to **re-vendor schemas + fixtures onto the same branch**, so the `SPEC_VERSION`
bump and the content it names land together. A pin that points at content the repo has not
absorbed is worse than no pin: it reads as adoption.

**The stop condition, stated as an instruction to whoever picks it up: if you find yourself
changing `aitp-session-bundle` logic, stop.** That crate is already correct —
`SessionTrustBundle` carries `signature` as a body field and `SessionBundleEnvelope` has no
sibling slot, so the corrected schema *blesses* what the crate already emits. Re-vendoring
should need no production-code change. A code change there means something else went wrong
(a mis-vendored fixture, a mis-read diff), and the right move is to find that, not to make
the crate match a broken input.

**Do not generalize the change to revocation.** This is the interaction that matters to *this*
plan. The session bundle moves `signature` **inside** the body because it is redistributable —
signed once by the coordinator, relayed to every participant, and it must carry its own proof
across any hop that strips the wrapper. The **revocation snapshot keeps `signature` as a
sibling** of the inner body; RFC-AITP-0001 §5.4.1 now states both rules normatively and
explains why they differ. Someone who reads the bundle correction as "signatures belong
inside the body" and applies it to revocation would break exactly what Phase 2 pins, in
exactly the way that shipped in 0.5.0. Phase 2's `SIGNING_INPUTS.innerBody` / `.wrapped` pair
is what would catch it — which is another argument for landing Phase 2 early.

**Folds in two tracked follow-ups, both sequence-sensitive:**
- **`#88` — remove the dual-shape shim** in the conformance adapter
  (`crates/aitp-rs-adapter/src/lib.rs` ~`:2885-2932`), which reassembles a sibling-shaped
  bundle into the internal inner shape so the old fixtures would load. Dead code once the
  corrected fixtures land. **Only after re-vendoring is green** — removing it first breaks
  the conformance run against a stale fixture copy. Cleanup, no behaviour change.
- **`#87` — add the optional `extensions` slot** to `SessionTrustBundle`, which today has
  `deny_unknown_fields` and no `extensions` field, so a schema-valid bundle carrying one
  fails to deserialize (RFC-AITP-0001 §7 reserves the slot on *every* signed object).
  **The trap: model it as `Option<Map>`, never a defaulted empty map with skip-if-empty.**
  Absent and present-empty canonicalize to different bytes under RFC 8785 — absent emits no
  key, `{}` emits `"extensions":{}` — so a field that silently normalizes one into the other
  changes the signing input and breaks verification against a conformant peer. Same class of
  bug as everything else in this document: an invisible change to what gets hashed.

### `aitp-verifier-py#12` — read and mint `signature` inside the inner body

Three phases from the companion plan. **No signed bytes change** — both readings canonicalize
the body with `signature` excluded; under the old shape the body simply never carried one.
`kat-session-bundle-001` is untouched at 922 canonical bytes. This is wire placement only.

**The exclusion trap is the whole change and it is easy to miss.**
`aitp_verifier/sessionbundle.py:51` verifies over `sha256(canonicalize(body))`, which is
correct **today only by accident**: the body never held a `signature`, so there was nothing
to strip. Once the member moves in, leaving that line unchanged **hashes the signature into
its own signing input** and every bundle fails. The signature must be read from `body` *and*
excluded from the signing bytes — `aitp_verifier/manifest.py:43` already has the idiom
(`{k: v for k, v in man.items() if k != "signature"}`); reuse it rather than reinventing it.

"Correct by accident" is worth naming as a category. It is the same reason Phase 2 demands
its negative assertion be **demonstrated** non-vacuous rather than reasoned about: a check
that passes for a reason other than the one you believe will keep passing right up until the
premise moves.

### The three acceptance criteria both share — and why this plan should adopt them

Both efforts end on the same three, and they generalize to every signing-input change in this
family:

1. **The old shape is rejected.** Not "the new shape works" — a verifier that accepts both has
   not migrated, it has widened. **[F] Stated precisely, this is family policy, not a spec
   MUST:** RFC-AITP-0008 §1.5's migration note says implementations coming from rc.3-era code
   "MAY accept either canonical shape during a transition window"
   (`rfcs/RFC-AITP-0008-revocation.md:105`). `aitp-rs` declined the window explicitly — its
   0.5.0 CHANGELOG says "No dual-accept is implemented" and cites that same MAY — and Phase
   5's criterion 2 and Phase 2's negative assertion enforce the *family's* choice. If anyone
   proposes a transition window later, it is a policy reversal to argue against on its
   merits, not a conformance violation to point at the spec about.
2. **A signature over itself fails.** The self-inclusion case must be tested explicitly, not
   assumed away, because it is the failure mode that appears the moment a `signature` member
   moves into a body someone is already canonicalizing.
3. **A cross-implementation check.** Verify an artifact minted by a *different*
   implementation, as committed, without re-minting. **Self-consistency is what let the
   divergence survive a full release in the first place** — a suite where the same code signs
   and verifies passes under any convention, including a wrong one.

Criteria 1 and 3 are already load-bearing in this plan: Phase 2's `wrapped`-form negative
assertion is criterion 1, and Phase 5's acceptance criterion 5 (verify the committed
`signed-examples/revocation/` vector without re-minting) is criterion 3. **Criterion 2 is
not, and should be** — this plan currently has no test that a signature cannot be hashed
into its own input. Add it to Phase 2 as a third `SIGNING_INPUTS` entry: an envelope whose
canonical bytes were computed with `signature` *included*, asserted to fail. Cheap, and it is
the one of the three the revocation path has never been tested against.

---

## Enterprise concerns

**Security.** The live gap is that the deny-set is populated from an unauthenticated fetch
with no signature check, at two call sites. Suppression (strip `entries`) is the higher-impact
direction: it silently *keeps a revoked TCT working*, and nothing in the current code could
notice. `agent_admin.py:634` [F] sending a bearer token to a public endpoint should be read as a
symptom — transport auth standing in for artifact authenticity. Phase 6 closes it; Phase 7
stops the docs from claiming it is already closed.

**[REV] Two further exposures found in the verification pass.** (1) The *manifest* ingest is
equally blind and picks the delegatee AID out of an unauthenticated fetch
(`agent_admin.py:419`) — Phase 2B, unblocked. (2) `/admin/refresh-revocations` and
`/admin/enroll-with-cp` accept `cp_base_url` **from the request body**
(`agent_admin.py:624`, `:528`), so an admin-route caller already chooses which host
populates the deny-set. Verification without a non-overridable issuer pin does not close
that; Phase 6 criterion 12 is what does.

**[F] A fourth blind ingest, found in the second pass — the CP's own registry.**
`POST /api/registry/agents` accepts an enrolling agent's `ManifestEnvelope`, checks only
that `manifest.aid` is present (`src/app/api/registry/agents/route.ts:106-110`), stores it,
and re-serves it inline "so a discovering peer can verify locally" (`route.ts:84-86`) —
without ever calling the npm binding's `verifyManifestJson`, which exists and which the CP
already uses on its *own* manifest in tests (`src/lib/identity/cp-agent.test.ts:14`). The
registry is a distribution point for envelopes it never verified. Same class as Phase 2B,
one repo over, and *not* blocked on Phase 5 (the manifest verify half is already bound in
npm). Out of this plan's phases; file a CP issue alongside Q6's console issue.

**[REV] Supply chain.** Until Phase 3, `ghcr.io/…/aitp-playground:latest` contains an SDK
built from unpinned `aitp-rs@main` (`docker.yml:46-50 [F]`, `:93`). The image is not
reproducible from its own commit, and `uv.lock` does not describe what it actually runs.
That is a provenance defect independent of anything about signing conventions.

**Reliability.** Verification introduces a new failure mode into a path that currently cannot
fail (it degrades to `[]`). Clock skew and the CP's 60s re-sign cache both feed the freshness
window; the staleness budget must be set with those in view or Phase 6 ships flake that
presents as a crypto bug.

**Observability.** `agent_admin` already emits `revocation.refresh_failed` and
`revocation.list_fetched`. Phase 6 should distinguish *fetch* failure from *verification*
failure in telemetry — collapsing them is how a signing-convention break would look like a
network blip, which is precisely the confusion this whole effort exists to prevent.

**Rollback.** Phases 1–4 are config/test-only and revert cleanly. Phase 6 is behavioural:
its **Axis B** mode is a settings flag (`revocation_fail_mode`, default `fail_closed` per
D1 — *not* "the Q2 mode", which D1 superseded **[REV]**), so an Axis-B rollout problem is a
config change rather than a revert. **Axis A has no flag by design** and rolls back only by
reverting the phase. Phase 2B is a single call per site and reverts cleanly, but its fixture
migration does not — see One-way doors.

**CI cost.** Phase 4 adds ~6 minutes to bump PRs only. Phase 3 removes a Rust compile from
the default e2e path **and from `build-and-push`, which runs on every PR and every main
push** **[REV]** — so the net is comfortably negative. Phase 2B adds one unit module and two
SDK calls on paths that already do network I/O; immeasurable.

---

## Decision D1 — Q2: fail mode for an unverifiable snapshot

**Decision.** Q2's binary was the wrong shape. RFC-AITP-0008 separates two axes that the
question — and `aitp_verifier`'s single `fail_mode` switch — collapse, and Phase 6
implements the RFC's decomposition rather than either pole of the original question:

- **Axis A — an unverifiable snapshot (bad signature, wrong issuer, unknown version,
  malformed, expired) is *discarded*. Not policy, not configurable.** RFC-AITP-0008 §1.5:
  "A snapshot whose `expires_at` is in the past, or whose signature does not validate,
  MUST be discarded" (`rfcs/RFC-AITP-0008-revocation.md:107`). Discarded means: entries
  never merge, the previous verified snapshot stays current, and telemetry says
  `revocation.verify_failed` with the cause.
- **Axis B — the *absence* of a fresh snapshot is a policy decision, and the playground
  ships the spec default: `fail_closed`, with `max_staleness_secs: 300`.** The same §1.5
  sentence continues: "the peer SHOULD treat the absence of a fresh snapshot per its
  configured `revocation_policy.mode` (§3)". §3.1 names the default: "The schema default
  for `revocation_policy.mode` is **`fail_closed`** … Deployments that need
  availability-first behavior MUST opt into `soft_fail` or `fail_open` explicitly;
  secure-by-default means revocation enforcement does not silently degrade"
  (`rfcs/RFC-AITP-0008-revocation.md:160`). `soft_fail` exists as an explicit opt-in
  setting, confined to Axis B.

**Why `fail_closed` does not make a CP hiccup a scenario failure.** §3.2 applies the mode
only when the cached list is older than `max_staleness_secs` *and* the endpoint is
unreachable — the last *verified* snapshot legitimately bridges outages inside the budget.
The demo's timing envelope fits with margin: the CP re-signs at most every 60s
(`producer.ts:43` [F]), Phase 6's 60s poll cadence bounds verified-snapshot age at ~120s + skew
against a 300s budget, and the signed `expires_at` defaults to 3600s (`config.ts:33`).
Compose healthchecks serialize start-up, so scenarios never begin against an unhealthy CP.
The failures `fail_closed` adds are the ones it exists to add: a CP down for more than five
minutes mid-run, or a snapshot that genuinely does not verify — the latter being precisely
the signing-convention break this plan is for.

**Rejected: blanket `soft_fail`** — the Q2 option as posed. It contradicts §3.1's
MUST-opt-in default in the exact artifact whose job is to model correct integration (the
`docs/aitp-integration.md` audience reads behaviour as guidance), and worse: under a
collapsed switch like `aitp_verifier`'s, `soft_fail` reports a *forged* snapshot as
not-revoked (`aitp-verifier-py/aitp_verifier/revocation.py:42-44`) — an attacker who can
serve garbage gets the same outcome as one who suppresses the list, and the whole
verification effort becomes a no-op under attack. That collapse is tolerable in
`aitp_verifier` only because its default is `fail_closed`; it must not be copied.

**Rejected: blanket `fail_closed` through one switch** — the other Q2 option as posed.
Protocol-safe but pedagogically wrong: it renders "the CP restarted" and "someone forged
the list" as the same `TCT_REVOKED`, which is exactly the confusion the Observability
requirement (fetch failure ≠ verification failure) exists to prevent. The decomposition
keeps the protocol posture *and* the legibility.

**Consistency with the family.** `aitp-rs` refuses to build a TCT verify context until the
revocation decision is made explicitly — `RevocationDecisionRequired`, waivable only by a
method named `accept_unchecked_revocation_dangerous`
(`crates/aitp-tct/src/verifier.rs:48-58,195`). The reference implementation's posture is
"no silent default; the unsafe direction must be named". Phase 6 mirrors it: CP configured
⇒ `fail_closed` default; no CP configured ⇒ the explicitly-logged unchecked posture.

**What is one-way here, and what is not.** One-way: Axis A's unconditional discard and the
secure-by-default direction — walking either back changes what the demo teaches under
attack. Deliberately two-way: the Axis B mode is a setting (`revocation_fail_mode`), so if
operating experience shows outage-legibility mattering more than modelled strictness, that
is a config flip plus a doc note, not a redesign. The door is narrower than the Long-term
posture section originally feared, and the narrowing is what the decomposition buys.

**What would change the decision.** A spec change to §3.1's schema default; the RFC folding
authenticity failures into `revocation_policy.mode` (today it pointedly does not); or the
Phase 5 binding shipping a policy surface that hard-codes the collapsed single-switch
shape — in which case the playground should push back upstream rather than absorb the
collapse.

---

## Open questions

**Q1 — Does the playground fix its `>=0.4.0` floor only, or adopt a cap?**
Recommendation: floor only (Phase 1), with the interlock (Phase 2) supplying the diagnostic.
A cap turns the next flip into a resolver error that names version ranges instead of signing
conventions. Cheap to reverse either way. *Pending confirmation — Phase 1 proceeds on the
recommendation unless told otherwise.*

**Q2 — Fail mode for an unverifiable snapshot: `fail_closed` or `soft_fail`?**
**Resolved — see Decision D1 above.** The binary was the wrong shape: an unverifiable
snapshot is discarded unconditionally (RFC-AITP-0008 §1.5, a MUST), and the absence of a
fresh snapshot is `fail_closed` by default — the spec's schema default — with `soft_fail`
as an explicit, Axis-B-only opt-in. Phase 6 is written against that decision.

**Q3 — Is `verify_revocation_list` binding work the playground should ask for, or does
`aitp-rs` already have it planned?**
**RESOLVED — build it; it is not planned, not a duplicate, and not somebody else's repo. [REV]** At the time of the
draft `aitp-rs` had exactly one issue (#82, closed — the 0.5.0 signing-input change);
**[F]** #87 and #88 have since been opened for the session-bundle follow-ups recorded in
"Adjacent in-flight work", and neither touches a revocation-verify binding. Also,
`verify_revocation_list` appears in its `plans/jcs-inner-body-signing-input.md` only as an
internal Rust concern (colocating signer/verifier/KAT), never as a binding deliverable. The
verify half is absent from `aitp.pyi` and `bindings/aitp-node/index.d.ts` at 0.5.0. The
question as posed — request or duplicate? — had a third answer the draft did not consider:
**neither.** `verify_revocation_snapshot` is a Tier C conformance operation the Rust adapter
already implements (`docs/conformance.md:129`, `crates/aitp-rs-adapter/src/lib.rs:162`), so
the bindings are missing a capability the spec expects of a verifier. Phase 5 is now an
implementation phase in `aitp-rs`.

**Q4 — Should Phase 3 land before Phase 2?**
**RESOLVED — Phase 2 first. [REV]** The draft called it a toss-up. It is not: `ci.yml`'s
`test` job already installs the pinned PyPI wheel via `uv sync --locked` (`ci.yml:50-53`), so
Phase 2 lands in a tier that *already* observes the artifact under test and needs nothing
from Phase 3. Phase 3 remains necessary — it is what makes every *other* e2e signal
trustworthy, and it retires the unpinned published image — but it is not a prerequisite for
the interlock. Recommended order is in Long-term posture.

**Q6 — Does `aitp-ui-console` get its own tracking issue? [REV — new]**
It is the third blind consumer (`use-trust.ts:130`, `cp-identity.tsx:33`) and it *displays* a
verification claim it never performs (`cp-identity.tsx:114`). Severity is lower — it misleads
an operator rather than admitting a forged deny-set — but the misleading string is a
one-line fix independent of everything else, and the console has no AITP dependency to verify
with until Phase 5's Node half lands. Recommendation: file a console issue now for the
display string, and reference the console as a consumer in Phase 5's PR. Out of scope for
this plan's phases either way. *Pending confirmation.*

**Q5 — Where should this plan live so `aitp-playground` can read it?**
`aitp-control-plane/.gitignore:18` ignores `plans/`, so **this file is untracked and a GitHub
blob URL will not resolve.** The relative path
`../aitp-control-plane/plans/cross-repo/aitp-playground-revocation-verification.md` works
locally (the repos are siblings) but means nothing to anyone opening issue #46 on GitHub.
Options: (a) un-ignore `plans/cross-repo/` so cross-repo plans are shareable while local
working plans stay ignored — the narrowest fix; (b) paste this plan's body into issue #46;
(c) leave it local-only and accept that the handoff works only on this machine. **(a) is the
recommendation**, but it edits repo config in `aitp-control-plane` and is not done here.
Related to open item **O2** in that repo's `DECISIONS.md`.

**[REV] Still open, and it is now the only thing blocking the handoff.** Everything else in
this plan is actionable; this file remains untracked, so `aitp-playground#46` cannot link to
it and Phase 5's PR description cannot cite it from `aitp-rs`. Both want the link. Pick (a)
or (b) before Phase 5 opens, not after.

---

## Repo map — `aitp-playground`

**Revocation path (the subject of this plan)**
- `src/aitp_playground/cp_client/client.py:206` — `fetch_revocation_list()`; parses the
  envelope, **ignores `signature`**. Service-side consumer.
- `agents/base/agent_admin.py:606-665` — `/admin/refresh-revocations`; the identical
  signature-blind parse. **The path the scenario actually exercises.**
- `agents/base/agent_admin.py:499` — local `/admin/revoke-tct`, adds to `revoked_jtis`.
- `agents/base/agent_admin.py:657` — `revoked_jtis.add(...)`; **the deny-set is a monotonic
  union of local + CP jtis, with no snapshot metadata.** Phase 6's prerequisite. **[REV]**
- `agents/base/agent_admin.py:624-629`, `:528` — `cp_base_url` / `cp_api_key` accepted **from
  the request body**, bootstrap as fallback. **[REV]**
- `agents/base/aitp_server.py:334` — deny-set enforcement (403 before signature check).
- `src/aitp_playground/cp_client/client.py:62` — `publish_revocation()` → CP
  `POST /api/revocation/entries`.

**Manifest path (Phase 2B) [REV]**
- `agents/base/agent_admin.py:415-424` — fetches the delegatee manifest, reads `["aid"]`
  unverified, mints the delegation to it.
- `agents/base/agent_admin.py:85-93` — hands raw `peer_manifest_json` to `build_hello`, then
  reads `handshake_endpoint` / `aid` from it directly.
- `src/aitp_playground/trust/resolver.py:33-51` — `did:web` → manifest URL; plain HTTP under
  `AITP_DIDWEB_INSECURE_HOSTS`. The name↔AID binding this phase does *not* establish.
- `src/aitp_playground/config.py:32` — `cp_base_url`; **there is no `cp_aid`**. Phase 6's pin
  has to be added here and threaded through `hosting/bootstrap.py:39-43` into
  `bootstrap["cp"]` to reach agent subprocesses.

**Scenarios & tests**
- `scenarios/intra-org/revocation-via-cp/1.0.0/scenario.yaml` — the CP-propagation scenario;
  step text claims a *signed* list is consumed.
- `scenarios/intra-org/revocation-demo/1.0.0/scenario.yaml` — local revocation, no CP.
- `tests/integration/test_protocol_e2e.py:157` — `_check_revocation_via_cp`; asserts counts
  and 403, **not** verification.
- `tests/unit/test_cp_client.py:209-263` — transport-mocked parse-shape tests; no crypto.
- `tests/unit/test_sdk_blocked_features.py:33` — the `hasattr` capability-probe idiom to
  follow for optional SDK surface.

**Build & CI**
- `pyproject.toml:23` — `aitp-sdk>=0.4.0`, the floor Phase 1 raises.
- `Dockerfile:33-50` — maturin-builds the SDK from `../aitp-rs` **source**; Phase 3's target.
- `Dockerfile:79-84` — installs that wheel, then `pip install -e .`.
- `docker-compose.test.yml` — postgres + CP (built from `../aitp-cp`) + playground + tests.
- `.github/workflows/ci.yml:14/30/60` — lint, unit+scenario (`uv sync --locked`), gated runner
  integration. Phase 2's test lands in the `test` job.
- `.github/workflows/ci.yml:50-53` — the `test` job installs the **PyPI** wheel via
  `uv sync --locked`; the only tier that observes the pinned artifact today. **[REV]**
- `.github/workflows/docker.yml:46-50 [F], :93` — `build-and-push` does the same unpinned
  `aitp-rs@main` checkout and pushes `:latest`. **The published image embeds an unreleased
  SDK.** Phase 3(b). **[REV]**
- `.github/workflows/docker.yml:103-106` — the `e2e` job, **`main`-push only**; Phase 4 widens.
- `.github/workflows/docker.yml:117` — sibling `aitp-rs` checkout; removable under Phase 3.
- `.github/workflows/bump-aitp.yml` — `repository_dispatch: aitp-released` → `aitp-ci`
  `bump-consume`, which opened #45.
- `.github/workflows/auto-merge.yml` — runs on `pull_request`; **a green bump PR auto-merges.**

**Docs to correct (Phase 7)**
- `docs/aitp-integration.md:67` — "no envelope is parsed … outside the SDK" (false today).
- `docs/aitp-integration.md:334-341` — boundary check listing "Verify a signature" as
  SDK-only; needs the test-code carve-out.
- `docs/control-plane.md:70-71, 116, 194-199` — CP call table and the boundary section.

**External references**
- `aitp-rs/CHANGELOG.md` — the 0.5.0 BREAKING entry, with KAT sizes/digests per convention.
- `aitp-rs/crates/aitp-tct/src/revocation.rs:87,118` — `revocation_signing_bytes`,
  `verify_revocation_list` (Rust only; **unbound** in Python and Node).
- `aitp-rs/crates/aitp-tct/src/revocation.rs:128` — issuer mismatch returns `CnfMalformed`
  under a stale "no new variant for v0.1" comment, though
  `aitp-rs/crates/aitp-tct/src/error.rs:12-19` **already defines `IssuerMismatch`** for this
  exact RFC-AITP-0008 §3.3 case. One-line fix, Phase 5 step 3. `revocation.rs:150-166` —
  `VerifyRevocationListContext` is `{expected_issuer, now}` only, **no staleness knob**, and
  `published_at` is never read: deliberate, and Phase 5 keeps it that way. **[REV]**
- `aitp-rs/docs/conformance.md:129`, `aitp-rs/crates/aitp-rs-adapter/src/lib.rs:162,209` —
  `verify_revocation_snapshot` is a **Tier C conformance operation** the Rust adapter
  implements and the bindings cannot. The reason Phase 5 is an implementation phase. **[REV]**
- `aitp-rs/bindings/aitp-py/src/lib.rs:38-60` — module registration; **no exception classes**,
  so every failure is a `PyValueError`/`PyRuntimeError` string. Phase 5 ask 2. **[REV]**
- `aitp-rs/bindings/aitp-py/src/session.rs:161-165` — `build_hello` deserializes the peer
  `ManifestEnvelope` without verifying it. Phase 2B. **[REV]**
- `aitp-rs/crates/aitp-crypto/src/keys.rs:510-518` — signature tagging: `p256.` prefix only,
  untagged ⇒ Ed25519. Phase 2's open item, closed. **[REV]**
- `aitp-rs/bindings/aitp-py/aitp.pyi:206` — `verify_manifest_json`, **already bound** (Phase
  2B needs no upstream work). **[REV]**
- `aitp-rs/bindings/aitp-py/aitp.pyi` — the Python surface; no revocation verify.
- `aitp-verifier-py/aitp_verifier/revocation.py` — independent `verify_revocation_snapshot`,
  already inner-body. Not on PyPI (404).
- `aitp-verifier-py/aitp_verifier/jcs.py` — the RFC 8785 canonicalizer Phase 2 copies.
- `aitp-control-plane/src/e2e/revocation-flow.integration.test.ts` — the shipped issuer-side
  `SIGNING_INPUTS.innerBody` / `.wrapped` pattern Phase 2 mirrors.
- `aitp-ui-console/src/hooks/use-trust.ts:130`,
  `aitp-ui-console/src/components/config/cp-identity.tsx:33` — the third blind consumer;
  `:114` renders "· signed by CP" from a truthiness check on the `signature` key. No AITP
  dependency in its `package.json`. Q6. **[REV]**
- PyPI: `aitp-sdk` 0.5.0 ships `cp39-abi3` wheels for manylinux x86_64/aarch64 and both macOS
  arches. `aitp-verifier` is still **404**. **[REV]**

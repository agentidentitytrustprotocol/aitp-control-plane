#!/usr/bin/env node
/**
 * Shipped-image conformance harness.
 *
 * `scripts/verify-request-gate.mjs` proves the request gate (`src/proxy.ts`) is
 * ATTACHED — but it boots the server with `npx next start`, and
 * `next.config.ts:3-8` records that `next start` is incompatible with
 * `output: 'standalone'`. The Docker image ships the standalone output
 * (`Dockerfile`: `NEXT_OUTPUT=standalone`, `COPY .next/standalone`,
 * `CMD node server.js`). So gate attachment is proven in a configuration the
 * image never runs, and in the artifact that actually deploys nothing tested it
 * at all. This harness exists to close that gap (aitp-control-plane#68).
 *
 * ── WHAT THIS FILE COVERS TODAY ────────────────────────────────────────────
 * First, static assertions against a BUILT IMAGE, needing no server and no
 * database: the NAPI binary loads, the OpenTelemetry tree was traced in, every
 * traced external present is a symlink that resolves, and the `.node` inventory
 * matches a committed baseline including the arch token.
 *
 * Then a LIVE SUBSTRATE: a run-unique private bridge network, an ephemeral
 * Postgres, the repo's own migrations applied from the host, and the image itself
 * run against them — with `/api/health` asserted to report `db: "ok"` and an AID
 * equal to one derived independently from `CP_AID_SEED_HEX` on the host.
 *
 * On that substrate, GATE ATTACHMENT — the gap #68 is named for: an unauthenticated
 * /api/audit is rejected 401 with `code: INVALID_API_KEY`, a valid key reaches the
 * handler, `x-request-id` is injected on both, and OPTIONS is answered 204 by the
 * gate without reaching a handler.
 *
 * Plus the checks that stop all of those being vacuous. There are three of them and
 * they have three different jobs; the distinction cost eight review rounds to arrive
 * at and collapsing it is how this phase kept shipping checks weaker than their prose.
 *
 *   CHECK 11 — IS THE GATE WIRED TO THE RIGHT PATHS?  A PINNED EQUALITY, not a test
 * of what the matcher satisfies. The matcher set is read out of the image's own
 * .next/server/functions-config-manifest.json and compared WHOLE to
 * `middlewareMatchers` in the committed baseline — including the COMPILED `regexp`,
 * which is what Next matches requests against, and not merely the `originalSource`
 * string that labels it. Any matcher key beyond those two fails closed, because Next
 * enforces `has`/`missing` at RUNTIME and a matcher carrying
 * `missing:[{type:"header",key:"cookie"}]` looked byte-identical to the correct one
 * while every browser request bypassed the gate. Three earlier versions tested
 * satisfaction — over HTTP at one path, then at three, then against the whole built
 * route list — and each fell to a ONE-LINE matcher edit; a fourth pinned only the
 * source string and fell to narrowing the compiled regexp alone. The built route
 * IDENTITIES are pinned too (`apiRoutes`), not merely their number: a count cannot see
 * a SUBSTITUTION, and renaming nineteen gated routes to decoys at an unchanged count
 * of 30 was measured to pass everything.
 *
 *   CHECK 13 — IS THE GATE'S CODE THE REVIEWED CODE?  ALSO AN EQUALITY, and it is the
 * answer to the question that defeated this phase five times. A gate can be attached,
 * matched by the pinned matcher, invoked on every request — and still DECIDE WRONGLY,
 * because its decision is compiled code that no manifest describes. The previous answer
 * was to probe the gate's behaviour over the whole route population (360 requests: six
 * verbs x thirty pinned routes x four id shapes) and it was defeated five times running,
 * each time by a dimension the probes held constant:
 *
 *     the gate BODY     rewrite the compiled isPublicRequest -> 12/12 green while five
 *                       admin routes answered 200
 *     the VERB          flip one operator ("GET"===t&& -> "GET"!==t||) -> 13/13 green
 *                       while an anonymous POST /api/trust-anchors returned 201 and
 *                       created a trust anchor for an attacker-supplied issuer
 *     the POPULATION    rename 19 gated manifest keys to /api/decoy-N -> 13/13 green
 *                       with six admin routes at 200
 *     the REQUEST SHAPE append `|| !e.headers.get("origin")` -> 13/13 green while a
 *                       plain curl (no Origin — what every non-browser caller sends)
 *                       read /api/audit, /api/tcts and seven more anonymously
 *     the ID LENGTH     exempt /[^/]{40,}/ -> 13/13 green while every dynamic route was
 *                       ungated for real 54-character AIDs
 *
 * One mechanism, five times: A CHECK THAT SAMPLES WHAT THE RUNTIME DECIDES ON IS
 * SATISFIABLE BY SOMETHING NARROWER THAN THE CHECK'S OWN PROSE CLAIMS, and the space of
 * request shapes is not finite. Adding a seventh verb or a ninth id literal closes
 * nothing. Every one of those five is an EDIT TO COMPILED CODE, and none of them touches
 * `src/proxy.ts` — so `verify-request-gate.mjs`, which builds its own server from source,
 * is structurally blind to all five and this harness is the only thing in CI that looks
 * at the image.
 *
 * So check 13 stopped asking what the gate DOES and asserts what the gate IS. But an
 * equality on the gate's own bytes proves the reviewed gate is present ON DISK, not that
 * it EXECUTES — anything that runs earlier in the same process can rewrite the gate in
 * memory before it is called. Two such channels were measured: a
 * `Module.prototype._compile` hook in the standalone boot script `/app/server.js`, and
 * code appended to the INSTRUMENTATION chunk, which the middleware entry `await`s in the
 * same module realm at boot — each opened an un-probed route to anonymous callers while
 * the gate chunk stayed byte-identical. So check 13 pins the gate's whole LOAD PATH, as
 * exact equalities, no requests at all:
 *   - `bootGraph`: server.js, plus the TRANSITIVE CLOSURE of the chunks
 *     `.next/server/middleware.js` and `.next/server/instrumentation.js` load, by SHA-256,
 *     each path prefixed by loader. Derived from the artifacts' own loaders rather than
 *     hardcoded, so a Next split is followed; the file NAMES are pinned, so a chunk swap
 *     is a diff. A CLOSURE, not the loaders' direct `R.c(...)` registrations: a chunk can
 *     load further chunks lazily at runtime (`e.v`/`e.l`), and one such chunk
 *     (`[root-of-the-server]__1up5uol._.js`, reached from `instrumentation.register()`)
 *     was measured to run in the gate's realm while being in NO pinned set — a
 *     `Set.prototype.has` shim in it served four un-probed routes anonymously at 13/13
 *     green. Complete over the COMPILED CHUNK GRAPH the gate's loaders reach, including
 *     bytes outside the gate function (deny(), applyCors(), the config parser). It is NOT
 *     complete over everything that executes — see WHAT IS OUT OF SCOPE.
 *   - `nextTreeSha`: one aggregate SHA-256 over /app/node_modules/next — the framework
 *     tree that loads and invokes the gate chunk, where a require-time hook would rewrite
 *     the gate before it runs. Measured byte-identical across arches; moves only on a
 *     `next` bump.
 *   - `scripts/image-gate-canonical.txt`: the compiled gate itself, extracted as a byte
 *     range of the middleware entry module (compiled PUBLIC_PATHS set literal → end of the
 *     export registration naming "proxy") and committed VERBATIM. The REVIEWABLE half —
 *     ~2.8 KB — so `git log -p` on it is the audit trail of the gate's compiled form and a
 *     mismatch prints a located diff rather than two walls of minified JavaScript.
 *   - `imageConfig`: Env, Entrypoint, Cmd, WorkingDir, User. They decide what code runs
 *     before any assertion here gets a say; `ENV NODE_OPTIONS=--require=/app/lie.js` was
 *     measured to preload its own code into every probe this harness ran from the image.
 *
 * The parts make the TRIAGE precise, which is what makes the maintenance cost bearable:
 * the gate region red means the gate's own compiled code changed — a security review, and
 * what all five defeats above produce. bootGraph or nextTreeSha red while the gate region
 * is green is the AMBIGUOUS case and is deliberately NOT auto-blessed: it is EITHER the
 * framework recompiling around an unchanged gate (a housekeeping re-pin) OR code injected
 * into a load-path file — a `_compile` hook in server.js, a patched instrumentation chunk —
 * that rewrites the gate in memory while leaving the region bytes untouched (a real
 * defeat). The two are indistinguishable on disk, so the operator, not the check, resolves
 * them: re-pin only a load-path change you made and can account for. THE EXTRACTION RUNS NO
 * CODE FROM THE IMAGE: `docker create` plus `docker cp` against a container never started.
 *
 * WHAT IS OUT OF SCOPE — stated because a `docker cp` check cannot honestly claim
 * otherwise, and because two of these are MEASURED HOLES, not theoretical ones. The
 * gate's realm is the whole Node process, so its code surface is the transitive `require`
 * closure of everything that runs before the gate decides. This check pins part of that
 * closure, not all of it:
 *
 *   1. THE DEPENDENCY TREE, apart from `node_modules/next`. **OUT OF SCOPE BY DELIBERATE
 *      DECISION — read this before "fixing" it.** A closure chunk can `require()` a traced
 *      external, and that package runs in the gate's realm. Measured:
 *      `[root-of-the-server]__1up5uol._.js` requires `pino`, and appending a
 *      `Set.prototype.has` shim to `/app/node_modules/pino/pino.js` flipped four un-probed
 *      routes from 401 to a handler-reached 500 while ALL 13 CHECKS PASSED
 *      (`aitp-attack24:pino-external`), with the gate region, the whole bootGraph and
 *      nextTreeSha all byte-identical.
 *        WHAT THIS CHECK GUARANTEES is that THIS REPO'S OWN COMPILED OUTPUT — the gate's
 *      compiled logic, the middleware/instrumentation chunk graph, the framework tree that
 *      invokes it, and the image's process config — is byte-for-byte the reviewed code. That
 *      is the regression class #68 was filed for: a bundler swap, a Next.js upgrade, a
 *      next.config.ts or Dockerfile edit, or a src/proxy.ts rename silently DETACHING the
 *      gate. It does NOT guarantee that no installed dependency's code was tampered with
 *      after install, and it is not meant to.
 *        WHY: that is a supply-chain-integrity question with a better owner. `npm ci`
 *      installs strictly from package-lock.json and verifies each tarball against that
 *      lockfile's `integrity` hash — in the Dockerfile and in every ci.yml job;
 *      package-lock.json is committed, so a dependency change is a reviewable diff; and
 *      ci.yml's `Dependency audit (prod, high+)` job is this repo's standing check on the
 *      tree itself. An attacker who can rewrite /app/node_modules inside the image can
 *      equally rewrite the `node` binary, which item 3 below already places out of reach of
 *      anything that READS files out of the image. Closing it here would cost either the
 *      measured "one pin serves both arches with no normalisation" property (native packages
 *      are arch-specific) or leave `.node` bytes unpinned — a different hole of the same
 *      shape. So this is a STATED SCOPE LINE, not deferred work; there is deliberately no
 *      follow-up issue for it. Revisit it, if ever, as "should the image pin its dependency
 *      tree?" — not as "check 13 has a hole".
 *   2. ROUTE-HANDLER CHUNKS (`.next/server/chunks/_next-internal_server_app_api_*`).
 *      Outside the loader closure by construction, but they run in the same PROCESS, so a
 *      shim installed while a public route is handled can poison a later gate decision.
 *      Folding all of `.next/server` in would close this AND would make
 *      `--allow-gate-change` mandatory for every ordinary route addition — destroying the
 *      "this consent cannot be a reflex" discipline the flag exists for. Judged the worse
 *      trade, so it is stated rather than closed.
 *   3. The `node` binary, libc and the base OS. A check that READS files out of the image
 *      cannot out-trust the runtime that EXECUTES them — a tampered `node` could ignore
 *      the very bytes verified here. Base-image integrity is the Dockerfile `FROM` pin's
 *      job.
 *
 * Against a fully arbitrary in-image rewrite, checks 8-12 are the necessary behavioural
 * complement. This check raises the bar from "a one-line edit to the gate chunk" —
 * invisible to checks 8-12 on an un-probed route — to "tamper with a dependency, a route
 * chunk or the base image", and names the boundary rather than papering over it. DO NOT
 * upgrade any of the three to a claim of completeness without a measured attack showing
 * the hole is closed: this boundary has already moved outward three times, each time
 * because a fix was described as complete when it covered exactly one hop.
 *
 * THE ACCEPTED COST, stated plainly so nobody treats it as a bug: a Next.js or Turbopack
 * upgrade that recompiles the same source differently FAILS check 13 with no behaviour
 * change to show for it, and needs `--update-baseline --allow-gate-change`. That is the
 * price of an equality and it is the price this design was chosen for. Do NOT "fix" it by
 * normalising, AST-diffing or otherwise teaching the comparison to tolerate variation: an
 * equality that has been fuzzed until it tolerates differences has started sampling
 * again, and sampling is the thing that lost five times.
 *
 *   CHECKS 8-12 — DOES THAT CODE ACTUALLY RUN?  The behavioural half, and it is NOT
 * redundant with check 13. Measured: an image with the `/_middleware` entry deleted from
 * functions-config-manifest.json has a byte-identical `bootGraph` AND a byte-identical
 * gate region — the gate's code is present and simply never called. Check 13 cannot see
 * that by construction. Check 11 catches it (no matchers) and so do checks 8-10 and 12
 * (no 401, no x-request-id). So the behavioural probes stay, explicitly scoped: they
 * establish that the pinned code is REACHED, not that it is correct. Check 12 covers a
 * second gated route, a public route, and — with exactly one request — an anonymous POST,
 * because the gate's decision takes the METHOD and every other assertion here is a GET.
 *
 *   THE SIGNING PATH (checks 14-18). The revocation list is the one response this
 * service SIGNS, and it signs it with the NAPI binary inside the image. The signature
 * is verified TWO independent ways over the RAW SERVED BYTES — never a
 * re-serialisation — hand-rolled from node:crypto on the host, and by the image's own
 * SDK inside the image. Plus the assertion that stops the group being vacuous: the
 * producer catches a failed DB read and publishes an EMPTY BUT VALIDLY SIGNED list, so
 * the absence of its warning in the logs is asserted. Measured: against an unmigrated
 * database every other assertion in the group still passes.
 *
 *   THE CORS BUILD-FREEZE (check 19). The served access-control-allow-origin must
 * equal the value the CONTAINER was started with and DIFFER from the value the
 * Dockerfile bakes at build time — parsed out of the Dockerfile, never hardcoded here.
 * Asserting mere presence would pass on a build-frozen artifact, which is the exact
 * failure being guarded against.
 *
 * What is NOT here yet: the OTEL_ENABLED=true pass, which lands in a later commit
 * of this series. Nothing below should be read as already asserting it.
 *
 * TWO HARNESSES, ON PURPOSE. DO NOT MERGE THEM.
 *   - `verify-request-gate.mjs` owns the `next start` path — a real developer
 *     workflow (`package.json`'s `start` script) — and owns its own build,
 *     because it must bake a CORS_ORIGIN that differs from the runtime one.
 *     `.github/workflows/ci.yml` explicitly protects that file from being
 *     "optimised".
 *   - THIS file owns the standalone Docker artifact, and does NOT own the build
 *     environment — the Dockerfile does.
 * Duplicated assertions rot at different rates.
 *
 * SCOPE LINE. This harness proves ATTACHMENT AND LOADING IN THE STANDALONE
 * ARTIFACT. It must never re-prove the gate's
 * logic: the rate-limit bucket checks need isolated per-IP buckets via
 * CLIENT_IP_HEADER and are already covered against a running server by the
 * sibling harness.
 *
 * ── THE CONTRACT THIS FILE IS HELD TO ─────────────────────────────────────
 * All three rules are in force.
 *   1. THE RUNTIME ENVIRONMENT DIFFERS FROM THE BUILD ENVIRONMENT. Check 19 asserts
 *      the served CORS header equals the RUNTIME value AND differs from the value
 *      baked into the Dockerfile — parsed out of the Dockerfile, never hardcoded
 *      here, since this harness does not choose it. Asserting mere presence would
 *      pass on a build-frozen artifact, which is the exact failure being guarded
 *      against. There is deliberately no literal copy of the baked origin in this
 *      file: a copy-pasted one would decay into "a header is present" the moment
 *      someone edited the Dockerfile.
 *   2. EXPECTATIONS COME FROM A COMMITTED, HUMAN-AUDITABLE SNAPSHOT, never
 *      re-derived from the thing under test. Here that is
 *      `scripts/image-artifact-baseline.json`. IN FORCE NOW.
 *   3. ASSERT THE WIRE CONTRACT, NOT THE STATUS CODE. A 401 without
 *      `code: INVALID_API_KEY` is a different failure wearing the right status.
 *      IN FORCE NOW, in checks 8-10.
 *
 * RESOURCE LIFECYCLE — the part a past incident dictates.
 * `verify-request-gate.mjs` records a CI job that passed every check and then
 * hung for 18 minutes because a killed child's stdio pipes stayed open and
 * pinned the event loop. The Docker analogue is a foreground `docker run` or a
 * `docker logs -f`: a long-lived child holding pipes. The design that cannot
 * reproduce it:
 *   - One-shot probe containers run to completion under a per-call timeout and are
 *     registered for teardown BEFORE they are started, so a signal mid-probe still
 *     sweeps them even if `--rm` never fires. Registration-before-creation is not
 *     stylistic: `docker rm -f <name>` issued in the window between the daemon
 *     creating a container and starting it removes nothing, which is how an
 *     earlier revision of this file leaked twelve containers in state `created`.
 *   - The long-lived containers (Postgres and the app) start DETACHED
 *     (`docker run -d`), so nothing long-lived is ever a child of this process,
 *     and their logs are read with ONE-SHOT `docker logs`, never `-f` — a
 *     `docker logs -f` is precisely the long-lived child holding pipes that caused
 *     the incident below. IN FORCE NOW; it was a rule for later commits when this
 *     file created only probe containers.
 *   - Every resource is registered in a `Set` the moment it is created and torn
 *     down by an idempotent cleanup that is safe to call twice.
 *   - Teardown is wired to `finally`, `process.on('exit')`, SIGINT and SIGTERM.
 *     The exit path uses `spawnSync`: an exit handler cannot await, so async
 *     teardown there silently does nothing.
 *   - DO NOT COPY THE SIBLING'S SIGNAL HANDLING. It wires
 *     `process.on('exit', ...)` and NOTHING else, so Ctrl-C terminates it under
 *     Node's default disposition and its teardown never runs (harmless there —
 *     the leak is a local process, not a container and a network). Here both
 *     signal listeners are installed explicitly, and each calls `process.exit(1)`
 *     AFTER cleanup: installing a listener SUPPRESSES Node's default exit, so a
 *     handler that only cleans up leaves the process alive on Ctrl-C, which is
 *     the 18-minute bug wearing a different hat.
 *   - Containers are removed before networks (`network rm` fails while an
 *     endpoint is attached), with a brief retry, and a teardown failure never
 *     masks the real check failure.
 *   - The watchdog timer is `.unref()`ed: `main()` is always awaiting
 *     something so the ceiling still fires, and an unref'd timer cannot itself
 *     be the handle that pins a loop which would otherwise drain.
 *   - The BUILD has its own timeout, separate from the post-build ceiling, so
 *     "the build hung" and "a check hung" are distinguishable — an arm64 build
 *     under QEMU legitimately takes far longer than any check.
 *   - Nothing is ever written INSIDE the container. The image runs as uid 999
 *     and `/app` is root-owned; every observation comes back on stdout. That
 *     removes the write-permission question entirely.
 *
 * Usage:
 *   node scripts/verify-image.mjs [options]
 *     --platform <os/arch>   one platform per invocation (default: host)
 *     --tag <tag>            image tag to build/use
 *     --no-build             reuse an existing local tag
 *     --keep                 skip teardown (prints the cleanup commands)
 *     --prune                sweep leaked resources from an earlier crashed run
 *     --update-baseline      rewrite scripts/image-artifact-baseline.json
 *     --allow-removals       with --update-baseline: consent to a shrinking set
 *     --help
 *
 * Requires the repo's dev dependencies on the host (`npm ci`): migrations run
 * through the repo's own `npm run db:migrate`, and the runtime image bundles no
 * drizzle-kit.
 *
 * Testability hooks: AITP_VERIFY_IMAGE_WATCHDOG_MS overrides the post-build
 * ceiling and AITP_VERIFY_IMAGE_BUILD_MS the build ceiling, so both timeout paths
 * can be exercised deliberately (set one to 1000) without editing this file.
 * AITP_VERIFY_IMAGE_PAUSE_MS holds the live substrate up once it is ready, so the
 * teardown-on-SIGINT path can be exercised with a network and two containers all
 * live — a window under a second wide otherwise.
 * AITP_VERIFY_IMAGE_LEAK_REPRO=<ms>[:<probe-label>] is the regression repro for the
 * container-leak race: it makes a run-labelled container materialise <ms> after a
 * SIGINT raised mid-probe, which is the leak that was measured at 1 run in 24 and
 * cannot otherwise be scheduled. See maybeLeakRepro.
 * AITP_VERIFY_IMAGE_SWEEP_TRACE=1 makes the label sweep say when it caught a late
 * arrival, so "nothing was ever there" and "something appeared late and was swept"
 * stop looking identical.
 * There is no test runner wired to a .mjs script in this repo, so a negative path
 * with no hook is not falsifiable from a diff plus output.
 *
 * Check 13 needs no such hook, and that is a property of the design rather than an
 * omission: its whole input is four files copied out of the image and one
 * `docker image inspect`, so its negative path is exercised by pointing it at an
 * image whose gate was modified — which is how each of the defeats above was
 * reproduced against it. `--update-baseline` prints the same located diff the
 * failure does, so the re-pin path and the failure path show the same evidence.
 *
 * NOT torn down: the IMAGE. Teardown covers containers and networks; the built
 * image is deliberately left in the local daemon under a deterministic tag, so a
 * failure can be re-probed with `--no-build`. Remove it by hand
 * (`docker image rm <tag>`) — `--prune` does not touch images. One consequence:
 * the tag is NOT run-unique, so two concurrent runs on different platforms would
 * clobber each other's image. It fails loudly (the arch-token check catches it)
 * but the message is misleading — pass `--tag` when running concurrently.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  verify as edVerify,
} from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = path.join(ROOT, 'scripts', 'image-artifact-baseline.json');
/** Named once so every "this no longer matches the pin" failure can say how to
 *  re-pin it. A check that reports drift without naming the remedy sends the
 *  reader to the docs to find a command this file already knows. */
const REPIN_CMD = 'node scripts/verify-image.mjs --update-baseline';

/** Label on every resource, so `--prune` can sweep orphans from a crashed run. */
const LABEL = 'aitp-verify-image';
const RUN_LABEL = 'aitp-verify-image-run';

/**
 * Run-unique id. Names derived from it mean two concurrent runs — locally, or a
 * CI matrix — share the Docker daemon without colliding.
 */
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ── in-container paths ──────────────────────────────────────────────────────
const APP_DIR = '/app';
const TRACED_DIR = '/app/.next/node_modules';
const REAL_MODULES = '/app/node_modules';
// The server chunks are what actually `require()` the hashed specifiers, so
// resolution is probed from where they live.
const RESOLVE_FROM = '/app/.next/server/chunks';

// ── timeouts ────────────────────────────────────────────────────────────────
const DEFAULT_DOCKER_MS = 60_000;
const PROBE_MS = 120_000;
/**
 * Post-build ceiling. A hang must fail loudly and fast, never burn a CI slot.
 *
 * It must comfortably exceed the worst realistic post-build case, or it fires
 * first and reports "something hung" in place of the specific, actionable
 * "Postgres never became healthy, here are its logs". Budget, recomputed as the run
 * grew: SIX probes at PROBE_MS (12 min) — and the file notes probe timeouts are
 * realistic under QEMU — plus PG_READY_MS (3 min) plus APP_READY_MS (4 min) plus
 * MIGRATE_MS (3 min) is about 22 minutes, so 25 still leaves headroom. KEEP THIS IN
 * STEP WITH THE RUN: every probe added spends another PROBE_MS and every app container
 * another APP_READY_MS. Keep BUILD_MS_NATIVE + this BELOW the `verify-image` job's
 * `timeout-minutes` in ci.yml.
 *
 * Check 13's extraction is not a meaningful line in that budget and is bounded
 * structurally rather than hopefully: two `docker create`/`cp`/`rm` cycles and one
 * `docker image inspect`, each under DEFAULT_DOCKER_MS, against a container that is
 * never started — so there is no boot to wait for and nothing that can wedge. It
 * replaced 360 HTTP requests, which cost seconds but needed their own deadline and
 * non-answer cap to stay bounded; the equality needs neither. A whole `--no-build` run
 * against a local image, substrate included, measures about 45 s.
 */
const WATCHDOG_MS = Number(process.env.AITP_VERIFY_IMAGE_WATCHDOG_MS) || 25 * 60_000;
/**
 * Build ceilings, deliberately separate from the watchdog so "the build hung"
 * and "a check hung" are distinguishable. Keep BUILD_MS_NATIVE + WATCHDOG_MS
 * BELOW the `verify-image` job's `timeout-minutes` in ci.yml, or GitHub kills
 * the job before the harness can print which of the two it was.
 * AITP_VERIFY_IMAGE_BUILD_MS is a testability hook, like the watchdog's.
 */
const BUILD_MS_NATIVE = Number(process.env.AITP_VERIFY_IMAGE_BUILD_MS) || 25 * 60_000;
const BUILD_MS_EMULATED =
  Number(process.env.AITP_VERIFY_IMAGE_BUILD_MS) || 60 * 60_000;

// ── live-substrate settings ─────────────────────────────────────────────────
/**
 * Readiness deadlines, deliberately SEPARATE from the watchdog and generous
 * enough for an emulated boot. Elapsed time is printed on success so a slow boot
 * is visible rather than mysterious.
 */
const PG_READY_MS = 180_000;
const APP_READY_MS = 240_000;
/** Per-request deadline, so one wedged route cannot consume the watchdog. */
const HTTP_MS = 20_000;
/** Deadline for the migration child — the one long-running process that is not a
 *  `docker` call, and so the one place a wedge could otherwise eat the watchdog. */
const MIGRATE_MS = 180_000;

// ── the gate-code pin (check 13) ────────────────────────────────────────────
/**
 * Where the CANONICAL compiled gate lives in the repo.
 *
 * A separate file rather than a field in the JSON baseline, for one reason: it is
 * ~2.8 KB of minified JavaScript, and burying that in a JSON string would make the
 * one artifact a reviewer most needs to read the one they cannot. As its own file it
 * is greppable, and `git log -p` on it is a history of every change the gate's
 * compiled form has ever undergone — which is exactly the audit trail this pin
 * exists to create.
 *
 * Stored VERBATIM, one line, exactly as the bytes appear in the image, with a single
 * trailing newline added so the file is well-formed for text tools. The comparison
 * strips that one newline and is then byte equality. It is deliberately NOT
 * pretty-printed, re-indented, or normalised in any way: the moment a pin tolerates
 * a transformation it has started sampling the space of things the transformation
 * maps together, which is the mechanism that defeated this check's eight previous
 * formulations. A one-line file diffs badly in `git diff`; that cost is paid on
 * purpose, and the harness prints a located, windowed diff on mismatch so the
 * reviewer never has to read the line.
 */
const GATE_CANONICAL_PATH = path.join(ROOT, 'scripts', 'image-gate-canonical.txt');
/**
 * The anchor that locates the compiled gate inside the entry module.
 *
 * This is `PUBLIC_PATHS` from `src/proxy.ts:10-18` as Turbopack emits it. It is the
 * START of the byte range this check extracts; the END is the export registration
 * that names `"proxy"`. Between them sits everything `src/proxy.ts` compiles to.
 *
 * WHY AN ANCHOR IS SAFE HERE, when "locate it and check it" has been defeated over
 * and over in this phase: a locator is only dangerous when it decides WHAT to
 * assert. This one decides only what to SHOW. The verdict comes from the whole-graph
 * digest half of check 13, which covers every byte of the middleware's code and
 * needs no anchor at all. So the two failure modes of an anchor are both harmless:
 *   - the anchor is not found -> this check FAILS CLOSED and says so;
 *   - the anchor is found in the wrong place -> the extracted region will not equal
 *     the canonical copy, so it FAILS; and an attacker who plants a byte-identical
 *     decoy copy to satisfy it still changed the chunk, so the digest half fails.
 * Because the anchor is itself inside the region, editing PUBLIC_PATHS breaks the
 * locate and fails the check rather than slipping past it.
 */
const GATE_REGION_START_ANCHOR =
  'new Set(["/api/health","/api/readyz","/api/well-known/aitp-manifest",' +
  '"/api/well-known/aitp-revocation-list","/api/registry/enroll","/api/registry/agents",' +
  '"/api/metrics"])';
/**
 * Sanity bound on the extracted region, so a locate that goes wrong in a way nobody
 * predicted reports "the region came out implausible" instead of pinning 70 KB of
 * Next's middleware adapter and calling it the gate. The gate compiles to 2829 bytes
 * on this image; the bound is loose enough for real growth and tight enough that
 * swallowing the enclosing module (77 KB) trips it.
 */
const GATE_REGION_MAX_BYTES = 24_000;
/**
 * The image-config fields pinned alongside the code.
 *
 * `Env` is the load-bearing one and it closes a measured primitive: an image with
 * `ENV NODE_OPTIONS=--require=/app/lie.js` preloads attacker-controlled code into
 * every `node` this harness runs from it, INCLUDING the probe that reports the
 * matcher check 11 pins — so the artifact controlled the reporter. Pinning Env
 * makes that a diff rather than a blind spot. Entrypoint/Cmd/WorkingDir/User are
 * pinned with it because the same argument applies to them: they decide what runs.
 */
const PINNED_IMAGE_CONFIG_FIELDS = ['Env', 'Entrypoint', 'Cmd', 'WorkingDir', 'User'];

// ── teardown sweep window ───────────────────────────────────────────────────
/**
 * How long the daemon's label-filtered listing must stay EMPTY before the sweep
 * believes it. Measured from the last sighting, so any late arrival resets it.
 *
 * 4 seconds, not the 300 ms this used to be, and the number is empirical: at
 * ~300 ms a probe container leaked in state `created` in 1 run out of 24, because
 * the daemon finished creating it after the sweep had concluded. With the
 * AITP_VERIFY_IMAGE_LEAK_REPRO hook a container materialising 2.9 s after the signal
 * was still caught, and a real `docker create` was observed taking 5.7 s to land
 * under load — which the window survives because every SIGHTING resets it, so a
 * still-visible probe container keeps the sweep awake for its late sibling. See
 * sweepByLabelSync for why a quiet WINDOW and not a listing COUNT.
 *
 * Cost: one window per sweep kind, so up to 8 s added to a teardown that happens
 * once per process, in a run measured in minutes. Cheap insurance against a leak
 * that was both silent and permanent.
 */
const SWEEP_QUIET_MS = 4_000;
/**
 * Hard ceiling on one sweep, so a daemon that keeps producing labelled resources
 * cannot turn teardown into the hang this file exists to avoid. Two sweeps
 * (containers, then networks) run per teardown, so this is bounded at 2x — well
 * inside any CI job timeout, and only reachable when something is genuinely wrong.
 */
const SWEEP_BUDGET_MS = 20_000;
/**
 * How many consecutive FAILED listings end a sweep. A failure is not an empty
 * listing — see dockerSyncLines — so it must neither satisfy the quiet window nor
 * be retried until the budget. Five, then a loud report naming `--prune`.
 */
const SWEEP_MAX_LIST_ERRORS = 5;

/**
 * The CORS origin the CONTAINER is run with.
 *
 * `.invalid` is reserved by RFC 2606 and can never resolve, so this can never
 * collide with a real origin. It must also DIFFER from the value the Dockerfile bakes
 * at build time — that difference is what makes check 19 falsifiable, and check 19
 * fails loudly with a collision message if someone ever makes the two equal.
 */
const RUNTIME_ORIGIN = 'https://runtime-probe.invalid';
/** A fixed NON-PRODUCTION seed, so the derived AID is deterministic and can be
 *  asserted. Not a secret, and never used anywhere but this harness. */
const SEED_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
/**
 * Must be NON-EMPTY. With `API_KEYS` empty under `NODE_ENV=production` the gate
 * answers 503 SERVER_MISCONFIGURED rather than 401, so an empty value here would
 * silently exercise a different code path than the one being asserted.
 */
const API_KEY = 'verify-image-harness-key-0000';
/** >= 32 chars, or EnrollmentService throws when first constructed. */
const ENROLLMENT_SECRET = 'verify-image-harness-secret-min-thirty-two-chars';
/** Matches ci.yml and docker-compose.yml rather than introducing a third pin. */
const PG_IMAGE = 'postgres:16-alpine';
const PG_DB = 'aitp_verify_image';
const PG_USER = 'postgres';
const PG_PASS = 'postgres';

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    platform: null,
    tag: 'aitp-control-plane:verify-image',
    build: true,
    keep: false,
    prune: false,
    updateBaseline: false,
    allowRemovals: false,
    allowGateChange: false,
    help: false,
  };
  /** A value-taking flag must actually be followed by a value, not by nothing
   *  and not by the next flag — otherwise `--platform` as the last token would
   *  silently fall back to the host platform and the run would quietly verify
   *  something other than what was asked for. */
  const value = (flag, i) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) {
      throw new Error(`${flag} needs a value`);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--platform':
        opts.platform = value(a, ++i);
        break;
      case '--tag':
        opts.tag = value(a, ++i);
        break;
      case '--no-build':
        opts.build = false;
        break;
      case '--keep':
        opts.keep = true;
        break;
      case '--prune':
        opts.prune = true;
        break;
      case '--update-baseline':
        opts.updateBaseline = true;
        break;
      case '--allow-removals':
        opts.allowRemovals = true;
        break;
      case '--allow-gate-change':
        opts.allowGateChange = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${a} (try --help)`);
    }
  }
  // Reject rather than ignore: a typo'd `--allow-removals` on a verification run
  // would otherwise look like it had done something.
  if (opts.allowRemovals && !opts.updateBaseline) {
    throw new Error('--allow-removals only means anything together with --update-baseline');
  }
  if (opts.allowGateChange && !opts.updateBaseline) {
    throw new Error('--allow-gate-change only means anything together with --update-baseline');
  }
  return opts;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  // Parsing happens before main(), so without this an unknown flag prints a raw
  // Node stack trace and the version banner instead of one actionable line.
  console.error(`verify-image: ${err.message}`);
  process.exit(1);
}

const HELP = `verify-image — prove the request gate and the native/OTel paths attach in the
shipped standalone Docker image.

  node scripts/verify-image.mjs [options]

  --platform <os/arch>   one platform per invocation (default: the host's).
                         A comma-separated list is rejected: "docker buildx
                         build --load" cannot load a multi-platform manifest.
  --tag <tag>            image tag to build and probe
                         (default aitp-control-plane:verify-image)
  --no-build             reuse an existing local tag instead of building
  --keep                 skip teardown and print the cleanup commands
  --prune                remove resources left by an earlier crashed run, then exit
  --update-baseline      rewrite scripts/image-artifact-baseline.json and
                         scripts/image-gate-canonical.txt from the image. Prints the
                         diff against the existing baseline first, and refuses if any
                         entry would DISAPPEAR (see --allow-removals) or if the
                         compiled gate itself changed (see --allow-gate-change).
  --allow-removals       with --update-baseline: consent to recording a baseline
                         from which entries have vanished. Needed only for an
                         intentional removal — otherwise it blesses a regression.
  --allow-gate-change    with --update-baseline: consent to re-pinning a CHANGED
                         compiled gate (check 13). Required whenever the gate's own
                         bytes, the middleware graph's bytes, or the image's Env /
                         entrypoint differ from what is pinned. The located diff is
                         printed first, and it is a security review: every defeat this
                         harness has ever caught in the gate body would appear there.
  --help                 this text
`;

// ── resource registry ───────────────────────────────────────────────────────
/** Containers created this run. Registered BEFORE creation, never after. */
const containers = new Set();
/** Networks created this run. */
const networks = new Set();
/** Live `docker` CLI children, so no pipe can outlive a signal. */
const liveChildren = new Set();

function nameFor(kind) {
  return `${LABEL}-${RUN_ID}-${kind}`;
}

function labelArgs() {
  return ['--label', `${LABEL}=1`, '--label', `${RUN_LABEL}=${RUN_ID}`];
}

// ── docker plumbing ─────────────────────────────────────────────────────────
/** Keep an error message readable: a probe's `-e <script>` argument is huge. */
function summariseArgs(args) {
  return args.map((a) => (a.length > 80 ? '<script>' : a)).join(' ');
}

/**
 * Run a `docker` command and capture its output.
 *
 * The child is tracked so a signal or the watchdog can kill it and destroy its
 * pipes; the per-call timeout means one wedged docker invocation cannot consume
 * the whole ceiling.
 */
function docker(args, { timeoutMs = DEFAULT_DOCKER_MS, allowFail = false, input = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    liveChildren.add(child);
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      reject(new Error(`could not run \`docker ${args[0]}\`: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      // Drop our end of the pipes so they cannot pin the event loop.
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (timedOut) {
        // summariseArgs, not args.join: a probe timeout would otherwise echo the
        // whole embedded probe script into the failure text — the same unreadable
        // output the non-zero-exit path below was already fixed to avoid. Probe
        // timeouts are realistic under QEMU emulation in CI, so this path is hot.
        reject(new Error(`\`docker ${summariseArgs(args)}\` timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0 && !allowFail) {
        reject(
          new Error(
            `\`docker ${summariseArgs(args)}\` exited ${code}\n${(err.trim() || out.trim()).slice(0, 4000)}`,
          ),
        );
        return;
      }
      resolve({ code, stdout: out, stderr: err });
    });
    if (input !== null) child.stdin.end(input);
  });
}

/**
 * Run a `docker` command with its output inherited (live progress, no pipes).
 *
 * Used for the build: it is the one long-running invocation, and inheriting
 * stdio means there is no pipe to leak in the first place. Docker prints its
 * own diagnostics to the inherited stderr, which is what CI shows anyway.
 */
function dockerStream(args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    liveChildren.add(child);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      reject(new Error(`could not run \`docker ${args[0]}\`: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      if (timedOut) {
        reject(
          new Error(
            `the image build exceeded its own ${Math.round(timeoutMs / 60_000)}-minute ` +
              'timeout (separate from the post-build watchdog, so this is "the build ' +
              'hung", not "a check hung")',
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(new Error(`\`docker ${args.slice(0, 3).join(' ')} ...\` exited ${code}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Spawn a child that LEADS ITS OWN PROCESS GROUP, so teardown can signal the group
 * and reach grandchildren.
 *
 * `npm run <script>` is `npm` with the real work as a grandchild, and `child.kill()`
 * reaches only `npm` — leaving the process that holds the database connection alive.
 *
 * This exists as a helper rather than two lines at the call site because the two
 * halves MUST NOT drift apart: `detached: true` is what makes the pid a group
 * leader, and the marker is what tells teardown to use a negative pid. Set the
 * marker without detaching and the group kill fails with ESRCH, which teardown can
 * only answer by killing the child alone — the grandchild then orphans while
 * teardown reports success. Verified: that is exactly what happens. Binding them
 * together in one function makes the mismatch unrepresentable.
 */
function spawnOwnGroup(cmd, args, opts2) {
  const child = spawn(cmd, args, { ...opts2, detached: true });
  child.__ownsProcessGroup = true;
  return child;
}

// ── teardown ────────────────────────────────────────────────────────────────
function killLiveChildren() {
  for (const child of liveChildren) {
    // Kill the child's whole PROCESS GROUP where it has one, not just the child.
    // `npm run db:migrate` is `npm` with drizzle-kit as a grandchild, and
    // `child.kill()` reaches only `npm` — leaving drizzle-kit orphaned. Children
    // that need this are spawned `detached: true` so they lead their own group and
    // the negative pid cannot possibly signal this process. Falls back to the plain
    // kill for the `docker` children, which have no group of their own.
    try {
      if (child.__ownsProcessGroup && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      // A group kill can legitimately fail with ESRCH — the group is already gone,
      // or the flag was set on a child that was NOT spawned `detached`, in which case
      // its pid leads no group. Swallowing that would leave the child alive while
      // teardown reported success: green while false, which is the failure shape this
      // file keeps finding. Always fall back to killing the child directly.
      try {
        child.kill('SIGKILL');
      } catch {
        /* genuinely gone */
      }
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  liveChildren.clear();
}

function printKeepInstructions() {
  const cs = [...containers];
  const ns = [...networks];
  if (!cs.length && !ns.length) return;
  console.log('\n--keep: resources left running. Remove them with:');
  if (cs.length) console.log(`  docker rm -f -v ${cs.join(' ')}`);
  if (ns.length) console.log(`  docker network rm ${ns.join(' ')}`);
  console.log(`  # or sweep every orphan of this harness: node scripts/verify-image.mjs --prune`);
}

/** Block the thread. Only ever called from teardown, where nothing else may run. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A synchronous `docker` listing, which THROWS rather than reporting nothing.
 *
 * The distinction is load-bearing and was a measured bug: this used to read
 * `r.stdout` unconditionally, so a `docker` that exited 125, or was not on PATH at
 * all, returned `[]` — indistinguishable from "the daemon holds nothing". The sweep
 * below would then see an empty listing, count it toward its quiet window, conclude
 * teardown was clean and leak in silence. A daemon that cannot answer is not
 * evidence of an empty daemon.
 */
function dockerSyncLines(args) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 20_000 });
  if (r.error) {
    throw new Error(`\`docker ${args[0]}\` could not run: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new Error(
      `\`docker ${args.join(' ')}\` exited ${r.status}: ` +
        (String(r.stderr ?? '').trim() || '(no stderr)').slice(0, 300),
    );
  }
  return String(r.stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * THE ONLY TEARDOWN. Synchronous, and used by every exit path: the end of
 * `main()`, the error path, `process.on('exit')`, SIGINT and SIGTERM.
 *
 * Synchronous because an exit handler cannot await, so async teardown there
 * silently does nothing — and having ONE implementation means the path that is
 * hardest to test cannot drift from the path that is easy to test. Blocking the
 * event loop here is not a cost: at teardown nothing else may proceed.
 *
 * It VERIFIES rather than fires and forgets, and it sweeps by LABEL rather than
 * only by name. Both were bought with a real bug: killing the `docker run` CLI
 * can land in the window between the daemon creating a container and starting
 * it, and a `docker rm -f <name>` issued in that window removes nothing — the
 * container then sits in state `created` with its `--rm` autoremove pending
 * forever, because AutoRemove only fires for a container that actually ran.
 * Observed: 12 leaked containers across a SIGINT sweep, all in state `created`,
 * all with `AutoRemove=true`. Name-based removal is the fast path; the
 * label-filtered re-check is what makes teardown actually true.
 *
 * That re-check used to stop after two consecutive empty listings — about 300 ms
 * of grace, on the assumption that a late container arrives within "a few
 * milliseconds". It does not: measured over 24 SIGINT runs, 1 leaked anyway, and
 * silently, since the leftover report also ran before the container existed. The
 * sweep now waits for a CONTINUOUS QUIET WINDOW (SWEEP_QUIET_MS) from the last
 * sighting, retries once more unconditionally at the end, and reports anything
 * that still survives. See sweepByLabelSync.
 *
 * Idempotent: the registries are emptied on the first call.
 */
let sweepDone = false;
let keepPrinted = false;

function cleanupSync() {
  killLiveChildren();
  if (opts.keep) {
    if (!keepPrinted) {
      keepPrinted = true;
      printKeepInstructions();
    }
    return;
  }
  // A signal handler runs cleanup and then `process.exit(1)`, which fires the
  // 'exit' handler, which would otherwise repeat the whole label sweep — two
  // more `docker ps`/`network ls` round-trips for nothing. Idempotence is kept
  // (the registries are emptied on the first call); this only skips the redo.
  if (sweepDone && !containers.size && !networks.size) return;
  const cs = [...containers];
  containers.clear();
  const ns = [...networks];
  networks.clear();

  // Fast path: remove what we know we created, by name.
  //
  // `-v` everywhere a container is removed. An image that declares a VOLUME makes
  // an anonymous volume on `docker run`, and `docker rm -f` without `-v` strands
  // it — a leak the container/network registries cannot see, so the harness would
  // report clean while leaking. Postgres is additionally run on a tmpfs so no such
  // volume exists in the first place; this is the backstop, not the fix.
  for (const c of cs) {
    spawnSync('docker', ['rm', '-f', '-v', c], { stdio: 'ignore', timeout: 30_000 });
  }

  // Correctness path: containers FIRST — `network rm` fails while an endpoint is
  // still attached.
  const listContainers = () =>
    dockerSyncLines(['ps', '-aq', '--filter', `label=${RUN_LABEL}=${RUN_ID}`]);
  const removeContainers = (ids) =>
    spawnSync('docker', ['rm', '-f', '-v', ...ids], { stdio: 'ignore', timeout: 30_000 });
  sweepByLabelSync('container', listContainers, removeContainers);

  for (const n of ns) {
    spawnSync('docker', ['network', 'rm', n], { stdio: 'ignore', timeout: 20_000 });
  }
  sweepByLabelSync('network', () =>
    dockerSyncLines(['network', 'ls', '-q', '--filter', `label=${RUN_LABEL}=${RUN_ID}`]),
  (ids) => spawnSync('docker', ['network', 'rm', ...ids], { stdio: 'ignore', timeout: 20_000 }));

  // ONE MORE CONTAINER LISTING, after the networks are gone, and it is FREE.
  //
  // The container sweep's reach ends at its own final pass — about 4.3 s from the
  // signal. The network sweep then spends another quiet window watching NETWORKS,
  // during which a late container create is invisible to anything. Measured: a
  // create scheduled 5 s after the signal slipped through exactly that hole. This
  // costs one `docker ps` because those seconds have already elapsed, and it takes
  // the container reach to roughly 8.5 s without adding any wall time.
  //
  // Deliberately NOT another quiet window: the point is to use time already spent,
  // not to buy more.
  recheckContainersSync(listContainers, removeContainers);

  sweepDone = true;
}

/** One listing, one removal, one confirmation. See the call site for why. */
function recheckContainersSync(list, remove) {
  let ids;
  try {
    ids = list();
  } catch (err) {
    console.error(
      `  (teardown) the post-network container re-check could not list (${err.message}); ` +
        'sweep with `node scripts/verify-image.mjs --prune`',
    );
    return;
  }
  if (!ids.length) return;
  console.error(
    `  (teardown) ${ids.length} container(s) appeared AFTER the container sweep finished ` +
      `(${ids.join(', ')}) — removing them in the post-network re-check`,
  );
  try {
    remove(ids);
  } catch (err) {
    console.error(`  (teardown) removing them threw: ${err.message}`);
  }
  sleepSync(250);
  let leftover = [];
  try {
    leftover = list();
  } catch {
    return;
  }
  if (leftover.length) {
    console.error(
      `  (teardown) ${leftover.length} container(s) still survive: ${leftover.join(', ')} — ` +
        'sweep them with `node scripts/verify-image.mjs --prune`',
    );
  }
}

/**
 * Remove everything this run labelled, and keep watching until the daemon's own
 * view has been EMPTY FOR A CONTINUOUS QUIET PERIOD rather than for a fixed number
 * of listings.
 *
 * That distinction is the whole fix. The previous version stopped after two
 * consecutive empty listings 150 ms apart — about 300 ms of grace — on the theory
 * that a container materialising "a few milliseconds" late would still be caught.
 * MEASURED, over 24 SIGINT runs: it is not. One run in 24 left a probe container in
 * state `created` with `AutoRemove=true`, because the daemon finished CREATING it
 * after the sweep had already concluded. `AutoRemove` does not rescue that: a
 * container that never reached `running` is never auto-removed, so the leak is
 * permanent and — worse — was SILENT, since the sweep's own leftover listing also
 * ran before the container appeared.
 *
 * SWEEP_QUIET_MS is therefore a wall-clock quiet window measured from the last
 * SIGHTING, and any sighting resets it. SWEEP_BUDGET_MS bounds the whole thing so a
 * daemon that keeps producing resources cannot hang teardown. This does not depend
 * on catching the container in a particular state, on the name registry, or on the
 * signal handler's bookkeeping: it depends only on the daemon's label-filtered
 * listing going quiet and staying quiet.
 *
 * It is not a proof, and the honest statement of what it buys matters more than a
 * reassuring one. The daemon's create latency after a client disconnect has no
 * documented bound, so this replaces a 300 ms window with a 4 s one, and the real
 * numbers say that is ample rather than lucky: across 24 SIGINT runs the race fired
 * 5 times, with the container DETECTED 284-618 ms after teardown began (a detection
 * time is an upper bound on the arrival, within one 100-500 ms poll). A further
 * re-check after the network sweep takes the container reach to about 8.5 s at no
 * extra wall-clock cost. Anything STILL PRESENT gets another removal attempt and is
 * then reported LOUDLY with the `--prune` command; a listing that FAILS is reported
 * as a failure rather than read as "nothing there". Something arriving later than the
 * whole teardown remains invisible to it — verified deliberately with the LEAK_REPRO
 * hook, which leaks at 30 s and (before the post-network re-check) at 5 s.
 * `--prune` is what recovers that case, and is what it is for.
 *
 * Cost on the happy path: one quiet window per sweep kind. Teardown is once per
 * process, against a run measured in minutes.
 */
function sweepByLabelSync(kind, list, remove) {
  const started = Date.now();
  let lastSighting = started;
  /** Elapsed ms of the last sighting, or -1 if nothing was ever listed. */
  let lastSightingAt = -1;
  /** Was the FIRST listing empty? If it was, anything seen later arrived after
   *  teardown began — which is the race, and the only interesting case. */
  let firstListingEmpty = null;
  /** Consecutive listing FAILURES. A daemon that cannot answer is not an empty
   *  daemon, so a failure must neither satisfy the quiet window nor be retried
   *  forever: bounded, then loud. */
  let listErrors = 0;
  let lastListError = null;
  let pollMs = 100;
  while (Date.now() - lastSighting < SWEEP_QUIET_MS) {
    if (Date.now() - started > SWEEP_BUDGET_MS) break;
    if (listErrors >= SWEEP_MAX_LIST_ERRORS) break;
    let ids;
    try {
      ids = list();
      listErrors = 0;
    } catch (err) {
      listErrors++;
      lastListError = err.message;
      // Hold the quiet window open: an unanswerable daemon must not be recorded as
      // a clean one, which is what silently reading an empty stdout used to do.
      lastSighting = Date.now();
      sleepSync(pollMs);
      pollMs = Math.min(pollMs * 2, 500);
      continue;
    }
    if (firstListingEmpty === null) firstListingEmpty = ids.length === 0;
    if (ids.length) {
      lastSighting = Date.now();
      lastSightingAt = lastSighting - started;
      try {
        remove(ids);
      } catch (err) {
        // A throw here would abort teardown for everything after it.
        console.error(`  (teardown) removing ${kind}(s) threw: ${err.message}`);
      }
    }
    sleepSync(pollMs);
    // Back off, so a long quiet window costs a handful of `docker ps` calls rather
    // than thirty. Capped well under the quiet window so a late arrival is still
    // seen with time to act on it.
    pollMs = Math.min(pollMs * 2, 500);
  }
  if (listErrors >= SWEEP_MAX_LIST_ERRORS) {
    console.error(
      `  (teardown) could not list ${kind}(s) — ${listErrors} consecutive failures, last: ` +
        `${lastListError}\n  Teardown CANNOT confirm it left nothing behind. Sweep with ` +
        '`node scripts/verify-image.mjs --prune` once the daemon answers again.',
    );
    return;
  }

  // FINAL PASS, unconditional. The loop above exits on a quiet window or on the
  // budget; either way, ask the daemon once more and try once more, so a resource
  // that appeared during the last sleep is removed rather than merely reported.
  // Measured to be load-bearing: with the LEAK_REPRO hook, a container landing
  // 2.9 s after the signal was removed HERE, not by the loop, because the loop's
  // quiet window had just elapsed.
  let leftover = [];
  let finalListFailed = false;
  try {
    leftover = list();
  } catch (err) {
    finalListFailed = true;
    lastListError = err.message;
  }
  if (leftover.length) {
    if (firstListingEmpty === null) firstListingEmpty = false;
    lastSightingAt = Date.now() - started;
    try {
      remove(leftover);
    } catch {
      /* reported below */
    }
    sleepSync(250);
    try {
      leftover = list();
    } catch (err) {
      finalListFailed = true;
      lastListError = err.message;
      leftover = [];
    }
  }
  if (finalListFailed) {
    // Say so rather than falling through to "nothing survived". The whole point of
    // the throwing listing is that an unanswered question is not a negative answer.
    console.error(
      `  (teardown) the final ${kind} listing FAILED (${lastListError}), so teardown ` +
        'cannot confirm it left nothing behind. Sweep with ' +
        '`node scripts/verify-image.mjs --prune`.',
    );
    return;
  }
  // Never let a teardown failure mask the real check failure: report and move on.
  if (leftover.length) {
    console.error(
      `  (teardown) ${leftover.length} ${kind}(s) survived: ${leftover.join(', ')} — ` +
        'sweep them with `node scripts/verify-image.mjs --prune`',
    );
  } else if (process.env.AITP_VERIFY_IMAGE_SWEEP_TRACE) {
    // Only under the trace hook, and it distinguishes the three outcomes that
    // otherwise look identical from the outside: nothing was ever there; something
    // was there when teardown started and was removed; or something APPEARED after
    // the first listing came back empty. Only the third is the race, and only the
    // third is what the old ~300 ms sweep could miss — so the elapsed time of that
    // sighting is the number that says whether SWEEP_QUIET_MS is wide enough.
    const detail =
      lastSightingAt < 0
        ? 'nothing was ever listed'
        : firstListingEmpty
          ? `APPEARED ${lastSightingAt}ms in, after an empty first listing, and was removed`
          : `present at the first listing, last sighting ${lastSightingAt}ms in, all removed`;
    console.error(
      `  (teardown) ${kind} sweep: ${detail} (sweep took ${Date.now() - started}ms)`,
    );
  }
}

let watchdog = null;
function armWatchdog(ms) {
  watchdog = setTimeout(() => {
    const human = ms < 60_000 ? `${ms}ms` : `${(ms / 60_000).toFixed(1)} minutes`;
    console.error(
      `\nharness watchdog: exceeded ${human} of post-build work. Failing rather than ` +
        'hanging the job.',
    );
    cleanupSync();
    process.exit(1);
  }, ms);
  // An unref'd timer still fires while main() is awaiting, and cannot itself be
  // the handle that pins a loop which would otherwise drain.
  watchdog.unref();
}

// ── platform helpers ────────────────────────────────────────────────────────
const DOCKER_ARCH = { aarch64: 'arm64', arm64: 'arm64', x86_64: 'amd64', amd64: 'amd64' };
/** npm/NAPI arch token for a docker platform arch. */
const NAPI_ARCH = { amd64: 'x64', arm64: 'arm64' };

function platformArch(platform) {
  const parts = platform.split('/');
  return parts[1] ?? '';
}

async function assertDockerAvailable() {
  try {
    const { stdout } = await docker(['version', '--format', '{{.Server.Version}}'], {
      timeoutMs: 30_000,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(
      'docker is unavailable — install the CLI and start the daemon. This harness ' +
        `cannot run without it.\n  underlying error: ${err.message}`,
    );
  }
}

async function hostPlatform() {
  const { stdout } = await docker(['info', '--format', '{{.OSType}}/{{.Architecture}}'], {
    timeoutMs: 30_000,
  });
  const [osType, arch] = stdout.trim().split('/');
  return `${osType || 'linux'}/${DOCKER_ARCH[arch] ?? arch}`;
}

// ── build / image checks ────────────────────────────────────────────────────
async function buildImage(platform, tag, emulated) {
  const timeoutMs = emulated ? BUILD_MS_EMULATED : BUILD_MS_NATIVE;
  console.log(
    `building ${tag} for ${platform} (no layer cache configured — see the ` +
      'verify-image job comment in ci.yml for why; budget for a cold build)',
  );
  await dockerStream(
    [
      'buildx',
      'build',
      '--platform',
      platform,
      '--load',
      '--file',
      path.join(ROOT, 'Dockerfile'),
      '--tag',
      tag,
      ROOT,
    ],
    { timeoutMs },
  );
}

async function assertImageMatchesPlatform(tag, platform) {
  let inspected;
  try {
    const { stdout } = await docker(['image', 'inspect', tag, '--format', '{{.Architecture}}'], {
      timeoutMs: 30_000,
    });
    inspected = stdout.trim();
  } catch {
    throw new Error(
      `no local image tagged \`${tag}\`. Drop --no-build to build it, or pass ` +
        '--tag with a tag that exists.',
    );
  }
  const want = platformArch(platform);
  if (inspected !== want) {
    throw new Error(
      `image \`${tag}\` is ${inspected} but --platform asked for ${want}. Running it ` +
        'would fail with an opaque `exec format error`; rebuild without --no-build.',
    );
  }
}

// ── static probes ───────────────────────────────────────────────────────────
//
// Each probe is a small script whose ONLY output is one JSON line, so a parse
// failure is attributable to a single probe rather than to "the harness".

const PROBE_NAPI = `
const m = require('aitp');
process.stdout.write(JSON.stringify({ aitpAgent: typeof m.AitpAgent }));
`;

/**
 * Prove the OpenTelemetry tree was TRACED, not merely installed.
 *
 * A bare `require.resolve('@opentelemetry/sdk-node')` — which is what this probe
 * used to be — runs from the image's WORKDIR `/app` and therefore resolves
 * through `/app/node_modules`. That answers "is the package installed and
 * loadable", which is a different and much weaker question: an image with
 * `.next/node_modules/@opentelemetry` deleted outright still passed. Verified,
 * not theorised — five of the eight traced externals can vanish while the check
 * that names them stays green.
 *
 * So look where tracing actually puts things: the `@opentelemetry` scope
 * directory under `.next/node_modules`, and `sdk-node` resolved THROUGH that
 * traced path rather than through the flat install.
 */
const PROBE_OTEL = `
const fs = require('fs');
const SCOPE = ${JSON.stringify(`${TRACED_DIR}/@opentelemetry`)};
// The entries INSIDE the scope directory carry the 16-hex Turbopack suffix too
// (e.g. sdk-node-2cf9b989c3033bc0), so look the package up by its stripped name.
// Hardcoding a hash here would break on the next dependency bump.
function strip(n) { return n.replace(/-[0-9a-f]{16}$/, ''); }
let scopeEntries = null, scopeError = null;
try { scopeEntries = fs.readdirSync(SCOPE).sort(); }
catch (e) { scopeError = e.message; }
const entry = (scopeEntries || []).filter(function (n) { return strip(n) === 'sdk-node'; })[0] || null;
let tracedRealpath = null, tracedResolved = null, tracedError = null;
if (entry) {
  try { tracedRealpath = fs.realpathSync(SCOPE + '/' + entry); }
  catch (e) { tracedError = 'realpath: ' + e.message; }
  try { tracedResolved = require.resolve(SCOPE + '/' + entry); }
  catch (e) { tracedError = (tracedError ? tracedError + '; ' : '') + 'require.resolve: ' + e.message; }
}
process.stdout.write(JSON.stringify({
  scopeEntries: scopeEntries, scopeError: scopeError, entry: entry,
  stripped: (scopeEntries || []).map(strip).sort(),
  tracedRealpath: tracedRealpath, tracedResolved: tracedResolved, tracedError: tracedError,
}));
`;

/**
 * Walk the traced-externals tree and report every leaf.
 *
 * Recurses THROUGH scope directories: `.next/node_modules/@opentelemetry` is a
 * real directory holding five symlinks, not a symlink itself, so a sweep that
 * asserts "every entry is a symlink" fails on a healthy image.
 */
const PROBE_SWEEP = `
const fs = require('fs');
const path = require('path');
const ROOT = ${JSON.stringify(TRACED_DIR)};
const RESOLVE_FROM = ${JSON.stringify(RESOLVE_FROM)};
const leaves = [];
const anomalies = [];
function walk(dir, prefix, depth) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    const spec = prefix ? prefix + '/' + ent.name : ent.name;
    if (ent.isSymbolicLink()) {
      const leaf = { spec: spec, realpath: null, resolved: null, error: null };
      try { leaf.realpath = fs.realpathSync(full); }
      catch (e) { leaf.error = 'realpath: ' + e.message; }
      try { leaf.resolved = require.resolve(spec, { paths: [RESOLVE_FROM] }); }
      catch (e) { leaf.error = (leaf.error ? leaf.error + '; ' : '') + 'require.resolve: ' + e.message; }
      leaves.push(leaf);
    } else if (ent.isDirectory() && ent.name.charAt(0) === '@' && depth === 0) {
      walk(full, spec, depth + 1);
    } else {
      anomalies.push({ spec: spec, kind: ent.isDirectory() ? 'directory' : 'file' });
    }
  }
}
let exists = true;
try { fs.statSync(ROOT); } catch (e) { exists = false; }
// require.resolve() walks up from its start path and SUCCEEDS even when that
// path does not exist, so resolution alone would not prove the server chunks
// are really there. Assert it separately.
let resolveFromExists = true;
try { fs.statSync(RESOLVE_FROM); } catch (e) { resolveFromExists = false; }
let error = null;
if (exists) { try { walk(ROOT, '', 0); } catch (e) { error = e.message; } }
leaves.sort(function (a, b) { return a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0; });
process.stdout.write(JSON.stringify({ exists: exists, resolveFromExists: resolveFromExists, error: error, leaves: leaves, anomalies: anomalies }));
`;

/**
 * Inventory every `.node` in the image.
 *
 * `fs.readdirSync(dir, {recursive:true})` rather than `find`: it depends on
 * nothing beyond `node`, comes back structured, and does not follow symlinks
 * (so the hashed traced entries are not counted twice).
 */
const PROBE_NATIVE = `
const fs = require('fs');
let files = [];
let error = null;
try {
  files = fs.readdirSync(${JSON.stringify(APP_DIR)}, { recursive: true })
    .filter(function (p) { return String(p).slice(-5) === '.node'; })
    .map(function (p) { return String(p).split('\\\\').join('/'); })
    .sort();
} catch (e) { error = e.message; }
process.stdout.write(JSON.stringify({ error: error, files: files }));
`;

/**
 * Read the middleware matchers and the full built-route list out of the image.
 *
 * WHY STATIC RATHER THAN MORE HTTP PROBES. Any FINITE set of probed paths can be
 * satisfied by a matcher that enumerates exactly those paths. Measured, twice: a
 * matcher of `['/api/audit']` defeats a one-path probe set, and
 * `['/api/audit', '/api/webhooks', '/api/health']` defeats the three-path set that
 * replaced it — 11/11 green while /api/sessions, /api/tcts, /api/delegations,
 * /api/trust-anchors and /api/pinned-keys all answered anonymously, and an
 * anonymous POST reached a handler's body validation. Adding a fourth probe just
 * moves the goalposts one token. The artifact RECORDS the matcher, so the whole
 * tree can be checked instead of sampled.
 *
 * The regexps are evaluated INSIDE the container by the same Node that serves the
 * app, so this borrows Next's own compiled semantics rather than reimplementing
 * path-to-regexp on the host and hoping the two agree.
 *
 * NOT `middleware-manifest.json`: it is `{"middleware":{},"sortedMiddleware":[]}`
 * in this image — and, verified, also in an image whose gate IS attached — so a
 * check written against it would be vacuously green forever.
 */
const PROBE_MIDDLEWARE = `
const P = '/app/.next/server/functions-config-manifest.json';
let error = null, routes = [], matchers = [], uncovered = [];
try {
  const f = require(P).functions || {};
  const mw = f['/_middleware'];
  // Carry the matcher objects WHOLE. Keeping only regexp/originalSource dropped
  // \`has\`/\`missing\` conditions, which Next enforces at runtime — so a matcher of
  // { source: '/api/:path*', missing: [{type:'header',key:'cookie'}] } looked
  // IDENTICAL to the correct one while any request carrying a cookie (i.e. every
  // browser request) bypassed the gate entirely. Measured: GET /api/audit with a
  // cookie returned the admin audit log. Unknown keys are the danger, so report
  // them all and let the host decide.
  matchers = ((mw && mw.matchers) || []).map(function (m) {
    const out = {};
    Object.keys(m).sort().forEach(function (k) { out[k] = m[k]; });
    return out;
  });
  const res = matchers.map(function (m) { return new RegExp(m.regexp); });
  routes = Object.keys(f)
    .filter(function (k) { return k === '/api' || k.indexOf('/api/') === 0; })
    .sort();
  // Dynamic segments must become something concrete before they can be tested.
  // Catch-alls first, so [...slug] is not eaten by the single-segment pattern.
  uncovered = routes.filter(function (r) {
    const c = r
      .replace(/\\[\\[\\.\\.\\.[^\\]]+\\]\\]/g, 'a/b')
      .replace(/\\[\\.\\.\\.[^\\]]+\\]/g, 'a/b')
      .replace(/\\[[^\\]]+\\]/g, 'a');
    return !res.some(function (re) { return re.test(c); });
  });
} catch (e) { error = String((e && e.message) || e); }
process.stdout.write(JSON.stringify({
  error: error, routes: routes, matchers: matchers, uncovered: uncovered,
}));
`;

/**
 * Run one probe script inside the image and parse its single JSON line.
 *
 * The container is named and registered for teardown BEFORE it is started, so a
 * signal mid-probe sweeps it even if `--rm` never fires.
 */
async function probe(tag, platform, label, script) {
  try {
    return await runProbe(tag, platform, label, script);
  } catch (err) {
    // NEVER throw out of a probe. A probe that fails — including one whose script
    // throws INSIDE the container, e.g. `require('aitp')` when the native binary
    // is missing — must surface as a NAMED check failure carrying the container's
    // own stderr, not abort the run with an unattributable `docker run ... exited 1`.
    // Aborting also skipped the structural-check gate that makes `--update-baseline`
    // refuse a broken image, so the refusal was never reached.
    // Wrapped in a Proxy so that FORGETTING `requireProbe` is loud rather than
    // silent. Without it, a new check reading `napi.aitpAgent` off a failed probe
    // gets `undefined` and reports a confident, wrong diagnosis ("expected
    // function, got undefined") instead of the container's real error. Every
    // property but `__error` throws.
    return failedProbe(label, err.message);
  }
}

/**
 * A failed probe's result: carries `__error`, throws on everything else.
 *
 * `then` must stay readable and undefined — `await`ing this object would
 * otherwise throw inside the microtask queue rather than at the access site.
 */
function failedProbe(label, message) {
  return new Proxy(
    { __error: message },
    {
      get(target, prop) {
        if (prop === '__error' || prop === 'then' || typeof prop === 'symbol') {
          return target[prop];
        }
        throw new Error(
          `probe \`${label}\` failed and its result was read (.${String(prop)}) without ` +
            `going through requireProbe(). The underlying failure was:\n${message}`,
        );
      },
    },
  );
}

/** Fail the current check with the probe's recorded error, if it had one. */
function requireProbe(result, label) {
  if (result?.__error) {
    fail(`probe \`${label}\` failed:\n${result.__error}`);
  }
  return result;
}

/**
 * REGRESSION REPRO for the SIGINT container-leak race. Inert unless the hook is set.
 *
 * `AITP_VERIFY_IMAGE_LEAK_REPRO=<ms>[:<probe-label>]` makes the race DETERMINISTIC
 * instead of one run in 24. At the exact lifecycle point where the leak was observed
 * — a probe container registered, its `docker run` about to be SIGKILLed by a signal
 * — it does two things:
 *
 *   1. Schedules, in a DETACHED process that outlives this one, a
 *      `docker create --rm` of a run-labelled container that lands <ms> AFTER the
 *      signal. That is exactly what the daemon leaves behind when the `docker run`
 *      client is killed mid-create: a container in state `created` with
 *      AutoRemove=true which is never auto-removed, because AutoRemove only fires
 *      for a container that actually ran. Synthesising it is the only way to
 *      SCHEDULE the daemon's create latency rather than wait for it to bite.
 *   2. Raises SIGINT on this process, so the real teardown path runs — the real
 *      handler, the real `cleanupSync`, the real label sweep.
 *
 * The synthetic container is deliberately NOT registered in `containers`, so the
 * by-name fast path cannot find it and only the label sweep can. That is the
 * property under test.
 *
 * Measured results:
 *   - the old two-empty-listings sweep (~300 ms grace): every <ms> above ~400 LEAKS,
 *     and leaks SILENTLY — its leftover listing also ran before the container
 *     existed. 3 runs out of 3 at <ms>=1200.
 *   - the quiet-window sweep plus the post-network re-check: caught and removed at
 *     1200, 1500, 2500, 2900, 3500 and 5000 ms, with
 *     AITP_VERIFY_IMAGE_SWEEP_TRACE=1 printing when it was detected. Still leaks at
 *     30000 ms, which is past the whole teardown and is `--prune`'s job.
 */
function maybeLeakRepro(tag, name) {
  const raw = process.env.AITP_VERIFY_IMAGE_LEAK_REPRO;
  if (!raw) return;
  const [msRaw, wantLabel] = String(raw).split(':');
  const ms = Number(msRaw);
  if (!Number.isFinite(ms) || ms <= 0) return;
  if (wantLabel && !name.endsWith(`probe-${wantLabel}`)) return;
  const late = `${name}-late`;
  const child = spawn(
    'sh',
    [
      '-c',
      `sleep ${(ms / 1000).toFixed(3)}; exec docker create --rm --name ${late} ` +
        `--label ${LABEL}=1 --label ${RUN_LABEL}=${RUN_ID} --entrypoint true ${tag}`,
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  console.error(
    `LEAK REPRO: ${late} will be created ${ms}ms from now, in state \`created\` with ` +
      'AutoRemove=true, registered nowhere but the run label. Raising SIGINT.',
  );
  // Asynchronous delivery, so the `docker run` below is genuinely in flight when
  // the handler tears down — the state the leak was observed in.
  process.kill(process.pid, 'SIGINT');
}

async function runProbe(tag, platform, label, script) {
  const name = nameFor(`probe-${label}`);
  containers.add(name);
  maybeLeakRepro(tag, name);
  try {
    const { stdout, stderr } = await docker(
      [
        'run',
        '--rm',
        '--name',
        name,
        '--platform',
        platform,
        ...labelArgs(),
        // BLANK THE PRELOAD VARIABLES. A probe is `node -e <script>` run from the
        // image, so it inherits the IMAGE's environment — and an image carrying
        // `ENV NODE_OPTIONS=--require=/app/lie.js` therefore executes its own code
        // inside every probe, including the one that reports the matcher check 11
        // pins. Measured: the preload ran. That made the artifact the reporter of
        // the facts it was being judged on.
        //
        // These `-e VAR=` forms set each variable to empty rather than unsetting it,
        // which is what `docker run` offers and is sufficient: Node treats an empty
        // NODE_OPTIONS as no options. This is defence in depth, not the fix —
        // check 13 PINS the image's Env, so a preload is a failed equality and not
        // merely a neutralised one, and check 13's own extraction does not run any
        // code from the image at all.
        '-e',
        'NODE_OPTIONS=',
        '-e',
        'NODE_REPL_EXTERNAL_MODULE=',
        '--entrypoint',
        'node',
        tag,
        '-e',
        script,
      ],
      { timeoutMs: PROBE_MS },
    );
    const line = stdout.trim();
    if (!line) {
      throw new Error(`probe \`${label}\` produced no output.\nstderr: ${stderr.trim()}`);
    }
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(
        `probe \`${label}\` did not emit parseable JSON:\n${line.slice(0, 2000)}`,
      );
    }
  } finally {
    containers.delete(name);
  }
}

// ── the gate-code pin: extraction (check 13) ────────────────────────────────
//
// WHY THIS EXISTS AT ALL, in one paragraph, because the reasoning cost eight rounds
// to arrive at and is easy to undo by accident.
//
// Checks 8-12 establish that the gate is ATTACHED: the matcher set and the built
// route identities are pinned equalities, and a handful of requests show the gate
// actually runs. None of them can see a gate that is attached, matched, invoked —
// and WRONG. The previous answer to that was to probe the gate's behaviour over the
// whole route population, and it was defeated five times running, each time by a
// dimension the probes did not vary: the verb, the route population, the id shape,
// the id LENGTH, and the presence of an `Origin` header. The mechanism never changed:
// a check that SAMPLES what the runtime decides on is satisfiable by something
// narrower than the check's own prose claims, and the space of request shapes is not
// finite, so no number of added dimensions closes it.
//
// So this stops asking what the gate DOES and asserts what the gate IS. All five of
// those defeats are edits to one compiled function; this check compares that function
// — and every other byte the middleware executes — to a committed copy. There is no
// sample, so there is no dimension left to vary. The cost is a real one and is
// accepted rather than designed around: a Next or Turbopack upgrade that recompiles
// the same source differently FAILS this check and needs a re-pin, with no behaviour
// change to show for it. That is the price of an equality, and the two halves below
// are arranged so the re-pin is a five-second triage rather than a leap of faith.

/** Hex SHA-256 of a buffer. */
function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Split a Turbopack server chunk into its modules.
 *
 * The emitted shape is a flat array of alternating id and factory:
 *
 *   module.exports=[21025,(e,t,r)=>{...},9254,(e,t,r)=>{...},...];
 *
 * so the modules ARE separable without evaluating anything. Brace-matching over
 * minified JavaScript has exactly one hazard — a `}` or `)` inside a string,
 * template, regex literal or comment — so those four are skipped rather than
 * counted. Anything unparseable THROWS: the caller turns that into a named check
 * failure, which is the fail-closed direction. A chunk this function cannot read is
 * not a chunk this harness may bless.
 */
/**
 * Is the `/` at `p` the start of a regex literal, or a division operator?
 *
 * The standard lexical rule: after a value-producing token it is division, otherwise
 * it begins a regex. A wrong answer here can only miscount a brace, which surfaces
 * as a throw from the scanner rather than as a wrong extraction.
 */
const REGEX_OK_AFTER = [
  'return', 'typeof', 'in', 'of', 'case', 'new', 'delete', 'void', 'do', 'else',
  'yield', 'instanceof',
];
function regexAllowedAt(text, p) {
  let k = p - 1;
  while (k >= 0 && /\s/.test(text[k])) k--;
  if (k < 0) return true;
  if (!/[A-Za-z0-9_$)\]]/.test(text[k])) return true;
  const word = /[A-Za-z0-9_$]+$/.exec(text.slice(Math.max(0, k - 12), k + 1));
  return !!(word && REGEX_OK_AFTER.includes(word[0]));
}

/**
 * End offset of the string, template, regex literal or comment starting at `p`, or
 * -1 if none does.
 *
 * ONE implementation, shared by both scanners below, so they cannot develop
 * different opinions about what a literal is — a disagreement between a locator and
 * a bounds check is the sort of seam this phase has been bitten by.
 */
function skipLiteralAt(text, p) {
  const n = text.length;
  const c = text[p];
  if (c === '"' || c === "'") {
    let k = p + 1;
    while (k < n) {
      if (text[k] === '\\') {
        k += 2;
        continue;
      }
      if (text[k] === c) return k + 1;
      k++;
    }
    throw new Error(`unterminated string literal at offset ${p}`);
  }
  if (c === '`') {
    // Template literals nest: `${ }` may contain further templates. Track the
    // substitution depth so a `}` closing a substitution is not read as the end.
    let k = p + 1;
    let depth = 0;
    while (k < n) {
      if (text[k] === '\\') {
        k += 2;
        continue;
      }
      if (text[k] === '$' && text[k + 1] === '{') {
        depth++;
        k += 2;
        continue;
      }
      if (depth > 0 && text[k] === '}') {
        depth--;
        k++;
        continue;
      }
      if (depth === 0 && text[k] === '`') return k + 1;
      k++;
    }
    throw new Error(`unterminated template literal at offset ${p}`);
  }
  if (c === '/' && text[p + 1] === '/') {
    const k = text.indexOf('\n', p);
    return k < 0 ? n : k + 1;
  }
  if (c === '/' && text[p + 1] === '*') {
    const k = text.indexOf('*/', p);
    if (k < 0) throw new Error(`unterminated block comment at offset ${p}`);
    return k + 2;
  }
  if (c === '/' && regexAllowedAt(text, p)) {
    let k = p + 1;
    let inClass = false;
    while (k < n) {
      if (text[k] === '\\') {
        k += 2;
        continue;
      }
      if (text[k] === '[') {
        inClass = true;
        k++;
        continue;
      }
      if (text[k] === ']') {
        inClass = false;
        k++;
        continue;
      }
      if (text[k] === '/' && !inClass) {
        k++;
        while (k < n && /[a-z]/.test(text[k])) k++; // flags
        return k;
      }
      if (text[k] === '\n') throw new Error(`unterminated regex literal at offset ${p}`);
      k++;
    }
    throw new Error(`unterminated regex literal at offset ${p}`);
  }
  return -1;
}

function parseChunkModules(text) {
  const head = 'module.exports=[';
  const at = text.indexOf(head);
  if (at < 0) throw new Error('the chunk does not begin with `module.exports=[`');
  let i = at + head.length;
  const n = text.length;
  const mods = [];
  const skipLiteral = (p) => skipLiteralAt(text, p);

  for (;;) {
    while (i < n && /[\s,]/.test(text[i])) i++;
    if (i >= n || text[i] === ']') break;
    const m = /^(\d+)/.exec(text.slice(i, i + 24));
    if (!m) {
      throw new Error(
        `expected a module id at offset ${i}, found ${JSON.stringify(text.slice(i, i + 40))}`,
      );
    }
    const id = Number(m[1]);
    i += m[1].length;
    while (i < n && /[\s,]/.test(text[i])) i++;
    const start = i;
    let depth = 0;
    for (;;) {
      if (i >= n) throw new Error(`the factory for module ${id} is unterminated`);
      const skipped = skipLiteral(i);
      if (skipped >= 0) {
        i = skipped;
        continue;
      }
      const c = text[i];
      if (c === '(' || c === '[' || c === '{') {
        depth++;
        i++;
        continue;
      }
      if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break; // the array's own closing bracket
        depth--;
        i++;
        continue;
      }
      if (c === ',' && depth === 0) break; // the next module id
      i++;
    }
    mods.push({ id, src: text.slice(start, i) });
  }
  if (!mods.length) throw new Error('the chunk holds no modules');
  return mods;
}

/**
 * End offset (exclusive) of the balanced call whose `(` follows `from`.
 *
 * Used to find where an `e.s([...])` export registration ends. It stops the instant
 * the parenthesis depth returns to zero, so trailing code after the call cannot
 * extend the range; shares `skipLiteralAt` so it cannot disagree with the module
 * scanner about what a literal is.
 */
function endOfBalancedCall(text, from) {
  const open = text.indexOf('(', from);
  if (open < 0) throw new Error(`no \`(\` after offset ${from}`);
  const n = text.length;
  let i = open;
  let depth = 0;
  for (;;) {
    if (i >= n) throw new Error(`the call at offset ${open} is unbalanced`);
    const skipped = skipLiteralAt(text, i);
    if (skipped >= 0) {
      i = skipped;
      continue;
    }
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') {
      depth++;
      i++;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      i++;
      if (depth === 0) return i;
      if (depth < 0) throw new Error(`the call at offset ${open} closes too early`);
      continue;
    }
    i++;
  }
}

/**
 * Copy files OUT of an image without ever starting it.
 *
 * `docker create` makes a container in state `created`; `docker cp` reads its
 * filesystem; `docker rm` removes it. Nothing in the image executes — no
 * entrypoint, no `node`, and therefore no `NODE_OPTIONS` preload. That is a
 * deliberate departure from the other probes, which run `node -e` inside the image
 * and so let the artifact under test participate in reporting on itself. For the
 * check that pins the gate's own bytes, that participation is exactly what must not
 * happen, so the extraction path contains no artifact-controlled code at all.
 */
/**
 * Create a container from the image WITHOUT starting it, hand `fn` a set of copy
 * primitives, and remove the container afterwards.
 *
 * `docker create` makes a container in state `created`; nothing in the image
 * executes — no entrypoint, no `node`, no `NODE_OPTIONS` preload — and `docker cp`
 * reads its filesystem cold. That is the property the gate-code pin depends on: the
 * one check whose whole claim is that the artifact did not participate in reporting
 * on itself must read the artifact without running any of it.
 *
 * `readFile(containerPath)` returns the file's bytes. `hashTree(containerDir)`
 * copies a whole directory out and returns a SHA-256 over its sorted
 * (relative-path, content) pairs — computed on the HOST, so still no image code
 * runs. Mtimes and ordering are excluded deliberately: only bytes and names matter.
 */
async function withImageContainer(tag, platform, fn) {
  const name = nameFor('extract');
  containers.add(name);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aitp-gate-pin-'));
  let seq = 0;
  try {
    await docker(['create', '--name', name, '--platform', platform, ...labelArgs(), tag], {
      timeoutMs: DEFAULT_DOCKER_MS,
    });
    const readFile = async (cPath) => {
      const dest = path.join(dir, `f${seq++}`);
      try {
        await docker(['cp', `${name}:${cPath}`, dest], { timeoutMs: DEFAULT_DOCKER_MS });
      } catch (err) {
        throw new Error(`could not copy ${cPath} out of the image: ${err.message}`);
      }
      return readFileSync(dest);
    };
    const hashTree = async (cDir) => {
      const dest = path.join(dir, `d${seq++}`);
      try {
        await docker(['cp', `${name}:${cDir}`, dest], { timeoutMs: DEFAULT_DOCKER_MS });
      } catch (err) {
        throw new Error(`could not copy the tree ${cDir} out of the image: ${err.message}`);
      }
      const files = [];
      const walk = (d) => {
        for (const ent of readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, ent.name);
          if (ent.isDirectory()) walk(full);
          else if (ent.isFile()) files.push(full);
        }
      };
      walk(dest);
      files.sort();
      const h = createHash('sha256');
      for (const f of files) {
        h.update(path.relative(dest, f).split(path.sep).join('/'));
        h.update('\0');
        h.update(readFileSync(f));
      }
      return { sha256: h.digest('hex'), count: files.length };
    };
    return await fn({ readFile, hashTree });
  } finally {
    // Remove by name first; the label sweep in cleanupSync is the backstop.
    try {
      await docker(['rm', '-f', name], { timeoutMs: DEFAULT_DOCKER_MS, allowFail: true });
    } finally {
      containers.delete(name);
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** The pinned subset of `docker image inspect`'s Config, in a fixed key order. */
async function readImageConfig(tag) {
  const { stdout } = await docker(['image', 'inspect', tag, '--format', '{{json .Config}}'], {
    timeoutMs: DEFAULT_DOCKER_MS,
  });
  let cfg;
  try {
    cfg = JSON.parse(stdout.trim());
  } catch (err) {
    throw new Error(`could not parse \`docker image inspect\` Config: ${err.message}`);
  }
  const out = {};
  for (const k of PINNED_IMAGE_CONFIG_FIELDS) {
    const v = cfg?.[k] ?? null;
    // Env is order-insensitive as far as the runtime is concerned, so sort it: a
    // Dockerfile reordering its own ENV lines must not read as a security event.
    // Entrypoint and Cmd are argument VECTORS and their order is meaning, so they
    // are left exactly as they are.
    out[k] = k === 'Env' && Array.isArray(v) ? [...v].sort() : v;
  }
  return out;
}

/**
 * Follow one Turbopack standalone loader (`.next/server/<name>.js`) to the set of
 * files it pulls in, deriving that set FROM THE LOADER rather than hardcoding it.
 *
 * The loader names the runtime chunk it requires, the chunks it registers with
 * `R.c(...)`, and the id of the entry module it instantiates with `R.m(<id>)`. So a
 * Next upgrade that splits the code differently is followed, and because the file
 * NAMES are pinned, a swap to a different chunk is a diff rather than a silent
 * redirection. Returns `{ files, entryId, texts }` — `files` prefixed with `label/`
 * so two loaders' file lists compose without colliding, `texts` for the chunk source
 * the region locator reads.
 *
 * THE SET IS A TRANSITIVE CLOSURE, NOT THE LOADER'S DIRECT REGISTRATIONS, and that
 * distinction is a measured defeat rather than a precaution. `R.c(...)` names only the
 * chunks registered EAGERLY at boot; a chunk can load further chunks LAZILY at runtime
 * with `e.v(t=>Promise.all(["server/chunks/X.js"].map(t=>e.l(t))))`, and such a chunk
 * still executes in the same module realm. Measured: `instrumentation.js`'s entry
 * module is `register()`, which the middleware entry `await`s in the GATE'S realm via
 * `_ENTRIES.middleware_instrumentation`; `register()` unconditionally awaits a module
 * that lazily loads `[root-of-the-server]__1up5uol._.js`. That chunk is named by no
 * `R.c(...)`, and it lives under `.next/server/chunks` rather than
 * `/app/node_modules/next`, so it was in NEITHER `bootGraph` NOR `nextTreeSha` — yet
 * appending a `Set.prototype.has` shim to it re-pointed the gate's own
 * `PUBLIC_PATHS.has(pathname)` and served four un-probed admin routes to anonymous
 * callers while ALL THIRTEEN CHECKS STAYED GREEN, the gate region byte-identical.
 *
 * So every collected chunk's text is scanned for `"server/chunks/….js"` references and
 * those are followed to a FIXPOINT. A closure, not another enumerated file: the
 * previous fix added the one chunk that defeat used, and the same class reopened one
 * level down. Do not "simplify" this back to a single pass.
 *
 * It is deliberately NOT a blanket digest of `.next/server`: the per-route handler
 * chunks (`_next-internal_server_app_api_*`) are loaded by the app-server's own route
 * realm and are NOT reachable from these two loaders, so they stay out of the closure
 * and adding an `/api/*` route still moves nothing in the pin. Measured: the closure is
 * 10 chunks and contains no route-handler chunk. Hashing all of `.next/server` instead
 * would fold every route chunk in and make the pin churn on ordinary feature work —
 * trading a real property away for no extra coverage of the gate's realm.
 *
 * A referenced chunk that cannot be read is a FAILURE, never a skip: a dangling lazy
 * reference is either a broken build or a file removed to shrink the pinned set.
 */
async function followLoader(readFile, containerPath, label) {
  const buf = await readFile(containerPath);
  const loader = buf.toString('utf8');
  const runtime = /require\("\.\/(chunks\/[^"]+)"\)/.exec(loader);
  if (!runtime) {
    throw new Error(
      `${containerPath} does not require a Turbopack runtime chunk, so its file set ` +
        'cannot be derived from it. Either this is not a Turbopack standalone build or ' +
        'the loader shape changed.',
    );
  }
  const entry = /R\.m\((\d+)\)/.exec(loader);
  if (!entry) throw new Error(`${containerPath} names no entry module (no \`R.m(<id>)\`)`);
  const registered = [...loader.matchAll(/R\.c\("server\/(chunks\/[^"]+)"\)/g)].map((m) => m[1]);
  const files = [
    { path: `${label}/${path.basename(containerPath)}`, bytes: buf.length, sha256: sha256Hex(buf) },
  ];
  const texts = new Map();
  // Breadth-first to a fixpoint from the loader's own seeds. BFS order is preserved and
  // the set de-duplicated, so the pinned list reads as the load order and a re-ordering
  // is visible; the eagerly-registered chunks therefore still come first.
  const queue = [runtime[1], ...registered];
  const seen = new Set();
  while (queue.length) {
    const r = queue.shift();
    if (seen.has(r)) continue;
    seen.add(r);
    // A read failure propagates: see the doc comment — a dangling lazy reference fails
    // closed rather than quietly shrinking the pinned set.
    const b = await readFile(`/app/.next/server/${r}`);
    files.push({ path: `${label}/${r}`, bytes: b.length, sha256: sha256Hex(b) });
    const text = b.toString('utf8');
    texts.set(r, text);
    // The lazy-chunk reference shape: `e.l("server/chunks/X.js")`, reached via
    // `e.v(t=>Promise.all([...].map(t=>e.l(t))))`. Matching the STRING LITERAL rather
    // than the call keeps this robust to minifier renames of `e`/`l`/`v`, which is the
    // same reason the region locator anchors on a literal.
    for (const m of text.matchAll(/"server\/(chunks\/[^"]+\.js)"/g)) {
      if (!seen.has(m[1])) queue.push(m[1]);
    }
  }
  return { files, entryId: Number(entry[1]), texts };
}

/**
 * Everything check 13 compares, read out of the image.
 *
 * The pin covers the CODE ON THE GATE'S LOAD PATH, not just the gate's own chunk —
 * and that breadth is the fix for a defeat measured against the narrower version. An
 * equality on the gate chunk's bytes proves the reviewed gate is present ON DISK; it
 * does NOT by itself prove that code EXECUTES, because anything that runs earlier in
 * the same process can rewrite the gate in memory before it is called. Two such
 * channels were demonstrated: a `Module.prototype._compile` hook planted in the
 * standalone boot script `/app/server.js` (which `require`s the Next server that
 * loads the middleware chunk), and code appended to the INSTRUMENTATION chunk, which
 * the middleware entry `await`s in the same module realm at boot. Both left the gate
 * chunk byte-identical while opening an un-probed route to anonymous callers. So the
 * pinned set is the transitive load path a `docker cp` can see:
 *
 *   bootGraph     — server.js, the MIDDLEWARE loader's chunk graph, and the
 *                   INSTRUMENTATION loader's chunk graph, every file by SHA-256. This
 *                   is the COMPLETE half over the app-authored + compiled code: any
 *                   byte of any of it changing lands here, needing no locator.
 *   nextTreeSha   — one aggregate SHA-256 over the whole `/app/node_modules/next`
 *                   framework tree (985 files here), because that is the code that
 *                   loads and invokes the middleware chunk and a hook installed there
 *                   would rewrite the gate before it runs. Measured byte-identical
 *                   across linux/amd64 and linux/arm64, and it moves only on a `next`
 *                   bump — the same event that moves the gate region — so it adds no
 *                   new churn event.
 *   region        — the compiled gate itself, extracted from the middleware entry
 *                   module (compiled `PUBLIC_PATHS` set literal → end of the export
 *                   registration naming `"proxy"`), committed VERBATIM. The REVIEWABLE
 *                   half: 2.8 KB, so a mismatch prints a located diff. Narrower than
 *                   the graph on purpose and NOT relied on for completeness.
 *   imageConfig   — Env / Entrypoint / Cmd / WorkingDir / User: what runs at all.
 *
 * WHAT IS OUT OF SCOPE, stated because a `docker cp` check cannot honestly claim
 * otherwise: the `node` binary, libc and the base OS. They are supplied by the
 * Dockerfile's `FROM` and a check that READS files out of the image cannot out-trust
 * the runtime that would EXECUTE them — a tampered `node` could ignore the very bytes
 * this check verified. Base-image integrity is the `FROM` pin's job. And against a
 * fully arbitrary in-image rewrite, checks 8-12 are the necessary behavioural
 * complement: they prove the gate that runs still refuses the probed routes. This
 * check raises the bar from "a one-line edit to the gate chunk" (invisible to
 * checks 8-12 on an un-probed route) to "tamper with the framework tree or the base
 * image", and names the boundary rather than papering over it.
 *
 * The verdict/triage split: bootGraph or nextTreeSha differing while the region
 * matches means framework bytes moved and the gate did not — a housekeeping re-pin.
 * The region differing means the gate's own compiled code changed — a security
 * review.
 *
 * WHAT MAKES THIS PRACTICAL, all MEASURED — an equality on compiler output is only
 * usable if the output is reproducible:
 *   - ACROSS ARCHITECTURES: amd64 and arm64 produce byte-identical bootGraph digests,
 *     an identical gate region, and an identical nextTreeSha. One pin, both arches,
 *     no normalisation.
 *   - ACROSS NODE MAJORS AND HOST OS: a local `NEXT_OUTPUT=standalone next build` on
 *     macOS/arm64 under Node 26 reproduced the in-image Debian/Node-24 digests
 *     exactly, so the pin regenerates and reviews without Docker.
 *   - ACROSS REBUILDS of unchanged source: identical.
 *   - ACROSS ROUTE CHANGES: adding an `/api/*` route leaves every pinned file
 *     byte-identical, filename hashes included — the middleware chunk holds no route
 *     handler code. What moves the pin: a Next/Turbopack upgrade, or a change to
 *     `src/proxy.ts`, `src/lib/config.ts` or `src/lib/rate-limit.ts` — exactly the
 *     changes that warrant a security review. Cheap to falsify (add a route, rebuild,
 *     diff) and expensive to leave stale; re-measure if the chunking strategy changes.
 */
async function extractGatePin(tag, platform) {
  const imageConfig = await readImageConfig(tag);
  return withImageContainer(tag, platform, async ({ readFile, hashTree }) => {
    // The standalone boot script: `node server.js` is the process, and it `require`s
    // the Next server that loads the middleware chunk, so a compile hook here rewrites
    // the gate before it runs. Pinned as a first-class member of the boot graph.
    const serverBuf = await readFile('/app/server.js');
    const bootGraph = [
      { path: 'server.js', bytes: serverBuf.length, sha256: sha256Hex(serverBuf) },
    ];

    // The middleware loader — the gate's own chunk graph — and the entry module the
    // region is extracted from.
    const middleware = await followLoader(
      readFile,
      '/app/.next/server/middleware.js',
      'middleware',
    );

    // The instrumentation loader. `middleware.js`'s entry module awaits
    // `_ENTRIES.middleware_instrumentation` in the same realm, so its chunk can run
    // before the gate. Optional only in the sense that a build without it would have
    // nothing to await; if the baseline pinned it and the image dropped it, the graph
    // comparison flags the missing files.
    let instrumentation = { files: [], entryId: null, texts: new Map() };
    try {
      instrumentation = await followLoader(
        readFile,
        '/app/.next/server/instrumentation.js',
        'instrumentation',
      );
    } catch (err) {
      // Record the absence in the graph via a sentinel entry rather than silently
      // dropping it, so a build that stops shipping instrumentation is a diff.
      bootGraph.push({ path: 'instrumentation/(absent)', bytes: 0, sha256: err.message.slice(0, 64) });
    }

    // Compose the boot graph, de-duplicated by path: a chunk shared by two loaders
    // (same content-hashed name) collapses to one entry, which is correct — it is one
    // file — and its digest still covers it.
    const seen = new Set(bootGraph.map((g) => g.path));
    for (const g of [...middleware.files, ...instrumentation.files]) {
      if (seen.has(g.path)) continue;
      seen.add(g.path);
      bootGraph.push(g);
    }
    bootGraph.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    // The whole Next framework tree, one aggregate digest. This is the code that loads
    // and invokes the middleware chunk; a hook installed anywhere in it would rewrite
    // the gate before it runs, invisibly to a pin on the gate chunk alone.
    const nextTree = await hashTree('/app/node_modules/next');

    // The region: located inside the MIDDLEWARE entry module, across its chunk texts.
    // Every locate failure is reported rather than thrown, so it lands as a named
    // check failure beside the graph comparison instead of aborting the run.
    let region = null;
    let regionError = null;
    let hostChunk = null;
    try {
      const entryId = middleware.entryId;
      const found = [];
      for (const [r, text] of middleware.texts) {
        if (!text.startsWith('module.exports=[')) continue; // the runtime chunk is not a module array
        for (const m of parseChunkModules(text)) {
          if (m.id === entryId) found.push({ chunk: r, src: m.src });
        }
      }
      if (found.length !== 1) {
        throw new Error(
          `the entry module ${entryId} that middleware.js instantiates was found ` +
            `${found.length} time(s) across the middleware's chunks${
              found.length > 1 ? ` (${found.map((f) => f.chunk).join(', ')})` : ''
            }. Exactly one is the only reading this check can trust: none means the ` +
            'loader and the chunks disagree, more than one means the module that runs ' +
            'is ambiguous.',
        );
      }
      hostChunk = found[0].chunk;
      const src = found[0].src;

      const a = src.indexOf(GATE_REGION_START_ANCHOR);
      if (a < 0) {
        throw new Error(
          'the compiled PUBLIC_PATHS set literal is not in the entry module. That is ' +
            'either a change to `PUBLIC_PATHS` in src/proxy.ts — a security review, since ' +
            'it is the list of paths served with no authentication — or a compiler change ' +
            'that emits the set differently.',
        );
      }
      if (src.indexOf(GATE_REGION_START_ANCHOR, a + 1) >= 0) {
        throw new Error(
          'the compiled PUBLIC_PATHS set literal appears MORE THAN ONCE in the entry ' +
            'module, so which one begins the gate is ambiguous. A second copy is what a ' +
            'decoy region planted to satisfy this locator would look like.',
        );
      }

      const exporters = [...src.matchAll(/e\.s\(\[/g)]
        .map((m) => m.index)
        .filter((idx) => src.slice(idx, endOfBalancedCall(src, idx)).includes('"proxy"'));
      if (exporters.length !== 1) {
        throw new Error(
          `${exporters.length} export registration(s) in the entry module name "proxy". ` +
            'Exactly one is expected: none means the gate is no longer exported under that ' +
            'name, and more than one means the export that Next binds is ambiguous.',
        );
      }
      const end = endOfBalancedCall(src, exporters[0]);
      if (end <= a) {
        throw new Error(
          'the export registration naming "proxy" precedes the compiled PUBLIC_PATHS ' +
            'literal, so the extracted range would be empty or inverted. The compiler ' +
            'emitted the module in an order this check does not recognise.',
        );
      }
      region = src.slice(a, end);
      if (region.length > GATE_REGION_MAX_BYTES) {
        throw new Error(
          `the located gate region is ${region.length} bytes, above the ` +
            `${GATE_REGION_MAX_BYTES}-byte sanity bound. Rather than pin something this ` +
            'check has probably mis-located, it refuses: re-read the extraction against ' +
            'the current compiler output before widening the bound.',
        );
      }
    } catch (err) {
      regionError = err.message;
    }

    return {
      entryId: middleware.entryId,
      graph: bootGraph,
      nextTree,
      hostChunk,
      region,
      regionError,
      imageConfig,
    };
  });
}

/**
 * A located, windowed diff of two minified strings.
 *
 * The pinned gate is one 2.8 KB line, so "expected X, got Y" is unreadable and a
 * line diff says only "the line changed". Trimming the common prefix and suffix
 * leaves exactly the edit, which in practice is a handful of characters — every
 * defeat this check was built against shows up here as one legible operator or one
 * appended clause.
 */
function locatedDiff(want, got, window = 90) {
  let p = 0;
  while (p < want.length && p < got.length && want[p] === got[p]) p++;
  let s = 0;
  while (
    s < want.length - p &&
    s < got.length - p &&
    want[want.length - 1 - s] === got[got.length - 1 - s]
  ) {
    s++;
  }
  const lead = want.slice(Math.max(0, p - window), p);
  const wantMid = want.slice(p, want.length - s);
  const gotMid = got.slice(p, got.length - s);
  const trail = want.slice(want.length - s, want.length - s + window);
  return (
    `  first difference at byte ${p} of ${want.length} (image has ${got.length})\n` +
    `  common prefix ends: ...${lead}\n` +
    `  PINNED here:        ${JSON.stringify(wantMid)}\n` +
    `  IMAGE here:         ${JSON.stringify(gotMid)}\n` +
    `  common suffix:      ${trail}...`
  );
}

// ── normalisation, so ONE baseline serves both arches ───────────────────────
/** Strip the 16-hex Turbopack suffix. The hash is Next's internal detail and
 *  must never be hardcoded; deriving the name from the artifact cannot rot. */
function stripHash(spec) {
  return spec.replace(/-[0-9a-f]{16}$/, '');
}

/** Replace the arch token and drop a trailing `-<semver>` before `.node`. */
function normaliseNativePath(p) {
  return p
    .replace(/(^|[-/.])(arm64|aarch64|x64|amd64|x86_64)(?=[-/.]|$)/g, '$1<ARCH>')
    .replace(/-\d+\.\d+\.\d+(?=\.node$)/, '');
}

/**
 * One middleware matcher, with its keys in a FIXED order.
 *
 * Fixed order so the committed baseline is byte-stable across runs and a JSON diff
 * of it stays reviewable. Every key the image carried is PRESERVED — dropping an
 * unknown one here would rob check 11's fail-closed branch of the thing it exists
 * to catch (a `missing: [{type:"header",key:"cookie"}]` condition was measured to
 * let every browser request past the gate while the source looked untouched).
 *
 * Unlike `nativeModules`, nothing here is arch-normalised: Next compiles the regexp
 * from the source at build time, so linux/amd64 and linux/arm64 produce the same
 * string. A NEXT UPGRADE that recompiles the same source differently WILL fail
 * check 11 — deliberately. That is the fail-closed direction, and the check's
 * failure text names the re-pin command.
 */
function normaliseMatcher(m) {
  const out = {};
  for (const k of Object.keys(m).sort()) out[k] = m[k];
  return out;
}

/**
 * Canonical one-line form of a matcher, for diffing and for display.
 *
 * It carries the REGEXP as well as the source, because the source alone was a
 * measured hole: see `middlewareMatchers` in `main()`. A bare string is tolerated
 * so an older sources-only baseline diffs legibly against a current one rather than
 * rendering as `undefined => undefined`; check 11 refuses such a baseline outright.
 */
function matcherKey(m) {
  if (typeof m === 'string') return m;
  return `${m?.originalSource ?? '(no originalSource)'} => ${m?.regexp ?? '(no regexp)'}`;
}

/**
 * The ONLY matcher keys this harness has reasoned about. `has`, `missing`, `locale`
 * and anything Next adds later all fall outside it and must fail closed.
 *
 * Module scope because BOTH the verification path (check 11) and the WRITE path
 * (`--update-baseline`) have to apply it. They did not: `--update-baseline` used
 * `matcherKey` for its diff, which is a projection onto two fields, so an image
 * whose matcher carried `missing: [{type:"header",key:"cookie"}]` was recorded with
 * that condition intact while the diff printed "middlewareMatchers: unchanged". A
 * later verify did fail on it, so nothing shipped — but the baseline had already
 * been taught the bypass, and a projection hiding a condition is the exact hazard
 * this whole check exists for.
 */
const ALLOWED_MATCHER_KEYS = new Set(['regexp', 'originalSource']);

/** Every key on `m` that this harness has not reasoned about. */
function unknownMatcherKeys(m) {
  if (typeof m !== 'object' || m === null) return [];
  return Object.keys(m).filter((k) => !ALLOWED_MATCHER_KEYS.has(k));
}

/**
 * A FLOOR ON THE PIN ITSELF — concrete paths the PINNED matcher regexp must cover.
 *
 * Rule 2 makes the committed baseline authoritative, and that is right, but it has a
 * corollary worth stating: a baseline weakened IN LOCKSTEP with the image passes,
 * because the pin is otherwise purely self-referential. These literals are the floor
 * under it. They are written out here, not derived from the manifest or from
 * `src/proxy.ts`, because a floor derived from the thing it constrains is not a
 * floor.
 *
 * Chosen to include the shapes that defeated earlier versions of check 11: a digit
 * segment (round 3(a)'s `[^0-9]+` narrowing matched none of these), a uuid, an
 * `aid:pubkey:` token with colons, and a nested admin suffix — `/export` is the one
 * `src/proxy.ts` specifically warns must never become public.
 */
const PINNED_MATCHER_MUST_COVER = [
  '/api/audit',
  '/api/webhooks',
  '/api/webhooks/1/circuit-breaker',
  '/api/webhooks/1/circuit-breaker/reset',
  '/api/registry/agents/aid:pubkey:AAAABBBBCCCCDDDD/export',
  '/api/sessions/00000000-0000-4000-8000-000000000000/export',
  '/api/trust-anchors/42',
];

// ── check runner ────────────────────────────────────────────────────────────
// ── live substrate ──────────────────────────────────────────────────────────
//
// Everything below stands up a REAL deployment of the image: its own bridge
// network, its own Postgres, the repo's own migrations, and the image itself run
// against them. The static probes above can only see the artifact's shape; these
// are what let later checks assert behaviour over HTTP.
//
// Every resource is registered for teardown BEFORE it is created. That ordering
// is not stylistic: `docker rm -f <name>` issued between the daemon creating a
// container and starting it removes nothing, which is how an earlier revision of
// this file leaked twelve containers in state `created` under a SIGINT sweep.

/**
 * Derive `aid:pubkey:<base64url(raw Ed25519 public key)>` from a 32-byte seed,
 * using `node:crypto` and NOTHING else.
 *
 * Deriving it with the SDK would compare the SDK against itself and prove
 * nothing. This is an independent implementation, so the health-check assertion
 * becomes a genuine cross-implementation equality — and it keeps the harness's
 * host side free of any native dependency, which matters because the host may be
 * a different arch from the image. Same discipline as the hand-rolled verifier in
 * src/e2e/revocation-flow.integration.test.ts.
 */
function deriveAid(seedHex) {
  const seed = Buffer.from(seedHex, 'hex');
  if (seed.length !== 32) {
    fail(`CP_AID_SEED_HEX must decode to 32 bytes, got ${seed.length}`);
  }
  // A PKCS#8 Ed25519 private key is a fixed 16-byte prefix followed by the seed.
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    seed,
  ]);
  const priv = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(priv).export({ format: 'der', type: 'spki' });
  // The last 32 bytes of an Ed25519 SPKI DER are the raw public key.
  return `aid:pubkey:${spki.subarray(spki.length - 32).toString('base64url')}`;
}

// ── the revocation signing path (checks 14-18) ──────────────────────────────
//
// WHAT THESE CHECKS ARE FOR. The revocation list is the one response this service
// SIGNS, and it signs it with the NAPI binary inside the image
// (src/lib/revocation/producer.ts -> src/lib/identity/cp-agent.ts). Check 1 proves
// that binary LOADS; nothing proved it produces a signature anyone can verify, under
// the image's own arch and libc.
//
// AND WHY THE LOG ASSERTION (check 17) IS THE LOAD-BEARING ONE.
// src/lib/revocation/producer.ts catches a failed database read and publishes an
// EMPTY BUT VALIDLY SIGNED list. Measured against an unmigrated database: the
// endpoint answered 200, the signature verified, the issuer was right — and the
// container logged `revocation DB read failed, publishing empty list` because
// `relation "revocation_entries" does not exist`. So a check asserting only "200 and
// the signature verifies" PASSES ON AN IMAGE WHOSE DATABASE ACCESS IS ENTIRELY
// BROKEN. Do not "simplify" check 17 away: it is the only thing standing between
// this group and that vacuity, and the fallback it watches for is a deliberate
// feature of the producer, not a bug that might get fixed.
const REVOCATION_PATH = '/.well-known/aitp-revocation-list';
/**
 * The producer's fallback warning, as src/lib/revocation/producer.ts emits it.
 *
 * Matched as a SUBSTRING of the whole log, not of a tail: src/lib/logger.ts writes
 * structured JSON under NODE_ENV=production, so the text appears inside a `"msg"`
 * field, and the producer caches for 60s — which means the warning is emitted on the
 * FIRST request only. Fetch the list before scanning, and scan everything.
 */
const REVOCATION_DB_FALLBACK = 'revocation DB read failed';

/**
 * RFC 8785 (JCS) canonicalisation, sufficient for this envelope: every value in it
 * is an ASCII string, an integer, an array or an object.
 *
 * Deliberately a re-implementation rather than an import. The whole point of the
 * host-side verification is that it shares no code with the thing that produced the
 * signature — a verifier built from the SDK would be comparing the SDK to itself.
 */
function jcs(v) {
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * The two candidate signing inputs for a revocation envelope.
 *
 * `signature` is a SIBLING of `revocation_list` in the envelope, not a member of it,
 * so nothing is stripped before canonicalising. (The session bundle and the manifest
 * put `signature` INSIDE the signed body and exclude it — do not generalise from
 * here.) `wrapped` is the pre-0.5.0 convention and exists only to be asserted
 * against: a positive-only test is what let the wrapped form survive a full release,
 * and the same reasoning is written down at
 * src/e2e/revocation-flow.integration.test.ts.
 */
const SIGNING_INPUTS = {
  innerBody: (env) => jcs(env.revocation_list),
  wrapped: (env) => jcs({ revocation_list: env.revocation_list }),
};

/**
 * Verify an envelope: Ed25519 over sha256(canonical bytes), under the public key
 * taken from the base64url segment of the `aid:pubkey:<b64url>` issuer AID.
 *
 * Returns false rather than throwing for ANY rejection, malformed input included. A
 * verifier that distinguished "bad signature" from "unparseable key" would make the
 * negative checks below depend on which of the two a tamper happened to produce; what
 * they assert is the only thing that matters — that the envelope was NOT accepted.
 */
function verifyEnvelopeSignature(env, canonicalize = SIGNING_INPUTS.innerBody) {
  try {
    const seg = String(env?.revocation_list?.issuer ?? '').split(':').pop();
    const rawKey = Buffer.from(seg, 'base64url');
    if (rawKey.length !== 32) return false;
    // Ed25519 SubjectPublicKeyInfo DER prefix + the 32 raw key bytes.
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const digest = createHash('sha256').update(Buffer.from(canonicalize(env))).digest();
    return edVerify(null, digest, key, Buffer.from(String(env?.signature ?? ''), 'base64url'));
  } catch {
    return false;
  }
}

/**
 * Ask the image's OWN SDK to verify the envelope, inside the image.
 *
 * The raw bytes are embedded as a JS string literal, so what the SDK sees is
 * byte-for-byte what the server served. Re-serialising the parsed object would
 * PROBABLY round-trip, and relying on that reintroduces exactly the tautology these
 * checks exist to remove — the same reasoning as
 * src/e2e/revocation-flow.integration.test.ts. `docker run` passes argv straight to
 * the daemon with no shell, so there is nothing to quote around.
 *
 * It also runs the negative INSIDE the container: `verifyRevocationList` returns
 * `void` and signals failure by throwing, so "it did not throw" on its own is
 * satisfied by a verifier that never throws at all.
 */
function probeSdkVerifyScript(raw, issuer) {
  return `
const { verifyRevocationList } = require('aitp');
const RAW = ${JSON.stringify(raw)};
const ISSUER = ${JSON.stringify(issuer)};
let ok = false, err = null;
try { verifyRevocationList(RAW, ISSUER); ok = true; }
catch (e) { err = String((e && (e.code || e.message)) || e); }
let tamperedRejected = false, tamperedErr = null;
try {
  const env = JSON.parse(RAW);
  env.revocation_list.published_at = (env.revocation_list.published_at || 0) + 1;
  verifyRevocationList(JSON.stringify(env), ISSUER);
} catch (e) { tamperedRejected = true; tamperedErr = String((e && (e.code || e.message)) || e); }
process.stdout.write(JSON.stringify({ ok, err, tamperedRejected, tamperedErr }));
`;
}

// ── the CORS build-freeze (check 19) ────────────────────────────────────────
//
// RULE 1 OF THIS HARNESS'S CONTRACT, transplanted into the image: THE RUNTIME
// ENVIRONMENT DIFFERS FROM THE BUILD ENVIRONMENT. Asserting that an
// `access-control-allow-origin` header is merely PRESENT would pass on a
// build-frozen artifact, which is the exact failure being guarded against — and it is
// a live risk, not a hypothetical one: next.config.ts records that Next evaluates
// `headers()` at BUILD time, which is precisely why src/proxy.ts applies CORS
// per-request from src/lib/config.ts instead.
//
// ONE PRECISION THAT SHAPES HOW THIS CAN BE EXERCISED. `CORS_HEADERS` in
// src/proxy.ts is a MODULE-LEVEL const, built once at process start from
// `appConfig.corsOrigin`, which is itself a module-load snapshot of `process.env`. So
// the value is CAPTURED AT CONTAINER START and APPLIED per request. That is exactly
// what defeats the build-time freeze and is all this check needs — but it means the
// variable is NOT re-read per request. Anyone who tries to "verify" this by mutating
// the environment of a running container will see no change and will wrongly conclude
// the check is broken. The only way to vary it is a new container.
//
// WHY THE BUILD-TIME VALUE IS PARSED OUT OF THE DOCKERFILE RATHER THAN HARDCODED.
// The sibling harness (scripts/verify-request-gate.mjs) owns BOTH sentinels because it
// runs its own build. This one does not: the build-time value is baked by the
// Dockerfile and is not this harness's to choose. A copy-pasted literal here would
// silently decay into "a header is present" the moment someone edited the Dockerfile,
// which is the same decay the sibling warns about for a CI env var. Parsing keeps the
// coupling checkable and local — and there is deliberately no literal copy of the
// baked origin anywhere in this file.

/**
 * Read one `ENV <name>=<value>` from the Dockerfile.
 *
 * Folds backslash continuations into logical lines FIRST, because the Dockerfile's
 * build-stage block is a single multi-line `ENV` and the key this check needs sits on
 * a continuation line. A line-at-a-time scan happens to work on today's layout and
 * would break silently the moment the key moved to the instruction's first line —
 * the parser would find nothing, and a parser that quietly returns `undefined` turns
 * this check green and useless.
 *
 * Fails loudly on: no match, more than one DISTINCT value, and the legacy
 * `ENV <name> <value>` (space) form, which this repo does not use and which a
 * `<name>=` regex would silently miss.
 */
function dockerfileEnvValue(name) {
  const dockerfile = path.join(ROOT, 'Dockerfile');
  let text;
  try {
    text = readFileSync(dockerfile, 'utf8');
  } catch (err) {
    fail(`could not read ${path.relative(ROOT, dockerfile)}: ${err.message}`);
  }
  const logical = [];
  let acc = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    // A comment line is a comment even in the middle of a continuation.
    if (/^\s*#/.test(line)) continue;
    if (/\\\s*$/.test(line)) {
      acc += `${line.replace(/\\\s*$/, '')} `;
      continue;
    }
    logical.push(acc + line);
    acc = '';
  }
  if (acc) logical.push(acc);

  const found = [];
  for (const line of logical) {
    if (!/^\s*ENV\s/i.test(line)) continue;
    if (new RegExp(`(?:^|\\s)${name}\\s+[^=\\s]`).test(line)) {
      fail(
        `${path.relative(ROOT, dockerfile)} sets ${name} with the legacy space-separated ` +
          '`ENV <name> <value>` form. This parser only understands `ENV <name>=<value>`, ' +
          'which is what the file uses everywhere today, and it refuses rather than ' +
          `guessing: silently missing ${name} would leave this check asserting only that ` +
          'a CORS header is present, which passes on the build-frozen artifact it exists ' +
          `to catch.\nThe instruction was: ${line.trim().slice(0, 300)}`,
      );
    }
    const re = new RegExp(`(?:^|\\s)${name}=(\\S+)`, 'g');
    for (let m = re.exec(line); m; m = re.exec(line)) {
      // Strip one layer of matching quotes; Docker accepts `k="v"`.
      found.push(m[1].replace(/^(["'])(.*)\1$/, '$2'));
    }
  }
  if (!found.length) {
    fail(
      `no \`ENV ${name}=...\` found in ${path.relative(ROOT, dockerfile)}.\n` +
        'This check compares the SERVED CORS origin against the value the image was ' +
        'BUILT with, and it parses that value out of the Dockerfile rather than ' +
        'hardcoding it — so a missing line is a FAILURE and never a skip. If the ' +
        `variable really is gone from the build stage, this check's premise is gone ` +
        'with it and it should be rewritten, not made to pass.',
    );
  }
  const distinct = [...new Set(found)];
  if (distinct.length > 1) {
    fail(
      `${path.relative(ROOT, dockerfile)} sets ${name} to more than one value ` +
        `(${distinct.map((v) => JSON.stringify(v)).join(', ')}), so "the value the image ` +
        'was built with" is ambiguous. Resolve it in the Dockerfile; this check will not ' +
        'pick one.',
    );
  }
  return distinct[0];
}

/** An HTTP request with its own deadline, so one wedged route cannot eat the
 *  watchdog. Returns the parsed body when it is JSON, the raw text otherwise. */
async function httpReq(base, pathname, opts2 = {}) {
  // `requestBody`, not `body`: the RESPONSE body is already called `body` below, and a
  // second binding of that name silently shadowed it into a
  // "Cannot access 'body' before initialization" on every call.
  const { method = 'GET', key = null, origin = true, timeoutMs = HTTP_MS, body: requestBody = null } =
    opts2;
  const headers = {};
  if (key) headers.authorization = `Bearer ${key}`;
  if (origin) headers.origin = RUNTIME_ORIGIN;
  // A JSON body, when one is asked for. It matters for exactly one assertion — the
  // anonymous POST in check 12 — and it matters that it is VALID: against an ungated
  // gate that request returns 201 and creates the resource, which is an unmistakable
  // signal, whereas a bodyless POST would come back 400 from body validation and
  // "400" reads ambiguously next to "the gate refused it".
  if (requestBody !== null) headers['content-type'] = 'application/json';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers,
      ...(requestBody !== null ? { body: JSON.stringify(requestBody) } : {}),
      signal: ac.signal,
    });
    const text = await res.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status, headers: res.headers, body, text };
  } finally {
    clearTimeout(timer);
  }
}

/** One-shot `docker logs`. Never `-f`: a follower is a long-lived child holding
 *  pipes open, which is precisely the 18-minute-hang bug class. */
async function containerLogs(name) {
  const { stdout, stderr } = await docker(['logs', name], {
    allowFail: true,
    timeoutMs: 60_000,
  });
  return `${stdout}${stderr}`.trim() || '(no output)';
}

/** A run-unique private bridge network, so the app reaches Postgres by container
 *  name — identical locally and in CI. */
async function createNetwork() {
  const name = nameFor('net');
  networks.add(name);
  await docker(['network', 'create', ...labelArgs(), name], { timeoutMs: 60_000 });
  return name;
}

/**
 * Note what is NOT passed here: `--platform`. Postgres runs NATIVE even when the
 * image under test is emulated, so an amd64 run on an arm64 host has an emulated
 * app talking to a native Postgres. That is deliberate — only container-to-container
 * TCP crosses the boundary, and emulating the database would slow every run for no
 * assertion gained. The consequence to know: an emulated run does not exercise an
 * all-one-arch substrate. The image under test is always the requested platform,
 * which is the thing this harness is about.
 */
async function startPostgres(net) {
  const name = nameFor('pg');
  containers.add(name);
  await docker(
    [
      'run',
      '-d',
      '--name',
      name,
      '--network',
      net,
      // Loopback-bound EPHEMERAL port. Never 0.0.0.0, and never a fixed 5432 or
      // 5433: those collide with docker-compose and with ci.yml's service.
      '-p',
      '127.0.0.1:0:5432',
      // Keep the data directory in RAM so NO anonymous volume is ever created.
      //
      // postgres:16-alpine declares `VOLUME /var/lib/postgresql/data`, so a plain
      // `docker run` makes an anonymous volume and `docker rm -f` without `-v`
      // leaves it behind — on success as much as on failure. Measured: ~46 MB per
      // run, surviving every exit path. Worse than the disk cost, it was INVISIBLE
      // to this harness's own leak check, which counts containers and networks; a
      // run could report "nothing leaked" while leaking. A volume that never
      // exists cannot be forgotten, and the database is throwaway, so tmpfs is
      // both the smaller surface and the faster one. `-v` on the removals below is
      // the backstop for anything that still manages to create one.
      '--tmpfs',
      '/var/lib/postgresql/data:rw,size=512m',
      '-e',
      `POSTGRES_USER=${PG_USER}`,
      '-e',
      `POSTGRES_PASSWORD=${PG_PASS}`,
      '-e',
      `POSTGRES_DB=${PG_DB}`,
      // The container's OWN healthcheck, same idiom as ci.yml and
      // docker-compose.yml, rather than inventing a third readiness convention.
      '--health-cmd',
      `pg_isready -U ${PG_USER} -d ${PG_DB}`,
      '--health-interval',
      '2s',
      '--health-timeout',
      '5s',
      '--health-retries',
      '30',
      ...labelArgs(),
      PG_IMAGE,
    ],
    { timeoutMs: 180_000 },
  );

  const started = Date.now();
  for (;;) {
    const { stdout } = await docker(['inspect', '-f', '{{.State.Health.Status}}', name], {
      allowFail: true,
      timeoutMs: 20_000,
    });
    if (stdout.trim() === 'healthy') break;
    if (Date.now() - started > PG_READY_MS) {
      fail(
        `Postgres never became healthy in ${Math.round(PG_READY_MS / 1000)}s ` +
          `(last status: ${stdout.trim() || 'unknown'}). Its logs:\n${await containerLogs(name)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const { stdout: portOut } = await docker(['port', name, '5432/tcp'], { timeoutMs: 20_000 });
  const hostPort = portOut.trim().split('\n')[0]?.split(':').pop();
  if (!hostPort) {
    fail(
      `could not read Postgres's published host port from \`docker port\`: ` +
        `${JSON.stringify(portOut)}. Migrations run from the host against that port, so ` +
        'there is nothing to fall back to.',
    );
  }
  console.log(
    `postgres healthy in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
      `(127.0.0.1:${hostPort})`,
  );
  return { name, hostPort };
}

/**
 * Apply the repo's own migrations from the HOST.
 *
 * Mandatory, and the reason is empirical rather than tidy-minded: unmigrated,
 * src/lib/revocation/producer.ts catches the DB read failure and publishes an
 * EMPTY BUT VALIDLY SIGNED list, so a signature check would pass against an image
 * whose database access is completely broken; and /api/audit with a valid key
 * answers 500, so there would be no way to tell an attached gate from a rejecting
 * one. An unmigrated harness is a harness that lies.
 *
 * On the host because the runtime image bundles no drizzle-kit — see
 * docs/operations.md. That is why Postgres publishes an ephemeral host port at
 * all.
 */
async function migrate(hostPort) {
  const url = `postgres://${PG_USER}:${PG_PASS}@127.0.0.1:${hostPort}/${PG_DB}`;
  const started = Date.now();
  await new Promise((resolve, reject) => {
    const child = spawnOwnGroup('npm', ['run', 'db:migrate'], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    liveChildren.add(child);
    const out = [];
    // Every `docker` call carries its own deadline so no single wedged invocation
    // can consume the whole post-build ceiling. This child is the one long-running
    // process that is not a `docker` call, and it needs the same treatment:
    // drizzle-kit blocked on a Postgres advisory lock would otherwise burn the
    // entire watchdog and then report "something hung" instead of naming the step.
    //
    // Kill the GROUP, not the child. An earlier revision killed only `npm` and
    // reasoned that leaving the child inside this process group was safer, because
    // an interactive Ctrl-C signals the whole foreground group and would reach
    // drizzle-kit directly. That reasoning was measured only against
    // process-group signals, and it does not hold for a signal aimed at this
    // process's pid alone (a supervisor, `timeout`, `kill -INT <pid>`) or for this
    // timeout path — both of which orphaned drizzle-kit. Since teardown runs on
    // every one of those paths anyway, owning the group and killing it explicitly
    // covers all of them.
    //
    // ONE MEASURED TRADE-OFF, stated rather than glossed: under `kill -9` aimed at
    // this harness's process group, the OLD arrangement killed the grandchild as a
    // side effect (it shared our group) whereas now it survives, because our handler
    // never runs to kill its group. That path already leaked the container and the
    // network on both arrangements — SIGKILL is not a path any teardown can cover —
    // so it trades a process leak on one uncatchable path for correctness on the
    // three catchable ones. Worth the exchange, but it is an exchange.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Only signal a child that is still running. `clearTimeout` happens in the
      // `close` handler, so there is a narrow window where the child has exited, its
      // close event is still queued, and the OS has reused its pid as a new group
      // leader — a negative-pid SIGKILL would then hit an unrelated process group.
      // Sub-millisecond and needs pid wraparound, but this is a kill by negative pid,
      // where being wrong is expensive.
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, MIGRATE_MS);
    child.stdout.on('data', (d) => out.push(String(d)));
    child.stderr.on('data', (d) => out.push(String(d)));
    child.on('error', (e) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      reject(new Error(`could not run \`npm run db:migrate\`: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (timedOut) {
        reject(
          new Error(
            `migrations TIMED OUT after ${Math.round(MIGRATE_MS / 1000)}s — most likely ` +
              `drizzle-kit is blocked on a lock. Output so far:\n${out.join('').trim()}`,
          ),
        );
        return;
      }
      if (code !== 0) {
        // Never continue to checks against a half-migrated schema: they would
        // report application bugs that are really missing tables.
        reject(
          new Error(
            `migrations FAILED (drizzle-kit exit ${code}). Nothing is checked against a ` +
              `half-migrated schema.\n${out.join('').trim()}`,
          ),
        );
        return;
      }
      resolve();
    });
  });
  console.log(`migrations applied in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

/**
 * Prove the migrations actually built a schema, rather than trusting exit 0.
 *
 * This is load-bearing, and the reason is measured rather than theoretical: with
 * NO migrations applied at all, `/api/health` still answers
 * `{"ok":true,...,"db":"ok"}` with the correct AID and a 200, because its DB probe
 * is `SELECT 1` — which needs no schema. So check 7 is fully green against a
 * completely unmigrated database, and drizzle-kit's exit code was the only thing
 * standing between this harness and the "harness that lies" its own comments warn
 * about. Any exit-0 no-op — a drizzle-kit behaviour change, a journal pointing
 * somewhere empty, a DATABASE_URL resolved differently than intended — would print
 * "migrations applied" and sail through.
 *
 * Queried through `docker exec` on the Postgres container so this needs no psql on
 * the host.
 */
async function assertSchemaMigrated(pgName) {
  let expected;
  try {
    expected = JSON.parse(
      readFileSync(path.join(ROOT, 'drizzle', 'meta', '_journal.json'), 'utf8'),
    ).entries.length;
  } catch (err) {
    fail(`could not read drizzle/meta/_journal.json to learn the migration count: ${err.message}`);
  }
  if (!expected) {
    fail('drizzle/meta/_journal.json lists no migrations, so there is nothing to verify');
  }
  // Keep stderr: without it a psql that could not run at all (binary missing, exec
  // denied, container restarting) yields empty stdout, Number('') is 0, and the
  // failure below blames the migration for what is really a broken query. Fails
  // closed either way, but the diagnosis has to name the right thing.
  const problems = [];
  const q = async (sql) => {
    const { stdout, stderr } = await docker(
      ['exec', pgName, 'psql', '-U', PG_USER, '-d', PG_DB, '-tAc', sql],
      { timeoutMs: 60_000, allowFail: true },
    );
    if (stderr.trim()) problems.push(stderr.trim());
    return stdout.trim();
  };
  const why = () =>
    problems.length ? `\npsql also reported:\n  ${[...new Set(problems)].join('\n  ')}` : '';
  const tables = Number(
    await q("select count(*) from information_schema.tables where table_schema = 'public'"),
  );
  const applied = Number(await q('select count(*) from drizzle.__drizzle_migrations'));
  // Lead with the query failure when there was one. Otherwise this reports "the
  // schema holds 0 tables" — a count that was never actually measured, because
  // Number('') is 0 — and buries the real cause below the fold.
  if (problems.length) {
    fail(
      'could not read the schema back to confirm the migrations applied, so whether ' +
        'they did is unknown. psql reported:\n  ' +
        [...new Set(problems)].join('\n  '),
    );
  }
  if (!Number.isInteger(tables) || tables === 0) {
    fail(
      `migrations reported success but the public schema holds ${JSON.stringify(tables)} ` +
        'tables. Nothing downstream would notice: /api/health probes the database with ' +
        'SELECT 1, so it answers db:"ok" against an empty database.',
    );
  }
  // Compare against the EXPECTED count, not against zero. "At least one migration
  // ran" is a weaker claim than the spec asks for — it says never to proceed
  // against a half-migrated schema — and a partial apply that exits 0 (a truncated
  // journal, a future drizzle-kit that stops early) would satisfy a non-zero check
  // and print a number nobody compares. The expected count is free: it is the
  // journal this repo commits.
  if (applied !== expected) {
    fail(
      `drizzle.__drizzle_migrations holds ${JSON.stringify(applied)} row(s) but ` +
        `drizzle/meta/_journal.json lists ${expected} migration(s). The schema is ` +
        'partially applied, which the plan explicitly says never to run checks against — ' +
        'a half-migrated database produces failures that look like application bugs.' +
        why(),
    );
  }
  console.log(`schema verified: ${tables} tables, ${applied}/${expected} migrations applied`);
}

/**
 * Run the image under test against the substrate and wait until it answers.
 *
 * `label` distinguishes several app containers in one run; `extraEnv` is how a
 * later check varies one variable while holding the rest fixed.
 */
async function startApp(net, pgName, platform, label, extraEnv = {}) {
  const name = nameFor(label);
  containers.add(name);
  const env = {
    DATABASE_URL: `postgres://${PG_USER}:${PG_PASS}@${pgName}:5432/${PG_DB}`,
    CORS_ORIGIN: RUNTIME_ORIGIN,
    API_KEYS: API_KEY,
    CP_AID_SEED_HEX: SEED_HEX,
    ENROLLMENT_SECRET,
    // Explicit and generous: a future change to the defaults in src/lib/config.ts
    // must not be able to make these checks flaky through rate limiting.
    RATE_LIMIT_PUBLIC_PER_IP_MIN: '10000',
    RATE_LIMIT_API_KEY_PER_MIN: '10000',
    RATE_LIMIT_ENROLLMENT_PER_IP_MIN: '10000',
    ...extraEnv,
  };
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  await docker(
    [
      'run',
      '-d',
      '--name',
      name,
      '--network',
      net,
      '--platform',
      platform,
      // Ephemeral and loopback-bound: a fixed 4000 would collide with a local
      // `npm run dev`.
      '-p',
      '127.0.0.1:0:4000',
      ...envArgs,
      ...labelArgs(),
      opts.tag,
    ],
    { timeoutMs: 180_000 },
  );

  const { stdout: portOut } = await docker(['port', name, '4000/tcp'], { timeoutMs: 20_000 });
  const hostPort = portOut.trim().split('\n')[0]?.split(':').pop();
  if (!hostPort) {
    fail(`could not read the app's published host port from \`docker port\`: ${JSON.stringify(portOut)}`);
  }
  const base = `http://127.0.0.1:${hostPort}`;

  const started = Date.now();
  for (;;) {
    // Poll liveness ALONGSIDE the HTTP probe. A container that dies from a
    // native-module failure is then reported in about a second with its logs,
    // instead of as a four-minute timeout with no explanation.
    const { stdout: running } = await docker(['inspect', '-f', '{{.State.Running}}', name], {
      allowFail: true,
      timeoutMs: 20_000,
    });
    const state = running.trim();
    if (state === 'false') {
      fail(
        `the app container exited during readiness, after ` +
          `${((Date.now() - started) / 1000).toFixed(1)}s. Its logs:\n${await containerLogs(name)}`,
      );
    }
    // Neither `true` nor `false` means `docker inspect` could not answer — the
    // container was removed out of band, or the daemon is unwell. Without this the
    // loop would spin out the full readiness deadline and then blame a slow boot.
    if (state !== 'true') {
      fail(
        `\`docker inspect\` reported the app container's running state as ` +
          `${JSON.stringify(state)}, which is neither "true" nor "false" — the container ` +
          'has probably been removed from under this run, or the daemon is failing to ' +
          'answer. Not waiting out the readiness deadline for that.',
      );
    }
    try {
      // BREAK ON ANY HTTP RESPONSE — never on `res.ok`, never on a 200.
      // src/app/api/health/route.ts answers 503 whenever the DB ping fails, so a
      // status-gated loop would spin out the whole deadline on exactly the
      // misconfiguration this substrate exists to report, and the `db: "ok"`
      // assertion would be unreachable by construction. Readiness means "the
      // server answered"; what it answered is a separate, later check.
      await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
      break;
    } catch {
      if (Date.now() - started > APP_READY_MS) {
        fail(
          `the app never answered on ${base} within ${Math.round(APP_READY_MS / 1000)}s. ` +
            `Its logs:\n${await containerLogs(name)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log(
    `app "${label}" answered in ${((Date.now() - started) / 1000).toFixed(1)}s (${base})`,
  );
  return { name, base };
}

/**
 * Fetch the signed revocation list as BOTH the exact raw bytes and the parsed shape.
 *
 * The raw text is what every verification below is handed. Re-serialising the parsed
 * object would probably round-trip, and relying on that reintroduces the tautology
 * these checks exist to remove.
 */
async function fetchRevocationEnvelope(app) {
  const r = await httpReq(app.base, REVOCATION_PATH);
  if (r.status === 404) {
    fail(
      `GET ${REVOCATION_PATH} answered 404. That path is served through a REWRITE in ` +
        'next.config.ts onto /api/well-known/aitp-revocation-list, so a 404 means the ' +
        'rewrite is missing from the built artifact — not that the signature is bad. ' +
        'Check next.config.ts `rewrites()` and that it survived the build.',
    );
  }
  if (r.status !== 200) {
    fail(`GET ${REVOCATION_PATH} answered ${r.status} (body: ${JSON.stringify(r.body)})`);
  }
  const ct = r.headers.get('content-type');
  if (!String(ct).includes('application/json')) {
    fail(`content-type is ${JSON.stringify(ct)}, expected application/json`);
  }
  let env;
  try {
    env = JSON.parse(r.text);
  } catch (err) {
    fail(`the served envelope is not JSON: ${err.message}`);
  }
  if (!env?.revocation_list || typeof env.signature !== 'string') {
    fail(
      'the served envelope has no `revocation_list` body or no string `signature`, so ' +
        `there is nothing to verify: ${r.text.slice(0, 400)}`,
    );
  }
  return { raw: r.text, env };
}

/** Check 14, and part of check 20: the host-side, zero-dependency verification. */
function assertEnvelopeVerifiesOnHost(rev) {
  if (!verifyEnvelopeSignature(rev.env, SIGNING_INPUTS.innerBody)) {
    fail(
      'the served signature does NOT verify under the public key embedded in its own ' +
        '`issuer` AID, over sha256(JCS(revocation_list)).\n' +
        `  issuer:    ${rev.env.revocation_list?.issuer}\n` +
        `  signature: ${String(rev.env.signature).slice(0, 44)}...\n` +
        'This verifier is hand-rolled from node:crypto on the HOST and shares no code ' +
        'with the signer, so a failure here is a genuine cross-implementation ' +
        'disagreement: either the NAPI binary in the image signed something else, or it ' +
        'signed the wrong canonical bytes.',
    );
  }
  const entries = rev.env.revocation_list?.entries;
  return (
    `signature verifies (host, node:crypto, over sha256(JCS(revocation_list))); ` +
    `${Array.isArray(entries) ? entries.length : '?'} entr(ies), ` +
    `expires_at=${rev.env.revocation_list?.expires_at}`
  );
}

/** Check 16, and part of check 20. */
function assertEnvelopeIssuerIsSeedDerived(rev, expectedAid) {
  const issuer = rev.env.revocation_list?.issuer;
  if (issuer !== expectedAid) {
    fail(
      'the envelope is signed by an identity other than the configured seed:\n' +
        `  expected (host, node:crypto from CP_AID_SEED_HEX): ${expectedAid}\n` +
        `  served   (image, aitp NAPI signer):               ${issuer}\n` +
        'Without this equality the signature check above only proves the container ' +
        'signed with SOME key it holds, not with the one it was configured with.',
    );
  }
  return `issuer = ${expectedAid} (derived independently on the host)`;
}

/** Check 17, and part of check 20 — the assertion that stops the group being vacuous. */
async function assertRevocationDbReadHappened(app) {
  const logs = await containerLogs(app.name);
  const hits = logs
    .split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => l.includes(REVOCATION_DB_FALLBACK));
  if (hits.length) {
    fail(
      `the container logged ${JSON.stringify(REVOCATION_DB_FALLBACK)}, so the list above ` +
        'was signed WITHOUT reading the database.\n' +
        hits.map(([n, l]) => `  line ${n}: ${l.slice(0, 400)}`).join('\n') +
        '\n\nsrc/lib/revocation/producer.ts catches a failed DB read and publishes an ' +
        'EMPTY BUT VALIDLY SIGNED list, so every other assertion in this group still ' +
        'passes — measured. Against this substrate it almost always means the ' +
        'migrations did not apply and `revocation_entries` does not exist.',
    );
  }
  return (
    `no ${JSON.stringify(REVOCATION_DB_FALLBACK)} in ${logs.split('\n').length} log line(s) ` +
    '— the signed list came from a real DB read, not from the empty-list fallback'
  );
}

/** Check 19, and part of check 20: the CORS build-freeze. */
async function assertCorsIsRuntimeNotBuild(app) {
  const baked = dockerfileEnvValue('CORS_ORIGIN');
  if (baked === RUNTIME_ORIGIN) {
    fail(
      'the value the Dockerfile bakes at BUILD time is identical to the sentinel this ' +
        `harness runs the container with (${RUNTIME_ORIGIN}), so the two halves of this ` +
        'check cannot be told apart and it could never fail. Change the Dockerfile back, ' +
        'or pick a different runtime sentinel — do NOT weaken the assertion.',
    );
  }
  // An /api/* path, because the gate returns early for anything outside /api/ and so
  // sets no CORS headers there. Public and rate-limit exempt, so nothing else
  // interferes. An Origin header is sent to mirror a real browser call; src/proxy.ts
  // sets the response header unconditionally, so that is realism, not a dependency.
  const r = await httpReq(app.base, '/api/health');
  const served = r.headers.get('access-control-allow-origin');
  if (!served) {
    fail(
      'no access-control-allow-origin on GET /api/health. The gate sets it on every ' +
        '/api/* response, so its absence means the gate did not run here at all.',
    );
  }
  if (served === baked) {
    fail(
      'the served CORS origin equals the value baked into the image at BUILD time, not ' +
        'the one the container was STARTED with:\n' +
        `  served:                     ${served}\n` +
        `  runtime CORS_ORIGIN:        ${RUNTIME_ORIGIN}\n` +
        `  baked (parsed from Dockerfile): ${baked}\n` +
        'That is the build-freeze this check exists for: next.config.ts records that ' +
        'Next evaluates `headers()` at BUILD time, which is why src/proxy.ts applies ' +
        'CORS per request from src/lib/config.ts. If CORS moved into next.config.ts ' +
        '`headers()`, this is exactly what it would look like. Note the same value is ' +
        "also src/lib/config.ts's default, so a CORS_ORIGIN that never reached the " +
        'container is indistinguishable from a frozen one — both are failures.',
    );
  }
  if (served !== RUNTIME_ORIGIN) {
    fail(
      'the served CORS origin is neither the runtime value nor the baked one:\n' +
        `  served:                     ${served}\n` +
        `  runtime CORS_ORIGIN:        ${RUNTIME_ORIGIN}\n` +
        `  baked (parsed from Dockerfile): ${baked}\n` +
        'Something is rewriting the header between src/proxy.ts and the wire.',
    );
  }
  // Present in src/proxy.ts's CORS_HEADERS, and a correctness property of a
  // per-origin header: without it a shared cache could serve one origin's value to
  // another. Asserted here because this is the check that owns the CORS headers.
  const vary = r.headers.get('vary');
  if (!String(vary).toLowerCase().includes('origin')) {
    fail(`Vary is ${JSON.stringify(vary)} and does not include Origin`);
  }
  return (
    `served=${served} == runtime CORS_ORIGIN; ` +
    `!= ${baked} (parsed from the Dockerfile's build stage); Vary: ${vary}`
  );
}

const results = [];

async function runCheck(id, title, fn) {
  try {
    const detail = await fn();
    console.log(`  ok   ${String(id).padStart(2)}  ${title}`);
    if (detail) console.log(`         ${String(detail).split('\n').join('\n         ')}`);
    results.push({ id, ok: true });
  } catch (err) {
    console.log(`  FAIL ${String(id).padStart(2)}  ${title}`);
    console.log(`         ${String(err.message).split('\n').join('\n         ')}`);
    results.push({ id, ok: false });
  }
}

function fail(msg) {
  throw new Error(msg);
}

// ── prune ───────────────────────────────────────────────────────────────────
/**
 * Sweep resources left by an EARLIER run.
 *
 * Only resources carrying this harness's label, and never THIS run's own —
 * Docker's `--filter label=` has no negation, so the run id is excluded
 * host-side. Note what that does NOT protect: every OTHER run's resources are
 * removed, live or not. `--prune` is for orphans left by a crash; running it
 * while another verify:image run is in flight will break that run.
 */
async function prune() {
  let removed = 0;
  const { stdout: cs } = await docker(
    [
      'ps',
      '-a',
      '--filter',
      `label=${LABEL}=1`,
      '--format',
      `{{.Names}}\t{{.Label "${RUN_LABEL}"}}`,
    ],
    { allowFail: true },
  );
  for (const line of cs.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const [name, runId] = line.split('\t');
    if (runId === RUN_ID) continue;
    await docker(['rm', '-f', '-v', name], { allowFail: true, timeoutMs: 30_000 });
    console.log(`  pruned container ${name} (run ${runId || 'unlabelled'})`);
    removed++;
  }
  const { stdout: ns } = await docker(
    ['network', 'ls', '--filter', `label=${LABEL}=1`, '--format', '{{.Name}}'],
    { allowFail: true },
  );
  for (const name of ns.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (name.includes(RUN_ID)) continue;
    await docker(['network', 'rm', name], { allowFail: true, timeoutMs: 20_000 });
    console.log(`  pruned network ${name}`);
    removed++;
  }
  console.log(removed ? `\npruned ${removed} resource(s)` : '\nnothing to prune');
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const serverVersion = await assertDockerAvailable();

  if (opts.prune) {
    console.log(`docker ${serverVersion} — pruning orphans labelled ${LABEL}=1`);
    console.log(
      '  (this removes resources from EVERY other run of this harness, so do not ' +
        'run it while another verify:image run is in flight — it is for orphans ' +
        'left by a crashed run.)',
    );
    await prune();
    return;
  }

  if (opts.platform && opts.platform.includes(',')) {
    fail(
      `--platform ${opts.platform} names more than one platform. \`docker buildx ` +
        'build --load\` cannot load a multi-platform manifest into the daemon, so ' +
        'this harness takes ONE platform per invocation. Run it twice.',
    );
  }
  if (opts.platform && !/^[a-z0-9]+\/[a-z0-9]+(\/[a-z0-9]+)?$/.test(opts.platform)) {
    fail(
      `--platform ${opts.platform} is not an <os>/<arch> pair (e.g. linux/amd64). ` +
        'A bare arch would otherwise produce a confusing "no known NAPI arch token" ' +
        'failure several steps later.',
    );
  }
  const host = await hostPlatform();
  const platform = opts.platform ?? host;
  const emulated = platformArch(platform) !== platformArch(host);

  console.log(`docker ${serverVersion}`);
  console.log(`run id ${RUN_ID} · platform ${platform} · host ${host} · tag ${opts.tag}`);
  if (emulated) {
    console.log(
      `NOTE: ${platform} is emulated on a ${host} host (QEMU). Everything is slow, ` +
        'and `docker run` prints a platform-mismatch WARNING on stderr that is not ' +
        'a failure.',
    );
  }

  if (opts.build) {
    await buildImage(platform, opts.tag, emulated);
  } else {
    console.log('--no-build: reusing the existing local tag');
  }
  // The build has its own timeout above; the ceiling below covers the checks, so
  // "the build hung" and "a check hung" are distinguishable.
  armWatchdog(WATCHDOG_MS);
  await assertImageMatchesPlatform(opts.tag, platform);

  // ── gather the artifact facts ─────────────────────────────────────────────
  const napi = await probe(opts.tag, platform, 'napi', PROBE_NAPI);
  const otel = await probe(opts.tag, platform, 'otel', PROBE_OTEL);
  const sweep = await probe(opts.tag, platform, 'sweep', PROBE_SWEEP);
  const native = await probe(opts.tag, platform, 'native', PROBE_NATIVE);
  const middleware = await probe(opts.tag, platform, 'middleware', PROBE_MIDDLEWARE);
  // The gate-code pin (check 13). NOT a `probe()`: it runs no code from the image at
  // all — `docker create` + `docker cp` against a container that is never started —
  // because this is the one check whose whole claim is that the artifact did not get
  // to influence what was reported about it. A failure here is fatal rather than
  // deferred to a named check, for the same reason: there is no partial answer. It
  // fails BEFORE the --update-baseline branch, so a broken extraction cannot be
  // blessed into the baseline.
  let gate;
  try {
    gate = await extractGatePin(opts.tag, platform);
  } catch (err) {
    fail(
      `could not read the middleware's compiled code out of the image: ${err.message}\n\n` +
        'This is check 13\'s input — the bytes of the gate that actually ships — and it ' +
        'is read by copying files out of a container that is never started, so no code ' +
        'from the image runs. A failure here means the standalone layout is not what ' +
        'this harness understands (a Next.js major, a bundler change, or an image that ' +
        'is not the standalone output), not that the gate is wrong. Read the error, then ' +
        `re-pin with \`${REPIN_CMD} --allow-gate-change\` once you know why it moved.`,
    );
  }

  // These two run BEFORE any check, so they must tolerate a failed probe without
  // throwing — the whole point of the named-check machinery is that a probe
  // failure becomes checks 3/5/6 reporting it, not an abort that also skips the
  // --update-baseline gate. A failed probe is a Proxy that throws on any access
  // but `__error`, so ask that first rather than relying on `?? []`.
  const probeList = (result, prop) => (result?.__error ? [] : (result[prop] ?? []));
  const tracedExternals = [
    ...new Set(probeList(sweep, 'leaves').map((l) => stripHash(l.spec))),
  ].sort();
  const nativeModules = [
    ...new Set(probeList(native, 'files').map(normaliseNativePath)),
  ].sort();
  // The gate's matcher set and the built-route count are pinned rather than
  // recomputed, because every satisfaction-test of the matcher has been defeated by
  // a one-line edit. See check 11.
  //
  // BOTH FIELDS ARE CARRIED, and that is the whole point. An earlier revision kept
  // only `originalSource` here and check 11 compared only sources — a measured hole:
  // narrowing ONLY the compiled `regexp` (to `^/api/[a-z-]+(?:/[a-z-]+)*$`) while
  // leaving `originalSource: "/api/:path*"` and the 30-route list byte-identical
  // passed 12/12 while all ten dynamic /api/* routes were ungated, including
  // /api/registry/agents/[aid]/export and an anonymous
  // GET /api/webhooks/1/circuit-breaker -> 200 with no x-request-id.
  // `regexp` is what Next matches requests against; `originalSource` is a
  // human-readable label for it and enforces nothing.
  const middlewareMatchers = probeList(middleware, 'matchers')
    .map(normaliseMatcher)
    .sort((a, b) => matcherKey(a).localeCompare(matcherKey(b)));
  // THE ROUTE IDENTITIES, not just how many there are. Pinning only the count was a
  // measured hole of its own — the sixth break: rename 19 gated manifest keys to
  // `/api/decoy-N` while widening the compiled gate body to let everything but the two
  // sampled paths through, and the count is still 30, the matchers are still
  // byte-identical, coverage is still complete and every pinned-public route is still
  // built. 13/13 green, while /api/tcts, /api/pinned-keys, /api/trust-anchors,
  // /api/sessions, /api/dashboard/overview and /api/webhooks/1/circuit-breaker all
  // answered 200 to an anonymous caller. A count cannot see a SUBSTITUTION; a list can.
  const apiRoutes = [...probeList(middleware, 'routes')].sort();
  const apiRouteCount = apiRoutes.length;

  // ── structural checks ────────────────────────────────────────────────────
  //
  // These run BEFORE the --update-baseline branch, and --update-baseline refuses
  // to write if any of them failed. Otherwise regenerating the baseline could
  // BLESS a broken image: `--update-baseline` would happily record the names of
  // dangling symlinks, or of an aitp binary built for the wrong architecture —
  // exactly the states checks 3 and 4 exist to catch. A baseline is only
  // meaningful if the artifact it was taken from was structurally sound.
  await runCheck(1, 'the NAPI binary loads under the image arch and libc', async () => {
    requireProbe(napi, 'napi');
    if (napi.aitpAgent !== 'function') {
      fail(
        `typeof require('aitp').AitpAgent is ${JSON.stringify(napi.aitpAgent)}, expected ` +
          '"function" — the native module did not load in the image',
      );
    }
    return `typeof require('aitp').AitpAgent === 'function'`;
  });

  await runCheck(2, 'the OpenTelemetry SDK was traced into the image', async () => {
    requireProbe(otel, 'otel');
    if (otel.scopeError) {
      fail(
        `${TRACED_DIR}/@opentelemetry is not readable: ${otel.scopeError}\n` +
          'The OpenTelemetry tree was not traced into the standalone output. Note that ' +
          '`require("@opentelemetry/sdk-node")` may still succeed from /app/node_modules ' +
          '— being INSTALLED is not being TRACED, and only the traced copy is what the ' +
          'server chunks load.',
      );
    }
    if (!otel.entry) {
      fail(
        `${TRACED_DIR}/@opentelemetry exists but holds no sdk-node entry. Present ` +
          `(hashes stripped): ${JSON.stringify(otel.stripped)}`,
      );
    }
    if (otel.tracedError) {
      fail(
        `${TRACED_DIR}/@opentelemetry/${otel.entry} does not resolve: ${otel.tracedError}\n` +
          'The traced entry is present but broken — a dangling symlink, or a hashed COPY ' +
          'that lost its dependencies.',
      );
    }
    return (
      `${otel.stripped.length} traced @opentelemetry entries ` +
      `(${otel.stripped.join(', ')}); ${otel.entry} -> ${otel.tracedRealpath}`
    );
  });

  await runCheck(
    3,
    // "present": this check ranges over the leaves that ARE there and says
    // nothing about ones that should be — an image missing an entire traced
    // scope satisfies it vacuously. Completeness is check 5's job, against the
    // baseline. The title says so rather than implying a guarantee it does not
    // give.
    'every traced external present is a symlink into /app/node_modules and resolves',
    async () => {
      requireProbe(sweep, 'sweep');
      if (!sweep.exists) fail(`${TRACED_DIR} does not exist in the image`);
      if (!sweep.resolveFromExists) {
        fail(
          `${RESOLVE_FROM} does not exist in the image. Resolution is probed FROM the ` +
            'server chunks because they are what require the hashed specifiers; if that ' +
            'directory is gone the image is not the standalone output we think it is. ' +
            '(require.resolve walks up and would have succeeded anyway, which is why ' +
            'this is asserted separately.)',
        );
      }
      if (sweep.error) fail(`walking ${TRACED_DIR} failed: ${sweep.error}`);
      if (sweep.anomalies?.length) {
        fail(
          'unexpected non-symlink leaves (a hashed COPY instead of a symlink loses the ' +
            'sibling native binary — vercel/next.js#88844):\n' +
            sweep.anomalies.map((a) => `  ${a.spec} (${a.kind})`).join('\n'),
        );
      }
      if (!sweep.leaves?.length) fail(`${TRACED_DIR} contains no traced externals at all`);
      const broken = sweep.leaves.filter((l) => l.error);
      if (broken.length) {
        fail(
          'traced specifiers that do not resolve from the server chunks:\n' +
            broken.map((l) => `  ${l.spec}: ${l.error}`).join('\n'),
        );
      }
      const outside = sweep.leaves.filter((l) => !l.realpath?.startsWith(`${REAL_MODULES}/`));
      if (outside.length) {
        fail(
          `traced specifiers whose realpath is not under ${REAL_MODULES}:\n` +
            outside.map((l) => `  ${l.spec} -> ${l.realpath}`).join('\n'),
        );
      }
      // ...and it must point at the RIGHT package. "Somewhere under
      // /app/node_modules" is not enough: `aitp-<hash> -> node_modules/pg`
      // satisfies every assertion above while handing the server the wrong
      // module, and `aitp` is the one whose wrong answer ships a missing native
      // binary.
      const mispointed = sweep.leaves.filter(
        (l) => l.realpath !== `${REAL_MODULES}/${stripHash(l.spec)}`,
      );
      if (mispointed.length) {
        fail(
          'traced specifiers whose symlink does not point at the package of the same ' +
            'name:\n' +
            mispointed
              .map(
                (l) =>
                  `  ${l.spec} -> ${l.realpath} (expected ${REAL_MODULES}/${stripHash(l.spec)})`,
              )
              .join('\n'),
        );
      }
      return sweep.leaves.map((l) => `${l.spec} -> ${l.realpath}`).join('\n');
    },
  );

  await runCheck(
    4,
    'the aitp native binary carries the arch token this platform asked for',
    async () => {
      requireProbe(native, 'native');
      if (native.error) fail(`inventorying ${APP_DIR} failed: ${native.error}`);
      const arch = platformArch(platform);
      const napiArch = NAPI_ARCH[arch];
      if (!napiArch) fail(`no known NAPI arch token for platform arch \`${arch}\``);
      const token = `linux-${napiArch}-gnu`;
      const aitpBinaries = (native.files ?? []).filter((p) => /(^|\/)aitp[-.]/.test(p));
      if (!aitpBinaries.length) {
        fail(
          `no aitp .node found in the image at all. Observed: ${
            (native.files ?? []).join(', ') || '(none)'
          }`,
        );
      }
      const wrongArch = aitpBinaries.filter((p) => !p.includes(token));
      if (wrongArch.length) {
        fail(
          `the image was built for ${platform} but its aitp binary does not carry ` +
            `\`${token}\`:\n${wrongArch.map((p) => `  ${p}`).join('\n')}\n` +
            'An image shipping the wrong arch binary (or none) is the #54-class failure ' +
            'this check exists for.',
        );
      }
      return aitpBinaries.join('\n');
    },
  );

  const structuralFailures = results.filter((r) => !r.ok).length;

  if (opts.updateBaseline) {
    if (structuralFailures) {
      fail(
        `refusing to write a baseline: ${structuralFailures} structural check(s) failed ` +
          'above, so this image is not sound enough to be a reference. Writing anyway ' +
          'would bless the defect — the next run would compare a broken image against a ' +
          'baseline taken FROM a broken image and report green. Fix the image first.',
      );
    }
    // The SAME fail-closed rule check 11 applies, applied at WRITE time. Without it
    // an image whose matcher carried a runtime-enforced condition was recorded with
    // the condition intact while the diff reported "middlewareMatchers: unchanged",
    // because the diff compares matcherKey() — a projection onto two fields. A later
    // verify did fail on it, so nothing shipped, but the baseline had been taught the
    // bypass. Measured with `missing: [{type:"header",key:"cookie"}]`.
    const writeOffenders = middlewareMatchers.flatMap((m) =>
      unknownMatcherKeys(m).map(
        (k) =>
          `  matcher ${JSON.stringify(m.originalSource ?? '?')} carries \`${k}\`: ` +
          JSON.stringify(m[k]),
      ),
    );
    if (writeOffenders.length) {
      fail(
        'refusing to write a baseline: a middleware matcher in this image carries a ' +
          'condition this harness has not reasoned about:\n' +
          writeOffenders.join('\n') +
          '\n\nNext enforces `has`/`missing` at RUNTIME while leaving the source unchanged, ' +
          'so recording one here would pin a gate bypass as the expected state. Reason ' +
          'about the condition and add its key to ALLOWED_MATCHER_KEYS deliberately, or ' +
          'fix the image.',
      );
    }
    // A baseline cannot pin a gate that could not be read. Check 13 would fail on the
    // next verify anyway, but writing first and failing later means the unreadable
    // state is in the committed file and the failure looks like drift.
    if (gate.regionError) {
      fail(
        'refusing to write a baseline: the compiled gate could not be located in this ' +
          `image.\n  ${gate.regionError}\n\n` +
          'Pinning the graph digests without the gate region would leave check 13 with ' +
          'only its opaque half, so every later failure would say "some byte moved" and ' +
          'nothing more — losing exactly the triage the region exists to provide.',
      );
    }
    // The structural gate above is necessary but NOT sufficient, and the hole is
    // demonstrable: an image with the whole `.next/node_modules/@opentelemetry`
    // scope deleted passes checks 1-4 (check 2 used to be vacuous; check 3 only
    // ranges over leaves that are present), so `--update-baseline` would quietly
    // record a SHRUNKEN traced set and bless the regression. Checks 5-6 cannot be
    // part of the gate — a legitimate set change is exactly when you regenerate,
    // and gating on them would make the flag unusable for its actual purpose.
    //
    // So the gate on REMOVALS is explicit consent instead. Additions are printed
    // and allowed: a new external appearing is the benign direction. Entries
    // DISAPPEARING is the direction that turns a regression into a new normal.
    const prev = existsSync(BASELINE_PATH)
      ? (() => {
          try {
            return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
          } catch {
            return null;
          }
        })()
      : null;

    if (prev) {
      const diff = (before, after) => ({
        added: after.filter((x) => !before.includes(x)),
        removed: before.filter((x) => !after.includes(x)),
      });
      const t = diff(prev.tracedExternals ?? [], tracedExternals);
      const n = diff(prev.nativeModules ?? [], nativeModules);
      // Compared through matcherKey, so a change to the COMPILED regexp with the
      // source untouched shows up as a removal plus an addition rather than as
      // "unchanged". A sources-only baseline (the older shape) keys to its bare
      // string and therefore also reads as a removal — correct: that pin no longer
      // exists, and check 11 refuses to run against it.
      const mw = diff(
        (prev.middlewareMatchers ?? []).map(matcherKey),
        middlewareMatchers.map(matcherKey),
      );
      const show = (title, d) => {
        if (!d.added.length && !d.removed.length) {
          console.log(`  ${title}: unchanged`);
          return;
        }
        console.log(`  ${title}:`);
        for (const s of d.removed) console.log(`    - ${s}`);
        for (const s of d.added) console.log(`    + ${s}`);
      };
      console.log('\nbaseline diff (existing -> this image):');
      show('tracedExternals', t);
      show('nativeModules', n);
      show('middlewareMatchers', mw);
      const ar = diff(prev.apiRoutes ?? [], apiRoutes);
      show('apiRoutes', ar);
      if (prev.apiRouteCount !== apiRouteCount) {
        console.log(`  apiRouteCount: ${prev.apiRouteCount} -> ${apiRouteCount}`);
      } else {
        console.log('  apiRouteCount: unchanged');
      }

      const removed = [
        ...t.removed.map((s) => `tracedExternals: ${s}`),
        ...n.removed.map((s) => `nativeModules: ${s}`),
        // A matcher disappearing means the gate stopped covering routes. That is the
        // most consequential removal this baseline can record, so it needs the same
        // explicit consent as the others.
        ...mw.removed.map((s) => `middlewareMatchers: ${s}`),
        // A SHRINKING route count is a removal too, and it had no gate: a manifest
        // trimmed to 3 routes was silently re-blessed at 3 with exit 0 and no
        // consent, even though this baseline's own `_comment` calls any change to
        // apiRouteCount a security review. An under-reporting manifest is also what
        // makes check 11's coverage cross-check vacuous, so re-blessing a lower
        // count removes the very thing that catches it.
        ...(Number.isInteger(prev.apiRouteCount) && apiRouteCount < prev.apiRouteCount
          ? [`apiRouteCount: ${prev.apiRouteCount} -> ${apiRouteCount} (routes vanished)`]
          : []),
        // A route IDENTITY disappearing is the removal that matters most, because it is
        // half of a count-preserving substitution: 19 gated routes renamed to decoys
        // reads as 19 removals and 19 additions, and only the removal half is
        // dangerous. Without this gate, `--update-baseline` would re-bless the decoy
        // population at the same count with exit 0 and no consent.
        ...ar.removed.map((s) => `apiRoutes: ${s}`),
      ];
      if (removed.length && !opts.allowRemovals) {
        fail(
          `refusing to write a baseline: ${removed.length} entr${removed.length === 1 ? 'y' : 'ies'} ` +
            'would be REMOVED:\n' +
            removed.map((s) => `  - ${s}`).join('\n') +
            '\n\nSomething that used to ship no longer does. That is the shape of the ' +
            'regression this baseline exists to catch, and recording it would make the ' +
            'regression the new normal — silently, because every later run would then ' +
            'agree with the shrunken set. The structural checks above cannot see this: ' +
            'an image missing an entire traced scope still passes them.\n' +
            'If the removal is intended, re-run with --allow-removals.',
        );
      }

      // ── THE GATE-CHANGE GATE ────────────────────────────────────────────
      //
      // The removal gate above is the right ceremony for an inventory: things that
      // used to ship and no longer do. It is the WRONG ceremony for the gate's
      // compiled code, where the dangerous direction is not removal but CHANGE —
      // every defeat this phase measured added or rewrote a few bytes and removed
      // nothing. So the gate code gets its own consent flag, and the diff is printed
      // before the flag is demanded rather than after it is given.
      //
      // This is also the answer to a hole measured against the previous design:
      // `--update-baseline --allow-removals`, which check 11's own failure text
      // recommends, could re-bless a route population that had lost real routes to
      // decoy renames. That attack worked because the population was load-bearing
      // for CORRECTNESS. It no longer is — the decoy rename was only ever the cover
      // for a compiled-gate edit, and the edit is now a failed equality whatever the
      // route list says. What consent protects has moved, so the consent has moved
      // with it.
      const prevGraph = Array.isArray(prev.bootGraph) ? prev.bootGraph : null;
      const prevCanonical = existsSync(GATE_CANONICAL_PATH)
        ? readFileSync(GATE_CANONICAL_PATH, 'utf8').replace(/\n$/, '')
        : null;
      const gateChanges = [];
      if (!prevGraph) {
        gateChanges.push('  bootGraph: not pinned yet (this baseline predates check 13)');
      } else if (JSON.stringify(prevGraph) !== JSON.stringify(gate.graph)) {
        console.log('  bootGraph:');
        const m2 = Math.max(prevGraph.length, gate.graph.length);
        for (let i = 0; i < m2; i++) {
          const a = prevGraph[i];
          const b = gate.graph[i];
          if (JSON.stringify(a) === JSON.stringify(b)) continue;
          if (a) console.log(`    - ${a.path} ${a.sha256} (${a.bytes} bytes)`);
          if (b) console.log(`    + ${b.path} ${b.sha256} (${b.bytes} bytes)`);
        }
        gateChanges.push(
          `  bootGraph: ${
            prevGraph.filter((a, i) => JSON.stringify(a) !== JSON.stringify(gate.graph[i])).length
          } file(s) differ (see above)`,
        );
      } else {
        console.log('  bootGraph: unchanged');
      }
      if (prev.nextTreeSha !== gate.nextTree.sha256) {
        console.log(`  nextTreeSha: ${prev.nextTreeSha ?? '(not pinned yet)'} -> ${gate.nextTree.sha256}`);
        gateChanges.push('  nextTreeSha: the Next framework tree differs (see above)');
      } else {
        console.log('  nextTreeSha: unchanged');
      }
      if (prevCanonical === null) {
        gateChanges.push(
          `  the compiled gate: ${path.relative(ROOT, GATE_CANONICAL_PATH)} does not exist yet`,
        );
      } else if (prevCanonical !== gate.region) {
        console.log('  the compiled gate CHANGED:');
        console.log(locatedDiff(prevCanonical, gate.region));
        gateChanges.push('  the compiled gate: differs (the located diff is above)');
      } else {
        console.log('  the compiled gate: unchanged');
      }
      const prevCfg = prev.imageConfig ?? null;
      if (!prevCfg) {
        gateChanges.push('  imageConfig: not pinned yet (this baseline predates check 13)');
      } else {
        const cfgDiffs = PINNED_IMAGE_CONFIG_FIELDS.filter(
          (k) => JSON.stringify(prevCfg[k] ?? null) !== JSON.stringify(gate.imageConfig[k] ?? null),
        );
        if (cfgDiffs.length) {
          console.log('  imageConfig:');
          for (const k of cfgDiffs) {
            console.log(`    - Config.${k} ${JSON.stringify(prevCfg[k] ?? null)}`);
            console.log(`    + Config.${k} ${JSON.stringify(gate.imageConfig[k] ?? null)}`);
          }
          gateChanges.push(`  imageConfig: ${cfgDiffs.join(', ')} differ (see above)`);
        } else {
          console.log('  imageConfig: unchanged');
        }
      }
      if (gateChanges.length && !opts.allowGateChange) {
        fail(
          'refusing to write a baseline: this would RE-PIN THE COMPILED GATE.\n' +
            gateChanges.join('\n') +
            '\n\nThe diff is printed above. Read it before consenting, because this is the ' +
            'one field in this file that an attacker would want you to update: every gate ' +
            'defeat this harness has measured — a rewritten isPublicRequest, a flipped ' +
            'method operator, an appended `|| !headers.get("origin")`, an id-length ' +
            'exemption — appears here as a few extra bytes and nothing else. None of them ' +
            'touch src/proxy.ts, so `verify:gate` (which builds its own server from ' +
            'source) is structurally blind to all of them and cannot corroborate.\n\n' +
            'If the gate region above is UNCHANGED and only the graph digests moved, this ' +
            'is a compiler or framework change around an untouched gate — the expected, ' +
            'benign case, and the one this trade-off was accepted for.\n\n' +
            'Re-run with --allow-gate-change once you can name the source change that ' +
            'produced the diff.',
        );
      }
    }

    const baseline = {
      _comment:
        'Normalised inventory of the shipped standalone image, derived from a BUILT ' +
        'IMAGE (never from next.config.ts). `tracedExternals` is the set of ' +
        '.next/node_modules leaves with the 16-hex Turbopack suffix stripped — it is ' +
        'NOT serverExternalPackages: pg and pino are traced without being listed, and ' +
        '@grpc/grpc-js is listed without ever being traced. `nativeModules` is every ' +
        '.node under /app with the arch token replaced by <ARCH> and a trailing ' +
        '-<semver> dropped, so one baseline serves linux/amd64 and linux/arm64. ' +
        '`middlewareMatchers` is the request gate\'s matcher set; it is PINNED rather ' +
        'than recomputed, because every attempt to verify the matcher by testing what it ' +
        'satisfies was defeated by a one-line edit (see check 11). Each matcher records ' +
        'BOTH the compiled `regexp` and its `originalSource`, and the regexp is the ' +
        'load-bearing half: it is what Next matches requests against, while ' +
        'originalSource enforces nothing. Narrowing only the regexp, with the source ' +
        'left byte-identical, was measured to pass every other check while leaving all ' +
        'ten dynamic /api/* routes ungated. `apiRoutes` pins the IDENTITIES of the built ' +
        '/api/* routes and `apiRouteCount` their number; identities are pinned because a ' +
        'count cannot see a SUBSTITUTION — renaming 19 gated routes to decoy names, ' +
        'count unchanged at 30, was measured to pass every check while six admin routes ' +
        'answered 200 anonymously. Those two are CHANGE DETECTION for the route surface ' +
        '(a route appearing, vanishing or being renamed is a review point) and are no ' +
        'longer what establishes the gate is CORRECT — check 13 does that by equality. ' +
        '`bootGraph`, `nextTreeSha` and `imageConfig` are check 13, the gate-code pin, ' +
        'and they cover the gate\'s whole LOAD PATH rather than just its own chunk: ' +
        'bootGraph is server.js plus every file the middleware and instrumentation ' +
        'loaders pull in, by SHA-256; nextTreeSha is one aggregate digest of ' +
        '/app/node_modules/next; imageConfig pins Env, Entrypoint, Cmd, WorkingDir and ' +
        'User. Breadth is the point: an equality on the gate chunk alone proves the ' +
        'reviewed gate is on DISK, not that it RUNS, and a hook in server.js, the ' +
        'instrumentation chunk or the next tree was measured to rewrite the gate in ' +
        'memory while its chunk stayed byte-identical. Out of scope, and it must be ' +
        'stated: the node binary, libc and the base OS — a docker-cp check cannot ' +
        'out-trust the runtime that executes the files it read; that is the Dockerfile ' +
        'FROM pin\'s job, and checks 8-12 are the behavioural complement. The compiled ' +
        'gate itself is committed VERBATIM in scripts/image-gate-canonical.txt, not in ' +
        'this file, so it can be read and `git log -p`-ed. These replaced a 360-request ' +
        'behavioural probe of the route population that was defeated five times by ' +
        'request shapes it held constant (the verb, the population, the id shape, the id ' +
        'length, the Origin header); an equality has no such dimensions. The cost, ' +
        'accepted: a Next.js or Turbopack upgrade that recompiles the same source fails ' +
        'check 13 with no behaviour change to show for it, and needs `--update-baseline ' +
        '--allow-gate-change`. When that happens the harness says whether the GATE ' +
        'REGION moved or only the framework bytes around it, which is the difference ' +
        'between a security review and housekeeping. ' +
        'Review every line by hand: a new entry means a new external or a new native ' +
        'binary shipped, a missing entry means one stopped shipping, and any change to ' +
        'middlewareMatchers, bootGraph, nextTreeSha, imageConfig, apiRoutes or ' +
        'apiRouteCount is a security review — the first changes what the gate covers, ' +
        'the next three change the code it runs and the environment it runs in, and the ' +
        'last two mean a route appeared, vanished or was renamed.',
      _regenerate: 'node scripts/verify-image.mjs --update-baseline',
      tracedExternals,
      nativeModules,
      middlewareMatchers,
      // The IDENTITIES of the built /api/* routes, pinned so that a count-preserving
      // SUBSTITUTION of route keys cannot pass. Measured from the image like
      // tracedExternals, so it needs no hand-authoring.
      //
      // NOTE ON WHAT THIS IS NOW FOR. It was load-bearing for correctness while
      // check 13 probed the population behaviourally — the probe set came from here so
      // a lying manifest could not choose its own interrogation. Check 13 is an
      // equality on compiled code now, so this is change detection: a route appearing
      // or vanishing is a review point, and a rename still reads as removals plus
      // additions under the removal gate. The decoy-population attack it was built
      // against is dead either way, because its compiled-gate edit is a failed
      // equality whatever the route list says.
      apiRoutes,
      apiRouteCount,
      // ── check 13: the gate-code pin ──────────────────────────────────────
      //
      // The gate's LOAD PATH: server.js, the files `.next/server/middleware.js` loads,
      // and the files `.next/server/instrumentation.js` loads (which the middleware
      // entry awaits in the same realm at boot), each with byte length and SHA-256,
      // paths prefixed by loader so they compose. Derived from the artifacts' own
      // loaders rather than hardcoded, so a Next upgrade that splits the code
      // differently is followed — and because the file NAMES are part of the pin, a
      // swap to a different chunk is a diff and not a silent redirection.
      //
      // This is the COMPLETE half of check 13 over the app-authored + compiled code:
      // it needs no locator, no parsing and no anchor. It is also churny — Next's
      // middleware adapter lives in the same chunk as the gate, so a framework patch
      // moves these digests with the gate untouched. That is what the canonical gate
      // file below exists to disambiguate. It is BROADER than the gate chunk on
      // purpose: an equality on the gate chunk alone proves the reviewed gate is on
      // disk, not that it RUNS, and a hook in server.js or the instrumentation chunk
      // was measured to rewrite the gate in memory while its chunk stayed identical.
      bootGraph: gate.graph,
      // One aggregate SHA-256 over /app/node_modules/next — the framework tree that
      // loads and invokes the gate chunk, where a require-time hook would rewrite the
      // gate before it runs. Measured byte-identical across arches; moves only on a
      // `next` bump, the same event that moves the gate region.
      nextTreeSha: gate.nextTree.sha256,
      // Env / Entrypoint / Cmd / WorkingDir / User: what runs, before any assertion in
      // this harness gets a say.
      imageConfig: gate.imageConfig,
      // Where the verbatim compiled gate lives. Named in the baseline so the two files
      // are obviously one pin and a reviewer reading either finds the other.
      gateCanonicalFile: path.relative(ROOT, GATE_CANONICAL_PATH),
      gateRegion: { bytes: gate.region.length, sha256: sha256Hex(Buffer.from(gate.region, 'utf8')) },
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
    // Written VERBATIM, plus one trailing newline so the file is well-formed for text
    // tools; the comparison strips that newline and is then byte equality. No
    // pretty-printing and no normalisation — see GATE_CANONICAL_PATH.
    writeFileSync(GATE_CANONICAL_PATH, gate.region + '\n');
    console.log(`\nbaseline written: ${BASELINE_PATH}`);
    console.log(`  tracedExternals (${tracedExternals.length}):`);
    for (const s of tracedExternals) console.log(`    ${s}`);
    console.log(`  nativeModules (${nativeModules.length}):`);
    for (const s of nativeModules) console.log(`    ${s}`);
    // Printed in full, regexp included: this is the line a human has to review, and
    // it is the one with security consequences.
    console.log(`  middlewareMatchers (${middlewareMatchers.length}):`);
    for (const m of middlewareMatchers) console.log(`    ${matcherKey(m)}`);
    // Printed in full as well: this is the list a human has to compare against the
    // routes they believe exist, and a decoy name is only obvious when it is on screen.
    console.log(`  apiRoutes (${apiRoutes.length}):`);
    for (const r of apiRoutes) console.log(`    ${r}`);
    console.log(`  apiRouteCount: ${apiRouteCount}`);
    console.log(`  bootGraph (${gate.graph.length} file(s), middleware entry module ${gate.entryId}):`);
    for (const g of gate.graph) console.log(`    ${g.sha256}  ${String(g.bytes).padStart(7)}  ${g.path}`);
    console.log(`  nextTreeSha: ${gate.nextTree.sha256} (${gate.nextTree.count} files)`);
    console.log('  imageConfig:');
    for (const k of PINNED_IMAGE_CONFIG_FIELDS) {
      console.log(`    Config.${k} = ${JSON.stringify(gate.imageConfig[k] ?? null)}`);
    }
    console.log(
      `\ncompiled gate written: ${GATE_CANONICAL_PATH}\n` +
        `  ${gate.region.length} bytes, extracted from module ${gate.entryId} of ` +
        `${gate.hostChunk}\n` +
        '  READ IT BEFORE COMMITTING. It is the gate that will ship, in the form that ' +
        'will ship, and it is the one artifact in this repo that `verify:gate` cannot ' +
        'corroborate — that harness builds its own server from src/proxy.ts and never ' +
        'looks at the image, which is precisely why five separate defeats of this phase ' +
        'left the source untouched.',
    );
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    fail(`no baseline at ${BASELINE_PATH} — generate it with --update-baseline`);
  }
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (err) {
    fail(`could not read ${BASELINE_PATH}: ${err.message}`);
  }


  await runCheck(5, 'the traced external set matches the committed baseline', async () => {
    requireProbe(sweep, 'sweep');
    const want = [...(baseline.tracedExternals ?? [])].sort();
    const diffs = [];
    for (const spec of new Set([...want, ...tracedExternals])) {
      const inBaseline = want.includes(spec);
      const inImage = tracedExternals.includes(spec);
      if (inBaseline && !inImage) diffs.push(`  MISSING from the image: ${spec}`);
      if (!inBaseline && inImage) diffs.push(`  NEW in the image:       ${spec}`);
    }
    if (diffs.length) {
      fail(
        'the traced-externals set drifted from scripts/image-artifact-baseline.json:\n' +
          diffs.join('\n') +
          '\n\nA MISSING entry means a package stopped being traced — most likely it was ' +
          'dropped from serverExternalPackages in next.config.ts. Measured: dropping one ' +
          'of the `@opentelemetry/*` entries lands here, as MISSING; dropping `aitp` never ' +
          'reaches this check at all, because Turbopack cannot bundle the native module ' +
          'and `next build` fails outright inside the image build. Both are caught, at ' +
          'different steps. If the change is intended, review every line above, then ' +
          'regenerate with `node scripts/verify-image.mjs --update-baseline`.',
      );
    }
    return `${tracedExternals.length} traced externals: ${tracedExternals.join(', ')}`;
  });

  await runCheck(6, 'the native-module inventory matches the committed baseline', async () => {
    requireProbe(native, 'native');
    if (native.error) fail(`inventorying ${APP_DIR} failed: ${native.error}`);
    // Normalisation replaces the arch token, so two binaries for DIFFERENT arches
    // collapse to one entry and the diff below would not notice. That is
    // reachable: next.config.ts force-includes BOTH Linux globs, so an image that
    // somehow shipped x64 *and* arm64 would look identical to a correct one.
    // Catch the collapse itself rather than trusting it cannot happen.
    const collapsed = new Map();
    for (const raw of native.files ?? []) {
      const key = normaliseNativePath(raw);
      if (!collapsed.has(key)) collapsed.set(key, []);
      collapsed.get(key).push(raw);
    }
    const multi = [...collapsed.entries()].filter(([, raws]) => raws.length > 1);
    if (multi.length) {
      fail(
        'two or more distinct native binaries normalise to the same inventory entry, ' +
          'so the baseline diff below cannot see the difference — most likely the image ' +
          'ships more than one architecture:\n' +
          multi.map(([k, raws]) => `  ${k}\n${raws.map((r) => `    <- ${r}`).join('\n')}`).join('\n'),
      );
    }
    const want = [...(baseline.nativeModules ?? [])].sort();
    const diffs = [];
    for (const p of new Set([...want, ...nativeModules])) {
      const inBaseline = want.includes(p);
      const inImage = nativeModules.includes(p);
      if (inBaseline && !inImage) diffs.push(`  MISSING from the image: ${p}`);
      if (!inBaseline && inImage) diffs.push(`  NEW in the image:       ${p}`);
    }
    if (diffs.length) {
      fail(
        'the native-module inventory drifted from scripts/image-artifact-baseline.json:\n' +
          diffs.join('\n') +
          '\n\nPaths are normalised (<ARCH> for the arch token, trailing -<semver> ' +
          'dropped) so one baseline serves both arches and a sharp bump is absorbed. A ' +
          'genuinely new or missing binary is a review point, not noise. Regenerate with ' +
          '`node scripts/verify-image.mjs --update-baseline` once reviewed.\n' +
          `observed (raw): ${(native.files ?? []).join(', ')}`,
      );
    }
    return `${nativeModules.length} native module(s): ${nativeModules.join(', ')}`;
  });

  // ── live substrate ───────────────────────────────────────────────────────
  //
  // Deliberately AFTER the --update-baseline branch returns: regenerating the
  // baseline is a static operation and must not pay for a Postgres boot and a
  // migration run.
  //
  // Not gated on the structural checks above, on purpose. If the native binary is
  // missing the app container dies, and the readiness loop reports that in about
  // a second with the container's own logs — which is a better diagnosis than
  // skipping the live half and saying nothing about it.
  console.log('\nstanding up the live substrate');
  const net = await createNetwork();
  const pg = await startPostgres(net);
  await migrate(pg.hostPort);
  await assertSchemaMigrated(pg.name);
  const app = await startApp(net, pg.name, platform, 'app');

  // Testability hook, same rationale as the two timeout hooks. The whole run
  // takes about five seconds locally, so the window in which a network, a
  // Postgres and an app container are ALL live is well under a second — too
  // narrow to aim a signal at reliably. Teardown across every exit path is the
  // property this harness most needs to keep (an earlier revision leaked twelve
  // containers here), and a property that cannot be tested on demand is one that
  // rots. Set AITP_VERIFY_IMAGE_PAUSE_MS to hold the substrate up and Ctrl-C into
  // it. Unset in normal runs, including CI.
  const pauseMs = Number(process.env.AITP_VERIFY_IMAGE_PAUSE_MS) || 0;
  if (pauseMs) {
    console.log(
      `AITP_VERIFY_IMAGE_PAUSE_MS=${pauseMs}: holding 1 network and 2 containers up. ` +
        'Ctrl-C now to exercise teardown.',
    );
    await new Promise((r) => setTimeout(r, pauseMs));
  }

  const expectedAid = deriveAid(SEED_HEX);

  await runCheck(7, '/api/health reports db ok and the seed-derived AID', async () => {
    const r = await httpReq(app.base, '/api/health');
    // ORDER MATTERS. `db` is asserted BEFORE the status, because route.ts answers
    // 503 whenever the DB ping fails: a status-first assertion reports "status
    // 503" for an unreachable database, which is the symptom rather than the
    // cause, and buries the actual finding in a JSON blob. Checking `db` first
    // means the most specific available message is the one that fires. All three
    // properties are still asserted.
    if (r.body?.db !== 'ok') {
      fail(
        `db is ${JSON.stringify(r.body?.db)}, expected "ok" — the container cannot reach ` +
          `Postgres at ${pg.name}:5432 (HTTP status was ${r.status}; route.ts answers 503 ` +
          `when the DB ping fails). The app's logs:\n${await containerLogs(app.name)}`,
      );
    }
    if (r.body?.aid !== expectedAid) {
      fail(
        'the served AID is not the one CP_AID_SEED_HEX derives to:\n' +
          `  expected (host, node:crypto): ${expectedAid}\n` +
          `  served   (image, aitp SDK):   ${r.body?.aid}`,
      );
    }
    // Reached only when the DB is healthy and the AID is right, so a non-200 here
    // is a genuinely different problem and deserves its own message.
    if (r.status !== 200) {
      fail(
        `db and aid are both correct but the status is ${r.status}, not 200 ` +
          `(body: ${JSON.stringify(r.body)})`,
      );
    }
    // Print expectedAid, not r.body.aid: they are asserted equal just above, but the
    // label says "derived on the host", so the host's value is the honest one to show.
    return `db=ok  aid=${expectedAid}\n(derived independently on the host from CP_AID_SEED_HEX)`;
  });

  // ── gate attachment in the image (the gap #68 is named for) ──────────────
  //
  // ASSERT THE WIRE CONTRACT, NOT THE STATUS CODE. A 401 without
  // `code: INVALID_API_KEY` is a different failure wearing the right status.
  //
  // `/api/audit` is the right probe: it is absent from PUBLIC_PATHS in src/proxy.ts
  // and matches none of the public GET patterns, so it is genuinely gated. It also
  // exercises a different handler from the one the sibling harness probes, so a
  // shared-fixture mistake cannot make both harnesses agree wrongly.
  //
  // SCOPE LINE. This proves ATTACHMENT in the standalone artifact. It deliberately
  // does NOT re-prove the gate's logic: the rate-limit bucket checks need isolated
  // per-IP buckets via CLIENT_IP_HEADER and are already covered against a running
  // server by scripts/verify-request-gate.mjs. Duplicated assertions rot at
  // different rates. Do not "complete" this by copying that harness's 15 checks.
  await runCheck(8, 'the gate rejects an unauthenticated /api/audit', async () => {
    const r = await httpReq(app.base, '/api/audit');
    // Distinguish this case explicitly: it means API_KEYS never reached the
    // container, so the run was not exercising the auth path at all. Reported as
    // "wrong status" it would send a reader looking at the gate instead of the env.
    if (r.status === 503 && r.body?.code === 'SERVER_MISCONFIGURED') {
      fail(
        'got 503 SERVER_MISCONFIGURED rather than 401 — API_KEYS did not reach the ' +
          'container, so this run never exercised the auth path. Empty API_KEYS under ' +
          'NODE_ENV=production makes the gate fail closed with this code instead of ' +
          'checking the key.',
      );
    }
    if (r.status !== 401) {
      fail(`status ${r.status}, expected 401 (body: ${JSON.stringify(r.body)})`);
    }
    if (r.body?.code !== 'INVALID_API_KEY') {
      fail(
        `body.code is ${JSON.stringify(r.body?.code)}, expected "INVALID_API_KEY". The ` +
          'status alone is not the contract — a 401 from somewhere else wears it too.',
      );
    }
    // The gate injects x-request-id, so its presence is evidence the gate RAN,
    // rather than that some handler happened to answer 401.
    if (!r.headers.get('x-request-id')) {
      fail('no x-request-id on the response, so the gate did not run');
    }
    return `401 INVALID_API_KEY, x-request-id=${r.headers.get('x-request-id')}`;
  });

  await runCheck(9, 'a valid API key reaches the handler', async () => {
    // The non-vacuity half. Without it, a gate that rejected EVERYTHING
    // unconditionally — or an image serving a stub that always 401s — would satisfy
    // check 8 completely.
    const r = await httpReq(app.base, '/api/audit', { key: API_KEY });
    if (r.status === 401 || r.status === 503) {
      fail(
        `status ${r.status} WITH a valid key — the handler was not reached, so check 8's ` +
          'rejection proves nothing about the key actually being checked.',
      );
    }
    if (r.status === 500) {
      fail(
        'status 500 with a valid key. The gate let the request through but the handler ' +
          'failed — against this substrate that almost always means the migrations did ' +
          'not apply, so admin_audit_log does not exist.',
      );
    }
    if (r.status !== 200) fail(`status ${r.status} (body: ${JSON.stringify(r.body)})`);
    if (!r.headers.get('x-request-id')) {
      fail('no x-request-id on the authenticated response');
    }
    return `200 with a valid key, x-request-id present`;
  });

  await runCheck(10, 'the gate answers the CORS preflight itself', async () => {
    // NOTE, and do not "simplify" this away: the 204 and the empty body are NOT
    // attributable to the gate. Next answers OPTIONS 204/empty by itself — measured
    // on a gate-less image, where this check failed ONLY on the missing header. The
    // x-request-id assertion is the entire load-bearing part; the status and body
    // assertions are there to catch a handler answering the preflight instead.
    const r = await httpReq(app.base, '/api/audit', { method: 'OPTIONS' });
    if (r.status !== 204) fail(`status ${r.status}, expected 204`);
    if (r.text !== '') {
      fail(`expected an empty body, got ${JSON.stringify(r.text.slice(0, 200))}`);
    }
    if (!r.headers.get('x-request-id')) fail('no x-request-id on the preflight response');
    return '204, empty body, x-request-id present';
  });

  await runCheck(
    11,
    // The title names BOTH halves, because this check also fails on legitimate
    // route-count drift and a title that mentioned only the matcher sent readers
    // looking at src/proxy.ts for a new route file.
    'the matcher set and the built /api/* route identities are exactly the pinned ones',
    async () => {
      // WHY THIS IS PINNED AND NOT COMPUTED.
      //
      // Two earlier versions of this check tested whether the matcher SATISFIED a set
      // of paths — first by probing over HTTP, then by testing the built route list
      // against the matcher regexp. Both were defeated by one-line matcher edits,
      // because satisfaction-testing always samples:
      //
      //   ['/api/audit']                       defeated the 1-path HTTP probe
      //   ['/api/audit','/api/webhooks','/api/health']  defeated the 3-path probe
      //   ['/api/:path([^0-9]+)']              defeated route-list testing — the
      //       probe substitutes a literal 'a' for each [param], and 'a' has no digit,
      //       so all 30 routes "matched" while every real id (digits, uuids) did not.
      //       Anonymous POST /api/webhooks/1/circuit-breaker/reset returned 200.
      //   [{source:'/api/:path*', missing:[{type:'header',key:'cookie'}]}]
      //       defeated it again with the source UNCHANGED: Next enforces `missing` at
      //       runtime, so every request carrying a cookie skipped the gate, and
      //       GET /api/audit with a cookie returned the admin audit log.
      //
      // A sampled predicate can always be satisfied by something narrower than it
      // looks. So this asserts the matcher set ITSELF against a committed value —
      // rule 2 of this file's contract — and rejects ANY key beyond the two we have
      // reasoned about, because the second break above lived entirely in an extra
      // key. That makes unknown future matcher options fail closed instead of
      // silently widening what the gate lets past.
      //
      // AND THE PIN IS ON THE COMPILED REGEXP, not just on the source string. The
      // first pinned version compared only `originalSource`, and that was a measured
      // hole of its own — the fourth break, and round 3(a) in a new disguise:
      //
      //   regexp narrowed to ^/api/[a-z-]+(?:/[a-z-]+)*$, originalSource and the
      //       30-route list left byte-identical: 12/12 GREEN while all ten dynamic
      //       /api/* routes were ungated, including /api/registry/agents/[aid]/export,
      //       and GET /api/webhooks/1/circuit-breaker answered an anonymous caller
      //       200 {"state":"closed"} with no x-request-id.
      //
      // `regexp` is what the runtime matches against; `originalSource` is a label.
      // Reachable two ways even though `src/proxy.ts` cannot express it directly:
      // modification of the artifact between build and verification (`--no-build`
      // against a pre-existing tag is an advertised mode of this harness), and a Next
      // upgrade that compiles the same source more narrowly — which is exactly the
      // forward-compat scenario the fail-closed rules here exist to survive.
      requireProbe(middleware, 'middleware');
      if (middleware.error) {
        fail(`could not read the middleware config out of the image: ${middleware.error}`);
      }
      const expected = baseline.middlewareMatchers;
      if (!Array.isArray(expected) || !expected.length) {
        fail(
          'scripts/image-artifact-baseline.json has no `middlewareMatchers`. That is the ' +
            'pinned expectation this check compares against; without it the check would be ' +
            `vacuous. Regenerate it with \`${REPIN_CMD}\`.`,
        );
      }
      // An older baseline pinned bare source strings. Refuse it rather than compare
      // against it: the source string is not what the runtime enforces, and treating
      // it as the pin is the exact hole described above.
      const sourcesOnly = expected.filter((m) => typeof m === 'string');
      if (sourcesOnly.length) {
        fail(
          'scripts/image-artifact-baseline.json pins matcher SOURCE STRINGS only ' +
            `(${JSON.stringify(sourcesOnly)}), not the compiled regexps Next actually ` +
            'matches requests against. Narrowing only the regexp, with the source left ' +
            'byte-identical, was measured to pass every check here while leaving all ten ' +
            `dynamic /api/* routes ungated. Regenerate with \`${REPIN_CMD} --allow-removals\` ` +
            '(the shape change reads as a removal) and review the recorded regexp by hand.',
        );
      }
      const unpinned = expected.filter(
        (m) => typeof m?.regexp !== 'string' || !m.regexp.length,
      );
      if (unpinned.length) {
        fail(
          'a pinned matcher in scripts/image-artifact-baseline.json carries no `regexp`:\n' +
            unpinned.map((m) => `  ${JSON.stringify(m)}`).join('\n') +
            '\n\nThe regexp is the load-bearing half of the pin; without it this check ' +
            `only compares labels. Regenerate with \`${REPIN_CMD}\`.`,
        );
      }
      const got = middleware.matchers ?? [];
      if (!got.length) {
        fail(
          'the image records NO middleware matchers, so the gate is attached to nothing ' +
            'and every /api/* route is served with no auth, no rate limiting and no CORS.',
        );
      }
      // A string-form matcher would otherwise reach the ALLOWED loop below, where
      // `Object.keys('/api/x')` enumerates character indices and the failure reads
      // "carries `0`: \"/\"" — fail closed, but with a diagnosis that sends the reader
      // nowhere. Next has only ever emitted objects here; this is forward-compat.
      const strings = got.filter((m) => typeof m !== 'object' || m === null);
      if (strings.length) {
        fail(
          'the image records matcher(s) in a form this harness does not model ' +
            `(expected objects carrying \`regexp\`, got ${JSON.stringify(strings)}). ` +
            'Without a compiled regexp there is nothing to pin, so this fails closed. ' +
            'If Next has changed the manifest shape, model the new form here ' +
            'deliberately — do not widen the comparison to whatever it emits.',
        );
      }
      // Only two keys have been reasoned about — ALLOWED_MATCHER_KEYS, which the
      // `--update-baseline` write path applies too, so a condition cannot be recorded
      // into the baseline and then judged against it.
      const offenders = got.flatMap((m) =>
        unknownMatcherKeys(m).map(
          (k) =>
            `  matcher ${JSON.stringify(m.originalSource ?? '?')} carries \`${k}\`: ` +
            JSON.stringify(m[k]),
        ),
      );
      if (offenders.length) {
        fail(
          'a middleware matcher carries a condition this harness has not reasoned about:\n' +
            offenders.join('\n') +
            '\n\nNext enforces `has`/`missing` at RUNTIME while leaving the source unchanged, ' +
            'so such a matcher looks correct in every other check while letting requests ' +
            'past the gate. Measured: `missing: [{type:"header",key:"cookie"}]` lets any ' +
            'request with a cookie — i.e. any browser request — read /api/audit ' +
            'anonymously. If the condition is intended, reason about it here and add the ' +
            'key to ALLOWED deliberately.',
        );
      }
      // Compare the matchers WHOLE — every key, regexp included — not a projection
      // of them. A projection is what made the fourth break invisible.
      const canon = (list) =>
        [...list]
          .map(normaliseMatcher)
          .sort((a, b) => matcherKey(a).localeCompare(matcherKey(b)));
      const gotCanon = canon(got);
      const wantCanon = canon(expected);
      if (JSON.stringify(gotCanon) !== JSON.stringify(wantCanon)) {
        const sourcesMatch =
          JSON.stringify(gotCanon.map((m) => m.originalSource)) ===
          JSON.stringify(wantCanon.map((m) => m.originalSource));
        fail(
          'the middleware matcher set does not match the pinned one:\n' +
            `  pinned:\n${wantCanon.map((m) => `    ${matcherKey(m)}`).join('\n')}\n` +
            `  image:\n${gotCanon.map((m) => `    ${matcherKey(m)}`).join('\n')}\n\n` +
            (sourcesMatch
              ? 'The SOURCE strings are IDENTICAL and only the COMPILED regexp differs. ' +
                'That is the precise shape this check was rewritten to catch: the regexp ' +
                'is what the runtime matches requests against, so a narrowing there ' +
                'ungates routes while every other check — including the route-coverage ' +
                'cross-check below — stays green. Either the artifact was modified after ' +
                'the build, or a Next upgrade recompiled the same source differently. ' +
                'Establish which before re-pinning.\n\n'
              : '') +
            'Every route the matcher no longer covers is served with no auth, no rate ' +
            'limiting and no CORS. If the change is intended, review it as a security ' +
            `change and then regenerate with \`${REPIN_CMD}\`.`,
        );
      }
      // A FLOOR UNDER THE PIN. Everything above compares the image to the baseline,
      // so a baseline weakened in LOCKSTEP with the image passes — the pin alone is
      // self-referential. These literals are not derived from the manifest or from
      // src/proxy.ts, which is what makes them a floor rather than a restatement.
      // Evaluated on the host because the pinned value is a plain string this file
      // owns; the IMAGE's regexp is still evaluated in-container by the probe, where
      // Next's own semantics apply.
      const pinnedRes = wantCanon.map((m) => {
        try {
          return new RegExp(m.regexp);
        } catch (err) {
          fail(
            `the pinned matcher regexp does not compile: ${err.message}\n  ${m.regexp}\n\n` +
              'A baseline that cannot be compiled cannot be checked against anything. ' +
              `Regenerate with \`${REPIN_CMD}\`.`,
          );
        }
      });
      const uncoveredByPin = PINNED_MATCHER_MUST_COVER.filter(
        (p) => !pinnedRes.some((re) => re.test(p)),
      );
      if (uncoveredByPin.length) {
        fail(
          'the PINNED matcher regexp does not cover paths that must always be gated:\n' +
            uncoveredByPin.map((p) => `  ${p}`).join('\n') +
            '\n\nThe image agrees with the baseline, so this is the BASELINE being wrong — ' +
            'the shape of a pin weakened in lockstep with the artifact, which the equality ' +
            'above cannot see by construction. Do not re-pin to make this pass: work out ' +
            'why the matcher stopped covering these paths.',
        );
      }
      // Defence in depth, and a useful diagnostic: the pinned regexp should also, in
      // fact, cover every built route. This cannot be the primary assertion (see
      // above) but a disagreement between the two means something unmodelled.
      //
      // `uncovered` must be PRESENT. `middleware.uncovered?.length` silently skipped
      // the whole cross-check if the probe stopped reporting the field, while the line
      // below it would have thrown on a missing `routes` — two different dispositions
      // for the same kind of absence, and the quiet one was on the security half.
      if (!Array.isArray(middleware.uncovered)) {
        fail(
          'the middleware probe reported no `uncovered` array, so the route-coverage ' +
            'cross-check cannot run. Fail closed rather than skip it silently.',
        );
      }
      if (middleware.uncovered.length) {
        fail(
          `the matcher set matches the pinned value, yet ${middleware.uncovered.length} of ` +
            `${middleware.routes.length} built /api/* routes are not matched by its regexp:\n` +
            middleware.uncovered.map((r) => `  ${r}`).join('\n') +
            '\n\nThe two halves of this check disagree. The pin is authoritative, so read ' +
            'this as the regexp semantics having changed under us — a Next upgrade, or a ' +
            'route shape (optional catch-all, bare /api) the coverage probe models wrongly ' +
            '— rather than as a routing problem. Note the cross-check samples: it ' +
            'substitutes a literal `a` for each [param], so it can only ever be a ' +
            'diagnostic, never the assertion.',
        );
      }
      // A route list that under-reports would make the coverage half vacuous — a
      // trimmed manifest passed with 3 routes. Pin the count too.
      const wantCount = baseline.apiRouteCount;
      if (!Number.isInteger(wantCount)) {
        fail(
          'scripts/image-artifact-baseline.json has no integer `apiRouteCount`. ' +
            `Regenerate it with \`${REPIN_CMD}\`.`,
        );
      }
      if (middleware.routes.length !== wantCount) {
        fail(
          `the image reports ${middleware.routes.length} built /api/* routes, but the ` +
            `baseline pins ${wantCount}. A NEW route is a review point — is it gated, or ` +
            'does it belong in PUBLIC_PATHS? A MISSING one means a route stopped building, ' +
            'or the manifest is under-reporting and the coverage check above went vacuous. ' +
            `Once reviewed, re-pin with \`${REPIN_CMD}\` (a DROP in the count additionally ` +
            'needs --allow-removals).',
        );
      }
      // AND THE IDENTITIES, not only the cardinality. The count alone was the sixth
      // break: rename the 19 exposed gated keys to `/api/decoy-1..19` and the count is
      // still 30, the matchers are still byte-identical, the coverage cross-check is
      // still complete and every pinned-public route is still built — 13/13 green, while
      // /api/tcts, /api/pinned-keys, /api/trust-anchors, /api/sessions,
      // /api/dashboard/overview and /api/webhooks/1/circuit-breaker answered 200 to an
      // anonymous caller. A SUBSTITUTION is invisible to a count by construction.
      const wantRoutes = baseline.apiRoutes;
      if (!Array.isArray(wantRoutes) || !wantRoutes.length) {
        fail(
          'scripts/image-artifact-baseline.json has no non-empty `apiRoutes`. That is the ' +
            'pinned LIST of built /api/* route identities, and without it only their ' +
            'number is pinned — which a count-preserving rename of gated routes to decoy ' +
            `names passes. Regenerate with \`${REPIN_CMD}\` and read the list by hand.`,
        );
      }
      if (wantRoutes.length !== wantCount) {
        fail(
          `the baseline disagrees with itself: \`apiRoutes\` lists ${wantRoutes.length} ` +
            `route(s) but \`apiRouteCount\` pins ${wantCount}. One of the two was hand-edited ` +
            `without the other. Re-pin with \`${REPIN_CMD}\` rather than guessing which is ` +
            'right.',
        );
      }
      const routesGot = [...middleware.routes].sort();
      const routesWant = [...wantRoutes].sort();
      if (JSON.stringify(routesGot) !== JSON.stringify(routesWant)) {
        const added = routesGot.filter((r) => !routesWant.includes(r));
        const gone = routesWant.filter((r) => !routesGot.includes(r));
        fail(
          'the built /api/* route identities do not match the pinned ones' +
            (added.length === gone.length && added.length
              ? ' — and the counts are EQUAL, which is a SUBSTITUTION: the shape of the ' +
                'attack this pin exists for, where gated routes are renamed so the ' +
                'population check interrogates decoys instead of them'
              : '') +
            ':\n' +
            gone.map((r) => `  - ${r} (pinned, not built)`).join('\n') +
            (gone.length && added.length ? '\n' : '') +
            added.map((r) => `  + ${r} (built, not pinned)`).join('\n') +
            '\n\nA route in the image but not the pin has never been reviewed for whether ' +
            'it is gated. A route in the pin but not the image either stopped building or ' +
            'was renamed out from under check 13, which takes its probe population from ' +
            `this list. Review, then re-pin with \`${REPIN_CMD}\` (a removal additionally ` +
            'needs --allow-removals).',
        );
      }
      return (
        `matchers: ${gotCanon.map((m) => m.originalSource).join(', ')} — source AND ` +
        `compiled regexp both pinned, no unexpected conditions; the pinned regexp covers ` +
        `all ${PINNED_MATCHER_MUST_COVER.length} must-gate literals; ` +
        `${middleware.routes.length} built /api/* routes, all covered, and their ` +
        'identities equal the pinned list'
      );
    },
  );

  await runCheck(
    12,
    'the gate really runs — on a second gated route, a public one, and a mutating verb',
    async () => {
      // The BEHAVIOURAL half, kept alongside check 11's structural one because they
      // fail on different things. Check 11 proves the matcher covers the tree as
      // BUILT; this proves the gate actually executes for more than the one path the
      // earlier checks probe — catching a gate that is matched but inert, which no
      // manifest can show.
      //
      // Two probes, because they fail on different halves of the problem:
      //
      // 1. A SECOND genuinely gated route, under a different top-level segment.
      //    /api/webhooks is gated and is not probed by scripts/verify-request-gate.mjs
      //    (which uses /api/sessions), so the two harnesses stay independent.
      // 2. A PUBLIC route. The gate runs for every /api/* path, injecting
      //    x-request-id even where it does not reject — so a matcher that no longer
      //    covers a path loses the header there. This is the broad signal: it fails
      //    for any narrowing that excludes /api/health, whatever the gated routes do.
      //
      // Still ATTACHMENT, not gate logic: no rate-limit buckets, no per-route policy.
      const gated = await httpReq(app.base, '/api/webhooks');
      if (gated.status !== 401 || gated.body?.code !== 'INVALID_API_KEY') {
        fail(
          `unauthenticated GET /api/webhooks answered ${gated.status} ` +
            `${JSON.stringify(gated.body?.code)}, expected 401 INVALID_API_KEY. ` +
            'If check 8 passed, the gate is attached to some paths and not this one — a ' +
            'narrowed matcher in src/proxy.ts. If check 8 failed too, the gate is not ' +
            'running at all. Either way every /api/* route it does not cover is served ' +
            'with no auth, no rate limiting and no CORS.',
        );
      }
      // Public and rate-limit exempt, so this asserts only that the gate ran.
      const pub = await httpReq(app.base, '/api/health');
      if (!pub.headers.get('x-request-id')) {
        fail(
          'GET /api/health carries no x-request-id. That header is injected by the gate ' +
            'on its pass-through path, so its absence means the gate does not run for ' +
            '/api/health at all — the matcher no longer covers the whole /api/* tree.',
        );
      }
      // 3. ONE MUTATING VERB, and exactly one.
      //
      // The gate's decision is `isPublicRequest(pathname, method)` — it takes the
      // METHOD — so a gate can be correct for GET and wrong for everything else, and
      // every assertion above this line is a GET. That was measured, not supposed: one
      // operator flipped in the compiled gate (`"GET"===t&&` -> `"GET"!==t||`) left
      // `GET /api/audit` answering 401 throughout while an anonymous
      // `POST /api/trust-anchors {"issuerUrl":"https://evil.example.com"}` returned 201
      // and created a trust anchor pointing at an attacker-controlled issuer.
      //
      // ONE request, deliberately. An earlier version of this phase answered the same
      // finding with a 360-request cross product of six verbs, thirty routes and four id
      // shapes, and was then defeated by the request shape and the id length — because
      // the answer to "your sample missed a dimension" is not a bigger sample. That
      // proof now lives in check 13, which compares the gate's compiled bytes to a
      // committed copy and so covers every verb at once without sending anything. What
      // this line adds, and what check 13 structurally cannot, is that the pinned bytes
      // are REACHED on a verb other than GET: a mutating request really does arrive at
      // the gate and really is refused. `/api/trust-anchors` because it is the route
      // whose exposure was actually measured, and POST because that is what created the
      // anchor.
      const wrote = await httpReq(app.base, '/api/trust-anchors', {
        method: 'POST',
        body: { issuerUrl: 'https://verify-image-harness.invalid' },
      });
      if (wrote.status !== 401 || wrote.body?.code !== 'INVALID_API_KEY') {
        fail(
          `anonymous POST /api/trust-anchors answered ${wrote.status} ` +
            `${JSON.stringify(wrote.body?.code)}, expected 401 INVALID_API_KEY.\n` +
            'The gate refuses GET on this route (check 8 proves it on /api/audit), so a ' +
            'non-401 here means the gate DECIDES DIFFERENTLY BY METHOD. That is not a ' +
            'theoretical shape: an image with one operator flipped in the compiled ' +
            '`isPublicRequest` answered this exact request 201 and created a trust anchor ' +
            'for an attacker-supplied issuer, while every GET-based check stayed green. ' +
            'Note a 201 or 400 here both mean the request reached the handler — a 400 is ' +
            'body validation, i.e. past the gate, not a rejection by it.',
        );
      }
      if (!wrote.headers.get('x-request-id')) {
        fail(
          'the 401 for an anonymous POST /api/trust-anchors carries no x-request-id, so it ' +
            'did not come from the gate. A 401 with the right code from somewhere else is a ' +
            'different failure wearing the right status.',
        );
      }
      return (
        '/api/webhooks -> 401 INVALID_API_KEY (a second gated route); ' +
        '/api/health carries x-request-id (the gate runs on public paths too); ' +
        'anonymous POST /api/trust-anchors -> 401 INVALID_API_KEY with x-request-id ' +
        '(the gate is reached on a mutating verb, not only on GET)'
      );
    },
  );

  await runCheck(
    13,
    "the shipped image's compiled gate is byte-identical to the reviewed one",
    async () => {
      // THE EQUALITY THAT REPLACED A SAMPLE.
      //
      // Checks 8-12 prove the gate is ATTACHED (pinned matchers, pinned route
      // identities) and RUNNING (a handful of requests get gate-shaped answers).
      // Neither can see a gate that is attached, matched, invoked and WRONG. The
      // previous version of this check tried to close that by probing the gate's
      // behaviour across the whole route population — 360 requests over six verbs and
      // four id shapes — and it was defeated five times in a row, each time by a
      // dimension the probe set held constant:
      //
      //   the gate BODY    rewrite the compiled isPublicRequest -> 12/12 green while
      //                    /api/tcts, /api/delegations, /api/sessions,
      //                    /api/trust-anchors and /api/pinned-keys all answered 200
      //   the VERB         flip one operator ("GET"===t&& -> "GET"!==t||) -> 13/13
      //                    green while an anonymous POST /api/trust-anchors returned
      //                    201 and created a trust anchor
      //   the POPULATION   rename 19 gated manifest keys to /api/decoy-N -> 13/13
      //                    green with six admin routes at 200
      //   the REQUEST SHAPE  add `|| !e.headers.get("origin")` -> 13/13 green while a
      //                    plain curl (no Origin, i.e. every non-browser caller) read
      //                    /api/audit, /api/tcts and seven more anonymously
      //   the ID LENGTH    exempt /[^/]{40,}/ -> 13/13 green while every dynamic route
      //                    was ungated for real 54-character AIDs
      //
      // One mechanism, five times: a check that SAMPLES what the runtime decides on is
      // satisfiable by something narrower than the check's prose claims, and the space
      // of request shapes is not finite. Adding a seventh verb or a ninth id closes
      // nothing.
      //
      // So this check does not sample. All five of those defeats are EDITS TO COMPILED
      // CODE, so it compares the compiled code to a committed copy. There is no
      // request, no verb, no id and no header in it, which is why none of the five has
      // anywhere to hide: they are all byte differences now, whatever request would
      // have been needed to observe them.
      //
      // TWO HALVES, and the split is the design rather than belt-and-braces:
      //
      //   13a THE GRAPH — every file the middleware loads, by SHA-256. COMPLETE: any
      //       byte of the gate's own code changing lands here, including bytes outside
      //       the region 13b looks at (deny(), applyCors(), the config parser, the
      //       rate limiter, Turbopack's module runtime). No locator, no parsing, no
      //       anchor — nothing for an attacker to aim at. But opaque: a digest cannot
      //       say what moved, so on its own it makes a Next patch bump and a backdoor
      //       look identical.
      //
      //   13b THE GATE REGION — the compiled gate extracted as a byte range and
      //       compared to scripts/image-gate-canonical.txt. REVIEWABLE: 2.8 KB rather
      //       than 268 KB, committed as its own file so `git log -p` on it is the
      //       audit trail of every change the gate's compiled form has undergone, and
      //       a mismatch prints the located diff rather than two walls of minified JS.
      //       Narrower than 13a on purpose, and NOT relied on for completeness.
      //
      // Together: the verdict is 13a's (complete, unsampled) and the TRIAGE is 13b's.
      // 13a red with 13b green means framework bytes moved and the gate did not — a
      // housekeeping re-pin. 13b red means the gate's own compiled code changed, which
      // is a security review, and it is the case every one of the five defeats above
      // produces.
      //
      // WHAT THIS CHECK DOES NOT PROVE, stated here because the gap is real and was
      // measured, not imagined: that the pinned bytes are INVOKED. An image with the
      // `/_middleware` entry deleted from functions-config-manifest.json has a
      // byte-identical graph and a byte-identical gate region — the code is present and
      // simply never called. That image is caught by check 11 (no matchers) and by
      // checks 8-10 and 12 (no 401, no x-request-id), which is why the behavioural
      // half is kept rather than deleted as redundant. Three layers, three jobs:
      // check 11 says the gate is WIRED to the right paths, check 13 says its code is
      // the REVIEWED code, and checks 8-12 say that code actually RUNS.
      //
      // The extraction runs no code from the image: `docker create` + `docker cp`
      // against a container that is never started. That closes, by construction, the
      // measured primitive where an image carrying
      // `ENV NODE_OPTIONS=--require=/app/lie.js` executed its own code inside the
      // probes that report on it — and 13c below pins that Env outright, so a preload
      // is a failed equality rather than a neutralised one.
      const wantGraph = baseline.bootGraph;
      if (!Array.isArray(wantGraph) || !wantGraph.length) {
        fail(
          'scripts/image-artifact-baseline.json has no non-empty `bootGraph`. That ' +
            'is the pin on the gate\'s load path, and without it this check has nothing to ' +
            'compare against — so it fails rather than skipping. An older baseline ' +
            'predates this check: regenerate with ' +
            `\`${REPIN_CMD} --allow-gate-change\` and review the gate region it writes.`,
        );
      }
      if (typeof baseline.nextTreeSha !== 'string' || !baseline.nextTreeSha) {
        fail(
          'scripts/image-artifact-baseline.json has no `nextTreeSha`. That is the ' +
            'aggregate digest of the Next framework tree — the code that loads and ' +
            'invokes the gate, where a hook would rewrite the gate before it runs — so ' +
            `its absence is a failure, not a skip. Regenerate with \`${REPIN_CMD} ` +
            '--allow-gate-change\`.',
        );
      }
      if (!existsSync(GATE_CANONICAL_PATH)) {
        fail(
          `the canonical compiled gate is missing: ${GATE_CANONICAL_PATH}\n` +
            'It is the committed copy this check diffs the image against, so its absence ' +
            `is a failure and not a skip. Regenerate with \`${REPIN_CMD} ` +
            '--allow-gate-change\`, then READ the file before committing it.',
        );
      }

      // ── 13a: the boot graph, file by file ─────────────────────────────────
      const graphLines = [];
      const max = Math.max(wantGraph.length, gate.graph.length);
      for (let i = 0; i < max; i++) {
        const w = wantGraph[i];
        const g = gate.graph[i];
        if (!w) {
          graphLines.push(`  [${i}] EXTRA in the image:  ${g.path} (${g.bytes} bytes, ${g.sha256})`);
          continue;
        }
        if (!g) {
          graphLines.push(`  [${i}] MISSING from image:  ${w.path} (${w.bytes} bytes, ${w.sha256})`);
          continue;
        }
        if (w.path !== g.path) {
          graphLines.push(
            `  [${i}] PATH differs: pinned ${w.path}, image ${g.path} — the loader ` +
              'registers a different chunk than the one that was reviewed',
          );
        }
        if (w.sha256 !== g.sha256) {
          graphLines.push(
            `  [${i}] CONTENT differs: ${g.path}\n` +
              `        pinned ${w.sha256} (${w.bytes} bytes)\n` +
              `        image  ${g.sha256} (${g.bytes} bytes)` +
              (w.bytes === g.bytes
                ? '\n        SAME LENGTH, different bytes — an in-place edit. The ' +
                  'operator flip that made every non-GET request public was exactly ' +
                  'length-preserving.'
                : ''),
          );
        }
      }

      // ── 13b: the compiled gate region ─────────────────────────────────────
      const canonical = readFileSync(GATE_CANONICAL_PATH, 'utf8').replace(/\n$/, '');
      const regionLines = [];
      if (gate.regionError) {
        regionLines.push(
          '  the compiled gate could not be LOCATED in the image:\n' +
            `    ${gate.regionError}\n` +
            '  A locate failure is a failure, never a skip: this check cannot report on ' +
            'a gate it could not find.',
        );
      } else if (gate.region !== canonical) {
        regionLines.push(
          `  the compiled gate differs from ${path.relative(ROOT, GATE_CANONICAL_PATH)}:\n` +
            locatedDiff(canonical, gate.region),
        );
      }

      // ── 13b′: the Next framework tree, one aggregate digest ───────────────
      //
      // The code that loads and invokes the gate chunk. A pin on the gate's own bytes
      // proves the reviewed gate is present on DISK; it does not prove that code RUNS,
      // because a hook installed anywhere in the framework tree rewrites the gate in
      // memory before it is called. Measured: a `Module.prototype._compile` hook in
      // server.js (in bootGraph) and code in the instrumentation chunk (in bootGraph)
      // both did exactly that; this closes the same channel one layer down, in the
      // framework require path.
      const treeLines = [];
      if (baseline.nextTreeSha !== gate.nextTree.sha256) {
        treeLines.push(
          `  /app/node_modules/next (${gate.nextTree.count} files):\n` +
            `        pinned ${baseline.nextTreeSha}\n` +
            `        image  ${gate.nextTree.sha256}`,
        );
      }

      // ── 13c: the image's environment and entrypoint ───────────────────────
      //
      // Pinned with the code because it decides what CODE RUNS. `ENV
      // NODE_OPTIONS=--require=/app/lie.js` was measured to preload attacker-controlled
      // code into every `node` this harness ran from the image, the matcher reporter
      // included — the artifact controlling the reporting of the facts it is judged on.
      // An equality here makes that a one-line diff.
      const wantCfg = baseline.imageConfig;
      const cfgLines = [];
      if (!wantCfg || typeof wantCfg !== 'object') {
        fail(
          'scripts/image-artifact-baseline.json has no `imageConfig`. It pins the image\'s ' +
            'Env, entrypoint, command, workdir and user — the things that decide what code ' +
            'runs before any of this harness\'s assertions get a say. Regenerate with ' +
            `\`${REPIN_CMD} --allow-gate-change\`.`,
        );
      } else {
        for (const k of PINNED_IMAGE_CONFIG_FIELDS) {
          const w = JSON.stringify(wantCfg[k] ?? null);
          const g = JSON.stringify(gate.imageConfig[k] ?? null);
          if (w !== g) cfgLines.push(`  Config.${k}:\n        pinned ${w}\n        image  ${g}`);
        }
      }

      if (graphLines.length || treeLines.length || regionLines.length || cfgLines.length) {
        const parts = [];
        if (regionLines.length) {
          parts.push(
            'THE COMPILED GATE ITSELF DIFFERS — treat this as a security review:\n' +
              regionLines.join('\n'),
          );
        }
        if (cfgLines.length) {
          parts.push(
            "THE IMAGE'S ENVIRONMENT OR ENTRYPOINT DIFFERS — it decides what code runs:\n" +
              cfgLines.join('\n'),
          );
        }
        if (treeLines.length) {
          parts.push(
            'THE NEXT FRAMEWORK TREE DIFFERS — it loads and invokes the gate, so a hook ' +
              'there rewrites the gate before it runs:\n' + treeLines.join('\n'),
          );
        }
        if (graphLines.length) {
          parts.push(
            "THE GATE'S LOAD-PATH FILES DIFFER from the pinned set (server.js, the " +
              'middleware chunks, the instrumentation chunks):\n' + graphLines.join('\n'),
          );
        }
        // The triage line, and the reason the check has several halves at all. Only a
        // region difference is unambiguously a gate-code change; everything else, on
        // its own, is the framework moving around an unchanged gate.
        const onlyFramework = !regionLines.length && !cfgLines.length;
        const triage = onlyFramework
          ? '\nTRIAGE: the gate region is byte-identical to the committed copy, but a ' +
            'file the gate\'s process LOADS (server.js, a middleware/instrumentation ' +
            'chunk, or the Next framework tree) is not what was reviewed. Two things ' +
            'produce exactly this signature and they are indistinguishable on disk: (1) ' +
            'a Next.js or Turbopack upgrade recompiling the code around an unchanged ' +
            'gate — benign, and the accepted reason for this check to go red; (2) code ' +
            'injected into the gate\'s realm (e.g. a `Module.prototype._compile` hook in ' +
            'server.js, or a patched instrumentation chunk awaited in the gate\'s realm) ' +
            'that rewrites the compiled gate IN MEMORY at load time while leaving the ' +
            'region bytes on disk untouched — a real defeat. The pin cannot tell them ' +
            'apart, so YOU must: do NOT re-pin unless you made the dependency change and ' +
            'can account for every file in the diff above. An unexplained load-path ' +
            'change is the attack, not the framework.'
          : '\nTRIAGE: the gate\'s own compiled code, or the environment that decides ' +
            'what code runs, is not what was reviewed. Every defeat this check was ' +
            'built against looks exactly like this. Do NOT re-pin until you have read ' +
            'the diff above and can say which source change produced it — a rewritten ' +
            'compiled gate is invisible to `verify:gate`, which builds its own server ' +
            'from src/proxy.ts and never looks at the image.';
        fail(
          'the shipped gate is not the reviewed gate.\n\n' +
            parts.join('\n\n') +
            '\n' +
            triage +
            '\n\nThis is an EQUALITY, not a behavioural test, and that is deliberate: five ' +
            'consecutive attempts to establish the gate\'s correctness by probing it were ' +
            'defeated by request shapes the probes did not vary. The cost of an equality ' +
            'is that a compiler change fails it with no behaviour change to show for it. ' +
            `That is the accepted trade. Re-pin with \`${REPIN_CMD} --allow-gate-change\`, ` +
            'which prints this same diff and requires the flag precisely so the re-pin ' +
            'cannot be a reflex.',
        );
      }

      return (
        `${gate.graph.length} gate load-path file(s) byte-identical to the pin ` +
        '(server.js + middleware & instrumentation chunks); the Next framework tree ' +
        `(${gate.nextTree.count} files) matches nextTreeSha; the compiled gate is ` +
        `${gate.region.length} bytes and matches ${path.relative(ROOT, GATE_CANONICAL_PATH)} ` +
        `exactly; entry module ${gate.entryId} in ${gate.hostChunk}; ` +
        'Config.Env/Entrypoint/Cmd/WorkingDir/User all match'
      );
    },
  );

  // ── the NAPI signing path, end to end, in the real artifact ───────────────
  //
  // Fetched ONCE, before any log scan, and held: the producer caches for 60s, so the
  // DB-read warning check 17 looks for is emitted on the FIRST request only.
  let rev = null;

  await runCheck(
    14,
    'the revocation list is served and its signature verifies (host-side, no SDK)',
    async () => {
      rev = await fetchRevocationEnvelope(app);
      return assertEnvelopeVerifiesOnHost(rev);
    },
  );

  await runCheck(15, "the image's own SDK verifies the signature it produced", async () => {
    // The SECOND, independent verification, and the one that runs INSIDE the
    // artifact: it proves the shipped NAPI binary can verify its own signature under
    // the image's arch and libc. Check 14 crosses implementations (hand-rolled
    // node:crypto on the host); this crosses nothing but proves the SDK's own
    // verifier works in the place it will actually be used. Neither subsumes the
    // other, which is why both are here — and why host-side SDK verification was
    // rejected as the primary check: it compares the SDK to itself on a machine that
    // is not the deployment target.
    if (!rev) {
      fail('check 14 did not obtain an envelope, so there is nothing to verify here');
    }
    const issuer = rev.env.revocation_list?.issuer;
    const r = requireProbe(
      await probe(opts.tag, platform, 'sdk-verify', probeSdkVerifyScript(rev.raw, issuer)),
      'sdk-verify',
    );
    if (!r.ok) {
      // NO CLAIM ABOUT CHECK 14'S RESULT. An earlier version asserted "check 14
      // accepted the same bytes, so the two implementations disagree", which is a
      // confident and wrong diagnosis whenever 14 failed too — measured, by flipping a
      // byte of the served signature, which fails BOTH. Name the two readings instead.
      fail(
        "the image's own `verifyRevocationList` REJECTED the envelope the image served:\n" +
          `  ${r.err}\n` +
          'HOW TO READ THIS: if check 14 PASSED, the shipped SDK and an independent ' +
          'node:crypto implementation disagree about the same bytes — a real finding about ' +
          'the shipped binary, not a harness bug. If check 14 FAILED too, the served ' +
          'signature is simply wrong and both verifiers are agreeing about that.',
      );
    }
    if (!r.tamperedRejected) {
      fail(
        "the image's `verifyRevocationList` ACCEPTED an envelope whose signed body had " +
          'been mutated (published_at incremented by 1). A verifier that never rejects ' +
          'makes the positive half above worthless.',
      );
    }
    return (
      `verifyRevocationList(raw, issuer) inside the image: accepted the served bytes, ` +
      `rejected a mutated body (${r.tamperedErr})`
    );
  });

  await runCheck(16, 'the envelope is signed by the seed-derived identity', () => {
    if (!rev) fail('check 14 did not obtain an envelope');
    return assertEnvelopeIssuerIsSeedDerived(rev, expectedAid);
  });

  await runCheck(
    17,
    'the signed list came from a real DB read, not the empty-list fallback',
    () => {
      if (!rev) {
        fail(
          'check 14 never fetched the list, so this scan would be looking at logs from ' +
            'before the producer ever ran — which would pass for the wrong reason',
        );
      }
      return assertRevocationDbReadHappened(app);
    },
  );

  await runCheck(18, 'a tampered envelope is rejected by the host-side verifier', () => {
    // THE NEGATIVE HALF. Without it, `verifyEnvelopeSignature` returning true
    // unconditionally — a one-character mistake in it, or a `catch` that swallowed the
    // wrong thing — would make check 14 green forever. Two tampers, because they break
    // different halves of the signature relation, and neither sends a request: both
    // are local mutations of bytes already in hand.
    if (!rev) fail('check 14 did not obtain an envelope');

    // 1. Flip one byte of the signature, keeping its length.
    const sigBuf = Buffer.from(String(rev.env.signature), 'base64url');
    const flipped = Buffer.from(sigBuf);
    flipped[0] ^= 0x01;
    const badSig = {
      ...rev.env,
      signature: flipped.toString('base64url'),
    };
    if (verifyEnvelopeSignature(badSig)) {
      fail(
        'the host-side verifier ACCEPTED an envelope with one bit flipped in its ' +
          'signature. It is therefore not verifying anything, and check 14 proves ' +
          'nothing.',
      );
    }

    // 2. Mutate the SIGNED BODY, leaving the signature alone. This is the tamper that
    //    matters operationally: an attacker edits the entries list, not the signature.
    const badBody = {
      ...rev.env,
      revocation_list: {
        ...rev.env.revocation_list,
        expires_at: Number(rev.env.revocation_list?.expires_at ?? 0) + 1,
      },
    };
    if (verifyEnvelopeSignature(badBody)) {
      fail(
        'the host-side verifier ACCEPTED an envelope whose SIGNED BODY was mutated ' +
          '(expires_at incremented) while the signature stayed as served. Either the ' +
          'canonicalisation is not covering the field, or the verifier is not checking ' +
          'the body at all.',
      );
    }

    // 3. The pre-0.5.0 WRAPPED signing input must NOT verify. Kept for the same reason
    //    src/e2e/revocation-flow.integration.test.ts keeps it: a positive-only test is
    //    what let the wrapped form survive a full release, and an exclusion that is not
    //    written down is an exclusion that silently stops being tested.
    if (verifyEnvelopeSignature(rev.env, SIGNING_INPUTS.wrapped)) {
      fail(
        'the served signature verifies over the PRE-0.5.0 WRAPPED canonical form ' +
          '(`{"revocation_list":{...}}`) rather than over the inner body. The signing ' +
          'convention has changed under this harness; RFC-AITP-0008 signs the inner ' +
          '`revocation_list` body.',
      );
    }

    return (
      'rejected: a one-bit signature flip; a mutated signed body (expires_at+1); and ' +
      'the pre-0.5.0 wrapped canonical form'
    );
  });

  // ── the CORS build-freeze ─────────────────────────────────────────────────
  await runCheck(
    19,
    'CORS comes from the RUNTIME environment, not from the value baked at build time',
    () => assertCorsIsRuntimeNotBuild(app),
  );

  const failures = results.filter((r) => !r.ok).length;
  if (failures) throw new Error(`${failures}/${results.length} image checks FAILED`);
  console.log(`\nall ${results.length} image checks passed`);
}

// ── lifecycle wiring ────────────────────────────────────────────────────────
//
// Both halves are required. `cleanupSync()` alone would leave the process ALIVE
// on Ctrl-C, because installing a signal listener suppresses Node's default
// disposition — the 18-minute bug wearing a different hat.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.error(
      `\n${sig} — tearing down ${containers.size} container(s) and ${networks.size} network(s)`,
    );
    cleanupSync();
    process.exit(1);
  });
}

// Last-resort sweep for any path that skipped a `finally`. MUST be synchronous.
process.on('exit', cleanupSync);

main()
  .then(() => {
    clearTimeout(watchdog);
    cleanupSync();
    // Exit explicitly: a lingering handle must not turn a passing run into a
    // silent hang.
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\nharness error: ${err.message}`);
    clearTimeout(watchdog);
    cleanupSync();
    process.exit(1);
  });

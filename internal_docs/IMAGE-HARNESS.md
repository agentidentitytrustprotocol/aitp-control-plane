# Shipped-image harness (`verify:image`) — index

`npm run verify:image` (`scripts/verify-image.mjs`) builds the Docker image and
proves things about the artifact that actually deploys: the native and OTel
paths, request-gate attachment, the signing path, the CORS build-freeze, and a
set of pinned routing/manifest surfaces. This file is a **map**, not the
reference.

**Where the detail lives.** The long-term home of every rationale, measured
attack and scope line is the header comment of `scripts/verify-image.mjs`
(roughly its first 420 lines) and the comment above each `runCheck(<id>, …)`
call. A second prose copy of that material used to live in
`docs/operations.md`; it drifted from the code (route and check counts, an
arithmetic description of the old probe set), so it was cut down to this index.
When the two disagree, the script wins — fix this file.

**Why it is in `internal_docs/` and not `docs/`.** The repo is public; nothing
here is secret. `docs/` is synced to the public website, whose readers need to
know *that* the shipped image is verified, not how each check was arrived at.
This is reader triage. `docs/operations.md` keeps a short summary and links
here.

## Running it

```sh
npm ci                                            # migrations run from the host via npm run db:migrate
npm run verify:image                              # host platform
npm run verify:image -- --platform linux/amd64    # one platform per invocation
node scripts/verify-image.mjs --help
```

The runtime image bundles no `drizzle-kit`, so the dev dependencies must be
installed on the host. `--platform` takes one value: `docker buildx build --load`
cannot load a multi-platform manifest.

## Header sections in `scripts/verify-image.mjs`

Find them by their capitalised titles (line numbers move):

| Header section | What it explains |
|---|---|
| `WHAT THIS FILE COVERS TODAY` | the static half, the live substrate, gate attachment |
| `CHECK 11 — IS THE GATE WIRED TO THE RIGHT PATHS?` | why the matcher set and route identities are pinned equalities, not satisfaction tests |
| `CHECK 13 — IS THE GATE'S CODE THE REVIEWED CODE?` | the five measured defeats of the old behavioural probe; `bootGraph`, `nextTreeSha`, `image-gate-canonical.txt`, `imageConfig`; triage of a red result |
| `WHAT IS OUT OF SCOPE` | the dependency tree (a deliberate decision, not deferred work), route-handler chunks, the `node` binary/libc/base OS |
| `THE ACCEPTED COST` | why a Next/Turbopack upgrade fails check 13 and must not be "fixed" by normalising |
| `CHECKS 8-12 — DOES THAT CODE ACTUALLY RUN?` | why the behavioural probes stay alongside the pins |
| `THE SIGNING PATH (checks 14-18)` | revocation-list signature verified two ways over the raw served bytes |
| `THE CORS BUILD-FREEZE (check 19)` | runtime vs Dockerfile-baked `CORS_ORIGIN` |
| `THE OTEL_ENABLED=true PASS (checks 20-23)` | the second container; span export explicitly not verified |
| `THE COMPILED REWRITE TABLE (check 24)` | why a rewrite is a gate-bypass question |
| `THE MIDDLEWARE MANIFEST (check 26)` | manifest precedence over the pinned matcher set |
| `THE OTHER ROUTING TABLES (check 27)` | change detection with no measured exploit, stated as such |
| `TWO HARNESSES, ON PURPOSE` / `SCOPE LINE` | why this does not re-prove `verify:gate`'s logic |
| `THE CONTRACT THIS FILE IS HELD TO` | runtime ≠ build env; committed baseline; wire contract, not status code |
| `RESOURCE LIFECYCLE` | teardown design (registered before created, detached containers, one-shot logs, signal handling) |
| `Usage` / testability hooks | flags and `AITP_VERIFY_IMAGE_*` env hooks |

## The 27 checks

Check ids are appended and never renumbered, so ids do not follow execution
order (24–27 run in the static half). Each row's detail is at
`runCheck(<id>, …)` in the script.

| id | half | asserts | why it exists (one line) |
|---|---|---|---|
| 1 | static | the NAPI binary loads under the image's arch and libc | the build host's arch proves nothing about the image's |
| 2 | static | the OpenTelemetry SDK was **traced** into the image | a copy in `/app/node_modules` passes a bare `require.resolve` with nothing traced |
| 3 | static | every traced external present is a symlink that resolves | a hashed copy loses the sibling native binary (vercel/next.js#88844) |
| 4 | static | the `aitp` binary carries the requested arch token | catches an amd64 image shipping an arm64 binary, or none |
| 5 | static | traced externals match the baseline | drift (a new or vanished external) ships quietly |
| 6 | static | `.node` inventory matches the baseline | same, for native binaries |
| 24 | static | compiled rewrite table equals the pin, order included | a rewrite whose source the matcher misses reaches its handler with no gate |
| 25 | static | no rewrite reaches a path the gate protects | the pin alone writes an *added* rewrite with exit 0; this is the policy floor |
| 26 | static | `middleware-manifest.json` is empty and equals the pin | it overrides the pinned matcher set when populated |
| 27 | static | `dataRoutes`/`dynamicRoutes`/`staticRoutes` equal the pin | change detection; `nextTreeSha` does not cover this file |
| 7 | live | `/api/health` reports `db: "ok"` and the seed-derived AID | proves the substrate (and identity) before anything else |
| 8 | live | anonymous `/api/audit` → 401 `INVALID_API_KEY` + `x-request-id` | gate attachment in the standalone artifact |
| 9 | live | a valid key reaches the handler | a gate rejecting everything would satisfy check 8 |
| 10 | live | `OPTIONS` answered 204 by the gate | preflight is the gate's, not a handler's |
| 11 | live | matcher set (compiled `regexp` included) and `apiRoutes` equal the pin | satisfaction tests fell to one-line matcher edits four times |
| 12 | live | the gate runs on a second gated route, a public route, and one anonymous `POST` | the gate's decision takes the method |
| 13 | live | the compiled gate and its whole load path are byte-identical to the pin | sampled probes were defeated five times; an equality has no dimensions to miss |
| 14 | live | revocation list served; signature verifies host-side (no SDK) | cross-implementation check over the raw bytes |
| 15 | live | the image's own SDK verifies its own signature | exercises the shipped binary where it runs |
| 16 | live | envelope issuer equals the seed-derived AID | a wrong seed leaves 14 and 15 green |
| 17 | live | no `revocation DB read failed` in the logs | `REVOCATION_FAIL_MODE=serve_stale` still answers 200 on a failed read |
| 18 | live | a tampered envelope is rejected | without the negative half a verifier returning `true` passes everything |
| 19 | live | served CORS origin = runtime value ≠ Dockerfile-baked value | presence alone passes on a build-frozen artifact |
| 20 | OTel | gate, signing and CORS assertions re-run with `OTEL_ENABLED=true` | loading the OTel tree was measured to turn a 401 into a 500 |
| 21 | OTel | the SDK started and patched `pg.Client.prototype.query` | an absence-of-errors scan passes when OTel never started |
| 22 | OTel | no `native module` / `createContextKey` / `Cannot find module` in logs | the three ways the OTel tree fails to load in standalone builds |
| 23 | OTel | the OTel container is still running at the end | a post-boot crash would leave earlier checks green on a dead process |

Historical counts in the script and its comments ("12/12", "13/13", "all 25
checks") are measurements against the harness **as it stood then** and are kept
verbatim as evidence. The behavioural probe that check 13 replaced sent 360
requests: six verbs over the then-thirty pinned routes, with each of the ten
dynamic routes in four id shapes. Today the build has 31 `/api` routes, 11 of
them dynamic (`apiRouteCount` / `apiRoutes` in the baseline).

## The baseline

`scripts/image-artifact-baseline.json` pins `tracedExternals`, `nativeModules`,
`middlewareMatchers`, `apiRoutes`/`apiRouteCount`, `rewrites`, `dataRoutes`,
`dynamicRoutes`, `staticRoutes`, `middlewareManifest`, and check 13's load-path
fields (`bootGraph`, `nextTreeSha`, `imageConfig`); the compiled gate itself is
committed verbatim in `scripts/image-gate-canonical.txt`. The file's own
`_comment` explains each field (it is generated from a literal in the script's
`--update-baseline` branch). Native names are normalised (`<ARCH>`, trailing
`-<semver>` dropped) so one baseline serves both arches.

Regenerate only after reviewing the printed diff:

```sh
node scripts/verify-image.mjs --update-baseline
```

Guards, in short (details at the `--update-baseline` branch in the script):

- refuses outright if a structural check (1–4) failed, if the compiled gate
  could not be located, if the rewrite table or middleware manifest could not
  be read, or if the middleware manifest is populated (no override);
- a **removal** from any inventory or routing table needs `--allow-removals`;
- any change to the gate region, `bootGraph`, `nextTreeSha` or `imageConfig`
  needs `--allow-gate-change` (it deliberately does **not** cover the routing
  tables);
- a rewrite that reaches a gated path is refused at write time with no flag
  (check 25's policy floor).

Other flags: `--no-build`, `--tag`, `--keep`, `--prune`, `--inventory-out <file>`,
`--scan-fixture <file>` (runs only the OTel forbidden-string scan, no Docker).

## CI

| job | proves | gates a merge? |
|---|---|---|
| `build-and-test` | typecheck, lint, unit + integration tests, production `next build`, `verify:gate` | yes |
| `audit` | no high+ advisory in production dependencies | yes |
| `docker-build-check` | the image builds for amd64 (PRs only) | yes |
| `docker-build-check-arm64` | the image builds for arm64; opt-in via the `arch:arm64` PR label | no |
| `verify-image` | this harness on amd64, then `verify:sse` against the same image | yes |
| `verify-image-arm64` | the same under QEMU; opt-in via the `verify_image_arm64` dispatch input | no |
| `docker-publish` | multi-arch push to GHCR on `main`; `needs: [build-and-test, verify-image]` | — |

Load-bearing details, easy to undo by accident:

- `docker-publish` needs `verify-image`, so an image whose gate detached cannot
  publish on a green `build-and-test` (which only proves `next start`).
- `verify-image` has **no `if:`**: a skipped `needs` dependency skips its
  dependents, and a manual `workflow_dispatch` on `main` must still publish.
- The arm64 legs are not in `docker-publish`'s `needs` and cannot be required
  checks (a skipped required check stays pending).
- If the harness itself blocks a release: re-run, or dispatch the workflow on
  `main` with the arm64 input off. Do not remove the gate.

Both legs upload `image-inventory-<arch>.json` (14-day retention, uploaded even
on failure). The two files should differ only in `platform`:

```sh
gh run download <run-id> -n image-inventory-amd64 -n image-inventory-arm64
diff image-inventory-amd64.json image-inventory-arm64.json
```

## What it leaves behind

- Containers and networks are always torn down (success, failure, `SIGINT`/
  `SIGTERM`), followed by a label re-sweep for a container created between
  `docker run` dying and the daemon starting it. `--prune` sweeps orphans from
  every *other* run, so do not run it while another run is in flight.
- The **image** is kept under a deterministic tag for `--no-build` re-probes;
  remove it with `docker image rm`. Pass `--tag` when running two platforms
  concurrently.
- The harness creates no anonymous volumes (`docker rm -f -v`, `PGDATA` on
  tmpfs); dangling volumes after a build belong to Docker Desktop's build
  subsystem. Use `docker volume prune` locally; do not extend `--prune`.

## Framework line references

Next.js internals cited in the script header (`router-utils/filesystem.js:275`,
`:278-288`, `:260`; `next-server.js` `// TODO: can we just re-use the regex from
the manifest?` at ~476; `__ESC_COLON_` in `prepare-destination.js`) were
re-checked against the installed `next` 16.3.8. Where the script says "Next
16.3.3", that is the version the finding was measured against.

## Sibling harnesses

- `verify:gate` (`scripts/verify-request-gate.mjs`, 15 checks) — the gate's
  logic under `next start`; owns its own build. Summary in
  [`docs/operations.md`](../docs/operations.md#verifying-the-request-gate).
- `verify:sse` (`scripts/verify-sse-stream.mjs`, 7 checks) — SSE latency and
  wire contract in the shipped image. Summary in
  [`docs/operations.md`](../docs/operations.md#verifying-the-sse-stream-in-the-shipped-image).

The three are deliberately not merged: duplicated assertions rot at different
rates.

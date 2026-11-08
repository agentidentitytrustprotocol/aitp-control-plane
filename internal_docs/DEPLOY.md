# Deploying AITP Control Plane

The control plane ships as a container image built and published by CI to
the GitHub Container Registry (GHCR). Railway (or any container host)
pulls that image. The `aitp` SDK is the published
[`@agentidentitytrustprotocol/aitp`](https://www.npmjs.com/package/@agentidentitytrustprotocol/aitp)
npm package — no sibling `aitp-rs` checkout or Rust toolchain is needed to
build or run.

## CI/CD pipeline

`.github/workflows/ci.yml` runs on every push/PR to `main` (plus manual
`workflow_dispatch` runs from the Actions tab; in-flight PR runs are
cancelled when a new commit lands):

1. **build-and-test** (20 min timeout) — `npm ci`, typecheck, lint, Drizzle
   migrations against an ephemeral Postgres 16, unit tests **with coverage**
   (thresholds enforced by `jest.config.js`; `coverage/lcov.info` uploaded
   as a `coverage` artifact, 14-day retention), integration tests, a
   production `next build` smoke test, and **request-gate conformance**
   (`npm run verify:gate`: the gate in `src/proxy.ts` is attached and behaves,
   under `next start`).
2. **audit** — `npx audit-ci --config ./audit-ci.jsonc`: fails only on
   high+ advisories in production dependencies, so dev-tooling advisories
   don't block merges. The allowlist in `audit-ci.jsonc` is currently empty
   (the steady state; fixable advisories are fixed via `overrides` in
   `package.json` instead).
3. **docker-build-check-arm64** — builds the image for `linux/arm64` under
   QEMU, only on PRs carrying the `arch:arm64` label (informational). There
   is no separate amd64 build-only job: `verify-image` builds the same amd64
   image and then boots and probes it, so it is the required image check.
4. **verify-image** (every run, no `if:`) — `npm run verify:image` against
   the amd64 image, then `npm run verify:sse` against the same image.
   **verify-image-arm64** repeats both under QEMU, only on a manual dispatch
   with the `verify_image_arm64` input (informational, not in
   `docker-publish`'s `needs`). What each check proves, the baseline, and how
   to unblock a release if the harness itself breaks:
   [`IMAGE-HARNESS.md`](IMAGE-HARNESS.md#ci).
5. **docker-publish** (`main` only, not on PRs; `needs: [build-and-test,
   verify-image]`) — builds a multi-arch (`linux/amd64` + `linux/arm64`)
   image and pushes it to:

   ```
   ghcr.io/agentidentitytrustprotocol/aitp-control-plane:latest
   ghcr.io/agentidentitytrustprotocol/aitp-control-plane:sha-<full 40-char commit sha>
   ```

   Auth uses the built-in `GITHUB_TOKEN` (the job grants `packages:
   write`). No extra secrets required.

Other workflows in `.github/workflows/`:

- **`auto-merge.yml`** — on every PR, calls the shared
  `aitp-ci/.github/workflows/auto-merge.yml@v1`.
- **`bump-aitp.yml`** — adopts a new `aitp` SDK release: triggered by an
  `aitp-released` repository dispatch from aitp-rs (or manually with a
  version), via the shared `bump-consume.yml@v1`.
- **`notify-website.yml`** — on pushes to `main` touching `docs/**` or
  `README.md` (or manually), tells `aitp-website` to re-sync. Files under
  `internal_docs/` are not synced.

### Make the GHCR package pullable by Railway

By default a freshly published GHCR package is **private**. Choose one:

- **Public (simplest):** GitHub → org `agentidentitytrustprotocol` →
  Packages → `aitp-control-plane` → Package settings → Change visibility →
  Public. Railway can then pull without credentials.
- **Private:** in Railway, add registry credentials for `ghcr.io` using a
  GitHub Personal Access Token (classic) with the `read:packages` scope as
  the password.

## Railway deployment (pull the GHCR image)

Prereqs: `railway login` (interactive browser auth), the `railway` CLI
(v4+), and the image published per above.

1. **Create the project + Postgres**

   ```bash
   railway login
   railway init                       # create / select a project
   railway add --database postgres    # provisions Postgres, exposes DATABASE_URL
   ```

   (Or do both in the Railway dashboard: New Project → Add Postgres.)

2. **Create the app service from the GHCR image**

   In the Railway dashboard: **New → Docker Image** →
   `ghcr.io/agentidentitytrustprotocol/aitp-control-plane:latest`.
   (Image-source services are configured in the dashboard; `railway.json`
   in this repo supplies the deploy settings — healthcheck `/api/health`,
   restart-on-failure — if you instead connect the service to the repo.)

3. **Set environment variables** on the app service (see table below).
   Reference the Postgres plugin's value for `DATABASE_URL`:

   ```
   DATABASE_URL = ${{Postgres.DATABASE_URL}}
   ```

4. **Networking** — Railway sets `PORT`; the server reads it (defaults to
   4000). Generate a public domain under the service's **Settings →
   Networking**. The healthcheck path is `/api/health`. Railway calls it only
   while a new deployment starts (any `2xx` within 300 s; otherwise the deploy
   fails and the previous one keeps serving) and never afterwards, so a `503`
   from a running service (database down) does not restart it; restarts come
   only from `ON_FAILURE`, i.e. a process exiting non-zero.

5. **Run database migrations** (one-time per schema change) **before the
   PR merges.** Every merge to `main` rolls out automatically (step 6), so a
   schema change must be expand-only (new tables/nullable columns; drop
   things only in a later release) and applied first. The CI deploy job
   warns when a release touches `drizzle/*.sql`. The runtime
   image does not bundle `drizzle-kit`, so run migrations from a checkout
   pointed at the Railway database:

   ```bash
   # Grab the Railway Postgres URL (Variables tab) and run:
   DATABASE_URL='postgres://…railway…' npm run db:migrate
   ```

   Alternatively `railway run npm run db:migrate` from a dev checkout uses
   the linked project's `DATABASE_URL`.

6. **Rollout on new images (automatic).** Each push to `main` publishes
   `:latest` and `:sha-<commit>`; the CI `deploy` job then runs
   `deploy/railway-release.sh deploy --digest <pushed digest>`: it redeploys
   the service and waits until the newest deployment is `SUCCESS` on exactly
   that digest (it skips the redeploy when Railway's image auto-update got
   there first). Anyone can check the same thing read-only:

   ```bash
   RAILWAY_TOKEN="$(doppler secrets get RAILWAY_TOKEN -p aitp-control-plane -c prd --plain)" \
   RAILWAY_ENVIRONMENT_ID=<env id> RAILWAY_SERVICE_ID=<service id> \
     deploy/railway-release.sh verify --digest sha256:<digest>
   ```

   Wiring: a Railway **project** token (`gha-aitp-control-plane-release`,
   project aitp-runner, environment production) lives in Doppler
   `aitp-control-plane/prd` `RAILWAY_TOKEN` and in the GitHub Environment
   `production` (deployment branches: `main`) as secret `RAILWAY_TOKEN`, with
   variables `RAILWAY_ENVIRONMENT_ID` and `RAILWAY_SERVICE_ID`. The repo
   variable `DEPLOY_TO_RAILWAY=true` turns the job on. Rotate: create a new
   project token, pipe it into Doppler and `gh secret set RAILWAY_TOKEN --env
   production` (stdin), then delete the old token in Railway.

   **Red deploy job.** A failed healthcheck leaves the previous deployment
   serving (step 4). To stop rollouts set `DEPLOY_TO_RAILWAY=false` (and
   snooze auto-update in the service settings); to roll back, redeploy the
   last good deployment from the Railway dashboard.

## Required environment variables

| Variable           | Required            | Notes                                                              |
| ------------------ | ------------------- | ------------------------------------------------------------------ |
| `DATABASE_URL`     | yes                 | Postgres connection string (from the Railway Postgres plugin).     |
| `NODE_ENV`         | set by the image    | The image sets `production`; every production safeguard keys on that exact value (after trimming). Do not override it — use `production` for staging too. |
| `CP_AID_SEED_HEX`  | yes (prod)          | 32-byte (64 hex char) Ed25519 seed. **Persistent** — changing it rotates the control-plane identity. **Validated at boot: missing, or not decoding to 32 bytes (`0x` prefix, leading whitespace, wrong length), prints one `[aitp-cp] FATAL:` line and exits 1** — the healthcheck never passes, the Railway deploy fails, and the previous deployment keeps serving. Trailing non-hex characters (or a 65th hex digit) after the 64 hex digits are accepted with the same AID and only warn. |
| `ENROLLMENT_SECRET`| yes                 | ≥ 32 chars. HMAC secret for enrollment tokens. **Validated at boot: the image runs with `NODE_ENV=production`, so an unset/short value prints one `[aitp-cp] FATAL:` line and exits 1** — the healthcheck never passes, the Railway deploy fails, and the previous deployment keeps serving. (A bad value no longer deploys green; before this it 503'd `/api/registry/enroll` **and** `/api/registry/agents` on every request for as long as the release ran.) Still smoke-test an enrollment *and* a registration after changing it: boot proves the secret is usable, not that it matches the one existing tokens were minted under. |
| `API_KEYS`         | yes (prod)          | Comma-separated allowlist. Empty ⇒ API fails closed (503).         |
| `READ_ONLY_API_KEYS` | no                | `label:key` list of read-only keys (GET on the dashboard allowlist only; `403 READ_ONLY_KEY` elsewhere). Doppler-managed. |
| `TRUSTED_PROXY_HOPS` | yes (Railway: `1`) | Proxies appending to `X-Forwarded-For`; the client IP is read this many entries from the right. Railway's edge is one hop. Doppler-managed. |
| `CORS_ORIGIN`      | yes (prod)          | UI plane origin. Defaults to `http://localhost:3000` if unset.     |
| `CP_BASE_URL`      | recommended         | Public `https://` base URL, embedded in the CP's manifest as `<CP_BASE_URL>/api/aitp/handshake/hello` — a spec-required field for a route the CP does not serve (it is not a handshake peer). Unset (defaults to `http://localhost:4000`), loopback or non-https logs a boot warning; not fatal. |
| `PORT`             | auto                | Set by Railway; server defaults to 4000.                           |
| `DB_POOL_MAX`      | no                  | Connection pool size (default 20).                                 |
| `OTEL_ENABLED`     | no                  | Enable OpenTelemetry export (default off).                         |

See `.env.example` for the full list (rate-limiting, retention/TTL, OTel
endpoints).

## Configuration source of truth: Doppler

Production variables live in Doppler project **`aitp-control-plane`**, config
**`prd`** (configs `dev`, `dev_personal`, `stg`, `prd` exist; only `prd` feeds
Railway). Railway project `aitp-runner`, environment `production`, service
`aitp-control-plane` receives them through `deploy/doppler-sync.sh`. There is
no native Doppler→Railway integration: every push is explicit and
hash-checked.

```mermaid
flowchart LR
  D["Doppler aitp-control-plane/prd"] -->|"jq → curl stdin (values never in argv)"| S["deploy/doppler-sync.sh"]
  K["deploy/doppler-keys.txt (allowlist)"] --> S
  S -->|"variableUpsert, skipDeploys"| R["Railway aitp-runner / aitp-control-plane"]
  S -->|"serviceInstanceRedeploy only if a value changed"| R
  P["Railway Postgres"] -->|"DATABASE_URL = ${{Postgres.DATABASE_URL}}"| R
```

**Managed keys** are exactly the ones in `deploy/doppler-keys.txt`:
`API_KEYS`, `CORS_ORIGIN`, `CP_AID_SEED_HEX`, `CP_BASE_URL`,
`ENROLLMENT_SECRET`, `HOSTNAME`, `PORT`, `READ_ONLY_API_KEYS`,
`TRUSTED_PROXY_HOPS`. `DATABASE_URL` is a Railway reference
and stays Railway-managed. `RAILWAY_*` system variables are never managed.

**Change a value:** set it in Doppler `prd`, then

```bash
deploy/doppler-sync.sh            # dry run: per-key unchanged/changed/new + sha256 prefix, never values
deploy/doppler-sync.sh --apply    # push changed keys, verify the hash, redeploy once
```

Rules the script enforces:
- dry run by default; `--apply` refuses a dirty working tree, so the allowlist
  it applies is the committed one;
- it never deletes a variable and never touches a key not in the allowlist;
- it refuses a `RAILWAY_*` name and any `${{…}}` value on either side;
- it refuses a key missing from Doppler rather than skipping it;
- Railway redeploys on every variable set, even an identical one, so it sets
  only keys whose value differs and redeploys at most once; with nothing to
  change it makes no API write at all;
- after setting, it re-reads Railway and dies before redeploying unless the
  managed-key hash equals Doppler's.

**Add a key:** set it in Doppler `prd`, add the name to
`deploy/doppler-keys.txt`, commit, then dry-run and `--apply`. Order matters:
the sync refuses an allowlisted key that is missing from Doppler, so the value
must be in Doppler **before** a sync runs with the new allowlist entry —
for `READ_ONLY_API_KEYS` run `scripts/handoff/create-read-key.sh --apply`
(dry run without `--apply`; mints the key in memory, appends `label:key`, and
copies the key to `CP_API_KEY_CONSOLE_RO` for the console, printing sha256
prefixes only), and for `TRUSTED_PROXY_HOPS` set `1` (see
[operations.md](../docs/operations.md#client-ip-trust-important-behind-a-proxy)).
Offline tests: `bash scripts/handoff/test-create-read-key.sh` (runs in CI).

**Do not edit managed keys in the Railway UI** — the next `--apply` overwrites
them. A dry run is safe at any time and doubles as a drift check: anything but
`unchanged` and `match` means someone changed one side.

Doppler `prd` also holds `CP_API_KEY_CONSOLE` and `CP_API_KEY_PLAYGROUND` (the
key halves of `API_KEYS`' `console-…` and `playground-…` entries),
`CP_API_KEY_CONSOLE_RO` (the key half of the console's `READ_ONLY_API_KEYS`
entry; not used by the console yet) and `CONSOLE_PASSWORD`. The control plane reads none of them, so they are not in
the allowlist; when rotating a consumer key, update both the component key and
its `API_KEYS` entry (rotation: `scripts/handoff/rotate-api-key.sh`).

Offline tests for the script: `bash deploy/test-doppler-sync.sh` (stubbed
`curl`/`doppler`; runs in CI).

## Local image build / smoke test

```bash
docker build -t aitp-control-plane:local .
docker run --rm -p 4000:4000 \
  -e CP_AID_SEED_HEX=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff \
  -e ENROLLMENT_SECRET=local-secret-min-thirty-two-characters \
  -e API_KEYS=local-key -e CORS_ORIGIN=http://localhost:3000 \
  -e DATABASE_URL=postgres://postgres:postgres@host.docker.internal:5432/aitp_control_plane \
  aitp-control-plane:local
# Identity check (no DB needed):
curl -s localhost:4000/.well-known/aitp-manifest | head -c 200
```

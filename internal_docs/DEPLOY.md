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
   as a `coverage` artifact, 14-day retention), integration tests, and a
   production `next build` smoke test.
2. **audit** — `npm audit --omit=dev --audit-level=high`: fails only on
   high+ advisories in production dependencies, so dev-tooling advisories
   don't block merges.
3. **docker-build-check** (PRs only) — builds the image single-arch
   (`linux/amd64`, no push) with the shared GHA layer cache, so Dockerfile
   or standalone-output breakage is caught before merge.
4. **docker-publish** (`main` only, gated on build-and-test) — builds a
   multi-arch (`linux/amd64` + `linux/arm64`) image and pushes it to:

   ```
   ghcr.io/agentidentitytrustprotocol/aitp-control-plane:latest
   ghcr.io/agentidentitytrustprotocol/aitp-control-plane:sha-<commit>
   ```

   Auth uses the built-in `GITHUB_TOKEN` (the job grants `packages:
   write`). No extra secrets required.

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
   Networking**. The healthcheck path is `/api/health`.

5. **Run database migrations** (one-time per schema change). The runtime
   image does not bundle `drizzle-kit`, so run migrations from a checkout
   pointed at the Railway database:

   ```bash
   # Grab the Railway Postgres URL (Variables tab) and run:
   DATABASE_URL='postgres://…railway…' npm run db:migrate
   ```

   Alternatively `railway run npm run db:migrate` from a dev checkout uses
   the linked project's `DATABASE_URL`.

6. **Redeploy on new images.** Each push to `main` publishes a new
   `:latest`. Trigger a Railway redeploy via the dashboard, `railway
   redeploy`, or a Railway deploy webhook called from CI.

## Required environment variables

| Variable           | Required            | Notes                                                              |
| ------------------ | ------------------- | ------------------------------------------------------------------ |
| `DATABASE_URL`     | yes                 | Postgres connection string (from the Railway Postgres plugin).     |
| `CP_AID_SEED_HEX`  | yes (prod)          | 32-byte (64 hex char) Ed25519 seed. **Persistent** — changing it rotates the control-plane identity. |
| `ENROLLMENT_SECRET`| yes                 | ≥ 32 chars. HMAC secret for enrollment tokens.                     |
| `API_KEYS`         | yes (prod)          | Comma-separated allowlist. Empty ⇒ API fails closed (503).         |
| `CORS_ORIGIN`      | yes (prod)          | UI plane origin. Defaults to `http://localhost:3000` if unset.     |
| `CP_BASE_URL`      | recommended         | Public base URL; used in the manifest's handshake endpoint.        |
| `PORT`             | auto                | Set by Railway; server defaults to 4000.                           |
| `DB_POOL_MAX`      | no                  | Connection pool size (default 20).                                 |
| `OTEL_ENABLED`     | no                  | Enable OpenTelemetry export (default off).                         |

See `.env.example` for the full list (rate-limiting, retention/TTL, OTel
endpoints).

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

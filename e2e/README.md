# aitp-control-plane e2e

End-to-end integration test that drives the
[`aitp-playground`](../../aitp-playground) through a real scenario
against a real LLM (OpenAI by default), then asserts on what the
control plane observed about the run.

**No mocks. No stubs.** Real HTTP between three real processes (CP +
playground + Postgres) and real OpenAI calls.

## What's in this directory

- `playground-e2e.mjs` — Node-based test driver. No build step.
- `README.md` — this file.

## Prerequisites

### 1. Postgres + CP

```bash
docker compose up -d postgres
npm run db:migrate

API_KEYS=e2e-playground-key,e2e-driver-key \
CP_AID_SEED_HEX=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
ENROLLMENT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
DATABASE_URL=postgres://postgres:postgres@localhost:5432/aitp_control_plane \
npm run start
```

`API_KEYS` must include both an entry for the playground (the
`CP_API_KEY` it'll send) and an entry for the e2e driver itself (the
`CP_API_KEY` env var this script reads).

### 2. Playground

The playground (separate repo at `../../aitp-playground`) is the
runtime that calls OpenAI. Wire it up via its own `.env`:

```bash
# in aitp-playground/.env
CP_BASE_URL=http://localhost:4000/api
CP_API_KEY=e2e-playground-key
OPENAI_API_KEY=sk-…              # the playground process consumes this
LLM_PROVIDER=openai
OPENAI_MODEL=gpt-4o-mini

# Pick a port range that's free on your machine; defaults to 9100
# because 81xx is taken on the maintainer's box. The agent processes
# bind sequentially from this base port.
AGENT_BASE_PORT=9100

# Use the venv interpreter for agent subprocesses (they need uvicorn /
# crewai / langchain). The .yaml in scenarios/_shared/agents/*.yaml
# may also pin `python:` per agent — make sure it points at a venv.
AGENT_PYTHON=/absolute/path/to/aitp-playground/.venv/bin/python
```

Then start the playground:

```bash
cd ../aitp-playground
.venv/bin/python -m uvicorn aitp_playground.main:create_app --factory --port 8000
```

(If you previously ran the Dockerized playground, stop it first:
`docker stop aitp-playground-playground-1`. The native process won't
be able to bind 8000 otherwise.)

## Run

```bash
# Default: one scenario proven to drive a real-LLM round-trip
# end-to-end through the CP without manual registry bootstrapping.
node e2e/playground-e2e.mjs

# Pick a specific scenario
SCENARIO=intra-org/research-and-write@1.0.0 node e2e/playground-e2e.mjs

# Run every scenario in a pack
PACK=intra-org node e2e/playground-e2e.mjs
PACK=cross-cloud node e2e/playground-e2e.mjs

# Other knobs
CP_BASE_URL=http://localhost:4000 \
CP_API_KEY=e2e-driver-key \
PLAYGROUND_BASE_URL=http://localhost:8000 \
RUN_TIMEOUT_MS=240000 \
node e2e/playground-e2e.mjs
```

## What it asserts

For each scenario:

- `POST /runs` returns 202.
- The run reaches a terminal status within `RUN_TIMEOUT_MS` (default 3 min).
- Final status is `success` (the playground's term) or `succeeded`.
- The CP received events for that `run_id` via `POST /api/events`.
- Lifecycle events `run.started` and `run.{complete|failed}` are in the audit history.
- Non-trivial `outputs` are present (proves the LLM actually returned content — no stub fallback).

Across the whole run:

- The CP's `audit_events` table contains ≥3 distinct event types (proves
  the ingest pipeline received real bytes, not just a `run.started`).
- The dashboard KPI deltas are logged for visibility.
- Any `admin_audit_log` rows from agent registrations carry an
  `X-Request-Id` (verifies the middleware injection chain).

At the end, the script dumps the longest LLM-produced string from each
run's `outputs` so you can eyeball the actual generated artifact.

## Event vocabulary

The current playground emits its own event names (`trust.established`,
`step.complete`, `agent.spawning`, …) rather than the AITP canonical
names the CP also recognises (`handshake.complete`, `capability.invoked`,
`llm.complete`, …). The harness cross-walks the two so assertions hold
either way. The CP's ingest is vocabulary-agnostic — every event reaches
`audit_events` and the dashboard's "events by type" counter regardless.

## Default scenario rationale

`intra-org/research-and-write@1.0.0` is the default because it requires
no prior CP-registry state — both agents are in the same trust domain
with pre-shared anchors. The `cross-org` and `cross-cloud` packs assume
a CP registry already populated with the discoverable peer, which the
current playground doesn't auto-bootstrap; until that gap is closed,
those packs work only after the operator manually `POST /api/registry/enroll`s
each agent first.

## Cost

`intra-org/research-and-write@1.0.0` runs the researcher (CrewAI) and
writer (LangChain) against `gpt-4o-mini` once each — typically a few
cents per run.

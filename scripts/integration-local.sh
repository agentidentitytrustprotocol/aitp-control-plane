#!/usr/bin/env bash
#
# Run the integration suite locally the way CI does, against a throwaway Postgres.
#
#   scripts/integration-local.sh [extra jest args]      # or: npm run test:integration:local
#
# Each run is its own docker compose project (aitp-cp-it-<yyyymmdd-hhmmss>-<pid>) on a random
# localhost port, torn down (volumes included) on any exit, Ctrl-C too. Two runs at
# once do not collide. Env values are the CI ones (.github/workflows/ci.yml,
# "Integration tests"): test-only constants, no real secrets, no LLM keys.
# Exit: the suite's own exit code (migrations failing count as a failure).

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
command -v docker >/dev/null || { echo "docker is not on PATH" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "docker compose v2 is required" >&2; exit 1; }

project="aitp-cp-it-$(date -u +%Y%m%d-%H%M%S)-$$"
compose=(docker compose -p "$project" -f "$root/docker-compose.integration.yml")

# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() {
  local rc=$?
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  echo "integration-local: project $project removed (exit $rc)" >&2
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "integration-local: starting $project" >&2
"${compose[@]}" up -d --wait --wait-timeout 120 postgres
port="$("${compose[@]}" port postgres 5432 | sed 's/.*://')"
[[ "$port" =~ ^[0-9]+$ ]] || { echo "could not read the mapped Postgres port" >&2; exit 1; }
echo "integration-local: postgres on 127.0.0.1:$port" >&2

export DATABASE_URL="postgres://postgres:postgres@127.0.0.1:$port/aitp_control_plane_test"
export ENROLLMENT_SECRET=ci-integration-secret-min-thirty-two-chars
export CP_AID_SEED_HEX=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff
export CP_BASE_URL=https://cp.test.invalid

npm run --silent db:migrate
set +e
npm run --silent test:integration -- "$@"
rc=$?
set -e
exit "$rc"

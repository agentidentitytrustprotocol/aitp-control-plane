#!/usr/bin/env bash
#
# Roll the Railway service onto a published image and prove it, or check that it is there.
#
#   deploy/railway-release.sh verify --digest sha256:<64 hex>   # read-only: newest deployment is SUCCESS on it?
#   deploy/railway-release.sh deploy --digest sha256:<64 hex>   # redeploy (pulls :latest) and wait for SUCCESS on it
#
# The digest is the image INDEX digest that CI pushed (docker/build-push-action's
# `digest` output; `docker buildx imagetools inspect <image>:latest` shows the same
# one). Railway records it per deployment as meta.imageDigest.
#
# Environment (never argv):
#   RAILWAY_TOKEN           a Railway PROJECT token scoped to the target environment
#   RAILWAY_ENVIRONMENT_ID  the environment the token must be scoped to
#   RAILWAY_SERVICE_ID      the service to roll
#   POLL_SECONDS            default 10
#   TIMEOUT_SECONDS         default 900
#
# deploy does not redeploy when the newest deployment already carries the digest and
# is live or on its way (Railway's own image auto-update may have got there first).
# Otherwise it redeploys, which re-resolves the service's image tag (:latest), and
# follows the deployment that the redeploy created. If that lands on another digest
# (registry lag), it redeploys once more, then fails.
#
# Exit: 0 match/deployed, 1 mismatch/failed/timed out, 2 usage.

# GraphQL variables ($p, $e, $s) live in single-quoted query strings on purpose.
# shellcheck disable=SC2016
set -euo pipefail

say() { printf '%s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }
usage() { sed -n '2,25p' "$0" >&2; exit 2; }

mode="${1:-}"
case "$mode" in verify|deploy) shift ;; *) usage ;; esac
digest=""
while [ $# -gt 0 ]; do
  case "$1" in
    --digest) digest="${2:-}"; shift ;;
    *) say "unknown argument: $1"; usage ;;
  esac
  shift
done
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { say "--digest must be sha256:<64 lowercase hex>"; exit 2; }

for c in curl jq; do command -v "$c" >/dev/null || die "$c is not on PATH"; done
token="${RAILWAY_TOKEN:-}"
env_id="${RAILWAY_ENVIRONMENT_ID:-}"
svc_id="${RAILWAY_SERVICE_ID:-}"
poll="${POLL_SECONDS:-10}"
timeout="${TIMEOUT_SECONDS:-900}"
[ -n "$token" ] || die "RAILWAY_TOKEN is empty (set the GitHub environment secret, or export it from Doppler by pipe)"
[ -n "$env_id" ] || die "RAILWAY_ENVIRONMENT_ID is empty"
[ -n "$svc_id" ] || die "RAILWAY_SERVICE_ID is empty"
case "$token" in *[\"\\[:space:]]*) die "RAILWAY_TOKEN contains a quote, backslash or space; refusing to build the curl config" ;; esac
[[ "$poll" =~ ^[0-9]+$ && "$timeout" =~ ^[0-9]+$ ]] || die "POLL_SECONDS and TIMEOUT_SECONDS must be whole seconds"

# POST a GraphQL body from stdin. The token goes in a curl config read from a pipe
# (printf is a builtin), never argv. API errors and null data are failures.
gql_raw() {
  curl -fsS --max-time 30 https://backboard.railway.com/graphql/v2 \
    -K <(printf 'header = "Project-Access-Token: %s"\n' "$token") \
    -H 'content-type: application/json' --data-binary @- |
    jq -e 'if .errors then error("railway: \(.errors | map(.message) | join("; "))") elif .data == null then error("railway: no data") else .data end'
}
gql() { jq -nc --arg q "$1" --argjson v "${2:-{\}}" '{query: $q, variables: $v}' | gql_raw; }

# The token's own scope: refuse a token for another environment before anything else.
scope="$(gql '{projectToken{projectId environmentId}}')" || die "could not read the project token's scope (wrong or revoked token?)"
project_id="$(jq -r '.projectToken.projectId // empty' <<<"$scope")"
token_env="$(jq -r '.projectToken.environmentId // empty' <<<"$scope")"
[ -n "$project_id" ] || die "the project token reports no project"
[ "$token_env" = "$env_id" ] || die "the project token is scoped to environment $token_env, not RAILWAY_ENVIRONMENT_ID $env_id"
vars="$(jq -nc --arg p "$project_id" --arg e "$env_id" --arg s "$svc_id" '{p: $p, e: $e, s: $s}')"

# The service's 5 newest deployments, newest first by createdAt (not trusting API
# order), as a JSON array of {id, status, createdAt, digest}.
recent() {
  gql 'query($p: String!, $e: String!, $s: String!){deployments(first: 5, input: {projectId: $p, environmentId: $e, serviceId: $s}){edges{node{id status createdAt meta}}}}' "$vars" |
    jq -c '[.deployments.edges[].node | {id, status, createdAt, digest: (.meta.imageDigest // "")}] | sort_by(.createdAt) | reverse'
}
show() { jq -r '"deployment \(.id // "-") \(.status // "NONE") \(.digest // "-") (created \(.createdAt // "-"))"' <<<"$1"; }

# Status classes. Anything not listed (SLEEPING, a value Railway adds later) is
# treated as not finished yet, so the timeout, not a guess, decides.
IN_FLIGHT='["QUEUED","INITIALIZING","BUILDING","DEPLOYING","WAITING","NEEDS_APPROVAL"]'
DEAD='["FAILED","CRASHED","REMOVED","REMOVING","SKIPPED"]'

list="$(recent)" || die "could not read the service's deployments"
cur="$(jq -c '.[0] // {}' <<<"$list")"
say "now: $(show "$cur")"

if [ "$mode" = verify ]; then
  if [ "$(jq -r --arg d "$digest" '.status == "SUCCESS" and .digest == $d' <<<"$cur")" = true ]; then
    say "verify: running $digest"
    exit 0
  fi
  say "verify: MISMATCH: want SUCCESS on $digest"
  exit 1
fi

redeploy() {
  gql 'mutation($e: String!, $s: String!){serviceInstanceRedeploy(environmentId: $e, serviceId: $s)}' "$vars" >/dev/null ||
    die "serviceInstanceRedeploy failed"
  say "redeploy requested"
}

# `seen` holds the ids that existed before our latest redeploy; the deployment we
# follow is the newest one not in it. Empty `seen` = follow the newest (no redeploy).
redeploys=0
if [ "$(jq -r --arg d "$digest" --argjson ok "$IN_FLIGHT" '.digest == $d and ((.status == "SUCCESS") or ((.status // "") | IN($ok[])))' <<<"$cur")" = true ]; then
  say "deploy: the newest deployment already carries $digest; following it, no redeploy"
  seen='[]'
else
  seen="$(jq -c 'map(.id)' <<<"$list")"
  redeploy
  redeploys=1
fi

deadline=$(( $(date +%s) + timeout ))
errors=0
last=""
while :; do
  [ "$(date +%s)" -lt "$deadline" ] || die "timed out after ${timeout}s; last seen: $(show "${last:-{\}}")"
  sleep "$poll"
  if ! list="$(recent)"; then
    errors=$((errors + 1))
    [ "$errors" -lt 3 ] || die "3 consecutive failed reads of the deployment list"
    continue
  fi
  errors=0
  d="$(jq -c --argjson seen "$seen" '[.[] | select(.id as $i | $seen | index($i) | not)][0] // {}' <<<"$list")"
  [ "$d" != '{}' ] || continue   # the redeploy has not shown up yet
  line="$(show "$d")"
  [ "$line" = "$(show "${last:-{\}}")" ] || say "  $line"
  last="$d"
  id="$(jq -r '.id' <<<"$d")"
  status="$(jq -r '.status // ""' <<<"$d")"
  got="$(jq -r '.digest // ""' <<<"$d")"
  if [ "$status" = SUCCESS ]; then
    if [ "$got" = "$digest" ]; then say "deploy: SUCCESS on $digest ($id)"; exit 0; fi
  elif jq -e --argjson bad "$DEAD" --arg s "$status" '$s | IN($bad[])' <<<'null' >/dev/null; then
    [ "$got" != "$digest" ] || die "deployment $id ended $status on $digest"
  else
    continue   # in flight (or a status we do not know yet)
  fi
  # Settled on another digest: :latest had not moved to ours yet when Railway resolved it.
  if [ "$redeploys" -lt 2 ]; then
    say "deploy: $id settled $status on ${got:-no digest}, not $digest (registry lag?); redeploying once more"
    seen="$(jq -c 'map(.id)' <<<"$list")"
    redeploy
    redeploys=$((redeploys + 1))
    continue
  fi
  die "deployment $id settled $status on ${got:-no digest}, not $digest, after $redeploys redeploy(s)"
done

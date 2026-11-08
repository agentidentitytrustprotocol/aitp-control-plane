#!/usr/bin/env bash
#
# Offline tests for deploy/railway-release.sh. No network, no real Railway.
#
#   deploy/test-railway-release.sh
#
# A stub `curl` first on PATH plays Railway's GraphQL API from files in a per-case
# directory: deps.json (the service's deployments, deliberately stored OLDEST first
# so the script must sort), and redeploy-N.json (what the Nth serviceInstanceRedeploy
# creates: a digest and a list of statuses it walks through, one per deployments
# read). The stub fails if the token ever reaches its argv or arrives without the
# Project-Access-Token header in a -K config, and every case checks the output for it.
#
# Needs bash and jq.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/railway-release.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

TOKEN=tok-SENTINELvalue
D="sha256:$(printf 'a%.0s' {1..64})"     # the digest CI pushed
OLD="sha256:$(printf 'b%.0s' {1..64})"   # what runs before the release
pass=0
fail=0
ok() { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; [ -z "${2:-}" ] || printf '     %s\n' "$2"; }

mkdir -p "$work/bin"
cat >"$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
for a in "$@"; do
  case "$a" in *SENTINEL*) echo leak >>"$STUB/argv-leak"; exit 97 ;; esac
done
auth=""; prev=""
for a in "$@"; do [ "$prev" = -K ] && auth="$(cat "$a")"; prev="$a"; done
case "$auth" in *'Project-Access-Token: tok-SENTINELvalue'*) ;; *) echo "curl stub: no Project-Access-Token via -K" >&2; exit 95 ;; esac
body="$(cat)"
q="$(jq -r .query <<<"$body")"
case "$q" in
  *projectToken*)
    if [ -e "$STUB/scope-response" ]; then cat "$STUB/scope-response"
    else jq -nc --arg e "${STUB_TOKEN_ENV:-env-1}" '{data: {projectToken: {projectId: "proj-1", environmentId: $e}}}'; fi ;;
  *'deployments('*)
    [ "$(jq -r .variables.s <<<"$body")" = svc-1 ] || { echo "curl stub: wrong service" >&2; exit 94; }
    # Advance the followed deployment one status along its timeline.
    if [ -s "$STUB/timeline" ]; then
      next="$(head -n1 "$STUB/timeline")"; tail -n +2 "$STUB/timeline" >"$STUB/timeline.new"; mv "$STUB/timeline.new" "$STUB/timeline"
      jq --arg id "$(cat "$STUB/target")" --arg s "$next" 'map(if .id == $id then .status = $s else . end)' "$STUB/deps.json" >"$STUB/deps.new"
      mv "$STUB/deps.new" "$STUB/deps.json"
    fi
    jq -c '{data: {deployments: {edges: map({node: .})}}}' "$STUB/deps.json" ;;
  *serviceInstanceRedeploy*)
    n=$(( $(wc -l <"$STUB/mutations" 2>/dev/null || echo 0) + 1 ))
    echo redeploy >>"$STUB/mutations"
    spec="$STUB/redeploy-$n.json"
    [ -e "$spec" ] || { echo "curl stub: no redeploy-$n.json" >&2; exit 93; }
    id="dep-new-$n"
    jq -r '.statuses[1:][]' "$spec" >"$STUB/timeline"
    echo "$id" >"$STUB/target"
    jq --arg id "$id" --arg t "2026-11-08T11:0${n}:00Z" --slurpfile s "$spec" \
      '. + [{id: $id, status: $s[0].statuses[0], createdAt: $t, meta: {imageDigest: $s[0].digest}}]' \
      "$STUB/deps.json" >"$STUB/deps.new"
    mv "$STUB/deps.new" "$STUB/deps.json"
    echo '{"data":{"serviceInstanceRedeploy":true}}' ;;
  *) echo "curl stub: unexpected query: $q" >&2; exit 99 ;;
esac
STUB
chmod +x "$work/bin/curl"

# new_case <name> <newest-status> <newest-digest>: an older SUCCESS on OLD, then the newest.
new_case() {
  CASE="$work/$1"; mkdir -p "$CASE"
  jq -nc --arg s "$2" --arg d "$3" --arg old "$OLD" '[
    {id: "dep-old", status: "REMOVED", createdAt: "2026-11-07T09:00:00Z", meta: {imageDigest: $old}},
    {id: "dep-cur", status: $s, createdAt: "2026-11-08T10:00:00Z", meta: {imageDigest: $d}}]' >"$CASE/deps.json"
  : >"$CASE/mutations"
}
redeploy_spec() { jq -nc --arg d "$2" --argjson s "$3" '{digest: $d, statuses: $s}' >"$CASE/redeploy-$1.json"; }
run() {
  set +e
  OUT="$(cd "$CASE" && STUB="$CASE" PATH="$work/bin:$PATH" RAILWAY_TOKEN="$TOKEN" RAILWAY_ENVIRONMENT_ID=env-1 \
    RAILWAY_SERVICE_ID=svc-1 POLL_SECONDS=0 TIMEOUT_SECONDS="${TO:-20}" bash "$script" "$@" 2>&1)"
  RC=$?
  set -e
  case "$OUT" in *SENTINEL*) bad "$(basename "$CASE"): token reached the output" ;; esac
  [ ! -e "$CASE/argv-leak" ] || bad "$(basename "$CASE"): token reached curl argv"
}
redeploys() { wc -l <"$CASE/mutations" | tr -d ' '; }
has() { case "$OUT" in *"$1"*) return 0 ;; esac; return 1; }
expect() { # expect <label> <rc> <redeploys> [output substring]
  if [ "$RC" = "$2" ] && [ "$(redeploys)" = "$3" ] && { [ -z "${4:-}" ] || has "$4"; }; then ok "$1"
  else bad "$1" "rc=$RC redeploys=$(redeploys) out: $OUT"; fi
}

new_case verify-match SUCCESS "$D"; run verify --digest "$D"
expect "verify: newest SUCCESS on the digest exits 0" 0 0 "verify: running"

new_case verify-mismatch SUCCESS "$OLD"; run verify --digest "$D"
expect "verify: newest on another digest exits 1, read-only" 1 0 MISMATCH

new_case verify-failed FAILED "$D"; run verify --digest "$D"
expect "verify: newest FAILED on the digest exits 1" 1 0 MISMATCH

new_case verify-sorts SUCCESS "$D"
jq 'reverse' "$CASE/deps.json" >"$CASE/d" && mv "$CASE/d" "$CASE/deps.json"   # API order must not matter
run verify --digest "$D"
expect "verify: picks the newest by createdAt, not by API order" 0 0 "verify: running"

new_case already SUCCESS "$D"; run deploy --digest "$D"
expect "deploy: already SUCCESS on the digest: no redeploy, exit 0" 0 0 "no redeploy"

new_case in-flight DEPLOYING "$D"; echo dep-cur >"$CASE/target"; printf 'DEPLOYING\nSUCCESS\n' >"$CASE/timeline"
run deploy --digest "$D"
expect "deploy: already in flight on the digest: follows it, no redeploy" 0 0 "SUCCESS on $D"

new_case happy SUCCESS "$OLD"; redeploy_spec 1 "$D" '["QUEUED","INITIALIZING","DEPLOYING","SUCCESS"]'
run deploy --digest "$D"
expect "deploy: redeploys once and exits 0 on SUCCESS with the digest" 0 1 "deploy: SUCCESS on $D (dep-new-1)"

new_case unknown-status SUCCESS "$OLD"; redeploy_spec 1 "$D" '["QUEUED","SOMETHING_NEW","SLEEPING","SUCCESS"]'
run deploy --digest "$D"
expect "deploy: an unknown status is non-terminal, not a failure" 0 1 "deploy: SUCCESS on $D"

new_case failed SUCCESS "$OLD"; redeploy_spec 1 "$D" '["QUEUED","DEPLOYING","FAILED"]'
run deploy --digest "$D"
expect "deploy: FAILED on the digest exits 1" 1 1 "ended FAILED"

new_case crashed SUCCESS "$OLD"; redeploy_spec 1 "$D" '["DEPLOYING","CRASHED"]'
run deploy --digest "$D"
expect "deploy: CRASHED on the digest exits 1" 1 1 "ended CRASHED"

new_case lag SUCCESS "$OLD"; redeploy_spec 1 "$OLD" '["DEPLOYING","SUCCESS"]'; redeploy_spec 2 "$D" '["DEPLOYING","SUCCESS"]'
run deploy --digest "$D"
expect "deploy: lands on the old digest once (registry lag), redeploys, then SUCCESS" 0 2 "registry lag"

new_case lag-twice SUCCESS "$OLD"; redeploy_spec 1 "$OLD" '["SUCCESS"]'; redeploy_spec 2 "$OLD" '["SUCCESS"]'
run deploy --digest "$D"
expect "deploy: still the old digest after the retry: exits 1 after 2 redeploys" 1 2 "after 2 redeploy(s)"

new_case timeout SUCCESS "$OLD"; redeploy_spec 1 "$D" '["DEPLOYING"]'
TO=1 run deploy --digest "$D"
expect "deploy: never settles: times out, exits 1" 1 1 "timed out"

new_case env-mismatch SUCCESS "$OLD"
STUB_TOKEN_ENV=env-OTHER run deploy --digest "$D"
expect "a token scoped to another environment is refused before any mutation" 1 0 "not RAILWAY_ENVIRONMENT_ID"

new_case api-errors SUCCESS "$OLD"
echo '{"data":null,"errors":[{"message":"Not Authorized"}]}' >"$CASE/scope-response"
run deploy --digest "$D"
expect "a 200 carrying {data:null, errors} exits 1 with no mutation" 1 0 "could not read the project token"

new_case bad-digest SUCCESS "$D"; run deploy --digest "sha256:XYZ"
expect "a malformed digest is a usage error (exit 2)" 2 0 "--digest must be"

new_case no-token SUCCESS "$D"
set +e; OUT="$(cd "$CASE" && STUB="$CASE" PATH="$work/bin:$PATH" RAILWAY_TOKEN='' RAILWAY_ENVIRONMENT_ID=env-1 RAILWAY_SERVICE_ID=svc-1 bash "$script" verify --digest "$D" 2>&1)"; RC=$?; set -e
expect "an empty RAILWAY_TOKEN exits 1 before any call" 1 0 "RAILWAY_TOKEN is empty"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" = 0 ]

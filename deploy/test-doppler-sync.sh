#!/usr/bin/env bash
#
# Offline tests for deploy/doppler-sync.sh. No network, no real Doppler or Railway.
#
#   deploy/test-doppler-sync.sh
#
# Each case copies the script and an allowlist into a throwaway git repo and puts
# stub `curl` and `doppler` commands first on PATH. The curl stub plays Railway's
# GraphQL API from a JSON file and logs every mutation; the doppler stub serves a
# JSON file as `secrets download`. Both stubs fail the run if a secret value ever
# reaches their argv, and every case checks that no value reaches the output.
#
# Needs bash, git, jq and shasum (the same tools the script itself needs).

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/doppler-sync.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Every fake value contains this marker, so a leak is a plain substring search.
S=SENTINELvalue
pass=0
fail=0

ok() { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; [ -z "${2:-}" ] || printf '     %s\n' "$2"; }

# --- stubs -------------------------------------------------------------------

mkdir -p "$work/bin"
cat >"$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
for a in "$@"; do
  case "$a" in *SENTINEL*) echo "curl stub: a value reached argv" >&2; echo leak >>"$STUB/argv-leak"; exit 97 ;; esac
done
# The token must arrive in a -K config (a pipe), carrying the Authorization header.
auth=""
prev=""
for a in "$@"; do
  [ "$prev" = -K ] && auth="$(cat "$a")"
  prev="$a"
done
case "$auth" in *'Authorization: Bearer tok-SENTINEL'*) ;; *) echo "curl stub: no Authorization header via -K" >&2; exit 95 ;; esac
body="$(cat)"
q="$(jq -r .query <<<"$body")"
case "$q" in
  *'project(id:'*)
    jq -nc '{data: {project: {
      environments: {edges: [{node: {id: "env-1", name: "production"}}]},
      services: {edges: [{node: {id: "svc-1", name: "aitp-control-plane"}}, {node: {id: "svc-2", name: "other"}}]}}}}' ;;
  *'variables(projectId'*)
    case "$q" in *'unrendered: true'*) ;; *) echo "curl stub: variables read without unrendered: true" >&2; exit 96 ;; esac
    # A case may replace the whole response body (e.g. a 200 carrying errors).
    if [ -e "$STUB/variables-response" ]; then cat "$STUB/variables-response"; else jq -c '{data: {variables: .}}' "$STUB/railway.json"; fi ;;
  *variableUpsert*)
    name="$(jq -r .variables.i.name <<<"$body")"
    [ "$(jq -r .variables.i.skipDeploys <<<"$body")" = true ] || { echo "upsert without skipDeploys" >&2; exit 98; }
    if [ ! -e "$STUB/drop-upserts" ]; then
      jq --arg n "$name" --arg v "$(jq -r .variables.i.value <<<"$body")" '.[$n] = $v' "$STUB/railway.json" >"$STUB/railway.json.new"
      mv "$STUB/railway.json.new" "$STUB/railway.json"
    fi
    echo "upsert $name" >>"$STUB/mutations"
    echo '{"data":{"variableUpsert":true}}' ;;
  *serviceInstanceRedeploy*)
    echo "redeploy" >>"$STUB/mutations"
    echo '{"data":{"serviceInstanceRedeploy":true}}' ;;
  *) echo "curl stub: unexpected query: $q" >&2; exit 99 ;;
esac
STUB
cat >"$work/bin/doppler" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
for a in "$@"; do
  case "$a" in *SENTINEL*) echo leak >>"$STUB/argv-leak"; exit 97 ;; esac
done
[ "$1 $2" = "secrets download" ] || { echo "doppler stub: unexpected: $*" >&2; exit 99; }
cat "$STUB/doppler.json"
STUB
chmod +x "$work/bin/curl" "$work/bin/doppler"

# --- harness -----------------------------------------------------------------

# new_case <name> <railway-json> <doppler-json> <allowlist...>
new_case() {
  local d="$work/$1"
  mkdir -p "$d/repo/deploy" "$d/stub"
  cp "$script" "$d/repo/deploy/doppler-sync.sh"
  printf '%s\n' "${@:4}" >"$d/repo/deploy/doppler-keys.txt"
  printf '%s\n' "$2" >"$d/stub/railway.json"
  printf '%s\n' "$3" >"$d/stub/doppler.json"
  : >"$d/stub/mutations"
  git -C "$d/repo" init -q
  git -C "$d/repo" -c user.email=t@t -c user.name=t add -A
  git -C "$d/repo" -c user.email=t@t -c user.name=t commit -qm init
  CASE="$d"
}

# run_sync <args...>: sets RC and OUT (stdout+stderr).
run_sync() {
  set +e
  OUT="$(STUB="$CASE/stub" PATH="$work/bin:$PATH" RAILWAY_API_TOKEN="tok-$S" \
    bash "$CASE/repo/deploy/doppler-sync.sh" "$@" 2>&1)"
  RC=$?
  set -e
}

check_no_leak() {
  if [ -e "$CASE/stub/argv-leak" ]; then bad "$1: a value reached a command's argv"; return; fi
  case "$OUT" in *SENTINEL*) bad "$1: a value was printed" "$OUT"; return ;; esac
  ok "$1: no value in argv or output"
}

has() { grep -qF -- "$1" <<<"$OUT"; }
mutations() { wc -l <"$CASE/stub/mutations" | tr -d ' '; }

R_SAME="{\"A\":\"a-$S\",\"B\":\"b-$S\",\"UNLISTED\":\"u-$S\",\"DATABASE_URL\":\"\${{Postgres.DATABASE_URL}}\"}"
D_SAME="{\"A\":\"a-$S\",\"B\":\"b-$S\",\"EXTRA\":\"x-$S\"}"

# --- cases -------------------------------------------------------------------

new_case in-sync "$R_SAME" "$D_SAME" A B
run_sync
if [ "$RC" = 0 ]; then ok "in-sync dry run exits 0"; else bad "in-sync dry run exits 0" "$OUT"; fi
if has $'A\tunchanged' && has $'B\tunchanged'; then ok "in-sync dry run: both keys unchanged"; else bad "in-sync dry run: both keys unchanged" "$OUT"; fi
if has "match)"; then ok "in-sync dry run: hashes match"; else bad "in-sync dry run: hashes match" "$OUT"; fi
if has "left alone (not in doppler-keys.txt): DATABASE_URL UNLISTED"; then ok "in-sync dry run: reports the unlisted Railway key by name"; else bad "in-sync dry run: reports the unlisted Railway key by name" "$OUT"; fi
check_no_leak "in-sync dry run"
run_sync --apply
if has "nothing to change; no redeploy"; then ok "in-sync apply: nothing to change"; else bad "in-sync apply: nothing to change" "$OUT"; fi
if [ "$(mutations)" = 0 ]; then ok "in-sync apply: zero mutations"; else bad "in-sync apply: zero mutations" "mutations: $(cat "$CASE/stub/mutations")"; fi
check_no_leak "in-sync apply"

new_case drift "{\"A\":\"a-$S\",\"B\":\"old-$S\"}" "{\"A\":\"a-$S\",\"B\":\"new-$S\",\"C\":\"c-$S\"}" A B C
run_sync
if has $'B\tchanged' && has $'C\tnew' && has $'A\tunchanged'; then ok "drift dry run: changed and new reported"; else bad "drift dry run: changed and new reported" "$OUT"; fi
if has "differ)"; then ok "drift dry run: hashes differ"; else bad "drift dry run: hashes differ" "$OUT"; fi
if [ "$(mutations)" = 0 ]; then ok "drift dry run: makes no mutation"; else bad "drift dry run: makes no mutation" "$OUT"; fi
run_sync --apply
if [ "$RC" = 0 ]; then ok "drift apply exits 0"; else bad "drift apply exits 0" "$OUT"; fi
if [ "$(cat "$CASE/stub/mutations")" = $'upsert B\nupsert C\nredeploy' ]; then ok "drift apply: upserts exactly B and C, then one redeploy"; else bad "drift apply: upserts exactly B and C, then one redeploy" "mutations: $(cat "$CASE/stub/mutations")"; fi
if has "hash after apply:" && has "(match)"; then ok "drift apply: hash matches after apply"; else bad "drift apply: hash matches after apply" "$OUT"; fi
if [ "$(jq -c '{B, C}' "$CASE/stub/railway.json")" = "{\"B\":\"new-$S\",\"C\":\"c-$S\"}" ]; then ok "drift apply: Railway now holds Doppler's values"; else bad "drift apply: Railway now holds Doppler's values" "$OUT"; fi
check_no_leak "drift apply"
run_sync --apply
if [ "$(grep -c redeploy "$CASE/stub/mutations")" = 1 ]; then ok "drift re-apply is a no-op (no second redeploy)"; else bad "drift re-apply is a no-op (no second redeploy)" "$OUT"; fi

new_case no-redeploy "{\"A\":\"old-$S\"}" "{\"A\":\"new-$S\"}" A
run_sync --apply --no-redeploy
if [ "$(cat "$CASE/stub/mutations")" = "upsert A" ]; then ok "--no-redeploy: one upsert, no redeploy"; else bad "--no-redeploy: one upsert, no redeploy" "mutations: $(cat "$CASE/stub/mutations")"; fi

new_case dirty "$R_SAME" "$D_SAME" A
echo scratch >"$CASE/repo/untracked"
run_sync --apply
if [ "$RC" != 0 ] && has "working tree is dirty"; then ok "dirty tree: --apply refused"; else bad "dirty tree: --apply refused" "$OUT"; fi
if [ "$(mutations)" = 0 ]; then ok "dirty tree: zero mutations"; else bad "dirty tree: zero mutations" "$OUT"; fi
run_sync
if [ "$RC" = 0 ]; then ok "dirty tree: dry run still allowed"; else bad "dirty tree: dry run still allowed" "$OUT"; fi

new_case railway-system "$R_SAME" "$D_SAME" A RAILWAY_PUBLIC_DOMAIN
run_sync
if [ "$RC" != 0 ] && has "RAILWAY_PUBLIC_DOMAIN is a Railway system variable"; then ok "RAILWAY_* in allowlist refused"; else bad "RAILWAY_* in allowlist refused" "$OUT"; fi

new_case railway-ref "$R_SAME" "{\"DATABASE_URL\":\"d-$S\"}" DATABASE_URL
run_sync --apply
if [ "$RC" != 0 ] && has "refusing: DATABASE_URL"; then ok "Railway reference refused"; else bad "Railway reference refused" "$OUT"; fi
if [ "$(mutations)" = 0 ]; then ok "Railway reference: zero mutations"; else bad "Railway reference: zero mutations" "$OUT"; fi
check_no_leak "Railway reference"

new_case doppler-ref "{\"A\":\"a-$S\"}" "{\"A\":\"\${{Postgres.X}}\"}" A
run_sync --apply
if [ "$RC" != 0 ] && has $'A\tdoppler-value-is-a-reference'; then ok "a \${{ value in Doppler refused"; else bad "a \${{ value in Doppler refused" "$OUT"; fi

new_case missing "$R_SAME" "$D_SAME" A NOT_IN_DOPPLER
run_sync --apply
if [ "$RC" != 0 ] && has $'NOT_IN_DOPPLER\tmissing-in-doppler' && [ "$(mutations)" = 0 ]; then ok "key missing in Doppler refused, nothing set"; else bad "key missing in Doppler refused, nothing set" "$OUT"; fi

new_case bad-name "$R_SAME" "$D_SAME" 'lower_case'
run_sync
if [ "$RC" != 0 ] && has "is not a valid variable name"; then ok "invalid variable name refused"; else bad "invalid variable name refused" "$OUT"; fi

new_case empty "$R_SAME" "$D_SAME" '# only a comment'
run_sync
if [ "$RC" != 0 ] && has "lists no keys"; then ok "empty allowlist refused"; else bad "empty allowlist refused" "$OUT"; fi

new_case unknown-arg "$R_SAME" "$D_SAME" A
run_sync --delete
if [ "$RC" = 2 ]; then ok "unknown argument refused with exit 2"; else bad "unknown argument refused with exit 2" "$OUT"; fi

new_case special "{\"A\":\"line1\\nline2 \\\"q\\\" \$x $S\"}" "{\"A\":\"line1\\nline2 \\\"q\\\" \$x $S changed\"}" A
run_sync --apply
if [ "$RC" = 0 ] && [ "$(jq -c .A "$CASE/stub/railway.json")" = "$(jq -c .A "$CASE/stub/doppler.json")" ]; then ok "multi-line and quoted value is copied byte for byte"; else bad "multi-line and quoted value is copied byte for byte" "$OUT"; fi
check_no_leak "multi-line value"

# Railway accepts the upsert but does not keep the value: the re-read hash must catch it.
new_case lost-write "{\"A\":\"old-$S\"}" "{\"A\":\"new-$S\"}" A
: >"$CASE/stub/drop-upserts"
run_sync --apply
if [ "$RC" != 0 ] && has "hash after apply is"; then ok "lost write: apply dies on the after-apply hash"; else bad "lost write: apply dies on the after-apply hash" "$OUT"; fi
if ! grep -q redeploy "$CASE/stub/mutations"; then ok "lost write: no redeploy"; else bad "lost write: no redeploy" "mutations: $(cat "$CASE/stub/mutations")"; fi
check_no_leak "lost write"

# A bad token can still get HTTP 200: errors with null data, or null variables. Both must
# stop the script before it plans or writes anything.
for shape in errors:'{"data":null,"errors":[{"message":"Not Authorized"}]}' null-variables:'{"data":{"variables":null}}' no-variables:'{"data":{}}'; do
  label="${shape%%:*}"
  new_case "bad-read-$label" "{\"A\":\"old-$S\"}" "{\"A\":\"new-$S\"}" A
  printf '%s\n' "${shape#*:}" >"$CASE/stub/variables-response"
  run_sync --apply
  if [ "$RC" != 0 ] && [ "$(mutations)" = 0 ] && { [ "$label" = errors ] || has "Railway returned no variables object"; }; then ok "railway read $label: --apply exits non-zero, zero mutations"; else bad "railway read $label: --apply exits non-zero, zero mutations" "rc=$RC mutations: $(cat "$CASE/stub/mutations") $OUT"; fi
  check_no_leak "railway read $label"
  run_sync
  if [ "$RC" != 0 ]; then ok "railway read $label: dry run exits non-zero"; else bad "railway read $label: dry run exits non-zero" "$OUT"; fi
done

new_case empty-railway '{}' "{\"A\":\"a-$S\"}" A
run_sync
if [ "$RC" = 0 ] && has $'A\tnew'; then ok "an empty variables object is valid: key reads as new"; else bad "an empty variables object is valid: key reads as new" "$OUT"; fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" = 0 ]

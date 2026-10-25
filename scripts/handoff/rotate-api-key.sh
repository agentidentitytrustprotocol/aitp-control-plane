#!/usr/bin/env bash
# Rotate the control-plane API key the console uses (H0.1), with no downtime.
#
#   O = the key the console uses today   (Doppler secret CP_API_KEY_CONSOLE)
#   N = the key that replaces it          (Doppler secret CP_API_KEY_NEW)
#
#   1. CP (Railway):  API_KEYS gains `<label>:N` next to O       (both work)
#   2. Console (Vercel): CP_API_KEY=N, then a production redeploy
#   3. Verify: N -> 200 at the CP; the console reaches the CP with N
#   4. CP (Railway):  O is removed from API_KEYS
#   5. Verify: O -> 401, N -> 200
#
# Every other API_KEYS entry (for example the playground's key) is left as it
# is. Keys are labelled (`label:key`, see docs/api.md), so admin audit rows made
# with N carry actor `key:<label>`.
#
# MODES
#   (default)    dry run: read-only preflight, then print the plan. Changes nothing.
#   --apply      run steps 1-5.
#   --rollback   put O back on the CP and the console back on O. N stays on the
#                CP, so a half-finished rotation is safe to roll back at any step.
#
# SECRETS
#   Values come from Doppler (`doppler secrets get --plain`) and from Railway's
#   current API_KEYS, are held in shell variables only, and reach other tools on
#   stdin (railway --stdin, the Vercel REST API via curl --data-binary @-,
#   curl -H @-). Nothing is
#   written to disk and no value is printed: keys are shown as
#   `apikey:<sha256[:16]>`, the same fingerprint the CP used as actor id before
#   labels. If CP_API_KEY_NEW is missing, --apply generates N in memory and
#   stores it in Doppler (via stdin) before touching anything else.
#   Optional Doppler secret CONSOLE_PASSWORD lets step 3 log in to the console
#   and call a CP-backed console route; without it that check is skipped.
#
# USAGE
#   scripts/handoff/rotate-api-key.sh --doppler-project <p> --doppler-config <c> \
#       [--label console-YYYYMMDD] [--apply | --rollback] [--yes]
#
# Requires: bash 3.2+, doppler, railway, vercel, curl, jq, openssl, shasum;
# logged in to all three CLIs.
set -euo pipefail
umask 077

# ----- targets (override with env vars) --------------------------------------
RAILWAY_PROJECT_ID="${RAILWAY_PROJECT_ID:-70754f0b-c930-4433-a268-7b408e8230e2}" # aitp-runner
RAILWAY_ENV="${RAILWAY_ENV:-production}"
RAILWAY_SERVICE="${RAILWAY_SERVICE:-aitp-control-plane}"
CP_URL="${CP_URL:-https://aitp-control-plane-production.up.railway.app}"
VERCEL_SCOPE="${VERCEL_SCOPE:-zer07labs}"
VERCEL_PROJECT="${VERCEL_PROJECT:-aitp-ui-console}"
CONSOLE_URL="${CONSOLE_URL:-https://console.agentidentitytrustprotocol.io}"
# A gated, read-only CP route (GET): 200 with a valid key, 401 without.
CP_PROBE_PATH="${CP_PROBE_PATH:-/api/trust-anchors}"
CONSOLE_PROBE_PATH="${CONSOLE_PROBE_PATH:-/api/cp/trust-anchors}"
WAIT_SECONDS="${WAIT_SECONDS:-600}"

MODE=dry-run
DOPPLER_PROJECT=""
DOPPLER_CONFIG=""
LABEL="console-$(date -u +%Y%m%d)"
ASSUME_YES=0

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) MODE=apply ;;
    --rollback) MODE=rollback ;;
    --dry-run) MODE=dry-run ;;
    --doppler-project) DOPPLER_PROJECT="${2:-}"; shift ;;
    --doppler-config) DOPPLER_CONFIG="${2:-}"; shift ;;
    --label) LABEL="${2:-}"; shift ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 2 ;;
  esac
  shift
done

log() { printf '[%s] %s\n' "$MODE" "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Fingerprint a secret without printing it (sha256, first 16 hex chars).
fp() { printf 'apikey:%s' "$(printf '%s' "$1" | shasum -a 256 | cut -c1-16)"; }

# ----- preflight --------------------------------------------------------------
[ -n "$DOPPLER_PROJECT" ] && [ -n "$DOPPLER_CONFIG" ] ||
  die "--doppler-project and --doppler-config are required (no default Doppler project holds these keys)"
printf '%s' "$LABEL" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$' ||
  die "--label must match [A-Za-z0-9][A-Za-z0-9._-]{0,39} (see docs/api.md)"
for t in doppler railway vercel curl jq openssl shasum; do
  command -v "$t" >/dev/null 2>&1 || die "missing tool: $t"
done

doppler_get() { # name -> value on stdout ("" if absent)
  doppler secrets get "$1" --plain -p "$DOPPLER_PROJECT" -c "$DOPPLER_CONFIG" 2>/dev/null || true
}
doppler_set_stdin() { # name; value on stdin
  doppler secrets set "$1" -p "$DOPPLER_PROJECT" -c "$DOPPLER_CONFIG" --silent >/dev/null
}

doppler configs get "$DOPPLER_CONFIG" -p "$DOPPLER_PROJECT" >/dev/null 2>&1 ||
  die "Doppler project/config $DOPPLER_PROJECT/$DOPPLER_CONFIG is not readable"

# Railway commands run from a throwaway directory linked to the target; the
# link file holds ids only, never a secret.
RW_DIR="$(mktemp -d)"
trap 'rm -rf "$RW_DIR"' EXIT
(cd "$RW_DIR" && railway link -p "$RAILWAY_PROJECT_ID" -e "$RAILWAY_ENV" -s "$RAILWAY_SERVICE" >/dev/null) ||
  die "railway link failed for project $RAILWAY_PROJECT_ID"
rw() { (cd "$RW_DIR" && railway "$@"); }

current_api_keys() {
  rw variables --json -s "$RAILWAY_SERVICE" -e "$RAILWAY_ENV" | jq -r '.API_KEYS // ""'
}
set_api_keys() { # value on $1, sent on stdin
  printf '%s' "$1" | rw variable set API_KEYS --stdin -s "$RAILWAY_SERVICE" -e "$RAILWAY_ENV" >/dev/null
}

# Entry helpers. An entry is `label:key` or a bare `key` (docs/api.md).
entry_key() {
  local e="$1" pre
  case "$e" in
    *:*)
      pre="${e%%:*}"
      if printf '%s' "$pre" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$' && [ -n "${e#*:}" ]; then
        printf '%s' "${e#*:}"; return
      fi ;;
  esac
  printf '%s' "$e"
}
has_key() { # list key
  local IFS=, e
  for e in $1; do
    e="$(printf '%s' "$e" | sed 's/^ *//;s/ *$//')"
    [ -n "$e" ] && [ "$(entry_key "$e")" = "$2" ] && return 0
  done
  return 1
}
without_key() { # list key -> list
  local IFS=, e out=""
  for e in $1; do
    e="$(printf '%s' "$e" | sed 's/^ *//;s/ *$//')"
    [ -z "$e" ] && continue
    [ "$(entry_key "$e")" = "$2" ] && continue
    out="${out:+$out,}$e"
  done
  printf '%s' "$out"
}
has_label() { # list label; labels as the CP assigns them (bare key = unlabelled-<n>)
  local IFS=, e n=0 k lbl
  for e in $1; do
    e="$(printf '%s' "$e" | sed 's/^ *//;s/ *$//')"
    [ -z "$e" ] && continue
    n=$((n + 1)); k="$(entry_key "$e")"
    if [ "$k" = "$e" ]; then lbl="unlabelled-$n"; else lbl="${e%%:*}"; fi
    [ "$lbl" = "$2" ] && return 0
  done
  return 1
}
free_label() { # list base -> base, or base-2, base-3, ... (the CP refuses boot on a duplicate label)
  local l="$2" i=1
  while has_label "$1" "$l"; do i=$((i + 1)); l="$2-$i"; done
  printf '%s' "$l"
}
describe_list() { # list -> "label|fingerprint" lines, no secrets
  local IFS=, e n=0 k lbl
  for e in $1; do
    e="$(printf '%s' "$e" | sed 's/^ *//;s/ *$//')"
    [ -z "$e" ] && continue
    n=$((n + 1)); k="$(entry_key "$e")"
    if [ "$k" = "$e" ]; then lbl="unlabelled-$n"; else lbl="${e%%:*}"; fi
    printf '    %d. %-28s %s\n' "$n" "$lbl" "$(fp "$k")"
  done
}

cp_status() { # key -> HTTP status of the gated probe
  printf 'Authorization: Bearer %s\n' "$1" |
    curl -sS -o /dev/null -w '%{http_code}' -H @- --max-time 15 "$CP_URL$CP_PROBE_PATH" || printf '000'
}
wait_for_status() { # key expected what
  local deadline=$(( $(date +%s) + WAIT_SECONDS )) s
  while :; do
    s="$(cp_status "$1")"
    [ "$s" = "$2" ] && { log "ok: $3 -> $s"; return 0; }
    [ "$(date +%s)" -ge "$deadline" ] && die "timed out waiting for $3 -> $2 (last $s)"
    sleep 10
  done
}

console_check() { # logs in with CONSOLE_PASSWORD and calls a CP-backed route
  local pw cookie s
  pw="$(doppler_get CONSOLE_PASSWORD)"
  if [ -z "$pw" ]; then
    s="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$CONSOLE_URL/login" || printf '000')"
    log "console /login -> $s (no CONSOLE_PASSWORD in Doppler: CP-backed console check skipped)"
    [ "$s" = 200 ] || die "console is not serving /login"
    return 0
  fi
  # The session cookie stays in a variable; no cookie jar file.
  cookie="$(jq -n --arg p "$pw" '{password: $p}' |
    curl -sS -D - -o /dev/null --max-time 15 -H 'content-type: application/json' \
      -H "origin: $CONSOLE_URL" --data-binary @- "$CONSOLE_URL/login" |
    tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie: \([^;]*\).*/\1/p' | head -1)"
  [ -n "$cookie" ] || die "console login failed"
  s="$(printf 'Cookie: %s\n' "$cookie" |
    curl -sS -o /dev/null -w '%{http_code}' -H @- --max-time 20 "$CONSOLE_URL$CONSOLE_PROBE_PATH" || printf '000')"
  [ "$s" = 200 ] || die "console $CONSOLE_PROBE_PATH -> $s (console cannot reach the CP with its key)"
  log "ok: console $CONSOLE_PROBE_PATH -> 200"
}

# Vercel REST call; JSON body (if any) on stdin. The token is the CLI's own
# (refreshed by `vercel whoami` below) and reaches curl on a pipe, never argv.
vercel_api() { # method path
  curl -sS --fail-with-body --max-time 30 -X "$1" -H 'content-type: application/json' \
    -H @<(printf 'Authorization: Bearer %s\n' "$VERCEL_TOKEN_VALUE") \
    "https://api.vercel.com$2?teamId=$VC_ORG_ID" \
    --data-binary @-
}
# The CLI's OAuth token is short-lived, and a rotation can run for 10+ minutes
# between preflight and the first Vercel write. `vercel whoami` refreshes it
# when needed; re-read it before every batch of REST calls and refuse one that
# expires within 2 minutes. A VERCEL_TOKEN from the environment is used as is.
vercel_refresh_token() {
  [ -n "${VERCEL_TOKEN:-}" ] && { VERCEL_TOKEN_VALUE="$VERCEL_TOKEN"; return; }
  vercel whoami >/dev/null 2>&1 || die "vercel CLI is not logged in"
  local exp
  VERCEL_TOKEN_VALUE="$(jq -r '.token // empty' "$VERCEL_AUTH_FILE" 2>/dev/null || true)"
  exp="$(jq -r '.expiresAt // 0' "$VERCEL_AUTH_FILE" 2>/dev/null || true)"
  [ -n "$VERCEL_TOKEN_VALUE" ] || die "no Vercel token (set VERCEL_TOKEN, or log in with the vercel CLI)"
  [ -z "$exp" ] || [ "$exp" = 0 ] || [ "$exp" -gt $(( $(date +%s) + 120 )) ] ||
    die "the Vercel CLI token expires within 2 minutes and was not refreshed; run \`vercel login\` or set VERCEL_TOKEN"
}
# `vercel env update ... preview` cannot run non-interactively: the CLI asks
# which git branch the preview value applies to. The REST API sets the
# all-branches preview entry directly: PATCH the existing entry for a target,
# or create one (sensitive) if that target has none.
vercel_set_cp_key() { # value on $1
  local target id envs
  vercel_refresh_token
  envs="$(vercel_api GET "/v10/projects/$VC_PROJECT_ID/env" </dev/null)" ||
    die "could not list the console's env vars: $(printf '%s' "$envs" | jq -r '.error.message // .' 2>/dev/null)"
  for target in production preview; do
    id="$(printf '%s' "$envs" | jq -r --arg t "$target" \
      '[.envs[] | select(.key == "CP_API_KEY" and (.target | index($t)) and .gitBranch == null)][0].id // empty')"
    if [ -n "$id" ]; then
      printf '%s' "$1" | jq -Rs '{value: .}' |
        vercel_api PATCH "/v9/projects/$VC_PROJECT_ID/env/$id" >/dev/null ||
        die "updating console CP_API_KEY ($target) failed"
    else
      printf '%s' "$1" | jq -Rs --arg t "$target" \
        '{key: "CP_API_KEY", value: ., type: "sensitive", target: [$t]}' |
        vercel_api POST "/v10/projects/$VC_PROJECT_ID/env" >/dev/null ||
        die "creating console CP_API_KEY ($target) failed"
    fi
    log "console CP_API_KEY ($target) set to $(fp "$1")"
  done
}
vercel_redeploy() {
  local url
  url="$(vercel inspect "$CONSOLE_URL" --scope "$VERCEL_SCOPE" --format=json 2>/dev/null | jq -r '.url // empty')"
  [ -n "$url" ] || die "could not resolve the console's current production deployment"
  log "redeploying console from $url"
  vercel redeploy "https://${url#https://}" --target production --scope "$VERCEL_SCOPE" --cwd "$VC_DIR" >/dev/null
}

VC_DIR="$(mktemp -d)"
trap 'rm -rf "$RW_DIR" "$VC_DIR"' EXIT
(cd "$VC_DIR" && vercel link --yes --project "$VERCEL_PROJECT" --scope "$VERCEL_SCOPE" >/dev/null 2>&1) ||
  die "vercel link failed for $VERCEL_SCOPE/$VERCEL_PROJECT"
VC_PROJECT_ID="$(jq -r '.projectId // empty' "$VC_DIR/.vercel/project.json")"
VC_ORG_ID="$(jq -r '.orgId // empty' "$VC_DIR/.vercel/project.json")"
[ -n "$VC_PROJECT_ID" ] && [ -n "$VC_ORG_ID" ] || die "vercel link wrote no project/org id"
VERCEL_AUTH_FILE="${VERCEL_AUTH_FILE:-$HOME/Library/Application Support/com.vercel.cli/auth.json}"
[ -r "$VERCEL_AUTH_FILE" ] || VERCEL_AUTH_FILE="$HOME/.local/share/com.vercel.cli/auth.json"
vercel_refresh_token

OLD="$(doppler_get CP_API_KEY_CONSOLE)"
NEW="$(doppler_get CP_API_KEY_NEW)"
[ -n "$OLD" ] || die "Doppler $DOPPLER_PROJECT/$DOPPLER_CONFIG has no CP_API_KEY_CONSOLE (the console's current key)"
case "$OLD$NEW" in *,*|*:*) die "keys must not contain ',' or ':'" ;; esac
[ "$OLD" != "$NEW" ] || die "CP_API_KEY_NEW equals CP_API_KEY_CONSOLE"
KEYS="$(current_api_keys)"
[ -n "$KEYS" ] || die "could not read API_KEYS from Railway"

log "CP $RAILWAY_SERVICE ($RAILWAY_ENV) API_KEYS now:"
describe_list "$KEYS" >&2
log "O = $(fp "$OLD") $(has_key "$KEYS" "$OLD" && echo '(present on CP)' || echo '(NOT on CP)')"
if [ -n "$NEW" ]; then
  log "N = $(fp "$NEW") $(has_key "$KEYS" "$NEW" && echo '(present on CP)' || echo '(not on CP yet)'), label $LABEL"
else
  log "N = (not in Doppler yet; --apply generates it and stores CP_API_KEY_NEW)"
fi

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  printf '%s [type yes] ' "$1" >&2
  local a; read -r a </dev/tty; [ "$a" = yes ] || die "aborted"
}

# ----- dry run ----------------------------------------------------------------
if [ "$MODE" = dry-run ]; then
  cat >&2 <<EOF
Plan (nothing has been changed):
  1. Railway $RAILWAY_SERVICE/$RAILWAY_ENV: API_KEYS += "$LABEL:<N>" (redeploys the CP); wait for N -> 200 on $CP_PROBE_PATH
  2. Vercel $VERCEL_SCOPE/$VERCEL_PROJECT: CP_API_KEY = N (production, preview); redeploy production
  3. Verify: N -> 200 at the CP; console $CONSOLE_PROBE_PATH -> 200
  4. Railway: API_KEYS -= O (redeploys the CP)
  5. Verify: O -> 401, N -> 200
Run with --apply to execute, --rollback to undo.
EOF
  has_key "$KEYS" "$OLD" || log "warning: O is not on the CP; --apply would refuse"
  { [ -n "$NEW" ] && has_key "$KEYS" "$NEW"; } || ! has_label "$KEYS" "$LABEL" ||
    log "warning: label $LABEL is already in API_KEYS; --apply would refuse (pass --label)"
  exit 0
fi

# ----- rollback ---------------------------------------------------------------
if [ "$MODE" = rollback ]; then
  confirm "Roll back: put O back on the CP and point the console at O?"
  if has_key "$KEYS" "$OLD"; then
    log "step R1: O already on the CP"
  else
    RLABEL="$(free_label "$KEYS" console-old)"
    set_api_keys "$KEYS,$RLABEL:$OLD"
    log "step R1: API_KEYS += $RLABEL:$(fp "$OLD")"
  fi
  wait_for_status "$OLD" 200 "O at the CP"
  vercel_set_cp_key "$OLD"
  vercel_redeploy
  console_check
  log "rolled back. N ($(fp "${NEW:-}")) is still on the CP; remove it by hand if it should go."
  exit 0
fi

# ----- apply ------------------------------------------------------------------
has_key "$KEYS" "$OLD" || die "O is not in the CP's API_KEYS; nothing to rotate (or already rotated)"
# Before anything is written: a duplicate label makes the CP exit 1 at boot, which
# would leave a crash-looping API_KEYS on Railway (docs/api.md).
{ [ -n "$NEW" ] && has_key "$KEYS" "$NEW"; } || ! has_label "$KEYS" "$LABEL" ||
  die "label $LABEL is already in the CP's API_KEYS; pass --label with a new one"
confirm "Rotate the console's CP key on $CP_URL?"

if [ -z "$NEW" ]; then
  NEW="$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')"
  printf '%s' "$NEW" | doppler_set_stdin CP_API_KEY_NEW
  [ "$(doppler_get CP_API_KEY_NEW)" = "$NEW" ] || die "could not store CP_API_KEY_NEW in Doppler"
  log "generated N = $(fp "$NEW") and stored it in Doppler as CP_API_KEY_NEW"
fi

# 1. add N next to O
if has_key "$KEYS" "$NEW"; then
  log "step 1: N already on the CP"
else
  KEYS="$KEYS,$LABEL:$NEW"
  set_api_keys "$KEYS"
  log "step 1: API_KEYS += $LABEL:$(fp "$NEW")"
fi
wait_for_status "$NEW" 200 "N at the CP"
[ "$(cp_status "$OLD")" = 200 ] || die "O stopped working before the console moved; run --rollback"

# 2. move the console to N
vercel_set_cp_key "$NEW"
vercel_redeploy

# 3. verify
wait_for_status "$NEW" 200 "N at the CP"
console_check

# 4. remove O
KEYS="$(current_api_keys)"
REMAINING="$(without_key "$KEYS" "$OLD")"
has_key "$REMAINING" "$NEW" || die "refusing to remove O: N would not remain"
set_api_keys "$REMAINING"
log "step 4: API_KEYS -= $(fp "$OLD"); now:"
describe_list "$REMAINING" >&2

# 5. verify O -> 401
wait_for_status "$OLD" 401 "O at the CP"
wait_for_status "$NEW" 200 "N at the CP"
console_check
log "done. Next: copy CP_API_KEY_NEW over CP_API_KEY_CONSOLE in Doppler, then delete CP_API_KEY_NEW, once the rotation is final."

#!/usr/bin/env bash
# Mint a read-only control-plane key (READ_ONLY_API_KEYS, docs/api.md
# "Read-only keys") for a consumer such as the console, into Doppler.
#
#   1. READ_ONLY_API_KEYS gains `<label>:<new key>`; every existing entry is
#      kept byte for byte.
#   2. <secret-name> (default CP_API_KEY_CONSOLE_RO) holds the same key, for the
#      consumer to pick up later.
#   3. Both are re-read and checked by sha256 fingerprint.
#
# It writes Doppler only. Railway gets READ_ONLY_API_KEYS from the next
# `deploy/doppler-sync.sh --apply` (Doppler owns it: deploy/doppler-keys.txt),
# and the consumer is NOT switched to the key here.
#
# MODES
#   (default)    dry run: read-only preflight, then print the plan. Changes nothing.
#   --apply      write steps 1-3.
#
# RE-RUNS
#   The label must be new. If it is already in READ_ONLY_API_KEYS:
#     - <secret-name> holds that entry's key  -> nothing to do (exit 0)
#     - <secret-name> is empty                -> a half-finished earlier run:
#                                                --apply copies the key across
#     - <secret-name> holds a different key   -> refuse (exit 1)
#   A label used by API_KEYS, or a <secret-name> that already holds some other
#   key while the label is new, is refused too: this script never overwrites a key.
#
# SECRETS
#   The key is generated in memory (`openssl rand -hex 32`), held in a shell
#   variable only and reaches Doppler on stdin. Nothing is written to disk and
#   no value is printed: keys are shown as `apikey:<sha256[:16]>`.
#
# USAGE
#   scripts/handoff/create-read-key.sh [--label console-ro-YYYYMMDD]
#       [--secret-name CP_API_KEY_CONSOLE_RO]
#       [--doppler-project aitp-control-plane --doppler-config prd] [--apply]
#
# Requires: bash 3.2+, doppler (logged in), openssl, shasum.
set -euo pipefail
set +x # never trace: the key lives in a shell variable
umask 077

MODE=dry-run
DOPPLER_PROJECT=aitp-control-plane
DOPPLER_CONFIG=prd
LABEL="console-ro-$(date -u +%Y%m%d)"
SECRET_NAME=CP_API_KEY_CONSOLE_RO

usage() { sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) MODE=apply ;;
    --dry-run) MODE=dry-run ;;
    --doppler-project) DOPPLER_PROJECT="${2:-}"; shift ;;
    --doppler-config) DOPPLER_CONFIG="${2:-}"; shift ;;
    --label) LABEL="${2:-}"; shift ;;
    --secret-name) SECRET_NAME="${2:-}"; shift ;;
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
LABEL_RE='^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'
printf '%s' "$LABEL" | grep -Eq "$LABEL_RE" ||
  die "--label must match [A-Za-z0-9][A-Za-z0-9._-]{0,39} (see docs/api.md)"
printf '%s' "$SECRET_NAME" | grep -Eq '^[A-Z][A-Z0-9_]*$' ||
  die "--secret-name must be an upper-case Doppler secret name"
case "$SECRET_NAME" in
  READ_ONLY_API_KEYS|API_KEYS|ISSUER_KEYS) die "--secret-name must not be a key list" ;;
esac
for t in doppler openssl shasum; do
  command -v "$t" >/dev/null 2>&1 || die "missing tool: $t"
done

# READ_ONLY_API_KEYS must land in the Doppler config deploy/doppler-sync.sh
# reads, or the next sync never carries it to Railway. Read the expected pair
# from the sync script itself so the two cannot drift apart.
SYNC_SCRIPT="$(cd "$(dirname "$0")/../.." && pwd)/deploy/doppler-sync.sh"
[ -r "$SYNC_SCRIPT" ] || die "cannot read $SYNC_SCRIPT (needed to confirm the Doppler project/config)"
SYNC_PROJECT="$(sed -n 's/^DOPPLER_PROJECT=\([A-Za-z0-9_-]*\).*/\1/p' "$SYNC_SCRIPT")"
SYNC_CONFIG="$(sed -n 's/^DOPPLER_CONFIG=\([A-Za-z0-9_-]*\).*/\1/p' "$SYNC_SCRIPT")"
[ -n "$SYNC_PROJECT" ] && [ -n "$SYNC_CONFIG" ] || die "could not read DOPPLER_PROJECT/DOPPLER_CONFIG from $SYNC_SCRIPT"
[ "$DOPPLER_PROJECT/$DOPPLER_CONFIG" = "$SYNC_PROJECT/$SYNC_CONFIG" ] ||
  die "refusing: --doppler-project/--doppler-config is $DOPPLER_PROJECT/$DOPPLER_CONFIG, but deploy/doppler-sync.sh syncs $SYNC_PROJECT/$SYNC_CONFIG into Railway"

# Die before generating anything if Doppler is unreachable.
doppler configs get "$DOPPLER_CONFIG" -p "$DOPPLER_PROJECT" >/dev/null 2>&1 ||
  die "Doppler project/config $DOPPLER_PROJECT/$DOPPLER_CONFIG is not readable"

doppler_read() { # name var [failure note] -> sets var; "" only if Doppler says the secret does not exist
  local v err note="${3:-nothing written}"
  if v="$(doppler secrets get "$1" --plain -p "$DOPPLER_PROJECT" -c "$DOPPLER_CONFIG" 2>/dev/null)"; then
    printf -v "$2" '%s' "$v"; return 0
  fi
  # Any other failure (network, auth, rate limit) must not look like "absent":
  # that would append to an empty list and wipe the existing entries.
  err="$(doppler secrets get "$1" --plain -p "$DOPPLER_PROJECT" -c "$DOPPLER_CONFIG" 2>&1 >/dev/null || true)"
  case "$err" in
    *"Could not find requested secret"*) printf -v "$2" '%s' ""; return 0 ;;
  esac
  die "could not read $1 from Doppler $DOPPLER_PROJECT/$DOPPLER_CONFIG (not a 'not found'); $note"
}
doppler_set_stdin() { # name; value on stdin
  doppler secrets set "$1" -p "$DOPPLER_PROJECT" -c "$DOPPLER_CONFIG" --silent >/dev/null
}

trim() { printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'; }

# Labels as the CP assigns them in API_KEYS (bare key = unlabelled-<n>).
admin_has_label() { # list label
  local IFS=, e n=0 pre lbl
  for e in $1; do
    e="$(trim "$e")"; [ -z "$e" ] && continue
    n=$((n + 1)); lbl="unlabelled-$n"
    case "$e" in
      *:*) pre="${e%%:*}"
           if printf '%s' "$pre" | grep -Eq "$LABEL_RE" && [ -n "${e#*:}" ]; then lbl="$pre"; fi ;;
    esac
    [ "$lbl" = "$2" ] && return 0
  done
  return 1
}
ro_key_for_label() { # list label -> key on stdout; status 1 if absent
  local IFS=, e
  for e in $1; do
    e="$(trim "$e")"
    case "$e" in "$2":?*) trim "${e#*:}"; return 0 ;; esac
  done
  return 1
}
ro_has_key() { # list key
  local IFS=, e
  for e in $1; do
    e="$(trim "$e")"
    case "$e" in *:*) [ "$(trim "${e#*:}")" = "$2" ] && return 0 ;; esac
  done
  return 1
}
count_entries() { # list -> number of non-empty entries
  local IFS=, e n=0
  for e in $1; do e="$(trim "$e")"; [ -n "$e" ] && n=$((n + 1)); done
  printf '%d' "$n"
}

RO=""; ADMIN=""; SECRET=""
doppler_read READ_ONLY_API_KEYS RO
doppler_read API_KEYS ADMIN
doppler_read "$SECRET_NAME" SECRET

log "Doppler $DOPPLER_PROJECT/$DOPPLER_CONFIG: READ_ONLY_API_KEYS has $(count_entries "$RO") entr(y/ies) (${#RO} chars); API_KEYS has $(count_entries "$ADMIN"); $SECRET_NAME is $([ -n "$SECRET" ] && printf 'set (%s)' "$(fp "$SECRET")" || printf 'empty')"

admin_has_label "$ADMIN" "$LABEL" &&
  die "label $LABEL is already used by an API_KEYS entry (labels must be unique across both lists; the CP refuses to boot)"

# ----- re-run of an existing label ---------------------------------------------
if EXISTING="$(ro_key_for_label "$RO" "$LABEL")"; then
  if [ -n "$SECRET" ] && [ "$SECRET" = "$EXISTING" ]; then
    log "label $LABEL is already in READ_ONLY_API_KEYS and $SECRET_NAME holds the same key ($(fp "$EXISTING")): nothing to do"
    exit 0
  fi
  [ -z "$SECRET" ] ||
    die "refusing: label $LABEL is already in READ_ONLY_API_KEYS ($(fp "$EXISTING")) but $SECRET_NAME holds a different key ($(fp "$SECRET")); pick a new --label"
  log "label $LABEL is already in READ_ONLY_API_KEYS ($(fp "$EXISTING")) but $SECRET_NAME is empty: an earlier run stopped half-way"
  if [ "$MODE" != apply ]; then
    log "plan: copy that key into $SECRET_NAME (READ_ONLY_API_KEYS unchanged). Re-run with --apply."
    exit 0
  fi
  printf '%s' "$EXISTING" | doppler_set_stdin "$SECRET_NAME"
  doppler_read "$SECRET_NAME" GOT_SECRET "a write was sent; re-run this script to check and complete it"
  [ "$GOT_SECRET" = "$EXISTING" ] || die "$SECRET_NAME did not read back as $(fp "$EXISTING")"
  log "completed: $SECRET_NAME = $(fp "$EXISTING")"
  exit 0
fi

# ----- new label -----------------------------------------------------------------
[ -z "$SECRET" ] ||
  die "refusing: $SECRET_NAME already holds a key ($(fp "$SECRET")) and label $LABEL is new; this script never overwrites a key (use --secret-name, or retire the old key first)"

if [ "$MODE" != apply ]; then
  log "plan: generate a 64-hex key; READ_ONLY_API_KEYS gains '$LABEL:<key>' ($(count_entries "$RO") -> $(( $(count_entries "$RO") + 1 )) entries, existing ones untouched); $SECRET_NAME = the same key"
  log "dry run: nothing written. Re-run with --apply, then deploy/doppler-sync.sh --apply to reach Railway."
  exit 0
fi

KEY="$(openssl rand -hex 32)"
[ "${#KEY}" -eq 64 ] || die "openssl did not produce a 64-hex key"
ro_has_key "$RO" "$KEY" && die "generated key collides with an existing entry (re-run)"
NEW_RO="${RO:+$RO,}$LABEL:$KEY"

# READ_ONLY_API_KEYS first: if the second write fails, a re-run sees the label
# and finishes the copy (see RE-RUNS) instead of minting a second key.
printf '%s' "$NEW_RO" | doppler_set_stdin READ_ONLY_API_KEYS
printf '%s' "$KEY" | doppler_set_stdin "$SECRET_NAME"

GOT_RO=""; GOT_SECRET=""
AFTER="writes were sent; re-run this script to check and complete them"
doppler_read READ_ONLY_API_KEYS GOT_RO "$AFTER"
doppler_read "$SECRET_NAME" GOT_SECRET "$AFTER"
[ "$GOT_RO" = "$NEW_RO" ] ||
  die "READ_ONLY_API_KEYS did not read back as written (expected $(fp "$NEW_RO"), got $(fp "$GOT_RO"))"
[ "$GOT_SECRET" = "$KEY" ] ||
  die "$SECRET_NAME did not read back as $(fp "$KEY")"
log "done: READ_ONLY_API_KEYS += $LABEL ($(fp "$KEY")), now $(count_entries "$GOT_RO") entr(y/ies); $SECRET_NAME = $(fp "$GOT_SECRET")"
log "next: deploy/doppler-sync.sh (dry run), then --apply, then redeploy the CP so it reads the new list"

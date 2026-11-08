#!/usr/bin/env bash
#
# Offline tests for scripts/handoff/create-read-key.sh. No network, no real Doppler.
#
#   scripts/handoff/test-create-read-key.sh
#
# A stub `doppler` first on PATH keeps secrets as files in a throwaway directory
# and serves `configs get`, `secrets get --plain` and `secrets set` (value on
# stdin), logging every write. The stub fails the run if a value ever reaches
# its argv, and every case checks that no key value reaches the output.
#
# Needs bash, openssl and shasum (the same tools the script itself needs).

# The checks are `cond && ok … || bad …`; ok() always succeeds, so bad() runs only when cond fails.
# shellcheck disable=SC2015
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/create-read-key.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Every fake value contains this marker, so a leak is a plain substring search.
S=SENTINELvalue
pass=0
fail=0

ok() { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; [ -z "${2:-}" ] || printf '     %s\n' "$2"; }

mkdir -p "$work/bin"
cat >"$work/bin/doppler" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
for a in "$@"; do
  case "$a" in
    *SENTINEL*) echo "doppler stub: a value reached argv" >&2; echo leak >>"$STUB/argv-leak"; exit 97 ;;
  esac
  if printf '%s' "$a" | grep -Eq '[0-9a-f]{64}'; then
    echo "doppler stub: a key reached argv" >&2; echo leak >>"$STUB/argv-leak"; exit 97
  fi
done
[ -e "$STUB/unreachable" ] && { echo "doppler stub: unreachable" >&2; exit 1; }
case "$1 $2" in
  "configs get") exit 0 ;;
  "secrets get")
    [ -e "$STUB/fail-get-$3" ] && { echo "Doppler Error: request timed out" >&2; exit 1; }
    f="$STUB/secrets/$3"
    [ -e "$f" ] || { echo "Doppler Error: Could not find requested secret: $3" >&2; exit 1; }
    cat "$f" ;;
  "secrets set")
    [ -e "$STUB/fail-set-$3" ] && { echo "doppler stub: set $3 failed" >&2; exit 1; }
    cat >"$STUB/secrets/$3"
    echo "$3" >>"$STUB/sets" ;;
  *) echo "doppler stub: unexpected: $*" >&2; exit 99 ;;
esac
STUB
chmod +x "$work/bin/doppler"

# fresh <case> -> sets STUB to a clean store
fresh() {
  STUB="$work/$1"; export STUB
  mkdir -p "$STUB/secrets"
}
put() { printf '%s' "$2" >"$STUB/secrets/$1"; }
get() { cat "$STUB/secrets/$1" 2>/dev/null || true; }
sets() { cat "$STUB/sets" 2>/dev/null | tr '\n' ' ' | sed 's/ $//'; }
run() { # args... -> sets OUT and RC
  set +e
  OUT="$(PATH="$work/bin:$PATH" bash "$script" "$@" 2>&1)"
  RC=$?
  set -e
}
no_leak() { # case-name [extra-secret]
  if [ -e "$STUB/argv-leak" ]; then bad "$1: a value reached doppler argv"; return; fi
  case "$OUT" in *SENTINEL*) bad "$1: a fake value reached the output"; return ;; esac
  if [ -n "${2:-}" ]; then
    case "$OUT" in *"$2"*) bad "$1: the generated key reached the output"; return ;; esac
  fi
  if printf '%s' "$OUT" | grep -Eq '[0-9a-f]{64}'; then bad "$1: a 64-hex value reached the output"; return; fi
  ok "$1: no value in output or argv"
}

ADMIN="console-20261024:admin-$S,playground:play-$S"
OLD_RO="old-ro:ro-$S"

# --- 1. dry run writes nothing -------------------------------------------------
fresh dry
put API_KEYS "$ADMIN"; put READ_ONLY_API_KEYS "$OLD_RO"
run --label console-ro-test
[ "$RC" -eq 0 ] && ok "dry run exits 0" || bad "dry run exits 0" "rc=$RC $OUT"
[ -z "$(sets)" ] && ok "dry run writes nothing" || bad "dry run writes nothing" "sets: $(sets)"
case "$OUT" in *"plan:"*"1 -> 2 entries"*) ok "dry run prints the plan" ;; *) bad "dry run prints the plan" "$OUT" ;; esac
no_leak "dry run"

# --- 2. apply appends exactly one entry, existing ones byte for byte ------------
fresh apply
put API_KEYS "$ADMIN"; put READ_ONLY_API_KEYS "$OLD_RO"
run --label console-ro-test --apply
KEY="$(get CP_API_KEY_CONSOLE_RO)"
[ "$RC" -eq 0 ] && ok "apply exits 0" || bad "apply exits 0" "rc=$RC $OUT"
[ "$(sets)" = "READ_ONLY_API_KEYS CP_API_KEY_CONSOLE_RO" ] && ok "apply writes the list first, then the secret" || bad "apply write order" "sets: $(sets)"
printf '%s' "$KEY" | grep -Eq '^[0-9a-f]{64}$' && ok "the key is 64 hex chars" || bad "the key is 64 hex chars" "len=${#KEY}"
[ "$(get READ_ONLY_API_KEYS)" = "$OLD_RO,console-ro-test:$KEY" ] && ok "READ_ONLY_API_KEYS = old entries + exactly one new entry" || bad "READ_ONLY_API_KEYS content"
[ "$(get API_KEYS)" = "$ADMIN" ] && ok "API_KEYS untouched" || bad "API_KEYS untouched"
no_leak "apply" "$KEY"

# --- 3. second apply with the same label: nothing to do -------------------------
: >"$STUB/sets"
run --label console-ro-test --apply
[ "$RC" -eq 0 ] && ok "re-apply exits 0" || bad "re-apply exits 0" "rc=$RC $OUT"
[ -z "$(sets)" ] && ok "re-apply writes nothing" || bad "re-apply writes nothing" "sets: $(sets)"
case "$OUT" in *"nothing to do"*) ok "re-apply says nothing to do" ;; *) bad "re-apply says nothing to do" "$OUT" ;; esac
[ "$(get CP_API_KEY_CONSOLE_RO)" = "$KEY" ] && ok "re-apply keeps the key" || bad "re-apply keeps the key"
no_leak "re-apply" "$KEY"

# --- 4. a new label while the secret already holds a key: refuse ----------------
: >"$STUB/sets"
run --label console-ro-other --apply
[ "$RC" -eq 1 ] && ok "new label over a set secret refuses" || bad "new label over a set secret refuses" "rc=$RC $OUT"
[ -z "$(sets)" ] && ok "refusal writes nothing" || bad "refusal writes nothing" "sets: $(sets)"
no_leak "new label over a set secret" "$KEY"

# --- 5. empty READ_ONLY_API_KEYS is created -------------------------------------
fresh create
put API_KEYS "$ADMIN"
run --label console-ro-test --apply
KEY="$(get CP_API_KEY_CONSOLE_RO)"
[ "$RC" -eq 0 ] && [ "$(get READ_ONLY_API_KEYS)" = "console-ro-test:$KEY" ] && ok "absent READ_ONLY_API_KEYS is created with one entry" || bad "absent READ_ONLY_API_KEYS is created" "rc=$RC $OUT"
no_leak "create" "$KEY"

# --- 6. label already used by API_KEYS: refuse ----------------------------------
fresh admin-label
put API_KEYS "$ADMIN"
run --label playground --apply
[ "$RC" -eq 1 ] && [ -z "$(sets)" ] && ok "an API_KEYS label is refused" || bad "an API_KEYS label is refused" "rc=$RC $OUT"
put API_KEYS "bare-$S"
run --label unlabelled-1 --apply
[ "$RC" -eq 1 ] && [ -z "$(sets)" ] && ok "a bare API_KEYS key's unlabelled-<n> is refused" || bad "unlabelled-<n> is refused" "rc=$RC $OUT"
no_leak "admin label"

# --- 7. half-finished run: the secret write failed, a re-run completes it -------
fresh partial
put API_KEYS "$ADMIN"; put READ_ONLY_API_KEYS "$OLD_RO"
touch "$STUB/fail-set-CP_API_KEY_CONSOLE_RO"
run --label console-ro-test --apply
[ "$RC" -ne 0 ] && ok "a failed secret write fails the run" || bad "a failed secret write fails the run" "$OUT"
RO_AFTER="$(get READ_ONLY_API_KEYS)"
KEY="${RO_AFTER##*console-ro-test:}"
rm "$STUB/fail-set-CP_API_KEY_CONSOLE_RO"; : >"$STUB/sets"
run --label console-ro-test
[ "$RC" -eq 0 ] && [ -z "$(sets)" ] && ok "dry run of a half-finished run writes nothing" || bad "dry run of half-finished" "rc=$RC $OUT"
run --label console-ro-test --apply
[ "$RC" -eq 0 ] && ok "re-run completes a half-finished run" || bad "re-run completes" "rc=$RC $OUT"
[ "$(sets)" = "CP_API_KEY_CONSOLE_RO" ] && ok "completion writes only the secret" || bad "completion writes only the secret" "sets: $(sets)"
[ "$(get CP_API_KEY_CONSOLE_RO)" = "$KEY" ] && [ "$(get READ_ONLY_API_KEYS)" = "$RO_AFTER" ] && ok "completion copies the listed key; list unchanged" || bad "completion copies the listed key"
no_leak "partial" "$KEY"

# --- 8. label present but the secret holds a different key: refuse --------------
fresh mismatch
put API_KEYS "$ADMIN"; put READ_ONLY_API_KEYS "console-ro-test:ro-a-$S"; put CP_API_KEY_CONSOLE_RO "ro-b-$S"
run --label console-ro-test --apply
[ "$RC" -eq 1 ] && [ -z "$(sets)" ] && ok "label present with a different secret is refused" || bad "mismatch refused" "rc=$RC $OUT"
no_leak "mismatch"

# --- 9. Doppler unreachable: die before generating ------------------------------
fresh unreachable
touch "$STUB/unreachable"
run --label console-ro-test --apply
[ "$RC" -eq 1 ] && [ -z "$(sets)" ] && ok "unreachable Doppler dies without writing" || bad "unreachable Doppler" "rc=$RC $OUT"
case "$OUT" in *"not readable"*) ok "unreachable Doppler is named" ;; *) bad "unreachable Doppler is named" "$OUT" ;; esac

# --- 9b. a failed read (not "not found") dies instead of looking absent ---------
fresh read-error
put API_KEYS "$ADMIN"; put READ_ONLY_API_KEYS "$OLD_RO"
touch "$STUB/fail-get-READ_ONLY_API_KEYS"
run --label console-ro-test --apply
[ "$RC" -eq 1 ] && [ -z "$(sets)" ] && ok "a failed READ_ONLY_API_KEYS read dies without writing" || bad "failed read dies" "rc=$RC $OUT"
[ "$(get READ_ONLY_API_KEYS)" = "$OLD_RO" ] && ok "existing entries survive a failed read" || bad "existing entries survive a failed read"
rm "$STUB/fail-get-READ_ONLY_API_KEYS"; touch "$STUB/fail-get-API_KEYS"
run --label console-ro-test --apply
[ "$RC" -eq 1 ] && [ -z "$(sets)" ] && ok "a failed API_KEYS read dies without writing" || bad "failed API_KEYS read dies" "rc=$RC $OUT"
no_leak "read error"

# --- 9c. spaces around an entry and after the colon are trimmed like the server (labels are not) --
fresh spaces
put API_KEYS "$ADMIN"; put READ_ONLY_API_KEYS " console-ro-test:  ro-c-$S "; put CP_API_KEY_CONSOLE_RO "ro-c-$S"
run --label console-ro-test --apply
[ "$RC" -eq 0 ] && [ -z "$(sets)" ] && ok "a spaced entry with a matching secret is nothing to do" || bad "spaced entry" "rc=$RC $OUT"

# --- 10. wrong project/config, bad label, bad secret name -----------------------
fresh args
run --doppler-config dev --apply
[ "$RC" -eq 1 ] && [ -z "$(sets)" ] && ok "a config other than the sync script's is refused" || bad "wrong config" "rc=$RC $OUT"
run --label 'bad label' --apply
[ "$RC" -eq 1 ] && ok "an invalid label is refused" || bad "invalid label" "rc=$RC $OUT"
run --secret-name API_KEYS --apply
[ "$RC" -eq 1 ] && [ -z "$(sets)" ] && ok "a key-list secret name is refused" || bad "key-list secret name" "rc=$RC $OUT"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

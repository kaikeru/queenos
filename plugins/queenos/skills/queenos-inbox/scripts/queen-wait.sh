#!/bin/sh
# Usage: queen-wait.sh <sha|rev> [timeout_seconds=600]
# Polls the inbox notes (every QUEENOS_POLL_SECONDS, default and minimum 30) until a verdict
# note appears for <sha>, then prints it. INFRA is not final (the Queen retries) so polling goes on.
# Set QUEENOS_WAIT_FOR=landed to keep waiting past PASSED until LANDED.
# Exit: 0 PASSED/LANDED, 10 REJECTED, 12 SUPERSEDED, 124 timeout, 2 usage/error.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$here/_lib.sh"

case "${1:-}" in ''|-h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;; esac
require_git_repo
sha=$(resolve_sha "$1")
timeout=${2:-600}
interval=${QUEENOS_POLL_SECONDS:-30}
case "$timeout$interval" in *[!0-9]*) die "timeout and QUEENOS_POLL_SECONDS must be integers" ;; esac
[ "$interval" -ge 30 ] || interval=30

start=$(date +%s)
while :; do
  fetch_notes
  body=$(note_for verdict "$sha")
  # Notes are appended per milestone, so the last Queen-Verdict is the current state.
  verdict=
  if printf '%s\n' "$body" | grep -qi '^[[:space:]]*Queen-Note:[[:space:]]*v1'; then
  verdict=$(printf '%s\n' "$body" \
    | sed -n 's/^[ 	]*[Qq]ueen-[Vv]erdict:[ 	]*\([A-Za-z]*\).*/\1/p' | tail -n 1)
  fi
  if [ -n "$verdict" ]; then
    code=-1
    case "$verdict" in
      PASSED) [ "${QUEENOS_WAIT_FOR:-}" = landed ] || code=0 ;;
      LANDED) code=0 ;;
      REJECTED) code=10 ;;
      SUPERSEDED) code=12 ;;
      *) code=-1 ;; # INFRA or unknown: keep polling
    esac
    if [ "$code" -ge 0 ]; then
      printf 'verdict: %s\n' "$verdict"
      "$here/queen-notes.sh" "$sha"
      exit "$code"
    fi
    printf 'interim verdict %s for %s; still waiting\n' "$verdict" "$sha" >&2
  fi
  now=$(date +%s)
  [ $((now - start + interval)) -le "$timeout" ] || { printf 'timed out after %ss waiting for a verdict on %s\n' "$timeout" "$sha" >&2; exit 124; }
  sleep "$interval"
done

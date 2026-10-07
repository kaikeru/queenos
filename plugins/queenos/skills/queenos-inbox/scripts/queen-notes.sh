#!/bin/sh
# Usage: queen-notes.sh [<sha|rev>]   (default HEAD)
# Fetches refs/notes/* from the QueenOS inbox and prints, for verdict/review/provenance,
# each v1 note's summary line and its parsed Queen-* trailers. Exit 0 even if there is no note yet.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$here/_lib.sh"

case "${1:-}" in -h|--help) sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; esac
require_git_repo
sha=$(resolve_sha "${1:-HEAD}")
fetch_notes

found=0
for ref in verdict review provenance; do
  body=$(note_for "$ref" "$sha")
  [ -n "$body" ] || continue
  # Only parse v1 notes (never the Queen's internal ledger or anything else).
  printf '%s\n' "$body" | grep -qi '^[[:space:]]*Queen-Note:[[:space:]]*v1' || continue
  found=1
  printf '== refs/notes/%s  %s\n' "$ref" "$sha"
  # Summary = first non-empty line; trailers = lines starting with Queen (case-insensitive).
  printf '%s\n' "$body" | awk '
    !seen && NF { print "summary: " $0; seen=1; next }
    tolower($0) ~ /^[ \t]*queen(-[a-z-]+)?[ \t]*:/ { sub(/^[ \t]+/, ""); print }'
done
[ "$found" -eq 1 ] || printf 'no notes yet for %s (verdicts take ~1.5-3 min after push)\n' "$sha"

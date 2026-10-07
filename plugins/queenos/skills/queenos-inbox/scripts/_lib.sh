# Shared helpers for the queenos-inbox scripts. Sourced, not executed. POSIX sh.
# Never prints QUEENOS_TOKEN. Credentials come from the environment:
#   QUEENOS_REMOTE  inbox remote URL (https://...artifacts.cloudflare.net/git/<ns>/<hive>-in-<handle>.git)
#   QUEENOS_TOKEN   write token (a trailing "?expires=..." is stripped)
# Alternative: a git remote named "queen" (or $QUEENOS_GIT_REMOTE) with your own credential helper.

die() { printf 'queenos: %s\n' "$*" >&2; exit 2; }

require_git_repo() {
  git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"
}

# resolve_sha <rev>: prints the full commit sha.
resolve_sha() {
  git rev-parse --verify --quiet "$1^{commit}" 2>/dev/null || die "cannot resolve '$1' to a commit"
}

# fetch_notes: force-fetch all notes from the queen remote (the remote is authoritative).
# The token travels via GIT_CONFIG_* env vars, never argv or the URL, and is scoped to the remote URL.
fetch_notes() {
  if [ -n "${QUEENOS_REMOTE:-}" ]; then
    [ -n "${QUEENOS_TOKEN:-}" ] || die "QUEENOS_REMOTE is set but QUEENOS_TOKEN is not"
    _tok=${QUEENOS_TOKEN%%\?expires=*}
    _b64=$(printf 'queen:%s' "$_tok" | base64 | tr -d '\n')
    GIT_CONFIG_COUNT=1
    GIT_CONFIG_KEY_0="http.${QUEENOS_REMOTE}.extraHeader"
    GIT_CONFIG_VALUE_0="Authorization: Basic ${_b64}"
    export GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
    _src=$QUEENOS_REMOTE
  else
    _src=${QUEENOS_GIT_REMOTE:-queen}
    git remote get-url "$_src" >/dev/null 2>&1 \
      || die "set QUEENOS_REMOTE and QUEENOS_TOKEN, or add a git remote named '$_src'"
  fi
  GIT_TERMINAL_PROMPT=0 git fetch --quiet --no-tags "$_src" '+refs/notes/*:refs/notes/*' \
    || die "fetching notes failed (expired token? inbox not deployed yet? try again later)"
}

# note_for <ref-name> <sha>: prints the note body, or nothing.
note_for() {
  git notes --ref="$1" show "$2" 2>/dev/null || true
}

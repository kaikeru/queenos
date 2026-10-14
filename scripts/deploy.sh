#!/usr/bin/env bash
# Deploy QueenOS to Cloudflare.
#
#   scripts/deploy.sh                 deploy everything (bootstrap pass first if any Worker is missing)
#   scripts/deploy.sh --bootstrap     force the bootstrap pass
#   scripts/deploy.sh --dry-run       build every bundle to .deploy-dryrun/, deploy nothing
#   scripts/deploy.sh --only edge     run only the named Worker (apps/ dir name) in the full pass
#   scripts/deploy.sh --force         skip the in-flight v1 train check before deploying the Queen
#
# Site settings live in deploy.env at the repo root (gitignored; copy deploy.env.example):
#   QUEENOS_HOST, QUEENOS_ACCESS_TEAM, QUEENOS_ALLOWED_EMAIL_DOMAINS, QUEENOS_ACCESS_AUD and
#   CLOUDFLARE_ACCOUNT_ID. The edge's wrangler.jsonc ships with these empty; the script
#   deploys the edge from a temp copy with them filled in (custom domain route + vars).
#
# v2 safety check (design §7, R16): the Queen's v11 migration must not run while
# v1 trains are in flight (v1 successors chain on their predecessors; v2 builds
# fork from main). Before deploying the Queen, the script reads every hive's
# snapshot through the edge and refuses if a v1 Queen (no `items` in its
# snapshot) has any train that is not MERGED or EJECTED. Once the deployed
# Queen is v2 the check passes. It needs read access through Cloudflare Access:
#   CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET (an Access service token allowed
#   on the QueenOS app), or CF_ACCESS_TOKEN (a `cf-access-token`, e.g. from
#   `cloudflared access token -app=https://<your-host>`).
#   Set QUEENOS_URL to your deployment (https://<your-host>); QUEENOS_HIVES="demo pulse"
#   skips the project listing. The check is skipped on a first deploy (no Queen yet).
#   Without credentials or QUEENOS_URL it refuses; pass --force after checking the
#   War Room yourself.
#
# Why two passes: the Workers bind to each other in cycles (queen <-> executors,
# genesis <-> provisioner, edge <-> mcp, edge -> everything). Wrangler rejects a cross-script
# binding to a script that does not exist yet (code 10061, docs/day1-results.md 9b).
#   Pass 1 (bootstrap): every Worker is deployed with its cross-script bindings
#     stripped (durable_objects/workflows with `script_name`, and all `services`)
#     via a temp config; own DOs, workflows and migrations are kept.
#   Pass 2: every Worker is deployed with its full config.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Wrangler and Vite need the Node in .nvmrc. nvm is a shell function, so load it here;
# nvm.sh is not safe under `set -eu`.
if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  set +eu
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  nvm use >/dev/null || nvm install >/dev/null
  set -eu
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt "$(cut -d. -f1 .nvmrc)" ]; then
  echo "Node $(node -v) is too old; .nvmrc wants $(cat .nvmrc). Install nvm or switch Node, then re-run." >&2
  exit 1
fi

DRY_RUN=0
BOOTSTRAP=0
FORCE=0
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --bootstrap) BOOTSTRAP=1 ;;
    --only) shift; ONLY="${1:?--only needs a value}" ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n "2,35p" "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ -f "$ROOT/deploy.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/deploy.env"
  set +a
fi
QUEENOS_URL="${QUEENOS_URL:-${QUEENOS_HOST:+https://$QUEENOS_HOST}}"

OUTROOT="${DEPLOY_DRYRUN_DIR:-$ROOT/.deploy-dryrun}"
TMP_CFG_NAME=".wrangler.bootstrap.jsonc"
SITE_CFG_NAME=".wrangler.site.jsonc"

# dir:script-name. The edge is last: it needs the dashboard bundle, and its GIT and
# MCP service bindings need queenos-git and queenos-mcp to exist (so those go just
# before it). git and mcp bind the Queen DO cross-script; mcp also binds the edge's
# HiveRegistry (a cycle). The bootstrap pass strips those script_name bindings.
# A first deploy of any Worker takes the bootstrap pass.
WORKERS=(
  "queen:queen"
  "provisioner:queenos-provisioner"
  "herald:queenos-herald"
  "sentinel:queenos-sentinel"
  "oracle:queenos-oracle"
  "drones:queenos-drones"
  "gatekeepers:queenos-gatekeepers"
  "vault:queenos-vault"
  "genesis:queenos-genesis"
  "git:queenos-git"
  "mcp:queenos-mcp"
  "edge:queenos-edge"
)

cleanup() { for w in "${WORKERS[@]}"; do rm -f "$ROOT/apps/${w%%:*}/$TMP_CFG_NAME" "$ROOT/apps/${w%%:*}/$SITE_CFG_NAME"; done; }
trap cleanup EXIT

want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

# The edge needs the site settings; refuse before deploying anything if they are missing.
if [ "$DRY_RUN" = 0 ] && want edge; then
  missing=""
  for v in QUEENOS_HOST QUEENOS_ACCESS_TEAM QUEENOS_ALLOWED_EMAIL_DOMAINS; do
    [ -n "${!v:-}" ] || missing="$missing $v"
  done
  if [ -n "$missing" ]; then
    echo "Missing site settings:$missing. Copy deploy.env.example to deploy.env and fill it in." >&2
    exit 1
  fi
fi

prepare() {
  case "$1" in
    provisioner) echo "==> generating provisioner templates"; pnpm --filter @queenos/provisioner run gen ;;
    edge)
      if [ "${SKIP_DASHBOARD_BUILD:-0}" = 1 ]; then
        echo "==> skipping the dashboard build (SKIP_DASHBOARD_BUILD=1); using apps/dashboard/dist as is"
      else
        echo "==> building the dashboard"
        pnpm --filter @queenos/dashboard build
      fi ;;
  esac
}

# deploy_app <dir> <label> [extra wrangler args...]
deploy_app() {
  local app="$1" label="$2"; shift 2
  local args=(deploy --env="")
  if [ "$DRY_RUN" = 1 ]; then args+=(--dry-run --outdir "$OUTROOT/$label/$app"); fi
  echo "==> [$label] wrangler ${args[*]} $* (apps/$app)"
  (cd "$ROOT/apps/$app" && pnpm exec wrangler "${args[@]}" "$@")
}

# write_config <dir> <out name> <strip: 0|1>: a copy of apps/<dir>/wrangler.jsonc, with
# cross-script bindings removed when strip=1, and the site settings filled in for the edge.
write_config() {
  local dir="$1" name="$2" strip="$3"
  node - "$ROOT/apps/$dir/wrangler.jsonc" "$ROOT/apps/$dir/$name" "$dir" "$strip" <<'NODE'
const fs = require("node:fs");
const [src, dst, dir, strip] = process.argv.slice(2);
// Strip // and /* */ comments and trailing commas, outside of strings.
function parseJsonc(text) {
  let out = "", inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inStr = false;
    } else if (c === '"') { inStr = true; out += c; }
    else if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; }
    else if (c === "/" && n === "*") { i += 2; while (!(text[i] === "*" && text[i + 1] === "/")) i++; i++; }
    else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}
const cfg = parseJsonc(fs.readFileSync(src, "utf8"));
if (strip === "1") {
  if (cfg.durable_objects?.bindings) {
    cfg.durable_objects.bindings = cfg.durable_objects.bindings.filter((b) => !b.script_name);
  }
  if (cfg.workflows) cfg.workflows = cfg.workflows.filter((w) => !w.script_name);
  delete cfg.services;
}
if (dir === "edge") {
  const e = process.env;
  if (e.QUEENOS_HOST) cfg.routes = [{ pattern: e.QUEENOS_HOST, custom_domain: true }];
  Object.assign((cfg.vars ??= {}), {
    ACCESS_TEAM: e.QUEENOS_ACCESS_TEAM ?? "",
    ALLOWED_EMAIL_DOMAINS: e.QUEENOS_ALLOWED_EMAIL_DOMAINS ?? "",
    ACCESS_AUD: e.QUEENOS_ACCESS_AUD ?? "",
    ACCOUNT_ID: e.CLOUDFLARE_ACCOUNT_ID ?? "",
  });
}
fs.writeFileSync(dst, JSON.stringify(cfg, null, 2));
NODE
}

script_exists() {
  # `deployments list` fails for a script that has never been deployed.
  (cd "$ROOT/apps/$1" && pnpm exec wrangler deployments list --name "$2" >/dev/null 2>&1)
}

# R16: refuse to deploy the Queen while a v1 Queen has trains in flight.
check_no_v1_trains() {
  local base="${QUEENOS_URL:-}"
  if [ -z "$base" ]; then
    echo "==> R16 check: set QUEENOS_URL=https://<your-host> (plus Access credentials) to read hive snapshots." >&2
    return 1
  fi
  local -a auth=()
  if [ -n "${CF_ACCESS_CLIENT_ID:-}" ] && [ -n "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
    auth=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
  elif [ -n "${CF_ACCESS_TOKEN:-}" ]; then
    auth=(-H "cf-access-token: $CF_ACCESS_TOKEN")
  else
    echo "==> R16 check: no Access credentials (CF_ACCESS_CLIENT_ID/SECRET or CF_ACCESS_TOKEN) to read hive snapshots." >&2
    echo "    Check the War Room for trains that are not MERGED/EJECTED, then re-run with --force." >&2
    return 1
  fi
  local hives="${QUEENOS_HIVES:-}"
  if [ -z "$hives" ]; then
    hives="$(curl -fsS --max-time 20 "${auth[@]}" "$base/api/projects" | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try { const list = JSON.parse(s); console.log((Array.isArray(list) ? list : []).map((p) => p.hive).join(" ")); }
        catch { process.exit(1); } // not JSON: an Access login page, most likely
      });')" || { echo "==> R16 check: could not list projects at $base/api/projects" >&2; return 1; }
  fi
  local busy=0 h
  for h in $hives; do
    local verdict
    verdict="$(curl -fsS --max-time 20 "${auth[@]}" "$base/hives/$h/snapshot" | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        let snap; try { snap = JSON.parse(s); } catch { process.exit(1); }
        if (Array.isArray(snap.items)) { console.log("v2"); return; }
        const active = (snap.trains ?? []).filter((t) => t.phase !== "MERGED" && t.phase !== "EJECTED");
        console.log(active.length ? `active ${active.map((t) => `${t.trainId.slice(0, 8)}:${t.phase}`).join(",")}` : "idle");
      });')" || { echo "==> R16 check: could not read $base/hives/$h/snapshot" >&2; return 1; }
    case "$verdict" in
      active*) echo "==> R16: hive $h has v1 trains in flight (${verdict#active }); wait for them to land or eject." >&2; busy=1 ;;
      *) echo "==> R16: hive $h is $verdict" ;;
    esac
  done
  [ "$busy" = 0 ]
}

if [ "$DRY_RUN" = 0 ] && [ "$FORCE" = 0 ] && want queen && script_exists queen queen; then
  if ! check_no_v1_trains; then
    echo "Refusing to deploy the Queen (risk R16). Use --force to override." >&2
    exit 1
  fi
fi

if [ "$DRY_RUN" = 1 ]; then rm -rf "$OUTROOT"; mkdir -p "$OUTROOT"; fi

# ---- Pass 1: bootstrap (cross-script bindings stripped) ----
if [ "$DRY_RUN" = 0 ] && [ "$BOOTSTRAP" = 0 ]; then
  for w in "${WORKERS[@]}"; do
    if ! script_exists "${w%%:*}" "${w##*:}"; then
      echo "==> ${w##*:} is not deployed yet: bootstrap pass needed"
      BOOTSTRAP=1
    fi
  done
fi

if [ "$BOOTSTRAP" = 1 ]; then
  echo "==> PASS 1: bootstrap, cross-script bindings stripped"
  for w in "${WORKERS[@]}"; do
    dir="${w%%:*}"
    if want "$dir"; then
      prepare "$dir"
      write_config "$dir" "$TMP_CFG_NAME" 1
      deploy_app "$dir" bootstrap --config "$ROOT/apps/$dir/$TMP_CFG_NAME"
      rm -f "$ROOT/apps/$dir/$TMP_CFG_NAME"
    fi
  done
fi

# ---- Pass 2: full configs ----
echo "==> PASS 2: full configs"
for w in "${WORKERS[@]}"; do
  dir="${w%%:*}"
  if want "$dir"; then
    prepare "$dir"
    if [ "$dir" = edge ]; then
      write_config edge "$SITE_CFG_NAME" 0
      deploy_app edge full --config "$ROOT/apps/edge/$SITE_CFG_NAME"
      rm -f "$ROOT/apps/edge/$SITE_CFG_NAME"
    else
      deploy_app "$dir" full
    fi
  fi
done

if [ "$DRY_RUN" = 1 ]; then
  echo "Dry run complete. Bundles are in $OUTROOT"
  exit 0
fi

cat <<'MSG'

Deploy finished. One-time manual steps (first deploy only). <host> is QUEENOS_HOST and
<team> is QUEENOS_ACCESS_TEAM from deploy.env.

  1. Cloudflare Zero Trust (team: <team>) > Access > Applications > Add > Self-hosted.
     Create THREE applications:
       a. Main app: domain <host>, all paths. Policy: Allow, your emails (or your email
          domain). This is the dashboard and /api.
       b. <host>/git with a Bypass policy (Everyone). The edge checks `qgt_` git tokens
          itself on /git/*.
       c. <host>/mcp with a Bypass policy (Everyone). The edge checks the Bearer `qgt_`
          token itself on /mcp.
     Without (b) and (c), git clients and MCP clients are stopped by the Access login page.
  2. Copy the main app's "Application Audience (AUD) Tag" into QUEENOS_ACCESS_AUD in
     deploy.env, then redeploy the edge:
       scripts/deploy.sh --only edge
     (until then the edge fails closed with 503 on every route except /health).
  3. Vault key-encryption key (once):
       openssl rand -base64 32 | pnpm --filter @queenos/vault exec wrangler secret put VAULT_KEK --env=""
  4. Queen machine token (once):
       openssl rand -hex 32 | pnpm --filter @queenos/queen exec wrangler secret put QUEEN_INTERNAL_TOKEN --env=""
  5. Vectorize metadata index the Oracle's dedupe filters on (once):
       pnpm --filter @queenos/oracle exec wrangler vectorize create-metadata-index queenos-memory --property-name=kind --type=string
     Optional: the edge's Analytics Engine read token (Account Analytics Read), for the Metrics page:
       pnpm --filter @queenos/edge exec wrangler secret put ANALYTICS_API_TOKEN --env=""
  6. Open https://<host>, sign in, create a hive.
MSG

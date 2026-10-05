#!/usr/bin/env bash
# Deploy QueenOS to Cloudflare.
#
#   scripts/deploy.sh                 deploy everything (bootstrap pass first if any Worker is missing)
#   scripts/deploy.sh --bootstrap     force the bootstrap pass
#   scripts/deploy.sh --dry-run       build every bundle to .deploy-dryrun/, deploy nothing
#   scripts/deploy.sh --only edge     run only the named Worker (apps/ dir name) in the full pass
#
# Why two passes: the Workers bind to each other in cycles (queen <-> executors,
# genesis <-> provisioner, edge -> everything). Wrangler rejects a cross-script
# binding to a script that does not exist yet (code 10061, docs/day1-results.md 9b).
#   Pass 1 (bootstrap): every Worker is deployed with its cross-script bindings
#     stripped (durable_objects/workflows with `script_name`, and all `services`)
#     via a temp config; own DOs, workflows and migrations are kept.
#   Pass 2: every Worker is deployed with its full config.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DRY_RUN=0
BOOTSTRAP=0
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --bootstrap) BOOTSTRAP=1 ;;
    --only) shift; ONLY="${1:?--only needs a value}" ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

OUTROOT="${DEPLOY_DRYRUN_DIR:-$ROOT/.deploy-dryrun}"
TMP_CFG_NAME=".wrangler.bootstrap.jsonc"

# dir:script-name. The edge is last: it needs the dashboard bundle.
WORKERS=(
  "queen:queen"
  "provisioner:queenos-provisioner"
  "herald:queenos-herald"
  "sentinel:queenos-sentinel"
  "drones:queenos-drones"
  "gatekeepers:queenos-gatekeepers"
  "vault:queenos-vault"
  "genesis:queenos-genesis"
  "edge:queenos-edge"
)

cleanup() { for w in "${WORKERS[@]}"; do rm -f "$ROOT/apps/${w%%:*}/$TMP_CFG_NAME"; done; }
trap cleanup EXIT

want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

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

# Write a copy of apps/<dir>/wrangler.jsonc with cross-script bindings removed.
write_stripped_config() {
  local dir="$1"
  node - "$ROOT/apps/$dir/wrangler.jsonc" "$ROOT/apps/$dir/$TMP_CFG_NAME" <<'NODE'
const fs = require("node:fs");
const [src, dst] = process.argv.slice(2);
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
if (cfg.durable_objects?.bindings) {
  cfg.durable_objects.bindings = cfg.durable_objects.bindings.filter((b) => !b.script_name);
}
if (cfg.workflows) cfg.workflows = cfg.workflows.filter((w) => !w.script_name);
delete cfg.services;
fs.writeFileSync(dst, JSON.stringify(cfg, null, 2));
NODE
}

script_exists() {
  # `deployments list` fails for a script that has never been deployed.
  (cd "$ROOT/apps/$1" && pnpm exec wrangler deployments list --name "$2" >/dev/null 2>&1)
}

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
      write_stripped_config "$dir"
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
    deploy_app "$dir" full
  fi
done

if [ "$DRY_RUN" = 1 ]; then
  echo "Dry run complete. Bundles are in $OUTROOT"
  exit 0
fi

cat <<'MSG'

Deploy finished. One-time manual steps (first deploy only):

  1. Cloudflare Zero Trust (team: kaikeru) > Access > Applications > Add > Self-hosted.
     Domain queenos.kaikeru.com, all paths. Policy: Allow, emails ending in @kaikeru.com.
  2. Copy the application's "Application Audience (AUD) Tag" into "ACCESS_AUD" in
     apps/edge/wrangler.jsonc, then redeploy the edge:
       pnpm --filter @queenos/edge deploy
     (until then the edge fails closed with 503 on every route except /health).
  3. Vault key-encryption key (once):
       openssl rand -base64 32 | pnpm --filter @queenos/vault exec wrangler secret put VAULT_KEK --env=""
  4. Queen machine token (once):
       openssl rand -hex 32 | pnpm --filter @queenos/queen exec wrangler secret put QUEEN_INTERNAL_TOKEN --env=""
  5. Open https://queenos.kaikeru.com and sign in.
MSG

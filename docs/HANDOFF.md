# QueenOS: session handoff

Last updated **2026-10-05** by the coordinating Claude session. Read this, then `CLAUDE.md` and `README.md`, before doing anything.

## What this is
QueenOS is an entry for Cloudflare's "next Git platform" challenge (https://blog.cloudflare.com/next-git-platform-on-cloudflare/), **due 2026-10-14**. Submissions need a 5–10 minute video, an OSS license (MIT; done), and run instructions.
- **The pitch:** an OS for agent swarms, not a GitHub clone.
- **The judges want** multiple agents working on changes concurrently.
- **The three questions it answers:**
  - Awareness: the Queen DO is the single source of truth, plus the Cognitive Ledger.
  - Conflicts: the speculative merge train.
  - Review: gatekeepers, the LLM reviewer, the Scribe, and Sentinel.

**Live:** https://queenos.kaikeru.com, behind Cloudflare Access (team `kaikeru`, `@kaikeru.com` emails, one-time-PIN login). The demo hive is `demo`; its prod is https://demo-app.kyle-477.workers.dev and staging is https://demo-staging.kyle-477.workers.dev.

## How the user wants us to work
- **Orchestrate.** Dispatch right-sized subagents (Opus for research and subtle core logic, Sonnet for implementation, Haiku for trivial work). Verify their work yourself before reporting. See memory `orchestration-style`.
- **Before parallel dispatch:** write the shared contract in `packages/queen-types` first, give agents disjoint file ownership, and keep the lockfile with one writer (pre-install deps yourself).
- **Always verify** with `pnpm turbo run build typecheck lint test --force --continue` (**40/40 tasks** green at handoff). Use **Node 24**: `export PATH=~/.nvm/versions/node/v24.17.0/bin:$PATH`, because wrangler needs ≥22.
- **Commit** after each verified milestone; there's no remote, so never push. End messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Before committing, scan for the token: `grep -rlF -- "$CLOUDFLARE_API_TOKEN" --exclude-dir=node_modules --exclude-dir=.wrangler --exclude-dir=.git .`
- **Prefer Cloudflare-native tech** ("a boon"), and keep things simple. The user makes product calls fast; give a recommendation, not a menu.
- **The Queen is an orchestrator ONLY.** It decides, records and dispatches; executors do all external I/O.

## Architecture (10 Workers, all deployed)
| Worker (dir) | Role |
|---|---|
| `queen` (apps/queen) | `QueenNode` DO per hive: SQLite state, merge-train planner, release planner, **model router** (AIMD tier floor), watchdog; WS room. Only reachable through the edge. `sim` env = local fakes (localhost-only). |
| `queenos-edge` (apps/edge) | The `queenos.kaikeru.com` front door: Access JWT verification, dashboard static assets, `/api/*` and `/hives/*` routing, the `HiveRegistry` DO. `dev` env = auth bypass (localhost-only). |
| `queenos-provisioner` | Workflow: Artifacts fork/delete; CREATE_HIVE seeds a repo from `templates/worker-starter`. |
| `queenos-drones` | Workflow: BUILD/REWORK/LAND. Live LLM on the Queen's `modelChoice` + fallbacks. **Being replaced: see "In flight".** |
| `queenos-gatekeepers` | Workflow on `cf.artifacts.repo.pushed`: policy/security scans, preview smoke, **LLM reviewer** (intent check), Scribe, Vectorize failure log. |
| `queenos-herald` | Workflow: Worker Preview per train, `<hive>-staging`, canary splits on `<hive>-app`, rollback. Credentials come from the Vault. |
| `queenos-sentinel` | Workflow: readiness gate, then synthetic probes pinned per version, then a PROMOTE/ROLLBACK verdict. |
| `queenos-vault` | Per-hive AES-GCM envelope-encrypted creds. `VaultWriter` (edge) / `VaultReader` (herald) entrypoints. |
| `queenos-genesis` | The onboarding wizard DO: chat → charter → connect Cloudflare → CREATE_HIVE → first flight. |
| dashboard (apps/dashboard) | The React War Room: lanes, release timeline, tap-to-ship, Sites panel, Model Board. Served by the edge. |

**Packages:**
- `queen-types`: all contracts (onboarding, executors, releases, models, telemetry).
- `hive-kit`: isomorphic-git + memfs, the binding-based AI client, the Cloudflare REST client, the ledger.

**Flow:** prompt → Queen plans a speculative train → Provisioner fork → drone build+push (git note = Cognitive Ledger) → Herald preview → push event → gatekeepers (scans, smoke, reviewer) → Queen → lander drone pushes main → release: staging → Sentinel → AWAITING_TAP → human taps → canary 1/10/50/100 with Sentinel each step → SHIPPED, or auto-rollback.

## Account and infra facts (no secrets here)
- **Account:** `4773fbabdff038e3b907b14cd212c062`, workers.dev subdomain `kyle-477`. `CLOUDFLARE_API_TOKEN` (account-owned) is in the user's shell. Set `CLOUDFLARE_ACCOUNT_ID` for wrangler. Verify via `/accounts/{id}/tokens/verify`.
- **Access:** app "QueenOS" (id `798aa993-…`); its AUD is in `apps/edge/wrangler.jsonc`. The Zero Trust team was renamed from modernmythtools to kaikeru at the user's request.
- **AI:** gateway `queenos` (authenticated); all LLM calls use the Workers `ai` binding, so there are no tokens. Models come from `MODEL_CATALOG` in `packages/queen-types/src/models.ts`, all Workers AI `@cf/…`, ordered by `docs/model-bakeoff.md`. The user chose gateway models over Anthropic.
- **Other resources:** Vectorize index `queenos-failures` (768, cosine); Artifacts namespace `queenos`.
- **Secrets set:** `VAULT_KEK` (backup at `~/.queenos/vault-kek.backup`; the user was asked to move it to a password manager) and `QUEEN_INTERNAL_TOKEN`.
- **Deploy:** `./scripts/deploy.sh`, two passes because cross-script bindings form cycles. For a single NEW worker, deploy it alone first with `wrangler deploy --env=""` to avoid the bootstrap pass. Executors and most Workers have `workers_dev:false`.
- **Monitoring:** Workflow instances via `GET /accounts/{id}/workflows/<name>/instances` (names: `drone-workflow`, `herald-workflow`, `sentinel-workflow`, `gatekeeper-workflow`, `provisioner-workflow`). Step outputs are truncated in that API.

## State at handoff
- **Proven live on `demo`:** Genesis wizard; scripted and live-LLM builds through preview, gate, land; a release with tap-to-ship and a full canary (1→100%, 0 errors) that SHIPPED.
- **The first live-LLM build** passed the gate but missed the intent: it made a `/features/<slug>` HTML page instead of changing `/`. That's why the reviewer was added, and why the harness is being rebuilt.
- **A release is AWAITING_TAP on `demo`.** It holds that intent-miss build. The user was advised not to tap it.

## In flight (check first)
**The drone coding harness rebuild runs in a separate Herdr pane:** agent name `harness`, pane `w9:p4`, Claude on Opus.
- **Brief:** `docs/harness-build-brief.md`; **spike memo:** `docs/harness-spike.md`. It will write `docs/harness-design.md`.
- **Plan:** keep the drone Workflow; replace the single-shot "generate" step with a `@cloudflare/think` agent (one DO per build: read/edit/list/find/grep tools), plus our `verify` (runs the edited Worker in a **Dynamic Worker** via Worker Loader and fetches `/`, `/health`) and `finish`. Exclude Qwen from the tool loop. Let template features declare their own `path`.
- **Target:** proven on `demo` by **Oct 8**.
- **Check status:** `herdr agent get harness`, `herdr agent read harness --source recent-unwrapped --lines 80`. It may block on permission prompts in its pane; the user can approve there.
- **The harness agent owns:** apps/drones, hive-kit AI/git helpers, `templates/`, provisioner templates. Changes to `queen-types`/`apps/queen` go through the coordinator.

## Roadmap to Oct 14
1. **Oct 6–8:** harness (above), then a live proof: "Change our status page at / from JSON to a nice HTML page; keep /health" → reviewer APPROVES → lands → release.
2. **Oct 9–10:** close the Cognitive Ledger memory loop. Index git-note ledgers + Scribe summaries in Vectorize, recall them into the drone's context (`DroneTask.ragContext` exists but is always `[]`), and show "recalled memories" in the War Room.
3. **Oct 11:** buffer and polish:
   - the Model Board says "0/3 clean builds to back off" even at the fast floor (it can't back off further);
   - the router's `SLOW_MODEL_HINTS` could become a catalog field;
   - optional custom domains for project sites.
4. **Oct 12–13:** a reliable demo script (sim mode + live), the 5–10 minute video, a README refresh with screenshots, a check that the clean-clone quickstart works.
5. **Dropped or stubbed:** bisect + auto-revert on staging failure (the hook is `stagingFailed()` in the release planner), and real npm builds (`@cloudflare/worker-bundler` works per the spike, but is deferred).

## Known gaps and gotchas
- **Live latency:** builds take 40–220s, and the drone generation budget is 200s. The watchdog is 10 min.
- **Templates:** the no-build template only serves features at `/features/<slug>` until the harness adds `path`.
- **Sentinel** uses synthetic probes only. With little traffic on demo apps, that's the real signal.
- **Pinned preview URLs** (`<8hex>-<worker>…`) outlive teardown (a Cloudflare behavior). Herald reports alias URLs instead.
- **A failed first prod deploy** stays FAILED while the candidate serves 100% (there's no stable version to roll back to). The summary says so.
- **Dashboard tabs** opened before a deploy show an "updated, reload" banner on new message types.
- **Chrome automation:** clicks via `find` refs sometimes don't register; coordinates work.
- **Test flakiness:** the full parallel test run is heavy; the Queen tests have a 20s timeout for cold starts.

## Key docs
`README.md` (judge-facing), `CLAUDE.md` (rules), `docs/discovery.md` + `docs/deploy-discovery.md` (API research), `docs/day1-results.md` (real-account facts), `docs/model-bakeoff.md`, `docs/harness-spike.md`, `docs/harness-build-brief.md`, `apps/queen/README.md` (planner, router, release semantics).

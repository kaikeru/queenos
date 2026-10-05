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
- **Orchestrate.** The coordinator NEVER edits code or docs itself. Every change goes to a right-sized subagent (Opus for research and subtle core logic, Sonnet for implementation, Haiku for trivial work). The coordinator reads, verifies, commits and coordinates. See memory `orchestration-style`.
- **Before parallel dispatch:** write the shared contract in `packages/queen-types` first, give agents disjoint file ownership, and keep the lockfile with one writer (pre-install deps yourself).
- **Always verify** with `pnpm turbo run build typecheck lint test --force --continue` (**40/40 tasks** green at handoff). Use **Node 24**: `export PATH=~/.nvm/versions/node/v24.17.0/bin:$PATH`, because wrangler needs ≥22.
- **Commit AND push** `main` after each verified milestone. The remote is `origin` = github.com/kaikeru/queenos. The user files GitHub issues for things they find; reference them in commits (`Closes #n` / `Refs #n`). The roadmap stays the priority over the issue backlog. End messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Before committing, scan for the token: `/usr/bin/grep -rlF --exclude-dir=node_modules --exclude-dir=.wrangler --exclude-dir=.git -e "$CLOUDFLARE_API_TOKEN" .` (exit 1 means clean; `grep` is aliased to ugrep in this shell, and a `--` before the excludes makes grep read them as filenames)
- **Prefer Cloudflare-native tech** ("a boon"), and keep things simple. The user makes product calls fast; give a recommendation, not a menu.
- **The Queen is an orchestrator ONLY.** It decides, records and dispatches; executors do all external I/O.

## Architecture (10 Workers, all deployed)
| Worker (dir) | Role |
|---|---|
| `queen` (apps/queen) | `QueenNode` DO per hive: SQLite state, merge-train planner, release planner, **model router** (AIMD tier floor), watchdog; WS room. Only reachable through the edge. `sim` env = local fakes (localhost-only). |
| `queenos-edge` (apps/edge) | The `queenos.kaikeru.com` front door: Access JWT verification, dashboard static assets, `/api/*` and `/hives/*` routing, the `HiveRegistry` DO. `dev` env = auth bypass (localhost-only). |
| `queenos-provisioner` | Workflow: Artifacts fork/delete; CREATE_HIVE seeds a repo from `templates/worker-starter`. On FORK, recalls hive memories ("memory: recall"). Bindings: AI + MEMORY. |
| `queenos-drones` | Workflow: BUILD/REWORK/LAND. Live LLM on the Queen's `modelChoice` + fallbacks. Builder is a Think tool-loop agent (live; see `docs/harness-design.md`). |
| `queenos-gatekeepers` | Workflow on `cf.artifacts.repo.pushed`: policy/security scans, preview smoke, **LLM reviewer** (intent check), Scribe, Vectorize failure log, hive memory write ("memory: remember"; MEMORY binding). |
| `queenos-herald` | Workflow: Worker Preview per train, `<hive>-staging`, canary splits on `<hive>-app`, rollback. Credentials come from the Vault. |
| `queenos-sentinel` | Workflow: readiness gate, then synthetic probes pinned per version, then a PROMOTE/ROLLBACK verdict. |
| `queenos-vault` | Per-hive AES-GCM envelope-encrypted creds. `VaultWriter` (edge) / `VaultReader` (herald) entrypoints. |
| `queenos-genesis` | The onboarding wizard DO: chat → charter → connect Cloudflare → CREATE_HIVE → first flight. |
| dashboard (apps/dashboard) | The React War Room: lanes, release timeline, tap-to-ship, Sites panel, Model Board. Served by the edge. |

**Packages:**
- `queen-types`: all contracts (onboarding, executors, releases, models, telemetry).
- `hive-kit`: isomorphic-git + memfs, the binding-based AI client, the Cloudflare REST client, the ledger, `HiveMemory` (`src/memory.ts`, the shared Vectorize memory client).

**Flow:** prompt → Queen plans a speculative train → Provisioner fork (recalls memories) → drone build+push (git note = Cognitive Ledger) → Herald preview → push event → gatekeepers (scans, smoke, reviewer, remember verdict) → Queen → lander drone pushes main → release: staging → Sentinel → AWAITING_TAP → human taps → canary 1/10/50/100 with Sentinel each step → SHIPPED, or auto-rollback.

## Account and infra facts (no secrets here)
- **Account:** `4773fbabdff038e3b907b14cd212c062`, workers.dev subdomain `kyle-477`. `CLOUDFLARE_API_TOKEN` (account-owned) is in the user's shell. Set `CLOUDFLARE_ACCOUNT_ID` for wrangler. Verify via `/accounts/{id}/tokens/verify`.
- **Access:** app "QueenOS" (id `798aa993-…`); its AUD is in `apps/edge/wrangler.jsonc`. The Zero Trust team was renamed from modernmythtools to kaikeru at the user's request.
- **AI:** gateway `queenos` (authenticated); all LLM calls use the Workers `ai` binding, so there are no tokens. Models come from `MODEL_CATALOG` in `packages/queen-types/src/models.ts`, all Workers AI `@cf/…`, ordered by `docs/model-bakeoff.md`. The user chose gateway models over Anthropic.
- **Other resources:** Vectorize indexes `queenos-failures` (768, cosine) and `queenos-memory` (768, cosine, metadata index on `namespace`); Artifacts namespace `queenos`.
- **Secrets set:** `VAULT_KEK` (backup at `~/.queenos/vault-kek.backup`; the user was asked to move it to a password manager) and `QUEEN_INTERNAL_TOKEN`.
- **Deploy:** `./scripts/deploy.sh`, two passes because cross-script bindings form cycles. For a single NEW worker, deploy it alone first with `wrangler deploy --env=""` to avoid the bootstrap pass. To redeploy one existing Worker: `./scripts/deploy.sh --only <dir>` (its "one-time manual steps" footer prints every time; ignore it). Auto mode blocks production deploys from Claude, so the user runs them: write the commands in a scratchpad script (long pasted lines wrap and break). Executors and most Workers have `workers_dev:false`.
- **Monitoring:** Workflow instances via `GET /accounts/{id}/workflows/<name>/instances` (names: `drone-workflow`, `herald-workflow`, `sentinel-workflow`, `gatekeeper-workflow`, `provisioner-workflow`). Step outputs are truncated in that API.

## State at handoff
- **Proven live on `demo`:** Genesis wizard; scripted and live-LLM builds through preview, gate, land; a release with tap-to-ship and a full canary (1→100%, 0 errors) that SHIPPED.
- **The first live-LLM build** passed the gate but missed the intent: it made a `/features/<slug>` HTML page instead of changing `/`. That's why the reviewer was added, and why the harness was rebuilt.
- **Hive memory (Cognitive Ledger memory loop): DONE, proven live on `demo`.**
  - **Write:** gatekeepers write one memory per gate verdict (PASSED / FAILED / REJECTED_BY_REVIEW; text = prompt, changed files, the builder's ledger reasoning, verdict) to Vectorize `queenos-memory`, in a best-effort step "memory: remember". No memory on gate infra failure.
  - **Recall:** on each FORK the Provisioner recalls up to 5 memories (cosine ≥ 0.6, same hive, excluding its own train) in a best-effort "memory: recall" step and returns them in its `ProvisionResult`.
  - **Use:** the Queen stores them on the train (`merge_trains.memories`, migration v7) and passes them to the builder as `DroneTask.ragContext` ("[OUTCOME] text" strings, BUILD and REWORK). The War Room lane shows a "🧠 N memories recalled" chip that expands into cards.
  - The Queen never touches Vectorize.
  - **Code:** contract `packages/queen-types/src/memory.ts`; client `HiveMemory` in `packages/hive-kit/src/memory.ts`.
  - **Live proof (2026-10-05, ~17:25–17:33):** train e2fbd08c ("Add a dark theme to the HTML status page at /") recalled 0, passed the gate, wrote memory `e2fbd08c-…:7e6c51a208be`. Train 33767423 (a dark/light/auto switch) recalled that memory (score 0.67), its drone's ragContext carried it, it passed and wrote its own memory.
  - **Gotcha:** Vectorize writes take up to ~1 min to become queryable, and `wrangler vectorize info` / `list-vectors` show stale counts (0). Use `get-vectors --ids`.
- **Release state:** the old AWAITING_TAP release on `demo` held the intent-miss build and may have been superseded by the new landings. Check the War Room before tapping.

## Deploy state
- Deployed ~17:20 with hive memory: queen, provisioner, gatekeepers, edge.
- Changed since and **pending user deploy of queen, drones, edge**: queen (catalog flags, sim auth), drones (catalog toolLoop), edge (UX batch). Script: scratchpad `deploy-polish.sh`.
- The Think builder is confirmed live in drones.

## In flight
Nothing in a separate pane: the harness agent's work is landed (e24c4de, f9a5c47, 69f0286). Design and spike: `docs/harness-design.md`, `docs/harness-spike.md`.

## Roadmap progress (2026-10-05)
- **Oct 11 polish done early:**
  - catalog `slow`/`toolLoop` flags replace SLOW_MODEL_HINTS / TOOL_LOOP_EXCLUDED (closes #4); builder/rework never route to Qwen 3.8, and first builds now go to DS V4 Flash;
  - the Model Board says "at the lowest tier" instead of an impossible back-off.
- **Quickstart:** one-command `pnpm dev:sim`, warnings silenced, expected results and curl checks in the README.
- **README refreshed:** the three questions, four review layers, full architecture mermaid, hive memory, Think builder.
- **`docs/demo-script.md` added:** a shot-by-shot 8-minute video plan, recording on a fresh Genesis hive `pulse`, with sim fallbacks.
- **Sim:** now has a REVIEWER that rejects `[review-fail]`; tap-to-ship works header-less on a localhost sim (`sim@localhost`).
- **War Room UX:** closes #3, #5, #9, #12; partial #7, #11.
- **Demo-script gaps still open:**
  - no reliable LIVE reviewer reject (the sim has one now);
  - the scripted `[fail]` runner names the marker in its Scribe summary;
  - the UI shows recalled memories but not whether the builder used them;
  - the SHIPPED banner has no prod link;
  - release timeline step labels overlap at 390px width;
  - the Model Board still lists Qwen 3.8 as "untried" though it's no longer routable for builds.

## Roadmap to Oct 14
1. **Oct 6–8:** ~~harness + live proof~~ **DONE early (2026-10-05).** The Think tool-loop builder is live, and the user ran the HTML status page proof on `demo`.
2. **Oct 9–10:** ~~close the Cognitive Ledger memory loop~~ **DONE early (2026-10-05).** Gate verdicts are remembered in Vectorize, recalled at fork into `DroneTask.ragContext`, and shown in the War Room (see "State at handoff").
3. **Oct 11:** buffer and polish: **done early** (see progress below); optional custom domains for project sites is not started (optional).
4. **Oct 12–13 (remaining):**
   - README screenshots plus an architecture slide (not started);
   - rehearsal on a throwaway hive, then recording per `docs/demo-script.md`;
   - the video (user).
5. **Dropped or stubbed:** bisect + auto-revert on staging failure (the hook is `stagingFailed()` in the release planner), and real npm builds (`@cloudflare/worker-bundler` works per the spike, but is deferred).

## Known gaps and gotchas
- **Live latency:** builds take 40–220s, and the drone generation budget is 200s. The watchdog is 10 min.
- **Templates:** the no-build template only serves features at `/features/<slug>` unless a feature declares its own `path` (supported since f9a5c47).
- **Sentinel** uses synthetic probes only. With little traffic on demo apps, that's the real signal.
- **Pinned preview URLs** (`<8hex>-<worker>…`) outlive teardown (a Cloudflare behavior). Herald reports alias URLs instead.
- **A failed first prod deploy** stays FAILED while the candidate serves 100% (there's no stable version to roll back to). The summary says so.
- **Dashboard tabs** opened before a deploy show an "updated, reload" banner on new message types.
- **Chrome automation:** clicks via `find` refs sometimes don't register; coordinates work.
- **Never `pkill -f vite` / `pkill -f wrangler`:** a subagent once did, killing every vitest/wrangler on the machine, other projects included. Agents kill only the PIDs they started. Parallel live sim checks use distinct ports (e.g. 8797, 5191).
- **Test flakiness:** the full parallel test run is heavy; the Queen tests have a 20s timeout for cold starts.

## Key docs
`README.md` (judge-facing), `CLAUDE.md` (rules), `docs/discovery.md` + `docs/deploy-discovery.md` (API research), `docs/day1-results.md` (real-account facts), `docs/model-bakeoff.md`, `docs/harness-spike.md`, `docs/harness-design.md`, `docs/harness-build-brief.md`, `docs/demo-script.md`, `apps/queen/README.md` (planner, router, release semantics).

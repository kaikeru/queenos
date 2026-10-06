# QueenOS: session handoff

Last updated **2026-10-05** by the coordinating Claude session. Read this, then `CLAUDE.md`, `README.md` and `docs/v2-design.md`, before doing anything.

## What this is
QueenOS is an entry for Cloudflare's "next Git platform" challenge (https://blog.cloudflare.com/next-git-platform-on-cloudflare/), **due 2026-10-14**. Submissions need a 5–10 minute video, an OSS license (MIT; done), and run instructions.
- **Direction (user, 2026-10-05):** QueenOS is an **army of virtual engineers** applying decades of software-engineering practice (tickets, design review, trunk-based dev, merge queues, canaries, SLOs, runbooks, postmortems), adapted for thousands of agents. **Autonomous by default; humans only on escalation.** "Thousands" is theoretical; the MVP proves the vision (D10: no quota increase asked; the video says "dozens live, thousands by design"). Design: `docs/v2-design.md` (decisions D1–D11 in §10; D10 declined).
- **Not** a GitHub clone: an OS for agent swarms.
- **The judges want** multiple agents working on changes concurrently.
- **The three questions it answers:**
  - Awareness: the Queen DO (single source of truth), the event log and trace, and hive memory (plus the Cognitive Ledger).
  - Conflicts: path affinity plus a speculative, batched merge queue (3-way merge, integration gate, bisect, conflict -> rework).
  - Review: gates, the LLM reviewer, the Scribe, the integration gate, Sentinel, and error budgets.

**Live (pre-v2 version):** https://queenos.kaikeru.com, behind Cloudflare Access (team `kaikeru`, `@kaikeru.com` emails, one-time-PIN login). The demo hive is `demo`; its prod is https://demo-app.kyle-477.workers.dev and staging is https://demo-staging.kyle-477.workers.dev.

## How the user wants us to work
- **Orchestrate.** The coordinator NEVER edits code or docs itself. Every change goes to a right-sized subagent (Opus for research and subtle core logic, Sonnet for implementation, Haiku for trivial work). The coordinator reads, verifies, commits and coordinates. See memory `orchestration-style`.
- **Phases run as parallel subagents with disjoint file ownership.** Write the shared contract in `packages/queen-types` first, and keep the lockfile with one writer (pre-install deps yourself).
- **Verify per package before committing:** the coordinator checks each package's own tests AND a test typecheck (`tsc -p test`); a vitest pass alone isn't enough. Full gate: `pnpm turbo run build typecheck lint test --force --continue` (**43/43 tasks** green at handoff; turbo concurrency is capped at 4). Use **Node 24**: `export PATH=~/.nvm/versions/node/v24.17.0/bin:$PATH`, because wrangler needs ≥22.
- **Usage limits can kill all running agents at once.** Resume them with SendMessage, in smaller batches if needed.
- **Commit AND push** `main` after each verified package/milestone. The remote is `origin` = github.com/kaikeru/queenos. The user files GitHub issues for things they find; reference them in commits (`Closes #n` / `Refs #n`). The roadmap stays the priority over the issue backlog. End messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Before committing, scan for the token: `/usr/bin/grep -rlF --exclude-dir=node_modules --exclude-dir=.wrangler --exclude-dir=.git -e "$CLOUDFLARE_API_TOKEN" .` (exit 1 means clean; `grep` is aliased to ugrep in this shell, and a `--` before the excludes makes grep read them as filenames)
- **Prefer Cloudflare-native tech** ("a boon"), and keep things simple. The user makes product calls fast; give a recommendation, not a menu.
- **The Queen is an orchestrator ONLY.** It decides, records and dispatches; executors do all external I/O. Exceptions: fire-and-forget Analytics Engine points (D1) and the `SwarmGovernor` lease before `decide()` (D9).

## v2 status (2026-10-05): Phases 0–2 DONE on main, all green (43/43)
Plan and acceptance: `docs/v2-design.md` §8. Queen internals: `apps/queen/README.md`.
- **Phase 0:** contracts (`packages/queen-types`) and migrations v8–v11.
- **Phase 1 (13 packages):** work ledger + path affinity, parallel BUILD lane and races, autonomy/escalation/auto-ship, merge queue, git merge/land (`hive-kit`), observability (event log, rollups, trace), Oracle, drones, gatekeepers/Sentinel (integration gate), Herald/Provisioner config, sim fakes, dashboard data layer, scale plumbing (state cache, coalesced broadcast, `SwarmGovernor`).
- **Contract patch:** migration v12 (verified, budget boost, REST view schemas, Oracle cap 24).
- **Phase 2:** QueenNode `decide()` integration with e2e (a)–(j), status-first dashboard, trace/events/metrics UI, edge metrics proxy (allowlisted Analytics Engine SQL), swarm floor and merge-queue UI.
- **Fixes:** a decomposed goal no longer inherits one child's `[race]` hint (d27f934); turbo concurrency capped at 4 (workerd test flakes from CPU oversubscription, 7f4ac9b).
- **Proven in sim** (coordinator, in a browser against `pnpm dev:sim`): the 24-item "Swarm demo" ran fan-out -> parallel builds -> races -> merge-queue cars -> auto-release -> all 25 items SHIPPED with no human. After the race-width fix: 24 distinct items build at once with 1 race.
- **NOT deployed yet.** Live is the pre-v2 version.

## Phase 3: going live (needs the user)
1. **Analytics token** (Account Analytics Read): `cd apps/edge && wrangler secret put ANALYTICS_API_TOKEN --env=""`.
2. **Vectorize metadata index `kind` on `queenos-memory`:** ALREADY CREATED.
3. **Deploy the Oracle alone first:** `cd apps/oracle && wrangler deploy --env=""`.
4. **Then `./scripts/deploy.sh`.** It deploys the Queen first and adds the `SwarmGovernor` DO (migration tag v2) and the `ANALYTICS` dataset. Its new **R16 guard** reads each hive's snapshot through the edge, so it needs `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` (an Access service token) or `CF_ACCESS_TOKEN`, or `--force` after checking the War Room by hand. **Untested against the live edge.**
5. **After deploy,** existing hives (`demo`) are `supervised` (D2). Flip to autonomous with `PATCH /hives/demo/settings` or the dashboard's autonomy dropdown. New hives default to `autonomous`.
6. **Then** the live checks in design §8 WP3.1 (the 4-bullet Goals prompt, a 12-item live swarm, an AI burst test to set `SWARM_AI_RPM`).

**Do NOT deploy the Queen from a commit between 33d28ed and 191c167:** parallel builds without the queue reworked on NOT_FAST_FORWARD. Main is fine now.

Auto mode blocks production deploys from Claude, so the user runs them: write the commands in a scratchpad script (long pasted lines wrap and break).

## Architecture (11 Workers; v1 ones live, Oracle and v2 Queen not yet)
| Worker (dir) | Role |
|---|---|
| `queen` (apps/queen) | `QueenNode` DO per hive: SQLite state, work ledger, `decide()` pipeline (train/queue/release/work/escalation planners), merge queue, races, autonomy and error budget, model router (AIMD tier floor), watchdog, event log; coalesced WS room. Also hosts the `SwarmGovernor` DO (global lease). Only reachable through the edge. `sim` env = local fakes (localhost-only). |
| `queenos-edge` (apps/edge) | The `queenos.kaikeru.com` front door: Access JWT verification, dashboard static assets, `/api/*` and `/hives/*` routing, the `HiveRegistry` DO, `/api/metrics/:hive` (allowlisted Analytics Engine SQL). `dev` env = auth bypass (localhost-only). |
| `queenos-oracle` (apps/oracle) | Workflow: DECOMPOSE a goal into items (deps, difficulty, predicted paths) and TRIAGE bugs (dedupe). Falls back to "one item, the whole prompt". |
| `queenos-provisioner` | Workflow: Artifacts fork/delete; CREATE_HIVE seeds a repo from `templates/worker-starter`. On FORK, recalls hive memories. Bindings: AI + MEMORY. |
| `queenos-drones` | Workflow: BUILD/REWORK/MERGE/LAND. Live LLM on the Queen's `modelChoice` + fallbacks (429s back off, never count as model failures). Builder is a Think tool-loop agent (`docs/harness-design.md`). Reports `changedPaths`, `followUps`, `verified`. |
| `queenos-gatekeepers` | Workflow on `cf.artifacts.repo.pushed`: policy/security scans, preview smoke, **LLM reviewer**, Scribe, Vectorize failure log, hive memory write. QUEUE cars get the **integration gate** (no reviewer). Out-of-diff findings become follow-up bugs. |
| `queenos-herald` | Workflow: Worker Preview per train, `<hive>-staging`, canary splits on `<hive>-app`, rollback. Credentials come from the Vault. |
| `queenos-sentinel` | Workflow: readiness gate, then synthetic probes pinned per version, then PROMOTE/ROLLBACK (or inconclusive). |
| `queenos-vault` | Per-hive AES-GCM envelope-encrypted creds. `VaultWriter` (edge) / `VaultReader` (herald) entrypoints. |
| `queenos-genesis` | The onboarding wizard DO: chat -> charter -> connect Cloudflare -> CREATE_HIVE -> first flight. |
| dashboard (apps/dashboard) | React War Room: status-first home, swarm floor, merge-queue rail/page, item page, lanes drill-down, trace waterfall, event log, metrics, Model Board, Sites panel. Served by the edge. |

**Packages:**
- `queen-types`: all contracts (onboarding, executors, work, oracle, autonomy, observability, queue, releases, models, telemetry).
- `hive-kit`: isomorphic-git + memfs (3-way merge, registry merge driver), the binding-based AI client, the Cloudflare REST client, the ledger, `HiveMemory` (Vectorize memory client), structured log and metric helpers.

**Flow (v2):** prompt -> Oracle decomposes into work items -> Queen dispatches independent items (path affinity, caps, budget) -> **parallel BUILD trains all fork from main** (hard items race 2–3 models) -> gatekeepers per build -> passed builds board merge-queue **cars** -> MERGE drone 3-way merges members -> integration gate on the merged tree -> LANDER fast-forwards main (failed batch bisects, conflict -> REWORK) -> release: staging -> Sentinel -> **auto-ship if autonomous and budget green** (supervised hives wait for a human tap) -> canary 1/10/50/100 with Sentinel each step -> SHIPPED, or auto-rollback + P0 bug. One trace id runs end to end. Escalations (runbook enum) are the only human touchpoint.

## Account and infra facts (no secrets here)
- **Account:** `4773fbabdff038e3b907b14cd212c062`, workers.dev subdomain `kyle-477`. `CLOUDFLARE_API_TOKEN` (account-owned) is in the user's shell. Set `CLOUDFLARE_ACCOUNT_ID` for wrangler. Verify via `/accounts/{id}/tokens/verify`.
- **Access:** app "QueenOS" (id `798aa993-…`); its AUD is in `apps/edge/wrangler.jsonc`. The Zero Trust team was renamed from modernmythtools to kaikeru at the user's request.
- **AI:** gateway `queenos` (authenticated); all LLM calls use the Workers `ai` binding, so there are no tokens. Models come from `MODEL_CATALOG` in `packages/queen-types/src/models.ts`, all Workers AI `@cf/…`, ordered by `docs/model-bakeoff.md`. The user chose gateway models over Anthropic.
- **Other resources:** Vectorize indexes `queenos-failures` (768, cosine) and `queenos-memory` (768, cosine, metadata indexes `namespace` and `kind`); Artifacts namespace `queenos`; Analytics Engine dataset `queenos_events` (created on first Queen deploy).
- **Secrets set:** `VAULT_KEK` (backup at `~/.queenos/vault-kek.backup`; the user was asked to move it to a password manager) and `QUEEN_INTERNAL_TOKEN`. Pending: edge `ANALYTICS_API_TOKEN`.
- **Deploy:** `./scripts/deploy.sh`, two passes because cross-script bindings form cycles. For a single NEW worker, deploy it alone first with `wrangler deploy --env=""` to avoid the bootstrap pass. To redeploy one existing Worker: `./scripts/deploy.sh --only <dir>` (its "one-time manual steps" footer prints every time; ignore it). Executors and most Workers have `workers_dev:false`.
- **Monitoring:** Workflow instances via `GET /accounts/{id}/workflows/<name>/instances` (names: `drone-workflow`, `herald-workflow`, `sentinel-workflow`, `gatekeeper-workflow`, `provisioner-workflow`, `oracle-workflow`). Step outputs are truncated in that API. v2 adds Workers Logs (`observability`) and the in-Queen event log/trace view.
- **Hive memory:** gatekeepers write one memory per gate verdict; the Provisioner recalls up to 5 at FORK (cosine ≥ 0.6, same hive) into `DroneTask.ragContext`. The Queen never touches Vectorize. Contract `packages/queen-types/src/memory.ts`, client `packages/hive-kit/src/memory.ts`. **Gotcha:** Vectorize writes take up to ~1 min to become queryable, and `wrangler vectorize info` / `list-vectors` show stale counts (0); use `get-vectors --ids`.
- **Live proof (pre-v2, on `demo`):** Genesis wizard; live-LLM builds through preview, gate, land; tap-to-ship with a full canary (1->100%) that SHIPPED; the memory loop (a build recalled the previous build's memory). The old AWAITING_TAP release on `demo` may be superseded; check the War Room before tapping.

## Known gaps and gotchas
- **v2 gaps:**
  - `[batch-fail]` bisect is timing-dependent live (e2e (f) proves the deterministic case);
  - `queue.landed` has no `waitMs` (queue-wait p50 stays null);
  - 390 px layout not verified in a real narrow browser (the old release-timeline label overlap at 390px may remain);
  - mock mode (`VITE_MOCK_API=1`) doesn't support POST actions; use `pnpm dev:sim`;
  - the root README still says releases "reach AWAITING TAP" (now auto-ship); Phase 3 docs;
  - the dashboard shows recalled memories but not whether the builder used them;
  - no reliable LIVE reviewer reject (the sim has one); the SHIPPED banner has no prod link.
- **Live latency:** builds take 40–220s, and the drone generation budget is 200s. The watchdog is 10 min.
- **Templates:** the no-build template only serves features at `/features/<slug>` unless a feature declares its own `path`.
- **Sentinel** uses synthetic probes only. With little traffic on demo apps, that's the real signal.
- **Pinned preview URLs** (`<8hex>-<worker>…`) outlive teardown (a Cloudflare behavior). Herald reports alias URLs instead.
- **A failed first prod deploy** stays FAILED while the candidate serves 100% (there's no stable version to roll back to). The summary says so.
- **Dashboard tabs** opened before a deploy show an "updated, reload" banner on new message types.
- **Chrome automation:** clicks via `find` refs sometimes don't register; coordinates work.
- **Never `pkill -f vite` / `pkill -f wrangler`:** a subagent once did, killing every vitest/wrangler on the machine, other projects included. Agents kill only the PIDs they started. Parallel live sim checks use distinct ports (e.g. 8797, 5191).
- **Test flakiness:** workerd suites flake under CPU oversubscription; turbo concurrency is capped at 4 and the Queen tests have a 20s timeout for cold starts.

## Remaining roadmap to Oct 14
1. **Phase 3 (Oct 11):** live rollout (above); docs (new README pitch, `docs/demo-script.md`, this file); a 500-item sim load test per design §8 WP3.4 (`apps/queen/test/load.test.ts`); hardening/fix pool. Cut lines: design §8.
2. **Oct 12–13:** rehearsal on a throwaway hive, then recording per `docs/demo-script.md`. **That script predates v2** and needs a rewrite around the status home, swarm floor and merge queue. Screenshots and video are deferred until the user asks.
3. **Oct 14:** submit (the video is the user's).
4. **Dropped or stubbed:** bisect + auto-revert on *staging* failure (`stagingFailed()` files a P0 bug instead), real npm builds (`@cloudflare/worker-bundler` works per the spike, but is deferred), custom domains for project sites, and everything in design §9.

## Key docs
`README.md` (judge-facing; v1 pitch until Phase 3), `CLAUDE.md` (rules), `docs/v2-design.md` (v2 design, plan, decisions), `apps/queen/README.md` (decide pipeline, routes, planner, router, release semantics), `docs/discovery.md` + `docs/deploy-discovery.md` (API research), `docs/day1-results.md` (real-account facts), `docs/model-bakeoff.md`, `docs/harness-spike.md`, `docs/harness-design.md`, `docs/harness-build-brief.md`, `docs/demo-script.md` (pre-v2).

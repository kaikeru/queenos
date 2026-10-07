# QueenOS: session handoff

Last updated **2026-10-06** by the coordinating Claude session. Read this, then `CLAUDE.md`, `README.md` and `docs/v2-design.md` (§1 principles, §10 decisions), before doing anything. Memory files in `~/.claude/projects/-Users-kyle-repositories-queenos/memory/` repeat the key working rules.

## 1. What this is, the direction, how we work

QueenOS is an entry for Cloudflare's "next Git platform" challenge (https://blog.cloudflare.com/next-git-platform-on-cloudflare/), **due 2026-10-14**. Submissions need a 5-10 minute video (the user's), an OSS license (MIT; done) and run instructions (README).

- **Direction (user, 2026-10-05):** an **army of virtual engineers** applying decades of software-engineering practice (tickets, design review, trunk-based dev, merge queues, canaries, SLOs, runbooks, postmortems), adapted for thousands of agents. **Autonomous by default; humans only on escalation.** Scale line: "dozens live, thousands by design" (D10: no Workers AI quota increase requested).
- **Not** a GitHub clone: an OS for agent swarms. The judges want multiple agents working on changes concurrently.
- **The three questions it answers:**
  - Awareness: the Queen DO (single source of truth), event log and trace, hive memory (Vectorize) plus the Cognitive Ledger.
  - Conflicts: path affinity, then a speculative, batched merge queue (3-way merge, integration gate, bisect, conflict -> rework).
  - Review: gates, LLM reviewer, Scribe, integration gate, Sentinel, error budgets.
- **The Queen is an orchestrator ONLY.** It decides, records and dispatches; executors do all external I/O. Exceptions: fire-and-forget Analytics Engine points (D1) and the `SwarmGovernor` lease before `decide()` (D9).
- **Prefer Cloudflare-native tech**, keep things simple. The user makes product calls fast: give a recommendation, not a menu.

### How the user wants us to work
| Rule | Detail |
|---|---|
| Coordinator never edits | The coordinator NEVER edits code or docs. Right-sized subagents do: **Opus** for subtle logic and research, **Sonnet** for implementation, **Haiku** for trivial work. Disjoint file ownership per agent; contracts first in `packages/queen-types`; one lockfile writer (pre-install deps yourself). |
| Coordinator verifies | Per package: its own tests AND `tsc -p test` (vitest alone isn't enough). Then the full gate: `pnpm turbo run build typecheck lint test --force --continue` (**43/43 tasks** green). Then commit AND push `main` (`origin` = github.com/kaikeru/queenos). |
| Token scan before every commit | `/usr/bin/grep -rlF --exclude-dir=node_modules --exclude-dir=.wrangler --exclude-dir=.git -e "$CLOUDFLARE_API_TOKEN" .` Exit 1 = clean. Use `/usr/bin/grep`: plain `grep` is aliased to ugrep here, and a `--` before the excludes makes grep read them as filenames. |
| Commit messages | End with the attribution line your session's system reminder specifies (previous sessions used `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). The user files GitHub issues: reference them (`Closes #n` / `Refs #n`); the roadmap outranks the issue backlog. |
| Node 24 | `export PATH=~/.nvm/versions/node/v24.17.0/bin:$PATH` (wrangler needs 22+). Full gate is capped at **turbo concurrency 4** (workerd suites flake under CPU oversubscription; Queen tests have a 20 s timeout). |
| Production deploys are the USER's | Auto mode blocks them. Give the user exact commands (a short list, or a scratchpad script; long pasted lines wrap and break). |
| Usage limits | They kill ALL running agents at once. Resume them with SendMessage, in smaller batches. |
| Live sim checks | Run parallel ones on distinct ports (e.g. 8797, 5191). **Never `pkill`** (`-f vite`/`-f wrangler` once killed every vitest/wrangler on the machine, other projects included). Kill only PIDs you started. |

## 2. State of the system: v2 complete, live on demo

Phases 0-3 are DONE and on `main` (green 43/43). Plan and acceptance: `docs/v2-design.md` §8. Queen internals: `apps/queen/README.md`.

**Backend (all built and tested):**
- **Work ledger:** items with kind/priority/acceptance/deps and a state machine; path affinity; caps and dedupe (migrations v8-v13).
- **Oracle** (Workflow): fan-out of a goal into items (deps, difficulty, predicted paths; one item per explicit bullet), bug triage. Falls back to one item = whole prompt.
- **Parallel builds:** independent items fork from `main` together; hard items race 2-3 models.
- **Merge queue:** cars, batching, 3-way merge (MERGE drone), integration gate on the merged tree, LANDER fast-forward, bisect on failed batch, conflict -> REWORK, infra errors re-dispatch the same car.
- **Autonomy and escalations:** auto-ship while budget green; error budget and rollback streak degrade to `supervised`; runbook-enum escalations.
- **Self-filed bugs:** drone follow-ups, out-of-diff gate findings, P0 on rollback (caps and dedupe).
- **Observability:** one trace id end to end, `event_log`, hourly rollups, Analytics Engine sink, Workers observability logs.
- **Scale plumbing:** state cache, coalesced/paced broadcast, batched `appendAudits`, `SwarmGovernor` lease. Sim load test: 500/500 landed (`pnpm --filter @queenos/queen test:load`, opt-in).

**Dashboard (apps/dashboard):** status home, swarm floor (tiles by phase, race boxes), **merge-train graph** (821e12d: a git-graph view of parallel branches, batched cars, bisects, conflicts; status home shows 30 min, `/p/:hive/queue` shows 24 h with a car payload panel), item page, trace waterfall, event log, metrics, lanes, Model Board, **SIM badge** (hive status `mode`), release strip (auto-ship, prod link), guardrails panel.

**Sim:** `pnpm dev:sim` runs the real Queen + dashboard with fake executors (see README for prompt markers).

## 3. Proven live on queenos.kaikeru.com (hive `demo`, 2026-10-06)

| Run | What happened | Fix |
|---|---|---|
| 1 | Oracle collapsed 12 bullets into one item. Release auto-shipped with no tap. | 5ab8ee2 (Oracle: one item per bullet); auto-ship dc7126d |
| 2 | 12 parallel builds. Workers AI 429s (3021) and Artifacts 503s were blamed on the code -> REWORK_EXHAUSTED and a fake rollback bug. All 12 shipped after fixes plus retries. | ff3b0f5 (transient infra never blames the change) |
| 2b | Smoke gate false negatives on endpoints correctly returning 400 (leapyear/hex) caused repeated bisects. | 1d0d268 (feature routes pass on any non-404 under 500) |
| 2c | 503s in drone MERGE/LAND ejected cars and cascaded supersedes. | b21d68f (drones retry; Queen re-dispatches same car) |
| 2d | A deferred dispatch retry stalled a car about 5 min. | fd0a025 (retry in 15 s; undispatched drones get a deadline) |
| 2e | fd0a025 regressed the sim by overwriting a past-due alarm. | 2b2cd55 (never move an alarm later; track re-arm inside `alarm()`; sim runs due jobs inside the alarm) |
| 3 "toy box" | 11-item goal ("Toy box" on `/` plus 10 widget fragments) plus the user's follow-up goal. All SHIPPED autonomously. | n/a |

- Live prod page https://demo-app.kyle-477.workers.dev/ has the Toy box chips and "Try a feature" buttons (dice, emoji, colors verified working).
- **Totals by end of day:** about 25 items landed, several auto-shipped releases, error budget **0/2** (counts only real change failures after the infra fix; old rows age out of the window).

## 4. Deploy state (CRITICAL)

**Last production deploys (UTC 2026-10-06):** queen 20:00 (about b21d68f), drones 20:01, gatekeepers 19:47, herald/sentinel/oracle/edge about 19:26-19:27.

**PENDING, the user must run:**

| Command | Ships |
|---|---|
| `./scripts/deploy.sh --only queen` | fd0a025 + 2b2cd55 (dispatch retry + alarm fix). **Never deploy fd0a025 without 2b2cd55; `main` has both.** |
| `./scripts/deploy.sh --only edge` | Merge-train graph + dashboard (821e12d and earlier dashboard commits since 19:27). Builds the dashboard first. |

Preamble for both:
```
cd ~/repositories/queenos && export PATH=~/.nvm/versions/node/v24.17.0/bin:$PATH CLOUDFLARE_ACCOUNT_ID=4773fbabdff038e3b907b14cd212c062
```
- `deploy.sh` runs a v1-train safety check (R16 guard: reads each hive snapshot through the edge; needs `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` or `CF_ACCESS_TOKEN`). `--force` skips it. With no in-flight trains, a plain `--only <worker>` is fine. The "one-time manual steps" footer prints every time; ignore it.
- **Live config:**
  - Governor lease 12 builds (`SWARM_AI_RPM` 240, `SWARM_RPM_PER_BUILD` 20).
  - Hive `demo`: autonomous; guardrails raised by the user to `maxChildrenPerItem` 12.
  - `ANALYTICS_API_TOKEN` is NOT set, by design: the metrics page uses the Queen rollups.
- **Do not deploy the Queen from a commit between 33d28ed and 191c167** (parallel builds without the queue). Main is fine.

## 5. How to run and watch a live swarm

- **Dashboard:** the user is signed in to Access in Chrome. Drive it with the Chrome tools (load via ToolSearch): `get_page_text` to read, `form_input` for the composer textarea. Clicks via `find` refs sometimes don't register; coordinates work.
- **Workflow instances** via the Cloudflare API (`CLOUDFLARE_API_TOKEN` is in the user's shell): `GET /accounts/{id}/workflows/<name>/instances?per_page=...` for `oracle-workflow`, `drone-workflow`, `gatekeeper-workflow`, `herald-workflow`, `sentinel-workflow`, `provisioner-workflow`. Step outputs are truncated.
  - Watcher pattern: a script polling every 30 s, emitting only on change. The previous watcher omitted the provisioner; add it.
- **Queen event log** through the edge: `https://queenos.kaikeru.com/hives/demo/events?limit=40` (needs the Access cookie).
- **Queue page `/p/demo/queue`** is the best debugging view (now with the merge-train graph and car payloads).
- **Workers observability logs** exist for the Queen DO.
- Live latency: builds 40-220 s; drone generation budget 200 s; watchdog 10 min.

## 6. Open items and next steps (prioritized)

1. **User deploys queen + edge** (section 4).
2. **Clean live 12-item swarm** as the final proof with every fix deployed; watch the merge-train graph live.
3. **Dashboard polish:** nested `<li>` in the GoalTree Row; "N landed" counts cars + members (36 for 24); the `prod ▸` link is sometimes missing from the release strip.
4. **Demo prod cleanup:** old internal feature slugs on the Toy box chips (add-simple-webpage..., we-are-doing-a-test-deploy). The user can prompt a cleanup.
5. **Still-open gaps:**
   - no reliable live reviewer REJECT (the sim has `[review-fail]`);
   - the dashboard shows recalled memories but not whether the builder used them;
   - 390 px layout only verified in headless;
   - mock mode (`VITE_MOCK_API=1`) has no POST actions; use `pnpm dev:sim`.
6. **Transient Artifacts/Workflows errors** still occur under load; each now costs retries, not failures. Consider asking Cloudflare about Artifacts 503 rates.
7. **Update `docs/demo-script.md`:** it predates the merge-train graph; redo the merge-queue shots with it (its Gaps section also lists items since closed: swarm title, SIM badge, release strip, guardrails panel, queue wait).
8. **Screenshots and video stay deferred** until the user asks.

**Roadmap to Oct 14:** Oct 12-13 rehearsal on a throwaway hive then recording per the demo script (go/no-go: all-sim cut if live rehearsal hasn't passed by Oct 12 noon); Oct 14 submit. **Dropped or stubbed:** bisect + auto-revert on *staging* failure (a P0 bug is filed instead), real npm builds, custom domains for project sites, everything in design §9.

## 7. Architecture (11 components: 10 Workers plus the dashboard)

| Worker (dir) | Role |
|---|---|
| `queen` (apps/queen) | `QueenNode` DO per hive: SQLite state, work ledger, `decide()` pipeline (train/queue/release/work/escalation planners), merge queue, races, autonomy and error budget, model router (AIMD tier floor), watchdog, event log, coalesced WS room. Also hosts the **`SwarmGovernor` DO** (global lease). Reachable only through the edge. `sim` env = localhost-only fakes. |
| `queenos-edge` (apps/edge) | `queenos.kaikeru.com` front door: Access JWT, dashboard assets, `/api/*` and `/hives/*` routing, `HiveRegistry` DO, `/api/metrics/:hive` (allowlisted Analytics Engine SQL). `dev` env = auth bypass (localhost-only). |
| `queenos-oracle` | Workflow: DECOMPOSE goals, TRIAGE bugs. |
| `queenos-provisioner` | Workflow: Artifacts fork/delete, CREATE_HIVE seeds from `templates/worker-starter`, recalls hive memories on FORK. |
| `queenos-drones` | Workflow: BUILD/REWORK/MERGE/LAND. Builder is a Think tool-loop agent (`docs/harness-design.md`) verifying in a Dynamic Worker. 429s back off, 503s retry. |
| `queenos-gatekeepers` | Workflow on `cf.artifacts.repo.pushed`: policy/security scans, preview smoke, LLM reviewer, Scribe, Vectorize failure log, hive memory write. Queue cars get the integration gate (no reviewer). |
| `queenos-herald` | Workflow: Worker Preview per train, `<hive>-staging`, canary splits on `<hive>-app`, rollback. Creds from the Vault. |
| `queenos-sentinel` | Workflow: readiness gate, synthetic probes per version, PROMOTE/ROLLBACK/inconclusive. |
| `queenos-vault` | Per-hive AES-GCM envelope-encrypted creds (`VaultWriter`/`VaultReader`). |
| `queenos-genesis` | Onboarding wizard DO. |
| dashboard (apps/dashboard) | React + Vite War Room, served by the edge. |

**Packages:** `queen-types` (all Zod contracts), `hive-kit` (isomorphic-git + memfs, AI client, Cloudflare REST client, ledger, `HiveMemory`, log/metric helpers).

**Flow:** prompt -> Oracle -> work items -> Queen dispatches independent items (affinity, caps, budget) -> parallel BUILD trains forked from main (hard items race) -> gatekeepers -> passed builds board cars -> MERGE drone -> integration gate -> LANDER fast-forward (bisect/conflict handling) -> release: staging -> Sentinel -> auto-ship if autonomous and budget green (supervised waits for a tap) -> canary 1/10/50/100 -> SHIPPED, or auto-rollback + P0 bug. Escalations are the only human touchpoint.

## 8. Account and infra facts (no secrets here)

- **Account** `4773fbabdff038e3b907b14cd212c062`, workers.dev subdomain `kyle-477`. Verify the token via `/accounts/{id}/tokens/verify`.
- **Access:** app "QueenOS" (id `798aa993-...`), AUD in `apps/edge/wrangler.jsonc`; team `kaikeru`, `@kaikeru.com` emails, one-time PIN. Demo hive prod https://demo-app.kyle-477.workers.dev, staging https://demo-staging.kyle-477.workers.dev.
- **AI:** gateway `queenos`; all LLM calls via the Workers `ai` binding (no tokens). Models from `MODEL_CATALOG` (`packages/queen-types/src/models.ts`, Workers AI `@cf/...`, ordered by `docs/model-bakeoff.md`).
- **Other resources:** Vectorize `queenos-failures` and `queenos-memory` (768, cosine; metadata indexes `namespace`, `kind`); Artifacts namespace `queenos`; Analytics Engine `queenos_events`.
- **Secrets set:** `VAULT_KEK` (backup `~/.queenos/vault-kek.backup`; user asked to move to a password manager), `QUEEN_INTERNAL_TOKEN`. Not set: edge `ANALYTICS_API_TOKEN` (intentional).
- **Deploy:** `./scripts/deploy.sh` (two passes for cross-script binding cycles); a single NEW worker: `wrangler deploy --env=""` alone first; one existing worker: `--only <dir>`.
- **Hive memory:** one memory per gate verdict; recall up to 5 at FORK (cosine >= 0.6, same hive). Vectorize writes take up to ~1 min to become queryable and `wrangler vectorize info` shows stale counts; use `get-vectors --ids`.

## 9. Gotchas

- Templates: the no-build template serves features at `/features/<slug>` unless a feature declares its own `path`.
- Sentinel uses synthetic probes only (little traffic on demo apps).
- Pinned preview URLs (`<8hex>-<worker>...`) outlive teardown; Herald reports alias URLs.
- A failed first prod deploy stays FAILED while the candidate serves 100% (no stable version to roll back to).
- Dashboard tabs opened before a deploy show an "updated, reload" banner.
- Hives created before v2 stay `supervised` until switched (`PATCH /hives/<hive>/settings` or the dashboard dropdown).

## 10. Key docs

`README.md` (judge-facing, v2), `CLAUDE.md` (rules), `docs/v2-design.md` (design, plan, decisions D1-D11 in §10), `apps/queen/README.md` (decide pipeline, routes, planners, release semantics), `docs/demo-script.md` (13 shots, sim-backed; needs the merge-train graph update), `docs/discovery.md` + `docs/deploy-discovery.md` (API research), `docs/day1-results.md` (real-account facts), `docs/day1-verification.md`, `docs/model-bakeoff.md`, `docs/harness-spike.md`, `docs/harness-design.md`, `docs/harness-build-brief.md`.

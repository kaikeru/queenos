# QueenOS: session handoff

Last updated **2026-10-13** (Claude Code coordinator session). Read this, then `CLAUDE.md`, `README.md`, `docs/human-push-design.md` (rev 2; §13 is the plan) and `docs/agent-protocol.md`, before doing anything. `docs/v2-design.md` (§1 principles, §10 decisions) is the older swarm design.

## 1. Read first: direction, memory, rules

QueenOS is an entry for Cloudflare's "next Git platform" challenge (https://blog.cloudflare.com/next-git-platform-on-cloudflare/), **due 2026-10-14**. Submissions need a 5-10 minute video (the user's), an OSS license (MIT; done) and run instructions (README).

**Headline (user decision, 2026-10-07): "agent-native git."** The git layer is the product. The swarm, merge queue, deploy pipeline and SRE features are supporting products that prove it out.

- **Pitch:** "Git for agents isn't a review tool, it's a selection-and-integration engine. You don't open a PR; you submit a candidate, and the swarm decides."
- **"Git, reimagined" table** (README and video must carry it):

| Git today | QueenOS |
|---|---|
| Repository | Hive |
| Branch / worktree | Ephemeral fork |
| Pull request | Submission into an item's inbox |
| Code review | Gates, reviewer, human pick |
| Merge conflict | Queue, bisect, agent rework |
| "Why" | Item intent + git notes + trace |
| Comparing changes | Races + pick |

- **README TODO: done (3c582a6).** Reframed as agent-native git, with the table above.
- **Long-term product (after the hackathon): the git merge engine.** Coordinate agentic submissions through speculative merge trains and strict gates, hooking into existing CI/CD (pluggable gates; the engine's job ends at "landed on main"). Hackathon first (Oct 14), then refocus on the merge core.
- **Inbox model:** every change is a Submission. The item is the competition (the inbox).
  - A correlated push (branch `item/<id>`, or `goal/<slug>` with one item) joins that item's race.
  - An uncorrelated push has "already won a race": a new item with no race, still fully gated.
  - A late push becomes a follow-up item. Humans can join anywhere and are required nowhere.
- **Notes are the protocol, the ledger is the truth.** v1 notes with `Queen-*` trailers live on `refs/notes/verdict`, `refs/notes/review`, `refs/notes/provenance`. `refs/notes/queen` stays the internal Cognitive Ledger JSON. The proxy synthesizes notes from the Queen's ledger, so they are unforgeable and nothing is pushed.
- **Human-judged races** (opt-in "you pick") with manual reject and preference weighting (T9a-d): design §10.
- **Still true from v2:** autonomous by default, humans only on escalation; "dozens live, thousands by design"; an OS for agent swarms, not a GitHub clone. **The Queen is an orchestrator ONLY** (decides, records, dispatches; executors do all external I/O; exceptions: Analytics Engine points and the `SwarmGovernor` lease). Prefer Cloudflare-native tech, keep it simple; the user makes product calls fast, so give a recommendation, not a menu.

**Memory files** in `~/.claude/projects/-Users-kyle-repositories-queenos/memory/` (read `MEMORY.md` first): `headline-agent-native-git`, `vision-merge-engine`, `inbox-push-direction`, plus the older ones (deploy-pipeline-decisions, orchestration-style, handoff-doc, v2-autonomy-direction).

### How the user wants us to work
| Rule | Detail |
|---|---|
| **One task at a time** | Be credit-conscious. Run ONE task, finish it (verify, full gate, commit) before starting the next, and **ask before starting the next task**. |
| Coordinator never edits | The coordinator NEVER edits code or docs. Right-sized subagents do: **Opus** for subtle logic and research, **Sonnet** for implementation, **Haiku** for trivial work. Disjoint file ownership per agent; contracts first in `packages/queen-types`; one lockfile writer (pre-install deps yourself). |
| Coordinator verifies | Per package: its own tests AND `tsc -p test` (vitest alone isn't enough). Then the full gate: `pnpm turbo run build typecheck lint test --force --continue` (**49/49 tasks** green on `main`). Then commit AND push `main` (`origin` = github.com/kaikeru/queenos). |
| Token scan before every commit | `/usr/bin/grep -rlF --exclude-dir=node_modules --exclude-dir=.wrangler --exclude-dir=.git -e "$CLOUDFLARE_API_TOKEN" .` Exit 1 = clean. Use `/usr/bin/grep`: plain `grep` is aliased to ugrep here, and a `--` before the excludes makes grep read them as filenames. |
| Commit messages | End with the attribution line your session's system reminder specifies. The user files GitHub issues: reference them (`Closes #n` / `Refs #n`); the roadmap outranks the issue backlog. |
| Node 24 | `export PATH=~/.nvm/versions/node/v24.17.0/bin:$PATH` (wrangler needs 22+). Full gate is capped at **turbo concurrency 4** (workerd suites flake under CPU oversubscription; Queen tests have a 20 s timeout). |
| Production deploys are the USER's | Auto mode blocks them. Give the user exact commands (a short list, or a scratchpad script; long pasted lines wrap and break). |
| User does security config | Auto mode blocks creating or changing Access apps via the API. The user does Access/security config themselves. |
| Credentials | The coordinator must not mint git tokens via the browser: that would put the credential in its context. |
| Usage limits | They kill ALL running agents at once. Resume them with SendMessage, in smaller batches. |
| Live sim checks | Run parallel ones on distinct ports (e.g. 8797, 5191). **Never `pkill`** (`-f vite`/`-f wrangler` once killed every vitest/wrangler on the machine). Kill only PIDs you started. |

## 2. State of the system

- **2026-10-13: rework loop** (spec `docs/superpowers/specs/2026-10-13-queenos-rework-loop-design.md`, plan `docs/superpowers/plans/2026-10-13-queenos-rework-loop.md`). Implemented on `main` and **deployed 2026-10-14** (§4); all three live checks pass (§3). A rejected attempt gets a rework slot (findings, conflict, human) and re-pushes as the same candidate. `sync_base` and `reject` (MCP, 19 tools), dashboard Reject / Reject all, races `REWORKING`, migration v19, sim `POST /sim/rework-demo`. Deploy order: Queen, then `queenos-mcp`, then the edge (Task 12 has the commands).

`main` is green (49/49 turbo tasks; schema v19; Queen 919 passing + 1 skipped, mcp 63, dashboard 223). v2 swarm (Phases 0-3) is complete; the git proxy path (T0-T4) is built and live. Swarm internals: `docs/v2-design.md` §8, `apps/queen/README.md`.

**v2 backend (built, tested):** work ledger (items, deps, state machine, path affinity, caps/dedupe); Oracle fan-out (one item per bullet); parallel builds with races; merge queue (cars, batching, 3-way merge, integration gate, LANDER fast-forward, bisect, conflict -> REWORK); autonomy and error budget; self-filed bugs; one trace id end to end, event log, rollups, Analytics Engine; scale plumbing (sim load test 500/500). **Dashboard:** status home, swarm floor, merge-train graph, item page, trace waterfall, event log, metrics, Model Board, SIM badge, release strip, guardrails panel. **Sim:** `pnpm dev:sim` runs the real Queen with fake executors.

**Built and committed on Oct 7 (all on `main`):**

| Commit | What |
|---|---|
| d03ff3f | Dashboard polish (GoalTree li, landed count, prod link) |
| 1deb7ab | Infra survival for Artifacts per-repo 503 episodes: cf-ray evidence on git errors, backoff, provisioner fork stagger, `-rN` re-fork, readiness probe, cars retire after one infra round, gate watchdog |
| 6452ad7 T0, d877f1d T0b | Contracts: Submission, race, pick (schema v14); notes v1 renderer/parser; git intake schemas |
| 34ac6aa | **Bug fix:** Workflows `createBatch` silently omits instances it fails to create; the dispatcher now starts missing ones one by one. Caused a 7-minute prod stall |
| fa03cf4 | Design rev 2 (git proxy, probed against real Artifacts) |
| d2dfaf4 | Notes-protocol docs, `docs/agent-protocol.md`, Claude Code plugin `plugins/queenos` (queenos-inbox skill, `queen-notes.sh`, `queen-wait.sh`) |
| b0666a9 T1 | Queen git intake RPCs `gitIntent` / `gitPushed` / `gitAborted` / `notesFor` |
| f88e092 T2 | `apps/git` = the `queenos-git` Worker (the proxy) |
| 168b43e T3 | Edge `/git/*` auth (`qgt_` tokens; `/api/git-tokens` behind Access) |
| 926f991 | Queen follow-ups, schema v15: `-rN` adoption; **Queen-started gates for every train reaching TESTING (applies to drone builds too)**; per-train findings |
| be2e6c1 T4 | Gate uses a real tree diff against the base (closes a blind spot for human modify-only commits); reviewer fails closed for non-drone origin; protected paths |

**Built and committed on Oct 9 (on `main`, pushed to origin):**

| Commit | What |
|---|---|
| efcccea | **Step (a) of the external-agents direction: per-hive `executors: "swarm" \| "external"`** (details below, §6). LIVE (queen and edge Oct 9; queenos-git Oct 12) |
| 35d851c (step (d)) | **Step (d) dynamic race entry** (details below, §6). Also commits the `AGENTS.md` tool blocks (repo-graph, ast-grep). Queen 738 tests, git 80, queen-types 121, dashboard 201; full gate 46/46. LIVE (same deploys as efcccea) |
| eab6a7b (step (b)) | **Step (b) agent identity on git tokens** (details below, §6). A git token can be bound to an agent (name + claimed model, self-reported) at mint (`POST /api/git-tokens` with `agent:{name, model?}`; dashboard Push code page fields). The edge forwards trusted `x-queen-agent` / `x-queen-agent-model` (client copies are stripped on every path); queenos-git validates them (401 if malformed) and refuses a branch handle suffix that doesn't match the token's agent. Queen schema v16 adds `submissions.agent`; the origin becomes `{kind:"agent", id:"<name>@<owner>", model?}` from the token (overrides the `Queen-Origin` trailer, which still works for human tokens). Supersede and same-head retry are keyed by (owner, ref, agent), so agents of one owner race instead of superseding; caps stay per owner email. The claimed model never reaches the router or `model_stats`; OriginChip shows "claims <model>". Tests: Queen 751 (+1 skipped), git 101, edge 85, queen-types 126, dashboard 208; full gate 46/46. LIVE (same deploys as efcccea) |

**MCP (attempt = repo), Oct 12:** `apps/mcp` (`queenos-mcp`), Queen v17 attempts ledger, gatekeepers attempt routing, edge `/mcp`, dashboard attempt chip. Spec `docs/superpowers/specs/2026-10-12-queenos-mcp-design.md`, plan `docs/superpowers/plans/2026-10-12-queenos-mcp.md`. Probe results in spec §13.1 (P3 Claude Code client sub-check and P4 2 h token re-check still outstanding). **Oct 12 pivot:** the Herdr 3-session race rehearsal (shared git token, finding item ids behind Access) was dropped in favor of an MCP server, so agents race through MCP instead; the Oct 14 deadline is no longer the driver. Agent protocol: `docs/agent-protocol.md` §8; skill `plugins/queenos/skills/queenos-mcp`; template `AGENTS.md` has a "Through MCP" section. Not deployed yet (§4). Full gate 49/49; Queen 806 passed + 1 skipped.

**Built and committed on Oct 12 (on `main`):**

| Commit | What |
|---|---|
| 927c875 | **Step (e) hive template**: `templates/worker-starter/AGENTS.md` (feature convention, protected paths, branch handles, trailers, entry window, verdict notes, rework) seeded via regenerated `templates.generated.ts`; queenos-inbox skill preconditions now describe the live proxy flow (token from `/p/<hive>/push`, remote `https://<host>/git/<hive>`, scripts default to remote `origin`); `docs/agent-protocol.md` status refreshed. Provisioner 35 tests; full gate 46/46. Provisioner NOT deployed |

## 3. Proven live (queenos.kaikeru.com, hive `demo`)

**2026-10-14: rework loop, all three live checks PASS** (Herdr workers, external executors):
1. **Conflict, sync_base, rebase, land: PASS.** The first attempt had no conflict: the features index is a generated file that the merge regenerates. The second attempt used two goals renaming the same morse key. The second winner was REJECTED with `kind: "conflict"` and a rework slot. It ran `sync_base`, rebased, force-pushed, and landed in the same race `9052c584` with no follow-up item. Oddities: the verdict note still began with the old PASSED text, and the item view kept the original train as winner/preview.
2. **Mid-race fix after entry close: PASS** (race `1c63dc00`). A deliberate syntax error got a findings slot. The fix was pushed 41 s after entry close and rejoined the same race with no follow-up. The race held for it, then decided normally. The AI reviewer gave a false positive ("not registered in index"), which cost a round.
3. **Reject all with a reason: PASS, on the retry.** The first try decided before PICKING (an infra regate plus the 90 s grace, so a single pass wins). The retry was race `de577d31`. The user did Reject all twice with reasons, which reopened the race twice, and the agents reworked per each reason. The orchestrator used `close_entries`. w4 hit gate infra failures twice. The user ended entries and w3 auto-won as the single pass and LANDED (train `061ac4df`).
4. `maxInboxPushesPerHour` was hit during testing; the user raised demo's to 60.
5. UI findings from these checks are the dashboard redesign in §6.

**Oct 13: the MCP path, live (before the fix wave below was deployed):**
1. **Two-agent "you pick" haiku race on `demo`:** both agents started from the shared race base, both passed, the human picked w1 (sonnet), it shipped.
2. **4-goal train test, 2 workers holding 2 attempts each:** moon, bmi and countdown landed; morse hit the infra-reject bug (the reviewer LLM returned empty output, so the attempt went REJECTED and the race ABANDONED with a note that said the Queen re-gates), then landed after a re-push (an empty commit).
3. **P3 Claude Code client check: PASS.** **P4 (2 h token re-check, spec §13.1) is still outstanding.**
4. The infra bug, the misleading verdict and the other live findings are fixed in the fix wave (Queen v18 gate-infra re-gates with `notBefore`, `retry_gates`, verdict `kind`, `retryable` errors, idempotent `end_attempt`, one `setupCommand`, reviewer hardening). See the spec's "Amendments (Oct 13, fix wave)". Deployed Oct 13 (§4 fix-wave deploy).
5. Folder-trust note: Herdr-started Claude workers in a new directory hit Claude Code's trust prompt. The user trusted `~/queen-race`; whether trusting the parent folder covers new subdirectories is untested.

**Oct 7:**
1. **12-item "final proof" swarm:** all 12 shipped autonomously in about 14 min, infra noise absorbed.
2. **4-item infra-check swarm** after the infra deploy: all landed. It exposed the createBatch bug (fixed 34ac6aa, deployed 15:24).
3. **First human `git push` through the proxy** (21:44-21:51): `remote: QueenOS:` lines, gate passed (reviewer approved), fast-forward land, auto-ship. `/features/hello-human` was live on prod about 5 min after the push. Item eef3a971, train 8cea16d5, release 4f0b76d0.

**Oct 6 history (fixes already shipped):** Oracle one-item-per-bullet (5ab8ee2); transient infra never blames the change (ff3b0f5); smoke gate accepts non-404 under 500 (1d0d268); drones retry merge/land 503s (b21d68f); dispatch retry in 15 s (fd0a025) and the alarm fix (2b2cd55). Live prod page https://demo-app.kyle-477.workers.dev/ has the Toy box chips.

## 4. Deploy state (CRITICAL)

**Last production deploys (UTC):** Oct 14: queenos-mcp 02:31, edge 02:31, provisioner 02:32, queen 02:33 (rework loop). Oct 12: queenos-git 14:13 (steps b, d and efcccea now live). Oct 9: queen 20:41 and edge 20:42 (after eab6a7b). Oct 8: queen 18:12 and edge 18:14 (T9a/T9d), gatekeepers 16:33 (T4), **queenos-git 16:33 (T2n)**, edge 17:01 (T7 dashboard). Oct 7: queen 21:17, herald 21:18. provisioner/drones Oct 7 14:49-14:51.

**Rework loop deploy: DONE, 2026-10-14 (UTC).** queenos-mcp 02:31, queenos-edge 02:31, queenos-provisioner 02:32, queen 02:33. That shipped schema v19, the 19-tool MCP (`sync_base`, `reject`), the dashboard Reject / Reject all, and the regenerated worker-starter template. Commands used, for the record:

```
cd ~/repositories/queenos && export PATH=~/.nvm/versions/node/v24.17.0/bin:$PATH CLOUDFLARE_ACCOUNT_ID=4773fbabdff038e3b907b14cd212c062
./scripts/deploy.sh --only queen
./scripts/deploy.sh --only mcp
./scripts/deploy.sh --only edge
./scripts/deploy.sh --only provisioner
```

`--only queen` now needs `QUEENOS_URL=https://queenos.kaikeru.com` (with Access creds) or `--force`.

**Live checks run after the rework-loop deploy (record; results in §3)** (Herdr workers, hive `demo`, external executors):
1. **Conflict → sync_base → rebase → land.** An orchestrator files two goals editing the same file (`src/features.js`). Two workers each take one. The second winner reads REJECTED `kind: "conflict"` with `rework.dueAt`, calls `sync_base`, runs `syncCommand`, rebases onto `queen/main`, pushes `--force-with-lease`, and lands as the same candidate (same race id, no follow-up item). Check: `get_item` shows one race; the dashboard shows "Reworking · ... due in mm:ss" while it is fixed.
2. **Mid-race fix after entry close.** A goal with `entryWindowMs: 120000` and two workers; one pushes a deliberate lint failure. After the window closes it pushes the fix. The fix rejoins the race (no "(follow-up)" item) and the race decides with both.
3. **Reject all with a reason.** A `judge: "pick"` goal with two passing candidates. Click **Reject all**, type a reason, Send. The race goes back to RACING with entries open; both agents' `get_verdict` read `kind: "human"` with the reason; their fixes come back, and the race picks again.

Results: all three passed on 2026-10-14 (HANDOFF §3).

**MCP fix-wave deploy: DONE (confirmed via the deployments API, Oct 13 UTC).** queen, queenos-gatekeepers, queenos-mcp, queenos-edge and queenos-provisioner 14:10-14:12; queenos-genesis and queenos-drones 14:17-14:18. That wave shipped schema v18, `GateCommand.notBefore`, the 19-tool MCP, the registry header and the `-att-`/`-base-` slug guard. The **Access Bypass for `/mcp` is DONE** (Access app "QueenOS MCP (edge checks tokens)").

External mode is live on the Queen. Switch hive `demo` (or a new hive) to external with the dashboard "workers" select, or `PATCH /hives/<hive>/settings {"executors":"external"}`.
Verify with the Cloudflare deployments API before assuming it is or isn't done.

- **Access:** the user created a second Access app "QueenOS git (edge checks tokens)" on `queenos.kaikeru.com/git` with a **Bypass** policy (the edge checks `qgt_` tokens itself). Verified: `/git` without creds gives 401 Basic; the dashboard still 302s to Access.
- **Deploying the git and MCP Workers:** `scripts/deploy.sh` now deploys `git` and `mcp` before the edge (`--only git` / `--only mcp`). The edge's `GIT` service binding needs `git` first.
- **Order:** gatekeepers before the Queen (the Queen binds `gatekeeper-workflow` for its own gates). Design §13: queen -> provisioner, drones, gatekeepers -> git Worker -> edge.
- `deploy.sh` runs a v1-train safety check (R16 guard). Redeploying an existing Queen needs `QUEENOS_URL=https://queenos.kaikeru.com` plus `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` (or `CF_ACCESS_TOKEN`), or `--force`. The check is skipped when the Queen was never deployed. With no in-flight trains a plain `--only <worker>` is fine.
- **Live config:** governor lease 12 builds (`SWARM_AI_RPM` 240, `SWARM_RPM_PER_BUILD` 20); hive `demo` autonomous, `maxChildrenPerItem` 12; `ANALYTICS_API_TOKEN` NOT set by design.
- **Do not deploy the Queen from a commit between 33d28ed and 191c167.** Main is fine.

## 5. How to push code, and how to run a swarm

### How to push code (human or agent)
- **Mint a token:** use the dashboard page `/p/<hive>/push` (T7: mint once-shown token, list, revoke, copyable clone/push instructions). Old way, in the dashboard tab's DevTools console (Cmd+Opt+J; type `allow pasting` first if Chrome asks):
  ```js
  await fetch('/api/git-tokens',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label:'first push'})}).then(r=>r.json())
  ```
  The `token` (`qgt_...`) is shown once. The user does this, not the coordinator.
- **Clone:** `git -c credential.helper='cache --timeout=3600' clone https://queenos.kaikeru.com/git/demo ~/queen-demo`. Username is anything; password is the token.
- **Add a feature:** `src/features/<slug>.js` exports `slug` and `handle(request)`; register it in `src/features/index.js` with an `import * as fX from "./x.js"` line and in the `features` array.
- **Push a branch:** `git push origin HEAD`. Use `item/<id>` or `goal/<slug>` branch names to join an item's race. Agents sharing one token push `item/<id>/<agent-name>` (or `goal/<slug>/<agent-name>`) so each is its own candidate instead of superseding the others. Pushing to `main` is refused.
- **Verdict notes:** `git fetch origin '+refs/notes/*:refs/notes/*' && git log --notes=verdict -1` works (T2n, verified live Oct 8: `git log --notes=verdict` shows PASSED/LANDED for the hello-human push; refs/notes/{verdict,review,provenance} fetched by a real git client).

### How to run and watch a live swarm
- **Dashboard:** the user is signed in to Access in Chrome. Drive it with the Chrome tools (load via ToolSearch): `get_page_text` to read, `form_input` for the composer textarea. Clicks via `find` refs sometimes don't register; coordinates work.
- **Workflow instances** via the Cloudflare API (`CLOUDFLARE_API_TOKEN` is in the user's shell): `GET /accounts/{id}/workflows/<name>/instances?per_page=...` for `oracle-workflow`, `drone-workflow`, `gatekeeper-workflow`, `herald-workflow`, `sentinel-workflow`, `provisioner-workflow`. Step outputs are truncated.
- **Watcher:** `watch.py` polled all six workflows every 30 s and printed only changes. The scratchpad is ephemeral; it is easy to recreate (Python, the workflows instances API above).
- **Queen event log** through the edge: `https://queenos.kaikeru.com/hives/demo/events?limit=40` (needs the Access cookie). **Queue page `/p/demo/queue`** is the best debugging view. Workers observability logs exist for the Queen DO.
- Live latency: builds 40-220 s; drone generation budget 200 s; watchdog 10 min.

## 6. Next steps (recommended order; ONE at a time, ask first)

**NEXT: dashboard redesign for the agent/race direction.** Needs a brainstorm and a spec first (use the brainstorming skill); do not start coding. Points the user raised from the rework-loop live checks:
- Goal and item pages must never differ, on any hive (swarm too). Make one page per goal that shows its work: all child items, and each item's race with pick/reject.
- Pick / Reject must be reachable from the War Room and the goal page. The user could not find them (they live only on the `-c1` item page).
- PICKING races and passed candidates must not show as "building" or TESTING (War Room "2 building", item badge "ACTIVE · building", attempt rows TESTING). The UI must read the race state.
- Show each candidate's preview LINK as soon as the agent submits, during RACING, so the human can judge early and decide to end the race. Never embed previews (no iframes). Never show previews of rejected or superseded heads; only each candidate's current live preview.
- Add a dashboard "close entries" action. Consider auto-closing a reopened window once every rejected candidate has re-passed: reject-all otherwise waits the full `reworkWindowMs` (30 min).
- The War Room is crowded and the lanes page is unused, so remove the lanes page. The user wants a more elegant UI overall.

Smaller follow-ups after that:
- Investigate gate/preview infra failures (w4 hit them twice in one session).
- The AI reviewer repeatedly flags "not registered in index" from its diff-only view (false positives that cost rounds).

Deferred minors from the rework-loop review: `.superpowers/sdd/2026-10-13-queenos-rework-loop/final-review.md` §2 (all OK-TO-DEFER, including the R4 residual, whose proper fix needs a v20 column recording the slot's race id on the attempt).

**Done Oct 8:** T9a/T9d you-pick races (0cd85a5, deployed: Queen PICKING state, pick route `POST /hives/:hive/races/:raceId/pick`, deadline auto-pick, `maxPickingRaces` cap, sim `[you-pick]`; dashboard Pick view + "you pick (3)" composer option; NOT yet seen live or in a browser; not built: re-pick after the winner boarded a car (409), a human push joining a PICKING race as a candidate). T2n notes pack (fa648e6 + 6e53603: bounded LRU cache, refresh TTL, SHA validation, 9 cache tests) and T7 dashboard (03609d9: Push code page, origin badges, landed-in-window count; user eyeballed it, looks good). Full gate 46/46.

**Done Oct 9: step (a), efcccea** (pushed, LIVE; Queen 707 tests, full gate 46/46). Per-hive `executors: "swarm" | "external"`, default `swarm` (no migration; lives in the settings overrides JSON).
- **queen-types:** `ExecutorsModeSchema`; optional `executors` on HiveSettings, overrides and `UpdateHiveSettings` (`PATCH /hives/:hive/settings`).
- **Queen ledger (external hives):** READY items wait with waitReason "awaiting submissions" unless a pushed train is parked for them (then dispatch at width 1, which resumes the parked train). Goals skip the Oracle and file exactly one child (the inbox), so `goal/<slug>` pushes resolve to it. Follow-ups skip TRIAGE. The `handoff` action returns 409. Reconcile settles items left DECOMPOSING/TRIAGE from before a switch (no escalation).
- **Planner:** no drone REWORK in external hives (a failure awaits the contributor; handoffs and the `Queen: rework` trailer are ignored, no "swarm takes over" remote line). Parked trains don't count against capacity (external only). MERGE/LANDER drones unchanged. Swarm mode unchanged.
- **Dashboard:** "workers" select (swarm / external agents) next to autonomy. In external mode the StatusHome composer becomes "FILE AN ITEM FOR AGENTS" (judge auto / you pick, `decompose:true`); the War Room composer is relabelled with no demo-swarm button (it still files a plain feature item, which is a valid inbox); SwarmFloor and Model Board are hidden; ItemView shows a copyable `git push origin HEAD:item/<id>`.
- **Tests:** new `apps/queen/test/external-mode.test.ts` plus ledger/planner/queen-types/dashboard tests.

**NEW DIRECTION (user, Oct 8): hide the Oracle/drone swarm (not stable enough) and make external coding agents the workers.** New demo script:
1. Create a new project (hive); the template ships `AGENTS.md` + skills (extend the `plugins/queenos` queenos-inbox skill) so agents know the API and the notes protocol.
2. A primary agent files a goal; Claude sessions of different models (Haiku/Sonnet/Opus) each register as a worker (agent identity + declared model, shown as "claims <model>": self-reported, unverified) and race on it by pushing `item/<id>`.
3. We look at results and live previews (existing train fork + gates + Worker Preview).
4. We pick a winner (T9) and it publishes (land + auto-ship).
5. Several goals in flight show the merge train (give goals overlapping paths so cars batch/conflict).
Build order (Opus for the planner part, Sonnet for UI/template): (a) **DONE Oct 9 (efcccea, see above)**: per-hive `executors: "external"` mode; code + sim stay as the fallback recording; (d) **DONE Oct 9 (step (d), see item 1)**; (b) **DONE Oct 9 (step (b), see item 1)**: agent identity on git tokens (`agent:<name>`, declared model) shown in the origin badge; (e) DONE Oct 12; (b3) and (f) skipped unless time remains; (b2) **QueenOS agent API keys (deferred: bigger, needs a user-configured Access Bypass path)**: non-human principals, minted by a human in the dashboard (the Push code page grows an "Agent keys" section), hive-scoped, shown once, stored hashed (extend the edge `HiveRegistry` `git_tokens` table with kind + scopes, or add a sibling table), revocable, with scopes like `goals:create`, `inbox:submit`, `worker:register`, `races:read`; an agent can never mint keys. Optional per-key rate/race caps so a runaway agent can't burn credits. Edge: new `/api/agent/*` (and reuse `/git/*`) routes authenticated by the key and forwarded with `x-queen-user: agent:<name>`; this needs another Access Bypass path, which the USER configures. A key may register itself as a worker (name + claimed model) and create goals/inboxes; all of it is audited in the event log and shown via the origin badge. (b3) **Notes/trailers for the inbox target**: the item is the inbox; correlation today is branch `item/<id>` or commit trailer `Queen-Item` (docs/agent-protocol.md), and Queen's synthesized notes already carry `Queen-Item/Train/Trace/Model`. Add: `Queen-Goal: <goalId|slug>` commit trailer so a registered worker can push to a goal without knowing the item id (proxy resolves it); agents also set `Queen-Model` (claimed) next to `Queen-Origin`; proxy refuses a push whose branch item and `Queen-Item` trailer disagree (verify what it does today); agents never write verdict/review notes (synthesized, trusted), an optional untrusted `refs/notes/agent` self-report is shown as such. Update `docs/agent-protocol.md`, the plugin skill and the template `AGENTS.md`. (c) route that files an item/race without the Oracle (`FileWorkItem` already has bestOf/judge; mostly covered by (a): external goals file one inbox child and the dashboard composer files an item); (d) dynamic race entry so pushes by distinct agents to a RACING item become candidates (design 2.5, `entryClosesAt`; DONE Oct 9, 35d851c); (e) **DONE Oct 12 (927c875)**: hive template with AGENTS.md + skills; (f) SSE/long-poll "picked or landed" endpoint for `queen-wait.sh`; (g) rehearse with 3 real Claude Code sessions. Target before the Oct 12 recording cutoff, else cut.
**Dogfooding QueenOS on itself** (post Oct 14): needs an external gate (verdict webhook, "bring your CI") because gatekeepers can't run pnpm/turbo; a release-off hive mode (job ends at landed on main); a history import path (the proxy refuses main); a GitHub mirror; a separate hive on the prod Queen so a bad Queen deploy can't strand the train.

1. **Next: retest the MCP path live** (after the §4 deploys): force an infra failure if feasible (for example make the reviewer unavailable for one gate), else just rerun a race on `demo`, and check the new behaviour: automatic re-gate, `kind: "infra"` plus `retry_gates`, `retryable` errors, `setupCommand`. Also run the P4 2 h token re-check (spec §13.1). Then write a short spec for **"reject all with reason" in you-pick races** (the human can say none of the candidates is acceptable and give the reason back to the agents). Ask the user before starting.

   **Done Oct 9: step (b) agent identity on git tokens** (eab6a7b, pushed, LIVE; Queen 751 (+1 skipped), git 101, edge 85, queen-types 126, dashboard 208; full gate 46/46):
   - **Mint:** `POST /api/git-tokens` takes `agent: {name, model?}`; the Push code page has name and model fields. The edge registry `git_tokens` gains `agent_name`, `agent_model`.
   - **Edge → git:** trusted `x-queen-agent` / `x-queen-agent-model` headers; client copies are stripped on every path. queenos-git validates them (401 if malformed) and refuses a branch handle suffix that differs from the token's agent name.
   - **Queen (schema v16):** `submissions.agent`; origin `{kind:"agent", id:"<name>@<owner>", model?}` comes from the token and overrides the `Queen-Origin` trailer (still used for human tokens). Supersede and same-head retry are keyed by (owner, ref, agent); caps stay per owner email. The claimed model never reaches the router or `model_stats`. OriginChip shows "claims <model>".

   **Done Oct 9: step (d) dynamic race entry** (35d851c, pushed, LIVE; Queen 738 tests, git 80, queen-types 121, dashboard 201; full gate 46/46). External hives only:
   - **Entry window:** a push-opened race has `entryClosesAt` = first push + `race.entryWindowMs` (default 15 min, `ENTRY_WINDOW_DEFAULT_MS`, range 0..1 h, set via `PATCH /settings`). The race is not decided before close (passes and all-failed are held); first-pass grace counts from max(now, close); the watchdog wakes at a future close.
   - **Close early:** `POST /hives/:hive/races/:raceId/close-entries` (RPC `closeRaceEntries`; 409 if not RACING, already closed, or no window; event `race.entries-closed`), then auto-decide or PICKING. Dashboard `RaceEntries` box on ItemView (countdown + "End entries now").
   - **Agents sharing a token:** branch suffix `item/<id>/<agent>` / `goal/<slug>/<agent>` (shared `AGENT_HANDLE_RE` in queen-types, used by apps/git preReceive) so they race instead of superseding. A re-push after close files a follow-up (no supersede). The `remote:` line carries the close time (NOTES_HINT always stays last).
   - **Fixes:** RACING `deadlineAt` resets when no live pass remains; the watchdog ignores past deadlines (fixed an alarm spin).
2. **Deploy the provisioner for (e)** (user, §4), and look at external mode in a browser/live (not yet seen live).
3. **Live-check T9** (sim: `pnpm --filter @queenos/queen dev:sim`, file a prompt with `[you-pick]`; prod: "you pick (3)" in the composer), then **T9b manual reject** (cheap; design §10.4) if wanted. T9c preference weighting is cut to a "next" slide. Ask the user before starting.
4. **T5 drones:** the REWORK brief comes from notes; the rework commit writes `Queen-Replies-To`.
5. **T6 sim** (the sim already gates pushed code via GATE commands); the all-sim fallback recording needs inbox and pick in the sim. Known: the sim has no git push, so an external hive in `dev:sim` just waits.
6. **T8:** `git` added to `deploy.sh` (done, 3c582a6). Still open: update the plugin and agent-protocol for the proxy UX and the `---` note entry separator (from T0b); live rehearsal.
7. **README / video reframe:** README part done (3c582a6, agent-native git, "Git, reimagined" table). Still open: a `docs/demo-script.md` update (it predates the merge-train graph and the git proxy). Demo beat: push, `remote:` lines, a deliberate edit-only push with `eval(` that gets REJECTED, a note in the terminal, Claude Code with the plugin fixes it, it lands.
8. **Optional / cut:** T1b drone adapter; an external-gate (verdict webhook) contract for "bring your CI"; the Queen reading `TrainResult.changedPaths` (from T4) to widen path claims; auto-correlation of uncorrelated pushes. Cut order if time runs out: T9c, T9b, T1b, `/t/<trainId>`.
9. **Also open:** demo prod cleanup of old internal feature slugs on the Toy box chips; no reliable live reviewer REJECT in the swarm path (the sim has `[review-fail]`); dashboard doesn't show whether the builder used recalled memories; 390 px layout only verified headless; mock mode (`VITE_MOCK_API=1`) has no POST actions (use `pnpm dev:sim`). Screenshots and video stay deferred until the user asks.

**Roadmap:** Oct 12-13 rehearsal and recording (go/no-go for an all-sim cut by Oct 12 noon); Oct 14 submit. **Dropped or stubbed:** bisect + auto-revert on staging failure (a P0 bug is filed instead), real npm builds, custom domains for project sites.

## 7. Architecture (12 Workers plus the dashboard)

| Worker (dir) | Role |
|---|---|
| `queen` (apps/queen) | `QueenNode` DO per hive: SQLite state, work ledger, `decide()` pipeline, merge queue, races, autonomy and error budget, model router, watchdog, event log, coalesced WS room. Git intake RPCs (`gitIntent` / `gitPushed` / `gitAborted` / `notesFor`). Attempt RPCs (v17 `attempts` ledger: `attemptIntent` / `attemptReady` / `attemptPushed` / `attemptRefresh` / `attemptEnd` ...). Also hosts the **`SwarmGovernor` DO**. Reachable only through the edge. `sim` env = localhost-only fakes. |
| `queenos-edge` (apps/edge) | `queenos.kaikeru.com` front door: Access JWT, dashboard assets, `/api/*` and `/hives/*` routing, `HiveRegistry` DO, `/api/metrics/:hive`. **`/git/*` route** (before Access middleware): `qgt_` token check (Basic/Bearer), 401 challenge, failure rate limit, forwards to the `GIT` service binding with `x-queen-user`; `/api/git-tokens` behind Access. `dev` env = auth bypass. **`/mcp` route**: Bearer `qgt_` only (push scope), forwards to the `MCP` service binding with the owner; the token is stripped before forwarding. |
| `queenos-git` (apps/git) | **Agent-native git proxy.** Smart-HTTP front door over Artifacts: pre-receive rules, `gitIntent`, one fork per push (+ readiness probe, `-rN` re-fork), ref rewrite, `remote:` lines, `gitPushed`/`gitAborted`, filtered read advert, read-only `/t/<trainId>`. No routes of its own (reached via the edge); notes pack (`notes-pack.ts`) synthesizes v1 notes from the Queen's `notesFor` (bounded per-hive LRU cache). |
| `queenos-mcp` (apps/mcp) | MCP server for agents: `QueenMcp` (McpAgent DO per session, owner-bound), `AgentIdentity` DO per agent, 16 tools. Forks the item's read-only race base `<hive>-base-<12hex>` and one attempt fork `<hive>-att-<12hex>` per attempt (forkRepo from `@queenos/hive-kit/artifacts`), mints 2 h fork-scoped tokens. Reached only via the edge's `MCP` binding. |
| `queenos-oracle` | Workflow: DECOMPOSE goals, TRIAGE bugs. |
| `queenos-provisioner` | Workflow: Artifacts fork/delete, CREATE_HIVE seeds from `templates/worker-starter`, recalls hive memories on FORK. |
| `queenos-drones` | Workflow: BUILD/REWORK/MERGE/LAND. Builder is a Think tool-loop agent (`docs/harness-design.md`) verifying in a Dynamic Worker. |
| `queenos-gatekeepers` | Workflow on `cf.artifacts.repo.pushed` and Queen-started gates: tree-diff policy/security scans, preview smoke, LLM reviewer (fails closed for non-drone origin), protected paths, Scribe, Vectorize failure log, hive memory. Queue cars get the integration gate. |
| `queenos-herald` | Workflow: Worker Preview per train, `<hive>-staging`, canary splits on `<hive>-app`, rollback. Creds from the Vault. |
| `queenos-sentinel` | Workflow: readiness gate, synthetic probes, PROMOTE/ROLLBACK/inconclusive. |
| `queenos-vault` | Per-hive AES-GCM envelope-encrypted creds. |
| `queenos-genesis` | Onboarding wizard DO. |
| dashboard (apps/dashboard) | React + Vite War Room, served by the edge. |

**Packages:** `queen-types` (all Zod contracts, incl. notes v1 and git intake), `hive-kit` (isomorphic-git + memfs, AI client, Cloudflare REST client, ledger, `HiveMemory`, helpers). **Plugin:** `plugins/queenos`.

**Flows:**
- **Swarm:** prompt -> Oracle -> items -> parallel BUILD trains from main (hard items race) -> gatekeepers -> cars -> MERGE drone -> integration gate -> LANDER fast-forward (bisect/conflict handling) -> staging -> Sentinel -> auto-ship if autonomous and budget green -> canary 1/10/50/100 -> SHIPPED, or auto-rollback + P0 bug.
- **Git push:** `git push` -> edge `/git/*` token check -> `queenos-git` (pre-receive rules, `gitIntent`, fork, ref rewrite) -> Queen `gitPushed` -> pre-forked train -> same gates/queue/release as drone builds -> verdict as notes + `remote:` lines + dashboard.

## 8. Account and infra facts (no secrets here)

- **Account** `4773fbabdff038e3b907b14cd212c062`, workers.dev subdomain `kyle-477`. Verify the token via `/accounts/{id}/tokens/verify`.
- **Access:** app "QueenOS" (id `798aa993-...`), AUD in `apps/edge/wrangler.jsonc`; team `kaikeru`, `@kaikeru.com` emails, one-time PIN. Second app "QueenOS git (edge checks tokens)" on `/git`, Bypass. Demo hive prod https://demo-app.kyle-477.workers.dev, staging https://demo-staging.kyle-477.workers.dev.
- **AI:** gateway `queenos`; all LLM calls via the Workers `ai` binding. Models from `MODEL_CATALOG` (`packages/queen-types/src/models.ts`, ordered by `docs/model-bakeoff.md`).
- **Other resources:** Vectorize `queenos-failures` and `queenos-memory` (768, cosine; metadata indexes `namespace`, `kind`); Artifacts namespace `queenos`; Analytics Engine `queenos_events`.
- **Secrets set:** `VAULT_KEK` (backup `~/.queenos/vault-kek.backup`; user asked to move to a password manager), `QUEEN_INTERNAL_TOKEN`. Not set: edge `ANALYTICS_API_TOKEN` (intentional).
- **Deploy:** `./scripts/deploy.sh` (two passes for cross-script binding cycles); a single NEW worker: `wrangler deploy --env=""` alone first; one existing worker: `--only <dir>`.
- **Hive memory:** one memory per gate verdict; recall up to 5 at FORK (cosine >= 0.6, same hive). Vectorize writes take up to ~1 min to be queryable; use `get-vectors --ids`.

## 9. Known issues and gotchas

- **Artifacts per-repo 503 episodes** right after a push (a fresh fork works). Handled by retire, re-fork and retry. The "ask Cloudflare" message waits on cf-rays: herald, gatekeepers and drones now capture them in error messages.
- **Workflows `createBatch` silently drops instances** on failure; never trust its result length (fixed in 34ac6aa).
- **Queen-started gates now apply to drone builds too** (926f991). Run a 2-item drone smoke goal after the next deploy to confirm the drone path.
- Vitest in `apps/git` warns that `env.test` in `wrangler.jsonc` doesn't inherit `durable_objects`/`artifacts` (harmless; clean up eventually).
- Oct 8 T2n commit (Antigravity) also added `AGENTS.md`/`GEMINI.md` and trimmed `CLAUDE.md`; review whether that was intended.
- Claude's Chrome profile isn't signed in to Access (needs the user's one-time PIN), so the coordinator can't view the dashboard; the user checks UI visually.
- `PIN` and the `inboxes` table (T0) are unused under rev 2 (kept for compatibility).
- Usage limits kill running agents; resume with SendMessage.
- **External mode gaps (efcccea):** default for new hives is still `swarm` (a New Project option belongs with step (e)).
- **Step (d) known gaps:** a re-push in the instant between `gitIntent` and `gitPushed` as the window closes can exceed `maxInboxOpenPerContributor` by one (the hourly cap still bounds it); an agent handle ending in `.` is accepted (git clients won't send it); no DOM click test for the "End entries now" button (no jsdom in the dashboard); no UI for `race.entryWindowMs`; any Access user can close entries on any hive (same model as pick); no per-race candidate cap (only `maxInboxPushesPerHour`).
- **Step (b) known gaps:** no `Queen-Model-Claimed` note trailer yet (b3); a human-token push with `Queen-Origin: agent:opus` and an agent token named `opus` of the same owner share origin id `opus@owner` (separate supersede chains, identical in the UI); agent tokens aren't hive-scoped (any hive); the edge `/hives/*` forwarder still passes the client `authorization` header through (needed by Queen internal webhooks via the edge; pre-existing; an Access user holding `QUEEN_INTERNAL_TOKEN` could call internal routes); `api.ts` `mintGitToken` still accepts a bare label string (unused).
- **Stale worktrees:** `.claude/worktrees/integration` (branch `dashboard-ux-batch`) and four `.claude/worktrees/agent-*` are fully merged into main and safe to remove; the integration one holds the old Oct 5 `docs/HANDOFF.md`.
- `AGENTS.md` now carries the tool-added repo-graph and ast-grep blocks (committed with step (d)).
- Templates: the no-build template serves features at `/features/<slug>` unless a feature declares its own `path`.
- Sentinel uses synthetic probes only (little traffic on demo apps).
- Pinned preview URLs (`<8hex>-<worker>...`) outlive teardown; Herald reports alias URLs.
- A failed first prod deploy stays FAILED while the candidate serves 100% (no stable version to roll back to).
- Dashboard tabs opened before a deploy show an "updated, reload" banner.
- Hives created before v2 stay `supervised` until switched (`PATCH /hives/<hive>/settings` or the dashboard dropdown).
- `docs/agent-protocol.md` section headings still carry `[T1-T3]`/`[T1-T2]` design-task markers (harmless).

## 10. Key docs

`README.md` (judge-facing; agent-native-git reframe done, 3c582a6), `CLAUDE.md` (rules), **`docs/human-push-design.md`** (rev 2: git proxy, Submissions, notes, races; §13 plan, §14 demo shot), **`docs/agent-protocol.md`** (v1 protocol for agents that speak git; plugin `plugins/queenos`), `docs/v2-design.md` (swarm design, decisions D1-D11 in §10), `apps/queen/README.md` (decide pipeline, routes, planners, release semantics), `docs/demo-script.md` (13 shots, sim-backed; predates merge-train graph and git proxy), `docs/discovery.md` + `docs/deploy-discovery.md` (API research), `docs/day1-results.md` (real-account facts), `docs/day1-verification.md`, `docs/model-bakeoff.md`, `docs/harness-spike.md`, `docs/harness-design.md`, `docs/harness-build-brief.md`.

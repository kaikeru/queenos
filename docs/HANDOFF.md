# QueenOS: session handoff

Last updated **2026-10-08** by the coordinating Claude session. Read this, then `CLAUDE.md`, `README.md`, `docs/human-push-design.md` (rev 2; §13 is the plan) and `docs/agent-protocol.md`, before doing anything. `docs/v2-design.md` (§1 principles, §10 decisions) is the older swarm design.

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

- **README TODO:** it still leads with the old "army of virtual engineers". Reframe it as agent-native git, plus the table above.
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
| Coordinator verifies | Per package: its own tests AND `tsc -p test` (vitest alone isn't enough). Then the full gate: `pnpm turbo run build typecheck lint test --force --continue` (**46/46 tasks** green on `main`). Then commit AND push `main` (`origin` = github.com/kaikeru/queenos). |
| Token scan before every commit | `/usr/bin/grep -rlF --exclude-dir=node_modules --exclude-dir=.wrangler --exclude-dir=.git -e "$CLOUDFLARE_API_TOKEN" .` Exit 1 = clean. Use `/usr/bin/grep`: plain `grep` is aliased to ugrep here, and a `--` before the excludes makes grep read them as filenames. |
| Commit messages | End with the attribution line your session's system reminder specifies. The user files GitHub issues: reference them (`Closes #n` / `Refs #n`); the roadmap outranks the issue backlog. |
| Node 24 | `export PATH=~/.nvm/versions/node/v24.17.0/bin:$PATH` (wrangler needs 22+). Full gate is capped at **turbo concurrency 4** (workerd suites flake under CPU oversubscription; Queen tests have a 20 s timeout). |
| Production deploys are the USER's | Auto mode blocks them. Give the user exact commands (a short list, or a scratchpad script; long pasted lines wrap and break). |
| User does security config | Auto mode blocks creating or changing Access apps via the API. The user does Access/security config themselves. |
| Credentials | The coordinator must not mint git tokens via the browser: that would put the credential in its context. |
| Usage limits | They kill ALL running agents at once. Resume them with SendMessage, in smaller batches. |
| Live sim checks | Run parallel ones on distinct ports (e.g. 8797, 5191). **Never `pkill`** (`-f vite`/`-f wrangler` once killed every vitest/wrangler on the machine). Kill only PIDs you started. |

## 2. State of the system

`main` is green (46/46 turbo tasks). v2 swarm (Phases 0-3) is complete; the git proxy path (T0-T4) is built and live. Swarm internals: `docs/v2-design.md` §8, `apps/queen/README.md`.

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

## 3. Proven live (queenos.kaikeru.com, hive `demo`)

**Oct 7:**
1. **12-item "final proof" swarm:** all 12 shipped autonomously in about 14 min, infra noise absorbed.
2. **4-item infra-check swarm** after the infra deploy: all landed. It exposed the createBatch bug (fixed 34ac6aa, deployed 15:24).
3. **First human `git push` through the proxy** (21:44-21:51): `remote: QueenOS:` lines, gate passed (reviewer approved), fast-forward land, auto-ship. `/features/hello-human` was live on prod about 5 min after the push. Item eef3a971, train 8cea16d5, release 4f0b76d0.

**Oct 6 history (fixes already shipped):** Oracle one-item-per-bullet (5ab8ee2); transient infra never blames the change (ff3b0f5); smoke gate accepts non-404 under 500 (1d0d268); drones retry merge/land 503s (b21d68f); dispatch retry in 15 s (fd0a025) and the alarm fix (2b2cd55). Live prod page https://demo-app.kyle-477.workers.dev/ has the Toy box chips.

## 4. Deploy state (CRITICAL)

**Last production deploys (UTC):** Oct 8: gatekeepers 16:33 (T4), **queenos-git 16:33 (T2n)**, edge 17:01 (T7 dashboard). Oct 7: queen 21:17, herald 21:18. provisioner/drones Oct 7 14:49-14:51.

**Nothing pending.** Gatekeepers (T4), queenos-git (T2n) and edge (T7) are deployed on current `main` (03609d9). Command for a future gatekeepers redeploy:
```
cd ~/repositories/queenos && export PATH=~/.nvm/versions/node/v24.17.0/bin:$PATH CLOUDFLARE_ACCOUNT_ID=4773fbabdff038e3b907b14cd212c062
./scripts/deploy.sh --only gatekeepers --force
```
Verify with the Cloudflare deployments API before assuming it is or isn't done.

- **Access:** the user created a second Access app "QueenOS git (edge checks tokens)" on `queenos.kaikeru.com/git` with a **Bypass** policy (the edge checks `qgt_` tokens itself). Verified: `/git` without creds gives 401 Basic; the dashboard still 302s to Access.
- **Deploying the git Worker:** `queenos-git` is NOT in `scripts/deploy.sh`'s WORKERS list yet (TODO, T8). Deploy it with `(cd apps/git && pnpm exec wrangler deploy)`, BEFORE the edge (the edge's `GIT` service binding needs it).
- **Order:** gatekeepers before the Queen (the Queen binds `gatekeeper-workflow` for its own gates). Design §13: queen -> provisioner, drones, gatekeepers -> git Worker -> edge.
- `deploy.sh` runs a v1-train safety check (R16 guard: needs `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` or `CF_ACCESS_TOKEN`). `--force` skips it. With no in-flight trains a plain `--only <worker>` is fine. Ignore the "one-time manual steps" footer.
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
- **Push a branch:** `git push origin HEAD`. Use `item/<id>` or `goal/<slug>` branch names to join an item's race. Pushing to `main` is refused.
- **Verdict notes:** `git fetch origin '+refs/notes/*:refs/notes/*' && git log --notes=verdict -1` works (T2n, verified live Oct 8: `git log --notes=verdict` shows PASSED/LANDED for the hello-human push; refs/notes/{verdict,review,provenance} fetched by a real git client).

### How to run and watch a live swarm
- **Dashboard:** the user is signed in to Access in Chrome. Drive it with the Chrome tools (load via ToolSearch): `get_page_text` to read, `form_input` for the composer textarea. Clicks via `find` refs sometimes don't register; coordinates work.
- **Workflow instances** via the Cloudflare API (`CLOUDFLARE_API_TOKEN` is in the user's shell): `GET /accounts/{id}/workflows/<name>/instances?per_page=...` for `oracle-workflow`, `drone-workflow`, `gatekeeper-workflow`, `herald-workflow`, `sentinel-workflow`, `provisioner-workflow`. Step outputs are truncated.
- **Watcher:** `watch.py` polled all six workflows every 30 s and printed only changes. The scratchpad is ephemeral; it is easy to recreate (Python, the workflows instances API above).
- **Queen event log** through the edge: `https://queenos.kaikeru.com/hives/demo/events?limit=40` (needs the Access cookie). **Queue page `/p/demo/queue`** is the best debugging view. Workers observability logs exist for the Queen DO.
- Live latency: builds 40-220 s; drone generation budget 200 s; watchdog 10 min.

## 6. Next steps (recommended order; ONE at a time, ask first)

**Done Oct 8:** T2n notes pack (fa648e6 + 6e53603: bounded LRU cache, refresh TTL, SHA validation, 9 cache tests) and T7 dashboard (03609d9: Push code page, origin badges, landed-in-window count; user eyeballed it, looks good). Full gate 46/46.

1. **T9a/T9d races and pick** (NEXT; maps to the challenge's "multi-change comparison and selection"). Ask the user before starting.
   T9b manual reject is cheap; T9c preference weighting is cut to a "next" slide.
2. **T5 drones:** the REWORK brief comes from notes; the rework commit writes `Queen-Replies-To`.
3. **T6 sim** (the sim already gates pushed code via GATE commands); the all-sim fallback recording needs inbox and pick in the sim.
4. **T8:** add `git` to `deploy.sh`; update the plugin and agent-protocol for the proxy UX and the `---` note entry separator (from T0b); live rehearsal.
5. **README / video reframe** (agent-native git, "Git, reimagined" table) and a `docs/demo-script.md` update (it predates the merge-train graph and the git proxy). Demo beat: push, `remote:` lines, a deliberate edit-only push with `eval(` that gets REJECTED, a note in the terminal, Claude Code with the plugin fixes it, it lands.
6. **Optional / cut:** T1b drone adapter; an external-gate (verdict webhook) contract for "bring your CI"; the Queen reading `TrainResult.changedPaths` (from T4) to widen path claims; auto-correlation of uncorrelated pushes. Cut order if time runs out: T9c, T9b, T9a/T9d, T1b, `/t/<trainId>`.
7. **Also open:** demo prod cleanup of old internal feature slugs on the Toy box chips; no reliable live reviewer REJECT in the swarm path (the sim has `[review-fail]`); dashboard doesn't show whether the builder used recalled memories; 390 px layout only verified headless; mock mode (`VITE_MOCK_API=1`) has no POST actions (use `pnpm dev:sim`). Screenshots and video stay deferred until the user asks.

**Roadmap:** Oct 12-13 rehearsal and recording (go/no-go for an all-sim cut by Oct 12 noon); Oct 14 submit. **Dropped or stubbed:** bisect + auto-revert on staging failure (a P0 bug is filed instead), real npm builds, custom domains for project sites.

## 7. Architecture (12 Workers plus the dashboard)

| Worker (dir) | Role |
|---|---|
| `queen` (apps/queen) | `QueenNode` DO per hive: SQLite state, work ledger, `decide()` pipeline, merge queue, races, autonomy and error budget, model router, watchdog, event log, coalesced WS room. Git intake RPCs (`gitIntent` / `gitPushed` / `gitAborted` / `notesFor`). Also hosts the **`SwarmGovernor` DO**. Reachable only through the edge. `sim` env = localhost-only fakes. |
| `queenos-edge` (apps/edge) | `queenos.kaikeru.com` front door: Access JWT, dashboard assets, `/api/*` and `/hives/*` routing, `HiveRegistry` DO, `/api/metrics/:hive`. **`/git/*` route** (before Access middleware): `qgt_` token check (Basic/Bearer), 401 challenge, failure rate limit, forwards to the `GIT` service binding with `x-queen-user`; `/api/git-tokens` behind Access. `dev` env = auth bypass. |
| `queenos-git` (apps/git) | **Agent-native git proxy.** Smart-HTTP front door over Artifacts: pre-receive rules, `gitIntent`, one fork per push (+ readiness probe, `-rN` re-fork), ref rewrite, `remote:` lines, `gitPushed`/`gitAborted`, filtered read advert, read-only `/t/<trainId>`. No routes of its own (reached via the edge); notes pack (`notes-pack.ts`) synthesizes v1 notes from the Queen's `notesFor` (bounded per-hive LRU cache). NOT in `deploy.sh` yet. |
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
- Templates: the no-build template serves features at `/features/<slug>` unless a feature declares its own `path`.
- Sentinel uses synthetic probes only (little traffic on demo apps).
- Pinned preview URLs (`<8hex>-<worker>...`) outlive teardown; Herald reports alias URLs.
- A failed first prod deploy stays FAILED while the candidate serves 100% (no stable version to roll back to).
- Dashboard tabs opened before a deploy show an "updated, reload" banner.
- Hives created before v2 stay `supervised` until switched (`PATCH /hives/<hive>/settings` or the dashboard dropdown).

## 10. Key docs

`README.md` (judge-facing; needs the agent-native-git reframe), `CLAUDE.md` (rules), **`docs/human-push-design.md`** (rev 2: git proxy, Submissions, notes, races; §13 plan, §14 demo shot), **`docs/agent-protocol.md`** (v1 protocol for agents that speak git; plugin `plugins/queenos`), `docs/v2-design.md` (swarm design, decisions D1-D11 in §10), `apps/queen/README.md` (decide pipeline, routes, planners, release semantics), `docs/demo-script.md` (13 shots, sim-backed; predates merge-train graph and git proxy), `docs/discovery.md` + `docs/deploy-discovery.md` (API research), `docs/day1-results.md` (real-account facts), `docs/day1-verification.md`, `docs/model-bakeoff.md`, `docs/harness-spike.md`, `docs/harness-design.md`, `docs/harness-build-brief.md`.

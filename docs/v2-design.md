# QueenOS v2: an army of virtual engineers (work ledger, parallel builds, merge queue, best-of-N, SRE observability)

Status: design, revised 2026-10-05 after the user's decisions (D1–D11 decided, §10). Build ends 2026-10-11; Oct 12–13 are for recording; the video is due 2026-10-14. Author: architect session.
Read with `docs/HANDOFF.md`, `apps/queen/README.md` and `packages/queen-types/src/*`.
**Addendum (2026-10-07):** `docs/human-push-design.md` covers the inbox (human and agent `git push`), the unified `Submission` intake and human-judged races (D12).

---

## 1. Summary and principles

**QueenOS is an army of virtual engineers.** It takes the practices that let human engineering organisations ship safely (decades of them) and adapts them for thousands of minds that work at machine speed: minutes per change instead of days, no meetings, and nobody who gets tired of re-running a pipeline. A user states goals. The Queen breaks them into tickets, hands the independent ones to many builder agents **at the same time**, reviews every change several ways, lands it through a merge queue, ships it through canaries, and files its own bugs when something breaks. Humans hear about it only when something escalates.

v1 turned one prompt into one train, built trains one after another (train k forked from train k-1), and waited for a human tap before any canary. v2 changes three things:
- **A work ledger.** A prompt fans out into work items (features, bugs, chores) with dependencies, and agents file their own bugs.
- **Parallel builds through a merge queue.** Independent items fork from main at the same moment and build concurrently. Only dependent items wait for each other. Passed builds board a speculative, batched merge queue that 3-way merges them onto main, re-validates the merged result, and lands it.
- **Autonomy with budgets.** Releases ship on their own while the gates, Sentinel and the error budget are green.

Everything leaves a trace: one trace id runs from item → build → merge-queue car → gate → release → Sentinel, and one event log is both the audit trail and the source of the dashboard's drill-downs.

### 1.1 The practices we adopt, and how each is adapted

Each row is something this design actually builds (the section is given). Nothing here is aspirational.

| practice (human origin) | what QueenOS does | adapted for machine speed and scale |
|---|---|---|
| **Ticketing / issue tracker** | The work ledger (§2.1): items with kind, priority, acceptance criteria, dependencies, links and a state machine. | Agents file tickets too (drone follow-ups, out-of-diff gate findings, rollbacks), behind hard caps and exact + vector dedupe so bugs can't breed bugs (§2.9). |
| **Design review / tech-lead planning** | The **Oracle** (§3.3) decomposes a goal into items, orders them by dependency, rates difficulty, and predicts which paths each item will touch. | Planning is a single structured LLM call that takes seconds and runs in parallel with everything else. Any failure falls back to "one item, the whole prompt", so planning never blocks work. |
| **Trunk-based development** | Every build forks from current main and lives minutes. Main is the only long-lived branch (§2.3). | There are no feature branches to rebase by hand. A branch that falls behind is merged by the queue or reworked by an agent. |
| **Code ownership (CODEOWNERS)** | **Path affinity** (§2.3.5): an active item temporarily owns the paths it is predicted to touch. Items that would overlap are serialised before they start. | Ownership is temporary (it lasts as long as the item is in flight) and is claimed automatically from the Oracle's prediction, widened by the paths the builder actually changed. |
| **Merge queue with speculative batching (bors / Zuul)** | The existing speculative merge train becomes the **merge queue** (§2.3.4): passed builds board *cars*; each car 3-way merges its members onto the speculative tip, is gated as a whole, and lands with a fast-forward push. A failed batch is bisected. | Cars stack speculatively (car k forks from car k-1 before k-1 lands), batches size themselves from whatever has passed, and a conflict becomes an agent-driven rebase (REWORK) rather than a human chore. |
| **CI gates and code review** | The gatekeepers (policy, security, preview smoke test, LLM reviewer against acceptance criteria) on every build, and again on every merged car (without the reviewer) before main moves. | Review is parallel and per-change, and it scores candidates as well as passing them. |
| **Prototype bake-offs** | **Races** (§2.3.6): hard items and reworks are built by 2–3 agents on different models from the same base, and the best passing one lands. | It is affordable because agents are cheap and the ranking is deterministic. |
| **Canary releases and automatic rollback** | Release planner + Sentinel: staging, then 1/10/50/100% with probes at each step; a bad step rolls back (v1, kept). | Promotion is automatic in `autonomous` hives (§2.4). |
| **SLOs and error budgets (SRE)** | The change-success SLO; an exhausted budget degrades the hive to `supervised` (§2.4, §2.8). | The budget gates *autonomy*, not just alerts. |
| **Incident escalation with runbooks** | Escalations with a fixed reason enum, a versioned `RUNBOOK`, and allowed actions (§2.5). | The Queen has already acted (parked, degraded, stopped) before a human is asked. |
| **Postmortems and institutional memory** | Every gate verdict is written to hive memory and recalled at the next fork (v1, kept). Rollbacks file a P0 bug carrying the verdict (§3.4). | Memory is machine-readable and recalled automatically into the next builder's prompt; nobody has to read it. |
| **WIP limits (Kanban)** | Concurrency controls (§2.9, §4): `maxActiveTrains` per hive, merge-queue depth and batch size, and a global ceiling leased from a `SwarmGovernor`. | The limits are derived from real platform quotas (Workers AI requests per minute, Workflows concurrency), not from team size. |
| **Distributed tracing** | One W3C-format trace id per goal across every executor (§2.6). | Our trace lives in our own event log, because platform tracing does not span a Workflow's lifetime. |

### 1.2 Principles

1. **The Queen decides, records, and dispatches. Nothing else.**
   - Every LLM call (decomposition, path prediction), every embedding and Vectorize query (dedupe), every git operation (build, merge, land), and every deploy or probe runs in an executor Workflow.
   - New Queen logic goes in pure planners in the style of `TrainPlanner` and `ReleasePlanner`: no I/O, no clock, no randomness. Each returns rows, effects and events.
   - **Two exceptions:**
     - fire-and-forget telemetry to Analytics Engine (D1);
     - a DO-to-DO lease call to the `SwarmGovernor` that runs *before* `decide()`, never inside it (D9).
2. **Extend, don't rewrite.**
   - A work item *is* a prompt run once it is dispatched (`prompt_runs.prompt_id = work_items.item_id`). REWORK stays the self-correction loop.
   - The speculative merge train is **kept and repurposed as the merge queue**. Its chained-fork, supersede, watchdog and lander code now carries merge *cars* instead of builds (§2.3.4).
   - Race candidates are ordinary build trains with a `race_id`.
3. **Parallel by default, serial only where correctness demands it.**
   - Builds serialise only on a declared dependency or a predicted path overlap.
   - Landing serialises only at the single point that must be serial: moving `main`.
4. **Autonomy is the default; safety comes from budgets, not ceremony.**
   - **Hard caps:** items, depth, children, active trains, race width, queue depth and batch size, daily credits.
   - **An error budget:** the change-failure SLO.
   - **A rollback streak breaker:** repeated rollbacks degrade a hive to `supervised` on their own.
5. **Every claim about a Cloudflare product matches its docs** (checked 2026-10-05, §2.8 and §4.1). Because Workers tracing is early beta and does not span Workflows, **our own trace ids live in our own event log**.
6. **Sim mode is a first-class target.** Every new executor op (including the MERGE drone) has a deterministic fake in `apps/queen/src/sim/sim-ports.ts`, driven by prompt markers. The sim must show dozens of builds at once.
7. **Build for dozens, don't preclude thousands** (§4). Everything the Oct 11 build adds is keyed by train or item id, so per-train state can move to sharded Durable Objects later without changing a contract.

---

## 2. Concepts and data model

### 2.1 WorkItem

One Queen-owned ticket. Kinds: `goal` (a user prompt that was decomposed, never built itself), `feature`, `bug`, `chore`.

| field | notes |
|---|---|
| `itemId` | UUID for root items. Decomposed children are `<goalId>-c<n>`, which is deterministic, so a re-delivered Oracle result is idempotent. |
| `kind`, `title` (≤120), `body` (≤4000), `acceptance[]` (≤8×200) | The builder prompt is composed from these (§2.2). |
| `priority` | 0..3 (P0..P3), default 2. The dispatch order is priority, then `seq`. |
| `status` | See the state machine. |
| `parentId`, `rootId`, `depth` | goal = depth 0, its children = 1, a bug a drone files against a child = 2. Capped by `maxDepth`. |
| `dependsOn[]` | Item ids that must be `LANDED` or `SHIPPED` before dispatch. |
| `paths[]` | **Predicted** path patterns (≤10; a file, or a directory ending in `/`) from the Oracle, a follow-up's `paths`, or the user. They drive path affinity (§2.3.5). Empty means unknown, which is treated optimistically. |
| `waitReason` | Why a READY item is not dispatched yet (`"affinity: src/theme.js held by G-c1"`, `"capacity 24/24"`, `"budget"`). Display only. |
| `source` | `{kind: user\|oracle\|drone\|gatekeeper\|sentinel\|queen, actor, itemId?, trainId?, releaseId?, commandId?}` |
| `traceId`, `spanId` | §2.6 |
| `difficulty` | `normal\|hard` (from the Oracle, or from the user's `bestOf`) |
| `bestOf` | An explicit race width from the user (1..5, capped), or null to let the Queen decide. |
| `attempts`, `conflicts` | `attempts` mirrors `prompt_runs.attempts` (gate failures), plus human retries. `conflicts` counts merge-conflict reworks separately (D7). |
| `duplicateOf`, `blockedReason`, `releaseId`, `escalationId` | links |

**States**

```
                 (user prompt, decompose=true)
                         │
                         ▼
                   ┌───────────┐  Oracle DECOMPOSE ok / fallback
                   │DECOMPOSING│──────────────────────────────┐ (goal → ACTIVE rollup)
                   └───────────┘                              ▼
 (auto-filed: drone/gate/queen)                         children filed
        │                                                     │
        ▼                                                     │
   ┌────────┐ Oracle TRIAGE: score ≥ 0.90 on an open item ┌────┴─────┐
   │ TRIAGE │────────────────────────────────────────────▶│DUPLICATE │ (human "not_duplicate" → READY)
   └───┬────┘                                             └──────────┘
       │ no duplicate        (user single item skips TRIAGE)
       ▼
  deps unmet? ──yes──▶ ┌────────┐ all deps LANDED ┌───────┐ dispatcher: slots free, budget,
                       │BLOCKED │────────────────▶│ READY │ autonomy != paused, no path-claim overlap
                       └────────┘                 └───┬───┘ (otherwise stays READY with waitReason)
                                                      │ TrainPlanner.submit (race width w)
                                                      ▼
                                                 ┌────────┐ member of a MERGED car ┌───────┐ release SHIPPED ┌────────┐
                                                 │ ACTIVE │───────────────────────▶│LANDED │────────────────▶│SHIPPED │
                                                 └───┬────┘                        └───────┘                 └────────┘
                                                     │ prompt FAILED (rework or conflict cap)
                                                     ▼
                                                 ┌────────┐ human "retry" → READY (attempts reset)
                                                 │ FAILED │ + escalation REWORK_EXHAUSTED
                                                 └────────┘
 TRIAGE / BLOCKED / READY / FAILED ──human "cancel"──▶ CANCELLED
```

ACTIVE has display sub-states, derived from the item's live build train and car: `building`, `gating`, `racing`, `queued` (passed, waiting to board a car), `merging`, `landing`, `reworking (conflict)`.

**Rules**
- **Goal status is a rollup of its children:**
  - DECOMPOSING until the children are filed;
  - then ACTIVE;
  - SHIPPED when every child is SHIPPED, DUPLICATE or CANCELLED;
  - FAILED when the remaining children are terminal and at least one FAILED.
- **A BLOCKED item whose dependency FAILED or was CANCELLED stays BLOCKED** with `blockedReason = "dependency <id> failed"`. It is not cascaded, and it shows under "blocked" on the home page.
- **Cancelling an ACTIVE item is not supported in v2** (§9).
- **ACTIVE → LANDED** happens when the car carrying the item's build train is MERGED (pushed to main), not when the build passes its own gate.
- **LANDED → SHIPPED** happens when a release whose `trainIds` contains a MERGED train of the item reaches SHIPPED. A canary rollback leaves the item LANDED: the code is still on main, the next release carries it again (`cutQueued(keepTrains)`), and a P0 bug is filed.

### 2.2 How a prompt becomes items

1. **Submission.**
   - The dashboard composer sends `submit_prompt {decompose: true}`.
   - `POST /hives/:hive/prompts` keeps v1 semantics by default (`decompose` defaults to false), so the curl quickstart and tests don't change.
2. **`decompose: false`.** One `feature` item is filed (title = first line, ≤120; body = full text; `paths: []`). It skips TRIAGE, because users are not deduped, and goes to READY.
3. **`decompose: true`.** One `goal` item is filed in DECOMPOSING, and an `OracleCommand{op: DECOMPOSE}` is issued:
   - `commandId = <itemId>-decompose-<n>`;
   - the planner model comes from the router role `planner`;
   - it carries up to 30 open item titles (with their `paths`) as context, and `limits.maxChildren`.
4. **The Oracle** (a Workflow, §3.3):
   - **repo listing:** a shallow clone of hive main lists up to 500 file paths (best effort; an empty list just makes path predictions weaker);
   - one JSON-schema LLM call, which returns ≤ `maxChildren` children with keys `c1..cN`, kind, title, body, acceptance, priority, difficulty, `dependsOn` (child keys only) and **`paths`** (≤10 patterns, chosen from the listing or as new files);
   - the system prompt says: "prefer fewer, independent items; 1 is fine; items that must edit the same existing file should depend on each other; new features go in new files";
   - for each child: embed, query `queenos-memory` with `filter {namespace: hive, kind: "work-item"}`, and upsert the child's vector (id `<goalId>-c<n>`). Optionally (cut line 4), the top-3 gate memories with score ≥ 0.75 add their recorded changed paths to the child's `paths`;
   - it returns `similar[]` per child.
5. **The Queen (`WorkPlanner.oracleResult`)** files the children:
   - **Duplicates:** a child whose best match scores ≥ `CHILD_DEDUPE_THRESHOLD` (0.92) against an item that still exists and is not terminal becomes DUPLICATE. The match is resolved through `duplicateOf` chains.
   - **Dependency keys** are mapped to item ids. A dependency cycle drops the edge that closes it, and an event is logged.
   - **Paths** are normalised (`assertRepoPath` rules; `GENERATED_PATHS` removed, §2.3.5).
   - **More than `maxChildren` children:** the extra ones are dropped, and escalation `GUARDRAIL_TRIPPED` (informational) is opened.
   - **`ok: false`, or the watchdog runs out:** fall back to one `feature` child with the whole prompt and no paths. The event is `item.decomposed {fallback: true}`. Prompts never get stuck.
6. **Builder prompt composition** (`apps/queen/src/work/compose.ts`, pure). `promptText` is `title\n\nbody\n\nAcceptance criteria:\n- a\n- b` (≤ `MAX_PROMPT_CHARS`). The gatekeepers' reviewer gets the same text, so acceptance criteria become review criteria for free.

### 2.3 Parallel builds and the merge queue

This section replaces v1's "builds stay chained". The train planner (`apps/queen/src/train/planner.ts`) now runs **two lanes** of trains, both stored in `merge_trains` and distinguished by `lane`:

| | **BUILD lane** (new behaviour) | **QUEUE lane** (v1's speculative train, repurposed) |
|---|---|---|
| one train per | build attempt of an item (race candidate, rework) | merge **car**: a batch of 1..`maxQueueBatch` passed build trains |
| forks from | **hive main**, always: independent items fork at the same moment | the previous active car (speculative tip), or main for the first car (v1's `forkSourceFor`) |
| "builder" | the BUILDER drone (an LLM) | the **MERGE drone**: deterministic 3-way merges, no LLM |
| preview + gate | yes: full gate (policy, security, smoke, LLM reviewer) | yes: integration gate (policy, security, smoke; no reviewer), skipped on the fast path |
| on failure | `fail()` → REWORK of the item (attempts +1) | **bisect** (batch > 1) or fail its single member (§2.3.4) |
| lands | never directly; it boards a car | the LANDER pushes the car head to main (fast-forward) at the head of the queue |
| `includedPrompts` | `[its own prompt]` | cumulative: every car ahead plus its own members (v1 semantics) |

#### 2.3.1 Dispatch and concurrency

- **One prompt run per active item.** When the dispatcher moves READY → ACTIVE it calls `TrainPlanner.submit({promptId: itemId, promptText: composed, raceWidth: w, difficulty})`. `prompt_runs.prompt_id = item_id`.
- **Item status follows the prompt status:** QUEUED/BUILDING/IN_TRAIN/EJECTED → ACTIVE, MERGED → LANDED, FAILED → FAILED.
- **Dispatch order** is priority, then `seq`. `WorkPlanner.dispatchReady(capacity, claims, budget)` walks READY items and dispatches an item only if all of these hold. An item that fails a check is skipped (it does not block lower items) and gets a `waitReason`:
  - effective autonomy ≠ `paused`;
  - the daily budget is not exhausted;
  - **slots:** active BUILD-lane trains (race candidates included) + `w` ≤ `min(maxActiveTrains, leasedSlots)`. `w` is lowered to fit, minimum 1. `leasedSlots` comes from the `SwarmGovernor` (§2.9, §4.3);
  - every dependency is LANDED or SHIPPED (dependencies are never dispatched speculatively; §9);
  - **no path-claim overlap** with an ACTIVE item (§2.3.5).
- **Many dispatches per decision.** One `decide()` may dispatch dozens of items. Their FORK commands are all sourced from hive main and leave in one batch (`createBatch`, up to 100 instances per call; §4.1).

#### 2.3.2 The BUILD lane

- `enqueue(prompt, action, w)` creates `w` BUILD trains with `forkSource = <namespace>` (hive main) and `includedPrompts = [promptId]`. Nothing waits for a predecessor: `forkSourceFor(t)` returns the namespace for every BUILD train, except a train with `waitForCarSeq` set (below).
- Fork → BUILDER → push → preview → gate is v1's pipeline unchanged. The gate result carries `score`. `BuildResult.changedPaths` (new) widens the item's path claims to what was actually touched.
- **Passing the gate:** the train moves to `PASSED` and records `passedSeq` (a monotonically increasing queue ticket). It is now **waiting to board** (`carId = null`). Its fork and preview stay alive until its car lands.
- **REWORK is unchanged in spirit:** `fail()` ejects the train and re-enqueues the prompt as REWORK with the Scribe summary, up to `maxReworks`. The rework width comes from the race policy (§2.3.6).
  - **What is gone:** supersede in the BUILD lane. Nothing forks from a build train, so a failed build never ejects anyone else.
- **`waitForCarSeq`** (conflict and integration reworks only): the rework train stays `WAITING_PARENT` until every QUEUE car with `seq ≤ waitForCarSeq` is terminal, and then forks from hive main. That way it rebases onto exactly the code it collided with, and never onto speculative content that might itself be bisected out.

#### 2.3.3 Why the merged result is re-validated, and how

Two changes that each pass their own gate can still break each other: a renamed helper and a new caller, two guards that each assume they run first, or two features that register the same slug. A clean textual merge proves nothing about behaviour. So **main only ever moves to a commit whose exact tree was gated.**

Options considered:
- **Re-gate every merge, one at a time.** Correct, but landing throughput becomes one gate cycle (~1.5–2 min) per item: ~30–40 items per hour per hive, which defeats parallel builds.
- **Optimistic merge, validate in staging, bisect and revert.** Fast, but main can be broken, and v2 cannot auto-revert yet (§9).
- **Chosen: Zuul/bors-style speculative batching.** Batch the passed builds into a car, 3-way merge them onto the speculative tip, gate the car as a whole, land every member with one fast-forward, and bisect when a car fails. The v1 speculative train already implements the hard part (chained forks, head-of-queue landing, supersede, watchdog), so it is mostly a repurpose.

The integration gate skips the LLM reviewer. Each member was already reviewed against its own acceptance criteria, and a merge does not change intent. That keeps a car gate to ~30–60 s plus the preview deploy.

**Fast path.** When a car has exactly one member, and the MERGE drone could fast-forward it (no car ahead, and nothing has landed since the member forked), the car's tree *is* the gated tree. The car skips its preview and gate (`MergeResult.fastForward = true`) and goes straight to PASSED. An idle hive therefore lands as fast as v1 did.

#### 2.3.4 The QUEUE lane (merge queue)

**Forming cars.** `formCars()` lives in `apps/queen/src/train/queue.ts` (pure) and is called wherever v1 called `maybeLand()`.
- While the number of active cars is below `maxQueueDepth` (default 3) and there are passed BUILD trains with `carId = null`, it forms a car.
- **Member order:**
  - pending bisect halves come first, as pinned compositions;
  - then the rest by item priority, then `passedSeq`;
  - up to `maxQueueBatch` members (default 4).
- **A car is a QUEUE-lane train:**
  - `includedPrompts` = the prompts of every car ahead + its members' prompts;
  - `members` = the member trainIds;
  - each member gets `carId`.
- The car forks from the previous active car once that car has pushed (the v1 `PUSHED` rule), or from main.
- Cars do **not** wait for more members to arrive. A car of 1 leaves immediately, and batches grow naturally when the queue is busy (dynamic batching).
- **Cars reuse `TrainPhase`; there are no new phases.** For a car, BUILDING means merging. A car's FORK carries no `recallQuery`, because there is no builder to feed memories to.
- **The v1 queue helpers become lane-aware:** `active()`, `predecessor()`, `maybeLand()` and supersede look at QUEUE-lane trains only.
- **Failure routing:** every v1 failure path (`trainResult` failed, `previewFailed`, `landFailed`, watchdog cap) still calls `fail(t)`. For a QUEUE train, `fail()` delegates to `queue.carFailed` (below).

**MERGE drone** (`apps/drones/src/merge.ts`, action `MERGE`). It is dispatched when the car's fork is READY, in place of a builder, with `task.members = [{trainId, promptId, artifactRepo, headSha, title}]`. Every step is idempotent: it uses fixed author and committer timestamps from the step, so a replayed step makes the same SHAs and the push becomes a no-op. The steps:
1. Clone the car fork's `main` (depth `LAND_DEPTH` = 100) into memfs.
2. For each member, in order:
   1. `fetchRef(member fork refs/heads/main → refs/queen/m/<trainId>, depth LAND_DEPTH)`, and check that `headSha` is present. If it is not, record conflict `kind: "missing"`.
   2. `git.findMergeBase([main, member])`:
      - 0 bases (shallow history): re-fetch both with full depth once (template repos are small); still 0 → `kind: "unsupported"`;
      - more than 1 base (criss-cross): `kind: "unsupported"`. isomorphic-git has no recursive strategy.
   3. `git.merge({ours: "main", theirs: "refs/queen/m/<trainId>", fastForward: true, abortOnConflict: true, mergeDriver: registryMergeDriver, author/committer: QUEEN_MERGE_IDENTITY @ step timestamp, message: "queue <carId>: merge <trainId> (<title>)"})`.
   4. Handle the outcome:
      - **clean:** main advances (a merge commit, or a fast-forward for the first member when the car base equals the member's base). Record the member as `merged`.
      - **`MergeConflictError`**: isomorphic-git 1.42.6 throws it with `data.{filepaths, bothModified, deleteByUs, deleteByTheirs}`. With `abortOnConflict: true` the index and worktree are untouched and main has not moved. Record `{trainId, kind: "content", paths: filepaths}` and continue with the next member.
      - **`MergeNotSupportedError`** (add/add with different content, mode or type changes; no data): compute the overlap with hive-kit `changedPaths(repo, base, member) ∩ changedPaths(repo, base, main)`, record `kind: "unsupported"`, and continue.
3. If anything merged, push `main` to the car fork. Report `MergeResult {trainId: carId, ok: true, headSha, baseSha, merged[], conflicts[], fastForward}` via `reportMergeResult`.

**`registryMergeDriver`** (`packages/hive-kit/src/merge-driver.ts`). The template's `src/features/index.js` is a generated registry, and *every* feature build appends a line to it, so a plain diff3 merge would conflict on every concurrent pair.
- For paths in `GENERATED_PATHS`, the driver computes `renderRegistry(ours ∪ theirs − removedInEither)` from the base, ours and theirs module lists, reusing `registryModules` and `renderRegistry` (moved from `apps/drones/src/scripted.ts` into hive-kit).
- Every other path uses isomorphic-git's built-in diff3 (the default driver).
- This is the agent equivalent of a `.gitattributes merge=union`.

**The Queen on `mergeResult(car, r)`** (`TrainPlanner.mergeResult`, delegating to `queue.ts`). Its command-id, stale and duplicate guards are the same as `buildResult`'s.
- **Conflicting members leave the car before anyone forks from it.** Successor cars fork only after this car has pushed, and this result *is* the push. So:
  - the planner rewrites `members` and `includedPrompts` on this car and every later car (those cars are still `WAITING_PARENT`);
  - each conflicting member is `fail()`ed with a **deterministic conflict summary as the Scribe summary**: `"Merge conflict: your change and work that landed ahead of you both edit src/theme.js (content). Re-apply your change on top of the current main and keep both behaviours."`;
  - that REWORK gets `waitForCarSeq = car.seq` and adds the conflict paths to the item's claims;
  - it increments `conflicts`, not `attempts` (D7). Past `maxConflictReworks` (default 2), the item is FAILED with `REWORK_EXHAUSTED`.
- **`merged = []`:** the car is EJECTED (`"no members merged"`, no blame) and its fork deleted. The next car's predecessor becomes the car ahead, so `forkSourceFor` re-derives correctly.
- **`fastForward`:** the car goes to PASSED (fast path). **Otherwise:** DEPLOYING → preview → TESTING, exactly as v1. The gatekeepers recognise a car through `getGateTarget(repo).lane = "QUEUE"` and run the integration gate on the diff `car.baseSha..headSha`. The smoke test covers `/`, `/health`, and every member's feature routes.

**Landing.** `maybeLand()` is v1's code: the head car (every earlier car MERGED) in PASSED → LANDING → the LANDER pushes `car.headSha` to hive main.
- **It is always a fast-forward.** The first car forked from main, each later car forked from the one ahead, and the queue is the only writer of main.
- **The lander also carries ledger notes** from every member fork (`task.members`), not only the car fork.
- **`NOT_FAST_FORWARD`** (a human pushed main) → `landFailed(car)` → the car is treated as an infra failure below.
- **On `landResult(landed)`:**
  - the car → MERGED;
  - each member BUILD train → MERGED with `landedSha`, its fork deleted and its preview torn down;
  - prompts → MERGED, items → LANDED;
  - `rp.landed({sha, trainIds: members})`. Releases list member BUILD trains, so the item → SHIPPED rule is unchanged.

**A failing car** (gate failed, preview failed, or the MERGE or LANDER drone exhausted its watchdog) runs `queue.carFailed(car, summary)`:
1. **The car and every later car whose `includedPrompts` overlap it are EJECTED** (v1 supersede). Their members return to the pool (`carId = null`) with no attempt charged, and are re-boarded by `formCars()`.
2. **Gate failure on a car of more than one member: bisect.** Pin two new compositions: the first half, then the second half. `formCars()` boards them first, the second half stacked speculatively on the first, so they are gated in parallel. A half that passes lands. A half that fails bisects again. The cost is ≤ 2·⌈log₂ B⌉ extra car gates per bad batch.
3. **Gate failure on a car of one member:** the member is `fail()`ed with the summary `"Passed alone, fails integrated on main@<sha>: <gate summary>"`. That is a normal REWORK (attempts +1) with `waitForCarSeq`.
4. **Infra failure** (MERGE or LANDER drone lost, preview deploy failed, `NOT_FAST_FORWARD`): no bisect. Members return to the pool. After 3 consecutive infra-failed cars, `EXECUTOR_LOST` (subject hive) opens and car formation pauses until it is resolved.

**Why this keeps the old guarantees:**
- **REWORK:** it is the same `fail()` path, with one more source of Scribe summaries (conflicts and integration failures).
- **Watchdog:** `outstandingSince` already covers a car's fork, its "builder" (the MERGE drone runs in the BUILDING phase), deploy, LANDER, delete and teardown, so the watchdog is unchanged.
- **Supersede:** it now applies only to cars, which is exactly where speculative content is shared.

#### 2.3.5 Path affinity (conflict avoidance before it happens)

- **Claims.** When an item is dispatched, its `paths` become rows in `path_claims(path, item_id, source='predicted')`.
  - `BuildResult.changedPaths` adds `source='actual'` rows. Actual paths are the truth.
  - A conflict adds its conflict paths.
  - All of an item's claims are released when it is LANDED, FAILED or CANCELLED.
- **Overlap.** `pathsOverlap(a, b)` (pure, in queen-types): equal paths, or one is a directory prefix (ending `/`) of the other.
  - `GENERATED_PATHS` (`src/features/index.js`) never count, because the merge driver resolves them.
  - Empty `paths` never overlap. Unknown is treated as independent, and the merge queue is the safety net.
- **Dispatch.** A READY item whose paths overlap any claim held by another ACTIVE item is not dispatched. It gets `waitReason = "affinity: <path> held by <itemId>"` and an `affinity.wait` event (once per holder), and is dispatched in a later `decide()` when the claim is released.
  - **No deadlock:** only READY items wait, and only on ACTIVE holders, which never wait on claims.
  - **No starvation of priority:** the walk order is priority then `seq`, so a waiting P0 item is first in line when the claim frees.
- **Siblings from one goal** that the Oracle predicts will touch the same existing file are told to depend on each other (the system prompt rule in §2.2). Affinity catches the rest, including items from different goals and auto-filed bugs.
- This is code ownership for agents: the owner is whoever is working there right now, for minutes.

#### 2.3.6 Best-of-N (races)

Races compose with parallel builds without special cases. All candidates are BUILD trains that fork from hive main at the same moment, and only the winner boards a car.

- **Width policy.** `raceWidth()` in `apps/queen/src/train/race.ts` is pure:

  ```
  if modelPin                                  → 1
  w = item.bestOf ?? (action==REWORK ? settings.race.reworkWidth /*2*/
                    : item.difficulty=='hard' ? settings.race.hardWidth /*3*/ : 1)
  w = min(w, guardrails.maxRaceWidth /*3*/, slotsFree)
  if budget.remainingCredits < w × EST_BUILD_CREDITS[tier] → 1
  ```
- **Enqueue.** `TrainPlanner.enqueue(prompt, action, w)` with w > 1 creates a `races` row (`raceId`, `state: RACING`) and w BUILD trains:
  - consecutive `seq`, same `promptId`, `race_id = raceId`, `candidate = 0..w-1`;
  - each with its own fork of hive main (or, for a conflict rework, of main after `waitForCarSeq`), its own builder and its own preview. The gatekeepers find them by `artifactRepo`.
- **Models.** `router.routeRace(input, w)` returns w distinct models: the best by value at or above the starting tier, then the next distinct ones (preferring a different vendor prefix). Each candidate's `fallbacks` exclude its siblings' models. Race candidates never move the AIMD floor; model stats still count every candidate.
- **Planner rules:**
  - **A candidate passes its gate:** it stays in `TESTING` with `race_outcome = PASSED` and `gate_score` set. It does **not** board a car yet. If this is the first pass, the race gets `deadline_at = now + RACE_GRACE_MS` (90 s); the watchdog alarm covers it.
  - **A candidate fails** (its gate, its build, or the watchdog cap): `fail()` routes it to `raceCandidateFailed`, which ejects only that train (`reason "failed in race: …"`, fork deleted, preview torn down). No rework.
  - **The race is decided** when every candidate has reported, or at `deadline_at`.
    - With ≥1 pass: the winner = `rankCandidates()` → `phase PASSED`, `passedSeq` assigned (it is now waiting to board), `race_outcome WON`. Every other candidate is EJECTED with `reason "lost race to <id>: <why>"` and outcome LOST. Then `formCars()`.
    - With no pass: the normal `fail()` runs on the last candidate (attempts +1, REWORK with the *best* failure's Scribe summary). The race is `ABANDONED`.
  - v1's race-chaining rules are **gone**: build trains have no predecessor, so there is no need for `predecessor()` to skip races, or for successors to wait for a winner.
- **`rankCandidates`** (pure, deterministic, lexicographic):
  1. gate passed;
  2. reviewer `approved` > `skipped/off`;
  3. fewer `missing`, then more `satisfied`;
  4. builder `verified` (the Think `verify` tool passed);
  5. **fewer claimed paths outside the item's predicted `paths`** (less merge risk);
  6. smaller `changedBytes`;
  7. fewer `credits`;
  8. lower `candidate` index.

  The reason is recorded on the race and the winner, e.g. `"won: reviewer approved (4/0), 3.1 KB vs 9.8 KB; DeepSeek V4 Pro"`.
- **Gate score.** The gatekeepers add `score: GateScore` to `TrainResult` (review state, satisfied/missing counts, changedFiles, changedBytes, checks). Drones add `verified`, `usage` and `changedPaths` to `BuildResult`. All of these fields are optional, so a pre-v2 gate still decides on pass/fail and index.

#### 2.3.7 What we build by Oct 11, and what is deferred

**Built by Oct 11:**
- the BUILD lane forking from main;
- races;
- path affinity from Oracle predictions plus actual paths;
- the MERGE drone with the registry driver;
- cars with dynamic batching (`maxQueueBatch` 4, `maxQueueDepth` 3);
- the integration gate;
- the fast path;
- conflict → REWORK with `waitForCarSeq`;
- bisect;
- the multi-member LANDER.

**Cut line:** if Phase 2 runs late, set `maxQueueBatch = 1` (§8, cut line 6). Every car then has one member, bisect never runs, and parallel builds, the speculative queue, conflicts and reworks all still work.

**Deferred** (§9):
- an LLM **resolver drone** that fixes textual conflicts in place instead of a full rework;
- **stacked dispatch** of dependents on an unlanded dependency's fork;
- a recursive merge strategy (criss-cross);
- learned path predictions from git history;
- cars of mixed priority lanes (an express lane for P0 bugs).

### 2.4 Autonomy levels

| level | dispatch | release after staging PROMOTE |
|---|---|---|
| `autonomous` (default for new hives) | yes | auto-tap: `tappedBy = "queen:autonomous"`, straight to CANARY |
| `supervised` (today's behaviour) | yes | AWAITING_TAP + escalation `APPROVAL_REQUIRED` |
| `paused` (kill switch) | **no new items**; in-flight trains and releases finish | AWAITING_TAP (no new canaries start) |

- **Effective autonomy** comes from the pure function `effectiveAutonomy()` in `apps/queen/src/autonomy/policy.ts`: configured level → `supervised` if any of these holds:
  - **error budget exhausted:** the change-failure SLO, §2.8;
  - **`rollback_streak ≥ 2`:** consecutive ROLLED_BACK or canary-FAILED releases;
  - **an open `ROLLBACK_FAILED` escalation:** prod may be split.
- **The degradation is recorded.** It emits `autonomy.degraded` and shows its reasons on the home page. It lifts when the cause clears: the window slides, a release ships, or a human resolves the escalation with `resume_autonomy`, which also resets the streak.
- **Wiring into the release planner.** `ReleasePlanner` gets `ctx.autoShip: boolean` (computed by the Queen).
  - In `sentinelVerdict()` VALIDATING/PROMOTE: if `autoShip`, call the existing `tap()` body with the actor `AUTO_SHIP_ACTOR`; otherwise AWAITING_TAP.
  - `reconcile()` auto-taps an AWAITING_TAP release when `autoShip` turns true, unless it has an open `SENTINEL_INCONCLUSIVE` escalation.
- **Existing hives migrate as `supervised`** (decision D2), so the old AWAITING_TAP release on `demo` cannot auto-ship the intent-miss build.

### 2.5 Escalation (runbook-style)

`escalations` table. Each escalation has a `reason` from a fixed enum, a subject (item, release or hive), a summary, and the actions allowed. The runbook text is a static map `RUNBOOK[reason]` in queen-types (what happened, what the Queen already did, what each action does), so it is versioned with the code.

| reason | opened when | Queen already did | actions |
|---|---|---|---|
| `APPROVAL_REQUIRED` | supervised hive, staging PROMOTE | parked at AWAITING_TAP | `ship` (= tap), `hold` |
| `SENTINEL_INCONCLUSIVE` | verdict `inconclusive: true` on staging (readiness timeout or < ½ minRequests) | parked at AWAITING_TAP (even when autonomous) | `ship`, `hold` |
| `REWORK_EXHAUSTED` | item FAILED after `maxReworks` gate failures (races included) or `maxConflictReworks` merge conflicts | stopped; its claims released; Scribe or conflict summaries attached | `retry` (attempts and conflicts reset), `cancel` |
| `ROLLBACK_STREAK` | 2nd consecutive rollback | degraded to supervised; P0 bug filed per rollback | `resume_autonomy`, `ack` |
| `ROLLBACK_FAILED` | Herald rollback failed after its cap | prod may split traffic; supervised | `ack` (after a manual fix) |
| `ERROR_BUDGET_EXHAUSTED` | SLO budget < 0 | degraded to supervised | `resume_autonomy`, `ack` |
| `BUDGET_EXHAUSTED` | daily credits or dispatches hit | dispatch paused until the next UTC day | `raise_budget` (+50%), `ack` |
| `GUARDRAIL_TRIPPED` | children truncated, open-item cap hit by a user filing, depth exceeded on a user filing | dropped or truncated | `ack` |
| `EXECUTOR_LOST` | an Oracle, fork or deploy command exhausted its watchdog attempts; or 3 consecutive merge-queue cars failed on infrastructure (subject: hive) | item FAILED or fallback; car formation paused | `retry` (resumes the queue), `ack` |

- **Resolving.** Endpoint: `POST /hives/:hive/escalations/:id/resolve {action, note?}`. It is a user route: the edge sets `x-queen-user`, and `resolveUser` is checked. Each action maps to a planner transition (ship → `ReleasePlanner.tap`; retry → `WorkPlanner.retry`; and so on).
- **Lifecycle.** An escalation is `OPEN` → `RESOLVED`. The Queen auto-resolves stale ones: an APPROVAL_REQUIRED release that gets superseded resolves with `resolution: "superseded"`.

### 2.6 Trace model

- **`traceId`** is 32 lowercase hex characters, the W3C format.
  - A root item gets `itemId` with the dashes removed. UUIDs are 32 hex, and this makes migration backfill trivial.
  - Children of a goal share the goal's trace.
  - Auto-filed bugs start their **own** trace with a link (`source.itemId/trainId/releaseId`) to the cause, so traces stay bounded.
  - Each release gets its own trace (minted from `releaseId`) with links to the traces of its items.
- **`spanId`** is 16 hex, deterministic: `spanIdFor(key)` = FNV-1a 64 of `key`. It is pure and synchronous, which suits the planners.
  - item span: `spanIdFor(itemId)`, whose parent is the goal's span;
  - build train span: `spanIdFor(trainId)`, whose parent is the item span;
  - car span: `spanIdFor(carId)`. A car carries several items, so it is recorded in each member's trace as a child of that member's build-train span, with the same span id (one car, many traces);
  - command span: `spanIdFor(commandId)`, whose parent is the train span (or the release span or item span). This covers fork, deploy, teardown, drone instance, Oracle and Sentinel commands.
  - gate span: `spanIdFor("gate:" + trainId + ":" + sha)`;
  - executor step spans: `spanIdFor(commandId + "/" + stepName)`.
- **Propagation.**
  - Every command and `DroneTask` carries an optional `trace: {traceparent}` in its Workflow params (`00-<traceId>-<spanId>-01`).
  - Gatekeepers are started by Artifacts, not the Queen, so they read `traceId` from `getGateTarget(repo)`. For a car they log the trace id of each member.
  - Results are matched by `commandId`, so reports need no trace field. The Queen knows the span.
- **Where it shows up.**
  - (a) `event_log.trace_id/span_id/parent_span_id`, which feeds the trace view;
  - (b) every executor's structured `console.log({trace_id, span_id, parent_span_id, hive, command_id, step, ms, outcome})`, which Workers Logs can filter on (`observability.enabled: true`);
  - (c) optionally, Workers automatic tracing (`observability.traces.enabled`, early beta). Its own trace ids are separate from ours, and it only covers single invocations, not a Workflow's lifetime. It is supplementary.

### 2.7 Event log (supersedes `audit_trail`)

Decision: **`event_log` supersedes `audit_trail`.**
- Migration v10 copies `audit_trail` rows into `event_log` as `drone.audit`, and from then on `appendAudit` writes only `event_log`.
- `AuditEvent` (the snapshot's `recentAudit`, the lanes, and `builderReasoningFor` in the gatekeepers) is derived from `drone.audit` rows, so the contract is unchanged.
- `audit_trail` is kept read-only for one release, so a rollback of the Queen still works, and is dropped in a later migration.

**Columns**

| column | notes |
|---|---|
| `seq INTEGER PRIMARY KEY AUTOINCREMENT` | the cursor |
| `event_id`, `ts`, `hive` | |
| `type` | dotted names, see below |
| `severity` | `debug\|info\|warn\|error` |
| `actor` | `queen`, `user:<email>`, `drone:BUILDER`, `gatekeeper:REVIEWER`, `oracle`, `herald`, `sentinel`, `provisioner` |
| `trace_id`, `span_id`, `parent_span_id` | |
| `item_id`, `train_id`, `release_id`, `command_id` | |
| `summary` | ≤500 |
| `data` | JSON, ≤4 KB |
| `drone_role`, `audit_status`, `git_notes_payload` | ledger cards |

**Types:**
- items: `item.filed`, `item.status`, `item.decomposed`, `item.duplicate`;
- trains and races: `train.enqueued`, `train.phase`, `race.started`, `race.decided`;
- merge queue: `queue.car` (formed, with members), `queue.merged` (MergeResult summary), `queue.conflict` (per conflicting member, with paths), `queue.bisect` (split compositions), `queue.landed` (car sha + members);
- affinity: `affinity.claimed`, `affinity.wait` (once per holder per waiting item), `affinity.released`;
- commands: `command.issued`, `command.result`;
- drones and gates: `drone.audit`, `gate.verdict`;
- releases: `release.phase`, `release.autoshipped`, `sentinel.verdict`;
- escalations and autonomy: `escalation.opened`, `escalation.resolved`, `autonomy.degraded`, `autonomy.restored`, `hive.settings`;
- guardrails and follow-ups: `budget.exhausted`, `guardrail.tripped`, `followup.filed`, `followup.dropped`.

**Who writes what.** The planners stay pure:
- `TrainPlanner`, `ReleasePlanner` and `WorkPlanner` collect `EventDraft`s whenever a phase or status changes (inside `setTrain`, `set`, `setItem`) and return them in `PlanResult.events`.
- `QueenNode.apply()` adds `command.issued` for each non-broadcast effect and `command.result` (with the `Outcome`, e.g. `ignored:stale`) in each `report*` RPC.
- Everything is written in the same transaction as the rows.

**Broadcast and query.**
- `info`+ events are broadcast as `event.appended`. The snapshot carries the last 50.
- Query RPC `queryEvents(EventQuery)`, served at `GET /hives/:hive/events?trace=&item=&release=&type=&before=&limit=`. Indexes: `(trace_id, seq)`, `(item_id, seq)`, `(release_id, seq)`, `(type, seq)`.
- `GET /hives/:hive/traces/:traceId` returns the events plus the derived span tree. A span starts at `command.issued` and ends at `command.result`; train and item spans run from their first event to their last.

**Retention.** `pruneEvents()` in the alarm keeps 30 days or 100k rows, whichever is smaller. Summaries are capped, so that is ~100 MB worst case, well inside DO SQLite.

### 2.8 Metrics, SLOs and Cloudflare products

The doc facts below were checked on developers.cloudflare.com on 2026-10-05 (the scale-related limits are in §4.1):
- **Analytics Engine:**
  - binding: `analytics_engine_datasets`;
  - `writeDataPoint({blobs, doubles, indexes})` is non-blocking and need not be awaited;
  - ≤20 blobs (16 KB total), ≤20 doubles, 1 index (≤96 B), ≤250 points per invocation;
  - 3-month retention; SQL API at `POST /accounts/{id}/analytics_engine/sql`;
  - sampled, so weight with `_sample_interval`; functions include `quantileExactWeighted`, `sumIf` and `topKWeighted`.
- **Workers Logs:** `observability.enabled` plus `head_sampling_rate`; JSON `console.log` fields are indexed; 7 days of retention on paid plans; 256 KB per invocation.
- **Traces:** `observability.traces.enabled` is early beta; W3C propagation to outside services is not implemented.

**Two layers**

1. **Queen rollups in SQLite (authoritative, used for decisions, works in sim).**
   - `metrics_hourly(bucket, name, labels, count, sum, min, max)` is updated in the apply transaction from events.
   - Names:
     - items: `items_filed{kind,source}`, `items_landed{kind}`, `items_shipped{kind}`;
     - gates and races: `gate_verdicts{outcome,attempt}`, `races{width}`, `race_wins{model}`;
     - builds: `builds{model,role,outcome}`, `build_ms{model}`, `credits{role}`;
     - releases: `releases{outcome}`, `escalations{reason}`;
     - concurrency and queue: `active_builds` (a gauge, sampled into `max` on every apply), `queue_cars{outcome,size}`, `queue_wait_ms` (pass → land), `queue_conflicts{kind}`, `queue_bisects`, `affinity_waits`.
   - Lead time p50 and cycle time are computed on read from `work_items` timestamps over the window. N is small, so exact quantiles are fine.
   - The SLO and error budget are computed from the `releases` table (count-based, which suits low volume):
     - **SLO "change success"**: SHIPPED / (SHIPPED + ROLLED_BACK + canary-FAILED) over the last `slo.window` (20) terminal releases, target 0.9;
     - **error budget** = `floor((1 - target) × window) − failures`;
     - **`< 0` ⇒ exhausted** ⇒ `ERROR_BUDGET_EXHAUSTED` ⇒ effective `supervised`.
   - Lead-time and first-try-pass SLOs are shown on the dashboard but don't gate anything.
2. **Analytics Engine dataset `queenos_events` (long retention, cross-time drill-down, live only).** One point per notable event:
   - `indexes: [hive]` (the sampling key);
   - `blobs: [type, hive, kind_or_role, model, outcome, environment, trace_id, item_id]`;
   - `doubles: [value_ms, tokens_in, tokens_out, credits, 1]`.
   - **Writers:**
     - the Queen in `apply()`, after commit, never awaited, wrapped in try (decision D1);
     - drones (per build attempt and model);
     - Sentinel (per window: requests, errorRate, p99);
     - the Oracle (usage).
   - **Reader:** the edge's `GET /api/metrics/:hive?q=<name>`, a fixed allowlist of SQL templates (throughput per hour, lead-time quantiles, model win and pass rates, Sentinel p99). It needs secret `ANALYTICS_API_TOKEN` (Account Analytics Read).
   - The dashboard's Metrics page uses AE when the endpoint answers and falls back to the Queen rollups (sim).

### 2.9 Guardrails and budget (who can file what)

Defaults are in `GUARDRAIL_DEFAULTS` (queen-types). Per-hive overrides are clamped to `GUARDRAIL_MAX`.

| guardrail | default | max | on trip |
|---|---|---|---|
| `maxChildrenPerItem` | 8 | 12 | extras dropped, `GUARDRAIL_TRIPPED` |
| `maxDepth` | 2 | 3 | auto-filed: dropped (`followup.dropped`); user: 409 |
| `maxOpenItems` (non-terminal, hive) | 40 | 1000 | auto-filed dropped; user 409 |
| `maxActiveTrains` (BUILD lane, race candidates count) | 24 | 256 | dispatch waits (`waitReason: capacity`); race width shrinks |
| `maxQueueBatch` (members per car) | 4 | 16 | car formation stops at the cap |
| `maxQueueDepth` (active speculative cars) | 3 | 8 | passed builds wait to board |
| `maxConflictReworks` | 2 | 4 | item FAILED + `REWORK_EXHAUSTED` |
| global: `SWARM_MAX_ACTIVE_BUILDS` (env, `SwarmGovernor`) | 64 live / 1000 sim | n/a | `leasedSlots` caps the per-hive slots (§4.3) |
| global: `SWARM_AI_RPM` (env, `SwarmGovernor`) | 240 (80% of the 300 rpm text-generation default) | n/a | leases are also capped at `SWARM_AI_RPM / EST_RPM_PER_BUILD` (4) |
| `maxRaceWidth` | 3 | 5 | clamp |
| `maxAutoFiledPerHour` | 10 | 30 | dropped + one `GUARDRAIL_TRIPPED` per hour |
| `maxFollowUpsPerBuild` | 3 | 5 | truncated |
| `budget.dailyCredits` | 50,000 | n/a | `BUDGET_EXHAUSTED`, dispatch stops |
| `budget.dailyDispatches` (LLM drone + Oracle instances; MERGE and LANDER drones are deterministic and don't count) | 400 | n/a | same |

- **Credits.** `credits = (inputTokens + outputTokens) / 1000 × catalog cost`, from `BuildResult.usage` and `OracleResult.usage`. Scripted or sim drones report synthetic usage. Counters live in `hive_settings` and reset on the UTC day.

| source | may file | max priority | parent | dedupe |
|---|---|---|---|---|
| user (dashboard/API) | goal, feature, bug, chore | P0 | any or none | no (Oracle shows "similar to" hints) |
| oracle (DECOMPOSE) | feature, bug, chore | the goal's priority | the goal | 0.92 against open items |
| drone (`BuildResult.followUps`, out-of-scope only) | bug, chore | P2 (clamped) | the item being built (depth+1) | TRIAGE 0.90 |
| gatekeeper (`TrainResult.followUps`: findings in paths **outside the diff**) | bug | P1 security, P2 policy | none (link to item) | TRIAGE 0.90 |
| queen (Sentinel ROLLBACK, staging FAILED) | bug | P0 | none (link to release + items) | one per release (exact ref check) |

- **Exact dedupe before vector dedupe.** Before a TRIAGE command is issued, the Queen drops any auto-filed item with the same `(source.kind, source ref, normalized title)` as an open item. Vectorize writes take about a minute to become queryable, so this check comes first.

**Mapping the user's "gate failures and Scribe summaries become bugs"** (decision D3):
- A gate failure on an item's own diff is a **REWORK attempt on the same item**, which is today's loop. Its Scribe summary is that attempt's bug report, carried as `scribeSummary`.
- New bug items come from:
  - out-of-diff gate findings;
  - drone follow-ups;
  - Sentinel rollbacks and staging failures.
- Rework exhaustion escalates; it never files another bug. That breaks the loop.

---

### 2.10 Contract sketches (`packages/queen-types`)

All new fields on existing schemas are **optional**, so old executors, Queens and dashboards keep validating. Zod v4 (`z.record(z.string(), …)`).

```ts
// src/trace.ts (new)
export const TraceIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
export const SpanIdSchema = z.string().regex(/^[0-9a-f]{16}$/);
export const TraceparentSchema = z.string().regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
export const TraceContextSchema = z.object({ traceparent: TraceparentSchema, tracestate: z.string().max(256).optional() });
export type TraceContext = z.infer<typeof TraceContextSchema>;
export function traceIdFromUuid(uuid: string): string;            // dashes removed, lowercased
export function spanIdFor(key: string): string;                    // FNV-1a 64 → 16 hex, never all-zero
export function traceparent(traceId: string, spanId: string): string;
export function parseTraceparent(tp: string): { traceId: string; spanId: string } | null;
```

```ts
// src/work.ts (new)
export const WorkKindSchema = z.enum(["goal", "feature", "bug", "chore"]);
/** A repo-relative file, or a directory ending in "/". assertRepoPath rules; no globs. */
export const PathPatternSchema = z.string().min(1).max(200).regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._\/-]+$/);
/** Files resolved by a merge driver: never claimed, never a conflict. */
export const GENERATED_PATHS = ["src/features/index.js"] as const;
/** Equal, or one is a directory prefix ("dir/") of the other. GENERATED_PATHS never overlap. Pure; shared by Queen, sim, dashboard. */
export function pathsOverlap(a: readonly string[], b: readonly string[]): string[]; // returns the overlapping paths (from a)
export const WorkStatusSchema = z.enum(["TRIAGE", "DECOMPOSING", "BLOCKED", "READY", "ACTIVE", "LANDED", "SHIPPED", "FAILED", "DUPLICATE", "CANCELLED"]);
export const TERMINAL_WORK_STATUSES = ["SHIPPED", "DUPLICATE", "CANCELLED"] as const; // FAILED is terminal until a human retries
export const PrioritySchema = z.number().int().min(0).max(3);
export const DifficultySchema = z.enum(["normal", "hard"]);
export const WorkSourceSchema = z.object({
  kind: z.enum(["user", "oracle", "drone", "gatekeeper", "sentinel", "queen"]),
  actor: z.string().min(1).max(320),
  itemId: z.string().optional(), trainId: z.string().optional(),
  releaseId: z.string().optional(), commandId: z.string().optional(),
});
export const WorkItemSchema = z.object({
  itemId: z.string().min(1).max(64), hive: z.string().min(1),
  kind: WorkKindSchema, title: z.string().min(1).max(120), body: z.string().max(4000),
  acceptance: z.array(z.string().max(200)).max(8),
  priority: PrioritySchema, status: WorkStatusSchema,
  parentId: z.string().nullable(), rootId: z.string(), depth: z.number().int().min(0).max(3),
  dependsOn: z.array(z.string()).max(8), source: WorkSourceSchema,
  traceId: TraceIdSchema, spanId: SpanIdSchema,
  difficulty: DifficultySchema, bestOf: z.number().int().min(1).max(5).nullable(),
  attempts: z.number().int().min(0), conflicts: z.number().int().min(0).default(0),
  paths: z.array(PathPatternSchema).max(10).default([]), waitReason: z.string().max(200).nullable().default(null),
  duplicateOf: z.string().nullable(), blockedReason: z.string().max(200).nullable(),
  releaseId: z.string().nullable(), escalationId: z.string().nullable(),
  createdAt: z.number().int(), updatedAt: z.number().int(),
});
export const FollowUpSchema = z.object({
  kind: z.enum(["bug", "chore"]), title: z.string().min(1).max(120), body: z.string().max(1000),
  paths: z.array(z.string().max(200)).max(10).default([]), priority: z.number().int().min(1).max(3).default(2),
});
/** POST /hives/:hive/items (user). */
export const FileWorkItemSchema = z.object({
  kind: WorkKindSchema.exclude(["goal"]), title: z.string().min(1).max(120), body: z.string().max(4000).default(""),
  acceptance: z.array(z.string().max(200)).max(8).default([]), priority: PrioritySchema.default(2),
  parentId: z.string().optional(), dependsOn: z.array(z.string()).max(8).default([]),
  bestOf: z.number().int().min(1).max(5).optional(), difficulty: DifficultySchema.optional(),
  paths: z.array(PathPatternSchema).max(10).default([]),
});
export const WorkActionSchema = z.object({ action: z.enum(["retry", "cancel", "not_duplicate"]), note: z.string().max(500).optional() });
export const GuardrailsSchema = z.object({
  maxChildrenPerItem: z.number().int().min(1).max(12), maxDepth: z.number().int().min(1).max(3),
  maxOpenItems: z.number().int().min(1).max(1000), maxActiveTrains: z.number().int().min(1).max(256),
  maxRaceWidth: z.number().int().min(1).max(5), maxAutoFiledPerHour: z.number().int().min(0).max(30),
  maxFollowUpsPerBuild: z.number().int().min(0).max(5),
  maxQueueBatch: z.number().int().min(1).max(16), maxQueueDepth: z.number().int().min(1).max(8),
  maxConflictReworks: z.number().int().min(0).max(4),
});
export const GUARDRAIL_DEFAULTS = { maxChildrenPerItem: 8, maxDepth: 2, maxOpenItems: 40, maxActiveTrains: 24, maxRaceWidth: 3,
  maxAutoFiledPerHour: 10, maxFollowUpsPerBuild: 3, maxQueueBatch: 4, maxQueueDepth: 3, maxConflictReworks: 2 } as const;
export const DEDUPE_THRESHOLD = 0.9;
export const CHILD_DEDUPE_THRESHOLD = 0.92;
export const RACE_GRACE_MS = 90_000;
export const RaceSchema = z.object({
  raceId: z.string(), itemId: z.string(), width: z.number().int().min(2).max(5),
  state: z.enum(["RACING", "DECIDED", "ABANDONED"]), trainIds: z.array(z.string()),
  winnerTrainId: z.string().nullable(), reason: z.string().max(300).nullable(),
  deadlineAt: z.number().int().nullable(), createdAt: z.number().int(), decidedAt: z.number().int().nullable(),
});
```

```ts
// src/oracle.ts (new): the Oracle Workflow contract
export const OracleCommandSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("DECOMPOSE"), commandId: CommandId, hive: z.string().min(1), itemId: z.string().min(1),
    trace: TraceContextSchema.optional(), promptText: z.string().min(1).max(16_000),
    model: ModelChoiceSchema, // router role "planner"
    openItems: z.array(z.object({ itemId: z.string(), title: z.string().max(120), status: WorkStatusSchema,
      paths: z.array(PathPatternSchema).max(10).default([]) })).max(30),
    limits: z.object({ maxChildren: z.number().int().min(1).max(12) }),
  }),
  z.object({
    op: z.literal("TRIAGE"), commandId: CommandId, hive: z.string().min(1), itemId: z.string().min(1),
    trace: TraceContextSchema.optional(), kind: WorkKindSchema, title: z.string().max(120), body: z.string().max(2000),
  }),
]);
export const SimilarItemSchema = z.object({ itemId: z.string(), score: z.number() });
export const DecomposedChildSchema = z.object({
  key: z.string().regex(/^c\d{1,2}$/), kind: z.enum(["feature", "bug", "chore"]),
  title: z.string().min(1).max(120), body: z.string().max(2000), acceptance: z.array(z.string().max(200)).max(6).default([]),
  priority: PrioritySchema.default(2), difficulty: DifficultySchema.default("normal"),
  dependsOn: z.array(z.string().regex(/^c\d{1,2}$/)).max(6).default([]),
  paths: z.array(PathPatternSchema).max(10).default([]),           // predicted touch set (§2.3.5)
  similar: z.array(SimilarItemSchema).max(3).default([]),
});
export const OracleResultSchema = z.object({
  commandId: CommandId, op: z.enum(["DECOMPOSE", "TRIAGE"]), itemId: z.string(), ok: z.boolean(),
  children: z.array(DecomposedChildSchema).max(12).optional(), // DECOMPOSE
  similar: z.array(SimilarItemSchema).max(5).optional(),        // TRIAGE
  model: z.string().optional(), usage: BuildUsageSchema.optional(), summary: z.string().max(500).default(""),
});
export const WORK_ITEM_VECTOR_KIND = "work-item"; // Vectorize metadata `kind` in queenos-memory
```

```ts
// src/autonomy.ts (new)
export const AutonomyLevelSchema = z.enum(["autonomous", "supervised", "paused"]);
export const AUTO_SHIP_ACTOR = "queen:autonomous";
export const EscalationReasonSchema = z.enum(["APPROVAL_REQUIRED", "SENTINEL_INCONCLUSIVE", "REWORK_EXHAUSTED", "ROLLBACK_STREAK",
  "ROLLBACK_FAILED", "ERROR_BUDGET_EXHAUSTED", "BUDGET_EXHAUSTED", "GUARDRAIL_TRIPPED", "EXECUTOR_LOST"]);
export const EscalationActionSchema = z.enum(["ship", "hold", "retry", "cancel", "resume_autonomy", "raise_budget", "ack"]);
export const EscalationSchema = z.object({
  escalationId: z.string(), hive: z.string(), reason: EscalationReasonSchema, status: z.enum(["OPEN", "RESOLVED"]),
  subject: z.object({ type: z.enum(["item", "release", "hive"]), id: z.string() }),
  traceId: TraceIdSchema.nullable(), summary: z.string().max(500), actions: z.array(EscalationActionSchema),
  createdAt: z.number().int(), resolvedAt: z.number().int().nullable(), resolvedBy: z.string().nullable(), resolution: z.string().max(500).nullable(),
});
export const RUNBOOK: Record<EscalationReason, { what: string; did: string; actions: Partial<Record<EscalationAction, string>> }>;
export const ResolveEscalationSchema = z.object({ action: EscalationActionSchema, note: z.string().max(500).optional() });
export const HiveSettingsSchema = z.object({
  autonomy: AutonomyLevelSchema, guardrails: GuardrailsSchema,
  budget: z.object({ dailyCredits: z.number().int().min(0), dailyDispatches: z.number().int().min(0) }),
  slo: z.object({ changeSuccessTarget: z.number().min(0.5).max(1), window: z.number().int().min(5).max(100) }),
  race: z.object({ reworkWidth: z.number().int().min(1).max(5), hardWidth: z.number().int().min(1).max(5) }),
});
export const UpdateHiveSettingsSchema = z.object({ autonomy: AutonomyLevelSchema.optional(), guardrails: GuardrailsSchema.partial().optional(),
  budget: HiveSettingsSchema.shape.budget.partial().optional(), race: HiveSettingsSchema.shape.race.partial().optional() });
export const HiveStatusSchema = z.object({
  hive: z.string(), settings: HiveSettingsSchema, effectiveAutonomy: AutonomyLevelSchema,
  degradedBy: z.array(EscalationReasonSchema).max(5),
  headline: z.enum(["SHIPPING", "BLOCKED", "NEEDS_YOU", "IDLE"]),
  budget: z.object({ day: z.string(), creditsUsed: z.number(), creditsLimit: z.number(), dispatches: z.number().int(), dispatchLimit: z.number().int() }),
  slo: z.object({ window: z.number().int(), attempted: z.number().int(), failed: z.number().int(), target: z.number(), errorBudgetRemaining: z.number().int(), exhausted: z.boolean() }),
  counts: z.record(z.string(), z.number().int()), // by WorkStatus
  throughput: z.object({ shipped24h: z.number().int(), landed24h: z.number().int(), leadTimeP50Ms: z.number().nullable(), firstTryPassRate: z.number().nullable() }),
  concurrency: z.object({ activeBuilds: z.number().int(), slots: z.number().int(), leasedSlots: z.number().int(),
    affinityWaits: z.number().int(), queueDepth: z.number().int(), waitingToBoard: z.number().int(),
    landed1h: z.number().int(), conflicts24h: z.number().int(), bisects24h: z.number().int(), queueWaitP50Ms: z.number().nullable() }).optional(),
});
```

`headline` rules (pure, `apps/queen/src/autonomy/policy.ts`):
- `NEEDS_YOU` if any escalation is OPEN;
- otherwise `BLOCKED` if paused, the budget is exhausted, or READY/BLOCKED items exist and nothing is ACTIVE;
- otherwise `SHIPPING` if any item is ACTIVE, LANDED or DECOMPOSING, a car is in the queue, or a release is in flight;
- otherwise `IDLE`.

```ts
// src/observability.ts (new)
export const EventTypeSchema = z.enum(["item.filed", "item.status", "item.decomposed", "item.duplicate", "train.enqueued", "train.phase",
  "race.started", "race.decided", "queue.car", "queue.merged", "queue.conflict", "queue.bisect", "queue.landed",
  "affinity.claimed", "affinity.wait", "affinity.released", "command.issued", "command.result", "drone.audit", "gate.verdict", "release.phase", "release.autoshipped",
  "sentinel.verdict", "escalation.opened", "escalation.resolved", "autonomy.degraded", "autonomy.restored", "hive.settings",
  "budget.exhausted", "guardrail.tripped", "followup.filed", "followup.dropped"]);
export const QueenEventSchema = z.object({
  seq: z.number().int(), eventId: z.string(), ts: z.number().int(), hive: z.string(), type: EventTypeSchema,
  severity: z.enum(["debug", "info", "warn", "error"]), actor: z.string().max(340),
  traceId: TraceIdSchema.nullable(), spanId: SpanIdSchema.nullable(), parentSpanId: SpanIdSchema.nullable(),
  itemId: z.string().nullable(), trainId: z.string().nullable(), releaseId: z.string().nullable(), commandId: z.string().nullable(),
  summary: z.string().max(500), data: z.record(z.string(), z.unknown()).nullable(),
  droneRole: DroneRoleSchema.optional(), auditStatus: AuditStatusSchema.optional(), gitNotesPayload: GitNotesPayloadSchema.nullable().optional(),
});
export const EventQuerySchema = z.object({ traceId: TraceIdSchema.optional(), itemId: z.string().optional(), releaseId: z.string().optional(),
  typePrefix: z.string().max(40).optional(), before: z.number().int().optional(), limit: z.number().int().min(1).max(500).default(100) });
export const SpanSchema = z.object({ spanId: SpanIdSchema, parentSpanId: SpanIdSchema.nullable(), name: z.string(), kind: z.enum(["item", "train", "car", "command", "gate", "release"]),
  startTs: z.number().int(), endTs: z.number().int().nullable(), outcome: z.string().nullable() });
export const TraceViewSchema = z.object({ traceId: TraceIdSchema, spans: z.array(SpanSchema), events: z.array(QueenEventSchema), links: z.array(TraceIdSchema) });
export const HourlyMetricSchema = z.object({ bucket: z.number().int(), name: z.string(), labels: z.record(z.string(), z.string()), count: z.number(), sum: z.number(), min: z.number(), max: z.number() });
export const AE_DATASET = "queenos_events";
/** AE layout: indexes [hive]; blobs [type, hive, kindOrRole, model, outcome, environment, traceId, itemId]; doubles [valueMs, tokensIn, tokensOut, credits, count]. */
```

```ts
// src/queue.ts (new): parallel builds + merge queue
export const TrainLaneSchema = z.enum(["BUILD", "QUEUE"]);
export const MergeMemberSchema = z.object({
  trainId: z.string().min(1), promptId: z.string().min(1), artifactRepo: z.string().min(1),
  headSha: z.string().regex(/^[0-9a-f]{40}$/), title: z.string().max(120),
});
export const MergeConflictSchema = z.object({
  trainId: z.string().min(1),
  kind: z.enum(["content", "unsupported", "missing"]),   // MergeConflictError / MergeNotSupportedError (add-add, criss-cross, no base) / head not fetchable
  paths: z.array(z.string().max(200)).max(50),            // conflicting paths (best effort for "unsupported")
  summary: z.string().max(500),
});
/** The MERGE drone's report for a car (`trainId` = car id). */
export const MergeResultSchema = z.object({
  trainId: z.string().min(1), ok: z.boolean(),            // ok:false = infra failure (nothing pushed)
  headSha: z.string().optional(), baseSha: z.string().optional(),
  merged: z.array(z.string()).max(16).default([]),        // member trainIds, in merge order
  conflicts: z.array(MergeConflictSchema).max(16).default([]),
  fastForward: z.boolean().default(false),                // exactly one member, fast-forwarded: tree already gated → skip the car gate
  mergeMs: z.number().int().min(0).optional(), summary: z.string().max(500).default(""),
});
/** The gatekeepers' RPC answer: what a pushed repo is (replaces the snapshot scan). */
export const GateTargetSchema = z.object({
  trainId: z.string(), lane: TrainLaneSchema, promptId: z.string(), promptText: z.string(), previewUrl: z.string().nullable(),
  phase: TrainPhaseSchema, traceId: TraceIdSchema.nullable(), baseSha: z.string().nullable(),
  members: z.array(MergeMemberSchema.extend({ traceId: TraceIdSchema.nullable(), smokePaths: z.array(z.string()).max(10) })).max(16).optional(), // QUEUE lane
});
export const LAND_DEPTH = 100;                          // moved from apps/drones/src/land.ts; shared by MERGE and LANDER drones
// Cars report GateScore.review = "skipped" (the integration gate has no reviewer).
/** Global concurrency lease (SwarmGovernor DO, §4.3). */
export const SwarmLeaseRequestSchema = z.object({ hive: z.string(), want: z.number().int().min(0).max(1000), ttlMs: z.number().int().min(10_000).max(600_000) });
export const SwarmLeaseSchema = z.object({ hive: z.string(), granted: z.number().int().min(0), expiresAt: z.number().int(),
  globalActive: z.number().int(), globalCeiling: z.number().int(), aiRpmCeiling: z.number().int() });
export const EST_RPM_PER_BUILD = 4; // ~8 LLM steps per Think build over ~2 min
```

Edits to existing files:
- `train.ts`:
  - `SubmitPromptSchema` gains `decompose: z.boolean().default(false)`, `bestOf?`, `priority?`.
  - New `GateScoreSchema = {review: "approved"|"skipped"|"off", satisfied, missing, changedFiles, changedBytes, checks}` (ints ≥ 0).
  - `TrainResultSchema` gains `score?: GateScore` and `followUps?: FollowUp[] (max 3)`.
  - `BuildResultSchema` gains `verified?: boolean`, `followUps?: FollowUp[] (max 5)` and `changedPaths?: string[] (max 200)` (vs the fork base; it widens path claims).
- `state.ts`: `MergeTrainSchema` gains `traceId?`, `raceId?`, `candidate?`, `raceOutcome?: "RACING"|"PASSED"|"FAILED"|"WON"|"LOST"`, `score?: GateScore`, and for the merge queue `lane?: TrainLane` (absent = `BUILD`), `members?: string[]` (QUEUE), `carId?: string|null` (BUILD), `passedSeq?: number|null`, `conflict?: MergeConflict|null`, `changedPaths?: string[]`, `waitForCarSeq?: number|null`.
- `drone.ts`: `DroneActionSchema` adds `"MERGE"`; `DroneTaskSchema` gains `trace?: TraceContext` and `members?: MergeMember[] (max 16)` (MERGE and LAND of a car). The drone's `promptText` for a car is `"queue car <carId>: <n> members"`.
- `executors.ts`: every `ProvisionCommand` and `DeployCommand` variant gains `trace?`.
- `releases.ts`:
  - `SentinelCommandSchema` gains `trace?`.
  - `SentinelVerdictSchema` gains `inconclusive?: boolean`. The verdict stays `ROLLBACK` when inconclusive, so a v1 Queen treats it safely.
  - `ReleaseSchema` gains `traceId?`.
- `models.ts`: `ModelRoleSchema` adds `"planner"`. The catalog adds `planner` to GLM-5.3 Flash and DeepSeek V4 Flash.
- `telemetry.ts`:
  - The snapshot gains optional `items`, `escalations`, `races`, `hive: HiveStatus` and `recentEvents`.
  - New server messages: `item.updated {item}`, `race.updated {race}`, `escalation.updated {escalation}`, `hive.updated {hive}`, `event.appended {event}`, and **`batch {messages: QueenServerMessage[] (max 200)}`**. The Queen coalesces broadcasts into one `batch` frame per ≤100 ms (§4.3). Old dashboards show the "updated, reload" banner on it, which is acceptable.
  - Cars travel as ordinary `train.updated` messages with `lane: "QUEUE"`.
  - `submit_prompt` carries the extended `SubmitPrompt`.

### 2.11 SQLite migrations (`apps/queen/src/db.ts`, appended)

```sql
-- v8: work ledger. prompt_runs.prompt_id = work_items.item_id for dispatched items.
CREATE TABLE work_items (
  item_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, hive TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('goal','feature','bug','chore')),
  title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', acceptance TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  status TEXT NOT NULL,
  parent_id TEXT, root_id TEXT NOT NULL, depth INTEGER NOT NULL DEFAULT 0,
  depends_on TEXT NOT NULL DEFAULT '[]',
  source_kind TEXT NOT NULL, source_actor TEXT NOT NULL, source_ref TEXT /* JSON */,
  trace_id TEXT NOT NULL, span_id TEXT NOT NULL,
  difficulty TEXT NOT NULL DEFAULT 'normal', best_of INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  duplicate_of TEXT, blocked_reason TEXT, release_id TEXT, escalation_id TEXT,
  -- current Oracle command (DECOMPOSE/TRIAGE) + watchdog clock
  command_id TEXT, command_issued_at INTEGER,
  normalized_title TEXT NOT NULL DEFAULT '',  -- exact dedupe key
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  landed_at INTEGER, shipped_at INTEGER         -- lead/cycle time
);
CREATE INDEX work_items_status ON work_items(status, priority, seq);
CREATE INDEX work_items_parent ON work_items(parent_id);
CREATE INDEX work_items_trace ON work_items(trace_id);
CREATE INDEX work_items_command ON work_items(command_id);
-- Backfill: every v1 prompt is a user feature item with the same id.
INSERT INTO work_items (item_id, seq, hive, kind, title, body, priority, status, root_id, depth,
  source_kind, source_actor, trace_id, span_id, attempts, created_at, updated_at, normalized_title)
SELECT prompt_id, seq, namespace, 'feature', substr(prompt_text, 1, 120), substr(prompt_text, 1, 4000), 2,
  CASE status WHEN 'MERGED' THEN 'LANDED' WHEN 'FAILED' THEN 'FAILED' ELSE 'ACTIVE' END,
  prompt_id, 0, 'user', 'legacy', lower(replace(prompt_id, '-', '')), lower(substr(replace(prompt_id, '-', ''), 1, 16)),
  attempts, created_at, created_at, lower(substr(prompt_text, 1, 120))
FROM prompt_runs;
ALTER TABLE prompt_runs ADD COLUMN race_width INTEGER NOT NULL DEFAULT 1;
ALTER TABLE prompt_runs ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'normal';
```

```sql
-- v9: races (best-of-N) + trace on trains.
ALTER TABLE merge_trains ADD COLUMN trace_id TEXT;
ALTER TABLE merge_trains ADD COLUMN race_id TEXT;
ALTER TABLE merge_trains ADD COLUMN candidate INTEGER;
ALTER TABLE merge_trains ADD COLUMN race_outcome TEXT;  -- RACING/PASSED/FAILED/WON/LOST
ALTER TABLE merge_trains ADD COLUMN gate_score TEXT;    -- JSON GateScore
ALTER TABLE merge_trains ADD COLUMN credits REAL;       -- build credits (budget + ranking)
CREATE INDEX merge_trains_race ON merge_trains(race_id);
UPDATE merge_trains SET trace_id = (SELECT trace_id FROM work_items w WHERE w.item_id = merge_trains.prompt_id);
CREATE TABLE races (
  race_id TEXT PRIMARY KEY, item_id TEXT NOT NULL, width INTEGER NOT NULL,
  state TEXT NOT NULL, train_ids TEXT NOT NULL DEFAULT '[]', winner_train_id TEXT, reason TEXT,
  deadline_at INTEGER, created_at INTEGER NOT NULL, decided_at INTEGER
);
CREATE INDEX races_state ON races(state);
ALTER TABLE releases ADD COLUMN trace_id TEXT;
UPDATE releases SET trace_id = lower(replace(release_id, '-', ''));
```

```sql
-- v10: autonomy, escalations, event log (supersedes audit_trail), metrics rollups.
CREATE TABLE hive_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1), hive TEXT NOT NULL,
  autonomy TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}' /* JSON overrides of HiveSettings */,
  budget_day TEXT, credits_used REAL NOT NULL DEFAULT 0, dispatches INTEGER NOT NULL DEFAULT 0,
  auto_filed_hour INTEGER, auto_filed_count INTEGER NOT NULL DEFAULT 0,
  rollback_streak INTEGER NOT NULL DEFAULT 0, degraded_by TEXT NOT NULL DEFAULT '[]',
  updated_by TEXT, updated_at INTEGER NOT NULL
);
-- Existing hives (they have prompts) migrate SUPERVISED (decision D2); new hives get a row at first filing, AUTONOMOUS.
INSERT INTO hive_settings (id, hive, autonomy, updated_by, updated_at)
SELECT 1, namespace, 'supervised', 'migration-v10', created_at FROM prompt_runs ORDER BY seq LIMIT 1;
CREATE TABLE escalations (
  escalation_id TEXT PRIMARY KEY, reason TEXT NOT NULL, status TEXT NOT NULL,
  subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, trace_id TEXT,
  summary TEXT NOT NULL, actions TEXT NOT NULL /* JSON */,
  created_at INTEGER NOT NULL, resolved_at INTEGER, resolved_by TEXT, resolution TEXT
);
CREATE INDEX escalations_status ON escalations(status, created_at);
CREATE INDEX escalations_subject ON escalations(subject_type, subject_id);
CREATE TABLE event_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, ts INTEGER NOT NULL, hive TEXT NOT NULL,
  type TEXT NOT NULL, severity TEXT NOT NULL, actor TEXT NOT NULL,
  trace_id TEXT, span_id TEXT, parent_span_id TEXT,
  item_id TEXT, train_id TEXT, release_id TEXT, command_id TEXT,
  summary TEXT NOT NULL DEFAULT '', data TEXT,
  drone_role TEXT, audit_status TEXT, git_notes_payload TEXT
);
CREATE INDEX event_log_trace ON event_log(trace_id, seq);
CREATE INDEX event_log_item ON event_log(item_id, seq);
CREATE INDEX event_log_release ON event_log(release_id, seq);
CREATE INDEX event_log_type ON event_log(type, seq);
CREATE INDEX event_log_ts ON event_log(ts);
INSERT INTO event_log (event_id, ts, hive, type, severity, actor, trace_id, item_id, summary, drone_role, audit_status, git_notes_payload)
SELECT a.event_id, a.created_at, p.namespace, 'drone.audit', 'info', 'drone:' || a.drone_role,
  lower(replace(a.prompt_id, '-', '')), a.prompt_id, a.drone_role || ' ' || a.status, a.drone_role, a.status, a.git_notes_payload
FROM audit_trail a JOIN prompt_runs p ON p.prompt_id = a.prompt_id ORDER BY a.created_at, a.rowid;
CREATE TABLE metrics_hourly (
  bucket INTEGER NOT NULL, name TEXT NOT NULL, labels TEXT NOT NULL /* canonical JSON */,
  count REAL NOT NULL DEFAULT 0, sum REAL NOT NULL DEFAULT 0, min REAL, max REAL,
  PRIMARY KEY (bucket, name, labels)
);
```

```sql
-- v11: parallel builds, merge queue, path affinity, swarm lease.
ALTER TABLE merge_trains ADD COLUMN lane TEXT NOT NULL DEFAULT 'BUILD';  -- BUILD | QUEUE
ALTER TABLE merge_trains ADD COLUMN members TEXT;                         -- QUEUE: JSON trainIds, merge order
ALTER TABLE merge_trains ADD COLUMN car_id TEXT;                          -- BUILD: the car carrying it
ALTER TABLE merge_trains ADD COLUMN passed_seq INTEGER;                   -- BUILD: queue ticket when PASSED (race winner: when decided)
ALTER TABLE merge_trains ADD COLUMN conflict TEXT;                        -- BUILD: JSON MergeConflict that ejected it
ALTER TABLE merge_trains ADD COLUMN changed_paths TEXT;                   -- BUILD: JSON, from BuildResult
ALTER TABLE merge_trains ADD COLUMN wait_for_car_seq INTEGER;             -- BUILD: conflict/integration rework waits for this car seq
ALTER TABLE merge_trains ADD COLUMN bisect_of TEXT;                       -- QUEUE: the failed car this composition came from
CREATE INDEX merge_trains_lane ON merge_trains(lane, phase, seq);
CREATE INDEX merge_trains_car ON merge_trains(car_id);
CREATE INDEX merge_trains_board ON merge_trains(lane, phase, car_id, passed_seq);
-- Existing rows keep lane BUILD. Deploy v11 with no active v1 trains (the deploy script checks the snapshot):
-- a v1 chained train still in flight would land through the queue anyway (its head includes its predecessors' commits, a 3-way merge handles that),
-- but its successors would no longer wait for it, so we don't rely on that.
ALTER TABLE work_items ADD COLUMN paths TEXT NOT NULL DEFAULT '[]';
ALTER TABLE work_items ADD COLUMN wait_reason TEXT;
ALTER TABLE work_items ADD COLUMN conflicts INTEGER NOT NULL DEFAULT 0;
CREATE TABLE path_claims (
  path TEXT NOT NULL, item_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('predicted','actual','conflict')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (path, item_id)
);
CREATE INDEX path_claims_item ON path_claims(item_id);
ALTER TABLE hive_settings ADD COLUMN leased_slots INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hive_settings ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE hive_settings ADD COLUMN car_infra_failures INTEGER NOT NULL DEFAULT 0;
```

`path_claims` stays small (≤ 10 predicted + ≤ 200 actual paths per active item), so `dispatchReady` loads every claim of the ACTIVE items into memory and checks overlap in pure code. It does no prefix SQL.

`hiveNamespace()` reads `hive_settings.hive`, falling back to `prompt_runs`. A goal can exist before any prompt run, so the first filing upserts the settings row.

---

## 3. Flows

### 3.1 The QueenNode decision pipeline (one synchronous plan, one transaction)

Today `trainTransition` composes `TrainPlanner` and then `ReleasePlanner`. v2 generalises this into `decide()` in `queen-node.ts`:

```
// before decide(), async, only when due: lease = await governor.lease({hive, want, ttlMs: 120_000}) (§4.3), cached on hive_settings
decide(input):                        // all synchronous: no await until apply()
  ctx   = settings, effectiveAutonomy (policy.ts), budget, guardrails, leasedSlots
  state = cache.get() ?? loadActiveState()        // §4.3: warm in-memory copy of active rows; the DO is the only writer
  tp    = new TrainPlanner(state.trains, {..., race: {slotsFree, reworkWidth}, queue: {maxQueueBatch, maxQueueDepth}, credits})
  rp    = new ReleasePlanner(state.releases, {..., autoShip: ctx.effective === 'autonomous'})
  wp    = new WorkPlanner(state.work, ctx)        // items + path_claims of ACTIVE items
  r1    = input(tp, rp, wp)                       // the triggering transition
  r2    = wp.absorb(r1)                           // prompt status → item status; landed cars → rp.landed(members);
                                                  // changedPaths / conflicts → claims; release SHIPPED → items SHIPPED;
                                                  // rollbacks → P0 bug + streak; followUps → TRIAGE items; escalations
  subs  = wp.dispatchReady(slots(tp, ctx), claims, budget)   // READY items → [{itemId, promptText, width}] or waitReason
  r3    = subs.map(s => tp.submit(s))             // same TrainPlanner: BUILD trains, all forked from main
  r4    = tp.formCars()                           // passed builds board cars (queue.ts); no-op if the queue is full
  apply(merged(r1..r4))                           // rows + events + metrics rollups, one transactionSync;
                                                  // then cache update, coalesced broadcast, executor dispatch
                                                  // (createBatch per Workflow, ≤100 per call), then AE writes
```

- **Every RPC goes through `decide()`:** `report*` (including the new `reportMergeResult`), `submitPrompt`, `fileWorkItem`, `resolveEscalation`, `updateSettings` and `alarm`.
- **The alarm** runs `tp.reconcile()` (which now includes `formCars()`), `rp.reconcile()` and `wp.reconcile()`. `wp.reconcile()` is the Oracle watchdog, plus the race deadlines, plus `pruneEvents`, plus releasing claims of terminal items, plus the lease renewal flag.

### 3.2 Main flow: prompt → shipped (autonomous hive, parallel)

```
user ──submit_prompt{decompose}──▶ Queen: goal G (DECOMPOSING), trace T, event item.filed
Queen ──OracleCommand DECOMPOSE──▶ Oracle: list repo files → LLM → children c1..c5 with paths → dedupe → reportOracleResult
Queen: c1 READY [src/features/health.js]  c2 READY hard [src/lib/theme.js, src/features/dark.js]
       c3 READY [src/lib/theme.js]  c4 READY []  c5 BLOCKED (dep c1)
Queen dispatch (one decide): c1 → width 1 (train A); c2 → race R width 3 (B0,B1,B2); c4 → width 1 (D)
       c3 waits: "affinity: src/lib/theme.js held by c2"
  Provisioner FORK ×5 from main@m0, in one createBatch → drones BUILD ×5 at the same time (B0..B2 on 3 models)
  → Herald previews ×5 → Gatekeepers ×5: policy/security/smoke/reviewer → reportTrainResult{passed, score}
  A PASSED (ticket 1) → formCars: car K1 [A] forks main → MERGE: fast-forward → fastForward=true → PASSED → LANDER
     → main@m1 → A MERGED → c1 LANDED → rp.landed → release R1 STAGING; c5's dep met → READY → dispatched (forks m1)
  D PASSED (ticket 2), B1/B2 pass, B0 fails (ejected) → race decided: B2 WON (ticket 3), B1 LOST
  formCars: car K2 [D, B2] forks main@m1 → MERGE: D merges (merge commit), B2 merges → push → preview → integration gate ✓
     → head of queue → LANDER fast-forwards main to K2 → D, B2 MERGED → c4, c2 LANDED; c2's claims released → c3 dispatched
Release: R1 SUPERSEDED by R2 (carries A, D, B2) → STAGING → Sentinel → PROMOTE → autoShip → CANARY 1/10/50/100 → SHIPPED
Queen: items in R2 → SHIPPED; when every child SHIPPED → G SHIPPED; metrics: lead time, queue wait, active builds
```

Release supersede works as in v1. When R1 is in STAGING or VALIDATING and a car lands, R1 becomes SUPERSEDED and R2 carries every member train. During CANARY, R2 is queued with `nextHeadSha`.

### 3.2a Conflict → rework

```
c6 [paths: []] and c7 [paths: []] both edit src/lib/format.js (unpredicted). Both build in parallel from main@m1 and pass.
formCars: car K3 [c6-train E, c7-train F] forks main@m1
MERGE drone: E merges cleanly; F → MergeConflictError {filepaths: [src/lib/format.js], bothModified: [...]}
  → MergeResult{merged: [E], conflicts: [{trainId: F, kind: content, paths: [src/lib/format.js]}]}, push K3
Queen: K3.members = [E]; F EJECTED ("merge conflict"); c7.conflicts = 1; claim src/lib/format.js (conflict) on c7
       REWORK train F' (wait_for_car_seq = K3.seq, scribeSummary = conflict summary)       event queue.conflict
K3: gate ✓ → lands → main@m2.  F': K3 terminal → forks main@m2 → rebuilds on top of E's change → passes → car K4 → lands
```

### 3.2b Batch failure → bisect

```
car K5 [P, Q, R, S] (each passed alone) → integration gate ✗ (smoke: /features/q 500 after merge)
queue.carFailed: K5 EJECTED; K6 stacked behind it (contains K5's prompts) EJECTED, its members back to the pool
  pin halves: K7 [P, Q] (forks main), K8 [R, S] (forks K7 once pushed)        event queue.bisect
K7 gate ✗ → bisect: K9 [P] , K10 [Q]; K8 superseded (contains P, Q) → R, S back to the pool → re-boarded behind
K9 ✓ lands; K10 ✗ (single member) → Q fail(): "Passed alone, fails integrated on main@…" → REWORK (attempts +1, waits K10)
R, S board K11 → ✓ → land.
```

### 3.3 The Oracle executor (new Workflow `queenos-oracle`)

**Why a new Workflow and not an extension of the Provisioner or Genesis:**
- The Provisioner is the Artifacts executor. Its retries, timeouts and failure semantics are about repos. Decomposition is an LLM call with a different latency and failure profile, and coupling them would make FORK retries replay LLM work.
- Genesis is a chat DO for onboarding, not a command executor.
- The drones are keyed per train (`<trainId>-<action>`), while decomposition happens before any train exists.
- The Oracle needs just `AI`, `MEMORY` (queenos-memory), `ARTIFACTS` (read-only listing), `QUEEN` (DO RPC back), `ANALYTICS` and the shared hive-kit clients, so it is ~350 lines.
- It is one more deploy, accepted (decision D5).

**Steps of `runOracle(cmd)`** (pattern of `apps/provisioner/src/orchestrate.ts`, StepRunner + ports seam). Every step is idempotent by `commandId`:
- **DECOMPOSE:**
  0. `step "repo: list files"` (best effort, ≤500 paths): an Artifacts read token for the hive repo plus a depth-1 hive-kit clone, then `listFiles()`. On failure, use `[]`.
  1. `step "decompose: llm"`: a JSON-schema call via the hive-kit AI client with `cmd.model.model`, then `cmd.model.fallbacks`; temperature 0; output capped to `limits.maxChildren`; a tolerant parse.
  2. `step "dedupe: children"` (best effort): `HiveMemory.findSimilarItems(hive, texts, kind=work-item)` and `HiveMemory.indexItems(...)`.
  3. `step "report"`: `queen.reportOracleResult(result)`.
- **TRIAGE:** embed, query (topK 5, filter `{namespace, kind: "work-item"}`), upsert, report.
- **Failure handling:**
  - LLM failure → `ok: false` (the Queen falls back to a single item);
  - Vectorize failure → `similar: []` (the Queen does not dedupe).
- **Setup:** the user runs once:

  ```
  npx wrangler vectorize create-metadata-index queenos-memory --property-name=kind --type=string
  ```

  Old memory vectors lack `kind`. That is fine: dedupe filters on `kind = work-item`. `HiveMemory.recall` (used by the Provisioner) over-fetches and drops `metadata.kind === "work-item"` in code.

### 3.4 Bug filing (self-correcting code)

| origin | mechanism | Queen handling |
|---|---|---|
| **Drone notices an out-of-scope problem** | The Think `finish` tool gets `followUps: [{kind, title, body, paths}]` (≤3; the prompt says "only problems outside your task; never your own unfinished work"). `runBuild` passes them in `BuildResult.followUps`. | `wp.followUps(item, train)`: guardrails (depth, hourly, open cap) → exact dedupe → TRIAGE (Oracle) → READY or DUPLICATE. The follow-up's `paths` become the new item's predicted `paths` |
| **Gate finds problems outside the diff** | `inspect.ts` already has the findings with paths and `changedPaths`. Findings in unchanged paths don't fail the gate (they are pre-existing); they are sent as `TrainResult.followUps` (bug, P1 for security, P2 for policy). | same as the drone row |
| **Gate failure on the item's own diff** | unchanged: Scribe summary → `fail()` → REWORK (a race of `reworkWidth`, forked from main) | after `maxReworks`: FAILED + `REWORK_EXHAUSTED` |
| **Merge conflict in the queue** | MERGE drone → `MergeResult.conflicts` | same item: REWORK with the conflict summary as Scribe summary, `waitForCarSeq`, conflict paths claimed; `conflicts +1`; after `maxConflictReworks`: FAILED + `REWORK_EXHAUSTED` (D7) |
| **Passed alone, fails integrated** (single-member car gate failure) | integration gate → `TrainResult{passed: false}` on the car | same item: REWORK (attempts +1) with `"Passed alone, fails integrated on main@<sha>: …"`, `waitForCarSeq` |
| **Sentinel rollback or staging failure** | Sentinel reports a verdict as today | `wp.absorb` on the release phase → ROLLED_BACK or FAILED: P0 bug `"Release <id> rolled back: <summary>"`, links to the release and its items, body = verdict metrics + item titles; `rollback_streak++`; ≥2 → `ROLLBACK_STREAK` |
| **Sentinel inconclusive** | `inconclusive: true` (readiness timeout; < ½ minRequests) | staging: AWAITING_TAP + `SENTINEL_INCONCLUSIVE`; canary: the normal rollback path + escalation |

### 3.5 Escalation flow

```
condition ──▶ wp/rp opens Escalation (OPEN) ──▶ event escalation.opened ──▶ hive.headline = NEEDS_YOU
human (dashboard "Needs you" card) ──POST /escalations/:id/resolve {action}──▶ decide(): action → transition
  ship → rp.tap(releaseId, user) · retry → item FAILED→READY · resume_autonomy → streak=0, degraded cleared
  ──▶ escalation RESOLVED, event escalation.resolved, hive.updated broadcast
```

### 3.6 RPC and HTTP surface added to the Queen (`apps/queen/src/index.ts`, `queen-node.ts`)

| route / RPC | auth | notes |
|---|---|---|
| `POST /hives/:hive/prompts` / `submitPrompt(SubmitPrompt)` | open (as today) | returns `{item, promptRun}`. `promptRun` is synthesized from the item (QUEUED until ACTIVE), so v1 clients still work |
| `POST /hives/:hive/items` / `fileWorkItem` | user | `FileWorkItem` |
| `POST /hives/:hive/items/:id/actions` | user | `WorkAction` (retry, cancel, not_duplicate) |
| `GET /hives/:hive/items/:id` | open | item + children + trains + races + release + escalations |
| `GET /hives/:hive/events`, `GET /hives/:hive/traces/:traceId` | open | `EventQuery`, `TraceView` |
| `GET /hives/:hive/metrics?window=24h\|7d` | open | rollups + `HiveStatus` |
| `PATCH /hives/:hive/settings` | user | `UpdateHiveSettings`; event `hive.settings` |
| `POST /hives/:hive/escalations/:id/resolve` | user | `ResolveEscalation` |
| `reportOracleResult` + `POST /internal/webhook/oracle-result` | internal bearer | idempotent by `commandId` |
| `getGateTarget(repo)` | RPC only | `GateTarget` (§2.10): BUILD trains get the full gate; QUEUE cars get the integration gate (no reviewer, smoke over the members' routes, scans on `baseSha..head`). Replaces the gatekeepers' snapshot scan (`lookupTrain`), which stays as a fallback for BUILD trains, so deploy order doesn't matter |
| `reportMergeResult` + `POST /internal/webhook/merge-result` | internal bearer | `MergeResult`, idempotent by car id + drone attempt (the existing drone report path) |
| `GET /hives/:hive/queue` | open | active cars with members, passed builds waiting to board, the last 20 conflicts and bisects |

The "open" GET routes match today's openness (`/snapshot`, `/room`). In production the edge's Access check covers everything.

---

## 4. Scale: designing for thousands of agents

The user's bar is "1000s of agents should be able to run at once". This section covers three things:
- the platform limits that bound us, checked on developers.cloudflare.com on 2026-10-05;
- where a single Queen breaks first;
- what we build by Oct 11 so that nothing precludes thousands, and what comes after.

The Oct 11 demo shows dozens, not thousands.

### 4.1 Platform limits (verified 2026-10-05)

| product | documented limit (Workers Paid) | source | what it means for us |
|---|---|---|---|
| **Workflows** | **50,000** concurrent instances (instances in `waiting` don't count); creation **300/s per account, 100/s per workflow**; 2,000,000 queued; step result 1 MiB; 10,000 steps per instance (default). `createBatch` takes up to **100** instances per call, is idempotent on ids already in use, and counts as one `create` against the creation limit | [limits](https://developers.cloudflare.com/workflows/reference/limits/), [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/) | A BUILD train runs about 6 instances over its life (FORK, BUILD, DEPLOY, gate, DELETE, TEARDOWN), with ~2 running at once. 1,000 concurrent builds ≈ 2,000 running instances, 4% of the cap. A fan-out of 1,000 forks takes ≥10 s at 100/s per workflow; with `createBatch` that is 10 calls. Not a bottleneck. |
| **Durable Objects** | soft limit of **1,000 requests/s per object**; 10 GB SQLite per object; 30 s CPU per request (configurable to 5 min); WebSockets: "thousands of clients per instance". The docs recommend batching 10–100 logical messages per frame every 50–100 ms | [limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) | One QueenNode per hive. The request *rate* is fine (§4.2). The *cost per request* and the broadcast fan-out are what break first. |
| **Artifacts** | control plane **2,000 requests / 10 s per namespace**; git **2,000 requests / 10 s per repo**; 1 GB per repo; 1 TB per account (raisable); unlimited repos | [limits](https://developers.cloudflare.com/artifacts/platform/limits/) | **Every hive shares the one namespace `queenos`**, so the 200/s control-plane budget is account-wide. A train costs ~6–8 control calls (fork, delete, token mints), so the ceiling is ~25 train starts/s across all hives. That is fine for thousands *concurrent* at 2–3 min per train (~8 starts/s), but it is the second ceiling after AI. The docs give no fork-specific limit. |
| **Workers AI** | text generation **300 requests/min** per account by default; models that require Workers Paid: **20/min** (standard billing) or **50/min** (prepaid AI Gateway credits); text embeddings 3,000/min (`bge-large-en-v1.5`: 1,500/min). Higher limits through the Custom Requirements Form | [limits](https://developers.cloudflare.com/workers-ai/platform/limits/) | **This is the binding constraint.** A Think build is ~8 text-generation calls over 2–3 min, plus the reviewer, plus the Scribe on failure: about **4 rpm per active builder**. 300 rpm supports **~75 concurrent builders**, so we lease 60 (80%). 1,000 concurrent builders would need ~4,000 rpm and a limit raise, which is not being requested (D10 declined: thousands is a design target, and v2 is an MVP that proves the vision). The model pages don't say whether our catalog models (DeepSeek V4, Kimi K2.7, GLM-5.3) count as "paid models" at 20/min. A one-minute burst test on Oct 11 settles it (§8, WP3.1). |
| **Vectorize** | upsert ≤1,000 vectors per batch from Workers (5,000 via HTTP); the service combines mutations into batches of up to 200,000 vectors or 1,000 updates and applies them asynchronously; 20 M vectors per index; topK ≤50 with metadata; 50,000 namespaces per index; 10 KiB metadata per vector. No write-QPS limit is documented | [limits](https://developers.cloudflare.com/vectorize/platform/limits/), [inserting vectors](https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/) | One memory per gate verdict plus one per item is ~2 upserts per train: volume is fine. Many single-vector writes lengthen the time until they are queryable (already ~1 min). The exact dedupe in the Queen covers that window. A batching memory writer comes later. |
| **Analytics Engine** | **250 data points per Worker invocation**; 20 blobs (16 KB total), 20 doubles, 1 index (96 B) per point; 3-month retention | [limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/) | One `decide()` after a large fan-out can produce hundreds of notable events. The Queen caps AE writes at 200 per invocation (debug first, then info) and counts the drops in `metrics_hourly`. Executors write a handful each. |
| **Workers** | 128 MB memory per isolate; 6 simultaneous open connections; 10,000 subrequests per request (default) | [limits](https://developers.cloudflare.com/workers/platform/limits/) | The MERGE drone holds the car repo plus up to 16 member histories in memfs. That is fine for template-sized repos; a real monorepo would need a partial-clone strategy (later). Fetches are sequential, so the 6-connection limit doesn't matter. |
| **Worker previews** | "Only the 1000 most recently deployed aliases are retained" per Worker | [previews](https://developers.cloudflare.com/workers/configuration/previews/) | One preview alias per train on the hive's app Worker means ≤1,000 live previews per hive. `maxActiveTrains` is capped at 256 + 8 cars, well under that. |

### 4.2 Where one Queen per hive breaks

These are our estimates, from the current RPC surface.

- **RPCs into the Queen per BUILD train** ≈ 14: fork, build, deploy, gate, delete and teardown results, ~6 `drone.audit` rows, `getGateTarget`, and the dispatch confirmation. A car adds ~10, shared by its B members.
- **At 1,000 concurrent builds with a ~3 min lifetime:** 1,000 / 180 s × 14 ≈ **80 RPC/s** into one QueenNode. That is 8% of the 1,000 rps soft limit, so the rate is fine.
- **The cost per RPC is not.** Today `decide()` reloads every active train, prompt and item from SQLite and rebuilds the planners: O(active) per call. At 1,000 active trains that is ~5–15 ms of CPU per call (estimate) × 80/s ≈ one full core. **The DO saturates on reload, not on request rate.**
- **Broadcast:** 80 RPC/s × ~3 messages × every connected dashboard. Without coalescing, that is thousands of frames per second.
- **Event log:** ~25 events per train means a wave of 1,000 builds writes 25k rows. That is fine for SQLite, but the 100k-row retention then covers only ~4 waves.

### 4.3 What we build by Oct 11 (the design must not preclude 1000s)

1. **Warm state cache** (`apps/queen/src/scale/state-cache.ts`).
   - The QueenNode keeps its active state (non-terminal trains, prompts, items, claims, open races, in-flight releases) in memory between calls. The DO is single-threaded and the only writer, so after each `apply()` the cache equals the database.
   - Cold start (and any apply error) reloads from SQLite.
   - `decide()` becomes O(rows touched + READY scan) instead of O(all rows).
   - **Acceptance:** with 500 active trains, one `reportBuildResult` loads zero rows from SQLite (it reads the counter `sql.exec` calls in a test hook).
2. **Coalesced broadcast** (`apps/queen/src/scale/broadcast.ts`).
   - Messages queue per apply. They are flushed as one `batch` frame at the end of an apply if ≥100 ms have passed since the last frame. Otherwise a `setTimeout` is scheduled for the remainder (the DO stays resident while a timer is pending), and any later apply flushes first.
   - Per-entity dedupe: the last `train.updated` per train wins inside a frame.
   - The snapshot keeps v1's cap (200 newest trains). `HiveStatus.concurrency` gives the home page its counts without shipping every train.
3. **Batched executor dispatch.** `executors.ts` groups `dispatchDrone` and command effects per Workflow and calls `createBatch` (≤100 per call). Instance ids are the command ids already, so a re-dispatch stays idempotent (`createBatch` skips ids in use).
4. **Concurrency controls.**
   - **Per hive:** `maxActiveTrains` (24), `maxQueueBatch` (4), `maxQueueDepth` (3).
   - **Global:** **`SwarmGovernor`**, one DO named `global` in the queen Worker (`apps/queen/src/scale/governor.ts`).
     - `lease({hive, want, ttlMs})` grants `min(want, ceiling − Σ other unexpired leases)`, where `ceiling = min(SWARM_MAX_ACTIVE_BUILDS, ⌊SWARM_AI_RPM / EST_RPM_PER_BUILD⌋)`.
     - Every hive with demand is guaranteed at least `⌊ceiling / hivesWithDemand⌋`; when a hive asks for more than it holds, others shrink at their next renewal.
     - The Queen renews in its alarm when the lease expires within 30 s, or when READY demand exceeds `leasedSlots`. It sends `want = 0` when idle.
     - The lease is a soft ceiling for *new* dispatches. Running builds are never pre-empted.
5. **AI rate-limit hygiene in the drones.**
   - The hive-kit AI client treats HTTP 429 and "rate limited" errors as retryable with jittered backoff inside the step.
   - It never reports them as `failedModels`, so a quota hit does not lower the router's AIMD floor. That is a correctness bug at any concurrency above ~60.
6. **AE cap.** At most 200 points per invocation (above).
7. **Load test** (WP3.4): 500 sim items through one hive under vitest-pool-workers.
   - It asserts that every item lands, the number of SQLite reads per RPC, frames per second, and the Queen RPC count per train.
   - It does **not** assert wall-clock CPU, because `Date.now()` does not advance during execution in Workers.

### 4.4 Targets

| horizon | concurrent builders | landing throughput | needs |
|---|---|---|---|
| **Oct 11, sim** (the video) | **40** in one hive (`SWARM_MAX_ACTIVE_BUILDS=1000`, `maxActiveTrains=64`) | cars of up to 4 landing every ~10 s | §4.3 items 1–4 |
| **Oct 11, live on `demo`** | **12–24** (lease 60 at 240 rpm) | ≥ 20 items/hour | §4.3 + the AI burst test |
| **v2.x (after Oct 14)** | **1,000 per account**, ≤ 250 per hive, across ≥ 4 hives | ≥ 400 items/hour per hive (D=3, B=4: 12 items per ~100 s car cycle) | Workers AI raised to ≥ 4,000 rpm (not requested; D10 declined for v2); TrainNode sharding (§4.5, 1); a RoomNode (§4.5, 3) |
| **later** | **10,000** | hive of hives | §4.5, 4–5 and a second Artifacts namespace per ~25 train starts/s |

The merge queue is not the bottleneck at these numbers. A car cycle is ~80–110 s (merge ~15 s, fork ~5 s, preview ~20 s, integration gate 30–60 s, land ~10 s). With pipeline depth D and batch B, up to D·B items land per cycle: 12 at the defaults, ~128 at D=8, B=16 (~4,600/hour in theory, before bisect costs).

### 4.5 Scale-out architecture (after Oct 14; no contract changes needed)

1. **`TrainNode` DO per BUILD train** (`idFromName(trainId)`).
   - It owns one train's command loop (fork → build → preview → gate → teardown), its watchdog, its `drone.audit` rows and its events.
   - It reports three milestones to the Queen: `PUSHED{changedPaths}`, `VERDICT{passed, score, summary}` and `ENDED`.
   - Executors already report by `trainId`/`commandId`, so only the edge's internal webhook routing changes.
   - Queen RPCs per train drop from ~14 to ~3: 1,000 concurrent builds become ~17 RPC/s.
   - The Queen keeps the decisions: the ledger, dispatch, claims, races, the merge queue, releases, autonomy.
2. **Sharded event log.** TrainNodes keep their own events. The Queen keeps item, queue and release events. The trace view fans out to the TrainNodes named in the trace (bounded by the item's attempts), and AE is the cross-shard index.
3. **`RoomNode` per hive for broadcast.**
   - The Queen publishes a 5 Hz `swarm.summary` (counts, queue state).
   - The RoomNode owns the WebSockets (hibernating), and clients subscribe to detail (`subscribe {trains: […]}`) that streams from TrainNodes.
   - Viewers cost the Queen nothing.
4. **Sub-queens per area.** Inside one big repo, an area queen per top-level path prefix owns the ledger, dispatch and claims for its area (code ownership at the org level). The hive Queen keeps only what must be serial: the merge queue onto main, and releases.
5. **Hive of hives.** A Swarm Queen decomposes cross-repo goals into per-hive goals. The `SwarmGovernor` (built Oct 11) already leases capacity across hives. A second Artifacts namespace lifts the 200/s control-plane ceiling.

---

## 5. Dashboard v2

The concurrency must be **visible**: many builds at once, the merge queue moving, conflicts turning into reworks, races being decided. The home page leads with it.

**Routes** (`apps/dashboard/src/route.ts`):
- `/p/:hive` → **Status home** (new; the War Room moves);
- `/p/:hive/lanes` → today's War Room (lanes, release timeline, Sites, Model Board, ticker);
- `/p/:hive/queue` → the merge-queue page (§5.2);
- `/p/:hive/items/:id`;
- `/p/:hive/traces/:traceId`;
- `/p/:hive/events`;
- `/p/:hive/metrics`.

`/?hive=x` maps to the home page. The home page runs off the WebSocket snapshot plus `batch` deltas, and the drill-downs fetch the REST endpoints.

### 5.1 Status home (status first, swarm visible)

```
┌─ QueenOS ▸ demo ──────────────────────────────────────── ● linked 42ms ─ [autonomous ▾] ─┐
│  ██ SHIPPING · 23 building · 5 in the merge queue · 1 needs you · landed 31 today           │
│  slots 23/24 (lease 60)   error budget ▓▓▓▓▓▓░░ 1 of 2 left   credits ▓▓▓░░░ 31k/50k          │
├─ NEEDS YOU (1) ──────────────────────────────────────────────────────────────────────────┤
│ ⚠ SENTINEL_INCONCLUSIVE · release 9f1c · staging never became ready in 90s                 │
│   The Queen parked it at staging. [Ship anyway] [Hold]  runbook ▸   trace ▸                  │
├─ SWARM FLOOR · 23 builds at once ────────────────────────────────────────────────────────┤
│ ■■■■■■■■■■■■ ▣▣ ◆◆◆◆◆ ⧉⧉⧉ ⌛                                                                │
│ building 12 · deploying 2 · gating 5 · racing 3 (1 race) · waiting on paths 1             │
│ tile hover: "c4 Dark mode · DeepSeek V4 Flash · build 1:12 · forked from main@a1f2"        │
├─ MERGE QUEUE ────────────────────────────────────────────── 31 landed today · p50 wait 2m ┤
│ main@7c01 ◀━ K41 [c2 c5 c7 c9] LANDING ◀━ K42 [c3 c8] GATING ◀━ K43 [c11] MERGING           │
│ waiting to board: c12 c14                                                                 │
│ ⚡ conflict  c6 vs K41 on src/lib/format.js → reworking (waits for K41)                    │
│ ✂ bisect   K39 [c1 c4 c10 c13] ✗ smoke → [c1 c4] ✓ landed · [c10 c13] → c13 ✗ reworking     │
├─ GOALS ──────────────────────────────────────────────────────────────────────────────────┤
│ ◆ goal "Dark mode, a /health page, fix the footer"        5 items · 2 landed · 1 shipped   │
│   ├ feature Dark mode toggle        racing best-of-3 ▸ 2 passed, deciding 41s             │
│   ├ feature /health JSON endpoint   SHIPPED 8m lead time                                  │
│   ├ chore   Theme tokens            waiting: src/lib/theme.js held by "Dark mode toggle"   │
│   └ bug     Footer year hardcoded   BLOCKED needs: /health JSON endpoint                   │
├─ THROUGHPUT (24h) ──────────────────────┬─ BLOCKED / FAILED ─────────────────────────────┤
│ landed 31 shipped 27 lead p50 11m        │ bug "Flaky smoke on /api" FAILED · retry ▸      │
│ peak 38 concurrent · conflicts 3 · bisects 1 │                                             │
├─ COMPOSER ───────────────────────────────────────────────────────────────────────────────┤
│ [ Describe the goals…                                             ] [x] split into items    │
│                                                        best-of [auto ▾]  [Send to Queen]    │
└──────────────────────────────────────────────────────────────────────────────────────────┘
 footer: lanes ▸  queue ▸  events ▸  metrics ▸  models ▸
```

- **Swarm floor** (`SwarmFloor.tsx`):
  - one tile per active BUILD train, grouped by phase, with a race's candidates outlined together;
  - tiles animate on phase change (CSS transitions only), and a newly forked tile slides in;
  - a tile links to its item;
  - above 120 tiles it collapses to per-phase bars with counts, so the page stays readable at hundreds.
- **Merge-queue strip** (`MergeQueue.tsx`):
  - cars as a right-to-left rail ending at main, with member chips and each car's phase (`MERGING` = car BUILDING, `GATING`, `LANDING`, and `⚡ fast-forward` when the gate was skipped);
  - the waiting-to-board chips;
  - the last 3 conflicts and bisects as one-line stories, linking to the item and the trace.
- **Headline colours:** SHIPPING green, BLOCKED amber, NEEDS YOU red, IDLE grey. When the Queen degraded the hive, the autonomy dropdown shows `autonomous → supervised (error budget)`.
- **Item rows** show the ACTIVE sub-state (§2.1) and the `waitReason`.

### 5.2 Merge-queue page (`/p/:hive/queue`)

- **Top:** the rail from §5.1, full width.
- **Below it:** a table of cars from the last 24 h (car, members, base → head, merge ms, gate verdict, fast path, landed sha, wait time).
- **Car detail:** expanding a car shows the `MergeResult` (merged order, conflicts with paths and kind) and, for a bisect, the tree of compositions.
- **Data:** live from `train.updated` for QUEUE-lane trains, with history from `GET /hives/:hive/queue`.

### 5.3 Work item page

```
┌ ◂ demo / feature #G-c3  "Theme tokens"  P2 · ACTIVE (reworking: conflict) · trace 4e1f… ▸ ┐
│ source: oracle (goal "Dark mode, …")  depends on: –  paths: src/lib/theme.js (predicted)   │
│ claims: src/lib/theme.js · src/lib/format.js (conflict)                                   │
│ Acceptance: ☐ tokens exported  ☐ dark + light values  ☐ used by /features/dark              │
├ ATTEMPTS ───────────────────────────────────────────────────────────────────────────────── │
│ #1 BUILD   DeepSeek V4 Flash  ✓ gate 3/0 · 2.4 KB  → boarded K41 → ⚡ conflict on          │
│            src/lib/format.js (content) with c6                                            │
│ #2 REWORK  (conflict 1/2) waiting for K41 → forked main@7c01 → building 0:48               │
├ RELEASE ─ (none yet) ───────────────────────────────────────────────────────────────────── │
├ EVENTS (item) ─ 12:01:03 item.filed · 12:03:40 queue.conflict · … [all events ▸]           │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

A race attempt lists each candidate with its model, gate result, size and `verified`, with a ★ on the winner and the ranking reason (§2.3.6). Actions on the page: retry, cancel, not-duplicate (only where valid). The page also shows the Scribe or conflict summary of each failed attempt, and the recalled-memories chip (reused from `MemoryRecall`).

### 5.4 Trace view

```
trace 4e1f9a… "Dark mode, a /health page, fix the footer"   links: release 9f1c ▸
0s        30s        60s        90s        120s       150s       180s
├ goal G ─────────────────────────────────────────────────────────────────────────────┤
│├ oracle G-decompose-1 ██ 6s ok (5 children)
│├ item c1 ── train A  fork █ build ████████ deploy ██ gate ███ ✓ ─ car K1 ⚡ land █ merged
│├ item c2 ── race R
││   ├ train B0 fork █ build ██████████ deploy ██ gate ████ ✗
││   ├ train B1 fork █ build ███████████████ deploy ██ gate █████ ✓
││   └ train B2 fork █ build ████████████ deploy █ gate ████ ✓ ★ ─ car K2 merge █ gate ███ land █
│├ item c4 ── train D  fork █ build █████████ deploy █ gate ███ ✓ ─ car K2 (same span)
click a span → side panel: command id, executor, attempt, outcome, summary, ledger (git notes),
car members and MergeResult, "Workers Logs: filter trace_id = 4e1f…"
```

The parallel bars starting at the same x are the point: they show independent builds forking together.

### 5.5 Event log and metrics

- **Event log:** a virtualized table (time, type, severity, actor, item, train, release, summary) with filter chips (type prefix, including `queue.` and `affinity.`; severity; actor) and a search box for item, train or trace. It live-tails `event.appended` and pages back with `before=seq`.
- **Metrics:** tiles plus small multiples:
  - **concurrency over time** (active builds, leased slots);
  - **merge queue:** depth, wait p50/p90, cars by size and outcome, conflicts and bisects per hour;
  - throughput per hour (filed / landed / shipped);
  - lead time p50/p90;
  - gate first-try pass rate;
  - rework and race counts, and race wins by model;
  - change-success SLO burn-down;
  - credits per day against the budget;
  - Sentinel error rate and p99 per release.

  Range 24h or 7d. Data comes from AE via the edge in live mode and from Queen rollups otherwise; the source is labelled. Charts follow the dataviz skill.

**The lanes page (existing War Room)** gets three additions:
- BUILD trains render as parallel lanes that all start from main;
- race candidates render as stacked cars in one lane with a "best of N" badge and a star on the winner;
- the ledger panel links to the trace view.

---

## 6. Sim mode (`apps/queen/src/sim/sim-ports.ts`)

`SimExecutors` gains an `oracle` port and a MERGE fake. All fakes run off DO alarms as today, and the job id is the command id. Sim defaults: `SWARM_MAX_ACTIVE_BUILDS = 1000`, `maxActiveTrains = 64`, and build delays jittered 4–12 s from a hash of the trainId, so builds visibly overlap and finish out of order.

**Sim paths.** Every sim build "changes" `src/features/<slug>.js` plus `src/features/index.js` (generated), plus:
- each `[touch:<path>]` marker in the item text: **predicted**, because the Oracle fake copies it into `paths`;
- `src/lib/shared.js` when the text has `[collide]`: **unpredicted**, so the Oracle fake does not copy it.

The fake reports these as `BuildResult.changedPaths`.

| fake | behaviour |
|---|---|
| **oracle DECOMPOSE** | Splits the prompt on lines starting `-`, `*`, `•` or `\d+.`, or on `;`. With one part, it returns one child. **Kind:** `bug` if the part matches `/\b(fix\|bug\|broken)\b/i`, `chore` if it matches `/\b(chore\|rename\|bump\|refactor\|cleanup)\b/i`, else `feature`. **Markers:** `[hard]` sets difficulty hard; `(after N)` or `depends on #N` sets `dependsOn: ["cN"]`; `[touch:p]` adds `p` to `paths`. **Acceptance:** one line, `"<title> is visible at /"`. **Dedupe:** Jaccard word overlap ≥ 0.8 against open item titles from the snapshot gives `similar: [{itemId, score: 0.95}]`. `[decompose-fail]` gives `ok: false` (the fallback demo). Delay 800 ms. Usage: 1.2k tokens. |
| **oracle TRIAGE** | The same Jaccard against open items gives `similar`. Delay 300 ms. |
| **drones (BUILD/REWORK)** | As today, plus synthetic `usage` (tier-scaled), `verified: true` (false for the race candidate 0 build when the prompt has `[fail]`), and `changedPaths` as above. `[spot-bug]` reports one follow-up: bug "Spotted: README badge link 404s" (first BUILD only). A REWORK whose `scribeSummary` starts with "Merge conflict" drops `src/lib/shared.js` from its changes, so the rebased rework merges cleanly. |
| **drones (MERGE)** | **Sim main** is an in-memory, per-hive log of `{seq, trainId, paths}` for everything merged into main or into an active car. For each member in order, a member **conflicts** if any of its non-generated paths was changed by an entry *after the member's fork point* (the log length when its FORK was faked) that is in the car's base chain or merged earlier in this car. Otherwise it merges and is appended. `fastForward` is true for a single member whose fork point equals the car base. Delay 1.5 s. |
| **drones (LAND)** | As today. The car's members' entries become "landed" in sim main. |
| **gate** (sim "test" job) | As today, plus `score`: approved; `changedBytes` from a deterministic hash of `trainId` (2–12 KB); `satisfied` 3; `missing` 0. In a race, `[fail]` fails candidate 0 only, and `[review-fail]` makes the reviewer reject candidate 0. Candidates 1+ pass, so the winner is the smallest `changedBytes`. `[gate-spot]` sends one out-of-diff security follow-up. **Cars:** the integration gate (no reviewer) fails any car in which a `[batch-fail]` member was merged on top of changes it did not fork from (other members, or entries landed after its fork point). So `[batch-fail]` passes alone, fails in a batch, is isolated by bisect, fails again as a singleton on a moved main ("passed alone, fails integrated"), and its REWORK, forked from the new main, takes the fast path and lands. |
| **herald / provisioner** | Unchanged. They log trace ids. The fork fake records the member's fork point in sim main. |
| **sentinel** | As today (`[canary-fail]` rolls back at 10%), plus `[inconclusive]`: staging gets `inconclusive: true` and ROLLBACK. |
| **governor** | The real `SwarmGovernor` DO runs in sim with the sim ceiling. |
| **analytics** | `NoopMetricsSink` (no AE binding in sim). Rollups in SQLite power the Metrics page. |

**Sim race trigger:** `[race]` in a prompt or item title sets `bestOf: 3` when filed. `[hard]` from DECOMPOSE gets width 3 through the policy.

**Demo prompts** (added to `DEMO_PROMPTS`, decompose on):

1. **"Goals"**, the small, legible one, for the opening shot:
   ```
   - Add a dark theme toggle [hard] [touch:src/lib/theme.js]
   - Add a /health JSON endpoint
   - Add theme tokens for the status page [touch:src/lib/theme.js]
   - Fix the hardcoded footer year (after 2)
   ```
   This shows a race, affinity (item 3 waits on item 1's claim), a dependency, and a fast-path landing.
2. **"Swarm"**, the concurrency shot: 24 bullets generated by `demoSwarmPrompt(24)` (`Add a /features/<word> endpoint returning <word> facts`). Two of them carry `[collide]`, one carries `[batch-fail]`, and one carries `[race]`. Expected run in the sim, about 90 s:
   - 24 forks in one batch, so up to 24 builds at once (with the race, 26 BUILD trains);
   - cars of 4 landing in a pipeline of 3;
   - one conflict → rework → lands after the car it hit;
   - one bisect;
   - all 24 items LANDED, then SHIPPED by one or two releases.

**Acceptance (sim, WP1.9 unit + WP2.1 e2e):** running the Swarm prompt shows ≥ 20 BUILD trains in BUILDING or later simultaneously; at least one car lands ≥ 3 members in one LANDER push; the `[collide]` pair yields exactly one `queue.conflict` and both items end LANDED; `[batch-fail]` yields one `queue.bisect`, its item is reworked exactly once, and then it ends LANDED.

---

## 7. Risks and open questions (each with a recommendation)

| # | risk / question | recommendation |
|---|---|---|
| R1 | **Merge-queue correctness** (bisect, supersede of stacked cars, conflict removal before successors fork, late results from ejected cars). | Opus owns `queue.ts` with table-driven tests (WP1.11): a conflict in the middle member; all members conflict (empty car); a bisect under a stacked successor; a late `MergeResult` for an ejected car (`ignored:stale`); `NOT_FAST_FORWARD` (infra path, no bisect); 3 infra failures → `EXECUTOR_LOST` and a paused queue. The cut line `maxQueueBatch = 1` removes bisect if it isn't solid by Oct 10. |
| R2 | **isomorphic-git merge limits** (1.42.6, verified in `node_modules`): no recursive strategy (it fails on more than one merge base); add/add and other non-content conflicts throw `MergeNotSupportedError` with no paths; a shallow clone can hide the merge base. | Pre-check with `findMergeBase`; deepen once on 0 bases; map every unsupported case to a conflict → REWORK (correct, if slower); compute paths with our own `changedPaths`. A linear main (only the queue writes it) makes criss-cross unlikely. |
| R3 | **Hot files serialise everything.** If every feature edits one file, affinity runs the hive one item at a time, and without affinity every pair conflicts. | The template's only shared file, `src/features/index.js`, is generated and merged by `registryMergeDriver`. The builder prompt already says "prefer new files; don't edit src/index.js". `GENERATED_PATHS` are never claimed. Watch `affinity_waits` and `queue_conflicts` in the sim run. |
| R4 | **Path predictions are wrong.** Too broad over-serialises; too narrow means conflicts. | Unknown = optimistic, and the queue is the safety net. Actual `changedPaths` widen claims as soon as a build pushes. Conflict reworks don't count as attempts but are capped (D7). Measure both rates. |
| R5 | **Workers AI 300 rpm** bounds live concurrency at ~75 builders; 429s could also poison the router's model stats. | The `SwarmGovernor` leases from `SWARM_AI_RPM`; the drones back off on 429 without reporting a model failure (§4.3, item 5). No limit raise is requested (D10 declined), so live concurrency stays within the default quota. The video claims "dozens live, designed for thousands" and backs it with the sim Swarm run and §4. |
| R6 | **The race-condition story changes:** v1 chained builds; v2 merges trees that were tested separately. | Main moves only to a gated tree (§2.3.3). The fast path is used only when the tree is provably identical (single member, fast-forward). |
| R7 | Races cost N forks, previews, gates and LLM tokens. | Race only hard items and reworks, cap at 3, gate on budget and slots, use a 90 s grace after the first pass, and eject losers immediately. |
| R8 | **The old AWAITING_TAP release on `demo` auto-ships** after the upgrade. | Migration v10 sets existing hives to `supervised` (D2, decided). The user flips `demo` to autonomous after checking the War Room. |
| R9 | Runaway self-amplification (bugs filing bugs). | Depth cap, hourly auto-file cap, open-item cap, exact and vector dedupe, budget, a rollback streak that degrades to supervised, rework and conflict exhaustion that escalate instead of filing, and the `paused` level. All of it is visible as events. |
| R10 | Decomposition quality on Workers AI models (JSON drift, over-splitting, bad paths). | A strict JSON schema, `maxChildren`, temperature 0, fallbacks from the router role `planner`, a single-item fallback, the repo file list in the prompt, and the "same file ⇒ dependency" rule. |
| R11 | Dedupe false positives swallow a distinct bug; Vectorize is eventually consistent (~1 min). | Only auto-filed items are deduped (0.90; 0.92 for children); `not_duplicate` reverses it; the exact `(source, ref, normalized title)` dedupe runs first. |
| R12 | **The Queen DO becomes the bottleneck** at hundreds of builds (reload per RPC, broadcast fan-out). | The warm state cache, coalesced `batch` frames and `createBatch` (§4.3), with load-test acceptance (WP3.4). TrainNode sharding after Oct 14 (§4.5). |
| R13 | Event log growth in DO SQLite at swarm volume. | Summaries ≤500, data ≤4 KB, prune to 30 days or 100k rows in the alarm; `debug` events are not broadcast. Sharded event logs come later (§4.5). |
| R14 | Platform tracing is beta and has its own trace ids. | Our trace lives in `event_log` + Workers Logs fields. Enable `observability.traces` but don't depend on it. |
| R15 | A Sentinel `INCONCLUSIVE` verdict reaching an old Queen. | Encoded as `inconclusive: true` with verdict ROLLBACK (backward-safe). Deploy the Queen first anyway. |
| R16 | **The v11 migration with v1 trains in flight.** | Deploy when the snapshot shows no active trains (`deploy.sh` checks `/snapshot` and refuses otherwise, `--force` to override). |
| R17 | Merge commits on main make history non-linear and slightly change what "the landed sha" means. | It is the car head. Releases, Sentinel and canary use it unchanged. Ledger notes stay on the members' own commits, which remain reachable (D8). |
| R18 | Budget credits are an approximation (Workers AI pricing differs per model). | Label them "credits (weighted tokens)". They are a guardrail, not billing. |
| Q1 | Should dependents dispatch speculatively on top of an unlanded dependency's fork (stacked PRs)? | Not by Oct 11. It needs a merge-base story when the dependency is reworked (§9). |
| Q2 | Should `paused` stop in-flight canaries? | No. It stops new dispatch and new canaries (AWAITING_TAP). In-flight canaries finish, and rollback stays automatic. |

---

## 8. Implementation plan (parallel subagents)

The rules from `docs/HANDOFF.md` apply:
- the coordinator never edits;
- the contracts come first;
- file ownership is disjoint within a phase;
- one lockfile writer (the coordinator runs `pnpm install` after Phase 0 scaffolds `apps/oracle/package.json`);
- verify with `pnpm turbo run build typecheck lint test --force --continue` under Node 24;
- commit and push after each phase.

**Every phase leaves `main` deployable and green.** New fields are optional, and new modules are inert until Phase 2 wires them. The BUILD/QUEUE lane split is the one behaviour change; it stays behind `lane` until WP2.1 switches `submit()` to it.

### Phase 0: contracts, migrations, seams (Oct 6, morning, ~0.5 day). One agent, before any fan-out.

**WP0 (Opus)**
- **Owns:**
  - `packages/queen-types/src/{trace,work,oracle,autonomy,observability,queue}.ts` (new);
  - `packages/queen-types/src/{state,train,drone,executors,releases,models,telemetry,index,index.test}.ts`;
  - `apps/queen/src/db.ts`: migrations v8–v11; row mappers and upserts for `work_items`, `races`, `hive_settings`, `escalations`, `event_log`, `metrics_hourly`, `path_claims`; `rowToTrain`/`upsertTrain` gain the v9 and v11 columns; `rowToAudit` reads `event_log`;
  - `apps/queen/test/migrations.test.ts` (new);
  - **seams for disjoint ownership in Phase 1** (signatures, types and `throw new Error("not implemented")` bodies, plus their exports):
    - `apps/queen/src/train/queue.ts`: `formCars`, `mergeResult`, `carFailed`, `carLanded`, `rewriteMembers`, operating on `TrainRecord[]` and returning patches and effects;
    - `apps/queen/src/work/affinity.ts`: `claimsFor`, `blockingClaim`, `widen`, `release`;
    - `apps/queen/src/scale/{state-cache,broadcast,governor}.ts`;
    - `packages/hive-kit/src/{merge-driver,registry,log,metrics}.ts`, all exported from `packages/hive-kit/src/index.ts` (so no Phase 1 agent edits `index.ts`);
  - **the registry move:** `renderRegistry` / `registryModules` / `mergeRegistry` / `featureModuleName` move from `apps/drones/src/scripted.ts` to `packages/hive-kit/src/registry.ts`, and `scripted.ts` re-exports them (a behaviour-preserving move; drones tests stay green);
  - scaffold `apps/oracle/{package.json,tsconfig.json,wrangler.jsonc,eslint.config.js,src/index.ts}` (a stub Workflow that throws "not implemented").
- **Also:** `RUNBOOK`, `GUARDRAIL_DEFAULTS`, `GENERATED_PATHS`, `pathsOverlap` (implemented, with tests), `spanIdFor` (FNV-1a 64) with test vectors, and `traceIdFromUuid`.
- **Acceptance:**
  - all turbo tasks green;
  - a fresh DO migrates to v11;
  - a v7 fixture with 3 prompts, audit rows and a release migrates: 3 `work_items` rows, `event_log` has the audit rows, `hive_settings.autonomy = 'supervised'`, every train has `lane = 'BUILD'`, and the snapshot is unchanged for v1 consumers;
  - `index.test.ts` round-trips every new schema, including `MergeResult`, `GateTarget` and `SwarmLease`, and old payloads (no new fields) still parse;
  - the `pathsOverlap` table tests cover equal paths, a directory prefix, a sibling prefix (`src/a` vs `src/ab`), and generated paths.

### Phase 1: pure logic, executors, sim, dashboard data (Oct 6 PM – Oct 8, 2.5 days). Fourteen agents in parallel.

| WP | model | owns (exclusive) | depends | acceptance |
|---|---|---|---|---|
| **1.1 Work ledger + affinity** | Opus | `apps/queen/src/work/{ledger.ts,guardrails.ts,compose.ts,affinity.ts}`, `apps/queen/test/{work-ledger.test.ts,affinity.test.ts}` | P0 | **Pure `WorkPlanner`:** `fileGoal`, `fileItem`, `oracleResult` (dedupe, cycles, truncation, fallback, path normalisation), `absorb` (prompt → item status, landed cars → LANDED, release → SHIPPED, rollback bug + streak, followUps, `changedPaths` and conflict paths → claims), `dispatchReady` (priority, deps, slots, budget, paused, **claims**, `waitReason`), `retry`/`cancel`/`notDuplicate`, `reconcile` (Oracle watchdog → fallback or `EXECUTOR_LOST`; release the claims of terminal items). **Tests:** a table for every state-machine edge and guardrail; affinity: an overlap waits, a non-overlap dispatches the same tick, a P0 waiter goes first when the claim frees, an empty `paths` never waits, generated paths never wait, a conflict widens claims. |
| **1.2 BUILD lane + races** | Opus | `apps/queen/src/train/{planner.ts,race.ts}`, `apps/queen/src/models/router.ts`, `apps/queen/test/{planner.test.ts,router.test.ts,race.test.ts}` | P0 | **Lane split:** BUILD trains fork from main (`forkSourceFor`), with no supersede in BUILD, `passedSeq` on pass, and `waitForCarSeq` holding WAITING_PARENT. **QUEUE hooks:** cars dispatch the MERGE drone; `mergeResult()`; car-level `landResult` fans out to members; `maybeLand`, `fail` and `reconcile` call `queue.ts` (the stub until 1.11 lands). **Races** (§2.3.6): `raceWidth`, `routeRace`, `rankCandidates` with the path-risk key; trace stamping; `EventDraft`s from `setTrain`. **Tests:** v1 tests are rewritten where chaining was asserted (they now assert parallel forks from main); 6 independent submits → 6 FORK effects with `sourceRepo = namespace` in one plan; a race's candidates all fork from main; a winner gets `passedSeq`, losers EJECTED; all-fail → REWORK attempts +1; a late loser result is `ignored:stale`; a REWORK with `waitForCarSeq` stays WAITING_PARENT until the car is terminal; the floor doesn't move on race candidates. |
| **1.11 Merge queue** | Opus | `apps/queen/src/train/queue.ts`, `apps/queen/test/{queue.test.ts,planner-queue.test.ts}` | P0; 1.2's hooks for `planner-queue.test.ts` (Oct 8) | §2.3.4 exactly. **Pure tests:** `formCars` (order by priority then `passedSeq`; pinned bisect halves first; depth and batch caps; stacking on the previous car); `mergeResult` (a conflict in the middle member, all conflict → empty car EJECTED, members rewritten on later cars, fast path); `carFailed` (bisect 4 → 2+2; a stacked successor superseded with its members back in the pool and no attempts; a singleton → member `fail()` with the integration summary; infra → no bisect; 3 infra → `EXECUTOR_LOST` + paused). **Planner integration:** a 4-member car lands → 4 BUILD trains MERGED with one `landedSha`, forks deleted, previews torn down, `rp.landed` gets the members; duplicate and stale `MergeResult` handled. |
| **1.12 Merge + land git** | Opus | `packages/hive-kit/src/{git.ts,git.test.ts,merge-driver.ts,merge-driver.test.ts,registry.ts}`, `apps/drones/src/{merge.ts,land.ts}`, `apps/drones/test/{merge.test.ts,land.test.ts}` | P0 | **`GitRepo`** gains `merge({theirs, message, timestamp, mergeDriver})` → `{oid, fastForward} \| {conflict: MergeConflict}`, `findMergeBase`, `changedPaths(from, to)`, and `deepen`. **`mergeCar(ports, task, ts)`** (§2.3.4) and a multi-member `landTrain` (carrying notes from every member fork). **Tests on real isomorphic-git over memfs:** 4 clean members (merge commits, the first a fast-forward); a content conflict on member 3 → recorded with `filepaths`, the others merged, main untouched by the conflict; add/add → `unsupported` with paths; two features both registering in `src/features/index.js` → **no conflict**, a union registry; a replay with the same timestamp → identical SHAs; a shallow base → deepen → merge; a 3-member land carries the notes. |
| **1.4 Observability core** | Sonnet | `apps/queen/src/obs/{events.ts,rollup.ts,metrics-sink.ts,trace-view.ts,log.ts}`, `apps/queen/test/obs.test.ts`, `packages/hive-kit/src/{log.ts,metrics.ts}` + tests | P0 | `EventDraft` → row; rollup upsert SQL (including the queue and concurrency metrics); `buildTraceView(events)` (span tree from issued/result pairs; car spans shared across member traces); `pruneEvents`; `AnalyticsSink` (AE `writeDataPoint` wrapper, no-op without a binding, **≤200 points per invocation**, drops counted); hive-kit `structuredLog({trace…})` and `metricPoint()` for executors. |
| **1.5 Oracle** | Sonnet | `apps/oracle/**`, `packages/hive-kit/src/{memory.ts,memory.test.ts}` | P0 (+ install) | `runOracle` for DECOMPOSE/TRIAGE with a StepRunner and ports seam (fakes in tests): the **repo listing step**; a JSON-schema prompt with `paths` and the same-file-dependency rule; fallbacks; reports through `QUEEN` RPC. `HiveMemory.findSimilarItems` and `indexItems`; `recall` drops `kind=work-item`. wrangler: AI, MEMORY, ARTIFACTS, QUEEN, ANALYTICS, `observability.enabled`. Optional (cut line 4): `pathsFromMemory`. |
| **1.6 Drones** | Sonnet | `apps/drones/**` except 1.12's files; `packages/hive-kit/src/{ai-gateway.ts,ai-gateway.test.ts}` | P0 | `orchestrate.ts` routes action `MERGE` → `runMerge` (calls `mergeCar`, reports `reportMergeResult`, ledger audit role LANDER, model `queenos/merge-git`); `finish` accepts `followUps` (≤3, prompt rule); `BuildResult` gets `verified`, `followUps`, `usage` and **`changedPaths`** (diff against the fork base); a **429 / rate-limit is retried with jittered backoff and never added to `failedModels`** (test); structured logs with the trace from `DroneTask.trace`; AE build point; observability config. |
| **1.7 Gatekeepers and Sentinel** | Sonnet | `apps/gatekeepers/**`, `apps/sentinel/**` | P0 | `TrainResult.score`; out-of-diff findings → `followUps` without failing; `getGateTarget` with snapshot fallback; **the integration gate for `lane: QUEUE`** (no reviewer, `review: "skipped"`, scans on `baseSha..head`, smoke over `/`, `/health` and every member's `smokePaths`, no memory write, the Scribe summary names the failing member route); trace from the target; Sentinel `inconclusive`, the AE window point, trace logs. |
| **1.8 Herald, Provisioner, config** | Haiku | `apps/herald/**`, `apps/provisioner/**`, `apps/{edge,genesis,vault}/wrangler.jsonc` | P0 | Log trace fields from `cmd.trace`; `"observability": {"enabled": true, "head_sampling_rate": 1}` on every Worker (traces disabled by default; a commented line to opt in); the Provisioner FORK of a car's source repo (a car fork) needs no change, verified by a test. |
| **1.9 Sim fakes** | Sonnet | `apps/queen/src/sim/sim-ports.ts`, `apps/queen/test/sim-ports.test.ts` | P0 | Everything in §6: the Oracle fake (`sim.oracle`, `[touch:]`), sim paths, the **sim-main log and MERGE fake**, `[collide]`, `[batch-fail]`, build jitter, `demoSwarmPrompt(n)`. `SimQueen` gains `reportOracleResult` and `reportMergeResult`. Unit tests per marker, and a test that two `[collide]` members in one car yield exactly one conflict. |
| **1.10 Dashboard data layer** | Sonnet | `apps/dashboard/src/{reducer.ts,api.ts,mock.ts,mockQueen.ts,useMockQueen.ts,route.ts,status.ts,swarm.ts}`, `apps/dashboard/test/**` | P0 | The reducer handles `batch` frames (applied atomically) and the new messages and snapshot fields. **Selectors:** headline, pipeline counts, goal trees, race view, **swarm floor tiles by phase, the queue rail (cars by seq with members), the waiting-to-board list, recent conflicts and bisects** (`swarm.ts`). Routes from §5; a REST client for items, events, traces, metrics and the queue. The mock queen emits a v2 swarm (20+ builds, cars, a conflict, a bisect, a race, an escalation). |
| **1.13 Scale plumbing** | Sonnet | `apps/queen/src/scale/{state-cache.ts,broadcast.ts,governor.ts}`, `apps/queen/test/{state-cache.test.ts,broadcast.test.ts,governor.test.ts}` | P0 | **`StateCache`**: load once, apply plan rows (upserts and terminal evictions), `invalidate()` on error; a test that the cache equals a fresh load after random plan sequences. **`Coalescer`**: per-entity last-write-wins, ≤1 frame per 100 ms, a flush on the next apply. **`SwarmGovernor` DO**: lease, renew, expiry, fair share, `want = 0` release; ceilings from env (§4.3). |

### Phase 2: integration and UI (Oct 9 – Oct 10, 2 days). Five agents in parallel.

| WP | model | owns | depends | acceptance |
|---|---|---|---|---|
| **2.1 QueenNode integration** | Opus | `apps/queen/src/{queen-node.ts,index.ts,auth.ts,executors.ts,drones.ts}`, `apps/queen/src/sim/worker.ts`, `apps/queen/wrangler.jsonc` (ORACLE workflow binding, `SwarmGovernor` DO + migration tag, `analytics_engine_datasets` `ANALYTICS`→`queenos_events`, `SWARM_*` vars, observability), `apps/queen/worker-configuration.d.ts`, `apps/queen/test/{queen.test.ts,v2-flow.test.ts,fakes.ts,worker.ts}`, `apps/queen/README.md`, `scripts/deploy.sh` (add `oracle`; refuse when active v1 trains exist, R16) | 1.1–1.13 | **Wiring:** the `decide()` pipeline (§3.1) with `formCars`, the state cache, the coalesced broadcast, `createBatch` dispatch, the lease before `decide()`; every route and RPC in §3.6, including `reportMergeResult` and `GET /queue`; snapshot and broadcasts; events in the same transaction; AE after commit; alarm = reconcile ×3 + prune + lease. **e2e under vitest-pool-workers with sim ports:** (a) a 4-bullet prompt → goal + children, the dependent waits, all SHIPPED automatically, one trace id across every event; (b) `[race]` → 3 candidates fork from main together, the winner boards a car and lands, losers EJECTED; (c) **parallel:** 6 independent items → 6 FORK commands in one apply, all from main, ≥5 BUILDING at once; (d) **queue:** with `maxQueueDepth` cars in flight, 4 more items pass, then board **one** car when a slot frees (one LANDER dispatch, 4 items LANDED); (e) **conflict:** a `[collide]` pair → one `queue.conflict`, a REWORK with `waitForCarSeq`, both LANDED in the end; (f) **bisect:** `[batch-fail]` + 3 others → `queue.bisect`, the 3 others LANDED, the culprit reworked once (attempts 1) and then LANDED; (g) **affinity:** two items with `[touch:src/lib/theme.js]` → the second has `waitReason` until the first is LANDED; (h) `[canary-fail]` → ROLLED_BACK + P0 bug filed and dispatched; a second rollback → supervised + `ROLLBACK_STREAK`; (i) a supervised hive → `APPROVAL_REQUIRED`, resolve `ship` → canary; (j) budget exhausted → no dispatch + escalation. The `pnpm dev:sim` curl quickstart is unchanged. |
| **2.2 Status home and item page** | Sonnet | `apps/dashboard/src/{StatusHome.tsx,ItemView.tsx,WarRoom.tsx,router.tsx,shell.tsx,components.tsx,styles.css,Home.tsx,demo.ts}` | 1.10 | §5.1 layout (it hosts `SwarmFloor` and `MergeQueue` by the agreed export names), §5.3, and the lanes additions; escalation actions call the API; the composer's "split into items", best-of, and a "Swarm demo" button in sim/mock; works with `VITE_MOCK_API=1` and against `dev:sim`; usable at 390 px. |
| **2.3 Trace, events, metrics UI** | Sonnet | `apps/dashboard/src/{TraceView.tsx,EventLog.tsx,Metrics.tsx,obs.css}` + their tests | 1.10 | §5.4 (car spans, parallel bars) and §5.5 (concurrency and queue charts); routes are registered by 2.2 (agreed export names `TraceView`, `EventLog`, `Metrics`); charts follow the dataviz skill; the AE source with rollup fallback. |
| **2.4 Edge** | Sonnet | `apps/edge/src/**`, `apps/edge/test/**` | P0 | `GET /api/metrics/:hive?q=` with allowlisted AE SQL (secret `ANALYTICS_API_TOKEN`, account id var), 503 → the dashboard falls back; the internal webhook route for `merge-result`; user routes (`PATCH settings`, resolve, items) keep `x-queen-user`; tests for the allowlist (no raw SQL from the client). |
| **2.5 Swarm floor + merge queue UI** | Sonnet | `apps/dashboard/src/{SwarmFloor.tsx,MergeQueue.tsx,QueuePage.tsx,swarm.css}` + their tests | 1.10 | §5.1 floor and rail, §5.2 page (route registered by 2.2 as `QueuePage`). Tiles animate by phase; collapse to bars above 120 tiles; the conflict and bisect stories link to the item and the trace; the mock swarm renders 40 tiles at 60 fps in a dev build; usable at 390 px (the rail scrolls horizontally inside its own box, never the page). |

### Phase 3: live, docs, hardening (Oct 11, 1 day)

| WP | model | owns | acceptance |
|---|---|---|---|
| **3.1 Live rollout** | coordinator + user | scratchpad deploy script | **One-time:** the Vectorize `kind` metadata index; `wrangler secret put ANALYTICS_API_TOKEN` (edge); deploy oracle alone (`--env=""`), then `./scripts/deploy.sh` (queen first, with no active trains). **On `demo`:** check the old release; flip it to autonomous; run the 4-bullet Goals prompt, then a 12-item live swarm; watch ≥ 8 builds at once, one multi-member car, SHIPPED with no tap. **AI burst test:** 30 builder calls in one minute on each catalog builder model; record any 429 and set `SWARM_AI_RPM` from it. The AE dataset appears after the first write; query it once via the SQL API. |
| **3.2 Docs** | Sonnet | `README.md`, `docs/HANDOFF.md`, `docs/demo-script.md` | The new pitch (an army of virtual engineers; the practices table from §1.1; parallel builds through a merge queue; best-of-N; self-filed bugs; SLO-gated autonomy; trace drill-down; the scale story from §4 with honest numbers); the HANDOFF "three questions" answer for conflicts becomes "path affinity + a speculative, batched merge queue"; the sim quickstart with the new markers and the Swarm prompt. |
| **3.3 Fix pool** | Sonnet ×2 | assigned per bug | A green turbo run, then a live re-run. |
| **3.4 Load test** | Sonnet | `apps/queen/test/load.test.ts` | 500 sim items (`demoSwarmPrompt(500)`, `maxActiveTrains = 256`, `SWARM_MAX_ACTIVE_BUILDS = 1000`) through one hive: every item LANDED; **0 SQLite row loads per report RPC** after warm-up; ≤ 10 broadcast frames per simulated second; ≤ 16 Queen RPCs per BUILD train on average; the event log under the prune cap. No wall-clock assertions (§4.3, item 7). |

### Schedule

| date | phase |
|---|---|
| Oct 6 | Phase 0 (AM) → Phase 1 kickoff (PM) |
| Oct 7–8 | Phase 1 (1.11's planner integration tests on Oct 8, after 1.2's hooks) |
| Oct 9–10 | Phase 2 |
| Oct 11 | Phase 3 (live + docs + load test) |
| Oct 12–13 | rehearsal + recording (unchanged from the roadmap); buffer for fixes |
| Oct 14 | submit |

**Cut lines if late, in order:**
1. AE edge proxy (WP2.4 metrics; keep the rollups);
2. the Metrics page charts (keep the tiles on home);
3. the `SwarmGovernor` (fall back to per-hive `maxActiveTrains` and env ceilings only);
4. memory-based path prediction (keep the Oracle's LLM prediction);
5. gatekeeper out-of-diff follow-ups;
6. **`maxQueueBatch = 1`**: no batching, no bisect. Parallel builds, the speculative queue, the integration gate, the fast path and conflict → rework all remain;
7. TRIAGE vector dedupe (keep exact dedupe).

**Never cut** (they are the video's spine): the ledger, fan-out, **parallel builds**, **the merge queue with conflict → rework**, path affinity, races, the swarm floor, autonomy, escalations, the trace view.

---

## 9. Deliberately NOT building (v2)

- Merging race candidates, or landing more than one race winner.
- **Stacked dispatch:** dependents forking from an unlanded dependency (Q1).
- An LLM **resolver drone** that fixes conflicts in place. A conflict is always a full rework of the item, rebased on the new main.
- A recursive merge strategy, rename detection, or merge drivers beyond the generated registry.
- Priority lanes in the merge queue (an express lane for P0s), or pre-empting cars.
- Pre-empting running builds when the lease shrinks.
- `TrainNode` sharding, sharded event logs, a `RoomNode`, sub-queens, a hive of hives (§4.5: designed for, not built).
- Cancelling or pre-empting ACTIVE items, and re-prioritising in-flight trains.
- Bisect + auto-revert on *staging* failure (the merge queue bisects only before main). `stagingFailed()` files a P0 bug instead.
- Re-decomposing goals, LLM-judged dedupe, learned thresholds, or learned path predictions from git history.
- RBAC or per-user permissions beyond "Access-verified human".
- OTLP export, custom platform spans, Tail Workers in user accounts, Logpush.
- Cross-hive dashboards or org-level SLOs.
- Billing-accurate cost accounting (credits are weighted tokens).
- Editing items from the dashboard beyond retry, cancel, not-duplicate and settings.

---

## 10. Decisions

### Decided (2026-10-05)

- **D1 (decided: yes).** The Queen writes Workers Analytics Engine points directly, as a fire-and-forget telemetry sink that never feeds decisions (capped at 200 per invocation, §4.1).
- **D2 (decided: yes).** Existing hives (`demo`) migrate as `supervised`; new hives default to `autonomous` (R8).
- **D3 (decided: yes).**
  - A gate failure on an item's own diff stays a same-item REWORK, not a new bug item.
  - New bugs come only from drone follow-ups, out-of-diff gate findings, and Sentinel rollbacks and staging failures.
  - Rework exhaustion escalates instead of filing.
  - The same rule now covers merge conflicts and integration failures (§3.4).
- **D4 (decided: yes, then superseded by D6 the same day).** "Builds stay chained for Oct 14" no longer holds.
- **D5 (decided: yes).** Decomposition, dedupe and now path prediction go in a new `queenos-oracle` Workflow.
- **D6 (decided by the user: parallel builds are in scope and central).**
  - Independent items fork from main together.
  - Landing goes through a speculative, batched merge queue that re-validates merged trees before main moves (§2.3).
  - "1000s of agents" is a design target backed by §4; the demo shows dozens.

### Decided (2026-10-05, second round)

- **D7 (decided: yes, as recommended).** Conflict reworks don't count as gate attempts. They are tracked in `conflicts`, capped by `maxConflictReworks` (2), and then escalate with `REWORK_EXHAUSTED`. A conflict usually isn't the builder's fault, so charging it would starve items in a busy hive, while the cap still stops hot-file loops.
- **D8 (decided: yes, as recommended).** Main gets merge commits (isomorphic-git `merge`), not a linear rebase (cherry-pick). It is the same as Zuul and GitHub merge queues: members keep their own commits and ledger notes, and a car stays one fast-forward.
- **D9 (decided: yes, as recommended).** The Queen may make one DO-to-DO call outside `decide()`: the `SwarmGovernor` lease, as the global concurrency ceiling. The alternative is per-hive caps only, which can't honour an account-wide Workers AI quota once there is more than one busy hive. It is cut line 3 if Phase 2 is late.
- **D10 (decided: no).** We do not ask Cloudflare for a higher Workers AI limit. "Thousands of agents" is a design target, not something v2 has to run live; the goal is an MVP that proves the vision. Live runs stay inside the default quota (the `SwarmGovernor` leases from `SWARM_AI_RPM`), the video says "dozens live, thousands by design", and it shows the sim Swarm run.
- **D11 (decided: yes, as recommended).** The integration gate on cars skips the LLM reviewer, and it is skipped entirely on the single-member fast-forward path. The reviewer already judged each member against its acceptance criteria, and the fast path's tree is byte-identical to the gated one.

### Decided (2026-10-07)

- **D12 (decided by the user: the inbox; every change is a Submission).** Design: `docs/human-push-design.md`.
  - **Humans and external agents push with plain `git push`** to a **per-person, persistent inbox fork** `<hive>-in-<handle>`, with 24 h write tokens scoped to that fork and minted only by the provisioner's `InboxKeys` entrypoint. This settles per person vs per session: per person.
  - **The inbox is not a PR.** A PR says "please review my branch"; an inbox push says "here's code, vet it". The swarm owns the vetting (gates, reviewer, merge queue, integration gate, lander, release ladder). The contributor opens, shepherds and merges nothing, and reads the verdict as a git note (`refs/notes/queen`) and on the dashboard.
  - **Unified intake.** All code, drone-written included, enters as a `Submission {repo, ref, headSha, origin, itemId?, provenance?}`. Provenance (model, race, attempt) is metadata for races, rework counts and the router, never a separate code path.
    - An inbox submission is pinned into an ordinary train fork by a deterministic PIN drone, so every downstream consumer is unchanged.
    - Drones keep fork + dispatch; their `BuildResult` is adapted to a Submission. The adapter can slip without blocking the inbox.
  - **The item is the competition, and the item is the inbox (2026-10-07).** A submission that targets an item (branch `item/<id>` or `goal/<slug>`, or `Queen-Item` / `Queen` / `Queen-Origin` trailers) joins that item's race as a candidate (`joined-race`; a race is created lazily at width 1). An uncorrelated push is treated as having already won a race: `filed`, a new item with no race record, straight to gate, car, land, with every gate still applied. A late entry becomes a follow-up item (`late-new-item`), never a rejection. There is no goal-level fork repo; every submission forks from hive `main`.
  - **Same rules, same consequences.** No auto-rework for human code unless the contributor hands off to the swarm. A rollback of human code is a real change failure.
  - **Human-judged races (opt-in "you pick").** They are separately shippable: a `PICKING` race state after machine pre-review, a deadline auto-pick, manual reject, and capped Elo preference weighting in the router.

### Open

None.

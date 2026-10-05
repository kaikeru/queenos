# QueenOS v2: autonomous swarm, work ledger, best-of-N, SRE observability

Status: design, 2026-10-05. Deadline 2026-10-14 (video due). Author: architect session.
Read with `docs/HANDOFF.md`, `apps/queen/README.md` and `packages/queen-types/src/*`.

---

## 1. Summary and principles

v1 turns one prompt into one train, gates it, lands it, then waits for a human tap before any canary. v2 makes the Queen run a **work ledger**:
- a prompt fans out into work items (features, bugs, chores) with dependencies;
- agents and the Queen file bug items when something breaks;
- the Queen dispatches from the ledger onto the existing speculative merge train;
- for hard items and reworks it races several drones on different models and lands the best one;
- releases ship on their own when gates and Sentinel are green.

Humans hear about it only when something escalates. Everything leaves a trace: one trace id runs from item → train → drone → gate → release → Sentinel, and one event log is both the audit trail and the source of the dashboard's drill-downs.

**Principles**
1. **The Queen decides, records, and dispatches. Nothing else.**
   - Every LLM call (decomposition), every embedding and Vectorize query (dedupe), and every deploy or probe runs in an executor Workflow. That includes the new **Oracle**.
   - New Queen logic goes in pure planners in the style of `TrainPlanner` and `ReleasePlanner`: no I/O, no clock, no randomness. Each returns rows, effects and events.
   - The only proposed exception is fire-and-forget telemetry (see decision D1).
2. **Extend, don't rewrite.**
   - A work item *is* a prompt run once it is dispatched (`prompt_runs.prompt_id = work_items.item_id`). The train planner keeps its job, and REWORK stays the self-correction loop.
   - Race candidates are ordinary trains with a `race_id`. Fork, preview, gate, watchdog and reconcile are reused unchanged.
3. **Autonomy is the default; safety comes from budgets, not ceremony.**
   - **Hard caps:** items, depth, children, trains in flight, race width, daily credits.
   - **An error budget:** the change-failure SLO.
   - **A rollback streak breaker:** repeated rollbacks degrade a hive to `supervised` on their own.
4. **Every claim about a Cloudflare product matches its docs** (checked 2026-10-05, §2.8):
   - Workers Logs is structured and queryable, with 7-day retention on paid plans.
   - Workers automatic tracing is early beta and does not propagate W3C context outside Cloudflare.
   - Workers Analytics Engine allows 20 blobs, 20 doubles and 1 index per point, with 3-month retention and a SQL API.

   Because of these limits, **our own trace ids live in our own event log**. Platform tracing and Workers Logs are complementary, filterable by our `trace_id`.
5. **Sim mode is a first-class target.** Every new executor op has a deterministic fake in `apps/queen/src/sim/sim-ports.ts`, driven by prompt markers.

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
| `source` | `{kind: user\|oracle\|drone\|gatekeeper\|sentinel\|queen, actor, itemId?, trainId?, releaseId?, commandId?}` |
| `traceId`, `spanId` | §2.6 |
| `difficulty` | `normal\|hard` (from the Oracle, or from the user's `bestOf`) |
| `bestOf` | An explicit race width from the user (1..5, capped), or null to let the Queen decide. |
| `attempts` | Mirrors `prompt_runs.attempts`, plus human retries. |
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
  deps unmet? ──yes──▶ ┌────────┐ all deps LANDED ┌───────┐ dispatcher: capacity, budget,
                       │BLOCKED │────────────────▶│ READY │ autonomy != paused
                       └────────┘                 └───┬───┘
                                                      │ TrainPlanner.submit (race width w)
                                                      ▼
                                                 ┌────────┐ prompt MERGED ┌───────┐ release SHIPPED ┌────────┐
                                                 │ ACTIVE │──────────────▶│LANDED │────────────────▶│SHIPPED │
                                                 └───┬────┘               └───────┘                 └────────┘
                                                     │ prompt FAILED (rework cap)
                                                     ▼
                                                 ┌────────┐ human "retry" → READY (attempts reset)
                                                 │ FAILED │ + escalation REWORK_EXHAUSTED
                                                 └────────┘
 TRIAGE / BLOCKED / READY / FAILED ──human "cancel"──▶ CANCELLED
```

**Rules**
- **Goal status is a rollup of its children:**
  - DECOMPOSING until the children are filed;
  - then ACTIVE;
  - SHIPPED when every child is SHIPPED, DUPLICATE or CANCELLED;
  - FAILED when the remaining children are terminal and at least one FAILED.
- **A BLOCKED item whose dependency FAILED or was CANCELLED stays BLOCKED** with `blockedReason = "dependency <id> failed"`. It is not cascaded, and it shows under "blocked" on the home page.
- **Cancelling an ACTIVE item is not supported in v2** (§8).
- **LANDED → SHIPPED** happens when a release whose `trainIds` contains a MERGED train of the item reaches SHIPPED. A canary rollback leaves the item LANDED: the code is still on main, the next release carries it again (`cutQueued(keepTrains)`), and a P0 bug is filed.

### 2.2 How a prompt becomes items

1. **Submission.**
   - The dashboard composer sends `submit_prompt {decompose: true}`.
   - `POST /hives/:hive/prompts` keeps v1 semantics by default (`decompose` defaults to false), so the curl quickstart and tests don't change.
2. **`decompose: false`.** One `feature` item is filed (title = first line, ≤120; body = full text). It skips TRIAGE, because users are not deduped, and goes to READY.
3. **`decompose: true`.** One `goal` item is filed in DECOMPOSING, and an `OracleCommand{op: DECOMPOSE}` is issued:
   - `commandId = <itemId>-decompose-<n>`;
   - the planner model comes from the router role `planner`;
   - it carries up to 30 open item titles as context and `limits.maxChildren`.
4. **The Oracle** (a Workflow, §3.3):
   - one JSON-schema LLM call, which returns ≤ `maxChildren` children with keys `c1..cN`, kind, title, body, acceptance, priority, difficulty and `dependsOn` (child keys only);
   - for each child: embed, query `queenos-memory` with `filter {namespace: hive, kind: "work-item"}`, and upsert the child's vector (id `<goalId>-c<n>`);
   - it returns `similar[]` per child.
5. **The Queen (`WorkPlanner.oracleResult`)** files the children:
   - **Duplicates:** a child whose best match scores ≥ `CHILD_DEDUPE_THRESHOLD` (0.92) against an item that still exists and is not terminal becomes DUPLICATE. The match is resolved through `duplicateOf` chains.
   - **Dependency keys** are mapped to item ids. A dependency cycle drops the edge that closes it, and an event is logged.
   - **More than `maxChildren` children:** the extra ones are dropped, and escalation `GUARDRAIL_TRIPPED` (informational) is opened.
   - **`ok: false`, or the watchdog runs out:** fall back to one `feature` child with the whole prompt. The event is `item.decomposed {fallback: true}`. Prompts never get stuck.
6. **Builder prompt composition** (`apps/queen/src/work/compose.ts`, pure). `promptText` is `title\n\nbody\n\nAcceptance criteria:\n- a\n- b` (≤ `MAX_PROMPT_CHARS`). The gatekeepers' reviewer gets the same text, so acceptance criteria become review criteria for free.

### 2.3 How items map to trains

- **One prompt run per active item.** When the dispatcher moves READY → ACTIVE it calls `TrainPlanner.submit({promptId: itemId, promptText: composed, raceWidth: w, difficulty})`.
  - `prompt_runs.prompt_id = item_id`.
  - Item status follows the prompt status: QUEUED/BUILDING/IN_TRAIN/EJECTED → ACTIVE, MERGED → LANDED, FAILED → FAILED.
- **Dispatch order** is priority, then `seq`. An item is dispatched only if all of these hold:
  - effective autonomy ≠ `paused`;
  - the daily budget is not exhausted;
  - active trains (race candidates included) + `w` ≤ `maxActiveTrains` (`w` is lowered to fit, minimum 1);
  - every dependency is LANDED or SHIPPED. Dependencies are never dispatched speculatively, because `fail()` re-enqueues superseded successors without their missing dependency.
- **Builds stay chained.** Train k forks from train k-1 once k-1 has pushed (`forkSourceFor`).
  - Fan-out gives parallel decomposition, pipelined builds, parallel previews, gates and reviews, and parallel race candidates.
  - It does **not** give parallel independent builds (risk R1).
- **REWORK is unchanged:** `TrainPlanner.fail()` re-enqueues the prompt as REWORK with the Scribe summary, up to `maxReworks`. The rework width comes from the race policy (§2.3.1).

#### 2.3.1 Best-of-N (races)

- **Width policy.** `raceWidth()` in `apps/queen/src/train/race.ts` is pure:

  ```
  if modelPin                                  → 1
  w = item.bestOf ?? (action==REWORK ? settings.race.reworkWidth /*2*/
                    : item.difficulty=='hard' ? settings.race.hardWidth /*3*/ : 1)
  w = min(w, guardrails.maxRaceWidth /*3*/, slotsFree)
  if budget.remainingCredits < w × EST_BUILD_CREDITS[tier] → 1
  ```
- **Enqueue.** `TrainPlanner.enqueue(prompt, action, w)` with w > 1 creates a `races` row (`raceId`, `state: RACING`) and w trains:
  - consecutive `seq`, same `promptId`, `race_id = raceId`, `candidate = 0..w-1`;
  - **each with its own fork from the same source**, its own builder and its own preview. The gatekeepers find them by `artifactRepo` as today.
- **Models.** `router.routeRace(input, w)` returns w distinct models: the best by value at or above the starting tier, then the next distinct ones (preferring a different vendor prefix). Each candidate's `fallbacks` exclude its siblings' models. Race candidates never move the AIMD floor; model stats still count every candidate.
- **Planner changes** (`apps/queen/src/train/planner.ts`):
  - `predecessor(t)` skips trains from the same race.
  - `forkSourceFor(next)` returns null while the predecessor belongs to an undecided race. The successor waits for the winner and then forks from it. Losers are EJECTED, so the predecessor becomes the winner naturally.
  - **A candidate passes its gate:** it stays in `TESTING` with `race_outcome = PASSED` and `gate_score` set. If this is the first pass, the race gets `deadline_at = now + RACE_GRACE_MS` (90 s); the watchdog alarm covers it.
  - **A candidate fails** (its gate, its build, or the watchdog cap): `fail()` routes it to `raceCandidateFailed`, which ejects only that train (`reason "failed in race: …"`, fork deleted, preview torn down). No rework and no supersede.
  - **The race is decided** when every candidate has reported, or at `deadline_at`.
    - With ≥1 pass: the winner = `rankCandidates()` → `phase PASSED`, `race_outcome WON`. Every other candidate is EJECTED with `reason "lost race to <id>: <why>"` and outcome LOST. Then `scheduleSuccessor(winner)` and `maybeLand()`.
    - With no pass: the normal `fail()` runs on the last candidate (attempts +1, REWORK with the *best* failure's Scribe summary). The race is `ABANDONED`.
  - `fail()` superseding a later race re-enqueues the prompt **once**, by deduping superseded trains by `promptId`. `includedPrompts` is deduped with a Set.
- **`rankCandidates`** (pure, deterministic, lexicographic):
  1. gate passed;
  2. reviewer `approved` > `skipped/off`;
  3. fewer `missing`, then more `satisfied`;
  4. builder `verified` (the Think `verify` tool passed);
  5. smaller `changedBytes`;
  6. fewer `credits`;
  7. lower `candidate` index.

  The reason is recorded on the race and the winner, e.g. `"won: reviewer approved (4/0), 3.1 KB vs 9.8 KB; DeepSeek V4 Pro"`.
- **Gate score.** The gatekeepers add `score: GateScore` to `TrainResult` (review state, satisfied/missing counts, changedFiles, changedBytes, checks). Drones add `verified` and `usage` to `BuildResult`. Both fields are optional, so a pre-v2 gate still decides on pass/fail and index.

### 2.4 Autonomy levels

| level | dispatch | release after staging PROMOTE |
|---|---|---|
| `autonomous` (default for new hives) | yes | auto-tap: `tappedBy = "queen:autonomous"`, straight to CANARY |
| `supervised` (today's behaviour) | yes | AWAITING_TAP + escalation `APPROVAL_REQUIRED` |
| `paused` (kill switch) | **no new items**; in-flight trains and releases finish | AWAITING_TAP (no new canaries start) |

- **Effective autonomy** comes from the pure function `effectiveAutonomy()` in `apps/queen/src/autonomy/policy.ts`: configured level → `supervised` if any of these holds:
  - **error budget exhausted:** the change-failure SLO, §2.7;
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
| `REWORK_EXHAUSTED` | item FAILED after `maxReworks` (races included) | stopped; Scribe summaries attached | `retry` (attempts reset, next race at frontier), `cancel` |
| `ROLLBACK_STREAK` | 2nd consecutive rollback | degraded to supervised; P0 bug filed per rollback | `resume_autonomy`, `ack` |
| `ROLLBACK_FAILED` | Herald rollback failed after its cap | prod may split traffic; supervised | `ack` (after a manual fix) |
| `ERROR_BUDGET_EXHAUSTED` | SLO budget < 0 | degraded to supervised | `resume_autonomy`, `ack` |
| `BUDGET_EXHAUSTED` | daily credits or dispatches hit | dispatch paused until the next UTC day | `raise_budget` (+50%), `ack` |
| `GUARDRAIL_TRIPPED` | children truncated, open-item cap hit by a user filing, depth exceeded on a user filing | dropped or truncated | `ack` |
| `EXECUTOR_LOST` | an Oracle, fork or deploy command exhausted its watchdog attempts | item FAILED or fallback | `retry`, `ack` |

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
  - train span: `spanIdFor(trainId)`, whose parent is the item span;
  - command span: `spanIdFor(commandId)`, whose parent is the train span (or the release span or item span). This covers fork, deploy, teardown, drone instance, Oracle and Sentinel commands.
  - gate span: `spanIdFor("gate:" + trainId + ":" + sha)`;
  - executor step spans: `spanIdFor(commandId + "/" + stepName)`.
- **Propagation.**
  - Every command and `DroneTask` carries an optional `trace: {traceparent}` in its Workflow params (`00-<traceId>-<spanId>-01`).
  - Gatekeepers are started by Artifacts, not the Queen, so they read `traceId` from the train in the snapshot (`MergeTrain.traceId`).
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

The doc facts below were checked on developers.cloudflare.com on 2026-10-05:
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
     - releases: `releases{outcome}`, `escalations{reason}`.
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
| `maxOpenItems` (non-terminal, hive) | 40 | 100 | auto-filed dropped; user 409 |
| `maxActiveTrains` (race candidates count) | 8 | 16 | dispatch waits; race width shrinks |
| `maxRaceWidth` | 3 | 5 | clamp |
| `maxAutoFiledPerHour` | 10 | 30 | dropped + one `GUARDRAIL_TRIPPED` per hour |
| `maxFollowUpsPerBuild` | 3 | 5 | truncated |
| `budget.dailyCredits` | 50,000 | n/a | `BUDGET_EXHAUSTED`, dispatch stops |
| `budget.dailyDispatches` (drone + Oracle instances) | 150 | n/a | same |

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

## 2.10 Contract sketches (`packages/queen-types`)

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
  attempts: z.number().int().min(0),
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
});
export const WorkActionSchema = z.object({ action: z.enum(["retry", "cancel", "not_duplicate"]), note: z.string().max(500).optional() });
export const GuardrailsSchema = z.object({
  maxChildrenPerItem: z.number().int().min(1).max(12), maxDepth: z.number().int().min(1).max(3),
  maxOpenItems: z.number().int().min(1).max(100), maxActiveTrains: z.number().int().min(1).max(16),
  maxRaceWidth: z.number().int().min(1).max(5), maxAutoFiledPerHour: z.number().int().min(0).max(30),
  maxFollowUpsPerBuild: z.number().int().min(0).max(5),
});
export const GUARDRAIL_DEFAULTS = { maxChildrenPerItem: 8, maxDepth: 2, maxOpenItems: 40, maxActiveTrains: 8, maxRaceWidth: 3, maxAutoFiledPerHour: 10, maxFollowUpsPerBuild: 3 } as const;
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
    openItems: z.array(z.object({ itemId: z.string(), title: z.string().max(120), status: WorkStatusSchema })).max(30),
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
});
```

`headline` rules (pure, `apps/queen/src/autonomy/policy.ts`):
- `NEEDS_YOU` if any escalation is OPEN;
- otherwise `BLOCKED` if paused, the budget is exhausted, or READY/BLOCKED items exist and nothing is ACTIVE;
- otherwise `SHIPPING` if any item is ACTIVE, LANDED or DECOMPOSING, or a release is in flight;
- otherwise `IDLE`.

```ts
// src/observability.ts (new)
export const EventTypeSchema = z.enum(["item.filed", "item.status", "item.decomposed", "item.duplicate", "train.enqueued", "train.phase",
  "race.started", "race.decided", "command.issued", "command.result", "drone.audit", "gate.verdict", "release.phase", "release.autoshipped",
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
export const SpanSchema = z.object({ spanId: SpanIdSchema, parentSpanId: SpanIdSchema.nullable(), name: z.string(), kind: z.enum(["item", "train", "command", "gate", "release"]),
  startTs: z.number().int(), endTs: z.number().int().nullable(), outcome: z.string().nullable() });
export const TraceViewSchema = z.object({ traceId: TraceIdSchema, spans: z.array(SpanSchema), events: z.array(QueenEventSchema), links: z.array(TraceIdSchema) });
export const HourlyMetricSchema = z.object({ bucket: z.number().int(), name: z.string(), labels: z.record(z.string(), z.string()), count: z.number(), sum: z.number(), min: z.number(), max: z.number() });
export const AE_DATASET = "queenos_events";
/** AE layout: indexes [hive]; blobs [type, hive, kindOrRole, model, outcome, environment, traceId, itemId]; doubles [valueMs, tokensIn, tokensOut, credits, count]. */
```

Edits to existing files:
- `train.ts`:
  - `SubmitPromptSchema` gains `decompose: z.boolean().default(false)`, `bestOf?`, `priority?`.
  - New `GateScoreSchema = {review: "approved"|"skipped"|"off", satisfied, missing, changedFiles, changedBytes, checks}` (ints ≥ 0).
  - `TrainResultSchema` gains `score?: GateScore` and `followUps?: FollowUp[] (max 3)`.
  - `BuildResultSchema` gains `verified?: boolean` and `followUps?: FollowUp[] (max 5)`.
- `state.ts`: `MergeTrainSchema` gains `traceId?`, `raceId?`, `candidate?`, `raceOutcome?: "RACING"|"PASSED"|"FAILED"|"WON"|"LOST"`, `score?: GateScore`.
- `drone.ts`: `DroneTaskSchema` gains `trace?: TraceContext`.
- `executors.ts`: every `ProvisionCommand` and `DeployCommand` variant gains `trace?`.
- `releases.ts`:
  - `SentinelCommandSchema` gains `trace?`.
  - `SentinelVerdictSchema` gains `inconclusive?: boolean`. The verdict stays `ROLLBACK` when inconclusive, so a v1 Queen treats it safely.
  - `ReleaseSchema` gains `traceId?`.
- `models.ts`: `ModelRoleSchema` adds `"planner"`. The catalog adds `planner` to GLM-5.3 Flash and DeepSeek V4 Flash.
- `telemetry.ts`:
  - The snapshot gains optional `items`, `escalations`, `races`, `hive: HiveStatus` and `recentEvents`.
  - New server messages: `item.updated {item}`, `race.updated {race}`, `escalation.updated {escalation}`, `hive.updated {hive}`, `event.appended {event}`.
  - `submit_prompt` carries the extended `SubmitPrompt`.

## 2.11 SQLite migrations (`apps/queen/src/db.ts`, appended)

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

`hiveNamespace()` reads `hive_settings.hive`, falling back to `prompt_runs`. A goal can exist before any prompt run, so the first filing upserts the settings row.

---

## 3. Flows

### 3.1 The QueenNode decision pipeline (one synchronous plan, one transaction)

Today `trainTransition` composes `TrainPlanner` and then `ReleasePlanner`. v2 generalises this into `decide()` in `queen-node.ts`:

```
decide(input):                        // all synchronous: no await until apply()
  ctx   = load settings, effectiveAutonomy (policy.ts), budget, guardrails
  tp    = new TrainPlanner(loadState(...), {..., race: {slotsFree, reworkWidth}, credits})
  rp    = new ReleasePlanner(loadReleaseState(...), {..., autoShip: ctx.effective === 'autonomous'})
  wp    = new WorkPlanner(loadWorkState(), ctx)
  r1    = input(tp, rp, wp)                       // the triggering transition
  r2    = wp.absorb(r1)                           // prompt status → item status; MERGED trains → rp.landed;
                                                  // release SHIPPED → items SHIPPED; rollbacks → P0 bug + streak;
                                                  // followUps → TRIAGE items; escalations open/resolve
  subs  = wp.dispatchReady(capacity(tp), budget)  // READY items → [{itemId, promptText, width}]
  r3    = subs.map(s => tp.submit(s))             // same TrainPlanner instance
  apply(merged(r1, r2, r3))                        // rows + events + metrics rollups, one transactionSync;
                                                  // then broadcasts, then executor dispatches, then AE writes
```

Every RPC (`report*`, `submitPrompt`, `fileWorkItem`, `resolveEscalation`, `updateSettings`, `alarm`) goes through `decide()`. The alarm runs `tp.reconcile()`, `rp.reconcile()` and `wp.reconcile()`. `wp.reconcile()` is the Oracle watchdog plus the race deadlines plus `pruneEvents`.

### 3.2 Main flow: prompt → shipped (autonomous hive)

```
user ──submit_prompt{decompose}──▶ Queen: goal G (DECOMPOSING), trace T, event item.filed
Queen ──OracleCommand DECOMPOSE (trace 00-T-span(G-decompose-1))──▶ Oracle Workflow
Oracle: LLM (planner model) → children c1..c3 → embed+query+upsert → reportOracleResult
Queen: G-c1 READY, G-c2 READY (hard), G-c3 BLOCKED(dep c1); G ACTIVE; events item.decomposed/filed
Queen dispatch: G-c1 → submit(width 1); G-c2 → submit(width 3: race R)
  TrainPlanner: train A (c1) forks from main; race trains B0,B1,B2 wait for A to push, then all fork from A
  Provisioner FORK ×4 (recall memories) → drones BUILD ×4 (B0..B2 on 3 distinct models) → Herald previews
  Gatekeepers per push: policy/security/smoke/reviewer → reportTrainResult{passed, score}
  A PASSED → head of queue → LANDER → MERGED → rp.landed → release R1 STAGING
  B1, B2 pass, B0 fails → B0 ejected; deadline or all reported → rankCandidates → B2 WON, B1 LOST
  B2 head-of-queue after A → LAND → MERGED → G-c2 LANDED; c3 deps met → READY → dispatched
Release: STAGING → Sentinel VALIDATING → PROMOTE → autoShip → CANARY 1/10/50/100 (Sentinel each) → SHIPPED
Queen: items in R's trains → SHIPPED; when all children SHIPPED → G SHIPPED; metrics/lead time recorded
```

Supersede still works as in v1. When R1 is in STAGING or VALIDATING and B2 lands, R1 becomes SUPERSEDED and R2 carries both trains. During CANARY, R2 is queued with `nextHeadSha`.

### 3.3 The Oracle executor (new Workflow `queenos-oracle`)

**Why a new Workflow and not an extension of the Provisioner or Genesis:**
- The Provisioner is the Artifacts executor. Its retries, timeouts and failure semantics are about repos. Decomposition is an LLM call with a different latency and failure profile, and coupling them would make FORK retries replay LLM work.
- Genesis is a chat DO for onboarding, not a command executor.
- The drones are keyed per train (`<trainId>-<action>`), while decomposition happens before any train exists.
- The Oracle needs just `AI`, `MEMORY` (queenos-memory), `QUEEN` (DO RPC back), `ANALYTICS` and the shared hive-kit clients, so it is ~300 lines.
- It is one more deploy, accepted (decision D5).

**Steps of `runOracle(cmd)`** (pattern of `apps/provisioner/src/orchestrate.ts`, StepRunner + ports seam). Every step is idempotent by `commandId`:
- **DECOMPOSE:**
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
| **Drone notices an out-of-scope problem** | The Think `finish` tool gets `followUps: [{kind, title, body, paths}]` (≤3; the prompt says "only problems outside your task; never your own unfinished work"). `runBuild` passes them in `BuildResult.followUps`. | `wp.followUps(item, train)`: guardrails (depth, hourly, open cap) → exact dedupe → TRIAGE (Oracle) → READY or DUPLICATE |
| **Gate finds problems outside the diff** | `inspect.ts` already has the findings with paths and `changedPaths`. Findings in unchanged paths don't fail the gate (they are pre-existing); they are sent as `TrainResult.followUps` (bug, P1 for security, P2 for policy). | same as the drone row |
| **Gate failure on the item's own diff** | unchanged: Scribe summary → `fail()` → REWORK (a race of `reworkWidth` at frontier) | after `maxReworks`: FAILED + `REWORK_EXHAUSTED` |
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
| `getGateTarget(repo)` | RPC only | `{trainId, promptId, promptText, previewUrl, phase, traceId}`. Replaces the gatekeepers' snapshot scan (`lookupTrain`). The gatekeepers fall back to the scan if the RPC is missing, so deploy order doesn't matter |

The "open" GET routes match today's openness (`/snapshot`, `/room`). In production the edge's Access check covers everything.

---

## 4. Dashboard v2

**Routes** (`apps/dashboard/src/route.ts`):
- `/p/:hive` → **Status home** (new; the War Room moves);
- `/p/:hive/lanes` → today's War Room (lanes, release timeline, Sites, Model Board, ticker);
- `/p/:hive/items/:id`;
- `/p/:hive/traces/:traceId`;
- `/p/:hive/events`;
- `/p/:hive/metrics`.

`/?hive=x` maps to the home page. The home page runs off the WebSocket snapshot plus deltas, and the drill-downs fetch the REST endpoints.

### 4.1 Status home (status first)

```
┌─ QueenOS ▸ demo ───────────────────────────────── ● linked 42ms ─ [autonomous ▾] ─┐
│  ██ SHIPPING  · 3 in flight · 1 needs you · shipped 7 today                         │
│  error budget ▓▓▓▓▓▓░░ 1 of 2 left (18/20 releases ok)   credits ▓▓▓░░░ 31k/50k      │
├─ NEEDS YOU (1) ───────────────────────────────────────────────────────────────────┤
│ ⚠ SENTINEL_INCONCLUSIVE · release 9f1c · staging never became ready in 90s         │
│   The Queen parked it at staging. [Ship anyway] [Hold]  runbook ▸   trace ▸          │
├─ IN FLIGHT ──────────────────────────────────────────────────────────────────────┤
│ Triage 0 │ Ready 2 │ Building 1 │ Gating 2 │ Landed 1 │ Releasing 1 │ Shipped 7      │
│ ─────────────────────────────────────────────────────────────────────────────── │
│ ◆ goal  "Dark mode, a /health page, fix the footer"           3 items · 1 shipped  │
│   ├ feature  Dark mode toggle            GATING  best-of-3 ▸ 2 passed, deciding 41s │
│   ├ feature  /health JSON endpoint       SHIPPED  8m lead time                     │
│   └ bug      Footer year is hardcoded    BLOCKED  needs: Dark mode toggle           │
│ ◆ bug P0 "Release 77a0 rolled back: 5% 5xx at 10%"  (filed by Sentinel) BUILDING    │
├─ THROUGHPUT (24h) ─────────────────────┬─ BLOCKED / FAILED ────────────────────────┤
│ shipped 7  landed 9  lead p50 11m      │ bug "Flaky smoke on /api" FAILED · retry ▸ │
│ first-try pass 62%  reworks 4  races 2 │                                            │
├─ COMPOSER ────────────────────────────────────────────────────────────────────────┤
│ [ Describe the goals…                                          ] [x] split into items│
│                                                     best-of [auto ▾]  [Send to Queen]│
└───────────────────────────────────────────────────────────────────────────────────┘
 footer: lanes ▸  events ▸  metrics ▸  models ▸
```

- **Headline colours:** SHIPPING green, BLOCKED amber, NEEDS YOU red, IDLE grey. When the Queen degraded the hive, the autonomy dropdown shows `autonomous → supervised (error budget)`.
- **Item rows** link to the item page. The race chip opens the race panel.

### 4.2 Work item page

```
┌ ◂ demo / feature #G-c1  "Dark mode toggle"  P2 · ACTIVE (gating) · trace 4e1f… ▸ ┐
│ source: oracle (goal "Dark mode, …")   parent ▸   depends on: –   blocks: G-c3     │
│ Acceptance: ☐ toggle in header  ☐ persists in localStorage  ☐ respects prefers-…   │
├ ATTEMPTS ──────────────────────────────────────────────────────────────────────── │
│ #1 BUILD  race best-of-3 (hard)                       deciding · deadline 0:41      │
│   B0  Kimi K2.7 Code     ✗ gate: security finding in src/theme.js       ejected     │
│   B1  DeepSeek V4 Flash  ✓ reviewer approved 3/0 · 9.8 KB · verified     PASSED     │
│   B2  DeepSeek V4 Pro    ✓ reviewer approved 3/0 · 3.1 KB · verified     PASSED  ★  │
│   ★ "won: reviewer approved (3/0), 3.1 KB vs 9.8 KB"                               │
├ RELEASE ─ (none yet) ──────────────────────────────────────────────────────────── │
├ EVENTS (item) ─ 12:01:03 item.filed · 12:01:09 race.started w=3 · … [all events ▸] │
└───────────────────────────────────────────────────────────────────────────────────┘
```

Actions on the page: retry, cancel, not-duplicate (only where valid). The page also shows the Scribe summary of each failed attempt and the recalled-memories chip (reused from `MemoryRecall`).

### 4.3 Trace view

```
trace 4e1f9a… "Dark mode, a /health page, fix the footer"   links: release 9f1c ▸
0s        30s        60s        90s        120s       150s
├ goal G ───────────────────────────────────────────────────────────────────┤
│├ oracle G-decompose-1 ██ 6s ok (3 children)
│├ item G-c1 ─────────────────────────────────────────────────────────┤
││├ train B0 ── fork █ build ██████████ deploy ██ gate ████ ✗
││├ train B1 ── fork █ build ███████████████ deploy ██ gate █████ ✓
││└ train B2 ── fork █ build ████████████ deploy █ gate ████ ✓ ★ land ██ merged
│└ item G-c2 …
click a span → side panel: command id, executor, attempt, outcome, summary, ledger (git notes), "Workers Logs: filter trace_id = 4e1f…"
```

### 4.4 Event log and metrics

- **Event log:** a virtualized table (time, type, severity, actor, item, train, release, summary) with filter chips (type prefix, severity, actor) and a search box for item, train or trace. It live-tails `event.appended` and pages back with `before=seq`.
- **Metrics:** tiles plus small multiples:
  - throughput per hour (filed / landed / shipped);
  - lead time p50/p90;
  - gate first-try pass rate;
  - rework and race counts;
  - race wins by model;
  - change-success SLO burn-down;
  - credits per day against the budget;
  - Sentinel error rate and p99 per release.

  Range 24h or 7d. Data comes from AE via the edge in live mode and from Queen rollups otherwise; the source is labelled.

**The lanes page (existing War Room)** gets two additions:
- race candidates render as stacked cars in one lane with a "best of N" badge and a star on the winner;
- the ledger panel links to the trace view.

---

## 5. Sim mode (`apps/queen/src/sim/sim-ports.ts`)

`SimExecutors` gains an `oracle` port. All fakes run off DO alarms as today, and the job id is the command id.

| fake | behaviour |
|---|---|
| **oracle DECOMPOSE** | Splits the prompt on lines starting `-`, `*`, `•` or `\d+.`, or on `;`. With one part, it returns one child. Kind: `bug` if the part matches `/\b(fix\|bug\|broken)\b/i`, `chore` if it matches `/\b(chore\|rename\|bump\|refactor\|cleanup)\b/i`, else `feature`. `[hard]` sets difficulty hard. `(after N)` or `depends on #N` sets `dependsOn: ["cN"]`. Acceptance: one line, `"<title> is visible at /"`. Dedupe: Jaccard word overlap ≥ 0.8 against open item titles from the snapshot gives `similar: [{itemId, score: 0.95}]`. `[decompose-fail]` gives `ok: false` (fallback demo). Delay 800 ms. Usage: 1.2k tokens. |
| **oracle TRIAGE** | The same Jaccard against open items gives `similar`. Delay 300 ms. |
| **drones (BUILD/REWORK)** | As today, plus synthetic `usage` (tier-scaled) and `verified: true` (false for the race candidate 0 build when the prompt has `[fail]`). `[spot-bug]` reports one follow-up: bug "Spotted: README badge link 404s" (first BUILD only). |
| **gate** (sim "test" job) | As today, plus `score`: approved; `changedBytes` from a deterministic hash of `trainId` (2–12 KB); `satisfied` 3; `missing` 0. In a race, `[fail]` fails candidate 0 only, and `[review-fail]` makes the reviewer reject candidate 0. Candidates 1+ pass, so the winner is the smallest `changedBytes`. `[gate-spot]` sends one out-of-diff security follow-up. |
| **herald / provisioner** | Unchanged. They log trace ids. |
| **sentinel** | As today (`[canary-fail]` rolls back at 10%), plus `[inconclusive]`: staging gets `inconclusive: true` and ROLLBACK. |
| **analytics** | `NoopMetricsSink` (no AE binding in sim). Rollups in SQLite power the Metrics page. |

**Sim race trigger:** `[race]` in a prompt or item title sets `bestOf: 3` when filed. `[hard]` from DECOMPOSE gets width 3 through the policy.

**Demo prompt** (added to `DEMO_PROMPTS`, decompose on):
```
- Add a dark theme toggle [hard]
- Add a /health JSON endpoint
- Fix the hardcoded footer year (after 1)
```

---

## 6. Risks and open questions (each with a recommendation)

| # | risk / question | recommendation |
|---|---|---|
| R1 | **Builds stay chained**, so a fan-out of k items builds in k sequential steps (40–220 s each live). | Accept for Oct 14. Parallelism comes from races, previews, gates and reviews. Show the pipeline honestly in the video. After Oct 14: a STACK drone that cherry-picks a candidate built from main onto the chain (no LLM), plus a rework on conflict. |
| R2 | Races cost N forks, previews, gates and LLM tokens. | Race only hard items and reworks, cap at 3, gate on budget, use a 90 s grace after the first pass, and eject losers immediately. |
| R3 | **The old AWAITING_TAP release on `demo` auto-ships** after the upgrade. | Migration v10 sets existing hives to `supervised` (D2). The user flips `demo` to autonomous after checking the War Room. |
| R4 | Runaway self-amplification (bugs filing bugs). | Depth cap, hourly auto-file cap, open-item cap, exact and vector dedupe, budget, a rollback streak that degrades to supervised, rework exhaustion that escalates instead of filing, and the `paused` level. All of it is visible as events. |
| R5 | Decomposition quality on Workers AI models (JSON drift, over-splitting). | A strict JSON schema, `maxChildren`, temperature 0, fallbacks from the router role `planner`, a single-item fallback, and a system prompt that says "prefer fewer, independent items; 1 is fine". |
| R6 | Dedupe false positives swallow a distinct bug. | Only auto-filed items are deduped, the threshold is 0.90 (0.92 for children), and DUPLICATE is reversible with `not_duplicate`. |
| R7 | Vectorize is eventually consistent (~1 min). | Exact `(source, ref, normalized title)` dedupe in the Queen first. Accept rare duplicates. |
| R8 | Does the Queen writing AE break "orchestrator only"? | D1: allow it as a non-blocking telemetry sink that is never read for decisions. Decisions use SQLite rollups. |
| R9 | Event log growth in DO SQLite. | Summaries ≤500, data ≤4 KB, prune to 30 days or 100k rows in the alarm. |
| R10 | Platform tracing is beta and has its own trace ids. | Our trace lives in `event_log` + Workers Logs fields. Enable `observability.traces` but don't depend on it. |
| R11 | Gatekeeper lookup by snapshot scan (200 newest trains) gets crowded by races. | Add the `getGateTarget(repo)` RPC, with the snapshot scan as a fallback. |
| R12 | Race and rework edge cases in `fail()` (supersede re-enqueues the race once, deadline vs. watchdog). | Opus owns `planner.ts`, with table-driven tests (§7, WP1.2): all-fail, first-pass-then-deadline, a loser's late result (`ignored:stale`), and a supersede during a race. |
| R13 | The dashboard working tree has **unresolved merge conflicts** (`components.tsx`, `styles.css` are `UU`; `reducer.ts`, `reducer.test.ts` and `scripts/deploy.sh` are modified). | Resolve and commit before Phase 1. WP1.10 and WP2.2 own those files after that. |
| R14 | A Sentinel `INCONCLUSIVE` verdict reaching an old Queen. | Encoded as `inconclusive: true` with verdict ROLLBACK (backward-safe). Deploy the Queen first anyway. |
| R15 | Default `SubmitPrompt.decompose=false` for the API vs. true in the composer. | Keep it: v1 tests and the curl quickstart keep working, and the dashboard composer's "split into items" box is checked by default. |
| R16 | Budget credits are an approximation (Workers AI pricing differs per model). | Label them "credits (weighted tokens)". They are a guardrail, not billing. |
| Q1 | Should deps allow speculative dispatch behind an ACTIVE dependency? | No for v2 (see §2.3). |
| Q2 | Should `paused` stop in-flight canaries? | No. It stops new dispatch and new canaries (AWAITING_TAP). In-flight canaries finish, and rollback stays automatic. |

---

## 7. Implementation plan (parallel subagents)

The rules from `docs/HANDOFF.md` apply:
- the coordinator never edits;
- the contracts come first;
- file ownership is disjoint within a phase;
- one lockfile writer (the coordinator runs `pnpm install` after Phase 0 scaffolds `apps/oracle/package.json`);
- verify with `pnpm turbo run build typecheck lint test --force --continue` under Node 24;
- commit and push after each phase.

**Every phase leaves `main` deployable and green**, because new fields are optional and new modules are inert until Phase 2 wires them.

### Phase 0: contracts and migrations (Oct 6, morning, ~0.5 day). One agent, before any fan-out.

**WP0 (Opus)**
- **Owns:**
  - `packages/queen-types/src/{trace,work,oracle,autonomy,observability}.ts` (new);
  - `packages/queen-types/src/{state,train,drone,executors,releases,models,telemetry,index,index.test}.ts`;
  - `apps/queen/src/db.ts` (migrations v8–v10; row mappers and upserts for `work_items`, `races`, `hive_settings`, `escalations`, `event_log`, `metrics_hourly`; `rowToTrain`/`upsertTrain` gain the v9 columns; `rowToAudit` reads `event_log`);
  - `apps/queen/test/migrations.test.ts` (new);
  - scaffold `apps/oracle/{package.json,tsconfig.json,wrangler.jsonc,eslint.config.js,src/index.ts}` (a stub Workflow that throws "not implemented").
- **Also:** `RUNBOOK`, `GUARDRAIL_DEFAULTS`, `spanIdFor` (FNV-1a 64) with test vectors, and `traceIdFromUuid`.
- **Acceptance:**
  - all 40 turbo tasks green;
  - a fresh DO migrates to v10;
  - a v7 fixture with 3 prompts, audit rows and a release migrates: 3 `work_items` rows, `event_log` has the audit rows, `hive_settings.autonomy = 'supervised'`, and the snapshot is unchanged for v1 consumers;
  - `index.test.ts` round-trips every new schema, and old payloads (no new fields) still parse.

### Phase 1: pure logic, executors, sim, dashboard data (Oct 6 PM – Oct 8, 2.5 days). Ten agents in parallel.

| WP | model | owns (exclusive) | depends | acceptance |
|---|---|---|---|---|
| **1.1 Work ledger** | Opus | `apps/queen/src/work/{ledger.ts,guardrails.ts,compose.ts}`, `apps/queen/test/work-ledger.test.ts` | P0 | pure `WorkPlanner`: `fileGoal`, `fileItem`, `oracleResult` (dedupe, cycles, truncation, fallback), `absorb` (prompt → item status, release → SHIPPED, rollback bug + streak, followUps), `dispatchReady` (priority, deps, caps, budget, paused), `retry`/`cancel`/`notDuplicate`, `reconcile` (Oracle watchdog → fallback or `EXECUTOR_LOST`). Table tests for every state-machine edge and every guardrail. |
| **1.2 Races** | Opus | `apps/queen/src/train/{planner.ts,race.ts}`, `apps/queen/src/models/router.ts`, `apps/queen/test/{planner.test.ts,router.test.ts,race.test.ts}` | P0 | `raceWidth`, `routeRace` (distinct models, sibling-free fallbacks), `rankCandidates`; planner race semantics (§2.3.1); trace stamping of `DroneTask.trace` and command `trace`; `EventDraft`s from `setTrain`. Every existing planner test passes unchanged at width 1. New: all-fail → REWORK with attempts +1; pass + deadline; a late loser result is `ignored:stale`; supersede during a race re-enqueues once; the successor waits for the winner; the floor doesn't move. |
| **1.3 Autonomy and release** | Opus | `apps/queen/src/release/planner.ts`, `apps/queen/src/autonomy/{policy.ts,escalations.ts,slo.ts,budget.ts}`, `apps/queen/test/{release-planner.test.ts,autonomy.test.ts}` | P0 | `effectiveAutonomy`, `headline`, the SLO and error budget, budget accounting and the day rollover, escalation open/resolve/auto-resolve, `autoShip` in `sentinelVerdict` and `reconcile`, `inconclusive` handling, release `traceId` and events. Existing release tests pass with `autoShip=false`. |
| **1.4 Observability core** | Sonnet | `apps/queen/src/obs/{events.ts,rollup.ts,metrics-sink.ts,trace-view.ts,log.ts}`, `apps/queen/test/obs.test.ts`, `packages/hive-kit/src/{log.ts,metrics.ts,index.ts}` + tests | P0 | `EventDraft` → row; rollup upsert SQL; `buildTraceView(events)` (span tree from issued/result pairs); `pruneEvents`; `AnalyticsSink` (AE `writeDataPoint` wrapper, no-op without a binding); hive-kit `structuredLog({trace…})` and `metricPoint()` for executors. |
| **1.5 Oracle** | Sonnet | `apps/oracle/**`, `packages/hive-kit/src/{memory.ts,memory.test.ts}` | P0 (+ install) | `runOracle` for DECOMPOSE/TRIAGE with a StepRunner and ports seam (fakes in tests); JSON-schema prompt; fallbacks; reports through `QUEEN` RPC; `HiveMemory.findSimilarItems` and `indexItems`; `recall` drops `kind=work-item`. wrangler: AI, MEMORY, QUEEN, ANALYTICS, `observability.enabled`. |
| **1.6 Drones** | Sonnet | `apps/drones/**` | P0 | `finish` accepts `followUps` (≤3, prompt rule); `BuildResult` gets `verified`, `followUps`, `usage`; structured logs with the trace from `DroneTask.trace`; AE build point; observability config. |
| **1.7 Gatekeepers and Sentinel** | Sonnet | `apps/gatekeepers/**`, `apps/sentinel/**` | P0 | `TrainResult.score` (review state, counts, changedFiles/Bytes, checks); out-of-diff findings → `followUps` without failing; `getGateTarget` with snapshot fallback; trace from the target; Sentinel `inconclusive` (readiness timeout on staging; < ½ minRequests), the AE window point, trace logs. |
| **1.8 Herald, Provisioner, config** | Haiku | `apps/herald/**`, `apps/provisioner/**`, `apps/{edge,genesis,vault}/wrangler.jsonc` | P0 | log trace fields from `cmd.trace`; `"observability": {"enabled": true, "head_sampling_rate": 1}` on every Worker (traces disabled by default; a commented line to opt in). |
| **1.9 Sim fakes** | Sonnet | `apps/queen/src/sim/sim-ports.ts`, `apps/queen/test/sim-ports.test.ts` | P0 | everything in §5 (Oracle fake exposed as `sim.oracle`; `SimQueen` gains `reportOracleResult`). Unit tests per marker. |
| **1.10 Dashboard data layer** | Sonnet | `apps/dashboard/src/{reducer.ts,api.ts,mock.ts,mockQueen.ts,useMockQueen.ts,route.ts,status.ts}`, `apps/dashboard/test/**` | P0, R13 resolved | reducer handles the new messages and snapshot fields; selectors (headline, pipeline counts, goal trees, race view); routes from §4; REST client for items, events, traces, metrics; the mock queen emits v2 frames (goal fan-out, a race, an escalation). |

### Phase 2: integration and UI (Oct 9 – Oct 10, 2 days). Four agents in parallel.

| WP | model | owns | depends | acceptance |
|---|---|---|---|---|
| **2.1 QueenNode integration** | Opus | `apps/queen/src/{queen-node.ts,index.ts,auth.ts,executors.ts,drones.ts}`, `apps/queen/src/sim/worker.ts`, `apps/queen/wrangler.jsonc` (ORACLE workflow binding, `analytics_engine_datasets` `ANALYTICS`→`queenos_events`, observability), `apps/queen/worker-configuration.d.ts`, `apps/queen/test/{queen.test.ts,v2-flow.test.ts,fakes.ts,worker.ts}`, `apps/queen/README.md`, `scripts/deploy.sh` (add `oracle`) | 1.1–1.4, 1.9 | `decide()` pipeline (§3.1); all routes and RPCs in §3.6; snapshot and broadcasts; events in the same transaction; AE after commit; alarm = reconcile ×3 + prune. **e2e under vitest-pool-workers with sim ports:** (a) a 3-bullet prompt → goal + 3 children, c3 waits for c1, all SHIPPED automatically, one trace id across every event; (b) `[race]` → 3 candidates, the winner lands, losers EJECTED; (c) `[canary-fail]` → ROLLED_BACK + P0 bug filed and dispatched; a second rollback → supervised + `ROLLBACK_STREAK`; (d) a supervised hive → `APPROVAL_REQUIRED`, resolve `ship` → canary; (e) budget exhausted → no dispatch + escalation. `pnpm dev:sim` curl quickstart unchanged. |
| **2.2 Status home and item page** | Sonnet | `apps/dashboard/src/{StatusHome.tsx,ItemView.tsx,WarRoom.tsx,router.tsx,shell.tsx,components.tsx,styles.css,Home.tsx,demo.ts}` | 1.10 | §4.1, §4.2, and the lanes additions; escalation actions call the API; the composer's "split into items" and best-of; works with `VITE_MOCK_API=1` and against `dev:sim`; usable at 390 px. |
| **2.3 Trace, events, metrics UI** | Sonnet | `apps/dashboard/src/{TraceView.tsx,EventLog.tsx,Metrics.tsx,obs.css}` + their tests | 1.10 | §4.3 and §4.4; routes are registered by 2.2 (agreed export names `TraceView`, `EventLog`, `Metrics`); charts follow the dataviz skill; the AE source with rollup fallback. |
| **2.4 Edge** | Sonnet | `apps/edge/src/**`, `apps/edge/test/**` | P0 | `GET /api/metrics/:hive?q=` with allowlisted AE SQL (secret `ANALYTICS_API_TOKEN`, account id var), 503 → the dashboard falls back; user routes (`PATCH settings`, resolve, items) keep `x-queen-user`; tests for the allowlist (no raw SQL from the client). |

### Phase 3: live, docs, hardening (Oct 11, 1 day)

| WP | model | owns | acceptance |
|---|---|---|---|
| **3.1 Live rollout** | coordinator + user | scratchpad deploy script | one-time: the Vectorize `kind` metadata index; `wrangler secret put ANALYTICS_API_TOKEN` (edge); deploy oracle alone (`--env=""`), then `./scripts/deploy.sh` (queen first). On `demo`: check the old release, flip it to autonomous, run the 3-bullet prompt live, and watch SHIPPED with no tap. The AE dataset appears after the first write; query it once via the SQL API. |
| **3.2 Docs** | Sonnet | `README.md`, `docs/HANDOFF.md`, `docs/demo-script.md` | the new pitch (an autonomous swarm with a ledger, best-of-N, self-filed bugs, an SLO-gated autonomy, trace drill-down); the sim quickstart with the new markers. |
| **3.3 Fix pool** | Sonnet ×2 | assigned per bug | green turbo run, then a live re-run. |

### Schedule

| date | phase |
|---|---|
| Oct 6 | Phase 0 (AM) → Phase 1 kickoff (PM) |
| Oct 7–8 | Phase 1 |
| Oct 9–10 | Phase 2 |
| Oct 11 | Phase 3 (live + docs) |
| Oct 12–13 | rehearsal + recording (unchanged from the roadmap); buffer for fixes |
| Oct 14 | submit |

**Cut lines if late, in order:**
1. AE edge proxy (WP2.4 metrics; keep the rollups);
2. the Metrics page charts (keep the tiles on home);
3. gatekeeper out-of-diff follow-ups;
4. TRIAGE vector dedupe (keep exact dedupe).

The ledger, fan-out, races, autonomy, escalations and the trace view are the video's spine and are not cut.

---

## 8. Deliberately NOT building (v2)

- Merging candidates, or landing more than one race winner.
- Parallel independent builds or a STACK/cherry-pick drone (R1). Speculative dispatch behind unlanded dependencies.
- Cancelling or pre-empting ACTIVE items, and re-prioritising in-flight trains.
- Bisect + auto-revert on staging failure. `stagingFailed()` files a P0 bug instead.
- Re-decomposing goals, LLM-judged dedupe, or learned thresholds.
- RBAC or per-user permissions beyond "Access-verified human".
- OTLP export, custom platform spans, Tail Workers in user accounts, Logpush.
- Cross-hive dashboards or org-level SLOs.
- Billing-accurate cost accounting (credits are weighted tokens).
- Editing items from the dashboard beyond retry, cancel, not-duplicate and settings.

---

## 9. Decisions for the user

- **D1:** Let the Queen write Workers Analytics Engine points directly, as a fire-and-forget telemetry sink that never feeds decisions. *Recommend yes.* The alternative is executor-only AE writes, which loses item and release lifecycle metrics in AE.
- **D2:** Existing hives (`demo`) migrate as `supervised`; new hives default to `autonomous`. *Recommend yes* (R3).
- **D3:** A gate failure on an item's own diff stays a same-item REWORK, not a new bug item. New bugs come only from drone follow-ups, out-of-diff gate findings, and Sentinel rollbacks and staging failures. Rework exhaustion escalates instead of filing. *Recommend yes* (it prevents loops).
- **D4:** Builds stay chained for Oct 14. Fan-out parallelism is pipelined builds plus parallel gates and races. *Recommend yes*; a STACK drone comes after the deadline.
- **D5:** Decomposition and dedupe go in a new `queenos-oracle` Workflow (one more Worker to deploy) instead of folding into the Provisioner. *Recommend yes.*

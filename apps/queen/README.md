# @queenos/queen

Hono Worker plus the `QueenNode` Durable Object: the hive's single source of truth. It runs the work ledger, parallel builds, the merge queue, races, releases, autonomy and escalations. State lives in SQLite; the War Room gets coalesced WebSocket broadcasts. The same Worker hosts the `SwarmGovernor` DO (one instance, `global`).

## v2 decision pipeline (`src/queen-node.ts`, design §3.1)

Every RPC (`report*`, `git*`, `submitWork`, `fileWorkItem`, `workAction`, `resolveEscalation`, `updateSettings`, `alarm`) runs one `decide()`:

1. **Before (async, only when due):** the `SwarmGovernor` lease (D9). `want` is the hive's `maxActiveTrains` while it has work, 0 when idle; the lease lasts 120 s and is renewed when it expires within 30 s. An expired or failed lease means "no global cap" (fail open). `SWARM_LEASE=off` turns it off (cut line 3).
2. **Plan (synchronous, no await):** settings + effective autonomy (`autonomy/policy.ts`) + budget + guardrails + lease → the warm `StateCache` (loaded from SQLite only on a cold start) → `TrainPlanner`, `ReleasePlanner`, `WorkPlanner`, `EscalationPlanner` → the triggering transition → a landed car hands all its members to `rp.landed` → `wp.absorb` (prompt → item status, path claims, releases → SHIPPED or a P0 bug, follow-ups, credits) → `ep.resolveStale` → `wp.dispatchReady` → `tp.submit` per READY item (BUILD trains, every fork from main) → `autonomyTransition` (`degraded_by`, ERROR_BUDGET_EXHAUSTED).
3. **Commit:** rows, `event_log` rows (planner drafts plus the Queen's `command.issued` / `command.result` / `gate.verdict` / `sentinel.verdict` / `hive.settings`) and `metrics_hourly` rollups in **one** `transactionSync`. Then the cache update, the coalesced broadcast (one `batch` frame per ≥ 100 ms, last update per entity wins), Analytics Engine points (`ANALYTICS` → `queenos_events`, never awaited, ≤ 200 per invocation), and executor dispatch grouped per Workflow with `createBatch` (≤ 100 per call; drone dispatches confirmed in one bookkeeping decision).

The merge queue is always on (`ctx.queue` from the hive's `maxQueueBatch` / `maxQueueDepth`): a passed build boards a car, the MERGE drone 3-way merges it, and the LANDER fast-forwards main. The **alarm** runs the three reconciles (watchdogs, race deadlines, the queue, the Oracle watchdog, stale claims), prunes the event log (30 days / 100k rows) and renews the lease.

**Snapshot and broadcasts** use `toMergeTrainV2` (trace, race, lane, members, carId, passedSeq, ...) and carry `items`, `escalations`, `races`, `hive` (HiveStatus) and `recentEvents`; new messages are `item.updated`, `race.updated`, `escalation.updated`, `hive.updated`, `event.appended` and `batch`.

**New hives** start `autonomous` (existing hives migrated `supervised`, D2). `HIVE_DEFAULT_GUARDRAILS` (JSON) seeds a new hive's guardrails; the sim sets `maxActiveTrains` 64 and `maxChildrenPerItem` 24.

## Hives and routing

There is **one `QueenNode` per hive**, addressed by `idFromName(namespace)`. A hive is one base repo in Artifacts (named `<namespace>`) and one merge queue. Its train forks are named `<namespace>-train-<12 hex>`. Namespaces must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`.

- **Canonical:** `/hives/:namespace/<route>`.
- **Root alias:** `/<route>` resolves the hive from the `x-queen-hive` header or `?namespace=`.
  - `POST /prompts` falls back to the body's `namespace`.
  - Every other route falls back to the `queen` hive.

| Method | Route | RPC on the stub | Body / result |
|---|---|---|---|
| POST | `/prompts` | `submitWork(SubmitPrompt)` (`submitPrompt` returns just the `promptRun`) | 201 `{item, promptRun}`. Open. `decompose: true` files a goal for the Oracle; otherwise one `feature` item (v1 semantics). `promptRun` is synthesized from the item (QUEUED until dispatched) |
| POST | `/items` | `fileWorkItem({hive, user, item})` | **User route.** 201 `{item}` (`FileWorkItem`); 400/404/409 on a bad dependency, parent or guardrail |
| POST | `/items/:id/actions` | `workAction({hive, itemId, user, action})` | **User route.** `{outcome, item}` for `retry` / `cancel` / `not_duplicate` / `handoff` (a FAILED pushed item → seeded REWORK); 409 when the item cannot take it |
| GET | `/items/:id` | `getItemDetail(itemId)` | `ItemDetail`: item, children, trains (and their cars), races, release, escalations |
| GET | `/events?trace=&item=&release=&type=&before=&limit=` | `queryEvents(EventQuery)` | `{events}` newest first (`type` is a prefix, e.g. `queue`) |
| GET | `/traces/:traceId` | `getTrace(traceId)` | `TraceView`: the trace's events plus the span tree |
| GET | `/metrics?window=24h\|7d` | `getMetrics(window)` | `MetricsView`: hourly rollups + `HiveStatus`, `source: "queen-rollups"` |
| GET | `/queue` | `getQueue()` | `QueueView`: active cars, passed builds waiting to board, last 20 conflicts and bisects |
| PATCH | `/settings` | `updateSettings({hive, user, patch})` | **User route.** `UpdateHiveSettings`; returns `HiveStatus`; event `hive.settings` |
| POST | `/escalations/:id/resolve` | `resolveEscalation({hive, escalationId, user, action})` | **User route.** `ResolveEscalation`; ship → tap, retry/cancel → the item, resume_autonomy → streak reset, raise_budget → today's limits ×1.5, retry on EXECUTOR_LOST → queue resumes. 409 when not allowed, 404 unknown |
| POST | `/internal/webhook/oracle-result` | `reportOracleResult(OracleResult)` | `{outcome}`; idempotent by `commandId`; 404 for an unknown item |
| POST | `/internal/webhook/merge-result` | `reportMergeResult(MergeResult)` | `{outcome, train}`; the MERGE drone's report for a car |
| — | — | `getGateTarget(repo)` | RPC only: `GateTarget` for a pushed repo (BUILD: full gate; QUEUE car: integration gate with the members' smoke paths) or null |
| — | — | `listOpenItems()` | RPC only: open items (the sim Oracle's TRIAGE dedupe) |
| POST | `/internal/webhook/train-result` | `reportTrainResult(TrainResult)` | `{outcome, train}`; apps/gatekeepers posts its verdict and Scribe summary (≤ 500 chars) here |
| POST | `/trains/:id/result` | `reportTrainResult` | Alias of the above; the train id comes from the path |
| POST | `/internal/webhook/build-result` | `reportBuildResult(BuildResult)` | The builder pushed the train head, so successors can fork from it |
| POST | `/internal/webhook/land-result` | `reportLandResult(LandResult)` | The lander pushed the head to the hive's `main` → MERGED |
| POST | `/internal/webhook/provision-result` | `reportProvisionResult(ProvisionResult)` | The Provisioner's FORK / DELETE outcome; idempotent by `commandId` |
| POST | `/internal/webhook/deploy-result` | `reportDeployResult(DeployResult)` | The Herald's outcome; idempotent by `commandId`. Preview DEPLOY / TEARDOWN go to the train (found from `trainId`, or else the command id); staging / canary DEPLOY and ROLLBACK go to the release (found from `releaseId`, or else the command id) and return `{outcome, release}` |
| POST | `/internal/webhook/sentinel-verdict` | `reportSentinelVerdict(SentinelVerdict)` | `{outcome, release}`; Sentinel's PROMOTE / ROLLBACK for staging or a canary step; idempotent by `commandId` |
| POST | `/releases/:releaseId/tap` | `tapRelease({releaseId, user})` | **User route**: needs `x-queen-user` (set by the edge after Cloudflare Access), 401 without; not behind the bearer token. Body `{releaseId}` optional (must match the path). 409 unless AWAITING_TAP, 404 if unknown. Starts the canary at 1% |
| POST | `/audit` | `appendAudit(AppendAudit)` | 201 `{event}`; a Cognitive Ledger entry (GitNotesPayload ≤ 16 KiB) |
| POST | `/scribe` | `recordScribeSummary(ScribeSummary)` | `{promptRun, train}`; the summary is ≤ 500 chars |
| GET | `/snapshot` | `getSnapshot()` | A `snapshot` server message |
| GET | `/room` (alias `/ws`) | DO `fetch` | WebSocket upgrade; returns 426 without one |

Errors come back as `{error: {code, message}}`:

| Code | Status |
|---|---|
| `INVALID_INPUT` | 400 |
| `NOT_FOUND` | 404 |
| `CONFLICT` | 409 |
| `UNAVAILABLE` | 503 |

Over RPC, the DO throws `Error("<CODE>: <detail>")`. `asQueenError()` in `src/errors.ts` turns it back into a typed error.

Duplicate, late or premature webhooks return 200 with an `outcome` of `ignored:stale`, `ignored:duplicate` or `ignored:premature`, so senders can safely retry.

## Auth

Machine-only HTTP routes (`/internal/*`, `/trains/:id/result`, `/audit`, `/scribe`) require `Authorization: Bearer <QUEEN_INTERNAL_TOKEN>` (`src/auth.ts`).

- The token is a wrangler secret: `wrangler secret put QUEEN_INTERNAL_TOKEN`. Locally, put it in `.dev.vars` (see `.dev.vars.example`).
- Comparison is constant-time (SHA-256 digests of both sides, XOR-compared, Web Crypto only).
- Missing or wrong token: 401 `UNAUTHORIZED`. Secret not configured: 503 (fail closed).
- `QUEEN_INTERNAL_AUTH="disabled"` skips the check. It is set only in `env.sim` (`pnpm dev:sim`); the `test` env uses a fixed test token instead.
- Drones and gatekeepers call the Queen over DO RPC (service binding to the `QueenNode` class), not HTTP, so they need no token.
- Left open on purpose: `POST /prompts`, `GET /snapshot`, and the `/room` WebSocket, because the dashboard uses them. **Beyond the hackathon these need user auth** (for example Cloudflare Access or per-hive tokens); today anyone who can reach the Worker can submit prompts and watch a hive.

## WebSocket (`/room`)

- On connect the server sends a `snapshot` (directly, never coalesced; so are errors and pongs).
- v2: every other broadcast is coalesced into `batch` frames (≤ 200 messages, ≤ 1 frame per 100 ms; a single message may be sent bare).
- The snapshot includes `deployments` (per-train preview rows now; staging/canary/prod rows from P3).
- After that it broadcasts `prompt.updated`, `train.updated`, `deployment.updated` and `audit.appended`, each after the change has been persisted.
- `?role=drone` tags a socket as a drone. The default tag is `role:dashboard`. Each socket is also tagged `hive:<ns>`, and its per-socket state lives in `serializeAttachment`.

Client messages follow `QueenClientMessageSchema`:

| Client message | Server response |
|---|---|
| `subscribe` | Re-sends the snapshot |
| `{"type":"ping"}` | `{"type":"pong"}` |
| `submit_prompt` | Submits the prompt to this hive |

The literal string `ping` gets the reply `pong` from the runtime's auto-response, which does not wake the DO.

Limits:

- 1,000 sockets per hive. Connections beyond that get 503.
- Frames are capped at 64 KiB. A larger frame closes the socket with code 1009.

## Orchestrator only: executors

The Queen decides, records and dispatches. It performs **no external I/O** (it has no Artifacts binding). Every side effect is a command to an executor Workflow, reached through a cross-script binding (`wrangler.jsonc`):

| Binding | Workflow (script) | Commands | Reports back with |
|---|---|---|---|
| `PROVISIONER` | `provisioner-workflow` / `ProvisionerWorkflow` (`queenos-provisioner`) | `ProvisionCommand` FORK / DELETE | `reportProvisionResult` |
| `HERALD` | `herald-workflow` / `HeraldWorkflow` (`queenos-herald`) | `DeployCommand` DEPLOY / TEARDOWN (preview) | `reportDeployResult` |
| `SENTINEL` | `sentinel-workflow` / `SentinelWorkflow` (`queenos-sentinel`) | `SentinelCommand` (staging / canary health window) | `reportSentinelVerdict` |
| `DRONES` | `drone-workflow` / `DroneWorkflow` (`queenos-drones`) | `DroneTask` BUILD / REWORK / MERGE / LAND | build / merge / train / land results |
| `ORACLE` | `oracle-workflow` / `OracleWorkflow` (`queenos-oracle`) | `OracleCommand` DECOMPOSE / TRIAGE | `reportOracleResult` |
| `GATEKEEPER` | `gatekeeper-workflow` / `GatekeeperWorkflow` (`queenos-gatekeepers`) | `GateCommand` (a gate for a train that entered TESTING) | `reportTrainResult` (with `gateId`) |

Other v2 bindings: `SWARM_GOVERNOR` (the `SwarmGovernor` DO in this Worker; vars `SWARM_MAX_ACTIVE_BUILDS`, `SWARM_AI_RPM`, `SWARM_LEASE`), `ANALYTICS` (Analytics Engine dataset `queenos_events`), and `observability` (Workers Logs; warn/error events are logged as JSON lines with `trace_id`).

- **Command ids** are `<trainId>-<op>-<n>` (`fork`, `delete`, `deploy`, `teardown`; `n` counts attempts). The id is stored on the train row in the same transaction as the decision, **before** dispatch, and is also the Workflow instance id, so re-dispatching it is a no-op.
- **Results** are matched by command id. A result for an older attempt returns `ignored:stale`, a repeat returns `ignored:duplicate`, and an unknown train returns `NOT_FOUND`. Executors treat `INVALID_INPUT:` / `NOT_FOUND:` / `CONFLICT:` errors as permanent.
- **FORK failure:** retried under a new command id, up to 3 attempts. After that the train fails like a test failure (EJECTED, and the prompt is re-queued as REWORK).
- **DELETE and TEARDOWN failures** are only recorded (`fork_state = DELETE_FAILED`, deployment `FAILED`); nothing is ejected.
- **Release commands** (staging / canary deploys, rollbacks, Sentinel windows) follow the same rules; see "Release train" below.
- **Reconcile:** if a dispatch throws, the DO sets an alarm, and `reconcile()` re-sends every pending command under the same id. A pending fork whose source changed gets a new id.
- **Queen-started gates (v15):** the push-event gate polls for TESTING only ~2 min (`GATE_PHASE_RETRIES` × `GATE_PHASE_WAIT_MS`) and its instance id is fixed per (repo, head), so a train that reaches TESTING later (pushed code parked by a paused hive, budget, capacity or dependencies; a slow preview) was never gated. Every train (BUILD and car) that enters TESTING now gets a `GateCommand` with id `gate-<repo>-<head>-q<n>` (round d of TESTING: n = 2d − 1; its one re-gate: 2d; `merge_trains.gate_command_id` / `gate_issued_at`). `GateTarget.gateId` names it: the push-event gate and any replaced gate stand down (`ignored: queen-gate`), and a report carrying another `gateId` is `ignored:stale` (a report without `gateId` is honoured as before). Watchdog (BUILD): no verdict within `GATE_TIMEOUT_MS` (2 × `COMMAND_TIMEOUT_MS`) → re-gated once, then the infra path (preview re-deployed after a backoff, a fresh gate; past `MAX_INFRA_ATTEMPTS`, EXECUTOR_LOST). Cars keep their retire watchdog. A TESTING row from before v15 is gated by the next alarm. The sim gatekeeper gates pushed code on these commands (drone builds and cars keep the sim drone's own gate).

**Seed requirement (P2 / Genesis, not owned yet):** the Herald deploys a hive only if its repo contains `.queen/deploy.json` (from `templates/worker-starter`). Nothing seeds the hive repo yet. Genesis / `createHive` must seed it.

## Git intake (human-push design rev 2, T1)

The git proxy Worker (`apps/git`) is the intake executor: it asks before it forks, reports after it pushes, and never decides. It calls the Queen over DO RPC (the same calls exist over HTTP behind the bearer token at `/hives/:hive/internal/git/{intent,pushed,aborted}` and `GET .../internal/git/notes?ref=`).

| RPC | Contract (queen-types `git.ts`) | What the Queen does |
|---|---|---|
| `gitIntent(GitPushIntent)` | → `GitIntakeDecision` | Pre-receive state rules (`work/inbox.ts` `decideIntent`): `main` → `refused:rule`; a head already submitted (applied, or pending from someone else) → `refused:duplicate`; unknown `item/<id>` / `goal/<slug>` → `refused:unknown-item`; `maxInboxPushesPerHour`, and (only when the push would file a new item) `maxInboxOpenPerContributor` and `maxOpenItems` → `refused:over-cap`. Paused / budget spent never refuses (a `queued:` line). Accepted: a **pre-forked train** (BUILD, `BUILDING`, `forkState: PENDING`, `origin: human`, repo `<hive>-train-<12hex>` that the proxy forks hive main into) and a `submissions` row `pending`. A pending intent of the same `(user, ref)` is replaced. |
| `gitPushed(GitPushed)` | → `GitPushedResult` | The Submission (`decideIntake`), then the train adopts the fork (`READY`, head, `baseSha`; `repo` is the intent's fork or the proxy's re-fork `<repo>-rN` of a sick first fork, which becomes the train's `artifactRepo` for the gate target, MERGE, kept-fork handoff and cleanup; anything else is `INVALID_INPUT`) and enters the pipeline exactly like a drone build-result (`DEPLOYING` → preview → gate), or is **parked** (fork READY, no drone) while its item is not ACTIVE; `dispatchReady` resumes it instead of forking a builder (so pause, budget, capacity and dependencies apply). Idempotent; a closed intent → `CONFLICT`. |
| `gitAborted(GitAborted)` | → `{outcome}` | The intent's train is EJECTED, no attempt, fork deleted, row `aborted:transient`. A pushed train is never aborted (`ignored:stale`). |
| `notesFor(hive, ref)` | → `NotesProjection` | The v1 notes projection (`work/notes.ts`, rendered with T0b `renderNotes`): one note per BUILD train head; `version` = newest `event_log` seq. Never input to a decision. |

**Intake rules** (`decideIntake`):
- **Uncorrelated** branch → a new `feature` (`filed`): title = head subject, body = message minus trailers, acceptance = `- ` lines under `Acceptance:`; READY (no TRIAGE), **no race** ("already won"), every gate applies.
- **Correlated** (`item/<id>`, `goal/<slug>`: its single child, else a new child; or a `Queen-Item` trailer on any branch) → `joined-race`: joins the item's RACING race, or opens a width-1 race (`entryClosesAt` null). A FAILED item reopens (attempts + 1). An unknown `Queen-Item` files a new item and says so.
- **Late** (item LANDED/SHIPPED/closed, its code passed / won / in a car, race entry closed, or an ACTIVE non-race build) → `late-new-item`: a follow-up item `"<title> (follow-up)"`.
- **Re-push** of the same `(user, ref)`: before boarding a car → `superseded` (old train EJECTED "superseded by push <sha>", LOST, no attempt, fork deleted; same item); after boarding / landing → a follow-up item; to a FAILED item → `reopened`.
- **Dedupe** is per head sha within the hive (`submissions.head_sha`; each push has its own fork repo, so `(repo, headSha)` alone would never collide).
- `Queen-Origin: agent:<name>` → origin `agent`, `<name>@<email>`; caps count per token-owner email.

**Lifecycle.** A gate reject (or a conflict / integration failure) of human/agent code does **not** rework: the train is EJECTED with its **fork kept** (`forkState: READY`; `delete_issued_at` holds the delete-after deadline, 24 h), the item goes FAILED with `blockedReason: "awaiting contributor"` and no escalation. A race of contributed candidates only that nobody passes does the same. **Handoff** (`Queen: rework` on the head commit, or `POST /items/:id/actions {action:"handoff"}` on a FAILED pushed item) reworks as for drones under `maxReworks`; the REWORK forks **from** the newest kept fork (`FORK.from`) and its `DroneTask` carries `seed` and `brief` = that commit's rendered `refs/notes/verdict` note (byte-identical to `notesFor`). Kept forks are deleted by the alarm at their deadline, or once the item left FAILED with no REWORK active. The **intent watchdog**: a pre-forked train with no `gitPushed` within `COMMAND_TIMEOUT_MS` (10 min) is ejected like `gitAborted`. A pending intent holds its targeted item READY (`waitReason: "awaiting push"`). The alarm prunes `submissions` older than 30 days. `GateTarget.origin` / `MergeTrain.origin` say whose code it is (the reviewer fails closed for non-drone origin); `GateTarget.baseSha` is the hive main the proxy forked.

**Notes** (`refs/notes/verdict`): PASSED / REJECTED by <ROLE> (with findings parsed from the REJECTED audits between the train's enqueue, or its previous verdict, and this verdict: only the train's own, and its head's, when the audit names them — gatekeepers send `trainId` / `commitSha` in `appendAudits`, stored as `event_log.train_id` / `data.commitSha` — else, for older rows, the item's) / INFRA from `gate.verdict`; SUPERSEDED, REJECTED (lost the race / CONFLICT) from EJECTED; `LANDED main@<sha>`; then `SHIPPED in release <id>` / `ROLLED BACK` without a `Queen-Verdict` (the last verdict stays LANDED, which is what agents wait for). `refs/notes/review`: the findings. `refs/notes/provenance`: `BUILT by <model>` or `PUSHED by human:<email>`. A seeded REWORK's entries carry `Queen-Replies-To: <rejected sha>`.

## Merge train

The planner lives in `src/train/planner.ts`. It is pure and returns effects for the DO to execute.

> **v2:** builds no longer chain. Every BUILD train forks from `main`; passed builds board merge-queue **cars** (QUEUE-lane trains, `src/train/queue.ts`) that are chained exactly as described below, merged by the MERGE drone and landed by the LANDER. The text below describes that speculative chain (it now carries cars); see `docs/v2-design.md` §2.3 for the lanes, races and bisect.

- Train k holds `main + prompts 1..k`. **Forks are chained:**
  - Train 1 is forked from the hive repo.
  - Train k is forked from train k-1's fork once train k-1's builder has pushed.
  - Builds run one after another. Tests run speculatively and in parallel.
- **Train phases** (`TrainPhaseSchema`; `status` is derived):

  | Phase | Public status | Meaning |
  |---|---|---|
  | `WAITING_PARENT` | BUILDING | Waiting for the predecessor's push before forking |
  | `BUILDING` | BUILDING | FORK dispatched / fork ready; the builder drone is working |
  | `DEPLOYING` | TESTING | The builder pushed; the Herald is deploying the head to the train's Worker Preview. Successors already fork from this push |
  | `TESTING` | TESTING | Preview is LIVE (`previewUrl` set in the same update); gatekeepers smoke-test it |
  | `PASSED` | TESTING | Verdict green; waiting to be the queue head |
  | `LANDING` | TESTING | The lander drone pushes the head to `main` |
  | `MERGED` / `EJECTED` | same | Terminal: the fork is deleted and the preview torn down |

  `DEPLOYING` reports as TESTING because the code is pushed and is being verified; deploying the preview is the first test step. A gatekeeper **pass** before `TESTING` is `ignored:premature`, but a **failure** is honoured in any phase. A failed deploy (or an ok deploy with no URL) fails the train like a test failure.
- **Landing:** only the head of the queue can land. Artifacts has no merge API, so landing works like this:
  1. The head train goes to phase `LANDING`, which still shows as status `TESTING`.
  2. A `LANDER` drone (`action: "LAND"`) pushes the head to the hive's `main`.
  3. `land-result` marks the train MERGED, deletes its fork and tears down its preview.
- **Failure:** when a train fails, it is EJECTED and its fork is deleted.
  - Later trains that contain the failed prompt are superseded. They get new train ids and are re-forked from the nearest surviving predecessor, or from `main` if there is none.
  - The failed prompt goes back on the queue at the tail as a `REWORK` builder task that carries the Scribe summary.
  - After 2 reworks the prompt is marked FAILED.
- **Durability:** command ids and dispatch intents are persisted before anything is dispatched. If a dispatch fails, the DO sets an alarm, and `reconcile()` re-issues it once that alarm fires.
- **Late deploys:** if a DEPLOY completes after its train ended (it was never LIVE), the preview may have been re-created behind the teardown, so a second TEARDOWN is issued, once.

## Release train (P3)

The planner lives in `src/release/planner.ts` (pure, like the train planner) and shares the Queen's SQLite (`releases` table; environment rows `staging` / `canary` / `prod` in `deployments`). A MERGED train hands the new main head to it in the same transaction.

| Phase | Waiting on | Next |
|---|---|---|
| `STAGING` | Herald `DEPLOY staging` → `<hive>-staging` | ok → `VALIDATING` (stagingUrl); !ok → `FAILED` |
| `VALIDATING` | Sentinel (staging) | PROMOTE → `AWAITING_TAP`; ROLLBACK → `FAILED` (P5: bisect + revert) |
| `AWAITING_TAP` | a human (`POST .../tap`) | tap → `CANARY` 1% (records tappedBy / tappedAt) |
| `CANARY` | Herald `DEPLOY canary` at 1 / 10 / 50 / 100%, then Sentinel per step | PROMOTE → next step; at 100% → `SHIPPED`. ROLLBACK or deploy !ok → Herald `ROLLBACK` → `ROLLED_BACK` (no stable version → `FAILED`) |
| `SHIPPED` / `ROLLED_BACK` / `FAILED` / `SUPERSEDED` | — | terminal |

- A merge during STAGING / VALIDATING / AWAITING_TAP supersedes the release (late results → `ignored:stale`) and cuts a new one. A merge during CANARY is queued and cut when the canary ends.
- A release carries every train landed since the last SHIPPED release.
- First prod deploy: Herald returns no `stableVersionId` and deploys at 100%, so the canary is a single 100% step.
- Command ids: `<releaseId>-<op>-<n>`, op `staging`, `validate`, `canary<p>`, `verify<p>`, `rollback`.
- Watchdog: same caps as the train; Sentinel gets `max(COMMAND_TIMEOUT_MS, SENTINEL_WINDOW_SECONDS*1000 + 5 min)`. A lost canary verdict rolls back.
- Vars: `SENTINEL_WINDOW_SECONDS` (default 60) and `SENTINEL_MIN_REQUESTS` (default 100).
- Broadcasts `release.updated` (updatedAt strictly increases), `deployment.updated`, `sentinel.verdict`; the snapshot has `releases` (newest first, 20).
- Sim: a new hive is `autonomous`, so a staging PROMOTE auto-ships (`tappedBy: queen:autonomous`). To tap by hand, make it supervised first: `curl -XPATCH localhost:8787/hives/<hive>/settings -H 'content-type: application/json' -d '{"autonomy":"supervised"}'` (the localhost sim defaults the user), then `curl -XPOST localhost:8787/hives/<hive>/releases/<id>/tap -H 'x-queen-user: you@example.com'`. A prompt containing `[canary-fail]` makes the sim Sentinel roll back at 10%; two rollbacks in a row degrade the hive to supervised (ROLLBACK_STREAK).
- Sim markers (v2): `[race]` (best-of-3), `[hard]`, `[touch:<path>]`, `[collide]`, `[batch-fail]`, `[spot-bug]`, `[gate-spot]`, `[inconclusive]`, `[decompose-fail]`; `POST /prompts` with `"decompose": true` splits bullets into items (see `src/sim/sim-v2.ts`).

## Model router

The Queen picks each builder drone's model; `src/models/router.ts` is pure and unit-tested. Every LLM call goes through the Workers `ai` binding and AI Gateway, so any `MODEL_CATALOG` model (queen-types) is available.

- **Who uses it:** BUILD and REWORK tasks carry `task.modelChoice` (`model`, `tier`, `role`, `reason`, `fallbacks`). LAND tasks don't use it (landers call no LLM), and neither does the Scribe, which keeps its env model in the gatekeepers.
- **Tiers:**
  - A first BUILD routes at the hive's **floor** (starts at `fast`).
  - REWORK, or any attempt of 2 or more (including a watchdog re-dispatch), escalates to `frontier`. Escalation is local to that prompt and never moves the floor.
- **Ranking:** candidates are the fitting models in the tier or above: the catalog role matches, the model can drive the tool loop (`toolLoop` is not `false`, which excludes Qwen 3.8), and `chars / 3` plus 64k tokens of headroom fits the context window. They are ranked by expected cost per success, `((passes + 1) / (attempts + 2) − 0.05 × min(failStreak, 3)) / cost`. A slow model scores ×0.8: one flagged `slow` in the catalog (GLM-5.3), or any model averaging over 120 s. Ties go to the lower cost, then catalog order.
- **Exploration:** every 5th router decision tries the least-tried model in the chosen tier.
- **Fallbacks:** up to 2. The rest of the chosen tier comes first, then the best model one tier up.
- **Floor (AIMD with probing), persisted in `model_router`:**
  - A gate failure, an unusable change set (`failedModels`), or a builder that gives up on a first-attempt BUILD raises the floor one tier.
  - `ROUTER_BACKOFF_STREAK` (3) passes at the floor lower it one tier.
  - While the floor is above `fast`, after `ROUTER_PROBE_AFTER` (4) floor dispatches the next one probes a tier lower. A probe that passes drops the floor at once.
  - The War Room sees the floor as `snapshot.routerFloor` and in `models.updated.floor`.
- **Stats:** kept in `model_stats`, keyed by `(model, role)`.
  - `build-result`: attempts+1 for `model` (or the chosen model), which also feeds `avgBuildMs`. Each `failedModels` entry gets attempts+1 and failures+1. The train's `model` becomes the model actually used.
  - Gate verdict: passes+1 on a pass, failures+1 on a fail.
  - Each count happens once per train, guarded by `model_outcome`.
  - Models outside the catalog (for example `queenos/scripted-drone-v1`) are never counted.
  - After each change the Queen broadcasts `models.updated`, and the snapshot carries `modelStats`.
- **Pin:** `MODEL_ROUTER_PIN_BUILDER=<model id>` forces one model for builder and rework tasks.
- **Sim:**
  - Sim drones report the chosen model. A frontier build takes 1.6× as long.
  - `[fail]` fails the first BUILD at the gate, which raises the floor and shows the rework escalating.
  - `[bad-json]` makes the chosen model "return junk" so the first fallback builds instead (`failedModels`).

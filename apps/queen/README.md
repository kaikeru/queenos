# @queenos/queen

Hono Worker plus the `QueenNode` Durable Object, which is the scheduler and state machine for the speculative merge train. State lives in SQLite. The War Room dashboard gets updates as WebSocket broadcasts.

## Hives and routing

There is **one `QueenNode` per hive**, addressed by `idFromName(namespace)`. A hive is one base repo in Artifacts (named `<namespace>`) and one merge queue. Its train forks are named `<namespace>-train-<12 hex>`. Namespaces must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`.

- **Canonical:** `/hives/:namespace/<route>`.
- **Root alias:** `/<route>` resolves the hive from the `x-queen-hive` header or `?namespace=`.
  - `POST /prompts` falls back to the body's `namespace`.
  - Every other route falls back to the `queen` hive.

| Method | Route | RPC on the stub | Body / result |
|---|---|---|---|
| POST | `/prompts` | `submitPrompt(SubmitPrompt)` | 201 `{promptRun}` |
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

- On connect the server sends a `snapshot`.
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
| `DRONES` | `drone-workflow` / `DroneWorkflow` (`queenos-drones`) | `DroneTask` BUILD / REWORK / LAND | build / train / land results |

- **Command ids** are `<trainId>-<op>-<n>` (`fork`, `delete`, `deploy`, `teardown`; `n` counts attempts). The id is stored on the train row in the same transaction as the decision, **before** dispatch, and is also the Workflow instance id, so re-dispatching it is a no-op.
- **Results** are matched by command id. A result for an older attempt returns `ignored:stale`, a repeat returns `ignored:duplicate`, and an unknown train returns `NOT_FOUND`. Executors treat `INVALID_INPUT:` / `NOT_FOUND:` / `CONFLICT:` errors as permanent.
- **FORK failure:** retried under a new command id, up to 3 attempts. After that the train fails like a test failure (EJECTED, and the prompt is re-queued as REWORK).
- **DELETE and TEARDOWN failures** are only recorded (`fork_state = DELETE_FAILED`, deployment `FAILED`); nothing is ejected.
- **Release commands** (staging / canary deploys, rollbacks, Sentinel windows) follow the same rules; see "Release train" below.
- **Reconcile:** if a dispatch throws, the DO sets an alarm, and `reconcile()` re-sends every pending command under the same id. A pending fork whose source changed gets a new id.

**Seed requirement (P2 / Genesis, not owned yet):** the Herald deploys a hive only if its repo contains `.queen/deploy.json` (from `templates/worker-starter`). Nothing seeds the hive repo yet. Genesis / `createHive` must seed it.

## Merge train

The planner lives in `src/train/planner.ts`. It is pure and returns effects for the DO to execute.

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
- Sim: staging → AWAITING_TAP automatically; then `curl -XPOST localhost:8787/hives/<hive>/releases/<id>/tap -H 'x-queen-user: you@example.com'`. A prompt containing `[canary-fail]` makes the sim Sentinel roll back at 10%.

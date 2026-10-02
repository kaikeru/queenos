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
- After that it broadcasts `prompt.updated`, `train.updated` and `audit.appended`, each after the change has been persisted.
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

## Merge train

The planner lives in `src/train/planner.ts`. It is pure and returns effects for the DO to execute.

- Train k holds `main + prompts 1..k`. **Forks are chained:**
  - Train 1 is forked from the hive repo.
  - Train k is forked from train k-1's fork once train k-1's builder has pushed.
  - Builds run one after another. Tests run speculatively and in parallel.
- **Landing:** only the head of the queue can land. Artifacts has no merge API, so landing works like this:
  1. The head train goes to phase `LANDING`, which still shows as status `TESTING`.
  2. A `LANDER` drone (`action: "LAND"`) pushes the head to the hive's `main`.
  3. `land-result` marks the train MERGED and deletes its fork.
- **Failure:** when a train fails, it is EJECTED and its fork is deleted.
  - Later trains that contain the failed prompt are superseded. They get new train ids and are re-forked from the nearest surviving predecessor, or from `main` if there is none.
  - The failed prompt goes back on the queue at the tail as a `REWORK` builder task that carries the Scribe summary.
  - After 2 reworks the prompt is marked FAILED.
- **Durability:** fork, delete and dispatch intents are persisted before any I/O. If one of those calls fails, the DO sets an alarm, and `reconcile()` re-issues the call once that alarm fires.

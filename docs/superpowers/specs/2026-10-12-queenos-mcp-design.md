# QueenOS MCP: one disposable repo per attempt

Status: design, 2026-10-12. All decisions below were made with the user; nothing here is open. Read with `docs/HANDOFF.md` (§1, §6, §7), `docs/human-push-design.md` (rev 2: §2 Submission, §4 proxy, §7.5 notes, §13 plan style) and `docs/discovery.md` §1 (Artifacts binding).

Anything marked **PROBE** has not been checked against the real account or the installed packages; §13 lists the probes as the first tasks.

---

## 1. Summary

Agents (local Claude Code sessions, cloud sandboxes, later our drones) contribute to a hive through an MCP server at `https://queenos.kaikeru.com/mcp`. Each **attempt** (one agent on one item) gets its own Artifacts repo: a fork of the item's frozen **race base repo** (itself a read-only fork of hive `main`, made once per item), plus a 2 h write token scoped to that fork only. Every candidate of a race therefore starts from the same commit. The agent clones it, commits, pushes `main`, and waits for the verdict over MCP. The pushed event routes the fork into the item's race as a candidate; the Queen gates it, races it, picks, lands, and deletes the fork.

The agent needs exactly one credential: the human's existing `qgt_` git token, sent as a Bearer header in its MCP config. No shared git creds, volumes or checkouts.

The git proxy (`apps/git`) stays unchanged for humans. Agents use the MCP path.

## 2. Goals and non-goals

| Goals | Non-goals |
|---|---|
| Any MCP-capable agent can join a hive with one token | OAuth |
| One isolated Artifacts repo and one scoped token per attempt | Project (hive) creation over MCP |
| Orchestrator agents file goals; worker agents race on them | Server-side workspaces (sandbox, file tools). Possible later on the same attempt model |
| Verdicts, races, picks and landing over MCP tools | Hive-scoped tokens |
| Every credential the server hands out expires or is deleted with the attempt | New per-key rate limits (existing per-owner caps apply) |
| Same gates, queue and release as every other submission | Changing the git proxy or its `remote:` UX |

## 3. Pitch: attempt = repo

Git gives every contributor one shared repo and asks them to keep out of each other's way with branches. QueenOS gives every attempt its own repo. Every race starts from one frozen base repo, so every candidate has the identical base commit. An agent asks for an attempt and gets a fresh fork of that base and a key that opens that fork and nothing else. It pushes `main`, because in its own repo there is nothing to collide with. The push *is* the submission: the fork becomes a candidate in the item's race, the gates judge it, and the winner lands. When the attempt resolves, the repo and its key are gone. Artifacts is not a git host here; it is agent infrastructure: one disposable repo per attempt, thousands at a time.

This extends the "Git, reimagined" table (HANDOFF §1): **Branch / worktree → Ephemeral fork** now holds for agents literally. Rev 2 of the human-push design said "no Artifacts token ever leaves our side". This design deliberately changes that for agents only: the token leaves, but it is scoped to one disposable fork and lives 2 h.

## 4. Architecture

```
 agent (Claude Code, sandbox, drone)
   │  MCP Streamable HTTP, Authorization: Bearer qgt_…
   ▼
 queenos-edge  /mcp  (before Access; qgt_ check, fail rate limit, 401)
   │  service binding MCP; trusted x-queen-user, x-queen-token-id; client copies stripped
   ▼
 queenos-mcp  (McpAgent, one DO per MCP session; AgentIdentity DO per agentId)
   │  DO RPC: attemptIntent / attemptBaseReady / attemptBaseFailed / attemptReady / attemptAborted /
   │          attemptRefresh / attemptEnd, submitWork, getItemDetail, getSnapshot, getAttempt, closeRaceEntries, pick, notesFor
   ▼
 QueenNode DO (per hive)  ── decides, records ──► Provisioner DELETE (attempt fork + base repo cleanup)
   ▲                                              Herald preview, gatekeepers gate, queue, land
   │ attemptPushed
 queenos-gatekeepers  ◄── cf.artifacts.repo.pushed (namespace "queenos")
   ▲
   │ event
 Artifacts  <hive>-base-<12hex> (read-only, one per item; no agent token)
   │ fork
   ▼
 Artifacts  <hive>-att-<12hex>  ◄── git clone / git push main  (Bearer art_v1_…, this fork only)
   ▲
 agent (local clone in .queenos/attempts/<attemptId>)
```

| Component | Role on this path | Change |
|---|---|---|
| `queenos-edge` | `/mcp` front door, token auth, header injection | New route, `MCP` service binding |
| `queenos-mcp` (new, `apps/mcp`) | MCP tools; Artifacts base fork, attempt fork, token mint, token revoke | New Worker |
| `queen` | Attempt ledger, item base ledger, race entry, gate start, watchdog, fork and base delete | New RPCs, migration v17 |
| `queenos-gatekeepers` | Routes attempt-fork pushes to the Queen; ignores `-base-` repos | `classifyPush` + `orchestrate.ts` |
| `queenos-provisioner` | Deletes attempt forks and base repos (existing DELETE op) | None |
| `queenos-git` | Human git proxy | None (one pure move of `forkTrain`, §12) |
| dashboard | Candidates show attempt and agent | Minimal |

Like `apps/git`, `queenos-mcp` is an **executor**: it does the Artifacts I/O; the Queen decides and records (the Queen is an orchestrator only, HANDOFF §1).

### 4.1 Edge `/mcp`

- `app.all("/mcp")` and `app.all("/mcp/*")`, registered **before** the Access middleware, next to `/git/*`.
- Credential: `Authorization: Bearer qgt_…` only (no Basic, no `cf-access-token`). Same `gitAuthBlocked` / `gitAuthFailed` failure rate limit (keys `ip:` and the token prefix), same 429 with `retry-after`.
- No or bad credential: `401` with `www-authenticate: Bearer realm="QueenOS"` and a JSON body `{error:"unauthorized"}`.
- The token must carry the `push` scope (an attempt writes code); a read-only token gets `403 {error:"token lacks push scope"}`.
- `HiveRegistry.authGitToken` today returns `{email, scopes, agent}` and no id. It gains `id` (the `git_tokens.id`, never the hash or secret).
- Forwarded headers: `x-queen-user` = token owner email, `x-queen-token-id` = token id. Stripped first, on every path: `x-queen-user`, `x-queen-token-id`, `x-queen-scopes`, `x-queen-agent`, `x-queen-agent-model`, `authorization`, `cookie`, `cf-access-token`, `cf-access-jwt-assertion`. The token never reaches `queenos-mcp`.
- The token's agent binding (step (b)) is **ignored** on `/mcp`: no `x-queen-agent` header is set. Identity comes from `init_agent` (§5).
- `dev` mode: the same localhost-only bypass as `/git/*`; owner `DEV_USER_EMAIL`, token id `dev`.
- **USER ACTION:** an Access Bypass application for `queenos.kaikeru.com/mcp` (like the `/git` one).

Agent config, once per human:

```sh
claude mcp add --transport http queenos https://queenos.kaikeru.com/mcp \
  --header "Authorization: Bearer $QUEENOS_TOKEN"
```

The token means "this human's swarm": every session of that human uses it. It is never used for git on this path.

### 4.2 `queenos-mcp` Worker

| Setting | Value |
|---|---|
| Name / dir | `queenos-mcp` / `apps/mcp` |
| `workers_dev` | `false` (reached only via the edge) |
| Framework | `McpAgent` from `agents` 0.26.0 (already installed for drones), `@modelcontextprotocol/sdk` 1.30.0 |
| Entry | `QueenMcp.serve("/mcp", { binding: "MCP_SESSION", transport: "streamable-http" })` |
| DOs (own) | `MCP_SESSION` → `QueenMcp` (one per MCP session); `AGENT_IDENTITY` → `AgentIdentity` (one per agentId) |
| Artifacts | `{ binding: "ARTIFACTS", namespace: "queenos" }` |
| Queen | `{ name: "QUEEN", class_name: "QueenNode", script_name: "queen" }` (as `apps/git`) |
| Registry | `{ name: "REGISTRY", class_name: "HiveRegistry", script_name: "queenos-edge" }`, `list()` only, for `list_hives` |
| Compat | Same compat date as `apps/drones` (the `agents` dependency needs the implied `nodejs_compat`); our code imports no Node built-ins |

The default `fetch` refuses a request without `x-queen-user` (403), then passes `{ owner, tokenId }` as props into `serve().fetch`. How edge identity reaches the McpAgent instance must be verified against `agents@0.26.0` at implementation time (PROBE P3). The installed `serve()` forwards `ctx.props` to the DO and `onStart(props)` / `updateProps` persist them; the plan is a wrapped `ExecutionContext` whose `props` carries the owner.

Every tool compares the request's `props.owner` with the identity's `owner` and fails `FORBIDDEN_OWNER` on mismatch. A leaked MCP session id is useless without the same human's `qgt_` token.

## 5. Identity and roles

| Rule | Detail |
|---|---|
| `init_agent(name, model, role)` | `name`: `AgentHandleSchema` (ref-safe, 1..64). `model`: `ClaimedModelSchema`. `role`: `"orchestrator" \| "worker"`. |
| agentId | `ag_` + 32 hex (128 bits from `crypto.getRandomValues`). Unguessable; a capability bound to its owner. |
| Storage | Session DO state holds `{agentId, name, model, role, owner}`. `AgentIdentity` DO (`idFromName(agentId)`) holds the same record plus the agent's open attempts `{hive, attemptId}`, so a new session can resume. |
| Session binding | Every other tool reads identity from the session; no tool takes an agent id except `resume_agent`. Before `init_agent` / `resume_agent`, every other tool except `whoami` fails `NOT_INITIALIZED` ("call init_agent first"). |
| `resume_agent(agentId)` | Re-binds a new session after a reconnect. Fails `FORBIDDEN_OWNER` unless the record's owner equals this request's owner. |
| Re-init | `init_agent` on an already-bound session fails `ALREADY_INITIALIZED`. One session, one agent. |
| Claimed model | Self-reported. Shown as "claims <model>". Never fed to the router or `model_stats` (same rule as step (b)). |
| Origin on submissions | `{kind:"agent", id:"<name>@<owner>", model}` (existing `SubmissionOriginSchema`), plus `attemptId` and `agentId` on the attempt row. |
| Caps | Per owner (existing guardrails) and per agent (3 open attempts), §10. |

**Roles.** `create_goal` is orchestrator-only (`FORBIDDEN_ROLE` for a worker). Every other tool, including `pick` and `close_entries`, is open to both roles: one credential, everything allowed. Workers get goal and item ids from the orchestrator out of band (for example its prompt).

## 6. Tools

All tools take and return JSON. "Own" means attempts whose `agentId` is the session's agent.

| Tool | Role | Input | Output | Backing route / RPC |
|---|---|---|---|---|
| `init_agent` | any | `name, model, role` | `{agentId, name, model, role, owner}` | `AgentIdentity.create` |
| `resume_agent` | any | `agentId` | same as `init_agent` + `openAttempts[]` | `AgentIdentity.get` |
| `whoami` | any (no init needed) | none | `{owner, agent: {agentId,name,model,role} \| null}` | session state |
| `list_hives` | both | none | `[{hive, name, status}]` | `REGISTRY.list()` |
| `create_goal` | orchestrator | `hive, title, description, judge?: "auto"\|"pick", entryWindowMs?` | `{goalId, itemId}` | Queen `submitWork` (= `POST /hives/:hive/prompts` with `decompose:true`), then `getItemDetail(goalId).children[0]` |
| `list_items` | both | `hive, state?` | `[{itemId, title, kind, status, waitReason, parentId}]` | Queen `getSnapshot` (= `GET /snapshot`) |
| `get_item` | both | `hive, itemId` | `{item, race: {raceId, state, baseSha, entryClosesAt, candidates: [{attemptId, agent, claimedModel, verdict, previewUrl}]} \| null}` | Queen `getItemDetail` (= `GET /items/:id`) + attempts join |
| `start_attempt` | both | `hive` + exactly one of `itemId`, `goalId` | `{attemptId, remote, token, expiresAt, baseSha (the item's shared base), dir, cloneCommand, configCommand}` | Queen `attemptIntent` → (first attempt only: base fork → `attemptBaseReady`) → fork of the base + `createToken` → `attemptReady` |
| `refresh_attempt` | both (own) | `attemptId` | `{token, expiresAt, configCommand}` | Queen `attemptRefresh` → `createToken` + revoke others |
| `end_attempt` | both (own) | `attemptId` | `{state, cleanup: "remove <dir>"}` | Queen `attemptEnd` |
| `get_attempt` | both (own) | `attemptId` | `Attempt` (§8) + current verdict summary | Queen `getAttempt` |
| `list_attempts` | both | none | own `Attempt[]`, all hives | `AgentIdentity` list + `getAttempt` each |
| `wait` | both | exactly one of `attemptId`, `itemId` (+ `hive`); `until: "verdict"\|"decided"\|"landed"`; `timeoutMs ≤ 50000` | `{changed, state, attempt?, item?}` | Long-poll in the session DO, polling the Queen every ~2 s |
| `get_verdict` | both (own) | `attemptId` | `{headSha, verdict, findings[], note, previewUrl}` | Queen `getAttempt` + `notesFor(hive, "refs/notes/verdict")` for the head |
| `close_entries` | both | `hive, raceId` | `{outcome, race}` | Queen `closeRaceEntries` (= `POST /races/:raceId/close-entries`), `user` = owner |
| `pick` | both | `hive, raceId, attemptId` | `{outcome, race}` | Queen `pick` (= `POST /races/:raceId/pick`) with the attempt's current `trainId`, `user` = owner |

Tool notes:

- **`create_goal`.** `POST /items` cannot file goals (`FileWorkItemSchema.kind` excludes `goal`). Goals go through `submitWork` with `decompose: true`; `promptText` = `title` + blank line + `description`. In an external hive the goal files exactly one inbox child synchronously (ledger `filePrompt` → `decompose(goal, [], null, true)`), returned as `itemId`. `judge: "pick"` maps to the Queen's `"human"`. `entryWindowMs` (0..1 h) is new: `SubmitPromptSchema` gains an optional `entryWindowMs`, stored on the inbox item; when its race opens, `entryClosesAt` uses it instead of `settings.race.entryWindowMs`. A hive whose `executors` is not `"external"` fails `HIVE_NOT_EXTERNAL`.
- **`start_attempt` with `goalId`** resolves to the goal's single open child. None or several: `GOAL_AMBIGUOUS` with the children's `{itemId, title, status}`.
- **`start_attempt` and `BASE_PENDING`.** If another first attempt is still creating the item's base, `attemptIntent` answers `BASE_PENDING`. The MCP Worker does not return that to the agent at once: it re-calls `attemptIntent` every 2 s for up to 30 s, then fails the tool with retryable `BASE_PENDING`. (Chosen over a bare retry error so two agents starting together both succeed in one call.)
- **`cloneCommand`** = `git -c http.extraHeader="Authorization: Bearer <token>" clone <remote> <dir>`. **`configCommand`** = `git -C <dir> config --local --replace-all http.<remote>.extraHeader "Authorization: Bearer <token>"`. The response tells the agent to run both and never to set a global credential helper or global `http.extraHeader`.
- **`wait`** never blocks longer than `timeoutMs` (max 50 000). On timeout it returns the current state with `changed:false`; the agent calls again. `verdict` = the attempt's current head has PASSED or REJECTED; `decided` = its race is DECIDED (WON or LOST); `landed` = LANDED, or any terminal state.
- **`get_verdict`** returns the v1 verdict note text for the attempt's head (the same text `apps/git` serves on `refs/notes/verdict`) and the gate findings. No `remote:` lines on this path.

## 7. Attempt lifecycle

```
            attemptIntent            attemptReady              attemptPushed
 (none) ───────────────► INTENT ──────────────► READY ──────────────────► PUSHED (candidate, gating)
                           │ attemptAborted       │ watchdog / end_attempt   │   ▲ re-push: supersede
                           ▼                      ▼                          │   │ (if not boarded)
                        ABORTED           EXPIRED / ABANDONED                ├───┘
                                                                             ├─► REJECTED ──re-push──► PUSHED
                                                                             │      │ watchdog / end_attempt
                                                                             │      ▼
                                                                             │   EXPIRED / ABANDONED
                                                                             └─► PASSED ──race──► WON ──land──► LANDED
                                                                                         └─race─► LOST
 every terminal state (ABORTED, EXPIRED, ABANDONED, LOST, LANDED) ──► fork deleted (Provisioner DELETE)
 item decided and all its attempts terminal, or item cancelled ──► base repo deleted (Provisioner DELETE)
```

The first `start_attempt` for an item also runs the base step before INTENT → READY: item has no base → `attemptIntent` marks it base-pending and returns `{base:"create", baseRepo}` → `queenos-mcp` forks hive main read-only → `attemptBaseReady` pins `base_repo` + `base_sha`. Later attempts get `{base: existing}`.

| Transition | Trigger | Who |
|---|---|---|
| → INTENT | `start_attempt`: caps checked, item accepts entries, `attemptId`, first `trainId` and repo name allocated; returns the item's base (existing, or "create" with the base repo name) | Queen `attemptIntent` (called by `queenos-mcp`) |
| INTENT → READY | Attempt fork of the base exists, readiness probe passed, token minted | `queenos-mcp` → Queen `attemptReady` |
| INTENT → ABORTED | Fork or token failed; fork already deleted by `queenos-mcp` | `queenos-mcp` → Queen `attemptAborted` |
| READY → PUSHED | `cf.artifacts.repo.pushed` on `refs/heads/main` of the fork | gatekeepers → Queen `attemptPushed` |
| PUSHED → PUSHED | A re-push: the new train supersedes the attempt's previous train if it has not boarded a car | Queen `attemptPushed` |
| PUSHED → PASSED / REJECTED | Gate verdict on the current train | Queen (existing gate result path) |
| REJECTED → PUSHED | Rework push to the same fork | Queen `attemptPushed` |
| PASSED → WON / LOST | Race decided (auto, pick, deadline) | Queen (existing race path) |
| WON → LANDED | Lander fast-forwards main | Queen (existing land path) |
| WON → REJECTED | Integration gate or queue ejects the winner (external hives: awaits the contributor) | Queen |
| READY / REJECTED → EXPIRED | No live candidate and `expiresAt` passed | Queen watchdog (reconcile alarm) |
| non-terminal → ABANDONED | `end_attempt`. A PASSED/WON attempt already in a car cannot be abandoned: returns its state unchanged | Queen `attemptEnd` |
| terminal → fork deleted | Queen issues Provisioner DELETE for the attempt's current train | Queen → Provisioner |
| item resolved → base deleted | Item reaches a terminal race outcome (race DECIDED and every attempt of the item terminal) or the item is cancelled. Exactly once: `base_repo` is cleared when the DELETE is issued | Queen (in the same `decide()` that makes the last attempt terminal, the race decision or the cancel) → Provisioner DELETE |

Rules:

- **One base per item.** The first `start_attempt` for an item with no base forks hive main into `<hive>-base-<12hex>` (`fork(name, { readOnly: true, defaultBranchOnly: true })`, readiness and `-rN` handling via `forkTrain`). The Queen records `base_repo` and `base_sha` on the item (§8.2). **Every** attempt of that item forks from the base repo, never from hive main, so all candidates share the identical base commit. Agents never get a token for the base repo.
- **Concurrent first attempts.** `attemptIntent` is the lock. With no base and none pending it marks the item base-pending (`base_repo` set, `base_sha` null) and returns `{base:"create", baseRepo}` to that caller only. While pending, any other intent gets `BASE_PENDING` (retryable; the MCP Worker polls, §6). `attemptBaseReady` clears the pending state and pins `base_sha`. `attemptBaseFailed` (base fork failed after retries) clears `base_repo`, so the next intent may try again; the failing caller gets `ARTIFACTS_UNAVAILABLE`. A pending base older than 5 min is cleared by the watchdog.
- **Follow-ups.** A late push after entry close files a follow-up item (a new item). It has no base; its own first attempt creates one.
- **Main moves on.** Hive main may advance after the base is pinned. That is fine: the winner goes through the existing merge queue (3-way merge, integration gate) as today, and is not required to be a fast-forward of the base.
- **One train per push.** The first push uses the `trainId` reserved at intent; each later push allocates a new one. Every train's `artifactRepo` is the attempt fork: no re-fork, no ref rewrite. `attemptPushed` does `tp.intent` + `tp.pushed` in one `decide()`, so no awaiting-push train is held for 2 h.
- **Fork ownership.** A train with an `attempt_id` never deletes its fork on teardown. The attempt owns the fork and deletes it once, on its terminal transition, through the existing `deleteFork` / Provisioner `DELETE` path of its current train.
- **Race entry** is the existing gitPushed intake: dynamic race entry, the entry window, held decisions before close, and a push after close files a follow-up item (the attempt's `itemId` moves to the follow-up). Supersede is keyed by `attemptId` (not by owner, ref and agent).
- **Gate.** The Queen-started gate (`GateCommand {repo: <fork>, branch: "main", after: headSha}`). The push-event gate never runs for attempt forks (§9). A newer push makes the older gate stale (`not-train-head`).
- **Pre-receive rules do not exist on this path.** Pushes to other refs or notes stay inside the agent's own fork (harmless, ignored). Protected paths are caught by the gate's tree diff (T4). Size is bounded by Artifacts limits only (1 GB/repo, 32 MB/blob).
- **Local folder.** The server cannot touch the agent's disk. Every terminal response (`end_attempt`, `wait`, `get_attempt`) carries `cleanup: "remove <dir>"`. A leftover folder is inert: the token expired and the remote is gone. Onboarding advises `.queenos/` in the global gitignore.

## 8. Data model

### 8.1 Contracts (`packages/queen-types/src/attempt.ts`)

| Schema | Fields |
|---|---|
| `AttemptIdSchema` | `att_` + 12 hex |
| `AgentIdSchema` | `ag_` + 32 hex |
| `AgentRoleSchema` | `"orchestrator" \| "worker"` |
| `McpAgentIdentitySchema` | `agentId, name: AgentHandle, model: ClaimedModel, role, owner: email` |
| `AttemptStateSchema` | `INTENT, READY, PUSHED, PASSED, REJECTED, WON, LOST, LANDED, ABANDONED, EXPIRED, ABORTED` |
| `AttemptIntentSchema` | `hive, owner, agent: McpAgentIdentity, target: {itemId} \| {goalId}` |
| `AttemptIntentDecisionSchema` | `accept {attemptId, trainId, repo, itemId, raceId?, expiresAt, base: {kind:"existing", baseRepo, baseSha} \| {kind:"create", baseRepo}}` \| `refuse {code, message, items?}` (`BASE_PENDING` is a refuse code) |
| `AttemptBaseReadySchema` | `hive, itemId, baseRepo` (actual name, may be `-rN`), `baseSha: Sha40` |
| `AttemptBaseFailedSchema` | `hive, itemId, baseRepo, reason ≤200` |
| `AttemptReadySchema` | `hive, attemptId, repo` (actual name, may be `-rN`), `baseSha: Sha40` (must equal the item's `base_sha`), `expiresAt` |
| `AttemptAbortedSchema` | `hive, attemptId, reason ≤200` |
| `AttemptPushedSchema` | `hive, attemptId, repo, before?, after: Sha40, title ≤120, message ≤4000` |
| `AttemptRefreshSchema` / `AttemptEndSchema` | `hive, attemptId, owner, agentId` |
| `AttemptSchema` | the row below, camelCase |

Helpers next to the train helpers: `attemptRepoName(hive, attemptId)` = `<hive>-att-<12hex>`, and `ATTEMPT_REPO_RE = /^(.+)-att-([0-9a-f]{12})(?:-r\d+)?$/` (the `-rN` suffix mirrors `TRAIN_REPO_RE` for the re-fork). Likewise `baseRepoName(hive, baseId)` = `<hive>-base-<12hex>` (`baseId` = 12 hex allocated by the Queen at intent) and `BASE_REPO_RE = /^(.+)-base-([0-9a-f]{12})(?:-r\d+)?$/`. Constants: `ATTEMPT_TOKEN_TTL_S = 7200`, `MAX_OPEN_ATTEMPTS_PER_AGENT = 3`, `WAIT_MAX_MS = 50_000`. `SubmitPromptSchema` gains `entryWindowMs?` (§6).

### 8.2 Queen schema migration v17

The Queen is at v16 (`submissions.agent`). v17:

```sql
CREATE TABLE attempts (
  attempt_id  TEXT PRIMARY KEY,           -- att_<12hex>
  hive        TEXT NOT NULL,
  item_id     TEXT NOT NULL,              -- moves to the follow-up item on a late push
  race_id     TEXT,                       -- set when the first push enters a race
  train_id    TEXT NOT NULL,              -- current train (first one reserved at intent)
  repo        TEXT NOT NULL,              -- <hive>-att-<12hex>[-rN]
  base_sha    TEXT,                       -- always equals the item's base_sha (shared by all attempts of the item)
  agent_id    TEXT NOT NULL,
  agent_name  TEXT NOT NULL,
  model       TEXT NOT NULL,              -- claimed, display only
  role        TEXT NOT NULL,
  owner       TEXT NOT NULL,              -- token owner email (caps key)
  state       TEXT NOT NULL,
  head_sha    TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL            -- token expiry; refresh_attempt extends it
);
CREATE INDEX attempts_agent ON attempts(agent_id, state);
CREATE INDEX attempts_owner ON attempts(owner, state);
CREATE INDEX attempts_item  ON attempts(item_id);
ALTER TABLE submissions  ADD COLUMN attempt_id TEXT;
ALTER TABLE merge_trains ADD COLUMN attempt_id TEXT;
-- race base (work_items is the items table): nullable; both NULL = no base yet
ALTER TABLE work_items ADD COLUMN base_repo TEXT;        -- <hive>-base-<12hex>[-rN]; set at intent (pending), cleared on delete
ALTER TABLE work_items ADD COLUMN base_sha  TEXT;        -- NULL while the base is pending; pinned by attemptBaseReady
```

`base_repo` set with `base_sha` NULL means base-pending. Both set means ready. When the base is deleted at resolution, `base_repo` is cleared and `base_sha` stays (history, `get_item`).

`submissions` rows from attempts use `origin_kind = "agent"`, `origin_id = owner` (so per-owner caps span all agents, as in v16), `agent = name`, `attempt_id`. `MergeTrain` gains optional `attemptId` (the dashboard candidate chip).

### 8.3 Queen RPCs

| RPC | Does |
|---|---|
| `attemptIntent(AttemptIntent)` | Validates the hive is external, the item accepts entries, caps; resolves the item's base (existing, create-and-mark-pending, or refuse `BASE_PENDING`); inserts INTENT; event `attempt.intent` |
| `attemptBaseReady({hive,itemId,baseRepo,baseSha})` | Pins `base_repo` (actual name) and `base_sha` on the item, clears pending; event `attempt.base.ready` |
| `attemptBaseFailed({hive,itemId,baseRepo,reason})` | Clears the pending `base_repo`; aborts the caller's INTENT; event (warn) |
| `attemptReady(AttemptReady)` | INTENT → READY; records repo; rejects a `baseSha` that differs from the item's; event `attempt.ready` |
| `attemptAborted(AttemptAborted)` | INTENT → ABORTED; event (warn) |
| `attemptPushed(AttemptPushed)` | Idempotent on `(repo, after)`. Ignores a push whose `after` is the base (nothing to submit). Files the submission, creates the train, supersedes, enters the race; READY/REJECTED/PUSHED → PUSHED |
| `attemptRefresh` | Owner and agent must match; non-terminal only; `expires_at = now + 2 h` |
| `attemptEnd` | Owner and agent must match; → ABANDONED (or no-op when boarded) |
| `getAttempt(attemptId)` | Row + current train phase, verdict, gate score, preview URL, race summary |
| `attemptsForItem(itemId)` | For `get_item` candidates (and the item's `base_sha`) |

"Accepts entries": item READY with wait reason "awaiting submissions", or an item whose race is RACING with `entryClosesAt` in the future (or not yet set). Anything else: `ITEM_NOT_ACCEPTING` with the item's status.

## 9. Push routing (gatekeepers)

`classifyPush` (apps/gatekeepers/src/event.ts) today ignores every repo that does not match `TRAIN_REPO_RE` (`not-a-train-fork`). It gains an attempt branch, checked after the namespace, notes-ref, branch and deletion checks:

| Repo | Ref | Result |
|---|---|---|
| `ATTEMPT_REPO_RE` match | `refs/heads/main` | `{action:"attempt", task:{hive, attemptId:"att_"+hex, repo, before, after, commits}}` |
| `ATTEMPT_REPO_RE` match | any other ref | `ignore` (`attempt-non-main`) |
| `BASE_REPO_RE` match | any | `ignore` (`base-repo`). Base repos are read-only so no push should arrive; `classifyPush` must still never route one as a train or attempt |
| `TRAIN_REPO_RE` match | branch | `gate` (unchanged) |
| other | | `ignore` (unchanged) |

`orchestrate.ts` sends an `attempt` classification to Queen `attemptPushed` over the existing `QUEEN` binding. Title and message come from the event's commit whose `id` equals `after` (else the last commit). If that commit is missing or `messageTruncated`, the gatekeeper reads it with `ARTIFACTS.get(repo).readCommit(after)`. `PushEvent` keeps the commits it already parses (today only `commitMessages`). Events are at-least-once and unordered (PROBE, discovery §1): the Queen's idempotency on `(repo, after)` and its ignore of a non-head `after` make replays harmless.

## 10. Caps

| Cap | Key | Default | Applies to |
|---|---|---|---|
| `maxInboxOpenPerContributor` | owner email | 3 (max 10) | Distinct open items the owner has an open attempt or open push on |
| `maxInboxPushesPerHour` | owner email | 20 (max 60) | Each `start_attempt` and each `attemptPushed` counts one |
| Open attempts per agent | agentId | 3 (`MAX_OPEN_ATTEMPTS_PER_AGENT`) | Non-terminal attempts across all hives; checked by `AgentIdentity`, re-checked per hive by the Queen |

Refusal: `CAP_EXCEEDED` with the cap name, the limit and when it frees up. For a 3-agent race the owner may raise `maxInboxPushesPerHour` via `PATCH /settings`.

## 11. Error handling

Tool errors are MCP results with `isError: true` and a JSON body `{code, message}` (message ≤ 200 chars, safe to show).

| Code | When |
|---|---|
| `NOT_INITIALIZED` | Any tool except `whoami`, `init_agent`, `resume_agent` before identity is bound ("call init_agent first") |
| `ALREADY_INITIALIZED` | `init_agent` on a bound session |
| `FORBIDDEN_ROLE` | `create_goal` from a worker |
| `FORBIDDEN_OWNER` | `resume_agent` or a session request from another owner; an own-only tool (§6) on an attempt that is not the session agent's (`pick` may name any candidate) |
| `HIVE_NOT_EXTERNAL` | `create_goal` or `start_attempt` on a swarm hive |
| `NOT_FOUND` | Unknown hive, item, goal, race or attempt |
| `INVALID_INPUT` | Schema failure (field names only, never values) |
| `ITEM_NOT_ACCEPTING` | Item not READY-awaiting-submissions and no open race entry window |
| `GOAL_AMBIGUOUS` | `goalId` with zero or several open children (lists them) |
| `CAP_EXCEEDED` | §10 |
| `BASE_PENDING` | Another first attempt is still creating the item's base. Retryable. The MCP Worker polls `attemptIntent` every 2 s for up to 30 s before returning it |
| `BASE_MOVED` | Fallback only (P5 failed): hive main moved past the item's `base_sha`, so no new attempt can share the base; the race closes entries early |
| `ARTIFACTS_UNAVAILABLE` | Base fork, attempt fork, readiness or token mint failed after retries; includes `cf-ray` when Artifacts returned one. The attempt is ABORTED and its fork deleted |
| `ATTEMPT_EXPIRED` | `refresh_attempt` / `end_attempt` / `pick` on a terminal attempt |
| `CONFLICT` | Queen 409s passed through (`pick` outside PICKING, `close_entries` already closed) |

Artifacts 503 handling reuses the existing code, for both the base fork and the attempt fork: `forkTrain` (fork with timeout, `get()` backoff on `FORK_IN_PROGRESS`, receive-pack readiness probe, up to 3 names `-r2`, `-r3`) and the read retry delays (2 / 4 / 6 s). `start_attempt` may take 5–40 s (first attempt of an item: two forks in sequence, up to ~80 s; a second concurrent caller waits on `BASE_PENDING`); the tool returns only when the fork is pushable or the attempt is aborted.

## 12. Security

| Topic | Rule |
|---|---|
| MCP credential | The `qgt_` token, Bearer header only. Never in a URL, never logged; the edge strips `authorization` before forwarding. Revoking it on the Push code page cuts off every session of that human. |
| Artifacts token | Minted per fork with `createToken("write", 7200)`. Scoped to that one repo (PROBE P1, load-bearing). Returned in the tool result (it will appear in the agent's transcript; accepted: one fork, 2 h). `queenos-mcp` never logs tool results. `refresh_attempt` mints a new token, then revokes the fork's other tokens (`listTokens` / `revokeToken`). Deleting the fork deletes all its tokens. |
| Base repo | `<hive>-base-<12hex>` is created `readOnly` and only `queenos-mcp` (server-side) and the Queen's Provisioner DELETE touch it. Agents never get a token for it; their attempt fork's token is scoped to the fork alone (P1, P5). |
| Clone config | Token in `http.extraHeader` in the clone's local `.git/config`, never in the remote URL, never a global helper. |
| agentId | A capability, but bound to its owner: useless without that owner's `qgt_` token. |
| Session | Each request's edge-derived owner must equal the session identity's owner. |
| Claimed model | Untrusted, display only. Never routes, never scores. |
| Origin | Edge-derived owner plus session-bound agent; commit trailers cannot override it (as for agent-bound git tokens, v16). |

| An agent can | An agent cannot |
|---|---|
| Read hive list, items, races, verdicts | Read or write any repo but its own attempt forks (P1); never the base repo (P5) |
| File goals (orchestrator) | Push to hive `main` or any train fork |
| Fork the item's frozen base into its own attempt, push it, rework it | Skip gates: every candidate passes the Queen-started gate, tree diff and reviewer (fails closed for non-drone origin) |
| Close entries and pick winners (any role) | Write verdict or review notes (synthesized from the ledger) |
| End its own attempts | Touch another agent's attempts, or another owner's agents |
| | Exceed per-owner caps or 3 open attempts |

The MCP Worker has the Artifacts binding for the whole `queenos` namespace; that power stays server-side, used only on `<hive>-att-*` and `<hive>-base-*` names the Queen allocated.

## 13. Risks and probes (FIRST TASKS)

Run these before building on them. Each is a short scratch Worker or `wrangler dev --remote` check, results recorded in this section.

| # | Probe | Why | If it fails |
|---|---|---|---|
| P1 | A token from `createToken("write", 7200)` on repo X cannot clone, fetch or push repo Y (same namespace), nor the hive repo | Load-bearing: the whole isolation claim (discovery Q3 never answered it) | Stop. Fall back to proxying attempt git through `queenos-git` with per-attempt credentials (re-plan with the user) |
| P2 | A push to `<hive>-att-<12hex>` main fires `cf.artifacts.repo.pushed` to the gatekeepers Workflow (filter `namespace: "queenos"`, no `repo_name`) with `commits[].id/message`, `before`, `after` | Routing depends on it; the payload shape is still UNVERIFIED in event.ts | Read the head with `readCommit(after)` (already the fallback); if no event at all, add a `submit_attempt` tool that calls `attemptPushed` after reading the fork head |
| P3 | `McpAgent.serve` over Streamable HTTP survives Claude Code's usage (initialize, session id header, reconnect, 50 s tool calls) and owner props from the edge reach the DO per request | Identity and `wait` depend on it | Pass owner via a forwarded header read in `onRequest`; shorten `wait` to 25 s |
| P4 | Fork readiness and 503 behaviour for attempt forks (time to pushable, `-rN` frequency); a fork kept 2 h stays pushable | `start_attempt` latency and reliability | Raise the readiness budget; surface `ARTIFACTS_UNAVAILABLE` with `cf-ray` |
| P5 | Forking from a fork works, including from a `readOnly` fork (`fork(name, { readOnly: true, defaultBranchOnly: true })` of hive main, then an attempt fork of that); the child's token cannot write the base repo (ties to P1); the child is writable and its base commit equals the base's head | Load-bearing for "every candidate starts from the same commit" | Fallback: record `base_sha` at the first attempt; later attempts fork hive main; `attemptIntent` refuses (`BASE_MOVED`) once hive main has moved past `base_sha`, so the race closes entries early. No base repo, no base cleanup |

Other risks:

- **Herald previews read the fork's head.** A re-push during a preview deploy may preview newer code under the older train; the older train is superseded anyway. Accepted.
- **Fork cost.** Forks are probably full copies (discovery §1). One per attempt plus one base per item, deleted on resolution; per-agent and per-owner caps bound the count. The base adds one extra copy per active item.
- **Leaked attempt token** gives 2 h of write to one fork whose pushes all still go through the gate. Same blast radius as a bad push.
- **Late push after entry close** files a follow-up item, not a candidate. `get_item` returns `entryClosesAt` so agents can see it.

## 14. Agent onboarding

The template `templates/worker-starter/AGENTS.md` and the plugin skill (`plugins/queenos/skills/`, a new `queenos-mcp` skill next to `queenos-inbox`) document the procedure:

1. Connect: `claude mcp add --transport http queenos https://queenos.kaikeru.com/mcp --header "Authorization: Bearer $QUEENOS_TOKEN"` (the human mints the token on the Push code page; never paste it into chat).
2. `init_agent(name, model, role)`. Keep the `agentId`; after a reconnect, `resume_agent(agentId)`.
3. Orchestrator: `create_goal`, hand `goalId`/`itemId` to workers.
4. Worker: `start_attempt({hive, itemId})`, run `cloneCommand` then `configCommand`.
5. Commit, `git push origin main`.
6. `wait({attemptId, until:"verdict"})` in a loop until `changed:true`; `get_verdict` on REJECTED.
7. Rework: commit, push `main` again (`refresh_attempt` first if the token is near expiry).
8. On a terminal state or when done: `end_attempt`, then `rm -rf <dir>`. Add `.queenos/` to the global gitignore.

These docs, `docs/agent-protocol.md` (new "MCP path" section) and the README must be updated in the docs task (§16).

## 15. Testing

| Package | Tests |
|---|---|
| `apps/mcp` (vitest-pool-workers) | Every tool with a fake Artifacts binding and a fake Queen: first attempt forks hive main into `-base-` (readOnly) then the attempt from the base; later attempts fork the base repo, never hive main; `BASE_PENDING` polled then surfaced; base fork failure → `attemptBaseFailed`; init/resume/whoami, `NOT_INITIALIZED`, `FORBIDDEN_ROLE`, `FORBIDDEN_OWNER` (owner mismatch on resume and on a session), `GOAL_AMBIGUOUS`, fork failure → `attemptAborted` + delete, `ARTIFACTS_UNAVAILABLE` carries `cf-ray`, refresh revokes old tokens, `wait` timeout returns `changed:false`, clone/config commands never put the token in a URL |
| `apps/queen` | Migration v17 from a v16 fixture; attempt ledger: intent caps (owner and agent), item-not-accepting, ready/aborted, pushed creates train with the fork as repo, re-push supersedes unboarded only, late push → follow-up, REJECTED → rework, watchdog EXPIRED, end on a boarded attempt is a no-op, terminal → exactly one fork DELETE, train teardown never deletes an attempt fork, idempotent `attemptPushed`, claimed model never reaches `model_stats`; `submitWork` `entryWindowMs`; base: a single base under concurrent first intents (second gets `BASE_PENDING`), all attempts of an item share one `base_sha`, `attemptBaseFailed` frees the slot, base deleted exactly once at resolution (decided + all attempts terminal) and on cancel, a follow-up item gets a new base, main advancing after pinning does not affect attempts |
| `apps/gatekeepers` | `classifyPush`: attempt main → `attempt`, attempt other ref → ignore, `-rN` suffix, train forks unchanged; pushes to `-base-` repos (incl. `-rN`) are ignored and never routed as train or attempt; orchestrate calls `attemptPushed` and the `readCommit` fallback |
| `apps/edge` | `/mcp`: no token 401, bad token 401 + fail counter, 429 when blocked, read-only token 403, header stripping (client `x-queen-user`, `x-queen-token-id`, `x-queen-agent*`, `authorization`), agent binding ignored, route runs before Access |
| `packages/queen-types` | New schemas, `attemptRepoName` ↔ `ATTEMPT_REPO_RE` and `baseRepoName` ↔ `BASE_REPO_RE` round trips (the two regexes never match each other's names) |
| dashboard | Candidate chip renders attempt id and "claims <model>" |

Per package: its tests and `tsc -p test`. Then the full gate `pnpm turbo run build typecheck lint test --force --continue` (turbo concurrency 4). Then a live probe: one Claude Code session on hive `demo` (external) runs the §14 procedure end to end; a second session races it; the human picks.

## 16. Build order

The user's rule holds: **one task at a time**; finish (verify, full gate, commit, push), then ask before the next. Disjoint files per agent; contracts first; one lockfile writer.

| # | Task | Files | Agent |
|---|---|---|---|
| 0 | Probes P1–P5 (§13), record results here | scratch Workers only | Sonnet |
| 1 | Contracts: `attempt.ts`, `SubmitPromptSchema.entryWindowMs`, `MergeTrain.attemptId`, constants, repo helpers | `packages/queen-types` | Sonnet |
| 2 | Queen attempt RPCs, migration v17, watchdog, fork ownership, race entry and supersede by attempt, `entryWindowMs` | `apps/queen` | **Opus** |
| 3 | Gatekeepers routing: `classifyPush` attempt branch, `orchestrate.ts` → `attemptPushed`, `readCommit` fallback | `apps/gatekeepers` | Sonnet |
| 4 | `apps/mcp`: Worker, `QueenMcp`, `AgentIdentity`, tools, `wait`; move `forkTrain` and its helpers from `apps/git/src/upstream.ts` into `packages/hive-kit` (pure move, `apps/git` behaviour and tests unchanged); one lockfile writer adds the deps | `apps/mcp`, `packages/hive-kit`, `apps/git` imports | Sonnet (Opus review of the session/identity code) |
| 5 | Edge `/mcp` route, `authGitToken` returns `id`, `MCP` service binding | `apps/edge` | Sonnet |
| 6 | Dashboard: candidates show attempt id and agent (minimal) | `apps/dashboard` | Sonnet |
| 7 | Docs: template `AGENTS.md`, plugin `queenos-mcp` skill, `docs/agent-protocol.md`, README, HANDOFF | docs, templates, plugins | Haiku (Sonnet if the skill needs judgement) |
| 8 | Deploy (USER): `queen`, `queenos-gatekeepers`, `queenos-mcp`, `queenos-edge`, in that order; then the Access Bypass app for `/mcp` | wrangler | User |

Deploy order reason: the Queen must understand `attemptPushed` before gatekeepers routes to it; `queenos-mcp` must exist before the edge binds it; the Bypass app last, so `/mcp` is never open before the edge enforces tokens.

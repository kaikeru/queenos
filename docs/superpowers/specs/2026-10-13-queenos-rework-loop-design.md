# QueenOS rework loop: the same attempt fixes its own rejection

Status: Draft, approved design 2026-10-13. Every section below was approved with the user; the implementation plan fills in code-level detail only.
Builds on: `docs/superpowers/specs/2026-10-12-queenos-mcp-design.md` (the MCP spec: attempts, race base, verdict kinds, error contract).
Supersedes: for external hives, the T9b section of `docs/human-push-design.md` (§10.4 "Manual reject", lines 555-565). Swarm hives keep T9b as written (§7.3).

Anything listed in §13 (Open checks) has not been verified against the real account or the installed packages; the plan runs those checks first.

---

## 1. Summary

When an attempt is rejected while its item is still open (gate findings, a merge conflict in the train, or a human's reject), the **same attempt** gets a **rework slot**: a deadline by which it may fix and push again, as the same candidate. A new MCP tool `sync_base` lets the agent fetch the hive's current `main` and rebase, which is impossible today. A new MCP tool `reject` (and dashboard buttons) lets a judge send candidates back with an actionable reason. When a slot runs out, the agent gives up, or a cap is hit, the race is abandoned and the item reopens to any agent from a fresh base.

## 2. Problem (verified 2026-10-13)

1. **A conflicting winner is stranded.** A race winner whose merge conflicts in the train is failed with `cause: "conflict"`. `Planner.fail()` skips the race path when a cause is set (`apps/queen/src/train/planner.ts:2096`), and the contributed branch runs: `ejectKeepingFork` + `awaitContributor` (planner.ts:2100-2105, 2121-2127). The conflict comes from `mergeResult` (`apps/queen/src/train/queue.ts:405-421`, summary from `conflictSummary` at queue.ts:382). Result: train EJECTED with `raceOutcome` still WON; attempt REJECTED (`attemptStateOf`, `apps/queen/src/work/attempts.ts:109-115`); race stays DECIDED; item FAILED "awaiting contributor". No drone rework: attempts exist only on external hives, where `handoffOf` is always false (planner.ts:2115-2118) and `rework()` short-circuits (planner.ts:2171-2175).
2. **The agent cannot rebase.** The race base is `forkRepo(hive, "main", {readOnly})` and the attempt fork is `forkRepo(base, "main")` (`apps/mcp/src/start.ts:74`, `:108`), both `defaultBranchOnly` (`packages/hive-kit/src/artifacts.ts:132`). The attempt token writes the attempt fork only, and `origin` is that fork, not the git proxy. `git fetch origin && git rebase origin/main` is a no-op. The only (undocumented) way out is `end_attempt` + `start_attempt` after the base is released (`releaseBases`, `apps/queen/src/queen-node.ts:1646-1689`).
3. **The verdict lies.** `attemptVerdict` (`apps/queen/src/work/attempts.ts:71-77`) tests `raceOutcome === "WON"` before `phase === "EJECTED"`, so the conflicting winner reads `verdict: "passed"`, `kind: null`, `findings: []`, `next: null`. Only the note says `REJECTED (CONFLICT)`, with the body "Rebase on origin/main and push the branch again, or hand off." (`apps/queen/src/work/notes.ts:228-238`): both impossible for an attempt.
4. **A re-push opens a second race.** The winner's re-push finds the item FAILED with no RACING race and its previous train inactive and no longer in a car, so intake reopens the item and asks for a new width-1 race (`apps/queen/src/work/inbox.ts:409-440`; created at planner.ts:1035-1064), which waits out a fresh entry window. The old DECIDED race keeps `winnerTrainId` pointing at a train that never landed.
5. **No grace for a rejected candidate mid-race.** A candidate rejected by findings gets `raceOutcome: "FAILED"` (`raceCandidateFailed`, planner.ts:2433-2439). Its fix push rejoins the race only before `entryClosesAt`; after that intake files a "(follow-up)" item (`lateReason`, inbox.ts:207-216; `followUp`, inbox.ts:383-393; the planner's defensive guard, planner.ts:1025-1026). `maybeDecide` decides or abandons as soon as nothing is RACING (planner.ts:2446-2484, `abandonRace` 2486-2500).
6. **No caps, and an early expiry.** `maxConflictReworks` is checked only inside `rework()` (planner.ts:2177-2182), which attempts never reach; reopen-by-push is uncapped. `expires_at` (2 h from READY, `ATTEMPT_TOKEN_TTL_S`) is not extended by pushes, and the watchdog expires REJECTED attempts past it (`attemptWatchdog` / `dueAttempts`, queen-node.ts:1579-1613): a winner that conflicts late can expire at once.
7. **Reject-with-reason is half built.** Present: `RejectRaceSchema {trainId | "all", reason 1..300}` (`packages/queen-types/src/work.ts:344-349`), `RaceRejectionSchema` and `Race.rejections` (work.ts:295-301, 333), the `races.rejections` column (`apps/queen/src/db.ts:477`), and the dashboard's display of a rejection (`apps/dashboard/src/raceLogic.ts:86-111`, `RacePick.tsx:90,112`). Missing: planner, RPC, route, MCP tool, buttons. The pick path to mirror: `apps/queen/src/train/pick.ts`, `Planner.pick` (planner.ts:2611-2655), `QueenNode.pick` (queen-node.ts:745), `POST /hives/:hive/races/:raceId/pick` (`apps/queen/src/index.ts:177`), MCP `pick` (`apps/mcp/src/tools.ts:410-423`).

## 3. Goals and non-goals

| Goals | Non-goals |
|---|---|
| A rejected attempt fixes and re-pushes as the same candidate, in the same race | Drone rework on external hives (never the swarm) |
| An attempt can bring hive `main` into its clone and rebase (`sync_base`) | Server-side rebase or merge on the agent's behalf |
| A conflicting winner re-boards the train without a new race or entry window | Changing the item's shared race base mid-race |
| Judges reject with a reason, over MCP and the dashboard | Reject for auto-judged races (repick covers a decided winner before boarding) |
| Bounded: per-attempt, per-race and time caps; a clean fallback that reopens the item | Changing `maxConflictReworks` or swarm rework |
| Verdicts and notes that tell the agent what it can actually do | Changing the human git-proxy path (its notes and intake stay as they are) |

## 4. The rule (§A)

While an item is open, any rejection of an attempt's head (gate findings, a merge conflict, an integration-gate failure in the train, a human reject) gives **that attempt** a rework slot:

```
rework = { reason: "findings" | "conflict" | "human", dueAt, round }
```

- `dueAt = now + reworkWindowMs` (default 30 min). `round` = the attempt's rework count after this one (1-based).
- Infra failures do **not** use a slot. They keep the automatic same-head re-gate (v18: `gate_infra_rounds`, `GateCommand.notBefore`) and the manual `retry_gates` (`attemptRegate`).
- Slots apply to attempts only (trains with an `attempt_id`). Swarm trains and human git-proxy trains keep today's behaviour.
- **Fallback**, when a slot expires, the agent calls `end_attempt`, or a cap is hit, and no other candidate of the race can still win: the race becomes ABANDONED and the item reopens to **any** agent over MCP (never the swarm), from a fresh base (§5.6). If another candidate can still win, only this candidate drops out (FAILED / LOST) and the race decides normally.

## 5. States and deadlines (§B)

### 5.1 Attempt

- State stays REJECTED while a slot is open. The row gains `rework {reason, dueAt, round}`; the views (`get_attempt`, `list_attempts`, `wait`, `get_item` candidates) carry it.
- Opening a slot sets `expires_at := max(expires_at, dueAt + 10 min)`. `refresh_attempt` still renews the token; with a slot open it sets `expires_at := max(now + 2 h, dueAt + 10 min)`, never shorter.
- A push inside the slot **closes** it (`rework` cleared, `reworks` kept) and the new head is gated as the **same candidate** (§5.2, §5.3). A second push before that head's verdict supersedes it in place, as any re-push of an unboarded train does, and stays the same candidate (never a follow-up).
- A push after `dueAt` is a late push: the item has already reopened to everyone (§5.6), so it goes through normal intake like any other agent's push (a new entry of whatever race the item now has, counted against the usual caps). It is never the old slot's candidate.
- The watchdog does not expire a REJECTED attempt while its slot is open (guaranteed by `expires_at >= dueAt + 10 min`). Slot expiry itself is a Queen deadline at `dueAt` (the alarm's next-deadline set gains every open slot's `dueAt`).

### 5.2 Candidate in a RACING race

- A candidate rejected by gate findings gets `raceOutcome: "REWORK"` (new value) instead of FAILED, when its attempt still has a slot to give (§5.5). Its train is EJECTED as today; the attempt fork is the attempt's and is never deleted by the train.
- `maybeDecide` treats a REWORK candidate as **pending until its `dueAt`** (like a RACING one), even though its train is no longer active.
- When another candidate has passed, the hold is capped. The cap depends on where the REWORK came from:
  - **From gate findings:** the candidate holds the race until `min(dueAt, graceStart + reworkHoldMs)`. `graceStart` is the moment the grace clock measures from: the first pass, or entry close if that is later. `reworkHoldMs` defaults to 10 min (§5.5).
  - **From a human reject-one (§7.2):** the candidate holds the race until its `dueAt`, because the judge chose to wait.
  - `raceGraceMs` (default 90 s) keeps its role for RACING (still-running) candidates only.
  - The race decides once every candidate's hold has passed. A REWORK candidate still without a push then loses (LOST, "still in rework at the race deadline"), and its slot closes. If the race goes to PICKING, `enterPicking` ends REWORK candidates the same way it ends RACING ones.
- The fix push **rejoins its own race even after `entryClosesAt`**: same candidate, not a new entry, never a follow-up. Mechanism: the existing `rejoin` path that `attemptRegate` uses (`enterAttemptHead(..., rejoinRaceId)`, planner `pushed({rejoin: true})`). The old REWORK train becomes FAILED when its slot closes by a push (it is no longer pending).
- At `dueAt` with no push: REWORK becomes FAILED, the slot closes, and `maybeDecide` runs (decide, PICKING, or `abandonRace`, which is the fallback when nothing passed).

### 5.3 Winner rejected in the train: race REWORKING

- When a race winner (an attempt's train with `raceOutcome: "WON"`) is ejected from its car by a merge conflict (`cause: "conflict"`, reason `conflict`) or an integration-gate failure (`cause: "integration"`, reason `findings`), and its attempt has a slot to give:
  - the train's `raceOutcome` becomes REWORK (not left at WON);
  - the race goes DECIDED → **REWORKING** (new state); `winnerTrainId` keeps the old train until a new winner exists;
  - the item stays ACTIVE with wait reason `awaiting rework (attempt <id>, due <time>)`, not FAILED. It takes no new attempts (`ITEM_NOT_ACCEPTING`) and other correlated pushes get today's "already being built" follow-up;
  - `awaitContributor` is not called.
- Only the winner's attempt may push. Its push **bypasses intake**: no new race, no entry window. The new train is attached to the same race (appended to `trainIds`) and goes through the usual preview, gate and reviewer (gates are never skipped). On PASS it becomes the winner: `raceOutcome: "WON"`, a queue ticket, `winnerTrainId` = the new train, race back to DECIDED. It then boards and lands normally.
- If the rebased head is rejected again (findings or another conflict) and a slot is left, the race stays REWORKING with the next round. Infra on the rebased head uses the infra path, as everywhere.
- Slot expiry, `end_attempt`, or the per-attempt cap → fallback (§5.6). The old winner train ends FAILED.
- A REWORKING race counts as open for `releaseBases` (like RACING / PICKING) until it resolves.

### 5.4 Human reject while PICKING

- Reject **one**: that candidate gets a slot (reason `human`); the race drops back to RACING (§7.2).
- Reject **all**: race back to RACING, every live candidate a slot (§7.2).
- Each PICKING → RACING drop (one or all) uses one of the race's reopens (max `maxRaceReopens`, default 3).

### 5.5 Guardrails

New optional per-hive guardrails (`GUARDRAIL_FIELDS`, defaulted on parse like the post-v2 caps, overridable with `PATCH /settings`, clamped to `GUARDRAIL_MAX`):

| Guardrail | Default | Bounds | Meaning |
|---|---|---|---|
| `reworkWindowMs` | 1 800 000 (30 min) | 60 000 .. 7 200 000 | Length of a rework slot; also the reopened entry window after reject-all |
| `reworkHoldMs` | 600 000 (10 min) | 60 000 .. 3 600 000 | How long a findings-REWORK candidate holds a race after another candidate has passed. The hold runs to `min(dueAt, graceStart + reworkHoldMs)`, where `graceStart` is the first pass or entry close, as the grace clock uses. It does not apply to a human reject-one, which holds until `dueAt` |
| `maxReworksPerAttempt` | 3 | 0 .. 5 | Slots one attempt may get. Findings, conflicts and human rejects share the count. 0 = no slots (fallback at once) |
| `maxRaceReopens` | 3 | 0 .. 5 | PICKING → RACING drops per race (reject one or all) |

"A slot to give" means `reworks < maxReworksPerAttempt` and the item open. Without one, the rejection is handled as today for the candidate (FAILED / LOST) and, where it was the race's last hope (a REWORKING winner, an all-failed race), the fallback runs. The existing `maxConflictReworks` stays for swarm items only.

### 5.6 Fallback

1. Race → ABANDONED (reason names the cause: slot expired, ended by the agent, cap reached). Any REWORK candidate → FAILED; open slots in that race close.
2. Item → FAILED "awaiting contributor", which `acceptsEntries` already opens to any agent's `start_attempt` (attempts.ts:32-37). External hives only; no `rework()`, no drones.
3. Fresh base: the item's base is released as soon as no attempt of the item is INTENT and no race of the item is RACING / PICKING / REWORKING. A REJECTED attempt whose slot has closed never forks from the base again, so it does not hold it (the existing rule waits for every non-terminal attempt; this narrows it for fallback only). The next `start_attempt` forks a new base from current `main`.
4. The slot-holder's attempt stays REJECTED (slot closed) until its `expires_at`, then the watchdog expires it as today. A push in that window is a late push (§5.1).

### 5.7 Lifecycle additions

| Transition | Trigger |
|---|---|
| REJECTED + slot opened | Findings, conflict, integration failure or human reject while the item is open and a slot is left |
| REJECTED (slot) → PUSHED | Push before `dueAt`: same candidate (rejoin, or REWORKING boarding) |
| REJECTED (slot) → REJECTED (no slot) | `dueAt` passed: candidate FAILED; fallback if nothing else can win |
| REJECTED (slot) → ABANDONED | `end_attempt`; fallback if nothing else can win |
| race DECIDED → REWORKING | Winner ejected from its car (conflict / integration) with a slot |
| race REWORKING → DECIDED | The winner's rebased head passed its gate |
| race REWORKING → ABANDONED | Fallback |
| race PICKING → RACING | `reject` one or all, within `maxRaceReopens` |

## 6. `sync_base` (§C)

### 6.1 Tool

`sync_base({attemptId})` → `{baseSha, syncCommand, next}`. Own attempts only (like `retry_gates`), any role, any agent; it may be called proactively (before a first push, to start from a newer `main`).

- **Allowed:** READY (no push yet) and REJECTED with an open slot. PUSHED, PASSED, WON and REJECTED without a slot → `CONFLICT` (not retryable).
- **Base:** the hive's current `main` sha, read from Artifacts (not from the Queen's landed-sha records), becomes the attempt's `base_sha`. The gates and the reviewer diff the next push against it (`enterAttemptHead` already passes `a.baseSha` as the train's `baseSha`). The item's shared base fork and `work_items.base_sha` are untouched.
- **Flow** (`queenos-mcp` is the executor; the Queen has no Artifacts binding, see `apps/queen/wrangler.jsonc`):
  1. `getAttempt`: owner, agent and state pre-check (fails fast without minting anything).
  2. Mint a **read** token on the hive repo, 30 min (`createToken("read", 1800)`), read the repo's remote and `main` head sha.
  3. Build `syncCommand` (validated with the same remote/token format checks as `setupCommand`) **before** telling the Queen.
  4. Queen `attemptSyncBase({hive, attemptId, owner, agentId, baseSha})`: re-checks the state, records `base_sha`, event `attempt.state` (`syncBase`). On refusal the MCP Worker revokes the read token and returns the error.
- **`syncCommand`**, one `&&` chain, every argument POSIX single-quoted, the token appearing only here:
  1. `(git -C <dir> remote remove queen || true)` (a rerun), then `git -C <dir> remote add queen <hiveRemote>`;
  2. `git -C <dir> config --local --replace-all http.<hiveRemote>.extraHeader 'Authorization: Bearer <readToken>'`;
  3. `git -C <dir> fetch queen +main:refs/remotes/queen/main` (fetch only; the rebase is the agent's job);
  4. verify `git -C <dir> rev-parse refs/remotes/queen/main` equals `baseSha`, else fail loudly: `main moved; call sync_base again`.
  The `queen` remote is read-only (read token, no push refspec); the token expires in 30 min and each call rotates it (`--replace-all`).
- **`next`:** "Rebase onto queen/main (`git -C <dir> rebase queen/main`), resolve conflicts keeping both behaviours, run the tests, then `git -C <dir> push --force-with-lease origin HEAD:main`."
- **Force push** to the attempt fork is expected. The Queen's `before_sha` ordering (queen-node.ts:1240-1255) treats the force-pushed head as the newest submission; a force push's `before` is the old head, so nothing is mistaken for a stale replay. (Accepted by Artifacts: open check.)
- **Push without `sync_base`:** gated against the old `base_sha`, as today. For a conflict slot the verdict's `next` and the note still point to `sync_base`.

### 6.2 Verdict fix

- `attemptVerdict`: phase EJECTED is tested before `raceOutcome` WON / PASSED; `raceOutcome: "REWORK"` is `rejected`. The conflicted winner reads `verdict: "rejected"`.
- `AttemptVerdictKindSchema` becomes `findings | infra | conflict | human`. `conflict`: the train carries a `conflict` (`MergeConflict`). `human`: the slot's reason is `human`. Otherwise `infra` / `findings` as today.
- `get_verdict` for `conflict`: `findings` = the conflicting paths (one per line, from `train.conflict.paths`, else its summary); `rework` = the slot `{reason, dueAt, round}`; `next` = "call sync_base, rebase onto queen/main, push again before <dueAt>".
- `get_verdict` for `findings` with a slot: `next` = "fix and push before <dueAt>". For `human`: §7.4. Without a slot (cap reached, slot expired): `next` = null and the note says the item reopened.
- Note body (`notes.ts`, the conflict branch) for **attempt** trains: drops "or hand off" and "Rebase on origin/main"; says "Call sync_base, rebase onto queen/main and push again before <dueAt>." Human git-proxy trains keep today's text.
- `wait({until: "verdict"})` returns when a new slot opens (the attempt goes WON → REJECTED or PASSED → REJECTED, or REJECTED gains a new round).

## 7. Reject with reason (§D)

### 7.1 Scope

Only for **PICKING** races (human-judged, ≥ 2 passes). Auto-judged races do not need it; `pick`'s re-pick covers a decided winner before it boards.

### 7.2 External hives

- **Reject one** (`trainId`): the candidate gets a slot (reason `human`; the reason text becomes its finding, attributed to the rejecter: `rejected by <email>: <reason>`), `raceOutcome: "REWORK"`, its preview torn down, fork kept. The race drops to RACING and holds until the slot's `dueAt` (the human hold of §5.2, not `reworkHoldMs` or `raceGraceMs`), unless the candidate pushes sooner. Normal decide logic then applies: the rejected candidate is pending until its `dueAt` or its fix's verdict, and the remaining passes wait. When it settles: ≥ 2 passes → PICKING again (a new `pickDeadlineAt`); 1 pass → it wins as `queen:single`; none → fallback.
- **Reject all** (`"all"`): every live candidate gets a slot; race → RACING; the entry window reopens (`entryClosesAt = now + reworkWindowMs`, so new agents may enter); `pickDeadlineAt` and `deadlineAt` cleared (no auto-pick, no pass left to time).
- Each drop uses one reopen. Past `maxRaceReopens`: reject-all → fallback (race ABANDONED, item reopens to any agent from a fresh base), and the response says so (`fallback: true`); reject-one → no slot, the candidate is LOST and the race stays PICKING (one pass left → `queen:single`).
- A candidate with no slot left (per-attempt cap) is LOST instead of REWORK.

### 7.3 Swarm hives

T9b as written (human-push-design §10.4): one → that candidate LOST (EJECTED, fork and preview cleaned up), reason recorded as a REVIEWER finding; one passed candidate left → `queen:single`; none → "none of these". All → race ABANDONED and `rework()` with the Scribe summary `Human rejected all candidates: <reasons>` (≤ 500), attempts + 1, within `maxReworks`. Reopens are not used.

### 7.4 Contract

- Reason: required, 1..300 chars (`RejectRaceSchema`). Stored in `races.rejections` (`{trainId, by: "human:<email>", reason}`, at most 16). Event `race.rejected {raceId, trainId | "all", by, reason, model}` per rejected candidate.
- Queen RPC `rejectRace({hive, raceId, user, reject: {trainId | "all", reason}})`, shaped and authorised like `pick` (`by = human:<user>`). Only in PICKING, else `CONFLICT`; unknown race `NOT_FOUND`; `trainId` not a live passed candidate `CONFLICT`. Returns `{outcome, race, fallback}`.
- HTTP `POST /hives/:hive/races/:raceId/reject` (user route; through the edge exactly like `/pick`).
- MCP tool `reject({hive, itemId, target: attemptId | "all", reason})`, same role and owner rules as `pick` (any role, any candidate; the session owner must match). It resolves the item's PICKING race and the attempt's current `trainId`. Returns `{outcome, race: {raceId, state, reopens}, fallback}`. Description: "Send candidates of a race you are judging back for rework, with a reason the agent can act on (what is wrong and what you expect instead)."
- Dashboard: a **Reject** button on each candidate card and **Reject all** on the race panel, each opening an inline reason box (textarea, Send, Cancel; no browser dialog). Send is disabled until a reason is typed. 409 shows the race's current state. REWORKING races and REWORK candidates render with their due time.
- Agent side: `wait` returns; `get_verdict` has `kind: "human"`, the reason as the finding, `rework.dueAt`, `next` = "address the reviewer's reason, push again before <dueAt>".

## 8. Guidance (§E)

Docs and tool descriptions only, no code beyond descriptions.

- `create_goal` description: a goal is a work spec (like a ticket): write it for whoever picks it up, with the outcome, acceptance criteria and constraints; its items are the units of work.
- `start_attempt`, `wait`, `get_verdict` descriptions explain the loop: a rejection may come with a rework slot; fix (for a conflict: `sync_base`, rebase) and push again before `dueAt`. `sync_base` and `reject` get their own descriptions (§6.1, §7.4).
- `plugins/queenos/skills/queenos-mcp/SKILL.md`: orchestrator section (goals as work specs, judging, rejecting with an actionable reason) and a rework-loop section.
- `templates/worker-starter/AGENTS.md`: the rework loop and `sync_base`.
- `docs/agent-protocol.md` §8: tools table (`sync_base`, `reject`), verdict kinds (`conflict`, `human`), state lists gain REWORK (candidate) and REWORKING (race), the `rework` field.
- MCP spec: an amendments note pointing here (tool count 19, verdict kinds, `sync_base`).
- `docs/HANDOFF.md`: milestone entry.

## 9. Errors (§F)

Existing contract (MCP spec §11): `{code, message, retryable, retryAfterMs?}`.

| Tool | Code | Retryable | When |
|---|---|---|---|
| `sync_base` | `CONFLICT` | no | Attempt not READY and not REJECTED with an open slot |
| `sync_base` | `ATTEMPT_EXPIRED` | no | Terminal attempt |
| `sync_base` | `ARTIFACTS_UNAVAILABLE` | yes (5 s) | Read token, remote or `main` read failed, or an unexpected remote/token format |
| `sync_base` | `UNAVAILABLE` | no | Queen without `attemptSyncBase`: "sync_base needs a newer Queen" |
| `sync_base` | `FORBIDDEN_OWNER`, `NOT_FOUND` | no | As every own-only tool |
| `reject` | `CONFLICT` | no | Item has no PICKING race; target not a live passed candidate |
| `reject` | `INVALID_INPUT` | no | Reason empty or over 300 chars |
| `reject` | `FORBIDDEN_ROLE`, `FORBIDDEN_OWNER` | no | As `pick` (in practice only a session-owner mismatch) |
| `reject` | `NOT_FOUND` | no | Unknown hive, item or attempt |
| `reject` | `UNAVAILABLE` | no | Queen without `rejectRace` |

A push after a slot's `dueAt` is not an error: it is a late push (§5.1).

## 10. Storage (§G): migration v19

```sql
-- v19: rework loop. An open slot is rework_due_at NOT NULL.
ALTER TABLE attempts ADD COLUMN rework_reason TEXT;               -- findings | conflict | human; NULL = no open slot
ALTER TABLE attempts ADD COLUMN rework_due_at INTEGER;            -- epoch ms
ALTER TABLE attempts ADD COLUMN reworks INTEGER NOT NULL DEFAULT 0; -- slots given (round of the current one)
ALTER TABLE races ADD COLUMN reopens INTEGER NOT NULL DEFAULT 0;  -- PICKING → RACING drops
```

- `attempts.base_sha` (v17) becomes updatable by `attemptSyncBase`; its comment no longer says "always equals the item's".
- `races.state` gains `REWORKING`; `merge_trains.race_outcome` gains `REWORK` (both TEXT; no DDL).
- `packages/queen-types`: `RaceStateSchema` + `REWORKING`; `RaceOutcomeSchema` + `REWORK`; `AttemptVerdictKindSchema` + `conflict`, `human`; `AttemptSchema` and attempt views gain optional `rework {reason, dueAt, round}`; `RaceSchema` gains optional `reopens`; guardrails §5.5; `AttemptSyncBaseSchema`; `SyncBaseResult`.
- Back-compatible: every new field is optional; old rows read as "no slot, 0 reopens". Deploy order: Queen first, then `queenos-mcp`, then the edge (dashboard). An older MCP or dashboard never sees the new values until the Queen produces them; both must treat an unknown verdict kind or race state as opaque (no crash).

## 11. Testing (§H)

| Area | Tests |
|---|---|
| Planner | A REWORK candidate holds the race until `dueAt`; its fix rejoins after entry close (no follow-up); a second push in the slot supersedes in place; with another candidate passed, a findings-REWORK hold ends at `graceStart + reworkHoldMs` (10 min) when that is before `dueAt`, and the race then decides without it; with another candidate passed, a human reject-one REWORK holds the race until its `dueAt` (not 90 s, not 10 min); a RACING candidate is still capped by `raceGraceMs`; slot expiry → FAILED → decide / abandon; winner conflict → REWORKING → rebased push gated → WON → LANDED; integration failure of a winner → REWORKING (findings); REWORKING slot expiry → ABANDONED + item FAILED + base release; per-attempt cap (findings, conflicts, human share it); per-race reopen cap; reject one / all on external (RACING, reopened window, cancelled auto-pick, `queen:single`) and swarm (T9b) hives |
| Queen | `attemptSyncBase` state rules and `base_sha` update; the next push's train diffs against the synced base; `attemptVerdict` / `attemptVerdictKind` fix (conflicted winner = rejected / conflict); `expires_at` extension on slot open and on refresh; watchdog leaves a slot alone; slot deadline in the alarm; `rejectRace` RPC and route (409, 404); migration v19 from a v18 fixture; note body for attempt conflicts |
| MCP | `sync_base`: quoting and validation, token appears once (only in `syncCommand`), sha check line present, read token revoked on a Queen refusal, error codes; `reject` tool resolution of race and train, errors; `get_verdict` `kind`/`next`/`rework` for conflict, human and findings-with-slot |
| Dashboard | Reason box gates Send; Reject / Reject all render only in PICKING; REWORKING / REWORK rendering |
| Sim mode | A conflict + rework scenario (`dev:sim`): two goals on one file, the second winner conflicts, reworks, lands |
| Live, after deploy (Herdr workers) | (1) two goals editing the same file: the second winner conflicts, `sync_base`, rebase, lands; (2) a deliberate lint failure fixed mid-race after entry close; (3) reject-all with a reason in a you-pick race |

Per package: its tests and `tsc -p test`; then the full gate `pnpm turbo run build typecheck lint test --force --continue`.

## 12. Review focus (§I)

- A slot's `dueAt` passes while the fix is mid-gate: the push closed the slot, so the fix stands (no expiry fires).
- Holds (§5.2): the alarm's deadline set must include each findings-REWORK hold end (`graceStart + reworkHoldMs`) as well as `dueAt`. A human-reject hold must not be cut short by a stale `deadlineAt` left over from before the race went to PICKING.
- `sync_base` racing a landing: the sha check in `syncCommand` catches a `main` that moved after the read.
- Two pushes inside one slot: the second supersedes the first in place; neither files a follow-up nor uses a second slot.
- Reject-all on a race whose candidate is mid-rework: by construction PICKING has no REWORK candidate (`enterPicking` ends them); confirm no path reaches PICKING with one.
- Fallback reopen while the old winner's train is still tearing down (preview, car): the new base, new attempts and a new race must not collide with the old train's cleanup or its kept fork.

## 13. Open checks (first plan tasks)

| # | Check | If it fails |
|---|---|---|
| C1 | `createToken("read", 1800)` on the hive repo is scoped to that repo: it cannot read other repos and cannot push the hive | Stop; re-plan `sync_base` (e.g. fetch through a short-lived read-only fork) with the user |
| C2 | Artifacts accepts a non-fast-forward push to an attempt fork (`--force-with-lease`), and the push event's `before`/`after` are the old and new heads | Document "rebase then push" as a merge instead; re-plan with the user |
| C3 | Cheapest way to read hive `main`'s sha: `repo.log({ref: "main", limit: 1})` (as `forkOnce` does) vs. another binding call; latency | Use `log` |
| C4 | The design said "the Queen reads main from Artifacts", but the Queen has no Artifacts binding by rule (`apps/queen/wrangler.jsonc`). This spec has `queenos-mcp` read it and the Queen record it | If the user wants the Queen itself to read it, that adds a binding: ask first |

## 14. Future (no code)

- A goal may carry an external ticket link (Jira and similar), shown with the item and passed to agents.

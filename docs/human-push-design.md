# QueenOS inbox: every change is a Submission (human `git push`, external agents, drones)

Status: design, 2026-10-07. Builds Oct 7–8; it is live by Oct 9 and goes into the demo. It also covers human-judged races (§10), which ship separately. Decision D12 in `docs/v2-design.md` §10.
Read with `docs/v2-design.md` (§1.2 principles, §2.3 lanes and queue), `apps/queen/README.md` and `docs/day1-results.md` (rows 1, 3, 5, 8, 8b, 8c).

Anything marked **UNVERIFIED** has not been checked against the real account or the code.

---

## 1. Problem and pitch

QueenOS lands code only when the Queen asks for it. Today a change exists only because the Queen dispatched a BUILDER drone into a fork it made. People and outside agents (Claude Code, Codex) have no way in. A hackathon judge's first question is "can I push to it?", and the honest answer today is no.

**The inbox is a different paradigm from a pull request.**

| | Pull request | QueenOS inbox push |
|---|---|---|
| What the contributor says | "Please review my branch." | "Here's code. Vet it." |
| Who does the work after the push | The contributor opens, shepherds, pings reviewers, rebases and merges. | The swarm does: gates, LLM reviewer, merge queue, integration gate, lander, canary. |
| What the contributor does next | Babysits the PR. | Nothing. They read the verdict (a git note and the dashboard) and either push a fix or hand off to the swarm. |
| Rules | Branch protection, chosen per repo. | The same rules every drone gets. There is no human fast lane. |

**Pitch: "A human's `git push` rides the same train as 12 agents, under the same rules."**

**The bigger claim (user direction, 2026-10-07):** the inbox is not a side door for humans. It is the **universal intake**. Every piece of code, drone-written included, arrives as a **Submission** ("here's code, vet it"), and the pipeline consumes only Submissions (§2). A drone is just a contributor that the Queen asked for code. A human is a contributor that nobody asked.

---

## 2. Unified intake: Submission

### 2.1 The contract

```
Submission = { repo, ref, headSha, origin: {kind: drone|human|agent, id}, itemId?, provenance? }
```

The pipeline after intake consumes only Submissions:

```
Submission ─▶ (pin) ─▶ train DEPLOYING ─▶ preview ─▶ gate ─▶ PASSED ─▶ car ─▶ MERGE ─▶ integration gate ─▶ LANDER ─▶ release ladder
```

- **Solicited** submissions have an `itemId`. They come from drones the Queen dispatched for an item, or from a human who targets an item on purpose (§3.4). They link to the existing item.
- **Unsolicited** submissions have no `itemId`, as with a plain inbox push. Intake files a new item for them: a `feature` whose title is the head commit's subject.
- **Provenance** is metadata only: drone id, model, failed models, usage, race id, candidate index, attempt, `verified`. It feeds races, rework attempt counts, the model router's AIMD floor and stats, and the Model Board. **It is never a separate code path.** A human submission simply has no `model`. The router already ignores models that are not in the catalog (`apps/queen/README.md` "Stats"), so human code never moves the floor.

### 2.2 Physical forks, logical inbox

- **Every contributor keeps its own fork.**
  - A drone's train fork (`<hive>-train-<12hex>`) is an ephemeral, per-train inbox.
  - A human's inbox fork (`<hive>-in-<handle>`) is persistent, one per person (D12).
- **The "feature inbox" is logical, not a repo.** The *item* is the inbox, and candidates arrive in it from any fork.
- **We do not use a shared per-item repo:**
  - Artifacts' own guidance is one repo per agent (discovery §1, "Do not use one shared repo as a queue for many autonomous agents").
  - Races need isolated trees.
  - Concentrating pushes on one repo could make the Artifacts 503s worse (HANDOFF §6.6).

### 2.3 The pin: why an inbox push is not gated in place

An inbox submission is first **pinned**: a deterministic `PIN` drone copies `inbox@headSha` into a fresh train fork forked from hive main, and pushes it as that fork's `main`. After that, the train is an ordinary BUILD-lane train. A drone submission is already in a Queen-owned train fork, so its pin is a no-op.

The first sketch said the train would "skip BUILD and enter at DEPLOYING" with the inbox as the train's repo. **The code rules that out:**

| Consumer | What it assumes about `train.artifactRepo` | Breaks if it is the inbox |
|---|---|---|
| `TrainPlanner.cleanUp` → `deleteFork` (planner.ts ~1480) | It is Queen-owned and deleted on MERGED or EJECTED. | It would delete the person's inbox. |
| MERGE drone `mergeCar` (drones/merge.ts, design §2.3.4) | It fetches the member fork's `refs/heads/main`. | The human's code is on a branch, not on `main`. |
| `getGateTarget(repo)` (gatekeepers orchestrate.ts:174) | One repo is one train. | One inbox has many branches, so many trains. |
| Lander `carryNotes` (drones/land.ts:84) | Member-fork notes are Queen-written. | Inbox notes can be forged by their owner and would land in the hive ledger. |
| Car stability | The member head stays fetchable. | A human force-push can remove `headSha` from under a car. |

Pinning costs one FORK (~2 s, day1 row 5) plus one drone start (~2 s, row 10) and a fetch and push. In return, **every downstream consumer is unchanged.** The PIN drone runs in the BUILDING phase, the way the MERGE drone already does for cars.

### 2.4 Where the code special-cases drones today, and how each case maps onto Submission

| # | Drone-only today | Where | As a Submission |
|---|---|---|---|
| 1 | **Solicitation:** `submit` → `enqueue` → FORK → `dispatchBuilder` (BUILDER, `modelChoice`) | planner.ts `submit`, `enqueue`, `dispatchBuilder` | **Unchanged.** This is how the Queen *asks* for a submission. Unsolicited code gets a PIN train instead of a BUILDER. |
| 2 | **Completion:** `reportBuildResult` → `buildResult()` → DEPLOYING | planner.ts:804 | **Adapter:** `submissionFromBuildResult(train, r)`, then one `submission()` transition. `BuildResult` stays on the wire. |
| 3 | `recordBuild`: model stats, `failedModels`, usage; gate verdict → `model_outcome` | planner.ts `recordBuild`; models/router.ts | Read from `provenance`. An absent `model` means no counting (the catalog-only rule already exists). |
| 4 | Races: `racingRaceOf`, `rankCandidates` (`verified`, `changedBytes`) | train/race.ts | `provenance.raceId` and `candidate`. A human candidate ranks with `verified` absent (§2.5). |
| 5 | `fail()` → `rework()` auto-enqueues a REWORK drone | planner.ts:1426–1465 | Branches on origin. Drone: unchanged. Human or agent: the item goes FAILED ("awaiting contributor") with no auto-rework, unless the contributor handed off (§6.3). |
| 6 | The gate's `builderReasoning` from the BUILDER ledger (hive memory) | gatekeepers orchestrate.ts:178 | Provenance. It is `[]` for humans. |
| 7 | **`collectChange`** finds changed paths from *added* files plus paths named in drone-style commit messages ("a pure modification by a non-drone commit is invisible") | gatekeepers inspect.ts:186–213 | **Must become `changedBetween(baseSha, head)`** (hive-kit `changedPaths`) for every BUILD gate. Without it, a human's edit to an existing file is "out of diff", and its policy and security findings become follow-up bugs **instead of failing the gate** (`splitOutOfDiff`). This is a security bypass for inbox code, and a latent bug for drones. |
| 8 | Scripted test runner: a `[fail]` marker and a `queen(rework)` message prefix | gatekeepers test-runner.ts:14, 64 | Applies to any origin. Prod runs `GATE_TEST_MODE: scripted`, so a human commit message that contains `[fail]` fails the "tests". Documented; harmless. |
| 9 | Gatekeeper filter: train forks only (`TRAIN_REPO_RE`) | gatekeepers event.ts:121 | Adds `INBOX_REPO_RE`, which classifies an inbox push as `intake` (§5.2). |
| 10 | Lander carries notes from member forks | drones/land.ts:84 | Member = the pinned train fork. **Inbox notes are never carried.** |
| 11 | `cleanUp` deletes `artifactRepo` | planner.ts | Train forks only. The train lifecycle never touches the inbox. |
| 12 | Sim gate markers keyed on `task.action === "BUILD"` | sim-ports.ts:526–580 | Treat `PIN` like `BUILD`. |
| 13 | Path claims widen from `BuildResult.changedPaths` | work/ledger.ts `absorb` | The PIN drone reports `changedPaths` (`mergeBase(main, head)..head`). |

### 2.5 Best-of-N generalises

A submission that targets an item (§3.4) can be a race candidate. A human's code then races the drones under the same gate and the same `rankCandidates` ordering. A human has no `verified` (the builder's verify tool), so they lose ties on that key. External agents are first-class contributors: they push to their person's inbox, with `Queen-Origin: agent:<name>` in the commit.

**By Oct 14:** a targeted submission to a READY or FAILED item becomes that item's next attempt. **Stretch:** joining an in-flight race (a `RACING` race gains a candidate). Joining an ACTIVE non-race build is post-Oct 14.

### 2.6 Delivery: an adapter, not a rewrite

- Drones keep fork and dispatch.
- Their completion emits a Submission inside the Queen: `buildResult()` becomes `submission(submissionFromBuildResult(...))`. This lands in the same change that adds the inbox path.
- **The plan (§13) is ordered so the human inbox path ships alone if the drone adapter slips.** The adapter is one task (T1b) with its own tests. Without it, `buildResult()` stays as it is and only inbox submissions use `submission()`.

---

## 3. UX walkthrough

### 3.1 Get an inbox (once; re-run to refresh the token)

From the dashboard, **Push code** (project header) shows the commands below with copy buttons. From a terminal behind Access:

```bash
cloudflared access curl -X POST https://queenos.kaikeru.com/api/hives/demo/inbox
```

```json
{
  "handle": "kyle",
  "repo": "demo-in-kyle",
  "remote": "https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/queenos/demo-in-kyle.git",
  "username": "queen",
  "password": "art_v2_…",            // the token with ?expires= stripped (Basic auth)
  "expiresAt": "2026-10-08T14:02:11Z", // 24 h
  "mainSha": "9f2c…"                  // inbox main fast-forwarded to hive main
}
```

### 3.2 Push

```bash
git clone https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/queenos/demo-in-kyle.git && cd demo-in-kyle
#   or, in an existing clone:  git remote add queen <remote>
git switch -c tip-jar
$EDITOR src/features/tip-jar.js
git commit -am "Add a tip jar at /features/tip-jar"
git push queen tip-jar                # username: queen, password: <password>
```

- **Credentials:** use Basic auth with any username and password = the token without `?expires=`. Or set a header: `git -c http.extraHeader="Authorization: Bearer <full token>" push …` (discovery §1).
- **`git push` always succeeds** (§11, item 1). The push is a proposal; the train decides.
- **Pushes to inbox `main` are ignored.** `main` is a mirror of hive main, refreshed on every `POST …/inbox`. Push branches.

### 3.3 Read the verdict

```bash
git fetch queen 'refs/notes/*:refs/notes/*'
git log --notes=queen -1
```
```
Notes (queen):
    queen: REJECTED by SECURITY  (item 3c1e…  train 7a90…  2026-10-07 14:06Z)
    error src/features/tip-jar.js:12 fetch to non-allowlisted host "tips.example.com"
    next: push a fix to tip-jar, or hand off: https://queenos.kaikeru.com/p/demo/items/3c1e…
```

Later milestones are appended to the same note: `PASSED`, `QUEUED in car <id>`, `CONFLICT`, `LANDED main@<sha>`, `SHIPPED <release>` or `ROLLED BACK`. The dashboard shows the same item with a **human** (or **agent**) origin badge.

### 3.4 Fix it yourself, or hand off to the swarm

- **Fix:** commit and `git push queen tip-jar` again. Intake reopens the same item (§6.2).
- **Hand off:** press **Let the swarm fix it** on the item page (`workAction: handoff`), or put `Queen: rework` in the commit message up front. A REWORK drone starts from *your* head, applies the reviewer and scan findings, and pushes its commit onto your branch:
  ```bash
  git pull queen tip-jar      # the drone's fix, on top of your commit
  ```
- **Trailers** (head commit only, case-insensitive):
  - `Queen: rework`: hand off automatically on a reject.
  - `Queen-Item: <itemId>`: target an existing item. The branch name `item/<itemId>` does the same.
  - `Queen-Origin: agent:<name>`: declare that an agent wrote this.

---

## 4. Architecture and sequence

**Rule kept:** the Queen decides, records and dispatches. Every Artifacts call runs in an executor.

**One deliberate exception in shape (not in principle):** opening an inbox has to hand a token back to a person on the request path. The Queen cannot do I/O, the provisioner Workflow is asynchronous, and a token must never sit in Queen SQLite or in a broadcast. So the edge calls a **synchronous RPC entrypoint on the provisioner** (`InboxKeys`), the same pattern as the Vault's `VaultWriter` (edge `wrangler.jsonc` `services`). The Queen still makes the decision first: it records the contributor, applies caps and chooses the repo name.

| Component | New responsibility |
|---|---|
| **edge** (`apps/edge/src/app.ts`) | `POST` and `DELETE /api/hives/:hive/inbox` behind Access: Queen `registerInbox`, then `InboxKeys.open` or `revoke`. Never logs the token. |
| **provisioner** (`apps/provisioner`) | `InboxKeys` entrypoint: `open` gets or forks `<hive>-in-<handle>`, fast-forwards inbox `main` to hive main (the lander's fetch-then-push pattern), mints a write token (24 h) and returns it. `revoke` revokes the inbox's tokens. New Workflow op **`NOTE`** appends a note on `repo@sha` under `refs/notes/queen`. **It mints tokens only for names that match `^<hive>-in-[a-z0-9]{1,24}$`.** |
| **gatekeepers** (`event.ts`, `orchestrate.ts`) | `classifyPush`: an inbox repo with `refs/heads/*` (not `main`) → `intake`, then one step: Queen `submit(Submission)`. Notes refs are already ignored (event.ts:119). Every BUILD gate scans `changedBetween(baseSha, head)`. A non-drone origin fails closed when the reviewer is unavailable. |
| **Queen** (`work/inbox.ts` new, planner, queen-node) | `registerInbox`; `submit`: dedupe, contributor lookup, caps, file or reopen the item, supersede; PIN trains; NOTE effects at milestones; `handoff`. |
| **drones** | `PIN` action (no LLM): fetch `inbox ref`, check `headSha`, push it to train fork `main` (force), report `BuildResult` with `changedPaths`. REWORK with `seed`: pin first, then build. Then write back to the inbox branch (fast-forward only, else `<branch>-queen`). |
| **dashboard** | Origin badge; **Push code** panel; **Let the swarm fix it** button. |

### Sequence (unsolicited human push)

```
human        Artifacts            gatekeepers          Queen (decide)                provisioner / drones / herald
  │ git push   │                      │                     │                                 │
  │──────────▶│ demo-in-kyle          │                     │                                 │
  │  ok       │ refs/heads/tip-jar    │                     │                                 │
  │◀──────────│── repo.pushed ───────▶│ classify: intake    │                                 │
  │           │   (2–5.5 s, row 8)    │── submit(Sub) ─────▶│ dedupe (repo, after); file item │
  │           │                       │                     │ READY → dispatchReady (slots,    │
  │           │                       │                     │ budget, paused, affinity)        │
  │           │                       │                     │ PIN train: FORK main ──────────▶│ fork demo-train-x
  │           │                       │                     │◀── provision-result ────────────│
  │           │                       │                     │ dispatch PIN drone ────────────▶│ fetch inbox@sha → push train main
  │           │◀── push demo-train-x ─│─────────────────────│◀── build-result (Submission) ───│
  │           │── repo.pushed ───────▶│ classify: gate      │ DEPLOYING → Herald preview ────▶│
  │           │                       │ lookup → TESTING    │◀── deploy-result ───────────────│
  │           │                       │ scans, smoke, REVIEWER (always for BUILD lane)        │
  │           │                       │── train-result ────▶│ PASSED → car → … (unchanged)    │
  │           │                       │                     │ or FAILED: NOTE effect ────────▶│ provisioner NOTE → inbox
  │           │◀───────────────── refs/notes/queen push (filtered: notes-ref) ────────────────│
```

**Latency (estimate, UNVERIFIED end to end):**
- event 2–5 s;
- fork about 2 s plus Workflow start 0.4–4.8 s;
- PIN about 5 s;
- the train push event 2–5 s;
- preview deploy;
- gate 30–90 s.

**The first note arrives about 1.5–3 minutes after `git push`.** This is slower than the "2–5 s" in the brief, which counted only the push event.

---

## 5. Contracts (`packages/queen-types`, first)

New file `src/inbox.ts`, exported from `index.ts`:

```ts
export const SubmissionOriginSchema = z.object({
  kind: z.enum(["drone", "human", "agent"]),
  /** drone: drone Workflow instance id; human: Access email; agent: "<name>@<owner email>". */
  id: z.string().min(1).max(320),
});

/** Metadata only (races, rework counts, router stats, Model Board). Never a code path. */
export const SubmissionProvenanceSchema = z.object({
  trainId: z.string(), raceId: z.string().nullable(), candidate: z.number().int().min(0),
  attempt: z.number().int().min(0), action: z.enum(["BUILD", "REWORK", "PIN"]),
  model: z.string(), failedModels: z.array(z.string()).max(5), usage: BuildUsageSchema,
  verified: z.boolean(), buildMs: z.number().int().min(0),
  followUps: z.array(FollowUpSchema).max(5),
  /** Inbox origin: the push event id (day1 row 8b) and the head commit's trailers. */
  eventId: z.string(), trailers: z.record(z.string(), z.string()),
}).partial();

export const SubmissionSchema = z.object({
  hive: z.string().min(1),
  /** The fork the code is in: a train fork (drone) or an inbox fork. */
  repo: z.string().min(1),
  ref: z.string().regex(/^refs\/heads\/.+/),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  /** Merge base with hive main (gate diff base); the PIN drone fills it for inbox code. */
  baseSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  origin: SubmissionOriginSchema,
  /** Solicited (or targeted with Queen-Item / item/<id>): link. Absent: intake files an item. */
  itemId: z.string().max(64).optional(),
  /** Head commit subject (≤120) and message (≤4000): the intent of unsolicited code. */
  title: z.string().max(120).optional(),
  message: z.string().max(4000).optional(),
  changedPaths: z.array(z.string().max(200)).max(200).optional(),
  provenance: SubmissionProvenanceSchema.default({}),
});

export const InboxSchema = z.object({
  hive: z.string(), email: z.string(), handle: z.string().regex(/^[a-z0-9]{1,24}$/),
  repo: z.string(), createdAt: z.number().int(), revokedAt: z.number().int().nullable(),
  openItems: z.number().int().min(0),
});
export const InboxOpenResultSchema = z.object({          // edge response; never stored
  handle: z.string(), repo: z.string(), remote: z.string().url(),
  username: z.literal("queen"), password: z.string(), expiresAt: z.string(), mainSha: z.string(),
});
export const SubmitOutcomeSchema = z.object({
  outcome: z.enum(["applied", "ignored:duplicate", "ignored:own-push", "ignored:inbox-main",
                   "ignored:unknown-inbox", "ignored:revoked", "ignored:over-cap", "ignored:paused"]),
  itemId: z.string().optional(), trainId: z.string().optional(),
});
```

Changes to existing schemas (all optional, so old payloads parse):

| Schema (file) | Change |
|---|---|
| `DroneActionSchema` (drone.ts) | + `"PIN"` |
| `DroneTaskSchema` (drone.ts) | + `seed?: {repo, ref, headSha}` (PIN, and REWORK of inbox code); + `writeBack?: {repo, ref}` |
| `ProvisionCommandSchema` (executors.ts) | + op `NOTE {commandId, hive, trainId, repo, sha, text ≤2000}`. `ProvisionResult.op` gains `"NOTE"`. |
| `WorkItemSchema` (work.ts) | + `inbox?: {repo, ref, handle, headSha, handoff: boolean} \| null`. `WorkSourceKindSchema` + `"agent"` (a human stays `"user"`, `actor` = email). |
| `WorkActionSchema` (work.ts) | + `"handoff"` |
| `GuardrailsSchema` (work.ts) | + `maxInboxOpenPerContributor` (default 3, max 10), `maxInboxPushesPerHour` (default 20, max 60) |
| `MergeTrainSchema` (state.ts) | + `origin?: SubmissionOrigin` (dashboard badge, gate fail-closed) |
| `GateTargetSchema` (queue.ts) | + `origin?`; `baseSha` also set for BUILD trains (the diff base) |

**Naming clash:** `WorkPlanResult.submissions: DispatchSubmission[]` (work/ledger.ts:167) already means "items to dispatch". T0 renames it to `dispatches`, a mechanical change in `ledger.ts` and `queen-node.ts`, so "submission" means one thing.

**SQLite v14** (`apps/queen/src/db.ts`):
- `inboxes(email PK, handle UNIQUE, repo, created_at, revoked_at)`;
- `submissions(repo, head_sha, ref, origin_kind, origin_id, item_id, train_id, outcome, created_at, PRIMARY KEY(repo, head_sha))`, pruned with the event log;
- `work_items.inbox_json`;
- `merge_trains.origin_json`.

---

## 6. State-machine changes

### 6.1 Trains

There are no new phases.
- A PIN train is a BUILD-lane train whose BUILDING phase runs the PIN drone, as a car's BUILDING phase runs the MERGE drone.
- `TrainAction` gains `PIN`.
- `submission()` keeps `buildResult()`'s guards: phase BUILDING, `forkState` READY, stale and duplicate checks.

### 6.2 Items (WorkPlanner, new pure `work/inbox.ts`)

| Event | Rule |
|---|---|
| Push, new `(inbox, ref)` | File a `feature`: title = head subject, body = head message, acceptance = `- ` lines under an `Acceptance:` line if present. Then **READY**, skipping TRIAGE (users are not deduped, §2.2 of v2-design). `paths: []`, so it is optimistic. The PIN train's `changedPaths` widen the claims. |
| Duplicate `(repo, headSha)` | `ignored:duplicate`. The same SHA pushed to a second branch is also a duplicate. **The dedupe key is `(repo, after)`, as day1 row 8 says; `(repo, ref)` is the supersede key.** |
| `headSha` equals a head the Queen wrote (the REWORK write-back) | `ignored:own-push` |
| Re-push to `(inbox, ref)` while its train is **not yet in a car** (`carId = null`) | Eject the old train (`superseded by push <sha>`, no attempt charged, fork deleted), then start a new PIN train for the same item. |
| Re-push while the train **is in a car**, or the item is LANDED or SHIPPED | File a **new** item ("<title> (follow-up)"). The earlier code lands on its own. |
| Re-push to a **FAILED** inbox item | FAILED → READY (attempts + 1). |
| Gate reject (any check) on human or agent origin | Train EJECTED; item **FAILED** with `blockedReason "awaiting contributor"`; NOTE. **No escalation and no auto-rework.** The contributor was told by the note. |
| …with `inbox.handoff` (`Queen: rework`) or `workAction handoff` | `rework()` as for drones: a REWORK train with `seed = inbox@head`, under `maxReworks`. Exhaustion is `REWORK_EXHAUSTED`, as today. |
| Merge conflict or integration failure | As for drones (D7, `waitForCarSeq`), but the rework is not automatic: FAILED plus a NOTE ("conflicts with work that landed: src/x.js; rebase on `queen/main` and push, or hand off"). |
| Caps | More than `maxInboxOpenPerContributor` open items, or more than `maxInboxPushesPerHour`, gives `ignored:over-cap` plus one NOTE per hour. `maxOpenItems` and the daily budget apply as for any item. `paused` holds the item READY. |

**Autonomy and the error budget are unchanged.** Inbox code auto-ships when the budget is green. If a release that carries inbox code rolls back, that is a **real change failure**: it counts against the SLO and the rollback streak exactly as drone code does, the P0 bug goes to the swarm (`source.kind: sentinel`), and the contributor's commit gets a `ROLLED BACK` note. Same rules means same consequences.

### 6.3 Handoff: human and agent on one branch

1. The REWORK drone is dispatched with `seed`. It runs the PIN body (train `main` = the human's head), then the builder with the Scribe summary (the reviewer and scan findings), and pushes the train fork.
2. It reports `BuildResult`, which is a Submission with origin `drone` and the item linked.
3. Then it writes back: it pushes the new head to `inbox refs/heads/<ref>` if that is a fast-forward (the human has not pushed since); otherwise it pushes to `<ref>-queen`.
4. The resulting push event is `ignored:own-push`. The Queen recorded the head in step 2, before the write-back.

---

## 7. Notes write-back

- **Writer:** the provisioner's `NOTE` op, dispatched by the Queen as a `provision` effect with `commandId <trainId>-note-<n>` at these milestones:
  - gate verdict (pass or reject, with the summary and up to 8 findings);
  - conflict;
  - integration failure;
  - LANDED;
  - SHIPPED or ROLLED BACK.
- **Why the provisioner:** it already owns repo administration (fork, delete, create, tokens). This keeps drones on code. The gatekeeper does not write notes today (its verdicts are `appendAudits` to the Queen), and later milestones are the Queen's to announce anyway.
- **Body:**
  1. fetch the inbox's `refs/notes/queen` (depth 1);
  2. read the existing note on `sha`;
  3. **append** (a separator line, up to 8 KB per commit);
  4. `addNote` and push **without** force;
  5. on a non-fast-forward, re-fetch and retry (3×).
  - Day 1 pushed notes with `force: true`. Force here would lose concurrent milestones.
- **Event loop:** a notes push fires `repo.pushed` (day1 row 8). `classifyPush` drops `refs/notes/*` before anything else (event.ts:119, verified in code). The inbox inherits the hive's `refs/notes/queen` at fork time (day1 row 1), so `git log --notes=queen` also shows the swarm's ledger on main's history.
- **The hive ledger:** the same NOTE is also written to the train fork, so the lander's `carryNotes` brings the verdict to hive main. Notes the human writes in their own inbox are never read.
- **Drone submissions:** no NOTE (nobody reads a train fork, and it adds Artifacts load). The verdict reaches the hive through the event log, as today.

---

## 8. Security model

| Concern | Control |
|---|---|
| A human bypasses the gates or the LANDER | The only token a person ever gets is minted by `InboxKeys`, which refuses any repo name but `<hive>-in-<handle>`. Hive main is written only by the LANDER (an executor with the binding). *Correction to the brief: Artifacts tokens are not in the Vault. The Vault holds Cloudflare deploy credentials, and executors mint Artifacts tokens on demand through the `ARTIFACTS` binding. The guarantee comes from `InboxKeys`'s name check.* |
| Token scope | `repo.createToken("write", 86400)` on the inbox repo handle. Tokens are per repo (a repo-level method; `delete()` removes "all associated tokens", discovery §1). **UNVERIFIED** that a repo token cannot authenticate to another repo; test it on day 1 of the build (§15, Q3). |
| Token lifetime and revocation | TTL 24 h (the allowed range is 60 s to 1 y). Re-opening mints a new token; `?rotate=1` also revokes the others (`listTokens` + `revokeToken`). `DELETE …/inbox` revokes everything and marks the inbox `revoked_at`, so later pushes are `ignored:revoked`. Per person = per repo, so revocation is per contributor. **UNVERIFIED** whether revocation takes effect immediately. |
| Who is the contributor | The **inbox owner** (Access email), never the commit author (which anyone can set). `Queen-Origin: agent:x` is a claim within the owner's accountability. |
| Git is not behind Access | Pushes go straight to `*.artifacts.cloudflare.net`; the token is the only gate. That is why the TTL is short. |
| Untrusted code | The same exposure as LLM code: Worker Preview per train, policy, security and allowlist scans, reviewer, integration gate, staging, Sentinel. **Fix required (T4):** scan `changedBetween(baseSha, head)` (§2.4 row 7), or modified files escape the in-diff scan. Also: changes to `.queen/**`, `wrangler.*` and `package.json` from a non-drone origin are a policy **error**, since the deploy config is not a contributor's to change. |
| Reviewer fails open | For drones it fails open on infra (orchestrate.ts:406). For human or agent origin it **fails closed**: the train is reported as `cause: "infra"`, so it is re-gated and never passed unreviewed. |
| Abuse | Per-contributor open-item and hourly push caps; `(repo, after)` dedupe; global `maxOpenItems` and budget. The PIN drone refuses a diff over 5 MB or 500 files (a NOTE explains). Artifacts limits: 32 MB per blob, 1 GB per repo. |
| Forged notes | The owner can write any notes into their own inbox. These are never carried to the hive (§7). |

---

## 9. Failure modes

| Failure | Behaviour |
|---|---|
| Push event lost or late (delivery semantics UNVERIFIED) | The next push catches up. Dashboard **Push code → Rescan** calls `POST /hives/:hive/inbox/rescan`; the Queen dispatches a provisioner op that lists inbox refs (`listServerRefs`) and replays `submit` for unknown heads. Stretch: T2 if time allows. |
| Duplicate event | `ignored:duplicate` on `(repo, after)`. |
| Force-push removes `headSha` before PIN | The PIN drone reports `ok: false` "head not found". If a newer push exists, the result is stale. Otherwise the item is FAILED with a note. |
| Branch shares no history with main | PIN reports a failure ("no merge base with main"), and the item is FAILED with a note. |
| Branch based on an old main | Allowed. The gate diffs from the merge base. The preview lacks newer main features. The car's integration gate (3-way merge onto the tip) is the safety net, and a conflict leads to a NOTE. |
| Inbox `main` pushed by the human | Ignored (`ignored:inbox-main`), and overwritten on the next open. |
| `InboxKeys.open` fails (fork or 503) | The edge returns 503 and the call can be retried; the fork is idempotent (`ALREADY_EXISTS` = success, day1 row 5b). The Queen's contributor row exists either way. |
| NOTE fails after retries | Recorded (`note.failed` event). The dashboard is the source of truth; nothing is ejected. |
| Write-back is not a fast-forward | Pushed to `<ref>-queen` instead, and the note says so. |
| Hive `paused` or budget exhausted | The item waits READY, with `waitReason` shown on the dashboard. A note "queued: hive paused" is sent once. |

---

## 10. Human-judged races (you pick)

**Pitch: "Show me three live versions of this feature and I'll pick."** You get an A/B choice before merge, instead of after deploy. It is separately shippable (T9) and does not need the inbox.

### 10.1 Today (verified in code)

`maybeDecide()` (planner.ts:1648) runs once every candidate has reported, or at `deadlineAt` (`RACE_GRACE_MS` = 90 s after the first pass). It then:
- ranks the passed candidates with `rankCandidates()` (race.ts:178);
- `pass()`es the winner (WON, `passedSeq`, it boards a car);
- **ejects every other candidate as LOST**, which deletes their forks and tears down their previews;
- marks the race DECIDED and emits `race.decided`.

Passed candidates wait in TESTING with their previews LIVE until then, so the previews already exist for a picker. There is just no hold.

### 10.2 The change (opt-in)

| | |
|---|---|
| **Opt-in** | Per item: the composer's best-of control gains **you pick**, setting `judge: "human"` on `SubmitPrompt` / `FileWorkItem`, stored on the item. Per hive: `settings.race.judge: "auto" \| "human"` (default `auto`). |
| **Machines first (pre-review)** | Only candidates that passed **every** gate enter PICKING: policy, security, preview smoke, and the LLM reviewer against the item's acceptance criteria. "Plain wrong" never reaches a human. **0 pass** → the normal ABANDONED → REWORK path, with no human. **Exactly 1 pass** → auto-decide (no real choice), `by: "queen:single"`. Inbox submissions in a race get the same pre-review (§2.5). |
| **New race state `PICKING`** | Between "all reported or deadline" and DECIDED. Entered only when `judge = human` and **at least 2 candidates passed**. Passed candidates stay alive: TESTING, previews LIVE, forks kept, no teardown. The race records `recommendedTrainId` (the `rankCandidates` winner) and `recommendReason`, and gets `pickDeadlineAt = now + pickWindowMs` (default 15 min, max 2 h). |
| **Pick** | `POST /hives/:hive/races/:raceId/pick {trainId, reason?}` is a Queen **user route** (`x-queen-user`). The edge already forwards `/hives/*` with the Access identity (edge app.ts:175–187), so **no edge change is needed**. It returns 409 unless the race is PICKING and `trainId` is a live passed candidate. |
| **Decide** | The same body as `maybeDecide`'s passed branch, with the human's winner. Event `race.decided` with `data: {by: "human:<email>", reason, recommended, agreed: winner === recommended}`. |
| **Deadline fallback** | At `pickDeadlineAt` the Queen auto-picks its recommendation: `by: "queen:deadline"`. The swarm never stalls, so "autonomous by default; humans only on escalation" still holds. `watchdogDeadline()` must include PICKING races' `pickDeadlineAt` (today it adds only RACING deadlines, planner.ts:500). |
| **Paused / supervised** | `paused` does not auto-pick (the hold continues; the deadline still fires). A supervised hive behaves the same: the pick is not a release tap. |

### 10.3 Wrinkles and guards

- **Slots and claims.** Held candidates are active BUILD trains, so they count against `maxActiveTrains` and the lease, and their path claims stay held. Guardrail `maxPickingRaces` (default 2, max 5): a race that would enter PICKING beyond the cap auto-decides, with `by: "queen:cap"` and an event. The pick window is short by default (15 min).
- **Preview lifetime.** The candidates' previews stay up through PICKING. Losers are torn down on decide, as today. Per the HANDOFF §9 gotcha, pinned `<8hex>-<worker>` preview URLs outlive teardown: the race box links the **alias** URL Herald reports, and the dashboard stops showing a loser's link once it is LOST.
- **Changing your mind.** Losers are EJECTED as today, but **fork deletion is deferred** until the winner's car is MERGED, or 30 min, whichever is first. Their previews are torn down. "Pick B instead" then has two cases:
  - **Before the winner boards a car:** a direct re-pick. The winner is ejected (LOST, no attempt), and B is restored to PASSED. This window is short, because cars form at once.
  - **After that:** it files a **targeted Submission** of B's head (`repo` = B's train fork, `itemId` = the item, origin `human`). This is §2's machinery: a loser's fork is just another inbox. If the winner already landed, the item gains a follow-up item.
  - The deferred delete is a planner flag (`deleteAfter`) checked in the alarm.
- **Preference data.** Picks are recorded per `(model, role)` in `model_stats` as `picks` and `picksAgainstRecommendation`. The Model Board shows a "human picks" column. §10.5 turns picks into a capped routing signal (T9c).
- **Your own version in the race.** With §2.5, a human's targeted submission to a RACING item joins as a candidate, so the picker compares the agents' versions with their own. Stretch: it needs the "join an in-flight race" path.

### 10.4 Manual reject (T9b)

- **Reject one candidate:** `POST /hives/:hive/races/:raceId/reject {trainId, reason}` (a user route, forwarded by the edge as is; `reason` 1..300 is required).
  - It works only while the race is PICKING.
  - The candidate is EJECTED (`raceOutcome: "LOST"`, reason `rejected by <email>: <reason>`), and its fork and preview are cleaned up as usual.
  - The reason is recorded as a reviewer-style finding: an `appendAudits` row, role REVIEWER, REJECTED, with `reasoningSteps: ["missing: <reason>"]`. It is also kept on the race (`rejections[]`), so a later REWORK brief can quote it.
  - If one passed candidate is left, the race auto-decides it (`by: "queen:single"`). If none are left, it is treated as "none of these".
- **None of these:** `{trainId: "all", reason}` ejects every live candidate. The race becomes ABANDONED, `rework()` runs with the Scribe summary = `Human rejected all candidates: <reasons, joined>` (≤500), and attempts + 1, exactly as a failed race.
  - The REWORK's race width follows the policy (`reworkWidth` 2), and it keeps `judge: human`, so the human sees the next round too.
  - Past `maxReworks` the item gets `REWORK_EXHAUSTED`, as today.
- **Ledger:** event `race.rejected {raceId, trainId | "all", by: "human:<email>", reason, model}` per rejected candidate.

### 10.5 Model weighting from picks (T9c, can slip)

**How the router scores today (verified, `apps/queen/src/models/router.ts`):**
- `rank()` (router.ts:154) computes `rate = max(MIN_RATE, (passes+1)/(attempts+2) − STREAK_PENALTY·min(failStreak,3))` and `value = rate / cost × (0.8 if slow)`.
- `route()` (first BUILD at the AIMD floor tier, REWORK at frontier, exploration every 5th) and `routeRace()` (w distinct models by value) both rank through `rank()`.
- Stats are per `(model, role)` in `model_stats` (`ModelStatsSchema`, queen-types models.ts:69). Item kind is not a key today.

**Plug-in point:** one multiplicative factor inside `rank()`:

```
value = rate / cost × slowFactor × pref(model, kind)
pref  = 1 + HUMAN_WEIGHT_CAP × confidence × clamp((rating − 1500) / 400, −1, 1)
confidence = n / (n + 5)          HUMAN_WEIGHT_CAP = 0.15
```

- **Rating:** Elo, K = 24, per `(model, item kind)`, in a new table `model_preference(model, kind, rating, n, updated_at)` (migration v14).
  - A **pick** is a set of pairwise wins: the winner beats each other candidate that passed and was still live at pick time. A model is skipped if it is absent or outside the catalog (that covers human candidates).
  - A **reject** is a loss against a virtual 1500 opponent. "None of these" is a loss for each candidate.
- **Guards:**
  - Only `by: "human:*"` decisions update ratings. `queen:deadline`, `queen:single` and `queen:cap` never do.
  - The cap means human preference moves a model's value by at most ±15%, so it reorders near-ties and never overrides a failing record.
  - It never touches the AIMD floor or tiers.
  - **Decay:** at read time the rating is pulled toward 1500 with a 7-day half-life from `updated_at` (pure, no clock in the planner: `ctx.now` is passed in).
- **Inputs:** `ChooseModelInput` gains `kind` and `preference: PreferenceRow[]`. `route` and `routeRace` pass them through, and `ModelChoice.reason` gains `"; human pref +6% (n=9)"` when the factor exceeds ±1%.
- **Traceability:** every rating change happens in the same `decide()` transaction as the `race.decided` / `race.rejected` event that caused it, with `data.preference: {model, kind, before, after}`. The rating table is therefore a fold of ledger events, and it can be rebuilt from `event_log`. Every routing change after that is explained by `ModelChoice.reason` (already recorded on the train as `model_reason`).
- **Model Board:** a "human preference" column (rating, n, last pick) per kind.

### 10.6 Dashboard

The race box (swarm floor and item page) gains a **Pick** view: candidates side by side, each with the preview link (an iframe on wide screens), the diff (changed files and bytes), gate checks, reviewer satisfied/missing counts and notes, model, and credits.
- The Queen's choice is badged **recommended**, with `recommendReason`.
- A countdown shows the auto-pick time.
- A required, one-line "why" goes into the ledger.
- Each card has **Reject…** (a reason is required), and the box has **None of these…**.

### 10.7 Contracts (in T0, inert until T9a)

- `RaceStateSchema` gains `"PICKING"`.
- `RaceSchema` gains `pickDeadlineAt`, `recommendedTrainId`, `recommendReason`, `decidedBy`, and `rejections: {trainId, by, reason}[]`.
- `HiveSettings.race` gains `judge` and `pickWindowMs`.
- `SubmitPrompt`, `FileWorkItem` and `WorkItem` gain `judge?`.
- `GuardrailsSchema` gains `maxPickingRaces`.
- `PickRaceSchema = {trainId, reason ≤300}` and `RejectRaceSchema = {trainId | "all", reason 1..300}`.
- `ModelPreferenceSchema = {model, kind, rating, n, updatedAt}`.
- `ModelChoice.reason` is unchanged in shape.
- Migration v14 adds the `races` and `work_items` columns and `model_preference`.

### 10.8 Sim and acceptance

- Sim: `[race] [you-pick]` in a prompt sets `bestOf 3, judge human`. Every candidate passes (marker rule), so the race enters PICKING. `[race] [you-pick] [fail]` leaves 2 passed candidates, and `[review-fail]` on candidate 0 shows that pre-review keeps it out of PICKING.
- Tests:
  - (a) A pick of the non-recommended candidate → that one lands, the others LOST, `race.decided` with `by: human:…` and `agreed: false`.
  - (b) **Deadline fallback** → the recommendation lands, `by: queen:deadline`, and **no rating change**.
  - (c) A pick on a DECIDED race → 409.
  - (d) The `maxPickingRaces` cap → auto-decide.
  - (e) A re-pick before boarding swaps the winner.
  - (f) Only 1 passed → no PICKING; 0 passed → REWORK with no human.
  - (g) `watchdogDeadline` includes `pickDeadlineAt`.
  - (h) Reject one of 3 → 2 left, still PICKING; reject one of 2 → auto-decide the other.
  - (i) "None of these" → ABANDONED, a REWORK whose summary quotes the reasons, attempts + 1.
  - (j) Elo: a pick over 2 losers gives two pairwise updates; the cap holds at ±15%; decay halves the deviation after 7 days; the router reason names the factor; the rating table rebuilt from `event_log` equals the live table.

---

## 11. Limitations (stated honestly)

1. **No pre-receive.** We do not own Artifacts' receive-pack, so `git push` always succeeds. The verdict arrives asynchronously, minutes later, as a note and on the dashboard. We cannot reject in the push output the way Gerrit does. Framing: **the push is a proposal; the train decides.**
2. The verdict takes about 1.5–3 minutes, not seconds (§4).
3. One branch is one item. There are no stacked branches.
4. The commit author is not authenticated. The inbox owner is accountable.

**Out of scope:** org and permission models, PR discussion threads, per-line comments, pre-receive rejection, service-token (non-email) contributors, joining a non-race build in flight.

---

## 12. Sim support and acceptance tests

**Sim** (`pnpm --filter @queenos/queen dev:sim`, no credentials):
- A localhost-only route `POST /hives/:hive/sim/inbox-push {email, ref, message, files?}` registers the inbox if needed, fabricates `headSha = sha1(email|ref|message|n)` and calls `submit()` exactly as the gatekeeper would.
- The sim PIN fake: about 1.5 s, `changedPaths` from `[touch:]` markers plus `src/features/<slug>.js`.
- Gate markers apply to PIN like BUILD: `[fail]` fails policy, `[review-fail]` makes the reviewer reject, `[collide]`.
- The sim NOTE fake appends to an in-memory per-inbox log served at `GET /hives/:hive/sim/notes/:sha`, so "git log --notes" can be shown.
- `Queen: rework` and the dashboard handoff dispatch the existing sim REWORK fake.
- In `pnpm dev:sim` the dashboard's **Push code** panel offers a "Simulate a push" form.

**Acceptance** (vitest-pool-workers, sim ports):
1. An inbox push → item (`source.kind user`, `inbox` set) → PIN train → gate → car → LANDED → SHIPPED. NOTE effects for PASSED, LANDED and SHIPPED.
2. `[review-fail]` push → item FAILED "awaiting contributor", **no** REWORK dispatched, no escalation, a REJECTED NOTE.
3. The same, then `workAction handoff` → REWORK with `seed` → passes → LANDED. The write-back's own push is `ignored:own-push`.
4. A `Queen: rework` trailer gives an automatic REWORK after the reject.
5. A re-push before boarding → the old train EJECTED (no attempt), a new PIN train, one item. A re-push after boarding → a new item.
6. The same SHA twice, or on two branches → `ignored:duplicate`. A push to `main` → `ignored:inbox-main`. A notes ref → gatekeeper `ignored notes-ref` (an existing test, kept).
7. Caps: a 4th open item → `ignored:over-cap`. `paused` → READY with `waitReason`.
8. A 12-item swarm plus 2 inbox pushes: the human trains share cars with drone members, and every item LANDED.
9. **Drone adapter (T1b):** every existing `planner.test.ts`, `v2-flow.test.ts` and `load.test.ts` passes unchanged through `submission()`. Race ranking and router stats are identical.
10. **Gatekeepers:** an inbox-repo event → exactly one `submit`; `changedBetween` flags a *modified* file with `eval` as in-diff (a failing gate, not a follow-up); the reviewer `unavailable` on a human origin → `cause: infra`.
11. **Provisioner:** `InboxKeys.open` refuses `demo` and `demo-train-…` (only `-in-` names); open twice → one fork; NOTE appends and retries on a non-fast-forward.
12. **Edge:** `x-queen-user` comes from Access only; the token never appears in logs (spy on `console`).

---

## 13. Implementation plan (subagents, disjoint files, contracts first)

The human path **ships without T1b**. If the drone adapter slips, cut it: drones keep `buildResult()`.

| Task | Model | Owns (exclusive) | Depends | Effort |
|---|---|---|---|---|
| **T0 Contracts + migration** | Opus | `packages/queen-types/src/{inbox.ts,drone.ts,executors.ts,work.ts,state.ts,queue.ts,train.ts,autonomy.ts,models.ts,index.ts,index.test.ts}` (inbox and race/pick/preference contracts, §5 and §10.7); `apps/queen/src/db.ts` (v14: inbox, submissions, race and preference columns, mappers); `apps/queen/test/migrations.test.ts`; rename `submissions` → `dispatches` in `apps/queen/src/work/ledger.ts` + `queen-node.ts` (mechanical); seams with `not implemented` for `work/inbox.ts` | none | 0.5 d (Oct 7 AM) |
| **T1 Queen intake + planner** | Opus | `apps/queen/src/work/inbox.ts`, `train/planner.ts`, `queen-node.ts`, `index.ts`, `executors.ts`; `apps/queen/test/{inbox.test.ts,planner.test.ts,v2-flow.test.ts}`; `apps/queen/README.md` | T0 | 1 d |
| **T1b Drone adapter** | Opus (same agent, after T1) | `planner.ts` `buildResult` → `submission()`; `submissionFromBuildResult` in queen-types | T1 | 0.25 d, **cuttable** |
| **T2 Provisioner** | Sonnet | `apps/provisioner/**` (`InboxKeys` entrypoint, NOTE op, wrangler entrypoint export) | T0 | 0.5 d |
| **T3 Drones** | Sonnet | `apps/drones/**` (PIN, seeded REWORK, write-back) | T0 | 0.5 d |
| **T4 Gatekeepers** | Sonnet | `apps/gatekeepers/**` (inbox classify → submit; `changedBetween` for BUILD; fail-closed reviewer; protected-path policy) | T0 | 0.5 d |
| **T5 Edge** | Haiku | `apps/edge/src/app.ts`, `apps/edge/wrangler.jsonc` (`PROVISIONER_KEYS` service, entrypoint `InboxKeys`), `apps/edge/test/**` | T0 | 0.25 d |
| **T6 Sim** | Sonnet | `apps/queen/src/sim/{sim-ports.ts,sim-v2.ts,worker.ts}`, `apps/queen/test/sim-ports.test.ts` | T0 | 0.5 d |
| **T7 Dashboard** | Sonnet | `apps/dashboard/src/{ItemView.tsx,homeLogic.ts,api.ts,components.tsx,SwarmFloor.tsx}` + a new `PushCode.tsx`, tests | T0 | 0.5 d |
| **T8 Live + docs** | coordinator + user | deploy commands; `docs/HANDOFF.md`, `docs/demo-script.md`, `README.md` | all | Oct 9 |
| **T9a You-pick races** (§10.1–10.3) | Opus | new `apps/queen/src/train/pick.ts` (pure: enter PICKING, pick, re-pick, deadline, cap) + `apps/queen/test/pick.test.ts` from Oct 7 PM; then, **after T1 merges**, the `maybeDecide` branch in `planner.ts`, `watchdogDeadline`, the `pick` RPC and route in `queen-node.ts` / `index.ts`; sim `[you-pick]` in `sim-v2.ts` (after T6) | T0; T1 for the wiring | 0.75 d |
| **T9b Manual reject** (§10.4) | same agent as T9a, after it | `pick.ts` reject / none-of-these; `reject` RPC and route; tests (h)(i) | T9a | 0.25 d |
| **T9c Preference weighting** (§10.5) | Sonnet | `apps/queen/src/models/{router.ts,preference.ts}`, `apps/queen/test/{router.test.ts,preference.test.ts}`; the Model Board column in `apps/dashboard/src/Home.tsx` (or the Model Board component); the event-fold rebuild test | T9a events | 0.5 d, **can slip without blocking T9a/T9b** |
| **T9d Pick UI** | Sonnet | new `apps/dashboard/src/RacePick.tsx` + test, mounted by T7 in the race box under that agreed export name | T0 | 0.5 d |

- **Schedule:** T0 on Oct 7 morning. T1–T7 run in parallel from Oct 7 afternoon to Oct 8. T1b runs Oct 8 if T1 is green. Live on Oct 9.
- **Races schedule:** T9a's pure `pick.ts` and T9d start Oct 7 afternoon. T9a's planner wiring and T9b follow T1 (Oct 8 afternoon to Oct 9). T9c runs Oct 9–10. Each one ships alone, and none blocks the inbox path.
- **Deploy order:** provisioner (new entrypoint) → queen (v14; no active trains, R16) → drones, gatekeepers → edge (binds to the new entrypoint, so two passes are not needed). Check: `pnpm turbo run build typecheck lint test --force --continue`.
- **Cut lines, in order:**
  1. T9c (preference weighting), then T9b, then T9a and T9d (races are independent of the inbox);
  2. T1b;
  3. rescan;
  4. the write-back to the human's branch (the handoff still lands; the human sees the fix on main);
  5. NOTE milestones after the gate verdict.

  The demo spine is: inbox push → gate → REJECT note → handoff → LANDED.

---

## 14. Demo shot (for `docs/demo-script.md`)

**"Here's code, vet it."** About 75 s, recorded after the swarm shot while the 12-item swarm is still landing.

1. Split screen: the dashboard swarm floor (12 drone tiles) and a terminal. Voice-over: *"A PR says 'please review my branch.' QueenOS has an inbox: you push code, and the swarm vets it with the same gates and the same train as the agents. You don't open, shepherd or merge anything."*
2. `git push queen tip-jar`. It returns at once. Within seconds a tile with a **human** badge joins the floor.
3. The change deliberately calls a non-allowlisted host, a deterministic SECURITY reject (no reliance on an LLM REJECT). The tile goes red. `git fetch queen 'refs/notes/*:refs/notes/*' && git log --notes=queen -1` shows the REJECTED note with the finding.
4. Click **Let the swarm fix it**. A REWORK drone starts from the human's commit. Its tile passes and boards a car **next to drone members**, and the merge-train graph shows the human branch merging in the same car.
5. `git pull queen tip-jar` shows the drone's fix on top of the human commit. Then `git log --notes=queen` on it: `LANDED main@…`, then `SHIPPED`.
6. Optional tag: push again with `[review-fail]` in sim to show the LLM reviewer's rejection text.

This closes HANDOFF §6.5's "no reliable live reviewer REJECT" by showing a reliable *gate* REJECT live. The reviewer REJECT stays sim-backed.

---

## 15. Open questions

| # | Question | Recommendation |
|---|---|---|
| Q1 | ~~Inbox per person or per session?~~ | **Decided (user, 2026-10-07): per person, persistent, 24 h tokens** (D12). |
| Q2 | Should the Queen also sync inbox `main` after every landing, not only on open? | No, not by Oct 14. A re-open is cheap, and the response carries `mainSha`. |
| Q3 | **UNVERIFIED:** can a token from `repo.createToken` authenticate to a *different* repo in the namespace? | Probe on Oct 7 with a throwaway pair of repos before T2 merges. If it can, inboxes are not isolated and the design needs per-hive namespaces. |
| Q4 | **UNVERIFIED:** does `revokeToken` take effect at once for in-flight git operations? | Probe alongside Q3. Until then, the docs say "within the TTL". |
| Q5 | **UNVERIFIED:** Artifacts repo-name rules (`INVALID_REPO_NAME`): length and character set for `<hive>-in-<handle>` | The handle is `[a-z0-9]{1,24}` (the email local part, stripped; on a collision, 4 hex from a hash). Probe a 63-character name. |
| Q6 | **UNVERIFIED:** isomorphic-git force-push of a branch head that is behind the remote `main` into a train fork (PIN), and pushing hive-main commits into the inbox from a shallow fetch | The lander already pushes fork commits to another repo at `LAND_DEPTH` (proven live). PIN uses the same depth and deepens once on a missing object. |
| Q7 | Notes push to Artifacts receive-pack | **Verified** (day1 row 1). A non-forced, appending push under contention is UNVERIFIED and is covered by the retry. |
| Q8 | Push event delivery: at-least-once? ordered? | UNVERIFIED. Dedupe makes it safe; rescan covers loss. |
| Q9 | Service-token agents (no Access email; edge `access.ts:153` rejects them) | Post-Oct 14. Agents push through their person's inbox with `Queen-Origin`. |
| Q10 | Should a targeted human submission join an in-flight race? | Stretch only (§2.5). Ranking needs no change. |
| Q11 | Preference granularity: `(model, item kind)` has 4 kinds × ~8 models, so it is sparse at demo volume. | Keep the per-kind key; `confidence = n/(n+5)` keeps sparse cells near neutral. Revisit with a per-hive key after Oct 14. |
| Q12 | Should `judge: human` be the default for `[hard]` items in a `supervised` hive? | No. It stays opt-in; autonomy is the default (D12 keeps auto as the hive default). |
| Q13 | Live previews of 3 candidates for up to 15 min: Worker Preview quota and cost | UNVERIFIED (deploy-discovery has no preview count limit). `maxPickingRaces` 2 bounds it at 6 previews. |

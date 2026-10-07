# QueenOS: agent-native git. Every change is a Submission, and the front door is a git proxy

Status: design, rev 2, 2026-10-07. **Rev 2 (user direction, 2026-10-07): "agent-native git".** The git layer is the product, and the swarm, merge queue, deploy pipeline and SRE are the supporting products that prove it. The front door is a **git proxy** at `https://queenos.kaikeru.com/git/<hive>`. It looks like GitHub, but it isn't: no Artifacts token ever leaves our side. Rev 2 replaces rev 1's per-person inbox forks, `InboxKeys` tokens, the PIN drone and the provisioner `NOTE` op (§16 lists what went away). Builds Oct 8–11; live by Oct 11 and in the demo. Human-judged races (§10) ship separately. Decision D12 in `docs/v2-design.md` §10 (amended by rev 2; record the amendment there in T8).
Read with `docs/v2-design.md` (§1.2 principles, §2.3 lanes and queue), `apps/queen/README.md`, `docs/day1-results.md` (rows 1, 3, 5, 8, 8b, 8c) and the proxy probes (§3.6). Spike code (not in the repo): `scratchpad/proxy-spike/src/index.ts` of the 2026-10-07 session; T2 starts from a copy of it.

Anything marked **UNVERIFIED** has not been checked against the real account or the code.

---

## 1. Problem and pitch

QueenOS lands code only when the Queen asks for it. Today a change exists only because the Queen dispatched a BUILDER drone into a fork it made. People and outside agents (Claude Code, Codex) have no way in. A hackathon judge's first question is "can I push to it?", and the honest answer today is no.

**Agent-native git.** `git clone https://queenos.kaikeru.com/git/demo`, `git push origin HEAD:item/14`. The remote speaks plain git smart-HTTP, so every git client and every coding agent works unchanged. Behind it, the push is not a branch on a shared repo: it is a **Submission**. The proxy checks the rules at push time and answers in the push output (`remote: QueenOS: submission received → item 14`). The swarm vets the code, and the verdict comes back as git notes on the commit.

**A push is a different paradigm from a pull request.**

| | Pull request | QueenOS push |
|---|---|---|
| What the contributor says | "Please review my branch." | "Here's code. Vet it." |
| Who does the work after the push | The contributor opens, shepherds, pings reviewers, rebases and merges. | The swarm does: gates, LLM reviewer, merge queue, integration gate, lander, canary. |
| What the contributor does next | Babysits the PR. | Nothing. They read the verdict (a git note and the dashboard) and either push a fix or hand off to the swarm. |
| Rules | Branch protection, chosen per repo. | The same rules every drone gets, enforced at push time (§4.3) and at the gate. There is no human fast lane. |

**Pitch: "A human's `git push` rides the same train as 12 agents, under the same rules."**

**The bigger claim (user direction, 2026-10-07):** intake is not a side door for humans. It is the **universal intake**. Every piece of code, drone-written included, arrives as a **Submission** ("here's code, vet it"), and the pipeline consumes only Submissions (§2). A drone is just a contributor that the Queen asked for code. A human is a contributor that nobody asked.

---

## 2. Unified intake: Submission

### 2.1 The contract

```
Submission = { repo, ref, headSha, origin: {kind: drone|human|agent, id}, itemId?, provenance? }
```

The pipeline after intake consumes only Submissions:

```
Submission ─▶ train DEPLOYING ─▶ preview ─▶ gate ─▶ PASSED ─▶ car ─▶ MERGE ─▶ integration gate ─▶ LANDER ─▶ release ladder
```

- **Correlated** submissions have a target or an `itemId` (user decision 2026-10-07: the item is the competition). They come from drones the Queen dispatched for an item, or from a human or agent who addresses an item or goal on purpose (§4.4). They **join that item's race** as a candidate (disposition `joined-race`, §2.5).
- **Uncorrelated** submissions have neither, as with a plain `git push origin HEAD:tip-jar`. They are treated as having **already won a race**: intake files a new item (a `feature` whose title is the head commit's subject, disposition `filed`) with **no race record**, and its single train goes straight to gate, car, land. "Already won" means no competition, never no vetting: every gate (policy, security, smoke, reviewer) still applies.
- **Provenance** is metadata only: drone id, model, failed models, usage, race id, candidate index, attempt, `verified`. It feeds races, rework attempt counts, the model router's AIMD floor and stats, and the Model Board. **It is never a separate code path.** A human submission simply has no `model`. The router already ignores models that are not in the catalog (`apps/queen/README.md` "Stats"), so human code never moves the floor.
- For a pushed submission, `repo` is the **train fork the proxy created** (§2.2) and `ref` is the **branch the client pushed** (`refs/heads/item/14`): the supersede key. Physically the code is on the fork's `main`.

### 2.2 Topology: one fork per push, made by the proxy (decided rev 2)

```
git client ──smart-HTTP──▶ edge /git/* (git token) ──service binding──▶ git Worker ──Artifacts token (server-only)──▶ Artifacts
                                                                          │  reads:  hive main  (<hive>, read token)
                                                                          │  pushes: fresh fork <hive>-train-<12hex>, ref → main
                                                                          └─ RPC ─▶ Queen DO (decide, record; notes projection)
```

- **Reads** (`clone`, `fetch`, `ls-remote`) are proxied to the hive's main repo. The proxy advertises only `HEAD` and `refs/heads/main` (plus the synthesized notes refs, §7.5).
- **Every push becomes its own train fork.** The proxy forks hive main into `<hive>-train-<12hex>` (the same name scheme as drone trains), then forwards the client's receive-pack body into it with the ref rewritten to `refs/heads/main`. That fork **is** the train's repo. There is no inbox repo, no PIN copy and no per-person fork. **Proven (§3.6 probe 5):** Artifacts accepts a pack the client built against hive main's advertisement when the receive-pack goes to a fresh fork, including a branch based on an older main (a non-fast-forward rewrite) and a commit built on objects that exist only on a non-default branch of the parent.
- **Why not a per-person inbox behind the proxy?** It would keep a persistent repo per person, a mirror `main` to sync, and a PIN copy into a train fork, so the push would land in a repo that is not the train's. Fork-per-push puts the code where the pipeline already expects it (train fork `main`; `TrainPlanner.cleanUp`, the MERGE drone, `getGateTarget`, the lander all unchanged) and spreads pushes across fresh repos, which is the best shape for the Artifacts per-repo 503 episodes (commit 1deb7ab: a repo goes 503 for 40 s to 7+ min right after a push; a fresh fork is healthy).
- **The "feature inbox" is logical, not a repo.** The *item* is the inbox; candidates arrive in it from any fork.
- **No goal-level fork repo (decided 2026-10-07).** Every submission forks from hive `main`, whatever goal it targets. A physical fork per goal is a long-lived feature branch that drifts from `main`, needs a two-level merge, ships a goal all at once against the swarm's item-by-item landing, and concentrates pushes on one repo. A goal stays a logical grouping in the work ledger; its items land independently.
- **No shared per-item repo:** Artifacts' own guidance is one repo per agent (discovery §1); races need isolated trees.

### 2.3 Why there is no PIN step any more

Rev 1 needed a PIN drone because the human's code sat on a branch of a person-owned inbox repo, which broke every consumer of `train.artifactRepo` (cleanup would delete the inbox, MERGE fetches `main`, one repo had many trains, inbox notes were forgeable, force-pushes could remove `headSha` from under a car). With fork-per-push, **the push itself produces a Queen-owned train fork with the code on `main`**:

| Consumer | Assumption | Fork-per-push |
|---|---|---|
| `TrainPlanner.cleanUp` → `deleteFork` (planner.ts ~1480) | `artifactRepo` is Queen-owned and deleted on MERGED or EJECTED | Holds. The proxy forks under a name the Queen chose (§4.2). |
| MERGE drone `mergeCar` (drones/merge.ts) | It fetches the member fork's `refs/heads/main` | Holds: the ref is rewritten to `main`. |
| `getGateTarget(repo)` (gatekeepers orchestrate.ts:174) | One repo is one train | Holds. |
| Lander `carryNotes` (drones/land.ts:84) | Member-fork notes are Queen-written | Holds: the proxy refuses any push to `refs/notes/*`, and v1 notes are not stored in Artifacts at all (§7.5). |
| Car stability | The member head stays fetchable | Holds: nobody but the Queen's executors holds a token for the fork. A re-push is a new fork. |

The train therefore enters the pipeline exactly where a drone's build result does (`BUILDING` → `DEPLOYING`), with no extra fork, drone start or copy. That saves ~10 s per human submission (rev 1: FORK + drone start + PIN).

### 2.4 Where the code special-cases drones today, and how each case maps onto Submission

| # | Drone-only today | Where | As a Submission |
|---|---|---|---|
| 1 | **Solicitation:** `submit` → `enqueue` → FORK → `dispatchBuilder` (BUILDER, `modelChoice`) | planner.ts `submit`, `enqueue`, `dispatchBuilder` | **Unchanged.** This is how the Queen *asks* for a submission. Unsolicited code gets a **pre-forked train** (§6.1) instead of a BUILDER. |
| 2 | **Completion:** `reportBuildResult` → `buildResult()` → DEPLOYING | planner.ts:804 | **Adapter:** `submissionFromBuildResult(train, r)`, then one `submission()` transition. The proxy's `gitPushed` calls the same `submission()`. |
| 3 | `recordBuild`: model stats, `failedModels`, usage; gate verdict → `model_outcome` | planner.ts `recordBuild`; models/router.ts | Read from `provenance`. An absent `model` means no counting. |
| 4 | Races: `racingRaceOf`, `rankCandidates` (`verified`, `changedBytes`) | train/race.ts | `provenance.raceId` and `candidate`. A human candidate ranks with `verified` absent (§2.5). |
| 5 | `fail()` → `rework()` auto-enqueues a REWORK drone | planner.ts:1426–1465 | Branches on origin. Drone: unchanged. Human or agent: the item goes FAILED ("awaiting contributor") with no auto-rework, unless the contributor handed off (§6.3). |
| 6 | The gate's `builderReasoning` from the BUILDER ledger | gatekeepers orchestrate.ts:178 | Provenance. It is `[]` for humans. |
| 7 | **`collectChange`** finds changed paths from *added* files plus paths named in drone-style commit messages | gatekeepers inspect.ts:186–213 | **Must become `changedBetween(baseSha, head)`** (hive-kit `changedPaths`, base = merge base with hive main) for every BUILD gate. Without it, a human's edit to an existing file is "out of diff", and its policy and security findings become follow-up bugs **instead of failing the gate**. A security bypass for pushed code, and a latent bug for drones. |
| 8 | Scripted test runner: a `[fail]` marker and a `queen(rework)` message prefix | gatekeepers test-runner.ts:14, 64 | Applies to any origin. Documented; harmless. |
| 9 | Gatekeeper filter: train forks only (`TRAIN_REPO_RE`) | gatekeepers event.ts:121 | **Unchanged.** A proxy push lands in a train fork, so the existing gate path picks it up. No inbox classification. |
| 10 | Lander carries notes from member forks | drones/land.ts:84 | Unchanged (`refs/notes/queen` only). v1 notes never exist in Artifacts. |
| 11 | `cleanUp` deletes `artifactRepo` | planner.ts | Unchanged, plus `deleteAfter` for rejected human/agent forks kept for handoff (§6.3). |
| 12 | Sim gate markers keyed on `task.action === "BUILD"` | sim-ports.ts:526–580 | The sim git push enters as a pre-forked BUILD train, so the markers apply as is. |
| 13 | Path claims widen from `BuildResult.changedPaths` | work/ledger.ts `absorb` | The gatekeeper's `changedBetween` result widens the claims (reported with the train result). |

### 2.5 Best-of-N generalises

**The item is the competition.** Every submission that targets an item (§4.4), drone, human or agent, enters that item's race as a candidate. A human's code races the drones under the same gate and the same `rankCandidates` ordering. A human has no `verified` (the builder's verify tool), so they lose ties on that key. External agents are first-class contributors: they push through the proxy with their person's git token, with `Queen-Origin: agent:<name>` in the commit.

**Joining an in-flight race is core, not a stretch.** A `RACING` race gains a candidate (`Race.trainIds` grows; `width` counts only the Queen-dispatched ones).
- A race is created **lazily at width 1** if the targeted item has none.
- `Race.entryClosesAt` bounds entries (null: until decided).
- **Late entry:** the race is decided, the item's code is already in a car, or it has landed. The submission becomes a follow-up item (disposition `late-new-item`). It is never rejected, and the push output says so (§4.3).
- A targeted submission to a READY or FAILED item with no live race becomes that item's next attempt (a width-1 race).
- Joining an ACTIVE non-race build is post-Oct 14.

### 2.6 Delivery: an adapter, not a rewrite

- Drones keep fork and dispatch.
- Their completion emits a Submission inside the Queen: `buildResult()` becomes `submission(submissionFromBuildResult(...))`.
- **The plan (§13) is ordered so the push path ships alone if the drone adapter slips.** The adapter is one task (T1b) with its own tests. Without it, `buildResult()` stays as it is and only pushed submissions use `submission()`.

---

## 3. UX walkthrough

### 3.1 Get a git token (once)

On the dashboard, **Push code** (project header) → **Create git token**. It is shown once, with copy buttons for:

```bash
git clone https://queenos.kaikeru.com/git/demo
# Username: your email (any value works)   Password: <git token>
```

- The token is a **QueenOS git token** (`qgt_…`), minted by the edge behind Access, bound to your Access email, stored only as a hash, valid 30 days by default, revocable at once from the same panel. It is **not** an Artifacts token; it opens nothing but `https://queenos.kaikeru.com/git/*`.
- Git's normal credential flow stores it (macOS keychain, `git credential-manager`, `credential.helper store`). After that, `git clone`, `fetch` and `push` just work, like GitHub with a PAT.
- If you already use `cloudflared`: `git -c http.extraHeader="cf-access-token: $(cloudflared access token -app=https://queenos.kaikeru.com)" clone …` also works (§8.1). No git token needed, but it expires with your Access session.

### 3.2 Push

```bash
git switch -c tip-jar
$EDITOR src/features/tip-jar.js
git commit -am "Add a tip jar at /features/tip-jar"
git push origin HEAD:tip-jar           # uncorrelated: a new item
git push origin HEAD:item/14           # join item 14's race
```

```
remote: QueenOS: submission received → item 3c1e… "Add a tip jar at /features/tip-jar" (new item, fully gated)
remote: QueenOS: train 7a90… · verdict in ~2 min
remote: QueenOS: git fetch origin '+refs/notes/*:refs/notes/*' && git log --notes=verdict -1
To https://queenos.kaikeru.com/git/demo
 * [new branch]      HEAD -> tip-jar
```

The push takes about 4–8 s (the proxy forks hive main first; §3.6). A push that breaks a rule is refused **in the push output** (§4.3):

```
remote: QueenOS: push refused
remote: QueenOS:   refs/heads/main: pushes to main are refused (the lander owns main)
remote: QueenOS: push a branch instead, e.g. git push origin HEAD:item/<id>
 ! [remote rejected] HEAD -> main (pushes to main are refused (the lander owns main))
```

- **Your branch is not stored on the hive remote.** It became a submission in its own train fork. `git fetch` will not show `origin/tip-jar`, and `git fetch --prune` deletes your local tracking ref. Keep working on your local branch and push it again to update the submission.
- The push being accepted means "submission received", never "passed". The verdict is asynchronous.

### 3.3 Read the verdict

```bash
git fetch origin '+refs/notes/*:refs/notes/*'
git log --notes=verdict --notes=review -1
```
```
Notes (verdict):
    REJECTED by SECURITY: fetch to a non-allowlisted host. Push a fix to tip-jar, or hand off: https://queenos.kaikeru.com/p/demo/items/3c1e…

    Queen-Note: v1
    Queen-Kind: verdict
    Queen-Verdict: REJECTED
    Queen-Item: 3c1e…
    Queen-Train: 7a90…
Notes (review):
    Queen-Note: v1
    Queen-Kind: finding
    Queen-Finding: error src/features/tip-jar.js:12 fetch to non-allowlisted host "tips.example.com"
```

- Fetch notes **with their own command** and the leading `+` (§7.5, §11). The notes are a projection of the Queen's ledger, served by the proxy; every fetch returns the current state.
- Later milestones replace the note: `PASSED`, `QUEUED in car <id>`, `CONFLICT`, `LANDED main@<sha>`, `SHIPPED <release>` or `ROLLED BACK`. The note holds the milestones in order, and the **last** `Queen-Verdict` is the current state. The dashboard shows the same item with a **human** (or **agent**) origin badge.

### 3.4 Fix it yourself, or hand off to the swarm

- **Fix:** commit and `git push origin HEAD:tip-jar` again. Intake reopens the same item (§6.2). Put `Queen-Replies-To: <rejected sha>` in the commit to link the chain.
- **Hand off:** press **Let the swarm fix it** on the item page (`workAction: handoff`), or put `Queen: rework` in the commit message up front. A REWORK drone starts from *your* head (its train fork is forked from your rejected submission's fork), applies the findings and goes through the gate. To get its fix before it lands:
  ```bash
  git pull https://queenos.kaikeru.com/git/demo/t/<trainId> main     # read-only view of one train fork
  ```
  The REWORK's verdict note names the train. After it lands, the fix is on `origin/main` anyway.
- **Addressing** (user decision 2026-10-07). Branch `item/<id>` targets that item. Branch `goal/<slug>` resolves to the goal's single item when it has exactly one; otherwise it files a new item under that goal (no guessing). Any other branch is uncorrelated. **Resolution now happens at push time**, so an unknown item is refused in the push output (§4.3).
- **Trailers** (head commit only, case-insensitive; see `parseSubmissionTrailers`):
  - `Queen: rework`: hand off automatically on a reject.
  - `Queen-Item: <itemId>`: target an existing item. The branch name `item/<itemId>` does the same.
  - `Queen-Origin: agent:<name>`: declare that an agent wrote this.
  - `Queen-Replies-To: <sha>`: this commit answers that rejected commit.

### 3.5 External agents

Exactly the same commands. The agent gets the git token through the environment (`QUEENOS_GIT_TOKEN`) and a credential helper, never in the URL. See `docs/agent-protocol.md` and the Claude Code plugin at `plugins/queenos/`.

### 3.6 Probe evidence (2026-10-07, local `wrangler dev` with the Artifacts binding `remote: true`, real account, stock git 2.50.1)

| # | Probe | Result | Evidence |
|---|---|---|---|
| 1 | Read path: `info/refs` + `git-upload-pack`, streaming | **WORKS** | `git clone` through the proxy with `protocol.version` 2, 1 and 0, and `--depth 1`, all gave the right tree. Upstream v2 caps: `ls-refs=unborn`, `fetch=shallow filter sideband-all`, `object-format=sha1`, `agent=gitty/1.0`. Stock git requests `sideband-all`. |
| 2 | Write path: receive-pack (v1), body streamed | **WORKS** | Small pushes (Content-Length kept with `FixedLengthStream`) and a **20 MB incompressible push** sent by git with chunked encoding: upstream fetch started at 1 ms, body chunks forwarded from 1 ms to 1609 ms, never buffered; Artifacts accepted the chunked body (`unpack ok`), push 12.4 s total. Artifacts advertises only `report-status delete-refs ofs-delta side-band-64k`. |
| 3 | Pre-receive: parse commands, reject before forwarding | **WORKS** | Push to `main` → `remote: QueenOS: …` lines plus `! [remote rejected] HEAD -> main (pushes to main are refused …)`, exit 1, nothing forwarded (reject in 1 ms). Also tested: a two-ref push (the other ref reported "atomic push refused") and a branch delete. |
| 4 | `remote:` messages on success | **WORKS** | Sideband-2 packets injected before the final flush render as `remote: QueenOS: submission received -> item 14 (joined its race)` in stock git. (The spike buffers the upstream report, which is under 1 KB, then re-emits it.) |
| 5 | Redirect a push into a fresh fork B of A, ref rewritten | **WORKS** | Advertisement from A, POST to new fork B: `refs/heads/item/77` → B `refs/heads/main` (old = B's main) accepted; B's log shows the commit on main. Also accepted: a commit built on a branch that exists **only in A** (not in B's refs; `defaultBranchOnly` fork), and B's full clone passes `git fsck` (forks carry all of A's objects); a branch based on an **older** main (non-fast-forward rewrite onto B main); a rewrite to a new ref `refs/heads/submission` (zero old). Fork on the push path took 3.3–6.4 s (day 1: ~2 s). The report-status is rewritten back to the client's ref name, so git shows `* [new branch] HEAD -> item/77`. |
| 6 | Notes fetch | **WORKS (option c)** | The proxy answered v2 `ls-refs` (prefix `refs/notes/`) and `fetch` itself with a pack it built (blobs, a notes tree, a parentless commit; zlib via `CompressionStream("deflate")`, SHA-1 via Web Crypto). Stock git: `* [new ref] refs/notes/verdict`, `git log --notes=verdict --notes=review` shows the notes on commits that live only in forks; `git fsck` clean. A changed ledger gives a new commit: `+` refspec → `(forced update)`; without `+` → `! [rejected] (non-fast-forward)`. A mixed refspec (heads + notes in one fetch) gets heads only (by design, §7.5). |
| 7 | Limits and Access | **Partly verified** | Stock git against the live host: `302` to `kaikeru.cloudflareaccess.com/cdn-cgi/access/login/…` → `fatal: unable to update url base from redirection` (Basic auth ignored). So git cannot pass Access as configured. Limits from docs: Workers request body 100 MB (Free/Pro), 200 MB (Business); Paid CPU 30 s default, 5 min max; **no wall-clock limit for HTTP while the client is connected**; 128 MB memory. `cloudflared access token -app=…` + `cf-access-token` header is documented for CLI clients (UNVERIFIED here: cloudflared not installed). Access path rules: the most specific path wins, so a `/git` app with its own policy overrides the host app (docs; UNVERIFIED on this account). |

---

## 4. Architecture and sequence

**Rule kept:** the Queen decides, records and dispatches. Every Artifacts call runs in an executor. **The git Worker is the intake executor:** it is synchronous because git waits on the HTTP response, the same shape as the Vault's `VaultWriter` entrypoint. It asks the Queen before it forks and reports after it pushes; it never decides.

### 4.1 Components

| Component | Responsibility |
|---|---|
| **edge** (`apps/edge`) | `/git/*` route **outside the Access middleware**: authenticates the git token (Basic password or `Authorization: Bearer`) or an Access JWT in `cf-access-token`; 401 with `WWW-Authenticate: Basic realm="QueenOS"` otherwise; rate-limits failures; forwards to the git Worker over a service binding with `x-queen-user` (never trusts a client value). Behind Access: `POST/GET/DELETE /api/git-tokens` (mint, list, revoke). Tokens live hashed in the `HiveRegistry` DO SQLite (`git_tokens`). |
| **git Worker** (`apps/git`, new, `queenos-git`, `workers_dev:false`, no routes) | Smart-HTTP proxy. Artifacts binding; Queen DO binding (`script_name: "queen"`). Reads: hive main with a **read** token, advertisement filtered to `HEAD` + `refs/heads/main`, upload-pack streamed, GET and (small, buffered) POST retried on 503. Notes: v2 `ls-refs` / `fetch` for `refs/notes/{verdict,review,provenance}` answered from the Queen's projection (§7.5). Writes: pre-receive (§4.3), Queen `gitIntent`, fork, readiness probe, ref rewrite, streamed body, report-status rewrite, `remote:` lines, `readCommit`, Queen `gitPushed`. Read-only `/git/<hive>/t/<trainId>` for one train fork. Artifacts tokens exist only in module memory, minted per repo, never logged. |
| **Queen** (`work/inbox.ts`, planner, queen-node) | RPCs `gitIntent` (pre-decision: rules that need state, dedupe, caps, target resolution, train id and fork name), `gitPushed` (the Submission: file, join or reopen the item, supersede; the train enters DEPLOYING), `gitAborted`, `notesFor` (the v1 notes projection). `handoff`, `deleteAfter` for rejected human forks, intent watchdog. |
| **gatekeepers** | Unchanged event path (a train fork push). `changedBetween(baseSha, head)` for every BUILD gate; a non-drone origin fails closed when the reviewer is unavailable; protected-path policy. Findings go to the Queen (`appendAudits`), never to notes. |
| **drones / provisioner** | REWORK takes its brief as the rendered v1 note text in the task (§7.2) and writes `Queen-Replies-To`. Provisioner `FORK` gains an optional `from` repo (seeded REWORK forks the rejected submission's fork). No `NOTE` op, no `InboxKeys`. |
| **dashboard** | **Push code** panel (clone URL, create, list and revoke git tokens), origin badge, **Let the swarm fix it**. |

### 4.2 Sequence (a human `git push origin HEAD:item/14`)

```
git client        edge            git Worker                    Queen (decide)                 Artifacts
  │ GET info/refs?service=git-receive-pack ──▶ token ok ──▶ advert of <hive> (HEAD, main) ─────────────────────▶│
  │◀──────────────────────────────────────────────────────── filtered advert ◀──────────────────────────────────│
  │ POST git-receive-pack (cmds + pack) ─▶│──────────────▶│ read cmds (pkt-lines), local rules                   │
  │                                       │               │── gitIntent{user, ref, old, new} ─▶│ dedupe, caps,  │
  │                                       │               │                                    │ resolve item/14│
  │                                       │               │◀─ accept{trainId, repo, item} ─────│ train BUILDING │
  │                                       │               │── fork <hive> → <hive>-train-x ───────────────────────▶│ ~2–6 s
  │                                       │               │── GET info/refs on the fork (503 → re-fork -rN) ──────▶│
  │                                       │               │── POST receive-pack: old(main) new refs/heads/main + streamed pack ─▶│
  │                                       │               │◀─ report-status ok ────────────────────────────────────│
  │                                       │               │── readCommit(new) ────────────────────────────────────▶│
  │                                       │               │── gitPushed{trainId, headSha, baseSha, title, msg, trailers} ─▶│ submission():
  │                                       │               │◀─ {disposition, itemId, messages} ─│ joined-race, DEPLOYING │
  │◀── remote: QueenOS … + ok refs/heads/item/14 ─────────│                                    │                │
  │                                                         (fork push event → gatekeeper → preview → gate, unchanged)
```

- `gitIntent` returns `refuse{reason}` for state rules (duplicate, over cap, unknown item, hive archived); the proxy drains the body and answers `ng` with `remote:` lines. Nothing is forked.
- If the fork, push or `readCommit` fails, the proxy calls `gitAborted{trainId, reason}` (the Queen ejects the train with no attempt and deletes the fork) and answers `ng <ref> transient: retry the push`. If the proxy dies, the Queen's intent watchdog does the same after 10 min.
- **Latency:** the push takes about 4–8 s (fork 2–6 s plus the upload). After it: push event 2–5 s, preview deploy, gate 30–90 s. **The first verdict note is readable about 1.5–2.5 minutes after `git push`** (UNVERIFIED end to end); rev 1's PIN step (~10 s) is gone.

### 4.3 Pre-receive rules (push time)

Local (proxy, no state; evaluated on the command pkt-lines before the pack is read):

| Rule | Refusal text |
|---|---|
| Exactly one ref update per push | `push one branch per submission` |
| Only `refs/heads/*` (no tags, no `refs/notes/*`, nothing else) | `only branches can be pushed` |
| Not `refs/heads/main` (or the hive's default branch) | `pushes to main are refused (the lander owns main)` |
| No deletes (`new` = zeros) | `branch deletion is refused` |
| Branch name: `item/<id>` / `goal/<slug>` with `[A-Za-z0-9_-]{1,64}`, or any other valid ref | `bad target: item/<id> takes [A-Za-z0-9_-]{1,64}` |
| Token scope `push`; hive exists | `this token cannot push` / `no hive <hive>` |
| Pack size ≤ 50 MB (counted while streaming; abort the upstream request, delete the fork) | `push too large (50 MB cap)` |

Queen (`gitIntent`, state):

| Rule | Outcome |
|---|---|
| `(hive, headSha)` already submitted | refuse: `already submitted as item <id> (train <t>)` |
| More than `maxInboxOpenPerContributor` open items, or `maxInboxPushesPerHour` | refuse: `over cap: 3 open items; wait for a verdict` |
| `item/<id>` unknown | refuse: `no item <id> in <hive>` |
| `item/<id>` race decided, in a car or landed | **accept** as `late-new-item`: `item <id> already decided; filed follow-up item <id2>` |
| Hive `paused` or budget exhausted | **accept**; `queued: hive paused` (the train waits) |
| Re-push of the same `(user, ref)` before boarding | **accept**, supersede: `replaces your earlier push <sha> (train <t>)` |

Content rules that need the diff (protected paths `.queen/**`, `wrangler.*`, `package.json` from a non-drone origin; 500-file cap; scans) stay at the gate, because the proxy never inflates the pack. The proxy could reject them at push time later by indexing the pack (post-Oct 14).

### 4.4 Addressing

`item/<id>` → that item (join its race; §2.5). `goal/<slug>` → the goal's single item if it has exactly one, else a new item under the goal. Anything else → uncorrelated, a new `feature`. A `Queen-Item` trailer overrides an uncorrelated branch name; it is applied in `gitPushed` (the proxy reads the commit after the push), so a bad `Queen-Item` trailer cannot be refused at push time: it files a new item and the `remote:` line says so.

---

## 5. Contracts (`packages/queen-types`)

T0 is **done** (inbox, Submission, race and pick contracts; SQLite v14). Rev 2 adds, in **T0b** (one owner for `notes.ts`, `git.ts`, `inbox.ts`, `index.ts`, `index.test.ts`):

```ts
// git.ts (new)
export const GitPushIntentSchema = z.object({
  hive: HiveSlugSchema, user: z.string().email(),           // from the edge, never the client
  ref: z.string().regex(/^refs\/heads\/.+/), oldSha: Sha40, newSha: Sha40,
});
export const GitIntakeDecisionSchema = z.discriminatedUnion("verdict", [
  z.object({ verdict: z.literal("accept"), trainId: z.string(), repo: z.string(),   // <hive>-train-<12hex>
             messages: z.array(z.string().max(200)).max(5) }),
  z.object({ verdict: z.literal("refuse"), reason: z.string().max(200), messages: z.array(z.string().max(200)).max(5) }),
]);
export const GitPushedSchema = z.object({
  hive: HiveSlugSchema, trainId: z.string(), repo: z.string(), ref: z.string(), headSha: Sha40,
  baseSha: Sha40,                                             // hive main at fork time (the gate computes the merge base)
  title: z.string().max(120), message: z.string().max(4000), trailers: z.record(z.string(), z.string()),
});
export const GitPushedResultSchema = z.object({
  disposition: SubmitDispositionSchema, itemId: z.string(), messages: z.array(z.string().max(200)).max(5),
});
export const GitTokenSchema = z.object({
  id: z.string(), email: z.string().email(), scopes: z.array(z.enum(["read", "push"])).min(1),
  createdAt: z.number().int(), expiresAt: z.number().int(), lastUsedAt: z.number().int().nullable(),
  revokedAt: z.number().int().nullable(),
});
export const GitTokenMintResultSchema = GitTokenSchema.extend({ token: z.string() });  // shown once; never stored
export const NotesProjectionSchema = z.object({
  ref: z.enum(["refs/notes/verdict", "refs/notes/review", "refs/notes/provenance"]),
  version: z.number().int(),                                  // ledger version: cache key
  notes: z.array(z.object({ sha: Sha40, text: z.string().max(8000) })).max(1000),
});
```

- `SubmitOutcomeSchema.outcome` gains `refused:duplicate`, `refused:over-cap`, `refused:unknown-item`, `refused:rule`, `aborted:transient`. The `ignored:inbox-main`, `ignored:unknown-inbox`, `ignored:revoked` values stay in the enum for old rows, unused.
- `InboxSchema` and `InboxOpenResultSchema` are **deprecated** (kept exported, unused). The v14 `inboxes` table stays (additive migration), unused.
- `DroneTaskSchema.seed` stays but means "fork from this repo" (`{repo, headSha}`); `writeBack` is dropped from use. `DroneTaskSchema` gains `brief?: string` (rendered v1 note text). `ProvisionCommandSchema` FORK gains `from?: string`. The `NOTE` op stays in the schema behind its non-destructive guard and is never sent.
- **T0b fixes in `inbox.ts`:** `TRAILER_RE` (inbox.ts:183, today `/^(queen(?:-[a-z]+)?)\s*:\s*(.+?)\s*$/i`) must accept multi-segment keys such as `Queen-Replies-To` (`/^(queen(?:-[a-z]+)*)\s*:\s*(.+?)\s*$/i`), with a test. The note summary line must **not** start with `queen:` (it would parse as a `Queen:` trailer); the renderer starts it with the verdict word (`REJECTED by SECURITY: …`).
- Sim and Queen routes keep `POST /hives/:hive/sim/…` shapes (§12).

**Naming clash** (done in T0): `WorkPlanResult.submissions` → `dispatches`.

**SQLite v14** (as built): see rev 1 (`inboxes`, `submissions`, race and pick columns, `model_preference`). Rev 2 needs no Queen migration: an intent is a train row in BUILDING with `forkState` PENDING and `origin` set; `submissions` rows record outcomes including `refused:*`. The edge `HiveRegistry` gains `git_tokens(id PK, email, hash UNIQUE, scopes, created_at, expires_at, last_used_at, revoked_at)` (its own migration, T3).

---

## 6. State-machine changes

### 6.1 Trains

There are no new phases.
- A **pre-forked train** is a BUILD-lane train created by `gitIntent` in BUILDING with `forkState: PENDING` and no drone. `gitPushed` moves it through `submission()` (same guards as `buildResult()`: phase BUILDING, stale and duplicate checks) to DEPLOYING; `forkState` becomes READY.
- `gitAborted`, or the intent watchdog (10 min without `gitPushed`), ejects it with no attempt charged and deletes the fork if it exists.
- `TrainAction` does **not** gain `PIN` (rev 1 plan dropped).

### 6.2 Items (WorkPlanner, pure `work/inbox.ts`)

| Event | Rule |
|---|---|
| **Correlated** push (`item/<id>`, `goal/<slug>`, or `Queen-Item`) | Disposition **`joined-race`**: the head enters the resolved item's race as a candidate. A race is created lazily at width 1 if the item has none; `entryClosesAt` bounds entries. |
| **Uncorrelated** push | **Already won a race**: disposition **`filed`**, a new item with no race record; its single train goes straight to gate, car, land. Every gate still applies. |
| **Late entry** (race decided, code in a car, or landed) | Disposition **`late-new-item`**: a follow-up item ("<title> (follow-up)"). Never a rejection; the push output says so. |
| New `(user, ref)`, uncorrelated | File a `feature`: title = head subject, body = head message, acceptance = `- ` lines under an `Acceptance:` line. Then **READY**, skipping TRIAGE. `paths: []`, so it is optimistic; the gate's `changedBetween` widens the claims. |
| Duplicate `(hive, headSha)` | Refused at push time (`refused:duplicate`). The dedupe key is the head SHA; `(user, ref)` is the supersede key. |
| Re-push to `(user, ref)` while its train is **not yet in a car** | Eject the old train (`superseded by push <sha>`, no attempt charged, fork deleted), and the new pre-forked train takes its place for the same item. |
| Re-push while the train **is in a car**, or the item is LANDED or SHIPPED | File a **new** item ("<title> (follow-up)"). The earlier code lands on its own. |
| Re-push to a **FAILED** item | FAILED → READY (attempts + 1). |
| Gate reject (any check) on human or agent origin | Train EJECTED; item **FAILED** with `blockedReason "awaiting contributor"`; the fork is kept (`deleteAfter` = 24 h or until the item leaves FAILED) for handoff. **No escalation and no auto-rework.** The note tells the contributor. |
| …with `Queen: rework` or `workAction handoff` | `rework()` as for drones: a REWORK train **forked from the rejected fork** (`seed`), under `maxReworks`. |
| Merge conflict or integration failure | As for drones (D7), but not automatic for human/agent origin: FAILED plus a verdict note ("conflicts with work that landed: src/x.js; rebase on `origin/main` and push, or hand off"). |
| Caps | Refused at push time over `maxInboxOpenPerContributor` / `maxInboxPushesPerHour`. `maxOpenItems` and the daily budget apply as for any item. `paused` holds the item READY. |

**Autonomy and the error budget are unchanged.** Pushed code auto-ships when the budget is green. A rollback of a release that carries pushed code is a real change failure, the P0 goes to the swarm, and the commit's note gets `ROLLED BACK`. Same rules means same consequences.

### 6.3 Handoff: human and agent on one item

1. The Queen decides to rework (ledger: attempts, `maxReworks`, origin, handoff). The provisioner forks the **rejected submission's fork** (`FORK from`), so the REWORK train's `main` is the human's head. No PIN, no copy.
2. The REWORK drone's brief is `DroneTask.brief`: the v1 verdict and findings text rendered by the T0b renderer from the ledger, byte-identical to what `git log --notes` shows the human (§7.2).
3. It reports `BuildResult` (a Submission with origin `drone`, item linked). Its commit message carries `Queen-Replies-To: <rejected sha>`, and its projected note does too.
4. **No write-back** to anybody's branch (there is no inbox). The human fetches the fix read-only from `/git/<hive>/t/<trainId>` (§3.4), or from `origin/main` once it lands.

---

## 7. Notes are the protocol, the ledger is the truth

Decided by the user, 2026-10-07. Rev 2 keeps the protocol (7.1–7.4, 7.8, 7.9) and changes **where notes live**: they are a projection of the ledger served by the proxy, never stored in Artifacts.

### 7.1 Principle

Git notes are QueenOS's **outward feedback protocol for humans and agents**. Verdicts, review findings, rework briefs and provenance are attached to the exact commit they judge. They travel with `fetch` and show up in `git log --notes=...`, with no SDK or API needed. Any agent that speaks git can close the loop: fetch the notes, read the rejection, fix, push.

### 7.2 Rework reads notes

The Queen **decides** rework from its SQLite ledger and dispatches the drone. The REWORK drone's brief is the v1 note text for the rejected commit, rendered by the same T0b renderer the proxy uses, so it is exactly what a human or external agent reads. The rework commit carries `Queen-Replies-To: <rejected sha>`, so the chain (reject, rework, reject, rework, pass) can be followed in plain `git log --notes`.

### 7.3 Notes are never authority

- The Queen decides **only from its ledger**. Notes are a projection of it, regenerated on every fetch.
- Nobody can write a v1 note: the proxy refuses pushes to `refs/notes/*`, and v1 notes are not stored in any Artifacts repo. Rev 1's forged-note problem (an inbox owner writing `Queen-Verdict: PASSED`) is gone.
- Drones still treat a brief as information, never permission. A note can tell a drone what to fix; it can never make code pass, land or skip a gate.
- A note a client fetched earlier and kept locally can be stale or edited locally; only a fresh fetch from the proxy is the current verdict.

### 7.4 Note format v1

A human-readable summary line, an optional body, then trailer lines. Each entry at most `MAX_NOTE_TEXT` (2000 characters, `executors.ts`); a commit's note holds its entries in order (newest last), at most 8 KB.

```
<summary line>               (starts with the verdict word, never "queen:")

<optional body>

Queen-Note: v1
Queen-Kind: verdict | finding | rework-brief | provenance | memory
Queen-Verdict: PASSED | REJECTED | INFRA | LANDED | SUPERSEDED   (kind verdict)
Queen-Item: <itemId>
Queen-Train: <trainId>
Queen-Trace: <traceId>
Queen-Origin: drone:<id> | human:<email> | agent:<id>
Queen-Model: <model id>                     (when a drone)
Queen-Finding: <severity> <path>[:<line>] <message>   (repeatable)
Queen-Replies-To: <sha>                     (a rework answering a rejection)
Queen-Memory: <memoryId> used|ignored        (repeatable; kind memory)
```

- **Unknown keys are ignored** (forward compatible); `Queen-Note: v1` is the version gate.
- **Contract (T0b):** a Zod schema plus a renderer and a parser in `packages/queen-types/src/notes.ts`. The renderer clips the body and findings to fit 2000 characters (findings dropped last-first, with a "+N more" line). The parser follows `parseSubmissionTrailers` (`inbox.ts`, with the multi-segment `TRAILER_RE` fix): case-insensitive keys, trailers on lines of their own, validated ids. The Queen, the proxy, the drones and the plugin all use these helpers; nobody hand-formats a note.
- `refs/notes/queen` stays the **internal** Cognitive Ledger (`GitNotesPayload` JSON on hive-main commits, hive-kit `NOTES_REF`), unchanged, written by drones and the lander. Never parse it as v1, never write v1 to it.

### 7.5 Where notes live: synthesized by the proxy from the ledger (decided rev 2)

| Ref | Holds | Source |
|---|---|---|
| `refs/notes/verdict` | verdicts and milestones, rework briefs (v1) | Queen `notesFor(hive, ref)` projection |
| `refs/notes/review` | findings (from the gatekeeper's `appendAudits`) | same |
| `refs/notes/provenance` | model, trace, memories (kinds `provenance`, `memory`) | same (from the drone's `BuildResult` provenance) |
| `refs/notes/queen` | internal Cognitive Ledger JSON | Artifacts hive main (existing); **not** advertised by the proxy |

**How it works.** On a v2 `ls-refs` whose `ref-prefix` list contains only `refs/notes/` (and the `refs/tags/` git adds for tag following), the proxy answers itself with the three refs. Each ref points at a deterministic, parentless notes commit: one blob per annotated commit (its entries, newest last), one flat tree keyed by the 40-hex SHA, a fixed author and timestamp. On a `fetch` whose wants are all such commits, the proxy builds the pack (no deltas; `CompressionStream("deflate")` and Web Crypto SHA-1) and answers with `acknowledgments/ready` or straight `packfile`, honouring `sideband-all`. An unchanged ledger gives the same SHA, so the client fetches nothing. The projection is bounded (the last 1000 annotated commits per ref, about 30 days) and cached per `(hive, ref, version)`. Proven in probe 6 (§3.6).

**Options considered:**

| Option | Verdict |
|---|---|
| (a) A per-hive notes repo, with the proxy merging info/refs from two repos | Rejected. Every note is a push, and every push puts that repo into a 503 episode (40 s to 7+ min, 1deb7ab), so the busiest notes repo would be sick most of the demo. A mixed fetch (heads + notes) cannot be served by one upstream without splicing two packs. Needs the NOTE op, retries and contention handling. |
| (b) The Queen writes notes into the hive main repo's notes refs | Rejected. It multiplies pushes to the one repo that every clone, fork and landing reads, so its 503 episodes would hit the whole pipeline. It still needs the NOTE op with append-retry under contention. |
| (c) The proxy synthesizes notes refs from the Queen's ledger | **Chosen.** Zero Artifacts writes for feedback, no contention, no forgery, always current, works for commits that live only in forks. Cost: a small pack builder in the proxy (~150 lines in the spike). |

**Rules for clients** (and the plugin):
- Fetch notes on their own: `git fetch origin '+refs/notes/*:refs/notes/*'`. A fetch that mixes heads and notes gets heads only (the proxy does not advertise notes then). A pack-splicing mixed fetch is a post-Oct 14 option (rewrite the pack header count and trailer).
- The leading `+` is required: each ledger change is a new parentless commit (a forced update). Local notes refs are a cache of the server's; never edit them.
- Protocol v2 only (git ≥ 2.26 defaults to it). A v0/v1 client sees no notes refs.

### 7.6 Timing

There are no notes writes, so there is no note push contention and no 503 interaction. A note becomes visible as soon as the ledger event that causes it commits (gate verdict, conflict, integration failure, LANDED, SHIPPED, ROLLED BACK). Drone submissions get notes too (they are free now), so a landed commit's history shows the swarm's verdicts.

### 7.7 Carry-forward

`Queen-Replies-To` links rework to the rejected sha. The lander's `carryNotes` keeps carrying only `refs/notes/queen` (internal) into hive main. v1 notes need no carrying: the projection covers every submission head, plus `LANDED main@<sha>` names the landed commit.

### 7.8 Memory bonus

A `Queen-Kind: memory` note on `refs/notes/provenance` records which hive memories the builder was given and which it cited (`Queen-Memory: <memoryId> used|ignored`, repeatable). This closes the HANDOFF gap "the dashboard shows recalled memories but not whether the builder used them".

### 7.9 External agents

An outside agent needs only git: `docs/agent-protocol.md` (clone, push, fetch notes, parse the trailers, fix, re-push) and `plugins/queenos/`.

---

## 8. Security model

### 8.1 Authentication (decided rev 2)

Stock git cannot pass Cloudflare Access: probe 7 shows a `302` to the Access login page and `fatal: unable to update url base from redirection`. Git sends only `Authorization` (Basic/Bearer) or configured extra headers, never the browser's `CF_Authorization` cookie.

| Option | Friction | Verdict |
|---|---|---|
| `cloudflared access token -app=…` sent as `cf-access-token` via `http.extraHeader` | Install cloudflared; token expires with the Access session (24 h); per-command header plumbing | Supported as a secondary path (verified in the Worker with the existing `access.ts` verifier, same `aud`), not the default |
| Access service token (`CF-Access-Client-Id/Secret` headers) | Per-agent secret pair; Access-team admin work; no person attached | Post-Oct 14 (Q9) |
| **QueenOS git token** minted on the dashboard (behind Access), sent as the Basic password | Copy once; git's credential helper remembers it, exactly like a GitHub PAT | **Chosen** |

- **Access configuration (T8, manual):** add a second self-hosted Access app for `queenos.kaikeru.com/git` with a **Bypass** policy. The most specific path wins (Access app-path docs), so `/git/*` reaches the edge without the Access login while everything else stays behind Access. The edge's `/git/*` handler is the only gate there. Deploy the edge's git-token check **before** adding the bypass.
- **Token:** `qgt_<32 random bytes, base32>`, minted only by `POST /api/git-tokens` behind Access, bound to the Access email, stored as SHA-256 (lookup by hash, so no timing oracle), scopes `read` / `push`, TTL 30 days (max 90), `last_used_at` updated at most once per minute, revocation immediate (checked on every request). The plaintext is shown once and never logged.
- **Rate limits:** failed git auth per IP and per token id (Workers rate-limit binding, or a counter in the registry DO), plus per-user caps at `gitIntent`.

### 8.2 Controls

| Concern | Control |
|---|---|
| Artifacts tokens | Never leave the git Worker. Minted per repo through the binding, cached in module memory (≤ 1 h TTL), never logged, never in a response. Hive main gets a **read** token; only fresh train forks get write tokens. A bug in the proxy cannot write hive main. Rev 1's Q3/Q4 (cross-repo token reach, revocation latency) become moot. |
| A human bypasses the gates or the LANDER | Every push lands in a new Queen-named train fork; hive main is written only by the LANDER. Pre-receive refuses `main`, deletes, tags and notes before anything is forwarded. |
| Who is the contributor | The **git token owner** (Access email at mint time), passed by the edge as `x-queen-user`, never the commit author. `Queen-Origin: agent:x` is a claim within the owner's accountability. |
| Untrusted code | Same exposure as LLM code: Worker Preview per train, policy, security and allowlist scans, reviewer, integration gate, staging, Sentinel. **Fix required (T4):** scan `changedBetween(baseSha, head)` (§2.4 row 7). Changes to `.queen/**`, `wrangler.*` and `package.json` from a non-drone origin are a policy **error**. |
| Reviewer fails open | For drones it fails open on infra (orchestrate.ts:406). For human or agent origin it **fails closed** (`cause: "infra"`, re-gated, never passed unreviewed). |
| Abuse | Caps checked in `gitIntent` **before** the fork (so a flood costs no Artifacts operations); `(hive, headSha)` dedupe; 50 MB pack cap enforced while streaming; Workers body limit 100 MB (Free/Pro zone); global `maxOpenItems` and budget. Artifacts limits: 32 MB per blob, 1 GB per repo. |
| Forged notes | Impossible outward: notes are synthesized from the ledger and `refs/notes/*` pushes are refused. |
| Read exposure | Any valid token (scope `read`) can clone hive main and read every verdict in that hive. The same population can already read the dashboard (`@kaikeru.com` behind Access). Per-hive scoping of tokens is post-Oct 14. |
| Proxy as a confused deputy | The git Worker has no public route (`workers_dev:false`, no routes); it is reachable only through the edge's service binding, and it trusts `x-queen-user` only from there. Repo names come from the Queen (`gitIntent`) or the hive registry, never from the URL beyond the hive slug and a `trainId` it validates against the Queen. |

---

## 9. Failure modes

| Failure | Behaviour |
|---|---|
| Hive main in a 503 episode (after a landing push) | The proxy retries `info/refs` and buffered upload-pack POSTs with backoff (3×, 2/4/6 s), then answers 503 with `Retry-After`; git prints the error and the user retries. Pushes do not read hive main except the fork itself (which may inherit the episode, next row). |
| Fresh fork inherits a 503 episode (1deb7ab) | Before reading the pack, the proxy probes `GET info/refs?service=git-receive-pack` on the fork and re-forks under `-rN` on 503 (the provisioner's pattern). The body has not been read yet, so nothing needs replaying. |
| Upstream receive-pack fails mid-stream | The body cannot be replayed. The proxy answers `ng <ref> transient error, retry the push`, calls `gitAborted` (fork deleted, no attempt). |
| Proxy dies between `gitIntent` and `gitPushed` | The intent watchdog ejects the train after 10 min and deletes the fork. The client saw an HTTP error and can retry; the head SHA is not marked submitted until `gitPushed`. |
| Push accepted but the push event is lost or late | The train is already DEPLOYING (the Queen learned of it synchronously). The gate waits for its event as for any drone train; the existing gate watchdog covers loss. |
| Branch shares no history with main | The gate's merge-base computation fails; the item goes FAILED with a verdict note ("no merge base with main"). |
| Branch based on an old main | Accepted (probe 5 non-fast-forward case). The gate diffs from the merge base; the car's integration gate (3-way merge onto the tip) is the safety net, and a conflict leads to a verdict note. |
| Large push slower than the client's patience | No Worker wall-clock limit while the client is connected; CPU stays low because the body is piped. The 50 MB cap bounds it. |
| `notesFor` RPC fails | The proxy answers the notes `ls-refs` with no refs (the client sees nothing new) and logs; the dashboard still has the verdict. Never a wrong note. |
| Hive `paused` or budget exhausted | Accepted at push time with `queued: hive paused`; the item waits READY with `waitReason`. |

---

## 10. Human-judged races (you pick)

**Pitch: "Show me three live versions of this feature and I'll pick."** You get an A/B choice before merge, instead of after deploy. It is separately shippable (T9) and does not need the git proxy.

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
| **Machines first (pre-review)** | Only candidates that passed **every** gate enter PICKING: policy, security, preview smoke, and the LLM reviewer against the item's acceptance criteria. "Plain wrong" never reaches a human. **0 pass** → the normal ABANDONED → REWORK path, with no human. **Exactly 1 pass** → auto-decide (no real choice), `by: "queen:single"`. Pushed submissions in a race get the same pre-review (§2.5). |
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
  - **After that:** it files a **targeted Submission** of B's head (`repo` = B's train fork, `itemId` = the item, origin `human`). This is §2's machinery: a loser's fork is just another submission fork, already Queen-owned, so no new fork is needed. If the winner already landed, the item gains a follow-up item.
  - The deferred delete is a planner flag (`deleteAfter`) checked in the alarm.
- **Preference data.** Picks are recorded per `(model, role)` in `model_stats` as `picks` and `picksAgainstRecommendation`. The Model Board shows a "human picks" column. §10.5 turns picks into a capped routing signal (T9c).
- **Your own version in the race.** With §2.5 (core), a human's targeted submission to a RACING item joins as a candidate, so the picker compares the agents' versions with their own.

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
- `RaceSchema` gains `entryClosesAt`, `pickDeadlineAt`, `recommendedTrainId`, `recommendReason`, `decidedBy`, and `rejections: {trainId, by, reason}[]`; `width` minimum is 1.
- `HiveSettings.race` gains `judge` and `pickWindowMs` (optional until T9a adds them to `effectiveSettings`).
- `SubmitPrompt`, `FileWorkItem` and `WorkItem` gain `judge?`.
- `GuardrailsSchema` gains `maxPickingRaces` (schema min 0; the planner must clamp it to at least 1, see §13 seams). Stored overrides and PATCH use `GuardrailOverridesSchema`.
- `observability.ts` event types: `race.picking`, `race.rejected`, `inbox.opened`, `inbox.revoked`, `submission.received`, `note.failed`.
- `PickRaceSchema = {trainId, reason ≤300}` and `RejectRaceSchema = {trainId | "all", reason 1..300}`.
- `ModelPreferenceSchema = {model, kind, rating, n, updatedAt}`.
- `ModelChoice.reason` is unchanged in shape.
- Migration v14 adds the `races` and `work_items` columns, `model_preference`, and `model_stats.picks` / `picks_against_recommendation`.

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

1. **Pre-receive covers rules, not code.** Ref rules, caps, duplicates and target resolution are answered in the push output. The verdict on the *code* (gates, reviewer) is asynchronous, about 1.5–2.5 minutes later, as a note and on the dashboard. Framing: **the push is a proposal; the train decides.**
2. A push takes about 4–8 s, because the proxy forks hive main on the push path (2–6 s measured).
3. Your branch is not visible on the remote after the push (it is a submission in its own train fork). Re-pushing the branch updates the submission.
4. Notes must be fetched on their own, with `+`, over protocol v2 (§7.5).
5. One branch is one item. One ref per push. There are no stacked branches.
6. The commit author is not authenticated. The token owner is accountable.
7. Packs over 50 MB are refused.

**Out of scope:** org and permission models, per-hive token scopes, PR discussion threads, per-line comments, content checks at push time (protected paths, file caps: they stay at the gate), service-token contributors, joining a non-race build in flight, a physical fork per goal (§2.2), SSH remotes.

---

## 12. Sim support and acceptance tests

**Sim** (`pnpm --filter @queenos/queen dev:sim`, no credentials):
- A localhost-only route `POST /hives/:hive/sim/git-push {email, ref, message, files?}` runs `gitIntent` then `gitPushed` exactly as the git Worker would, with a fabricated `headSha = sha1(email|ref|message|n)` and a fake fork name; a refusal returns the `remote:` lines.
- Gate markers apply as for BUILD trains: `[fail]` fails policy, `[review-fail]` makes the reviewer reject, `[collide]`.
- Notes: `GET /hives/:hive/sim/notes/:sha` returns the real `notesFor` projection rendered as text (the same code the proxy serves), so "git log --notes" can be shown.
- `Queen: rework` and the dashboard handoff dispatch the existing sim REWORK fake (seeded from the sim fork).
- In `pnpm dev:sim` the dashboard's **Push code** panel offers a "Simulate a push" form.

**Acceptance** (vitest-pool-workers):
1. Queen: `gitIntent` → `gitPushed` → item (`source.kind user`) → train DEPLOYING → gate → car → LANDED → SHIPPED; `notesFor` shows PASSED, LANDED, SHIPPED in order on the head SHA.
2. `[review-fail]` push → item FAILED "awaiting contributor", **no** REWORK, no escalation, a REJECTED note; the fork is kept (`deleteAfter`).
3. Then `workAction handoff` → REWORK forked from the rejected fork → passes → LANDED; its note carries `Queen-Replies-To`.
4. A `Queen: rework` trailer gives an automatic REWORK after the reject.
5. A re-push before boarding → the old train EJECTED (no attempt), one item. A re-push after boarding → a follow-up item.
6. `gitIntent` refusals: duplicate head SHA; over cap (a 4th open item); unknown `item/<id>`. A late `item/<id>` → accept as `late-new-item`. `paused` → accept, READY with `waitReason`.
7. A `gitIntent` with no `gitPushed` for 10 min → ejected, fork delete effect emitted.
8. A 12-item swarm plus 2 pushed submissions: pushed trains share cars with drone members, and every item LANDED.
9. **Drone adapter (T1b):** every existing `planner.test.ts`, `v2-flow.test.ts` and `load.test.ts` passes unchanged through `submission()`.
10. **git Worker** (fake upstream Artifacts over `fetch` mock): advert filtered to `HEAD` + `main`; upload-pack v2 and v0 passthrough; pre-receive refusals for `main`, delete, tag, notes, two refs, size cap (abort mid-stream); report-status rewritten to the client ref with `remote:` lines; sideband and non-sideband clients; 503 on the fork probe → re-fork `-rN`; upstream failure → `gitAborted`; notes `ls-refs`/`fetch` with and without `done` and `sideband-all`, the pack round-trips through a pack parser (or a real `git index-pack` in a manual check); a mixed fetch gets no notes refs. Artifacts tokens never appear in logs (spy on `console`).
11. **Edge:** `/git/*` without a token → 401 `WWW-Authenticate: Basic`; a revoked or expired token → 401; a `read` token cannot push; `x-queen-user` comes only from the token owner; mint returns the plaintext once and stores only the hash; `/api/git-tokens` stays behind Access.
12. **Gatekeepers:** `changedBetween` flags a *modified* file with `eval` as in-diff (a failing gate, not a follow-up); the reviewer `unavailable` on a human origin → `cause: infra`; protected paths from a non-drone origin → policy error.
13. **Manual live smoke (T8):** `git clone`, `git push origin HEAD:main` (refused), `git push origin HEAD:item/<id>` (`remote:` lines), wait, `git fetch origin '+refs/notes/*:refs/notes/*'`, `git log --notes=verdict -1`.

---

## 13. Implementation plan (subagents, disjoint files, contracts first)

The push path **ships without T1b**. If the drone adapter slips, cut it: drones keep `buildResult()`.

| Task | Model | Owns (exclusive) | Depends | When |
|---|---|---|---|---|
| **T0 Contracts + migration** **DONE** | Opus | (as built; see rev 1 history) | none | done Oct 7 |
| **T0b Contracts: notes + git intake** | Sonnet | `packages/queen-types/src/{notes.ts (new), git.ts (new), inbox.ts, drone.ts, executors.ts, index.ts, index.test.ts}`: note v1 schema, renderer and parser (§7.4: clipping to `MAX_NOTE_TEXT`, unknown-key tolerance, round trip, the three ref constants, the parser rejects `refs/notes/queen`); **`TRAILER_RE` multi-segment fix** (`Queen-Replies-To`) with a test; the summary line never starts with `queen:`; `git.ts` schemas (§5); `SubmitOutcome` `refused:*`/`aborted:*`; deprecate the inbox schemas; `DroneTask.brief`; FORK `from` | T0 | Oct 8 AM (0.5 d) |
| **T1 Queen intake** | Opus | `apps/queen/src/{work/inbox.ts, train/planner.ts, queen-node.ts, index.ts, executors.ts}`, `apps/queen/src/work/notes.ts` (new: `notesFor` projection from the event log and audits, using the T0b renderer), `apps/queen/test/{inbox.test.ts, notes.test.ts, planner.test.ts, v2-flow.test.ts}`, `apps/queen/README.md`: RPCs `gitIntent` / `gitPushed` / `gitAborted` / `notesFor`; pre-forked trains; supersede; FAILED "awaiting contributor"; `deleteAfter`; handoff with `seed` and `brief`; intent watchdog; `pruneSubmissions` in the alarm; `GateTarget.origin` / `baseSha`, `MergeTrain.origin` | T0b | Oct 8 PM – Oct 9 (1.25 d) |
| **T1b Drone adapter** | Opus (same agent, after T1) | `planner.ts` `buildResult` → `submission()`; `submissionFromBuildResult` | T1 | Oct 10, **cuttable** |
| **T2 git Worker core** | Opus | new `apps/git/**` **except** `src/notes-pack.ts` and its test: `wrangler.jsonc` (Artifacts binding, Queen DO binding, no routes, `workers_dev:false`, `preview_urls:false`), `src/{index.ts, pktline.ts, receive.ts, upload.ts, upstream.ts, tokens.ts}`, tests with a fake upstream. Start from the spike. Pre-receive (§4.3), `gitIntent`, fork + readiness probe + `-rN`, ref rewrite, streamed body with the size cap, report-status rewrite, `remote:` lines, `readCommit`, `gitPushed` / `gitAborted`; read path with the filtered advert and 503 retries; read-only `/t/<trainId>` | T0b (T1 RPC names from T0b) | Oct 8 – Oct 9 (1.5 d) |
| **T2n Notes pack** | Sonnet | `apps/git/src/notes-pack.ts` + `apps/git/test/notes-pack.test.ts`: snapshot commit/tree/blob builder, pack v2 writer, v2 `ls-refs` / `fetch` responders (with and without `done`, `sideband-all`), the notes-only prefix rule, a cache by `(hive, ref, version)`. Exports `answerNotesLsRefs` and `answerNotesFetch` for T2 to call | T0b | Oct 8 – Oct 9 (0.5 d) |
| **T3 Edge auth** | Sonnet | `apps/edge/src/{app.ts, registry.ts, gittokens.ts (new)}`, `apps/edge/wrangler.jsonc` (service binding `GIT` → `queenos-git`; `run_worker_first` adds `/git/*`; all envs), `apps/edge/test/**`: `/git/*` before the Access middleware (Basic/Bearer git token, or `cf-access-token` JWT), 401 challenge, failure rate limit, forward with `x-queen-user`; `POST/GET/DELETE /api/git-tokens` behind Access; `git_tokens` table | T0b | Oct 8 (0.5 d) |
| **T4 Gatekeepers** | Sonnet | `apps/gatekeepers/**`: `changedBetween` for BUILD gates (base = merge base with main), fail-closed reviewer for non-drone origin, protected-path policy, `changedPaths` in the train result. **No** inbox classification, **no** note writing | T0 | Oct 8 – Oct 9 (0.5 d) |
| **T5 Drones + provisioner** | Sonnet | `apps/drones/**`: REWORK uses `DroneTask.brief`, writes `Queen-Replies-To` in its commit, provenance and memory facts reported in `BuildResult` (the Queen projects them). `apps/provisioner/**`: FORK `from` (seeded REWORK); the NOTE guard stays | T0b | Oct 9 (0.5 d) |
| **T6 Sim** | Sonnet | `apps/queen/src/sim/{sim-ports.ts, sim-v2.ts, worker.ts}`, `apps/queen/test/sim-ports.test.ts`: `sim/git-push`, sim notes route, seeded sim REWORK | T1 seams | Oct 9 – Oct 10 (0.5 d) |
| **T7 Dashboard** | Sonnet | `apps/dashboard/src/{ItemView.tsx, homeLogic.ts, api.ts, components.tsx, SwarmFloor.tsx}` + new `PushCode.tsx` (clone URL, create / list / revoke git tokens, token shown once), origin badge, **Let the swarm fix it**, tests | T0b, T3 API | Oct 9 – Oct 10 (0.5 d) |
| **T8 Live + docs + plugin** | coordinator + user | deploy; the Access `/git` Bypass app (manual); `plugins/queenos/**` (credential helper, `+refs/notes/*` fetch); `docs/agent-protocol.md` status markers; `docs/HANDOFF.md`, `docs/demo-script.md`, `README.md`, `docs/v2-design.md` D12 amendment | all | Oct 10 – Oct 11 |
| **T9a You-pick races** (§10.1–10.3) | Opus | new `apps/queen/src/train/pick.ts` + `apps/queen/test/pick.test.ts`; `apps/queen/src/work/guardrails.ts`; then, **after T1 merges**, the `maybeDecide` branch in `planner.ts`, `watchdogDeadline`, the `pick` RPC and route; sim `[you-pick]` in `sim-v2.ts` (after T6) | T0; T1 for the wiring | pure part Oct 8; wiring Oct 10 |
| **T9b Manual reject** (§10.4) | same agent as T9a | `pick.ts` reject / none-of-these; `reject` RPC and route; tests (h)(i) | T9a | Oct 10 – Oct 11 |
| **T9c Preference weighting** (§10.5) | Sonnet | `apps/queen/src/models/{router.ts, preference.ts}`, tests; the Model Board column | T9a events | Oct 10 – Oct 11, **can slip** |
| **T9d Pick UI** | Sonnet | new `apps/dashboard/src/RacePick.tsx` + test, mounted by T7 under that export name | T0 | Oct 9 |

- **File ownership seams:** T2 and T2n share `apps/git` but not files; T2 imports T2n's two exports (agree the signatures in T0b's `git.ts` types). T1 and T9a both touch `planner.ts`, `queen-node.ts` and `index.ts`: T9a's wiring waits for T1 to merge (as in rev 1). T7 mounts T9d's component.
- **Seams T0 left:** T1 fills the `work/inbox.ts` `NotImplementedError` stubs (`handleFor` becomes unused; `decideIntake`, `resolveTarget`, `itemFromMessage` are now called from `gitIntent` / `gitPushed`), `WorkPlanner.handoff`, `pruneSubmissions`, `GateTarget.origin` / `baseSha`, `MergeTrain.origin`. T9a: `effectiveSettings` race `judge` / `pickWindowMs` and the `maxPickingRaces` min-1 clamp. T9c: preference reads and writes.
- **Infra (landed with T0):** train forks may be named `<hive>-train-<12hex>-rN`; the proxy's re-fork uses the same suffix, which `TRAIN_REPO_RE` already accepts.
- **Deploy order:** queen (new RPCs; no active trains, R16) → provisioner, drones, gatekeepers → git Worker → edge (binds `GIT`; `/git/*` now token-checked) → **then** the Access `/git` Bypass app. Until the bypass exists, `/git` sits behind Access and is harmless. Check: `pnpm turbo run build typecheck lint test --force --continue`.
- **Schedule:** Oct 8: T0b (AM), then T1, T2, T2n, T3, T4, T9a-pure in parallel. Oct 9: T1 and T2 finish, T5, T6, T7, T9d. Oct 10: T1b, T9a wiring, T9b, T9c; deploy and live smoke. Oct 11: live demo rehearsal of the git path, fixes, cut lines.
- **Cut lines, in order:** T9c, then T9b, then T9a and T9d (races are independent of the push path); T1b; the read-only `/t/<trainId>` route (handoff still lands; the human sees the fix on main); `refs/notes/provenance` and `review` (keep `verdict`); the `cf-access-token` auth path. **The demo spine is:** `git clone` → push to main refused → push `item/<id>` with `remote:` lines → REJECT note via `git fetch` → handoff → LANDED note.

---

## 14. Demo shot (for `docs/demo-script.md`)

**"Agent-native git."** About 75 s, recorded after the swarm shot while the 12-item swarm is still landing.

1. Split screen: the dashboard swarm floor (12 drone tiles) and a terminal. Voice-over: *"This looks like GitHub. It isn't. The git layer is the product: a push is a submission, the swarm vets it under the same rules as the agents, and the verdict comes back as git notes."*
2. `git clone https://queenos.kaikeru.com/git/demo`. Then `git push origin HEAD:main`: refused in the push output, `remote: QueenOS: pushes to main are refused (the lander owns main)`.
3. `git push origin HEAD:item/<id>`: `remote: QueenOS: submission received → item … (joined its race)`. Within seconds a tile with a **human** badge joins the floor, racing the drones' candidates.
4. The change deliberately calls a non-allowlisted host (a deterministic SECURITY reject). The tile goes red. `git fetch origin '+refs/notes/*:refs/notes/*' && git log --notes=verdict --notes=review -1` shows the REJECTED note with the finding, in a plain terminal. Then the **notes beat**: Claude Code with the QueenOS plugin reads the same note, fixes the problem and re-pushes.
5. Or click **Let the swarm fix it**: a REWORK drone starts from the human's commit, passes and boards a car **next to drone members** in the merge-train graph.
6. `git log --notes=verdict` on the commit: `LANDED main@…`, then `SHIPPED`.

---

## 15. Open questions

| # | Question | Recommendation |
|---|---|---|
| Q1 | ~~Inbox per person or per session?~~ | **Superseded by rev 2:** no inbox; one fork per push. |
| Q2 | ~~Sync inbox `main` after landings?~~ | Superseded: clients read hive main directly through the proxy. |
| Q3 | ~~Can an Artifacts repo token reach another repo?~~ | **Moot in rev 2:** Artifacts tokens never leave the git Worker. (Still worth one probe post-Oct 14 for defence in depth.) |
| Q4 | ~~Does `revokeToken` act at once?~~ | Moot: git tokens are ours and checked on every request. |
| Q5 | Artifacts repo-name rules for `<hive>-train-<12hex>-rN` | Already in production for drone trains. |
| Q6 | Fork latency on the push path (3.3–6.4 s in the probes, 2 s on day 1) under load | Accept for Oct 14; the `remote:` line reports it. Post-Oct 14: a warm pool is **unsafe** unless the pool fork is at least as new as the advertised main (the client's pack assumes those objects), so prefer forking at push time. |
| Q7 | Is a receive-pack body that the proxy aborts mid-stream (size cap) left as a half-written repo? | Irrelevant: the fork is deleted on abort. |
| Q8 | Push event delivery: at-least-once? ordered? | The Queen learns of a push synchronously (`gitPushed`), so intake no longer depends on events; the gate still waits for the fork's event as for drone trains. |
| Q9 | Service-token agents (no Access email) | Post-Oct 14. Agents use their person's git token with `Queen-Origin`. |
| Q10 | ~~Should a targeted submission join an in-flight race?~~ | **Decided: yes, core** (§2.5). |
| Q11 | Preference granularity `(model, item kind)` | Keep; `confidence = n/(n+5)` keeps sparse cells neutral. |
| Q12 | `judge: human` default for `[hard]` items in a `supervised` hive? | No. Opt-in. |
| Q13 | Live previews of 3 candidates for up to 15 min: quota and cost | UNVERIFIED. `maxPickingRaces` 2 bounds it at 6 previews. |
| Q14 | Should the proxy advertise the user's open submissions as virtual branches (`refs/heads/item/14` → its fork's head)? | Not by Oct 14: a fetch of those refs needs routing by want to many forks (the same mixed-source problem as notes). The read-only `/t/<trainId>` URL covers handoff. |
| Q15 | Is the `kaikeru.com` zone plan Free/Pro (100 MB request body) or higher? | UNVERIFIED; the 50 MB cap fits all plans. |
| Q16 | The Access `/git` path Bypass app on this account | UNVERIFIED (docs: the most specific path wins). Test in T8 before the demo; fallback: `cloudflared access token` as `cf-access-token`. |

---

## 16. What rev 2 removed from rev 1

| Rev 1 | Rev 2 |
|---|---|
| Per-person inbox fork `<hive>-in-<handle>`, its mirror `main`, re-open to refresh | Gone. One train fork per push, made by the proxy. |
| `InboxKeys` provisioner entrypoint; `POST/DELETE /api/hives/:hive/inbox`; 24 h Artifacts tokens handed to people (`?expires=` stripping) | Gone. QueenOS git tokens, minted by the edge; Artifacts tokens stay server-side. |
| PIN drone, `PIN` drone/train action, `seed` copy into a train fork | Gone. The push lands in the train fork; a seeded REWORK forks the rejected fork. |
| Provisioner `NOTE` op, append-and-retry notes pushes, note contention, forged inbox notes, lander filtering of inbox notes | Gone. Notes are synthesized from the ledger by the proxy. |
| Gatekeeper `INBOX_REPO_RE` intake classification, `ignored:inbox-main`, `ignored:unknown-inbox`, `ignored:revoked` | Gone. A pushed submission is an ordinary train fork push. |
| REWORK write-back to the human's branch (`<ref>-queen` fallback) | Gone. Read-only `/git/<hive>/t/<trainId>`, or `origin/main` after landing. |
| Rescan of inbox refs for lost push events | Gone. Intake is synchronous. |
| Limitation "no pre-receive; `git push` always succeeds" | Gone. Rule violations are refused in the push output (§4.3). |
| Open questions Q1–Q4 (inbox per person, mirror sync, token reach, revocation) | Superseded (§15). |

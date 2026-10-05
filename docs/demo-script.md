# QueenOS demo video script

Target length is about 8:00. The challenge allows 5 to 10 minutes. The video answers the challenge's three questions (awareness, conflicts, review) by showing the system working, not by describing it.

Everything below matches the code as of commit `6449a13`. Anything we'd like to show but can't yet is under [Gaps worth closing before recording](#gaps-worth-closing-before-recording); none of it is in the shot list.

**Primitive tags** used in the shot list: `ART` Artifacts · `DO` Durable Objects (SQLite + hibernating WebSockets) · `WF` Workflows · `VEC` Vectorize · `AIG` AI Gateway / Workers AI · `PREV` Workers Preview URLs and versions (gradual deployments) · `DYN` Dynamic Workers via Worker Loader · `THINK` `@cloudflare/think` · `EVT` Event Subscriptions (`cf.artifacts.repo.pushed`).

---

## 0. The plan in one paragraph

Record on a **fresh hive created on camera with Genesis**, for example project "Pulse", hive `pulse`. Don't use `demo`. The War Room lists every prompt a hive has ever had, oldest first, and lettered from A. On `demo` the swarm's lanes would be lettered K to N and sit below a dozen old lanes. On a fresh hive, the Genesis first-flight prompt is lane **A** and the swarm is **B to E**. Off camera, between Genesis and the swarm, ship the first-flight release once. A hive's first prod deploy has no stable version, so the Herald deploys it at 100% in a single step. Only the *second* release shows the 1 → 10 → 50 → 100 canary ladder. The swarm's release will be that second release.

---

## 1. Pre-flight checklist

### 1a. One to two days before

- [ ] **Node 24:** `export PATH=~/.nvm/versions/node/v24.17.0/bin:$PATH`. Run the full gate once: `pnpm turbo run build typecheck lint test --force --continue`.
- [ ] **Think builder with Dynamic Worker verify is live** (confirmed 2026-10-05 by an `agent: build` step on a production drone run).
- [ ] **Rehearse the full swarm once on a throwaway hive** (for example `rehearsal`, created through Genesis), using the exact prompts in §2. Confirm three things:
  1. C ejects and D/E show `SUPERSEDED`, then `REBUILD #1`.
  2. C's rework lane shows `🧠 N memories recalled` with a **failed** card of its own first attempt.
  3. E shows a recall chip with the first-flight memory.

  **Screen-record the whole rehearsal.** It's the fallback footage for every live shot, and the likeliest source of a real reviewer REJECT (§2.3).
- [ ] **Time the rehearsal** for each phase and write the times down. They tell the editor where the cuts go.
- [ ] **Prepare the architecture slide** (§3, shot 8.1). It doesn't exist yet. The mermaid diagram in the README is out of date (see Gaps).
- [ ] **Have a Cloudflare API token ready** for the Connect step: Account · Workers Scripts · Edit, plus Account · Account Settings · Read. The connect step is recorded with the token field off screen or paused (see Risks).

### 1b. Recording day, before rolling

- [ ] Sign in to https://queenos.kaikeru.com through Access (one-time PIN) in a clean Chrome profile. Set zoom to 90% on a 1440p or 1080p capture so the lanes and side panels both fit. Hide bookmarks and extensions.
- [ ] **Hard-reload every War Room tab.** Tabs opened before the last deploy show the "QueenOS was updated. Reload" banner.
- [ ] Open a **second window** (or a phone) on the same War Room. Shot 1.2 uses it.
- [ ] Keep a terminal ready but off screen, with the `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` env vars set, for watching Workflow instances if something stalls: `GET /accounts/{id}/workflows/<name>/instances`.
- [ ] Have the §2 prompts in a text file so you can paste them exactly. Typos change the embeddings.
- [ ] Have the sim fallback **built and tested** (§1d) on the same machine.

### 1c. Recording order (not the edit order)

| # | Record | Live wall time | Notes |
|---|---|---|---|
| R1 | Genesis on a fresh hive `pulse`, from Projects to "Your hive is live" | 5–10 min | The first-flight prompt is lane A and becomes the seed memory. |
| R2 | *Off camera:* wait for A's release to reach AWAITING TAP, tap it, and wait for SHIPPED (a single 100% step) | 3–5 min | This gives prod a stable version, so R3's release gets the full canary. |
| R3 | *Off camera:* wait at least **2 minutes after A's gate verdict** | 2 min | Vectorize writes take about 1 minute to become queryable. |
| R4 | The swarm: paste B, C, D, E in order, then let it run to the end | 15–35 min | Builds run in sequence (7 builds: B, C, D, E, C′, D′, E′, then B′). Live builds take 40–220 s each, and rebuilds after the floor rises go to frontier models, which are slower. Record continuously. |
| R5 | Reviewer prompt F (§2.3), on the same hive after R4 lands | 4–10 min | It may approve (see §2.3). Keep the rehearsal footage as backup. |
| R6 | The release: staging → Sentinel → AWAITING TAP → tap → canary 1/10/50/100 → SHIPPED | 7–10 min | Each canary step is a Herald deploy plus a Sentinel window of at least 60 s (`SENTINEL_WINDOW_SECONDS`). If F's train lands mid-canary, the next release is queued, not cut. |
| R7 | Cold open: pick 25 s from the busiest moment of R4 | — | It's edit-only. |

**Release supersession:** a merge during STAGING, VALIDATING or AWAITING TAP supersedes the release and cuts a new one. Several releases will flash past during R4. **Don't tap until the last swarm train (B′) has landed.** Otherwise the release you ship won't contain the whole swarm.

### 1d. Sim fallback (no Cloudflare, about 1 minute per swarm)

Use the most capable mode the shot needs:

| Mode | Start | What works | What doesn't |
|---|---|---|---|
| **Full stack local** (best fallback) | README §"Full stack locally": edge `--env dev` on :8787, Queen `--env sim`, Genesis scripted, Vault plus `scripts/dev/fake-cloudflare.mjs`. Open http://localhost:8787 | Projects, Genesis (scripted two-turn interview), War Room, **TAP TO SHIP from the UI** (the edge sets `x-queen-user` from `DEV_USER_EMAIL`), full release ladder | No REVIEWER cards; sim memories are word-overlap stand-ins, not Vectorize |
| **Queen sim only** | Terminal 1: `pnpm --filter @queenos/queen dev:sim` (:8787). Terminal 2: `pnpm --filter @queenos/dashboard dev` (:5173). Open http://localhost:5173/?hive=demo | War Room, **Launch demo swarm (4)**, `[fail]` ejection + rebuild + escalated rework, memory chips, staging → AWAITING TAP | The tap button returns 401 (there's no edge to set `x-queen-user`). Tap from a terminal: `curl -XPOST localhost:8787/hives/demo/releases/$(curl -s localhost:8787/hives/demo/snapshot \| jq -r '.releases[0].releaseId')/tap -H 'x-queen-user: kyle@kaikeru.com'`. Projects and Genesis pages fail (no `/api`). |
| **Mock** (last resort, no backend) | `VITE_MOCK_API=1 pnpm --filter @queenos/dashboard dev` | Scripted Projects and Genesis, two scripted releases (one SHIPPED, one ROLLED BACK at 50%), Model Board, a lane with three recalled memories including a **"rejected by review"** card. The tap button works. | Prompts aren't simulated |

Sim markers (in `apps/queen/src/sim/sim-ports.ts`):
- `[fail]`: SECURITY rejects the first BUILD ("unbounded retry loop"); the REWORK, escalated to frontier, passes.
- `[bad-json]`: the chosen model returns junk and the first fallback builds.
- `[canary-fail]`: Sentinel rolls back at the 10% canary step.

The **Launch demo swarm (4)** button submits `DEMO_PROMPTS` 250 ms apart. The second prompt carries `[fail]`.

Sim timings: fork 0.3 s, build 3.5 s (×1.6 on frontier), preview 1.5 s, gate 3 s, land 2 s, Sentinel 2 s. **Everything runs at real speed, so no speed-up is needed.** In the edit, don't present sim footage as live: put a small "local simulation" lower-third on it.

---

## 2. Exact prompts

### 2.1 Genesis (R1)

In **Step 1 · Describe**, type:

> A tiny status page for my side projects: an HTML page at / with a dark theme that shows the app name, uptime and a link to /health. Keep /health returning JSON.

Answer the Queen's follow-ups briefly. In **Step 2 · Review charter**, set:
- Name: `Pulse`
- **First prompt** (edit the field so it reads exactly):

  > Serve an HTML status page at / with a dark theme; keep /health as JSON

This is lane **A**. Once it's gated it becomes the hive's first memory: PASSED, with the prompt text, changed files and builder reasoning embedded in `queenos-memory`.

### 2.2 The swarm (R4): paste in this order, about 2 s apart

| Lane | Prompt (paste exactly) | Why |
|---|---|---|
| **B** | `Add a /version route that returns the app name and build time as JSON` | Clean and fast. It lands first. |
| **C** | `Add a /ping route that returns plain-text pong [fail]` | **The deliberate failure.** In live mode the gatekeepers' test runner is `scripted` (`GATE_TEST_MODE`): it fails any push whose commit message or changed file contains `[fail]`, unless the commit is a rework (`queen(rework): …`). The drone's commit subject is `queen(build): <first line of the prompt, cut at 59 chars>`, so **the marker must sit within the first 59 characters of the first line.** This prompt is 53 characters. C is ejected; D and E were forked on top of C, so they're superseded and rebuilt without it. C goes back to the tail as a REWORK carrying the Scribe summary, is escalated to a frontier model, and passes. |
| **D** | `Add a footer to the status page at / linking to /health and /version` | Touches the same page as E and depends on B's route. On the train, D is built *on top of* B (and, at first, C). |
| **E** | `Add a high-contrast theme to the HTML status page at /` | **Hive memory recall.** It's semantically close to A ("…HTML status page at / with a dark theme…"). The live proof on 2026-10-05 recalled a similar dark-theme / theme-switch pair at a score of 0.67, against a threshold of 0.6. |

Two recall moments to expect, in order of reliability:

1. **C′ (C's rework) recalls C's own failed first attempt.** The query is identical to the memory's prompt, so the match is near-certain. It's recallable only if C′ forks at least about 1 minute after C's gate. C′ forks only after the rebuilt D′ and E′ have pushed (two sequential builds, at least 80 s), so in practice this holds. *Recall excludes only the train's own id, not the prompt, which is why this works.*
2. **E (first build) recalls A.** It's recallable because R3 waited 2 minutes. The rebuilt E′ also recalls A, and may additionally recall B's PASSED memory.

If E's chip doesn't appear in rehearsal, change E to `Add a light theme toggle to the HTML status page at /`. It's closer to the proven pair.

### 2.3 Reviewer intent miss (R5)

The live reviewer is an LLM (`REVIEW_MODE=llm`, DeepSeek V4 Flash) that judges intent from the changed files plus what `GET /` on the preview actually serves. **No input deterministically produces a REJECT** (see Gaps). Use a two-part prompt where the second half is easy for a builder to skip:

> Add a /changelog page listing the last three changes, and link to it from the status page at /

If the builder adds `/changelog` but doesn't touch `/`, the reviewer sees the old `/` in the preview evidence and rejects it with `missing: link from / to /changelog`. If it approves, use the best REJECT captured during rehearsals. As a last resort, use the mock's "rejected by review" memory card, and narrate it as a past verdict rather than a live one.

Alternative that misses more often, but tends to burn 3 builds (BUILD plus 2 reworks, then FAILED):

> Store a visit counter in a Durable Object and show the count on the status page at /

The no-build template has no DO bindings, so builders tend to fake it with a module-level variable, and the reviewer rejects that.

---

## 3. Shot list

Timestamps are targets for the final cut. "VO" is the voiceover. Keep it measured; let the UI carry the energy.

### 0:00–0:25 · Cold open: the swarm is already running

**0.1 (0:00–0:12)**
- **Screen:** War Room `/p/pulse`, mid-R4. Five lanes; train cars with cumulative units (`B C D`); the phase bars pulsing; the TELEMETRY ticker scrolling (`● LIVE`); the top bar showing `ACTIVE 3 · MERGED 2 · EJECTED 1`.
- **Action:** none. Hold, then slowly zoom into lane C's car turning red with the `FAILED` tag, and the D/E cars flipping to `SUPERSEDED`.
- **VO:** "Four agents, four changes, one repo, at the same time. One of them just broke. Nobody had to resolve a merge conflict."
- **Primitives:** DO, WF, ART.

**0.2 (0:12–0:25)**
- **Screen:** title card over the blurred War Room: **QueenOS: an operating system for agent swarms.** Subtitle: *Built on Cloudflare Artifacts, Workers, Durable Objects, Workflows, Vectorize and AI Gateway.*
- **VO:** "This is QueenOS. It isn't a GitHub clone. It's the scheduler, memory and review layer that lets a swarm of coding agents share one repository."

### 0:25–1:05 · The problem

**1.1 (0:25–0:50)**
- **Screen:** a simple slide with three questions, one per line: *How does an agent know what the others are doing? What happens when their changes collide? Who reviews all of it?*
- **VO:** "Git platforms were built for humans: one branch per person, a pull request, a reviewer. Point twenty agents at that and you get twenty branches that all conflict, and a review queue no human can keep up with. Cloudflare's challenge asks three questions. We'll answer each one on screen."
- **Primitives:** none.

**1.2 (0:50–1:05)**
- **Screen:** two windows side by side on the same War Room, both showing `LINKED · 23ms` (top right).
- **Action:** in the left window, click any lane's Builder card. The **COGNITIVE LEDGER** drawer opens. In the right window, the same lane updates in lockstep as the next frame arrives.
- **VO:** "Awareness first. Every hive has exactly one Queen, a Durable Object with SQLite. Every prompt, train and agent action is written there first, then broadcast over hibernating WebSockets. Agents never talk to each other. They read and write through the Queen, so there's one answer to 'what's everyone doing'."
- **Primitives:** DO (single writer, SQLite, WebSocket hibernation).

### 1:05–2:05 · Onboarding with Genesis (R1 footage, heavily cut)

**2.1 (1:05–1:15)**
- **Screen:** `/`, "Your projects", with the `demo` card (ACTIVE, prod/staging links). Click **＋ New project** → `/new`, "Name your hive". Type `Pulse`; the slug auto-fills to `pulse`. Click **Start describing →**.
- **VO:** "A project is a hive: one repo, one merge train, one Queen."
- **Primitives:** Workers (the `queenos-edge` front door behind Access).

**2.2 (1:15–1:35)**
- **Screen:** `/p/pulse/setup`, **STEP 1 · DESCRIBE**. The chat is on the left; **CHARTER · LIVE PREVIEW** on the right, with its completeness meter filling.
- **Action:** paste the §2.1 description and send. Cut out the Queen's typing dots.
- **VO:** "You describe the project in plain language. The Genesis agent turns it into a charter: environments, an allowlist of dependencies, and the first prompt."
- **Primitives:** DO (`queenos-genesis` wizard DO), AIG (Workers AI model through the `queenos` gateway).

**2.3 (1:35–1:45)**
- **Screen:** **STEP 2 · REVIEW CHARTER**. Edit the First prompt field to the exact §2.1 text, then click **Confirm charter →**.
- **VO:** "Everything is editable before anything runs."

**2.4 (1:45–1:52)**
- **Screen:** **STEP 3 · CONNECT CLOUDFLARE**. Show only the **VERIFICATION** checklist with green ticks and "Connected to account …XXXX ✓". **Never show the token field while it has a value.**
- **VO:** "The hive deploys to your own Cloudflare account. The token goes straight into an envelope-encrypted vault and is never shown again."
- **Primitives:** Workers (`queenos-vault`, AES-GCM per hive).

**2.5 (1:52–2:05)**
- **Screen:** **STEP 4 · LAUNCH**, then click **♛ Launch hive**. Cut to **STEP 5 · FIRST FLIGHT**: the timeline (Creating repo ✓, Seeding template ✓, First prompt on the merge train, Deploying preview). Then cut to "Your hive is live" with the preview URL.
- **Action:** speed up the first-flight wait to 8–15×, or hard-cut it, with a corner clock showing the real elapsed time.
- **VO:** "Launch creates an Artifacts repo, seeds a Worker starter, and puts the first prompt on the merge train. A minute or two later there's a live preview."
- **Primitives:** ART (repo create + seed), WF (`queenos-provisioner`), PREV (the first Worker Preview from `queenos-herald`).

### 2:05–4:05 · The concurrent swarm and the speculative merge train (R4)

**3.1 (2:05–2:25)**
- **Screen:** War Room `/p/pulse`. Lane A is MERGED; the `main` rail shows `root → <sha> A · Serve an HTML status…`. The RELEASE panel shows SHIPPED (from R2).
- **Action:** paste B, C, D, E into **PROMPT COMPOSER** and press **Submit prompt** (or ⌘↵) four times. Four lanes appear: B, C, D, E.
- **VO:** "Now the swarm. Four changes, submitted together. I've tagged C to fail its tests, so you can see what a broken change does to everyone queued behind it."
- **Primitives:** DO.

**3.2 (2:25–2:50)**
- **Screen:** zoom on the train cars. B's car reads `B`, C's `B C`, D's `B C D`, E's `B C D E` (A already landed, so it's part of main, not a car). Each has a **model chip** (for example "GLM-5.3 Flash" with a FAST badge and the router's reason). B's car moves through BUILDING → DEPLOYING ("deploying preview…") → TESTING, with a live `↗ <preview host>` link.
- **VO:** "This is the speculative merge train. Train *k* is main plus prompts one through *k*. Each train is a real fork of the one ahead of it in Artifacts. So D isn't built against main: it's built against main plus B plus C, which is exactly what main will look like when it lands. Each change gets its own Worker Preview and is tested in parallel, on the assumption that everything ahead of it passes."
- **Primitives:** ART (`fork()` chain), WF (`queenos-drones`), PREV (one preview per train), DO (the router picks the model, AIG).
- **Edit:** builds run in sequence (a fork waits for its parent's push). Speed up 8–12× between state changes and slow down at each phase flip. Keep a corner clock in real time.

**3.3 (2:50–3:10)**
- **Screen:** B goes PASSED → LANDING → MERGED; a new commit appears on the `main` rail; the ticker shows `Train B landed on main @ …`. Click B's **Lander ⇪** card. The ledger shows "Pushed the head to the hive's main branch."
- **VO:** "B passes and it's at the head of the queue, so a lander drone pushes it to main. Artifacts has no merge API. Landing is just a push, because the train already contains exactly what main will be."
- **Primitives:** ART, WF.

**3.4 (3:10–3:35)**
- **Screen:** lane C. The **Scribe ✎** card goes from RUNNING to PASSED. C's car shows `EJECTED` with a red `FAILED` tag and a reason line. D's and E's cars show `SUPERSEDED`. The top-bar `EJECTED` count goes to 1. The ticker shows `SCRIBE [C] …` and `Train B+C+D ejected (superseded by an upstream ejection)`.
- **VO:** "C fails. Its train is ejected and its fork deleted. D and E contained C's code, so their results can't be trusted. They're superseded too. Nobody opens a merge tool. A conflict here is just a failed train."
- **Primitives:** DO (pure planner), ART (fork delete), EVT (the push event that triggered the gate).

**3.5 (3:35–3:55)**
- **Screen:** D and E grow a second car each, marked `REBUILD #1`, now reading `B D` and `B D E` (or `D` and `D E` if B has already landed). C's lane shows `· ATTEMPT 2` and its card row splits into "ATTEMPT 1" and "ATTEMPT 2 · REBUILD". C's new car sits at the tail, for example `D E C`, and its model chip shows **▲ ESCALATED** with a FRONTIER badge. In the side panel, the **MODEL BOARD** Floor line flashes red ("Router: floor raised to …" in the ticker).
- **VO:** "The Queen rebuilds D and E without C, forked from the last train that passed. C goes to the back of the line as a rework. It carries the Scribe's summary of what went wrong, and the Queen escalates it to a frontier model. One failure also raises the floor for the whole hive, and clean builds lower it again."
- **Primitives:** DO (AIMD model router), AIG (every model is a Workers AI `@cf/…` model through the `queenos` gateway).

**3.6 (3:55–4:05)**
- **Screen:** end state: `MERGED 5 · EJECTED 0 · FAILED 0` in the top bar (EJECTED counts prompts currently ejected, so it's 0 once C′ merges). The `main` rail shows A, B, D, E, C in landing order.
- **VO:** "Five changes from five agents, landed in a deterministic order. One was rejected, then fixed and re-landed. No human merged anything."

### 4:05–5:05 · Review: four layers, every change

**4.1 (4:05–4:25)**
- **Screen:** C's ATTEMPT 1 card row: **Policy §** PASSED, **Security ⚠** PASSED, **Reviewer ◎** PASSED, **Scribe ✎** PASSED. Click the Scribe card. The ledger shows `method: llm` and the 500-character summary.
- **VO:** "Every push to a train fires an Artifacts event, and the gatekeepers run as a Workflow. Policy checks the dependency allowlist and imports. Security looks for secrets, eval and outbound hosts. A smoke test hits the real preview. When something fails, the Scribe compresses the raw log into 500 characters. That summary is all the Queen keeps, and all the rework agent reads."
- **Primitives:** EVT, WF (`queenos-gatekeepers`), PREV (smoke test against the train's preview), AIG (Scribe model).

**4.2 (4:25–4:50)** (R5 footage, or a rehearsal capture)
- **Screen:** lane F (`/changelog…`). The **Reviewer ◎** card turns red, REJECTED. Click it. The ledger lists `verdict: REJECT`, `satisfied: …/changelog page exists`, `missing: link from / to /changelog`, and `feedback: …`.
- **VO:** "Passing tests isn't the same as doing what was asked. Our first live build passed every check and still changed the wrong page. So there's a reviewer. It reads the prompt, the diff and what the preview actually serves, and asks one question: does this change satisfy the prompt? Here it says no, and the feedback goes straight to the next builder."
- **Primitives:** AIG (reviewer LLM), PREV (the evidence is what `GET /` served).
- **If the reviewer approved in every take:** cut 4.2 to 10 s over the mock's "rejected by review" memory card (shot 5.2 style) and say: "When the reviewer rejects a change, that verdict is remembered too." Move the time to 4.3.

**4.3 (4:50–5:05)**
- **Screen:** click C′'s **Builder ⚒** card. The ledger drawer shows MODEL (with a FRONTIER badge), EXEC TIME, Task prompt, Reasoning steps (the agent's own steps followed by tool-trace lines such as `read src/index.js`, `edit …`, `verify / 200 html; /health 200 json -> ok`) and Discarded paths. Expand **git_notes_payload (raw)**.
- **VO:** "And every commit carries its author's reasoning. This is the Cognitive Ledger: the model, the steps, the paths it rejected, stored as a git note on the commit itself. The builder is a Think agent with file tools, and before it pushes it runs its own Worker in a Dynamic Worker and calls it."
- **Primitives:** ART (git notes in `refs/notes/queen`, falling back to `.queen/ledger/<sha>.json`), THINK, DYN (Worker Loader verify).

### 5:05–5:45 · Hive memory

**5.1 (5:05–5:25)**
- **Screen:** lane C, current train (the rework). Under the cars there's a chip: **🧠 2 memories recalled ▾**. Click it. A red **failed** card shows, for example, `95% match`, prompt "Add a /ping route…", and text "…failed the gate… preview smoke…". Click **show more**.
- **VO:** "The ledger isn't just for humans. Every gate verdict, pass, fail or rejected by review, is embedded into Vectorize. When the Queen forks a new train, the provisioner recalls the closest memories from this hive and the Queen hands them to the builder. C's rework remembered exactly why its first attempt failed."
- **Primitives:** VEC (`queenos-memory`), WF (`memory: recall` step in `queenos-provisioner`; `memory: remember` in gatekeepers), AIG (Workers AI embeddings).

**5.2 (5:25–5:45)**
- **Screen:** lane E. Expand its chip: a green **passed** card with prompt "Serve an HTML status page at / with a dark theme…", `~70% match`.
- **VO:** "And it isn't keyword matching. E asked for a high-contrast theme. The hive remembered how the dark theme was built and that it passed, and gave that to the agent before it wrote a line. Knowledge carries from one agent to the next, even though the drones themselves are thrown away."
- **Primitives:** VEC.

### 5:45–6:55 · Release: staging, Sentinel, a human tap, canary (R6)

**6.1 (5:45–6:05)**
- **Screen:** the **RELEASE** panel. The header shows `<sha>` with units `B D E C`; steps STAGING ✓ → VALIDATING (now) → …; headline "Sentinel is checking staging". In the **SITES** panel: preview rows (`DEPLOYING` / `LIVE` / torn down count), staging `VALIDATING` with the `<hive>-staging` URL, then `PROMOTE … requests, 0.x% errors, p99 … ms`.
- **VO:** "Landing on main isn't shipping. The Queen cuts a release from everything landed since the last ship and deploys it to staging. Sentinel waits until it's ready, then probes it and returns a verdict."
- **Primitives:** WF (`queenos-herald`, `queenos-sentinel`), Workers (staging Worker).
- **Edit:** the Sentinel window is at least 60 s; speed it up.

**6.2 (6:05–6:25)**
- **Screen:** the headline changes to "Staging is healthy. Waiting for a human to ship it". Click the yellow **TAP TO SHIP** button. A modal opens: **SHIP TO PRODUCTION**, "Ship release `<sha>`?", TRAINS (B+D+E+C with prompt excerpts), STAGING VERDICT, PLAN "Canary at 1 → 10 → 50 → 100%, Sentinel checks every step, automatic rollback on a bad verdict." Click **Confirm: ship it**.
- **VO:** "Agents do the work. Shipping stays a human decision: one tap, with the evidence right there in the dialog."
- **Primitives:** DO (the tap is recorded with the Access identity, `tappedBy`).

**6.3 (6:25–6:55)**
- **Screen:** the RELEASE steps go CANARY 1% (now) → 10% → 50% → 100% → SHIPPED. In the SITES canary row, the `cbar` lights 1%, 10%, 50%, 100%, with `candidate <ver> / stable <ver>` and a PROMOTE line per step. It ends with the green **SHIPPED by kyle@kaikeru.com** banner and the prod row showing "shipped by". Optionally open the prod URL in a new tab to show the high-contrast page with the footer.
- **VO:** "The Herald moves traffic between the old and new Worker versions: one percent, ten, fifty, a hundred. Sentinel checks every step. A bad verdict at any step rolls back to the stable version automatically."
- **Primitives:** Workers versions and gradual deployments (PREV), WF.
- **Edit:** four steps at about 60–90 s each. Show 1% in real time, then jump-cut 10 → 50 → 100.
- **Optional 5 s insert:** the sim with `[canary-fail]` in a prompt, showing `ROLLED BACK to …` at 10% (label it "local simulation").

### 6:55–7:35 · Architecture slide

**8.1 (6:55–7:35)**
- **Screen:** one slide (see the Gaps item about the out-of-date README diagram). Left to right:
  - **Edge** Worker (Access JWT, dashboard) → **Queen DO** (per hive, SQLite, WebSockets).
  - The Queen sends commands to the executor **Workflows**: Provisioner (Artifacts fork/delete + memory recall), Drones (Think builder + Dynamic Worker verify), Herald (previews / staging / canary), Sentinel (health verdicts).
  - **Artifacts** → `repo.pushed` event → **Gatekeepers** Workflow (policy, security, smoke, reviewer, Scribe, remember) → verdict back to the Queen over DO RPC.
  - **Vectorize** (`queenos-memory`, `queenos-failures`) and **AI Gateway / Workers AI** in the middle.
  - **Genesis** DO and **Vault** off to the side.
  - Caption: *10 Workers · 1 Durable Object per hive · 5 Workflows · 0 servers.*
- **VO:** "Here's the whole system. The Queen is an orchestrator only: it decides, records and dispatches, and it does no I/O itself. Every side effect is a durable Workflow that reports back over RPC, keyed by a command id, so retries and late results can't corrupt state. Ten Workers, one Durable Object per hive, all on Cloudflare."
- **Primitives:** all.

### 7:35–8:00 · Close

**9.1 (7:35–8:00)**
- **Screen:** back to the War Room at rest: the RELEASE panel SHIPPED, the main rail full, the TELEMETRY ticker quiet. Fade to an end card: **QueenOS** · MIT · `github.com/<repo>` · "Run it locally in sim mode: `pnpm --filter @queenos/queen dev:sim`".
- **VO:** "Awareness from one Queen and a shared memory. Conflicts handled by a speculative train instead of merge sessions. Review by gates, a reviewer, a scribe and a sentinel, with a human tap at the end. That's QueenOS: an operating system for agent swarms. You can run the whole thing locally in sim mode with one command."

---

## 4. Risks and recovery

| Risk | Recovery |
|---|---|
| **Live latency.** 7–8 builds in sequence at 40–220 s each; rebuilds after the floor rises go to frontier models (slower). The watchdog is 10 min. | Record R4 in one continuous take and time-lapse it in the edit, keeping a real-time clock on screen. If one build passes the 200 s generation budget and fails, its train ejects and the Queen re-queues it, which is still a valid story. If R4 takes over 45 min, use the rehearsal footage. |
| **C passes instead of failing** (marker not in the commit subject). | Check the prompt's first line has `[fail]` within 59 characters. The builder's commit subject is built from the prompt, not chosen by the LLM. If the fail is still missed, the swarm shows no ejection: use the sim's Launch demo swarm footage for 3.4–3.5, labelled as simulation. |
| **Another prompt fails for real** (reviewer REJECT or smoke 500 on B, D or E). | That's a genuine ejection, so narrate it as one. The rework loop will show. Don't retake unless it leaves the end state messy (a prompt FAILED after 2 reworks). |
| **No recall chip on E.** | Make sure R3 waited at least 2 minutes after A's verdict. Vectorize counts from `wrangler vectorize info` are stale; check with `get-vectors --ids`. Fall back to C′'s chip (near-certain), or switch E to the §2.2 alternative. |
| **No recall chip on C′** (it forked under 1 minute after C's gate). | It can happen if D′ and E′ rebuild very fast. Use E's chip for 5.1 and drop the "remembered why it failed" line. Or submit a second, near-identical prompt later, for example `Add a /ping route that replies pong as plain text`, after waiting 2 minutes. |
| **The reviewer approves F.** | Expected sometimes. Use rehearsal footage, or the mock fallback in 4.2. |
| **A release is superseded just after the tap.** | The tap returns 409 and the modal shows "This release is stale…". Wait for the newest release to reach AWAITING TAP and tap again. Avoid it by tapping only after the last train lands. |
| **The canary rolls back on camera** (a real Sentinel ROLLBACK). | It's a real feature: keep it and narrate the automatic rollback. Re-run R6 after the next landing for a SHIPPED take. |
| **A first-ship surprise** (a single 100% step instead of the ladder). | That means R2 was skipped. The hive needs one SHIPPED release before the swarm's release. |
| **The "QueenOS was updated. Reload" banner.** | Reload. Don't deploy anything during the recording window. |
| **WebSocket drop** (`RECONNECTING · Ns` in the top bar). | It reconnects and re-snapshots by itself, and no state is lost (the Queen is the source of truth). Cut around it. |
| **Access session expires mid-take** (tap gives "Your session expired"). | Reload, sign in with the one-time PIN, and tap again. Sign in fresh right before R6. |
| **Genesis LLM rambles or produces a bad charter.** | Edit every charter field in Step 2. If the Launch fails ("LAUNCH FAILED"), use **Retry launch**. Last resort: record Genesis in full-stack local mode (scripted interview) and label it. |
| **Token visible on screen.** | The field is a password input, but don't record it while it holds a value. Pause the recording, paste, submit, then resume on the verification checklist. |
| **Clicks don't register when driving Chrome by automation.** | Drive the browser by hand for recording. |

---

## Gaps worth closing before recording

These would make the video better but aren't in the code today, so they're not in the shot list.

1. **No deterministic way to trigger an LLM reviewer REJECT live, and no REVIEWER role in the sim.** The sim gate emits only GATEKEEPER, POLICY, SECURITY and SCRIBE cards, and its memories are only PASSED or FAILED. `[review-fail]` works only with `REVIEW_MODE=scripted`, and then the ledger shows model `queenos/review-scripted-v1`. Smallest fix: have the sim honour `[review-fail]` by emitting a REVIEWER RUNNING → REJECTED card with a canned verdict and a `REJECTED_BY_REVIEW` memory, so shot 4.2 has a sim fallback.
2. **There's no way to start a War Room with a clean board.** Old lanes stay forever and new prompts get late letters, which is why the plan records on a fresh hive. An "active only / hide merged" filter would let us record on `demo`.
3. **The README is out of date for judges.**
   - "The three questions" says `ragContext` is "currently empty"; hive memory is now live.
   - Review lists only gatekeepers, the Scribe and the ledger, not the reviewer or Sentinel.
   - The mermaid diagram still shows AI Gateway BYOK and omits the Provisioner, Herald, Sentinel, Genesis, Vault, Edge and `queenos-memory`.
   - The architecture slide (shot 8.1) needs a current diagram either way.
4. **The tap button returns 401 in Queen-only sim mode.** The Queen requires `x-queen-user`, which only the edge sets. Either let the sim env default the user, or document that the full-stack local mode is the sim fallback for the release segment.
5. **The Model Board reads "0/3 clean builds to back off" at the fast floor.** It can't back off further, and it'll be on screen for most of the video. Hide that text at the lowest tier. An uncommitted change in the working tree (`floorLine` in `components.tsx`, plus router changes) appears to address this; confirm that it lands and deploys before recording.
6. **The live `[fail]` path depends on the scripted test runner** (`GATE_TEST_MODE=scripted`). It's honest as long as the VO says "I tagged C to fail", but the Scribe summary will literally mention the marker. A real deterministic failure would read better: for example, a builder change with a literal `fetch("https://example.org")` that the security scan rejects for real. That would need the builder to reliably write it.
7. **The War Room doesn't show that a builder actually used its recalled memories.** The chip shows what was recalled, not what the builder did with it. If the agent prompt asked it to cite consulted memories in `reasoningSteps`, shot 5.2 could show the link in the ledger.
8. **No in-UI way to reach the prod or staging site from the release panel.** The Sites panel has the links, but nothing shows a before/after of prod. Optional: a "view prod" link on the SHIPPED banner, for a satisfying final cut.

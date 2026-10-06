# QueenOS demo video script (v2)

Target length is **8:00**; the challenge allows 5 to 10 minutes. Rehearse and record on **Oct 12–13**; the video is due **Oct 14**. The video answers the challenge's three questions (awareness, conflicts, review) by showing the system working, not by describing it.

**The story:** QueenOS is an army of virtual engineers. It takes decades of software-engineering practice (tickets, design review, trunk-based development, code ownership, merge queues, code review, bake-offs, canaries, SLOs, runbooks, postmortems) and adapts it for agent swarms. It's autonomous by default, and humans hear about it only when something escalates.

This script matches the code as of commit `3b41399` plus the uncommitted merge-queue work in the tree on 2026-10-06. Every sim prompt in §2 was **run against `wrangler dev --env sim` on 2026-10-06**, and the outcomes and timings below are what it did. Things we'd like to show but can't yet are under [Gaps](#6-gaps-worth-closing-before-recording); none of them are in the shot list.

**The honesty rule.** Every shot is labelled on screen, with no exceptions:
- **`LIVE · queenos.kaikeru.com`**: real Workers AI models, real Artifacts repos, real deploys. Speed-ups are allowed but keep a real-time corner clock.
- **`LOCAL SIMULATION · pnpm dev:sim`**: the real Queen (the same Durable Object, planners and dashboard) driving scripted executors. No model runs and nothing deploys. The sim reports the router's model *picks* (for example "DeepSeek V4 Pro"), but no model ran, so the label also says *"scripted executors · no models ran"*.

The scale line for the VO is **"dozens live, thousands by design"** (decision D10). Don't claim more than that.

**Primitive tags** used in the shot list:

| Tag | Primitive |
|---|---|
| `ART` | Artifacts (repos, `fork()`, git notes) |
| `DO` | Durable Objects (the per-hive QueenNode on SQLite with hibernating WebSockets, and the `SwarmGovernor`) |
| `WF` | Workflows (Oracle, Provisioner, Drones, Gatekeepers, Herald, Sentinel) |
| `EVT` | Event Subscriptions (`cf.artifacts.repo.pushed` triggers the gate) |
| `VEC` | Vectorize (`queenos-memory`, `queenos-failures`) |
| `AIG` | AI Gateway and Workers AI (the `queenos` gateway, `@cf/…` models) |
| `PREV` | Workers Preview URLs, versions and gradual deployments |
| `DYN` | Dynamic Workers through Worker Loader (the builder's verify step) |
| `THINK` | `@cloudflare/think` (the builder agent) |
| `AE` | Workers Analytics Engine (`queenos_events`, metrics through the edge) |

---

## 0. The plan in one paragraph

The **sim carries the spectacle and the live system carries the proof.** The sim shows things that need scale or determinism: 24 builds at once, merge conflicts, a bisect, scripted reviewer rejects, rollbacks and escalations. They run in about 90 s on a laptop, and every marker in §2.1 is deterministic. The live system on queenos.kaikeru.com shows the same pipeline at honest size: a real Oracle fan-out into about 12 items, real parallel builds of 40–220 s each, real cars, a real LLM reviewer, a real auto-ship canary, real Vectorize recall, and a trace with real durations. Workers AI allows about 300 text-generation requests a minute per account, which is why a live swarm is about 12 items and the 24-item swarm is sim-only. **The live rollout (HANDOFF Phase 3) isn't done yet, so the whole script must work in sim alone.** Each shot below lists a live source and a sim source, and the sim column is always complete. **Go/no-go:** if v2 isn't live and the L1 rehearsal hasn't passed by **Oct 12, 12:00**, record the all-sim cut. That means dropping every `LIVE` insert, giving the time back to the sim shot it sits in, and recording the one-sentence live line in shot 13 as VO only.

### Shot sources at a glance

| # | Shot | Sim source (always available) | Live source (if v2 is live) |
|---|---|---|---|
| 1 | Cold open | S2 swarm floor + queue | none |
| 4 | One prompt fans out | S1 Goals | L1 Oracle fan-out insert (10 s) |
| 5 | Dozens at once | S2 Swarm demo (24) | L1 swarm floor at ~12 (10 s) |
| 6 | Merge queue: cars, conflict, bisect | S2 | L1 cars landing (5 s) |
| 7 | Race | S1 dark-theme race, S2 race | L2 best-of-3 |
| 8 | Review | S1 `[review-fail]`, S2 car gate, S3 | L3 LLM reviewer ledger |
| 9 | Self-correction | S1 `[gate-spot]` bug | none |
| 10 | Autonomous ship, then escalation | S2 auto-ship, S3 streak, S4 inconclusive | L1 auto-ship canary |
| 11 | Drill-down | S2 trace, events, metrics | L1 trace (real durations), AE metrics |
| 12 | Hive memory | sim recall (word-overlap stand-in) | **L4 Vectorize recall (preferred)** |

---

## 1. Pre-flight checklist

### 1a. Blocking dependency: the live rollout

This isn't a code gap. It's HANDOFF "Phase 3: going live", and the user runs it, because auto mode blocks production deploys:
- [ ] `ANALYTICS_API_TOKEN` set on the edge.
- [ ] Deploy `apps/oracle` alone first, then run `./scripts/deploy.sh` (it needs the Access service token for the R16 guard, or `--force` after checking by hand).
- [ ] WP3.1 live checks: the 4-bullet Goals prompt, a 12-item live swarm, and an AI burst test that sets `SWARM_AI_RPM`.
- [ ] **Don't deploy anything during the recording window**, because open tabs would show the "QueenOS was updated" banner.

### 1b. One to two days before

- [ ] **Node 24:** `export PATH=~/.nvm/versions/node/v24.17.0/bin:$PATH`. Run the full gate once: `pnpm turbo run build typecheck lint test --force --continue`.
- [ ] **Rehearse every sim run (S1–S4) once, end to end**, with a screen recording. Write down the phase timings next to the ones in §1e. Rehearsal footage is the fallback for every sim shot.
- [ ] **Rehearse L1–L4 on a throwaway live hive** (for example `rehearsal`, created through Genesis). Keep the footage, which is the likeliest source of a real reviewer REJECT (L3).
- [ ] **Prepare four slides:** the practices table (shot 2, from `docs/v2-design.md` §1.1), the three questions (shot 3), the answers recap (shot 13), and the architecture (shot 13; redraw it from the v2 mermaid diagram in `README.md`, which is current as of `3b41399`).
- [ ] **Prepare the two lower-third labels** (`LIVE …` and `LOCAL SIMULATION …`) and a corner clock for time-lapsed live footage.
- [ ] Have a Cloudflare API token ready in case a fresh live hive is created on the day (Account · Workers Scripts · Edit, plus Account · Account Settings · Read). Never record the token field while it holds a value.

### 1c. Sim setup (for S1–S4)

- [ ] `pnpm dev:sim` from the repo root starts the Queen on :8787 and the dashboard on :5173 together. The **Swarm demo (24)** button exists only in this dev build, not on the live site.
- [ ] **Use a fresh hive name for every take** (`pulse`, `pulse-2`, …). The sim persists its DO state under `apps/queen/.wrangler/state`, so an old hive keeps its old goals. A new name is a clean board. Open `http://localhost:5173/p/<hive>`.
- [ ] **No settings needed:** new sim hives start `autonomous` with `maxActiveTrains: 64` and `maxChildrenPerItem: 24` (the `HIVE_DEFAULT_GUARDRAILS` var in the sim env). The sim also fakes a pre-existing prod version, so the very first release already shows the 1 → 10 → 50 → 100 canary ladder.
- [ ] Escalation buttons work in the sim: a localhost sim defaults the missing `x-queen-user`, so **Resume autonomy**, **Ship anyway** and the autonomy dropdown all work from the UI.
- [ ] Browser: a clean Chrome profile, zoom at 90% on a 1440p or 1080p capture, with no bookmarks bar or extensions.

### 1d. Live setup (for L1–L4)

- [ ] **A fresh live hive, `pulse`** (or `pulse-live`), created through Genesis off camera with the §2.3 description. New hives start `autonomous` (D2). **Don't use `demo`:** it migrated as `supervised` and carries old lanes.
- [ ] **Let the first-flight release ship before recording.** A hive's first prod deploy has no stable version, so it goes to 100% in one step. Only the *second* release shows the canary ladder. In an autonomous hive it auto-ships, so just wait for SHIPPED.
- [ ] **Raise the children cap for the 12-item goal.** The default `maxChildrenPerItem` is 8, so a 12-bullet goal would be truncated, with a GUARDRAIL_TRIPPED card on camera. The dashboard has no guardrails control (only the autonomy dropdown), so paste this into the DevTools console of a signed-in dashboard tab. It's same-origin, so the Access cookie goes with it.
  ```js
  await fetch("/hives/pulse/settings", { method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ autonomy: "autonomous", guardrails: { maxChildrenPerItem: 12 } }) }).then(r => r.json())
  ```
  Check that the response shows `maxChildrenPerItem: 12` and `autonomy: "autonomous"`. Leave `maxActiveTrains` at its default of 24; the `SwarmGovernor` lease, set from `SWARM_AI_RPM`, is the real limit.
- [ ] **Hive memory needs time.** Vectorize writes take about a minute to become queryable. Run L4 at least **2 minutes after** the L1 item it should recall has its gate verdict. `wrangler vectorize info` shows stale counts, so check with `get-vectors --ids`.
- [ ] Keep a terminal off screen with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` set, to watch Workflow instances if something stalls: `GET /accounts/{id}/workflows/<name>/instances` (`oracle-workflow`, `drone-workflow`, `gatekeeper-workflow`, `herald-workflow`, `sentinel-workflow`, `provisioner-workflow`).

### 1e. Recording order (not the edit order)

| # | Record | Wall time | Notes |
|---|---|---|---|
| S1 | Sim hive `pulse`: paste the Goals prompt (§2.2) | **~65 s** to all SHIPPED | Measured on 2026-10-06. Record the status home continuously, then the item pages (race, changelog, gate-spot bug) and the lanes page for the REVIEWER card. |
| S2 | Sim hive `swarm`: click **Swarm demo (24)** | **~90 s** to all 25 SHIPPED | Measured: 24 builds at once at t+4 s, the first car landing at t+16 s, cars of up to 4, 4 releases (several superseded), done at t+89 s. Then record the queue page, item pages, trace, event log and metrics on the finished hive. |
| S3 | Sim hive `incident`: the `[canary-fail]` prompt (§2.2) | **~60 s** to ROLLBACK_STREAK | Measured: rollback at 10% at ~t+30 s, a P0 bug filed and dispatched, a second rollback, ROLLBACK_STREAK, and the hive degraded to supervised by t+56 s. Optional third act (+20 s): **Ship anyway** on the next APPROVAL_REQUIRED, which leads to a third rollback and ERROR_BUDGET_EXHAUSTED. |
| S4 | Sim hive `night-shift`: the `[inconclusive]` prompt | **~25 s** to the card, then **~15 s** after **Ship anyway** | Measured: SENTINEL_INCONCLUSIVE at t+24 s, and SHIPPED about 15 s after Ship anyway. |
| L1 | Live hive `pulse`: the 12-item goal (§2.3) | 15–30 min | Record continuously and time-lapse. The Oracle takes seconds, builds 40–220 s each in parallel, gates ~1–2 min, then cars, then staging + Sentinel (≥ 60 s window) + 4 canary steps (≥ 60 s each). |
| L2 | Live: the best-of-3 race (§2.3), split off | 5–8 min | Can overlap the end of L1, but it costs 3 builds of AI budget. |
| L3 | Live: the reviewer prompt (§2.3) | 4–10 min | It may approve. Keep rehearsal takes. |
| L4 | Live: the memory-recall prompt, ≥ 2 min after L1's quote item has its verdict | 3–6 min | Only the item page's memory chip is needed. |

---

## 2. Exact prompts and markers

Paste prompts from a text file, because typos change the embeddings live and the markers in the sim.

### 2.1 Sim markers used in this script (all exist in `apps/queen/src/sim/sim-v2.ts` / `sim-ports.ts`)

| Marker | Effect in the sim |
|---|---|
| `- ` bullet lines | The Oracle fake makes one child per bullet. A **non-bullet first line becomes the goal's title** and isn't itself an item. |
| `[hard]` | difficulty `hard`, so the item races best-of-3 (`hardWidth`). The marker is removed from the title. |
| `[touch:<path>]` | A predicted path, so the item claims it (path affinity). The marker is removed from the title. |
| `(after N)` | Depends on bullet N, so the item is BLOCKED until N lands. |
| `[race]` | best-of-3 (it stays in the title). |
| `[collide]` | The build also changes `src/lib/shared.js` *without predicting it*. Two such items conflict in the merge queue, and one is reworked after the car it hit. |
| `[batch-fail]` | Passes alone but fails the integration gate when merged on top of others. That causes a bisect, then "passed alone, fails integrated", one rework, then it lands. |
| `[review-fail]` | The REVIEWER rejects the first build: "The change adds a route but never renders the requested content: the page body is a placeholder…". The REWORK (raced 2 wide) is approved. |
| `[gate-spot]` | The SECURITY gate files an out-of-diff follow-up bug: **"Spotted: unescaped query string in legacy search"** (source `gatekeeper:SECURITY`). It's triaged and dispatched. |
| `[canary-fail]` | Sentinel rolls the release back at the 10% canary step. |
| `[inconclusive]` | The staging verdict is inconclusive, so the release parks with SENTINEL_INCONCLUSIVE even though the hive is autonomous. |

Other existing markers, not used in the cut: `[fail]` (SECURITY rejects the first build; in a race only candidate 0 fails), `[spot-bug]` (the *builder* files "Spotted: README badge link 404s"; note that the word "bug" makes the Oracle fake classify its own item as a `bug`), `[bad-json]` (the chosen model's output is unusable, so the first fallback builds), and `[decompose-fail]` (the Oracle fails and the goal falls back to one item).

**Sim gotcha:** the Oracle fake keeps `[race]`, `[collide]`, `[batch-fail]`, `[review-fail]` and `[gate-spot]` in item titles, so they're visible on screen. Lean into it: "I tagged these to misbehave."

### 2.2 Sim prompts

**S1, the Goals prompt** (hive `pulse`, **split into items** checked, best-of `auto`). It's five bullets under a title line:

```
Status page polish for Pulse
- Add a dark theme toggle [hard] [touch:src/lib/theme.js]
- Add a /health JSON endpoint [gate-spot]
- Add theme tokens for the status page [touch:src/lib/theme.js]
- Fix the hardcoded footer year (after 2)
- Add a /changelog page that lists recent releases [review-fail]
```

What it did on 2026-10-06:
- Goal **"Status page polish for Pulse"** split into 5 items: 4 `feature` and 1 `bug` (the footer item, because of "fix").
- *Dark theme toggle* is HARD with paths `src/lib/theme.js` (predicted), and **races best-of-3**. The race was decided as `won: reviewer approved (3/0), 9.9 KB vs 10.4 KB; DeepSeek V4 Flash`.
- *Theme tokens* waits on **"affinity: src/lib/theme.js held by …"** until the toggle lands.
- *Footer year* is **BLOCKED** until `/health` lands (dependency).
- */changelog*: the REVIEWER **rejects** it, and the rework **races 2 wide** and wins (`2.3 KB vs 4.0 KB; DeepSeek V4 Pro`).
- */health* passes, and the gate files the *"Spotted: unescaped query string in legacy search"* bug, which is triaged, dispatched, built, landed and **shipped**.
- Everything SHIPPED automatically in ~65 s, with no human.

**S2, the swarm** (hive `swarm`): click **Swarm demo (24)** in the composer. It files `demoSwarmPrompt(24)`: 24 bullets `- Add a /features/<word> endpoint returning <word> facts`, with markers on these four:
- `maple` → `[race]`
- `quartz` → `[collide]`
- `ember` → `[collide]`
- `acorn` → `[batch-fail]`

On 2026-10-06 it produced:
- 24 builds at once;
- a best-of-3 race (`won: reviewer approved (3/0), 4.5 KB vs 6.2 KB; Kimi K2.7 Code`);
- one `queue.conflict` on `src/lib/shared.js`, followed by a rework (raced 2 wide) that lands after the car it hit;
- one `queue.bisect` ("failed its integration gate; bisecting 2 → 1+1");
- cars landing 1, 2, 3 and 4 members per push;
- all items SHIPPED by ~t+90 s.

*The button's goal title is just the first bullet.* That's ugly on camera (see Gaps). Until it's fixed, **paste the same 24 lines under a title line** `Fact endpoints, 24 at once` instead of clicking the button. The behaviour is identical. Keep one button click for the cold-open B-roll if the title isn't on screen.

**S3, rollback streak** (hive `incident`, **split into items unchecked**):

```
Add a /features/otter endpoint returning otter facts [canary-fail]
```

The sequence:
1. It lands, and the release auto-ships to canary.
2. Sentinel rolls it back at 10%.
3. The Queen files a P0 bug, **"Release <id> rolled back: …"**, and dispatches it.
4. The bug's release rolls back too.
5. The **NEEDS YOU** card shows **ROLLBACK_STREAK**, and the autonomy pill reads **`autonomous → supervised (rollback streak)`**. The error budget tile drains 2 → 1 → 0.
6. The next release parks with **APPROVAL_REQUIRED**.
7. *Optional:* **Ship anyway** causes a third rollback. **ERROR_BUDGET_EXHAUSTED** opens ("Change success 0/3 over the last 20 releases (target 0.9); error budget -1"), and the pill reads `autonomous → supervised (error budget, rollback streak)`.

The hive keeps rolling back from there, by design, so use a dedicated hive.

**S4, an inconclusive staging verdict** (hive `night-shift`, split unchecked):

```
Add a /status JSON summary of uptime [inconclusive]
```

The release parks at AWAITING_TAP with **SENTINEL_INCONCLUSIVE**, with the buttons **Ship anyway**, **Hold** and **Acknowledge**. Clicking **Ship anyway** starts the canary, which goes 1 → 10 → 50 → 100 to SHIPPED.

### 2.3 Live prompts

**Genesis** (off camera, as for v1). In **Step 1 · Describe**, use:
> A tiny status page for my side projects: an HTML page at / with a dark theme that shows the app name, uptime and a link to /health. Keep /health returning JSON.

In **Step 2**, name it `Pulse` and set the first prompt to:
> Serve an HTML status page at / with a dark theme; keep /health as JSON

**L1, the 12-item goal** (split checked, best-of `auto`). The items are independent, each with its own `/features/<slug>` route. Under the no-build template features are served at `/features/<slug>`, and the generated registry `src/features/index.js` is merged by the registry merge driver, so these don't conflict.

```
Twelve small utilities for Pulse
- Add a /features/quote endpoint that returns a random programming quote as JSON
- Add a /features/uuid endpoint that returns a fresh UUID from crypto.randomUUID as JSON
- Add a /features/time endpoint that returns the current UTC time in ISO 8601 as JSON
- Add a /features/dice endpoint that rolls two six-sided dice and returns both values and the total
- Add a /features/colors endpoint that returns a palette of five hex colors as JSON
- Add a /features/slugify endpoint that slugifies the ?text= query parameter
- Add a /features/wordcount endpoint that counts the words in the ?text= query parameter
- Add a /features/fizzbuzz endpoint that returns FizzBuzz from 1 to 30 as a JSON array
- Add a /features/roman endpoint that converts ?n= to Roman numerals
- Add a /features/emoji endpoint that returns a random animal emoji with its name
- Add a /features/haiku endpoint that returns a fixed haiku about the sea as three lines
- Add a /features/colo endpoint that returns the Cloudflare colo from request.cf as JSON
```

The live Oracle is an LLM. It may merge, split or reorder bullets and predict its own paths, and that's fine on camera. Expect about 12 tiles on the swarm floor and cars of 1–4.

**L2, a live race** (**split unchecked**, **best-of 3**). Don't race with split checked: the goal's `bestOf` is copied to *every* child.

```
Add a /features/calendar endpoint that renders the current month as an HTML table with today highlighted
```

Three candidates fork from main at once on three different models. The item page shows the ★ winner and the ranking reason, which is computed from real gate scores.

**L3, the live reviewer** (split unchecked). This is a two-part prompt whose second half is easy for a builder to skip. Live has no deterministic REJECT (see Gaps).

```
Add a /changelog page listing the last three changes, and link to it from the status page at /
```

If the builder adds `/changelog` but doesn't touch `/`, the reviewer sees the old `/` in the preview evidence and rejects it with something like `missing: link from / to /changelog`. Then the rework (2 wide) carries the feedback. If it approves, the reviewer's ledger entry still shows `verdict: APPROVE` with `satisfied: …`, which is a real (if quieter) review shot.

**L4, live memory recall** (split unchecked, ≥ 2 min after L1's quote item has its gate verdict):

```
Add a /features/quote/today endpoint that returns the same programming quote for the whole UTC day
```

Open its item page. The **🧠 N memories recalled ▾** chip should hold L1's `quote` memory (PASSED), with a real cosine score (the threshold is 0.6). If it's missing, see Risks.

---

## 3. Shot list (8:00)

"VO" is the voiceover. Keep it measured and let the UI carry the energy. Use `[SIM]` / `[LIVE]` for the on-screen label each shot needs.

### 0:00–0:20 · 1. Cold open: two dozen engineers at once `[SIM]`

- **Screen:** S2 status home at about t+5 s. The headline is green: **`SHIPPING · 24 building · … · landed 0 today`**. Below it, **SWARM FLOOR · 24 builds at once**, a wall of tiles, with the `maple` race outlined as one box of three. Hard-cut to t+20 s: the **MERGE QUEUE** rail `main @… ◀━ K1 [4 chips] LANDING ◀━ K2 … GATING`, and the landed count ticking up.
- **VO:** "That's one prompt, turned into twenty-four tickets, built by twenty-four agents at the same time, in one repository. Nobody is going to review twenty-four pull requests. Nobody has to."
- **Primitives:** DO, WF, ART.

### 0:20–0:50 · 2. Thesis: an army of virtual engineers

- **Screen:** title card **QueenOS: an army of virtual engineers**, with the subtitle *Built on Cloudflare Artifacts, Workers, Durable Objects, Workflows, Vectorize, AI Gateway and Analytics Engine.* Then the practices slide: two columns, *human practice → what QueenOS does*. Tickets → work ledger · design review → Oracle · trunk-based dev → every build forks main · CODEOWNERS → path affinity · merge queue → speculative cars + bisect · code review → gates + LLM reviewer · bake-offs → best-of-N races · canaries → Sentinel · SLOs → error budget gates autonomy · runbooks → escalations · postmortems → hive memory.
- **VO:** "Software teams learned how to ship safely over decades: tickets, design review, merge queues, code review, canaries, error budgets, postmortems. QueenOS gives all of that to agents, tuned for minds that work in minutes instead of days. It's autonomous by default. Humans hear about it only when something escalates."

### 0:50–1:05 · 3. The three questions

- **Screen:** slide: **1. Awareness:** how does each agent know what the others are doing? **2. Conflicts:** what happens when their changes collide? **3. Review:** who checks all of it? Each line gets a small badge that the later shots echo (`Q1`, `Q2`, `Q3`).
- **VO:** "Cloudflare asked three questions about a Git platform for agents. We'll answer each one on screen."

### 1:05–1:45 · 4. One prompt fans out `[SIM]` + `[LIVE]` insert

- **Screen:** S1. In the **COMPOSER**, paste the Goals prompt with **split into items** ticked, then **Send to Queen** ("Sent. The Queen is splitting it into items."). In **GOALS**, **◆ Status page polish for Pulse** opens with five rows:
  - `feature` *Add a dark theme toggle*: **racing best-of-3**;
  - `feature` *Add a /health JSON endpoint*;
  - `feature` *Add theme tokens…*: **affinity: src/lib/theme.js held by …**;
  - `bug` *Fix the hardcoded footer year*: **BLOCKED**;
  - `feature` */changelog…*.
- **Action:** click *Add theme tokens…* to open the item page and show its **paths** `src/lib/theme.js (predicted)`, its **waiting** line, and its **ACCEPTANCE** checklist. Click back.
- **Insert (10 s) `[LIVE]`:** L1, where the real Oracle turns "Twelve small utilities for Pulse" into ~12 items within seconds.
- **VO:** "The Queen gives the goal to the Oracle, our tech lead. It writes the tickets: kind, acceptance criteria, dependencies, and which files each one will probably touch. The footer fix waits for the health endpoint. Theme tokens would touch the same file as the dark-mode toggle, so it waits instead of colliding. That's code ownership for agents, held for minutes. And on the live system, a real model does the same with twelve items."
- **Primitives:** DO (work ledger and path claims in SQLite), WF (`queenos-oracle`), AIG (the live Oracle model).

### 1:45–2:30 · 5. Dozens of builds at once `[SIM]` + `[LIVE]` insert · **Q1 Awareness**

- **Screen:** S2. Click **Swarm demo (24)** (or paste the titled version). The floor fills: **SWARM FLOOR · 24 builds at once**, with the summary line `building … · deploying … · gating … · racing 3 (1 race)`. Hover one tile to show its tooltip *"Add a /features/quartz endpoint… · <model> · building 0:07 · forked from main@xxxx"*. The tiles slide between groups (building → deploying → gating → queued → merging) as they finish out of order. Show the **Slots** tile (`used/total (lease …)`).
- **Insert (10 s) `[LIVE]`:** the L1 swarm floor with ~12 tiles and a real-time clock showing minutes, not seconds.
- **On-screen badge:** `Q1 AWARENESS`.
- **VO:** "Every build forks from current main at the same moment: trunk-based development. How does anyone know what's going on? Each hive has exactly one Queen, a Durable Object with SQLite. Every ticket, claim, build and verdict is written there first and broadcast over WebSockets. Agents don't talk to each other. They read and write through the Queen, so there's one answer to 'who's doing what', down to which files each agent holds right now. Live, Workers AI's rate limit makes that about a dozen at once. The design is built for thousands."
- **Primitives:** DO (single writer, hibernating WebSockets, `SwarmGovernor` lease), ART (`fork()` from main), WF (`queenos-drones`, `queenos-provisioner`), PREV (one preview per build).

### 2:30–3:40 · 6. The merge queue: cars, a conflict, a bisect `[SIM]` · **Q2 Conflicts**

- **6a (2:30–2:55):** the **MERGE QUEUE** strip. Cars on the rail, `main @… ◀━ K1 [chip chip chip chip] LANDING ◀━ K2 [chip chip] GATING ◀━ K3 [chip] MERGING`, then **waiting to board:** chips. A single-member car shows **⚡ fast-forward**. The landed count jumps by four in one push.
  - **VO:** "Builds that pass don't merge one by one. They board a merge queue, like bors or Zuul. Each car three-way merges its passengers onto the car ahead of it, runs an integration gate on the merged tree, and lands with a single fast-forward push. Main only ever moves to a tree that was tested as a whole."
- **6b (2:55–3:20):** the **⚡ conflict** story line: `… conflicts in car …: src/lib/shared.js`. Click **item ▸** to open *quartz* or *ember*. Show the **claims** with `src/lib/shared.js (conflict)` highlighted, **attempts** `… 1 conflict reworks`, the attempt row **⚡ conflict on src/lib/shared.js (content): Merge conflict…**, then **waiting for car K… before re-forking main**, then the rework attempts (2-wide) and LANDED.
  - **VO:** "Two agents changed the same shared file without predicting it. The second can't merge cleanly, so it leaves the car before anyone builds on it, and goes back as a rework: rebase on exactly the code it collided with, then try again. Nobody opens a merge tool. A conflict is just another ticket."
- **6c (3:20–3:40):** the **✂ bisect** story: `car … failed its integration gate; bisecting 2 → 1+1: Integration gate failed: "Add a /features/acorn endpoint…`. Open **queue page ▸**, which shows **CARS · LAST 24H**. Expand the failed car (**▸ K…**) to show `bisect: half 1: […] · half 2: […]`. Open *acorn*'s item page: *"Passed alone, fails integrated on main@…"*, one rework, LANDED.
  - **VO:** "Two changes that each pass can still break each other. The car fails, so the queue bisects it: the innocent half lands and the culprit is isolated and reworked."
- **On-screen badge:** `Q2 CONFLICTS`.
- **Primitives:** WF (the MERGE drone: isomorphic-git 3-way merge with the registry merge driver; the LANDER), ART (car forks chained on the car ahead, one fast-forward push), EVT + WF (integration gate on the car's push), PREV (the car's preview), DO (the queue planner).

### 3:40–4:15 · 7. A race: best-of-N `[SIM]` (or `[LIVE]` L2)

- **Screen:** S1's *Add a dark theme toggle* item page (or S2's `maple`, or L2 live). The chips read **HARD** and **best-of-3**. **ATTEMPTS** lists three race candidates on three different models; one shows **★ winner**, and the line below reads `ranking: won: reviewer approved (3/0), 9.9 KB vs 10.4 KB; DeepSeek V4 Flash`. The losers read `LOST`. Cut back to the floor to show the three tiles outlined together while racing.
- **VO:** "For hard tickets the Queen runs a bake-off. Three agents, on three different models, build the same ticket from the same commit. The winner is ranked deterministically: did the reviewer approve, how much of the acceptance criteria it met, whether it verified its own build, how far it strayed from the predicted files, and how small the change is. Only the winner boards the queue. Agents are cheap enough to build things twice."
- **If L2 is live:** use it, because the ranking reason is computed from real gate scores. Keep the `[LIVE]` label.
- **Primitives:** DO (race planner, `rankCandidates`), ART (three forks of main), AIG (`routeRace` picks distinct models).

### 4:15–5:15 · 8. Review: every change, several ways `[SIM]` (+ `[LIVE]` L3) · **Q3 Review**

- **8a (4:15–4:40):** open S1 on the **lanes ▸** page, the */changelog* lane. The **Reviewer ◎** card turns red, REJECTED. Click it: the **COGNITIVE LEDGER** drawer shows the verdict and the feedback *"…the page body is a placeholder. Rework should render real content and cover it with a test."* The item page then shows the rework racing 2 wide, ★ winner, approved.
  - **Live alternative:** an L3 take with a real `REJECT` (`missing: link from / to /changelog`). Use the rehearsal take if needed, labelled with its date.
  - **VO:** "Passing tests isn't the same as doing what was asked. Every build gets policy and security scans, a smoke test against its own live preview, and then an LLM reviewer that checks the diff and the running preview against the ticket's acceptance criteria. Here it says no, and its feedback becomes the next agent's brief. Reworks race two models."
- **8b (4:40–4:55):** queue page **CARS · LAST 24H**: the gate column for each car, and the failed car from 6c with its integration-gate reason.
  - **VO:** "Every car is gated again after the merge, without the reviewer, because intent doesn't change when code is merged. Behaviour can."
- **8c (4:55–5:15):** the status home **Error budget** tile (`2 of 2 left`), and the lanes release timeline with the canary steps 1 → 10 → 50 → 100 and Sentinel verdicts.
  - **VO:** "After landing, Sentinel probes staging and every canary step. All of it feeds an error budget, a change-success SLO. That budget doesn't just raise alerts: it decides whether the hive is allowed to ship on its own."
- **On-screen badge:** `Q3 REVIEW`.
- **Primitives:** EVT (`repo.pushed` triggers the gate), WF (`queenos-gatekeepers`, `queenos-sentinel`), PREV (evidence from the build's own preview), AIG (reviewer and Scribe models), ART (the ledger as git notes in `refs/notes/queen`).

### 5:15–5:35 · 9. Self-correction: agents file their own bugs `[SIM]`

- **Screen:** S1 **GOALS** / **Other items**, with the new row `bug` **Spotted: unescaped query string in legacy search**. Open it: **source** `gatekeeper · gatekeeper:SECURITY`, **paths** `src/legacy/search.js (predicted)`, then its attempt, LANDED → SHIPPED. Then **EVENTS (ITEM)** with `item.filed`.
- **VO:** "While gating the health endpoint, the security scan noticed a problem *outside* the diff. It didn't block the change: it filed a ticket. The Queen triaged it, checked it wasn't a duplicate, and dispatched it. Agents file their own bugs, behind hard caps, so bugs can't breed bugs."
- **Primitives:** WF (gate follow-up, Oracle TRIAGE dedupe), DO (work ledger and guardrails).

### 5:35–6:35 · 10. Autonomous ship, then a human on escalation `[SIM]` (+ `[LIVE]` L1)

- **10a (5:35–5:55) `[LIVE]` if L1 shipped, else S2:** the lanes page release timeline: STAGING ✓ → VALIDATING ✓ → CANARY 1% → 10% → 50% → 100%, then **SHIPPED by queen:autonomous**. Optionally open the prod URL to show a `/features/…` route answering.
  - **VO:** "Nobody tapped anything. Gates green, Sentinel green, budget green, so the Queen shipped it through a canary on its own."
  - **Primitives:** WF (`queenos-herald`, `queenos-sentinel`), PREV (versions and gradual deployments).
- **10b (5:55–6:20) `[SIM]` S3:** the status home on `incident`.
  1. The release rolls back at 10%.
  2. In **GOALS / Other items**, a `bug` P0 **Release … rolled back: …** appears and starts building.
  3. The second rollback hits. The headline turns red, **NEEDS YOU**. The autonomy pill reads **autonomous → supervised (rollback streak)**, and the **Error budget** tile drains to `0 of 2 left`.
  4. The **NEEDS YOU (1)** card reads **⚠ ROLLBACK_STREAK · hive … · rollback streak**. Click **runbook ▸** to show *What happened / What the Queen did / Resume autonomy / Acknowledge*.
  - **VO:** "Here a release fails its canary. Sentinel rolls it back automatically, and the Queen files a P0 bug with the verdict, the way a team writes a postmortem ticket. When it happens twice in a row, the Queen stops trusting itself: it drops to supervised and pages a human, with a runbook that says what happened and what it already did."
- **10c (6:20–6:35) `[SIM]` S4:** on `night-shift`, the card **⚠ SENTINEL_INCONCLUSIVE · release … · sentinel inconclusive**. Click **Ship anyway**: "Sent: Ship anyway. Waiting for the Queen to confirm." The canary starts, and the release is SHIPPED.
  - **VO:** "And when Sentinel can't measure staging at all, the Queen won't guess, even in an autonomous hive. It parks the release and asks. One click, and the canary still checks every step."
  - **Optional, if time allows:** S3's third act, where **Ship anyway** leads to a third rollback and **ERROR_BUDGET_EXHAUSTED**.
- **Primitives:** DO (release planner, escalation planner, `effectiveAutonomy`), WF (Sentinel, Herald rollback).

### 6:35–7:15 · 11. Drill-down: trace, event log, metrics `[SIM]` (+ `[LIVE]` trace)

- **11a (6:35–6:55):** from the S2 goal, click **trace …▸**. The waterfall's legend reads `item · train · car · command · gate · release` with `total …`. Two dozen train bars start at the same x: they forked together. Car spans are marked **⚡** ("N car spans shared with member traces"). Click a car span: the side panel reads *"⚡ One car, many traces…"* and `Workers Logs: filter trace_id = …`.
  - **Live insert (5 s):** the L1 trace, with bars 40–220 s long.
  - **VO:** "Every goal has one trace id, from the ticket through build, car, gate, release and Sentinel. The parallel bars are the point: they forked together."
- **11b (6:55–7:05):** **Events** with the type filter `queue.`: `queue.car`, `queue.merged`, `queue.conflict`, `queue.bisect`, `queue.landed`.
  - **VO:** "One event log is the audit trail and the source of every drill-down."
- **11c (7:05–7:15):** **Metrics** (24h): the **Concurrency** chart's peak, **Throughput**, **Conflicts and bisects**, and the **Error budget** meter. The source line reads `Queen hourly rollups` in the sim, or `Analytics Engine via the edge` live.
  - **Primitives:** DO (event log, trace), AE (live metrics), Workers Logs (`trace_id`).

### 7:15–7:35 · 12. Hive memory `[LIVE]` L4 (sim fallback)

- **Screen:** the L4 item page with **🧠 N memories recalled ▾**. Expand it: a green **passed** card for L1's *quote* item, with its match score and prompt text. Click **show more**.
- **VO:** "Every gate verdict, whether it passed, failed or was rejected by review, is embedded into Vectorize. When a new agent forks, the hive recalls its closest memories and hands them over before it writes a line. The drones are thrown away. What they learned isn't."
- **Sim fallback:** the item page memory chip of S2's rework (*quartz/ember*), labelled `[SIM] simulated recall · word overlap, not Vectorize`.
- **Primitives:** VEC (`queenos-memory`), WF (`memory: recall` in the Provisioner, `memory: remember` in the gatekeepers), AIG (embeddings).

### 7:35–8:00 · 13. Architecture and close

- **Screen:** the architecture slide, then the answers recap, then the end card.
  - **Architecture:**
    - the **Edge** Worker (Access, dashboard) → **QueenNode DO** per hive (SQLite, WebSockets) + **SwarmGovernor DO**;
    - the Queen dispatches to **Workflows**: Oracle, Provisioner, Drones (Think builder, MERGE, LANDER), Herald, Sentinel;
    - **Artifacts** `repo.pushed` → **Gatekeepers** → verdicts back over RPC;
    - **Vectorize**, **AI Gateway / Workers AI** and **Analytics Engine** in the middle;
    - Genesis and Vault to the side.
  - **Recap:** **Q1** one Queen + event log + trace + hive memory · **Q2** path affinity + speculative merge queue (3-way merge, integration gate, bisect, conflict → rework) · **Q3** gates + LLM reviewer + integration gate + Sentinel + an error budget that gates autonomy.
  - **End card:** **QueenOS** · MIT · `github.com/kaikeru/queenos` · *Run it locally: `pnpm dev:sim`*.
- **VO:** "The Queen only decides, records and dispatches. Every side effect is a durable Workflow on Cloudflare. Awareness from one Queen and a shared memory. Conflicts avoided by ownership and absorbed by a merge queue. Review at every layer, with an error budget deciding when humans are needed. Dozens of engineers live today, thousands by design. That's QueenOS. Run the whole thing locally with one command."

---

## 4. The three questions: where each is answered

| Question | Answer in one line | Shots |
|---|---|---|
| **Awareness:** how does an agent know what others are doing? | One Queen DO per hive is the single writer of every ticket, claim, build and verdict, broadcast over WebSockets. Path claims say who holds which files. The event log and trace give the history, and hive memory gives what past agents learned. | 4 (claims, deps), **5**, 11, 12 |
| **Conflicts:** what happens when changes collide? | First avoided: path affinity serialises predicted overlaps, and the registry merge driver absorbs the generated index. Then absorbed: the speculative merge queue 3-way merges cars, re-gates the merged tree, sends a conflicting member back as a rework that waits for the car it hit, and bisects a failing batch. | 4 (affinity), **6** |
| **Review:** who reviews all of it? | Every build gets policy, security, a preview smoke test and an LLM reviewer against acceptance criteria. Every car gets an integration gate, every release gets Sentinel on staging and each canary step, and an error budget plus a rollback-streak breaker decide when a human is pulled in. | **8**, 7 (ranking), 10 |

---

## 5. Risks and recovery

| Risk | Recovery |
|---|---|
| **v2 isn't live by Oct 12** (Phase 3 slips, or the R16 guard or Oracle deploy fails). | Record the all-sim cut (§0 go/no-go). Every shot has a sim source. Drop the `[LIVE]` inserts and add their seconds back to shots 5, 6 and 11. Shot 12 uses the labelled sim recall. Say "dozens live, thousands by design" only if L1 ran; otherwise say "in simulation; live runs are rate-limited to about a dozen". |
| **Workers AI rate limit (~300 req/min)** throttles L1: builds stall in BUILDING, 429s. | 429s back off and never count as model failures. Lower the goal to 8 bullets, or set `SWARM_AI_RPM` lower so the governor leases fewer slots. Don't run L2 during L1. |
| **The live Oracle truncates or merges bullets.** | If GUARDRAIL_TRIPPED shows, the PATCH in §1d didn't apply: re-run it and re-submit on a fresh hive. Merging two bullets into one item is fine on camera. If the Oracle fails, the goal falls back to "one item, the whole prompt": re-submit. |
| **L1 takes over 30 min** (frontier rebuilds, slow canary). | Time-lapse with the real clock on screen. Only three 5–10 s inserts are needed (fan-out, floor, auto-ship) plus the trace. |
| **The live reviewer approves L3.** | Expected sometimes. Use a rehearsal REJECT take labelled with its date, or show the approve verdict in the ledger and keep 8a on the sim `[review-fail]`. |
| **No memory chip on L4.** | Wait 2 min after the L1 quote verdict and check with `get-vectors --ids`. Re-submit a near-identical prompt (for example `Add a /features/quote endpoint that returns two random programming quotes as JSON`). Last resort: the labelled sim chip. |
| **The live race has a single passer** or the grace window expires. | That's still a decided race: the reason line reads the one that passed. If none passes, the race is ABANDONED and the item reworks. Use S1's race. |
| **A live merge conflict or bisect happens for real.** | It's real, so keep it and narrate it. But don't wait for one: `[collide]` and `[batch-fail]` are sim-only, and affinity prevents most live overlaps. |
| **S2 timing drifts** (bisect or conflict doesn't appear). | The uncommitted `[batch-fail]` hold in `sim-ports.ts` makes the bisect deterministic. Make sure it's committed before recording. If no `queue.bisect` shows, re-run on a fresh hive name. The Queen e2e tests `(e) conflict → rework` and `(f) bisect` cover both paths. |
| **S3 keeps rolling back after the streak.** | That's by design (the `[canary-fail]` prompt stays in every later release). Use a dedicated hive and stop recording after the card. |
| **Sim markers visible in titles.** | Narrate them ("I tagged these"). Don't edit them out. |
| **The goal title is a raw bullet** (Swarm demo button). | Paste the titled prompt (§2.2) instead of clicking, until the Gap is closed. |
| **The "QueenOS was updated. Reload" banner.** | Reload. Don't deploy during recording. |
| **WebSocket drop** (`reconnecting` in the header). | It re-snapshots on its own, and the Queen is the source of truth. Cut around it. |
| **Access session expires mid-take** (escalation buttons or the PATCH fail with 401). | Reload, sign in with the one-time PIN, and retry. Sign in fresh before L1. |
| **The sim's DO state carries old goals.** | Use a new hive name per take. Never `pkill -f wrangler` or `pkill -f vite`: that kills other projects' processes too. Stop only the PIDs you started. |
| **Token visible on screen** (Genesis on the day). | Pause the recording, paste and submit, then resume on the verification checklist. |
| **Chrome automation clicks don't register.** | Drive the browser by hand for recording. |

---

## 6. Gaps worth closing before recording

These don't exist in the code today, so they aren't in the shot list. They're ordered by payoff for the video.

1. **The Swarm demo (24) button's goal title is a raw bullet.** `demoSwarmPrompt()` has no title line, so the goal reads "- Add a /features/otter endpoint returning otter facts". Fix: prepend a title line (for example `Fact endpoints, 24 at once`) in both copies, `apps/queen/src/sim/sim-v2.ts` and `apps/dashboard/src/demo.ts`. Bullet parsing ignores non-bullet lines, and the 2026-10-06 run showed a title line becomes the goal title. Until then, paste the titled prompt.
2. **No in-product "simulation" badge.** The sim dashboard looks identical to live and reports real catalog model names, so honesty depends on the edit. Fix: surface `QUEEN_ENVIRONMENT=sim` in the snapshot and show a `SIM · scripted executors` chip in `HiveHeader`.
3. **No reliable live reviewer REJECT.** The sim has `[review-fail]`; live it's an LLM's judgement. Optional: honour `[review-fail]` live only behind a demo flag (`REVIEW_MODE=scripted` exists, but it swaps the ledger's model to `queenos/review-scripted-v1`, which reads as fake).
4. **The status home has no release strip.** Auto-ship, canary steps and "SHIPPED by queen:autonomous" are only on the lanes page and the item page's RELEASE line, so shot 10a needs a page change. Optional: a one-line current-release row under the headline.
5. **No guardrails control in the dashboard.** Raising `maxChildrenPerItem` live needs the console `PATCH` in §1d. Fine for us, but a settings drawer would make it a visible "WIP limits" moment.
6. **The dashboard shows what was recalled, not whether the builder used it.** If the builder cited consulted memories in `reasoningSteps`, shot 12 could show the link in the ledger.
7. **Queue-wait metrics.** `queue.landed` has no `waitMs` at `3b41399`, so the Metrics **Queue wait** chart is empty. The uncommitted work in `train/planner.ts` and `train/queue.ts` adds it. Land and deploy it before recording, or skip that chart.
8. **The SHIPPED banner has no prod link** (lanes page). The item page has `prod ▸` once `release.prodUrl` is set. Optional: a link on the banner for a cleaner final cut.

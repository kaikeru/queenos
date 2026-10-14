# QueenOS dashboard redesign: one goal page, picks where you look, race-true labels

Status: Draft, approved design 2026-10-14. Every section below was approved with the user; the implementation plan fills in code-level detail only.
Builds on: `docs/superpowers/specs/2026-10-13-queenos-rework-loop-design.md` (race states, REWORK outcome, reject), `docs/HANDOFF.md` §6 (live-check findings).
Scope: `apps/dashboard` only. No backend, schema or MCP changes.

---

## 1. Summary

Replace the item page and the lanes page with one **goal page**, make the hive home a short list of goals with a "Needs you" panel that carries Pick / Reject inline, derive every race label from the race (never from train status alone), and give the whole thing the neon treatment the projects home already has. The hackathon is due 2026-10-14 and the user records the demo video after this ships.

## 2. Problem (verified in the rework-loop live checks, HANDOFF §6, and the dashboard UI preferences)

1. Goal and item pages diverge: `ItemView` and the goal rows on `StatusHome` show different things for the same work.
2. Pick / Reject exists only on the child (`-c1`) item page (`ItemView` renders `RaceEntries` and `RacePick` for `raceViewForItem`), and is hard to find from the goal.
3. PICKING races and passed candidates show as "building" / TESTING, because the labels come from train status (`itemSubState`, `tileGroup`, the chip in `AttemptRow`).
4. Previews must be links only (never iframes), shown as soon as a candidate submits, and never for rejected or superseded heads.
5. There is no "end entries now" outside `ItemView`.
6. The status home is crowded (release strip, tiles, guardrails, swarm floor, merge strip, goal trees, throughput, blocked, composer), and the lanes page (`WarRoom`) is unused.
7. The user wants it flashier, like the projects home page.

## 3. Pages and routing

### 3.1 Routes

- `/p/<hive>`: home.
- `/p/<hive>/items/<id>`: the goal page (§4).
- `queue`, `events`, `metrics`, `push`, `traces/<id>`: unchanged.
- `/p/<hive>/lanes`: removed. It redirects to `/p/<hive>`. `HivePage` loses `"lanes"`, `SIMPLE_PAGES` drops it, and `hrefFor.lanes` is deleted.
- `/items/<id>` walks `parentId` up to the root and renders `GoalPage(root)`. If `<id>` is a child, its race card is highlighted and scrolled into view.
- A loose item (no parent: uncorrelated push, follow-up, self-filed bug) is its own root: the same page with one race card.

### 3.2 Home, top to bottom

1. Header (hive, link state, workers select, autonomy select, push code) and a headline sentence.
2. A two-column row: left ADD A GOAL composer, right NEEDS YOU. On phone width the columns stack with Needs you first.
3. MERGE TREE panel: the graph (main with landed commits plus speculative cars) is always shown. Inside it, a CARS sub-section shows the current train when cars exist, else "No cars in line". The user likes the graph as a talking point.
4. GOALS: one card per root, active before done, newest first. Loose items appear as their own rows. Each row has the title, a race chip, a one-line summary and agent tiles.
5. HIVE HEALTH, collapsed at the bottom: release strip, tiles, guardrails, throughput, blocked/failed, and `SwarmFloor` on swarm hives only.

### 3.3 Composer

- Add goal only: title plus intent / work spec. Judge `auto | you pick` on external hives. On swarm hives it files with `decompose` so the Oracle splits it.
- The demo and swarm buttons are removed.
- Orchestrators may also create goals over MCP (`create_goal`); agents push to `goal/<slug>` or `item/<id>`.

### 3.4 Needs you

- Escalations plus every PICKING race, with inline Pick / Reject / Reject all (a compact `RacePick`).
- Empty state: a small ASCII bee with "Nothing needs you." The two-column row is kept; the layout does not collapse.

### 3.5 Agent tiles in goal rows

One tile per live candidate (hover: agent and claimed model), race-outlined like the old swarm floor tiles (`.frace`), but grouped per goal. Filled = passed, hollow = gating or reworking.

### 3.6 Moved and removed

- The lanes page (`WarRoom.tsx`) and the helpers only it uses are deleted if nothing else uses them (see §8 for what is still shared).
- The Model Board (`ModelBoard`) moves to the Metrics page.
- The footer (`HiveFooter`) drops the lanes and models links.

### 3.7 Layout

```
┌ demo · linked 42ms · workers [external] · autonomy [auto] · push code ▸ ┐
│ ● 2 races running, 1 waiting for your pick                              │
├────────────────────────────────────┬────────────────────────────────────┤
│ ADD A GOAL                         │ NEEDS YOU (1)                      │
│ ┌────────────────────────────────┐ │ Rename morse key · you pick 4:10   │
│ │ title                          │ │  w1 sonnet passed preview ▸ [Pick] │
│ │ intent / work spec …           │ │  w2 haiku  passed preview ▸ [Pick] │
│ └────────────────────────────────┘ │  [Reject all]                      │
│ judge (•) auto ( ) you pick [Add]  │                                    │
├────────────────────────────────────┴────────────────────────────────────┤
│ MERGE TREE                                                              │
│  main ●──●──●──●──●  (landed)                                           │
│            └─◆ K12 ─◆ K13 (speculative)                                 │
│  CARS  K12 [merging] w1 · K13 [gating] w4      (or "No cars in line")   │
├─────────────────────────────────────────────────────────────────────────┤
│ GOALS                                                                   │
│  Rename morse key      [you pick 4:10]     ▣▣ ▢   2 passed, 1 rework    │
│  Update features index [racing · 3:12]     ▣ ▢    1 gating, 1 failed    │
│  Add bmi page          [landed]                                         │
│  fix: typo in moon     [follow-up · racing] ▣                           │
├─────────────────────────────────────────────────────────────────────────┤
│ ▸ HIVE HEALTH (release strip, tiles, guardrails, throughput, blocked)   │
└─────────────────────────────────────────────────────────────────────────┘

Empty Needs you:
│ NEEDS YOU                          │
│      \_/                           │
│   -=(_'_)>  Nothing needs you.     │
│      / \    The hive is buzzing.   │
```

## 4. Goal page and race cards

### 4.1 Layout

```
┌ ◂ demo / goal "Rename morse key"                                   trace ▸ ┐
│ Rename the morse key from `dot` to `dit` across src/features/morse.js     │
│ [agent:orchestrator@kyle] [you pick] [P2]                                │
│ ☐ /features/morse returns dit for "."                                    │
│ $ git push origin HEAD:goal/rename-morse-key/<your-agent-name> [copy]    │
│ [Retry] [Cancel]                                                         │
├──────────────────────────────────────────────────────────────────────────┤
│ ▸ Rename morse key                         [ you pick · 4:10 left ]      │
│ ┌──────────────────────────────────────────────────────────────────────┐ │
│ │ w1@kyle  claims sonnet   [passed]      preview ▸   [Pick] [Reject]   │ │
│ │ w2@kyle  claims haiku    [passed]      preview ▸   [Pick] [Reject]   │ │
│ │ w3@kyle  claims opus     [reworking · human · due 12:30]             │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
│                                                        [Reject all]      │
│ ▸ details (claims, history, memories, events)                            │
├──────────────────────────────────────────────────────────────────────────┤
│ ▸ Update features index        [ racing · entries close 3:12 ]           │
│ ┌──────────────────────────────────────────────────────────────────────┐ │
│ │ w4@kyle  claims sonnet   [gating]                                    │ │
│ │ w5@kyle  claims opus     [failed: lint: unexpected token]  preview ▸ │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
│                                                   [End entries now]      │
│ ▸ details                                                                │
├──────────────────────────────────────────────────────────────────────────┤
│ ▸ Add morse docs               [ awaiting submissions ]                  │
│   No candidates yet. Agents push to item/3f2a…/<your-agent-name>         │
├──────────────────────────────────────────────────────────────────────────┤
│ RELEASE  4f0b76d0 · canary 10% · prod ▸                                  │
└──────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Header

Breadcrumb, title, body / intent, origin chip (`OriginChip`), judge chip, priority, trace link, acceptance, the push command on external hives (`goal/<slug>/<your-agent-name>` where a slug exists, else `item/<id>/<your-agent-name>`, the shared-token convention of `itemPushCommand`; loose items use the `item/` form), and the item actions (retry / cancel / not duplicate; the existing `ItemActions`, driven by `validItemActions`).

### 4.3 Race cards

One per child item in filed order (one for a loose item).

- Title row: the item title plus a race chip derived from the race:
  - `racing · entries close m:ss` / `racing · entries closed`
  - `you pick · m:ss left`
  - `reworking · due in m:ss`
  - `decided` / `landed` / `abandoned`
  - no race: `awaiting submissions` (external hives) or the build sub-state (swarm hives, where "building" is true)
- Candidate rows show only each contributor's current head (rejected and superseded heads are hidden). Decision (candidate identity): the candidate index is not stable, because every push that joins a race gets a new index (`candidate: race.trainIds.length - 1`, `planner.ts` ~1066). So `currentCandidates` (U1) works per contributor:
  - A contributor's key is `origin.id` plus `attemptId` when the train has one. MCP attempts: one candidate per attempt. Git pushes: one per agent identity. Drone trains (`origin` missing or kind drone): each train is its own contributor.
  - The current head is the contributor's newest train in the race (by `createdAt`).
  - Older trains of the same contributor are superseded / old heads and appear only in "details". The train `reason` text is not used.
  - A contributor whose newest train is EJECTED shows as failed, or as reworking if a rework slot is open. Each row has:
  - origin (agent, "claims <model>");
  - a verdict chip: passed, `failed: <first finding>`, gating, reworking (findings / conflict / human), won ★, lost;
  - a "preview ▸" link as soon as `previewUrl` exists (never embedded);
  - Pick and Reject when the race is PICKING.
- Card actions: Reject all (PICKING); End entries now (RACING with entries open; reuse `RaceEntries`).
- Collapsed "details" per card: claims / conflicts, attempt history (including old heads), memories, the last 12 events.
- Footer of the page: the release line (phase, canary %, prod link).

### 4.4 Labelling rule

Pure `raceStatus(race, trains, item)` and `candidateStatus(train, race)` live in one module and are used by goal rows, race cards, Needs you and agent tiles. Nothing derives a label from train status alone while a race exists. A passed candidate in PICKING reads "passed · waiting for your pick".

### 4.5 Out of scope, follow-up

Queen-side auto-close of a reopened window once all rejected candidates re-pass.

## 5. Visual treatment ("flashy like the projects home page")

Reuse the existing `styles.css` vocabulary: `.pcard` gradient cards, cyan / violet neon, `.btn--launch` and `.btn--ship` gradients, `glow-yellow`, `flash-green` / `flash-red`, `step-pulse`, `land`, `shake`, `ring`, `crown`, `.celebrate`, and the shimmer skeleton.

Rule: motion only marks a state change or something waiting on the human. There are no idle pulses except pending picks.

1. Hero headline: `.sh-head` (page-head style) with a gradient tint by hive mood (calm / racing / needs you / degraded).
2. Goal rows as `.pcard`-like cards with a state-colored edge and gradient wash: cyan racing, gold glow you pick (the only steady pulse), violet reworking, green landed, red failed.
3. Pick button gold (`.btn--ship` gradient). The Needs you panel gets the `glow-yellow` border while a pick is pending.
4. Agent tiles: slide-in on submit, flash-green on pass, flash-red on fail, crown pop for the winner, and the race outline rings in the last 60 s.
5. Merge tree: a new landed commit drops onto main (`land` keyframe plus a green flash), gating cars pulse (`step-pulse`), a bisect shakes.
6. Landed celebration: a one-time short `.celebrate` banner on the goal card ("Landed · w1 sonnet · prod ▸") with the crown, then it settles.
7. Add goal button with the `.btn--launch` gradient (smaller size).
8. Shimmer skeletons instead of "Loading…".
9. All motion off under `prefers-reduced-motion`; the colors stay.

CSS plus class toggles driven by state transitions the reducer already sees. No new libraries.

## 6. Build units

Units have disjoint files. Order: U1, then U2 to U5 in parallel, then U6.

| Unit | Files | Notes |
|---|---|---|
| U1 status logic | new `raceStatus.ts` + test | `raceStatus`, `candidateStatus`, `currentCandidates` (one head per contributor, §4.3; hides old heads), `rootOf`, `goalSummary`, `agentTiles`. The contract; done first. |
| U2 goal page | new `GoalPage.tsx`, `RaceCard.tsx`; `ItemView.tsx` removed | Reuses `RacePick`, `RaceEntries`, `RejectBox`. |
| U3 home | `StatusHome.tsx`, `HomePanels.tsx` | Composer, Needs you, goals list, collapsed hive health. |
| U4 merge tree panel | `MergeGraph.tsx` | Graph plus the CARS sub-section ("No cars in line"). |
| U5 removal | `route.ts`, `App.tsx`, `shell.tsx`, `WarRoom.tsx`, `lanes.ts`, `Metrics.tsx` | `/lanes` redirect, delete lanes page, Model Board to Metrics, footer links. See §8 on `lanes.ts`. |
| U6 visual | `styles.css` | One new section, last. |

## 7. Testing

- U1: exhaustive unit tests: every race state by candidate outcome; PICKING never yields "building" / TESTING; superseded heads hidden.
- Route tests (`test/route.test.ts`): `/lanes` redirects to home; a child id resolves to its root.
- Render tests in the existing `.test.tsx` pattern (`test/racepick.test.tsx`, `test/swarmui.test.tsx` style: `renderToString`): action buttons appear exactly when the race state allows, on the goal page and in Needs you; the bee empty state; "No cars in line".
- Dashboard `tsc -p test` plus the full gate (`pnpm turbo run build typecheck lint test --force --continue`).
- A live look in `dev:sim` on spare ports with the `[you-pick]` and rework demo markers; the user eyeballs it.
- Mock mode stays read-only (`VITE_MOCK_API=1`: no POST actions, as `RacePick` and `RaceEntries` already do).

## 8. Backend

No backend changes. The routes exist and the helpers are in `apps/dashboard/src/api.ts`: `api.pickRace`, `api.rejectRace`, `api.closeRaceEntries` (close-entries is present, so nothing is added in U2), and `api.itemAction`.

## 9. Non-goals

- Backend, MCP, schema or Queen changes (including the auto-close follow-up in §4.5).
- New libraries, new animation frameworks, iframes or embedded previews.
- New features beyond what is listed: no new pages, no new actions.
- Changes to the queue, events, trace, push or setup pages beyond the footer links and the Model Board addition on Metrics.
- Changing swarm-hive build behaviour; only labels and layout change.

## 10. Open questions

1. `lanes.ts` is not wholly dead: `relativeTime` is imported by `PushCode.tsx` and `ItemView.tsx`, and `components.tsx` imports `earlierSummary`, `groupLanes`, `relativeTime`. U5 should delete only the lane-grouping exports (`groupLanes`, `earlierSummary`, `newestFirst`, `isFinishedLane`, `RECENT_LANES`) and keep or relocate `relativeTime`. `test/lanes.test.ts` follows.
2. Lanes-only code in `components.tsx` (`TopBar`, `MainTrack`, `Lanes`, `LedgerPanel`, the old `Composer`, `Sites`, `ReleaseTimeline`, `Ticker`) and `reducer.ts` (`buildLanes`, `buildSites`, `AuditCard`, `Lane`) is used by `WarRoom` only as far as the grep shows. `ReleaseTimeline` / `CanaryBar` / `ShippedBanner` and `currentRelease` / `siteReleaseView` may be used by the release strip or `HomePanels`; U5 must grep before deleting. `MemoryRecall`, `useNow`, `ModelBoard` stay.
3. `useRoom` and the `Room` type live in `WarRoom.tsx` and are imported by `App.tsx` and `StatusHome.tsx`. They must move (for example to a `room.ts` or into `hooks.ts`) before `WarRoom.tsx` is deleted. U5 owns the move, so U3 should import `Room` from the new location.
4. `goalTrees` (`status.ts`) splits `goals` and `loose`, and `raceViewForItem` returns one race per item. A race card per child uses only the newest race; older (ABANDONED) races of the same item appear only in "details". Confirm that is what the user wants.

## 11. Self-review

- No TBDs. Every unit in §6 maps to a requirement in §3 to §5 and a test in §7.
- The two diagrams (§3.7 and §4.1) are the approved ones; only the push-command text in §4.1 changed to the `/<your-agent-name>` form.
- Labels: §4.4 is the single source; §3.4, §3.5 and §4.3 all defer to it.
- No contradiction found between "no idle pulses" (§5) and the gold you-pick pulse: the latter is the stated exception because it marks something waiting on the human.

# QueenOS Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Subagents do NOT commit.** Each task ends with a "Coordinator commits" step: the implementing subagent stops after its verification step and reports; the coordinator verifies, runs the token scan, and makes the commit with the message given.

**Goal:** Replace the item page and the lanes page with one goal page, make the hive home a short goal list beside a "Needs you" panel with inline Pick / Reject, derive every race label from the race (never from train status alone), and give it the projects-home neon treatment.

**Architecture:** A pure contract module (`apps/dashboard/src/raceStatus.ts`, Task 1) turns races and trains into chips, candidate rows, goal rows, Needs-you rows, agent tiles and the headline; every view reads labels only from it. Task 1 also moves `useRoom` / `Room` to `room.ts` and turns the pick controls in `RacePick.tsx` into shared exports (`CandidateActions`, `RejectAll`), so Tasks 2 to 5 can run in parallel on disjoint files: the goal page (`GoalPage.tsx`, `RaceCard.tsx`), the home (`StatusHome.tsx`, `HomePanels.tsx`), the merge tree panel (`MergeGraph.tsx`) and the removal of the lanes page. Task 6 styles every class name the markup tasks emit, in one new `styles.css` section.

**Tech Stack:** pnpm 9 + Turborepo, TypeScript 5.9, React 19 + Vite 8, vitest 4 (`renderToString` render tests, node environment), `@queenos/queen-types` (zod 4).

**Spec:** `docs/superpowers/specs/2026-10-14-queenos-dashboard-redesign-design.md` (approved 2026-10-14; § numbers below refer to it). Read it in full first. Background: `docs/superpowers/specs/2026-10-13-queenos-rework-loop-design.md` (race states, REWORK, reject), `docs/HANDOFF.md` §1 (work rules).

**Verified:** every code block in Tasks 1 to 6 was applied to a scratch copy of `apps/dashboard` and checked: `eslint .`, `tsc --noEmit`, `vite build`, and vitest (20 files, 276 tests) pass; the Task 1 checkpoint alone passes too (16 files, 258 tests). Every `diff` block is a unified diff with `a/apps/dashboard/...` paths: save it to a file and `git apply <file>` from the repo root (they were checked with `git apply --check` against `main` at 5bf5a54; the Task 5 `App.tsx` diff applies on top of Task 1).

## Global Constraints

- **Node:** every shell first runs `export PATH=~/.nvm/versions/node/v24.17.0/bin:$PATH`.
- **Scope:** `apps/dashboard` only (§1, §9). No backend, schema, MCP or Queen changes; no new dependencies; no `package.json` or `pnpm-lock.yaml` edits.
- **Shared types only from `@queenos/queen-types`.** Never import Node built-ins.
- **Labelling rule (§4.4):** `raceStatus` / `candidateStatus` (Task 1) are the only source of race and candidate labels. Nothing derives a label from train status alone while a race exists. A passed candidate in PICKING reads `passed · waiting for your pick`.
- **Previews are links only (§2.4):** never an `<iframe>`; shown as soon as `previewUrl` exists; never for rejected (lost, reworking) or superseded heads.
- **Motion (§5):** only for a state change or something waiting on the human; the you-pick gold pulse is the only steady one. All motion off under `prefers-reduced-motion` (colors stay). CSS and class toggles only; no new libraries.
- **Mock mode stays read-only** (`VITE_MOCK_API=1`): POST buttons render disabled, as `RacePick` / `RaceEntries` already do.
- **Commands run from `apps/dashboard`:**
  - one file: `pnpm exec vitest run test/<file>`
  - all dashboard tests: `pnpm --filter @queenos/dashboard test`
  - typecheck (src): `pnpm --filter @queenos/dashboard typecheck` (it is `tsc --noEmit`; the dashboard `tsconfig.json` includes `src` and `vite.config.ts` only)
  - lint: `pnpm --filter @queenos/dashboard lint`
  - **test typecheck:** the dashboard has no `test/tsconfig.json`, so `tsc -p test` does not exist. Use a throwaway config outside the repo:
    ```bash
    cat > "${TMPDIR:-/tmp}/dash-tsc-test.json" <<EOF
    { "extends": "$PWD/tsconfig.json", "include": ["$PWD/src", "$PWD/test", "$PWD/vite.config.ts"] }
    EOF
    pnpm exec tsc --noEmit -p "${TMPDIR:-/tmp}/dash-tsc-test.json"
    ```
    Expected: exactly one error, pre-existing on `main`: `test/release-strip.test.ts(82,41): error TS2493`. Anything else is yours to fix.
- **Full gate (Task 7 and the coordinator after each wave):** from the repo root, `pnpm turbo run build typecheck lint test --force --continue --concurrency=4`; expect 49/49 successful. Never raise the concurrency.
- **Parallel wave (Tasks 2 to 5):** file ownership is disjoint (table below). Touch only your files. Until all four land, `tsc` may report errors in files you do not own that name only `MergeTreePanel` (Task 4 adds it), `./GoalPage` (Task 2 adds it) or `hrefFor.lanes` (Task 5 removes it; Task 3 drops the last caller). Ignore those; fix everything else. The coordinator runs typecheck, lint and the full gate once the wave lands.
- **Commits (coordinator only):** Conventional style. Token scan first: `/usr/bin/grep -rlF --exclude-dir=node_modules --exclude-dir=.wrangler --exclude-dir=.git -e "$CLOUDFLARE_API_TOKEN" . ; echo "scan exit $?"` must print `scan exit 1`. Stage files by path (never `git add -A` / `.`), never stage `.claude/ .gemini/ .github/ .mcp.json .opencode/ .vscode/`. Each message ends with exactly:
  ```
  Queen-Origin: agent:claude-code
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```
- **Live checks:** spare ports only (Queen 8797, inspector 9297, dashboard 5197). **Never `pkill`**; kill only PIDs you started.

## Review Focus

1. **The same agent pushes twice into one race** (a fix after a reject, or a second push). Expected: one row for that contributor (its newest train), the old head only under "details", and no preview link for the old or rejected head. Owner: Task 1 "superseded heads never reach the rows, and rejected / reworking heads get no preview link"; Task 2 "superseded and rejected heads are hidden, with no preview link".
2. **A deadline already passed but the Queen has not moved the race yet** (the alarm runs late). Expected: `you pick · 0:00 left` and `racing · entries closed`, never a negative or stale countdown. Owner: Task 1 "PICKING: a countdown that never goes negative" and "RACING: entries open, entries closed, deciding, plain".
3. **A deep link to a child id, or to an id the live state does not hold** (cold load, an older item). Expected: the root's page with that card highlighted, or a shimmer skeleton while it loads; never a crash. Owner: Task 2 "a child id renders its root's page with that card highlighted" and "an id the state does not hold renders the shimmer skeleton".
4. **A race leaves PICKING while the human looks** (another judge picked, the deadline auto-picked). Expected: Pick / Reject vanish on the next frame and the race leaves Needs you; a click on a stale button gets the existing 409 "Refreshing…" message. Owner: Task 3 "RACING and decided races are not in Needs you"; Task 2 "a decided race: no Pick, no Reject all, no End entries now".
5. **Odd origins** (an agent id with no owner, a human push, a drone train with no model). Expected: a readable who label (`solo`, `kyle`, `c2`), never a blank row. Owner: Task 1 "agent name@owner with its claim, a human's local part, a drone's model or tag".

## Plan rulings (spec §10 open questions and gaps, resolved)

- **R1 `lanes.ts` (§10.1):** delete `RECENT_LANES`, `isFinishedLane`, `newestFirst`, `LaneGroups`, `groupLanes`, `earlierSummary` and the `Lane` import. Keep `relativeTime` in `lanes.ts` (callers after this plan: `PushCode.tsx`, `RaceCard.tsx`), so no import moves mid-wave. `test/lanes.test.ts` keeps only "relativeTime buckets". Owner: Task 5.
- **R2 `components.tsx` (§10.2):** keep exactly `useNow`, `MemoryRecall`, `TierBadge`, `ModelChip`, `SideSection` (private, used by `ModelBoard`), `floorLine`, `FloorLine` (private), `ModelBoard`. Delete `ROLE_LABEL`, `ROLE_GLYPH`, `clock`, `short`, `TopBar`, `Stat`, `MAX_COMMITS`, `MainTrack`, `Lanes`, `LaneRow`, `Chip`, `phaseClass`, `TrainCar`, `FailureReason`, `hostOf`, `PreviewLink`, `CardView`, `LedgerPanel`, `Composer`, `STATUS_TONE`, `VERDICT_TONE`, `VerdictLine`, `PHASE_CHIP`, `UrlLink`, `Sites`, `CanaryBar`, `ShippedBanner`, `ReleaseTimeline`, `Ticker`. Grep confirms every deleted one is used only inside `components.tsx` or by `WarRoom.tsx`; `test/models.test.ts` imports `floorLine` (kept). Owner: Task 5.
- **R3 `reducer.ts` (§10.2): delete nothing.** `buildLanes`, `Lane`, `LaneTrain`, `buildCards`, `AuditCard`, `buildSites`, `SiteRow`, `previewView`, `PHASE_FLOW` stay: `memory.ts` (`laneMemories`) uses `LaneTrain`, and `test/reducer.test.ts` covers all of them. Deleting them rewrites a 396-line test file for no user-visible gain on deadline day. They become unused by the UI, which lint does not flag. `releases.ts` (`currentRelease`, `siteReleaseView`) also stays (tested; `releaseStrip` and `prodUrlOf` are used by the home).
- **R4 `useRoom` / `Room` (§10.3):** move to a new `apps/dashboard/src/room.ts`, owned by **Task 1** (not Task 5 as the spec suggested), because Task 3 needs `Room` from a file that exists before the wave starts. Task 1 also repoints `App.tsx`, `StatusHome.tsx` and `WarRoom.tsx` at it. Everyone else imports `Room` from `./room`.
- **R5 Older races (§10.4):** adopt the spec's default: a race card shows the item's newest race (open races first, `racesForItem`); older races (ABANDONED etc.) are listed only in the card's "details". Confirm with the user during the sim check.
- **R6 `ItemView.tsx` is deleted by Task 5, not Task 2** (spec §6 lists it under U2). Task 5 owns `App.tsx`, which is where `ItemView` is swapped for `GoalPage`; deleting both in one task keeps `App.tsx` importable at every checkpoint.
- **R7 Shared pick controls in Task 1.** `RacePick.tsx` gains exported `CandidateActions` (Pick with an optional reason, Reject with a required reason) and exports `RejectAll`; both race cards (Task 2) and Needs you (Task 3) render them. The iframe preview in `RacePick` is removed (§2.4); the existing test that asserted it flips to `not.toContain("<iframe")`.
- **R8 `raceStatus` takes a context argument:** `raceStatus(race, trains, item, { now, external, subState })`. Countdowns need `now`; "awaiting submissions" vs the build sub-state needs `external` and `subState` (§4.3).
- **R9 Goal slug:** `WorkItem` has no slug. `titleSlug` copies the Queen's `slugify` (`apps/queen/src/work/inbox.ts:96`, ≤ 64 chars); the Queen matches `goal/<slug>` against the newest goals by `slugify(title)` (`queen-node.ts:2091`), or by item id. A goal whose title slugs to nothing uses `item/<id>/<your-agent-name>`.
- **R10 Cards are the root's direct children** in filed order (`itemOrder`), or the root itself when it has none (a loose item, a goal not split yet). Grandchildren of nested goals are not shown (the Oracle does not nest today).
- **R11 SwarmFloor stops rendering PICKING `RacePick` panels** (they would duplicate Needs you). Owner: Task 3.
- **R12 Composer on swarm hives** loses "split into items", best-of and "you pick (3)" (§3.3: judge on external hives only, swarm goals always decompose). The sim `[you-pick]` marker still makes a human-judged race.
- **R13 Fresh-state motion:** `trackFresh` (Task 1) marks tile and landing keys first seen after the page loaded; a tile key is `${trainId}:${kind}`, so a state change remounts the tile and its CSS animation plays once. The celebration banner fades itself out after about 6 s (CSS) and is hidden under reduced motion.
- **R14 Model Board on Metrics** only on swarm hives, as the lanes page did (`!isExternal(state.hive)`), inside `<section id="models">`.
- **R15 `/p/<hive>/lanes`** matches as `{ name: "warroom", hive, page: "status", redirectTo: "/p/<hive>" }`; `App` renders home and `navigate(redirectTo, { replace: true })`.

## File map and ownership

| File | Task | Responsibility |
|---|---|---|
| `src/raceStatus.ts` (new), `test/raceStatus.test.tsx` (new) | 1 | The label contract and its exhaustive tests |
| `src/room.ts` (new) | 1 | `useRoom`, `Room` (moved out of `WarRoom.tsx`) |
| `src/RacePick.tsx`, `test/racepick.test.tsx` | 1 | `CandidateActions`, exported `RejectAll`, no iframe |
| `src/App.tsx`, `src/StatusHome.tsx`, `src/WarRoom.tsx` | 1 (import lines only) | Point at `./room` |
| `src/GoalPage.tsx` (new), `src/RaceCard.tsx` (new), `test/goalpage.test.tsx` (new) | 2 | Goal page and race cards |
| `src/StatusHome.tsx`, `src/HomePanels.tsx`, `src/SwarmFloor.tsx`, `src/homeLogic.ts`, `test/home.test.tsx` (new) | 3 | Home: headline, Add a goal, Needs you, goals, hive health |
| `src/MergeGraph.tsx`, `test/mergetree.test.tsx` (new) | 4 | `MergeTreePanel` (replaces `MergeTrainStrip`) |
| `src/route.ts`, `src/App.tsx`, `src/shell.tsx`, `src/Metrics.tsx`, `src/components.tsx`, `src/lanes.ts`, `src/WarRoom.tsx` (delete), `src/ItemView.tsx` (delete), `test/route.test.ts`, `test/lanes.test.ts`, `test/metrics-models.test.tsx` (new) | 5 | Remove lanes, route items to the goal page, Model Board to Metrics, footer |
| `src/styles.css` | 6 | One new section; drop `.rp__frame` |
| `docs/HANDOFF.md` | 7 (coordinator) | Milestone entry |

All paths are under `apps/dashboard/` unless they start with `docs/`.

## Task order

| Task | Unit | Model tier | Runs |
|---|---|---|---|
| 1 | U1 status logic (the contract) + shared scaffolding | Opus | first, alone |
| 2 | U2 goal page | Sonnet | wave, parallel with 3, 4, 5 |
| 3 | U3 home | Sonnet | wave |
| 4 | U4 merge tree panel | Sonnet | wave |
| 5 | U5 removal | Sonnet | wave |
| 6 | U6 visual (`styles.css`) | Sonnet | after the wave |
| 7 | Full gate, sim check, handoff | coordinator | last |

---

### Task 1: U1 race-true status logic (the contract), `room.ts`, shared pick controls

**Files:**
- Create: `apps/dashboard/src/raceStatus.ts`
- Create: `apps/dashboard/src/room.ts`
- Create: `apps/dashboard/test/raceStatus.test.tsx`
- Modify: `apps/dashboard/src/RacePick.tsx` (`CandidateActions`, export `RejectAll`, `Card` without the iframe)
- Modify: `apps/dashboard/test/racepick.test.tsx:129` (iframe assertion flips)
- Modify (import lines only): `apps/dashboard/src/App.tsx`, `apps/dashboard/src/StatusHome.tsx`, `apps/dashboard/src/WarRoom.tsx`

**Interfaces:**
- Consumes (existing, unchanged): `countdownText(ms)`, `entryState(race, now)`, `pickRemainingMs(race, now)` from `./raceLogic`; `itemSubState(state, item)`, `isBuildTrain`, `itemIdOf`, `raceView`, type `SubState` from `./swarm`; `isPushed`, `originBadge`, type `OriginBadge` from `./origin`; `openEscalations`, `landedCount` from `./status`; `isExternal`, `itemPushCommand`, `autonomyLabel` from `./homeLogic`; `parseReworkReason`, `MergeTrain`, `Race`, `WorkItem` from `@queenos/queen-types`; type `ItemDetail` from `./api`.
- Produces (`src/raceStatus.ts`), used by Tasks 2, 3, 4:
  - `type Tone = "cyan" | "gold" | "violet" | "green" | "red" | "muted"`
  - `type RaceChipKind = "racing" | "picking" | "reworking" | "decided" | "landed" | "abandoned" | "awaiting" | "building" | "failed" | "cancelled"`
  - `interface RaceStatus { kind: RaceChipKind; text: string; tone: Tone; pulse: boolean }`
  - `type CandidateKind = "building" | "gating" | "passed" | "failed" | "reworking" | "won" | "lost"`; `interface CandidateStatus { kind; text; tone }`
  - `type StatusSlice = Pick<State, "trains" | "trainOrder" | "items" | "itemOrder" | "races" | "events" | "landed" | "hive" | "escalations" | "escalationOrder">` (a full `State` satisfies it)
  - `raceStatus(race: Race | null, trains: readonly MergeTrain[], item: WorkItem, ctx: { now: number; external: boolean; subState?: SubState | null }): RaceStatus`
  - `candidateStatus(t: MergeTrain, race: Race, now: number): CandidateStatus`
  - `currentCandidates(race, trains): { heads: MergeTrain[]; old: MergeTrain[] }`, `contributorKey(t): string`, `whoOf(t): { who: string; claim: string | null }`, `firstFinding(t): string | null`
  - `interface CandidateRow { train; key; tag; who; claim; origin: OriginBadge; status: CandidateStatus; previewUrl: string | null; pickable: boolean }`; `candidateRows(race, trains, now): { heads: CandidateRow[]; old: MergeTrain[] }`
  - `racesForItem(races: Record<string, Race>, itemId): Race[]`, `isOpenRace(r): boolean`
  - `rootOf(items: Record<string, WorkItem>, id: string): WorkItem | null`, `cardItems(state, root): WorkItem[]`
  - `interface CardSummary { item; race: Race | null; olderRaces: Race[]; status: RaceStatus; heads: CandidateRow[]; old: MergeTrain[]; trains: MergeTrain[] }`; `cardSummary(state: StatusSlice, item, now): CardSummary`
  - `goalStatus(root, cards): RaceStatus`, `goalSummary(cards: CardSummary[]): string`
  - `interface AgentTile { key; trainId; kind: CandidateKind; filled: boolean; title: string }`, `interface AgentTileGroup { raceId; lastMinute: boolean; tiles: AgentTile[] }`; `agentTiles(cards, now): AgentTileGroup[]`
  - `interface GoalRow { root; cards: CardSummary[]; status: RaceStatus; summary: string; tiles: AgentTileGroup[]; followUp: boolean; done: boolean }`; `goalRow(state, root, now)`, `goalRows(state, now): GoalRow[]`, `isFollowUp(item): boolean`
  - `interface PickRow { race; item; root; status: RaceStatus; heads: CandidateRow[] }`; `pickingRows(state, now): PickRow[]`
  - `type HiveMood = "calm" | "racing" | "needs-you" | "degraded"`; `homeHeadline(state: StatusSlice): { mood: HiveMood; text: string }`
  - `withDetail(state, detail: ItemDetail | null | undefined)`: the same slice type with REST rows folded in (live wins)
  - `titleSlug(title): string`, `pushCommand(item): string`
  - `trackFresh(memo: { seen: Set<string> | null; fresh: Set<string> }, keys: readonly string[]): ReadonlySet<string>`
  - `raceChipClass(s): string` → `race-chip race-chip--<tone>[ race-chip--pulse]`; `candChipClass(s): string` → `cand-chip cand-chip--<kind>`
- Produces (`src/room.ts`): `useRoom(hive: string)` → `{ state, dispatch, status, latencyMs, retryAt, send }`; `type Room = ReturnType<typeof useRoom>`.
- Produces (`src/RacePick.tsx`): `CandidateActions({ hive, raceId, trainId, tag, compact?, onChanged? })`, `RejectAll({ hive, raceId, onChanged? })`.
- **Class names emitted** (Task 6 styles them): `race-chip`, `race-chip--{cyan,gold,violet,green,red,muted}`, `race-chip--pulse`, `cand-chip`, `cand-chip--{building,gating,passed,failed,reworking,won,lost}`, `cand__actions`, `cand__actions--compact`, `cand__pick` (with `btn btn--ship`), `cand__reject`; existing `rp__confirm`, `rp__reject`, `rp__reject-all`, `rp__link`.

- [ ] **Step 1: Write the failing tests**

Create `apps/dashboard/test/raceStatus.test.tsx`:

```tsx
/** Dashboard redesign U1: race-true labels (spec §4.4, §7). One module labels races, candidates, goal rows, Needs you and tiles. */
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { reworkReasonText, type HiveStatus, type MergeTrain, type Race, type RaceState, type WorkItem } from "@queenos/queen-types";

import { CandidateActions, RacePick, RejectAll } from "../src/RacePick";
import {
  agentTiles, candChipClass, candidateRows, candidateStatus, cardItems, cardSummary, contributorKey, currentCandidates, firstFinding, goalRow, goalRows, goalStatus, goalSummary,
  homeHeadline, isFollowUp, pickingRows, pushCommand, raceChipClass, raceStatus, racesForItem, rootOf, titleSlug, trackFresh, whoOf, withDetail, type StatusSlice,
} from "../src/raceStatus";
import { initialState } from "../src/reducer";
import { raceView } from "../src/swarm";

const NOW = 1_800_000_000_000;
const SHA = "0".repeat(40);

const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  itemId: "i1", hive: "demo", kind: "feature", title: "Rename morse key", body: "", acceptance: [], priority: 2, status: "ACTIVE", parentId: null, rootId: over.itemId ?? "i1", depth: 0,
  dependsOn: [], source: { kind: "user", actor: "kyle@kaikeru.com" }, traceId: "a".repeat(32), spanId: "b".repeat(16), difficulty: "normal", bestOf: null, attempts: 0, conflicts: 0,
  paths: [], waitReason: null, duplicateOf: null, blockedReason: null, releaseId: null, escalationId: null, createdAt: NOW - 600_000, updatedAt: NOW - 600_000, ...over,
});
const race = (over: Partial<Race> = {}): Race => ({
  raceId: "r1", itemId: "i1", width: 1, state: "RACING", trainIds: [], winnerTrainId: null, reason: null, deadlineAt: null, createdAt: NOW - 300_000, decidedAt: null, ...over,
});
const agent = (name: string, model = "sonnet") => ({ kind: "agent" as const, id: `${name}@kyle@kaikeru.com`, model });
const train = (id: string, over: Partial<MergeTrain> = {}): MergeTrain => ({
  trainId: id, baseSha: SHA, includedPrompts: ["i1"], artifactRepo: "demo", status: "TESTING", phase: "TESTING", lane: "BUILD", createdAt: NOW - 200_000, raceId: "r1", candidate: 0,
  raceOutcome: "RACING", origin: agent("w1"), previewUrl: `https://${id}.example.dev`, ...over,
});
const slice = (items: WorkItem[], races: Race[], trains: MergeTrain[], hive: Partial<HiveStatus> | null = null): StatusSlice => ({
  ...initialState,
  items: Object.fromEntries(items.map((i) => [i.itemId, i])),
  itemOrder: items.map((i) => i.itemId),
  races: Object.fromEntries(races.map((r) => [r.raceId, r])),
  trains: Object.fromEntries(trains.map((t) => [t.trainId, t])),
  trainOrder: trains.map((t) => t.trainId),
  hive: hive as HiveStatus | null,
});
const EXTERNAL = { settings: { executors: "external", autonomy: "autonomous" }, effectiveAutonomy: "autonomous", degradedBy: [], throughput: { landed24h: 4 } } as unknown as Partial<HiveStatus>;
const ctx = (over: Partial<{ external: boolean; subState: "building" | "gating" | null }> = {}) => ({ now: NOW, external: false, subState: null, ...over });

describe("raceStatus: every race state", () => {
  test("RACING: entries open, entries closed, deciding, plain", () => {
    expect(raceStatus(race({ entryClosesAt: NOW + 192_000 }), [], item(), ctx()).text).toBe("racing · entries close 3:12");
    expect(raceStatus(race({ entryClosesAt: NOW - 1 }), [], item(), ctx()).text).toBe("racing · entries closed");
    expect(raceStatus(race({ deadlineAt: NOW + 41_000 }), [], item(), ctx()).text).toBe("racing · deciding in 0:41");
    expect(raceStatus(race(), [], item(), ctx())).toEqual({ kind: "racing", text: "racing", tone: "cyan", pulse: false });
  });
  test("PICKING: a countdown that never goes negative, gold, and the only pulse", () => {
    expect(raceStatus(race({ state: "PICKING", pickDeadlineAt: NOW + 250_000 }), [], item(), ctx())).toEqual({ kind: "picking", text: "you pick · 4:10 left", tone: "gold", pulse: true });
    expect(raceStatus(race({ state: "PICKING", pickDeadlineAt: NOW - 5_000 }), [], item(), ctx()).text).toBe("you pick · 0:00 left");
    expect(raceStatus(race({ state: "PICKING" }), [], item(), ctx()).text).toBe("you pick");
  });
  test("REWORKING: the due time comes from the winner's rework reason", () => {
    const w = train("a", { raceOutcome: "REWORK", status: "EJECTED", reason: reworkReasonText("conflict", NOW + 723_000, "conflict on src/x.js") });
    expect(raceStatus(race({ state: "REWORKING", winnerTrainId: "a" }), [w], item(), ctx())).toEqual({ kind: "reworking", text: "reworking · due in 12:03", tone: "violet", pulse: false });
    expect(raceStatus(race({ state: "REWORKING", winnerTrainId: "gone" }), [w], item(), ctx()).text).toBe("reworking");
  });
  test("DECIDED reads landed once the item landed or shipped; ABANDONED is red", () => {
    expect(raceStatus(race({ state: "DECIDED" }), [], item(), ctx()).text).toBe("decided");
    expect(raceStatus(race({ state: "DECIDED" }), [], item({ status: "LANDED" }), ctx()).kind).toBe("landed");
    expect(raceStatus(race({ state: "DECIDED" }), [], item({ status: "SHIPPED" }), ctx()).kind).toBe("landed");
    expect(raceStatus(race({ state: "ABANDONED" }), [], item({ status: "FAILED" }), ctx())).toMatchObject({ kind: "abandoned", tone: "red" });
  });
  test("no race: awaiting submissions on external hives, the build sub-state on swarm hives", () => {
    expect(raceStatus(null, [], item(), ctx({ external: true }))).toMatchObject({ kind: "awaiting", text: "awaiting submissions" });
    expect(raceStatus(null, [], item(), ctx({ subState: "gating" }))).toMatchObject({ kind: "building", text: "gating" });
    expect(raceStatus(null, [], item({ status: "READY" }), ctx())).toMatchObject({ kind: "building", text: "ready" });
    expect(raceStatus(null, [], item({ status: "LANDED" }), ctx({ external: true })).kind).toBe("landed");
    expect(raceStatus(null, [], item({ status: "FAILED" }), ctx()).kind).toBe("failed");
    expect(raceStatus(null, [], item({ status: "DUPLICATE" }), ctx())).toMatchObject({ kind: "cancelled", text: "duplicate" });
  });
});

describe("candidateStatus: every race state by candidate outcome", () => {
  const STATES: RaceState[] = ["RACING", "PICKING", "DECIDED", "ABANDONED", "REWORKING"];
  test("passed, failed with its first finding, lost, rework, gating", () => {
    for (const state of STATES) {
      const r = race({ state });
      expect(candidateStatus(train("a", { raceOutcome: "PASSED" }), r, NOW).kind).toBe("passed");
      expect(candidateStatus(train("a", { raceOutcome: "FAILED", status: "EJECTED", summary: "lint: unexpected token\nmore" }), r, NOW).text).toBe("failed: lint: unexpected token");
      expect(candidateStatus(train("a", { raceOutcome: "LOST", status: "EJECTED" }), r, NOW).kind).toBe("lost");
      expect(candidateStatus(train("a", { raceOutcome: "REWORK", status: "EJECTED", reason: reworkReasonText("human", NOW + 60_000, "x") }), r, NOW).text).toBe("reworking · human · due in 1:00");
    }
  });
  test("a passed candidate in PICKING reads as waiting for your pick", () => {
    expect(candidateStatus(train("a", { raceOutcome: "PASSED" }), race({ state: "PICKING" }), NOW).text).toBe("passed · waiting for your pick");
    expect(candidateStatus(train("a", { raceOutcome: "PASSED" }), race(), NOW).text).toBe("passed");
  });
  test("the winner of a decided race is won ★; a WON outcome is won even before the race row catches up", () => {
    expect(candidateStatus(train("a", { raceOutcome: "PASSED" }), race({ state: "DECIDED", winnerTrainId: "a" }), NOW)).toEqual({ kind: "won", text: "won ★", tone: "gold" });
    expect(candidateStatus(train("a", { raceOutcome: "WON" }), race(), NOW).kind).toBe("won");
    expect(candidateStatus(train("a", { status: "MERGED", raceOutcome: "WON" }), race({ state: "DECIDED", winnerTrainId: "a" }), NOW).kind).toBe("won");
  });
  test("a REWORKING winner is reworking, not won", () => {
    const t = train("a", { raceOutcome: "REWORK", status: "EJECTED", reason: reworkReasonText("conflict", NOW + 1_000, "x") });
    expect(candidateStatus(t, race({ state: "REWORKING", winnerTrainId: "a" }), NOW).kind).toBe("reworking");
  });
  test("a human-rejected candidate shows the reason", () => {
    const r = race({ state: "PICKING", rejections: [{ trainId: "a", by: "human:k@kaikeru.com", reason: "ugly" }] });
    expect(candidateStatus(train("a", { raceOutcome: "LOST" }), r, NOW)).toEqual({ kind: "lost", text: "rejected: ugly", tone: "muted" });
  });
  test("EJECTED with no outcome is failed; no finding text is plain failed", () => {
    expect(candidateStatus(train("a", { raceOutcome: null, status: "EJECTED", summary: null, reason: null }), race(), NOW).text).toBe("failed");
  });
  test("still running: building only for a drone in a RACING race that is still building, else gating", () => {
    const drone = { origin: null, model: "kimi" };
    expect(candidateStatus(train("a", { ...drone, status: "BUILDING", phase: "BUILDING" }), race(), NOW).kind).toBe("building");
    expect(candidateStatus(train("a", { ...drone, status: "BUILDING", phase: undefined }), race(), NOW).kind).toBe("building");
    expect(candidateStatus(train("a", { status: "BUILDING", phase: "BUILDING" }), race(), NOW).kind).toBe("gating");
    expect(candidateStatus(train("a", { ...drone, status: "TESTING", phase: "DEPLOYING" }), race(), NOW).kind).toBe("gating");
  });
  test("PICKING never yields building or TESTING, whatever the train says", () => {
    const statuses = ["BUILDING", "TESTING", "MERGED", "EJECTED"] as const;
    const phases = [undefined, "WAITING_PARENT", "BUILDING", "DEPLOYING", "TESTING", "PASSED", "LANDING"] as const;
    const outcomes = [null, "RACING", "PASSED", "FAILED", "WON", "LOST", "REWORK"] as const;
    for (const status of statuses) for (const phase of phases) for (const raceOutcome of outcomes) {
      for (const origin of [null, agent("w1")]) {
        const s = candidateStatus(train("a", { status, phase, raceOutcome, origin }), race({ state: "PICKING" }), NOW);
        expect(s.kind).not.toBe("building");
        expect(s.text).not.toMatch(/building|TESTING/);
        const r = raceStatus(race({ state: "PICKING" }), [train("a", { status, phase, raceOutcome })], item(), ctx());
        expect(r.kind).toBe("picking");
      }
    }
  });
  test("firstFinding strips a failed prefix and clips at 80", () => {
    expect(firstFinding({ summary: null, reason: "failed in race: lint" })).toBe("lint");
    expect(firstFinding({ summary: "x".repeat(100), reason: null })).toHaveLength(80);
    expect(firstFinding({ summary: "", reason: "" })).toBeNull();
  });
});

describe("currentCandidates: one head per contributor", () => {
  test("a contributor's newest train is the head; older ones are old heads", () => {
    const a = train("a", { createdAt: NOW - 300_000, raceOutcome: "LOST", status: "EJECTED", reason: "superseded by a newer push" });
    const b = train("b", { createdAt: NOW - 250_000, candidate: 1, origin: agent("w2", "haiku") });
    const d = train("d", { createdAt: NOW - 100_000, candidate: 2, raceOutcome: "PASSED" });
    const { heads, old } = currentCandidates(race(), [d, b, a]);
    expect(heads.map((t) => t.trainId)).toEqual(["d", "b"]);
    expect(old.map((t) => t.trainId)).toEqual(["a"]);
  });
  test("MCP attempts are one contributor each; drone trains each their own; other races are ignored", () => {
    const x = train("x", { attemptId: "att_1" });
    const y = train("y", { attemptId: "att_2", createdAt: NOW - 100_000 });
    const d1 = train("d1", { origin: null, model: "kimi" });
    const d2 = train("d2", { origin: { kind: "drone", id: "wf-2" }, model: "glm" });
    const other = train("o", { raceId: "r2" });
    expect(currentCandidates(race(), [x, y, d1, d2, other]).heads.map((t) => t.trainId).sort()).toEqual(["d1", "d2", "x", "y"]);
    expect(contributorKey(x)).toBe("agent:w1@kyle@kaikeru.com#att_1");
    expect(contributorKey(d1)).toBe("train:d1");
  });
  test("superseded heads never reach the rows, and rejected / reworking heads get no preview link", () => {
    const old = train("a", { createdAt: NOW - 300_000, raceOutcome: "PASSED" });
    const head = train("b", { createdAt: NOW - 100_000, raceOutcome: "REWORK", status: "EJECTED", reason: reworkReasonText("human", NOW + 5_000, "x") });
    const lost = train("c", { origin: agent("w3"), raceOutcome: "LOST", status: "EJECTED" });
    const failed = train("f", { origin: agent("w4"), raceOutcome: "FAILED", status: "EJECTED", summary: "boom" });
    const js = train("j", { origin: agent("w5"), raceOutcome: "PASSED", previewUrl: "javascript:alert(1)" });
    const rows = candidateRows(race(), [old, head, lost, failed, js], NOW);
    expect(rows.old.map((t) => t.trainId)).toEqual(["a"]);
    const by = Object.fromEntries(rows.heads.map((h) => [h.train.trainId, h]));
    expect(Object.keys(by).sort()).toEqual(["b", "c", "f", "j"]);
    expect(by.b!.previewUrl).toBeNull();
    expect(by.c!.previewUrl).toBeNull();
    expect(by.f!.previewUrl).toBe("https://f.example.dev");
    expect(by.j!.previewUrl).toBeNull();
  });
  test("pickable exactly when the race is PICKING and the head passed", () => {
    const ts = [train("a", { raceOutcome: "PASSED" }), train("b", { origin: agent("w2"), raceOutcome: "FAILED", status: "EJECTED" })];
    expect(candidateRows(race({ state: "PICKING" }), ts, NOW).heads.map((h) => h.pickable)).toEqual([true, false]);
    expect(candidateRows(race(), ts, NOW).heads.some((h) => h.pickable)).toBe(false);
    expect(candidateRows(race({ state: "DECIDED", winnerTrainId: "a" }), ts, NOW).heads.some((h) => h.pickable)).toBe(false);
  });
});

describe("who", () => {
  test("agent name@owner with its claim, a human's local part, a drone's model or tag", () => {
    expect(whoOf({ origin: agent("w1", "opus"), model: null, candidate: 0 })).toEqual({ who: "w1@kyle", claim: "opus" });
    expect(whoOf({ origin: { kind: "agent", id: "solo" }, model: null, candidate: 0 })).toEqual({ who: "solo", claim: null });
    expect(whoOf({ origin: { kind: "human", id: "kyle@kaikeru.com" }, model: null, candidate: 0 })).toEqual({ who: "kyle", claim: null });
    expect(whoOf({ origin: null, model: "kimi-k2", candidate: 0 })).toEqual({ who: "kimi-k2", claim: null });
    expect(whoOf({ origin: undefined, model: null, candidate: 1 })).toEqual({ who: "c2", claim: null });
  });
});

describe("roots, cards and goal rows", () => {
  const goal = item({ itemId: "g", kind: "goal", title: "Rename morse key", status: "ACTIVE", createdAt: NOW - 900_000 });
  const c1 = item({ itemId: "g-c1", parentId: "g", rootId: "g", depth: 1, title: "Rename in morse.js", createdAt: NOW - 800_000 });
  const c2 = item({ itemId: "g-c2", parentId: "g", rootId: "g", depth: 1, title: "Update features index", createdAt: NOW - 700_000 });

  test("rootOf walks to the root; an unknown id is null; a missing parent stops at the highest known item", () => {
    const items = { g: goal, "g-c1": c1 };
    expect(rootOf(items, "g-c1")?.itemId).toBe("g");
    expect(rootOf(items, "g")?.itemId).toBe("g");
    expect(rootOf(items, "nope")).toBeNull();
    expect(rootOf({ "g-c1": c1 }, "g-c1")?.itemId).toBe("g-c1");
  });
  test("cards: the children in filed order, or the root itself", () => {
    const s = slice([goal, c2, c1], [], []);
    s.itemOrder = ["g", "g-c1", "g-c2"];
    expect(cardItems(s, goal).map((i) => i.itemId)).toEqual(["g-c1", "g-c2"]);
    expect(cardItems(s, c1).map((i) => i.itemId)).toEqual(["g-c1"]);
  });
  test("racesForItem: open first, then newest; the card uses the first and keeps the rest for details", () => {
    const races = { a: race({ raceId: "a", itemId: "g-c1", state: "ABANDONED", createdAt: NOW - 10 }), b: race({ raceId: "b", itemId: "g-c1", state: "RACING", createdAt: NOW - 500 }) };
    expect(racesForItem(races, "g-c1").map((r) => r.raceId)).toEqual(["b", "a"]);
    const card = cardSummary(slice([c1], Object.values(races), []), c1, NOW);
    expect(card.race?.raceId).toBe("b");
    expect(card.olderRaces.map((r) => r.raceId)).toEqual(["a"]);
  });
  test("a goal row takes the most urgent card's chip and counts the open races' heads", () => {
    const picking = race({ raceId: "r1", itemId: "g-c1", state: "PICKING", pickDeadlineAt: NOW + 250_000 });
    const racing = race({ raceId: "r2", itemId: "g-c2", entryClosesAt: NOW + 192_000 });
    const trains = [
      train("a", { raceId: "r1", includedPrompts: ["g-c1"], raceOutcome: "PASSED" }),
      train("b", { raceId: "r1", includedPrompts: ["g-c1"], origin: agent("w2", "haiku"), raceOutcome: "PASSED" }),
      train("c", { raceId: "r1", includedPrompts: ["g-c1"], origin: agent("w3", "opus"), raceOutcome: "REWORK", status: "EJECTED", reason: reworkReasonText("human", NOW + 9_000, "x") }),
      train("d", { raceId: "r2", includedPrompts: ["g-c2"], origin: agent("w4") }),
    ];
    const row = goalRow(slice([goal, c1, c2], [picking, racing], trains, EXTERNAL), goal, NOW);
    expect(row.status).toMatchObject({ kind: "picking", text: "you pick · 4:10 left", pulse: true });
    expect(row.summary).toBe("2 passed, 1 gating, 1 rework");
    expect(row.tiles.map((g) => g.tiles.map((t) => [t.kind, t.filled]))).toEqual([[["passed", true], ["passed", true], ["reworking", false]], [["gating", false]]]);
    expect(row.tiles[0]!.tiles[0]!.title).toBe("w1@kyle · claims sonnet · passed · waiting for your pick");
    expect(row.tiles[0]!.tiles[0]!.key).toBe("a:passed");
  });
  test("tiles ring in the last minute; lost heads and closed races get none", () => {
    const r = race({ entryClosesAt: NOW + 30_000 });
    const card = cardSummary(slice([item()], [r], [train("a"), train("b", { origin: agent("w2"), raceOutcome: "LOST", status: "EJECTED" })]), item(), NOW);
    expect(agentTiles([card], NOW)).toEqual([{ raceId: "r1", lastMinute: true, tiles: [expect.objectContaining({ trainId: "a" })] }]);
    const decided = cardSummary(slice([item()], [race({ state: "DECIDED", winnerTrainId: "a" })], [train("a", { raceOutcome: "WON" })]), item(), NOW);
    expect(agentTiles([decided], NOW)).toEqual([]);
  });
  test("goalStatus: a landed root is landed; summary for a split goal with no open races counts landed cards", () => {
    const landed = { status: { kind: "landed" as const, text: "landed", tone: "green" as const, pulse: false } };
    const building = { status: { kind: "building" as const, text: "building", tone: "cyan" as const, pulse: false } };
    expect(goalStatus(item({ status: "LANDED" }), [building]).kind).toBe("landed");
    expect(goalStatus(item(), [landed, building]).kind).toBe("building");
    const s = slice([goal, item({ ...c1, status: "LANDED" }), c2], [], []);
    expect(goalSummary(cardItems(s, goal).map((i) => cardSummary(s, i, NOW)))).toBe("1 of 2 landed");
  });
  test("goalRows: one row per root, loose items included, active before done, newest first", () => {
    const done = item({ itemId: "old", status: "LANDED", createdAt: NOW - 100 });
    const loose = item({ itemId: "bug", kind: "bug", source: { kind: "gatekeeper", actor: "gate" }, createdAt: NOW - 50_000 });
    const rows = goalRows(slice([goal, c1, c2, done, loose], [], []), NOW);
    expect(rows.map((r) => r.root.itemId)).toEqual(["bug", "g", "old"]);
    expect(rows[0]!.followUp).toBe(true);
    expect(rows[2]!.done).toBe(true);
    expect(isFollowUp(c1)).toBe(false);
  });
});

describe("Needs you and the headline", () => {
  test("pickingRows: PICKING races only, soonest deadline first, with their pickable heads and root", () => {
    const goal = item({ itemId: "g", kind: "goal" });
    const c1 = item({ itemId: "g-c1", parentId: "g", rootId: "g" });
    const r1 = race({ raceId: "r1", itemId: "g-c1", state: "PICKING", pickDeadlineAt: NOW + 600_000 });
    const r2 = race({ raceId: "r2", itemId: "i1", state: "PICKING", pickDeadlineAt: NOW + 60_000 });
    const r3 = race({ raceId: "r3", itemId: "i1", state: "RACING" });
    const ts = [train("a", { raceId: "r1", raceOutcome: "PASSED" }), train("b", { raceId: "r2", raceOutcome: "PASSED" }), train("c", { raceId: "r2", origin: agent("w2"), raceOutcome: "FAILED", status: "EJECTED" })];
    const rows = pickingRows(slice([goal, c1, item()], [r1, r2, r3], ts), NOW);
    expect(rows.map((r) => r.race.raceId)).toEqual(["r2", "r1"]);
    expect(rows[0]!.heads.map((h) => h.train.trainId)).toEqual(["b"]);
    expect(rows[1]!.root.itemId).toBe("g");
  });
  test("homeHeadline: counts and mood; calm says how much landed", () => {
    expect(homeHeadline(slice([item()], [race(), race({ raceId: "r2" }), race({ raceId: "r3", state: "PICKING" })], []))).toEqual({ mood: "needs-you", text: "2 races running, 1 waiting for your pick" });
    expect(homeHeadline(slice([item()], [race()], []))).toMatchObject({ mood: "racing", text: "1 race running" });
    expect(homeHeadline(slice([item({ status: "LANDED" })], [], [], EXTERNAL))).toEqual({ mood: "calm", text: "All quiet · landed 4 today" });
    const paused = { ...EXTERNAL, effectiveAutonomy: "paused", settings: { executors: "external", autonomy: "autonomous" } } as unknown as Partial<HiveStatus>;
    expect(homeHeadline(slice([], [], [], paused)).mood).toBe("degraded");
  });
});

describe("helpers", () => {
  test("withDetail folds REST rows in; live rows win", () => {
    const live = slice([item({ status: "ACTIVE" })], [], [train("a", { raceOutcome: "PASSED" })]);
    const merged = withDetail(live, { item: item({ status: "READY" }), children: [item({ itemId: "k", createdAt: NOW - 700_000 })], trains: [train("a", { raceOutcome: "RACING" }), train("z", { createdAt: NOW - 900_000 })], races: [race()] });
    expect(merged.items.i1!.status).toBe("ACTIVE");
    expect(merged.itemOrder).toEqual(["k", "i1"]);
    expect(merged.trains.a!.raceOutcome).toBe("PASSED");
    expect(merged.trainOrder).toEqual(["z", "a"]);
    expect(merged.races.r1).toBeDefined();
    expect(withDetail(live, null)).toBe(live);
  });
  test("pushCommand: goal/<slug>/<agent> for goals, item/<id>/<agent> otherwise", () => {
    expect(titleSlug("Rename morse key!")).toBe("rename-morse-key");
    expect(pushCommand({ itemId: "g", kind: "goal", title: "Rename morse key" })).toBe("git push origin HEAD:goal/rename-morse-key/<your-agent-name>");
    expect(pushCommand({ itemId: "g", kind: "goal", title: "!!!" })).toBe("git push origin HEAD:item/g/<your-agent-name>");
    expect(pushCommand({ itemId: "i1", kind: "bug", title: "fix typo" })).toBe("git push origin HEAD:item/i1/<your-agent-name>");
  });
  test("trackFresh: nothing is fresh on the first call; later keys stay fresh", () => {
    const memo = { seen: null as Set<string> | null, fresh: new Set<string>() };
    expect([...trackFresh(memo, ["a:gating"])]).toEqual([]);
    expect([...trackFresh(memo, ["a:gating", "a:passed"])]).toEqual(["a:passed"]);
    expect([...trackFresh(memo, ["a:passed"])]).toEqual(["a:passed"]);
  });
  test("chip classes carry the tone, the pulse and the candidate kind", () => {
    expect(raceChipClass({ tone: "gold", pulse: true })).toBe("race-chip race-chip--gold race-chip--pulse");
    expect(candChipClass({ kind: "reworking" })).toBe("cand-chip cand-chip--reworking");
  });
});

describe("shared pick controls (RacePick.tsx)", () => {
  test("CandidateActions: Pick (gold) and Reject; compact says Pick", () => {
    const html = renderToString(<CandidateActions hive="demo" raceId="r1" trainId="a" tag="c1" compact />);
    expect(html).toContain("btn--ship");
    expect(html).toMatch(/>Pick</);
    expect(html).toMatch(/>Reject</);
    expect(renderToString(<CandidateActions hive="demo" raceId="r1" trainId="a" tag="c1" />)).toContain("Pick this one");
  });
  test("RejectAll renders its button", () => {
    expect(renderToString(<RejectAll hive="demo" raceId="r1" />)).toContain("Reject all");
  });
  test("previews are links only: RacePick never embeds an iframe", () => {
    const s = slice([item({ judge: "human" })], [race({ state: "PICKING", pickDeadlineAt: NOW + 1_000 })], [train("a", { raceOutcome: "PASSED" }), train("b", { origin: agent("w2"), raceOutcome: "PASSED" })]);
    const html = renderToString(<RacePick hive="demo" view={raceView(s, "r1", NOW)!} now={NOW} />);
    expect(html).toContain("open preview");
    expect(html).not.toContain("<iframe");
  });
});
```

In `apps/dashboard/test/racepick.test.tsx`, the render test asserted the iframe preview the spec forbids:

```diff
--- a/apps/dashboard/test/racepick.test.tsx
+++ b/apps/dashboard/test/racepick.test.tsx
@@ -126,7 +126,7 @@
     expect(html).toContain("recommended");
     expect(html.match(/Pick this one/g)).toHaveLength(3);
     expect(html).toContain("https://a.example.dev");
-    expect(html).toContain("<iframe");
+    expect(html).not.toContain("<iframe");
     expect(html).toContain("3 satisfied");
     expect(html).toContain("2.0 KB");
     expect(html).toContain("n/a");
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run test/raceStatus.test.tsx test/racepick.test.tsx`
Expected: FAIL: `Failed to resolve import "../src/raceStatus"`, and the racepick render test fails on `not.toContain("<iframe")`.

- [ ] **Step 3: Write `src/raceStatus.ts`**

```ts
/**
 * Race-true labels (dashboard redesign spec §4.4): the one module that turns a race and its trains into words and tones
 * for goal rows, race cards, Needs you and agent tiles. Nothing else derives a label from train status alone while a
 * race exists. Pure; no React.
 */
import { parseReworkReason, type MergeTrain, type Race, type WorkItem } from "@queenos/queen-types";

import type { ItemDetail } from "./api";
import { autonomyLabel, isExternal, itemPushCommand } from "./homeLogic";
import { isPushed, originBadge, type OriginBadge } from "./origin";
import { countdownText, entryState, pickRemainingMs } from "./raceLogic";
import type { State } from "./reducer";
import { landedCount, openEscalations } from "./status";
import { isBuildTrain, itemIdOf, itemSubState, type SubState } from "./swarm";

export type Tone = "cyan" | "gold" | "violet" | "green" | "red" | "muted";

export type RaceChipKind = "racing" | "picking" | "reworking" | "decided" | "landed" | "abandoned" | "awaiting" | "building" | "failed" | "cancelled";

export interface RaceStatus {
  kind: RaceChipKind;
  text: string;
  tone: Tone;
  /** Waiting on the human (you pick): the one steady pulse the design allows (spec §5). */
  pulse: boolean;
}

export type CandidateKind = "building" | "gating" | "passed" | "failed" | "reworking" | "won" | "lost";

export interface CandidateStatus {
  kind: CandidateKind;
  text: string;
  tone: Tone;
}

/** The reducer state this module reads. */
export type StatusSlice = Pick<State, "trains" | "trainOrder" | "items" | "itemOrder" | "races" | "events" | "landed" | "hive" | "escalations" | "escalationOrder">;

export interface RaceCtx {
  now: number;
  /** External hive: no race yet means "awaiting submissions", not a build sub-state. */
  external: boolean;
  /** Swarm hives without a race: the item's build sub-state (`itemSubState`), where "building" is true. */
  subState?: SubState | null;
}

const LANDED = new Set<string>(["LANDED", "SHIPPED"]);
const OPEN_RACE = new Set<string>(["RACING", "PICKING", "REWORKING"]);

const rs = (kind: RaceChipKind, text: string, tone: Tone): RaceStatus => ({ kind, text, tone, pulse: false });
const cs = (kind: CandidateKind, text: string, tone: Tone): CandidateStatus => ({ kind, text, tone });

export const isOpenRace = (r: Pick<Race, "state">): boolean => OPEN_RACE.has(r.state);

/** The chip of a race card or goal row. `trains` are the race's trains (the REWORKING winner's due time is read from them). */
export function raceStatus(race: Race | null, trains: readonly MergeTrain[], item: WorkItem, ctx: RaceCtx): RaceStatus {
  const { now } = ctx;
  if (race) {
    switch (race.state) {
      case "RACING": {
        const e = entryState(race, now);
        if (e?.kind === "open") return rs("racing", `racing · entries close ${countdownText(e.remainingMs)}`, "cyan");
        if (e?.kind === "closed") return rs("racing", "racing · entries closed", "cyan");
        if (race.deadlineAt != null && race.deadlineAt > now) return rs("racing", `racing · deciding in ${countdownText(race.deadlineAt - now)}`, "cyan");
        return rs("racing", "racing", "cyan");
      }
      case "PICKING": {
        const left = pickRemainingMs(race, now);
        return { kind: "picking", text: left == null ? "you pick" : `you pick · ${countdownText(left)} left`, tone: "gold", pulse: true };
      }
      case "REWORKING": {
        const winner = trains.find((t) => t.trainId === race.winnerTrainId);
        const r = parseReworkReason(winner?.reason);
        return rs("reworking", r ? `reworking · due in ${countdownText(r.dueAt - now)}` : "reworking", "violet");
      }
      case "DECIDED":
        return LANDED.has(item.status) ? rs("landed", "landed", "green") : rs("decided", "decided", "green");
      case "ABANDONED":
        return rs("abandoned", "abandoned", "red");
    }
  }
  if (LANDED.has(item.status)) return rs("landed", "landed", "green");
  if (item.status === "FAILED") return rs("failed", "failed", "red");
  if (item.status === "CANCELLED" || item.status === "DUPLICATE") return rs("cancelled", item.status.toLowerCase(), "muted");
  if (ctx.external) return rs("awaiting", "awaiting submissions", "muted");
  return rs("building", ctx.subState ?? item.status.toLowerCase(), "cyan");
}

/** The first line of a failed train's summary (else its reason), without a "failed:" prefix, ≤ 80 chars. */
export function firstFinding(t: Pick<MergeTrain, "summary" | "reason">): string | null {
  const line = (t.summary || t.reason || "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const text = line.replace(/^failed(?: in race)?:\s*/i, "").trim();
  if (!text) return null;
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/** One candidate's verdict chip. Never "building" outside a RACING race, so PICKING never reads as a build. */
export function candidateStatus(t: MergeTrain, race: Race, now: number): CandidateStatus {
  if (t.raceOutcome === "REWORK") {
    const r = parseReworkReason(t.reason);
    return cs("reworking", r ? `reworking · ${r.reason} · due in ${countdownText(r.dueAt - now)}` : "reworking", "violet");
  }
  if (race.winnerTrainId === t.trainId && (race.state === "DECIDED" || t.raceOutcome === "WON" || t.status === "MERGED")) return cs("won", "won ★", "gold");
  const rejected = race.rejections?.find((r) => r.trainId === t.trainId);
  if (rejected) return cs("lost", `rejected: ${rejected.reason}`, "muted");
  if (t.raceOutcome === "WON") return cs("won", "won ★", "gold");
  if (t.raceOutcome === "LOST") return cs("lost", "lost", "muted");
  if (t.raceOutcome === "FAILED" || t.status === "EJECTED") {
    const f = firstFinding(t);
    return cs("failed", f ? `failed: ${f}` : "failed", "red");
  }
  if (t.raceOutcome === "PASSED") return cs("passed", race.state === "PICKING" ? "passed · waiting for your pick" : "passed", "green");
  if (race.state === "RACING" && !isPushed(t) && t.status === "BUILDING" && (t.phase == null || t.phase === "WAITING_PARENT" || t.phase === "BUILDING")) return cs("building", "building", "cyan");
  return cs("gating", "gating", "cyan");
}

/**
 * Who a candidate is (spec §4.3): MCP attempts are one contributor per attempt, git pushes one per agent identity, drone
 * trains (no origin, or kind drone) each their own.
 */
export function contributorKey(t: Pick<MergeTrain, "trainId" | "origin" | "attemptId">): string {
  const o = t.origin;
  if (!o || o.kind === "drone") return `train:${t.trainId}`;
  return t.attemptId ? `${o.kind}:${o.id}#${t.attemptId}` : `${o.kind}:${o.id}`;
}

const byAge = (a: MergeTrain, b: MergeTrain): number => a.createdAt - b.createdAt || (a.candidate ?? 0) - (b.candidate ?? 0) || a.trainId.localeCompare(b.trainId);

export interface CurrentCandidates {
  /** Each contributor's newest train in the race, in order of the contributor's first entry. */
  heads: MergeTrain[];
  /** Superseded heads (older trains of the same contributor), oldest first: "details" only. */
  old: MergeTrain[];
}

/** One head per contributor. The candidate index is not stable (every push that joins gets a new one), so it is not used. */
export function currentCandidates(race: Pick<Race, "raceId">, trains: readonly MergeTrain[]): CurrentCandidates {
  const groups = new Map<string, MergeTrain[]>();
  for (const t of trains) {
    if (t.raceId !== race.raceId) continue;
    const k = contributorKey(t);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const ordered = [...groups.values()].map((g) => [...g].sort(byAge)).sort((a, b) => byAge(a[0]!, b[0]!));
  return { heads: ordered.map((g) => g.at(-1)!), old: ordered.flatMap((g) => g.slice(0, -1)).sort(byAge) };
}

/** "w1@kyle" for agent `w1@kyle@kaikeru.com` (claim: its model), "kyle" for a human push, the model (or "c2") for drones. */
export function whoOf(t: Pick<MergeTrain, "origin" | "model" | "candidate">): { who: string; claim: string | null } {
  const o = t.origin;
  if (o?.kind === "agent") {
    const at = o.id.indexOf("@");
    const name = at > 0 ? o.id.slice(0, at) : o.id;
    const owner = at > 0 ? (o.id.slice(at + 1).split("@")[0] ?? "") : "";
    return { who: owner ? `${name}@${owner}` : name, claim: o.model ?? null };
  }
  if (o?.kind === "human") return { who: o.id.split("@")[0] || o.id, claim: null };
  return { who: t.model ?? `c${(t.candidate ?? 0) + 1}`, claim: null };
}

export interface CandidateRow {
  train: MergeTrain;
  key: string;
  /** "c2" */
  tag: string;
  who: string;
  claim: string | null;
  origin: OriginBadge;
  status: CandidateStatus;
  /** http(s) only, and never for a rejected (lost, reworking) head. */
  previewUrl: string | null;
  /** PICKING and passed: Pick / Reject apply. */
  pickable: boolean;
}

const PREVIEW_KINDS = new Set<CandidateKind>(["building", "gating", "passed", "failed", "won"]);
const httpUrl = (u: string | null | undefined): string | null => (u && /^https?:\/\//i.test(u) ? u : null);

export function candidateRows(race: Race, trains: readonly MergeTrain[], now: number): { heads: CandidateRow[]; old: MergeTrain[] } {
  const { heads, old } = currentCandidates(race, trains);
  return {
    heads: heads.map((t) => {
      const status = candidateStatus(t, race, now);
      const { who, claim } = whoOf(t);
      return {
        train: t,
        key: contributorKey(t),
        tag: `c${(t.candidate ?? 0) + 1}`,
        who,
        claim,
        origin: originBadge(t.origin, t.attemptId),
        status,
        previewUrl: PREVIEW_KINDS.has(status.kind) ? httpUrl(t.previewUrl) : null,
        pickable: race.state === "PICKING" && status.kind === "passed",
      };
    }),
    old,
  };
}

/** An item's races: open ones first, then newest first. The card uses the first; the rest go to "details". */
export function racesForItem(races: Readonly<Record<string, Race>>, itemId: string): Race[] {
  return Object.values(races)
    .filter((r) => r.itemId === itemId)
    .sort((a, b) => Number(isOpenRace(b)) - Number(isOpenRace(a)) || b.createdAt - a.createdAt);
}

/** The root of an item: its `rootId` when known, else the highest ancestor the state holds. Null when the item is unknown. */
export function rootOf(items: Readonly<Record<string, WorkItem>>, id: string): WorkItem | null {
  let cur = items[id];
  if (!cur) return null;
  const byRoot = items[cur.rootId];
  if (byRoot && !byRoot.parentId) return byRoot;
  for (let i = 0; i < 8 && cur.parentId && items[cur.parentId]; i++) cur = items[cur.parentId]!;
  return cur;
}

/** The items that get a race card: the root's children in filed order, or the root itself (a loose item, a goal not split yet). */
export function cardItems(state: Pick<State, "items" | "itemOrder">, root: WorkItem): WorkItem[] {
  const children = state.itemOrder.map((id) => state.items[id]).filter((i): i is WorkItem => !!i && i.parentId === root.itemId);
  return children.length ? children : [root];
}

export interface CardSummary {
  item: WorkItem;
  /** The newest (open first) race, or null. */
  race: Race | null;
  /** The item's other races (ABANDONED and older): "details" only. */
  olderRaces: Race[];
  status: RaceStatus;
  heads: CandidateRow[];
  old: MergeTrain[];
  /** Every BUILD train of the item, in creation order (attempt history). */
  trains: MergeTrain[];
}

export function cardSummary(state: StatusSlice, item: WorkItem, now: number): CardSummary {
  const [race = null, ...olderRaces] = racesForItem(state.races, item.itemId);
  const all = state.trainOrder.map((id) => state.trains[id]).filter((t): t is MergeTrain => !!t);
  const trains = all.filter((t) => isBuildTrain(t) && itemIdOf(t) === item.itemId);
  const raceTrains = race ? all.filter((t) => t.raceId === race.raceId) : [];
  const { heads, old } = race ? candidateRows(race, raceTrains, now) : { heads: [], old: [] };
  const status = raceStatus(race, raceTrains, item, { now, external: isExternal(state.hive), subState: itemSubState(state, item) });
  return { item, race, olderRaces, status, heads, old, trains };
}

const RANK: Record<RaceChipKind, number> = { picking: 0, reworking: 1, racing: 2, building: 3, awaiting: 4, failed: 5, abandoned: 6, decided: 7, landed: 8, cancelled: 9 };

/** A goal row's chip: the most urgent card (you pick first), unless the root itself landed or was cancelled. */
export function goalStatus(root: WorkItem, cards: readonly Pick<CardSummary, "status">[]): RaceStatus {
  if (LANDED.has(root.status)) return rs("landed", "landed", "green");
  if (root.status === "CANCELLED" || root.status === "DUPLICATE") return rs("cancelled", root.status.toLowerCase(), "muted");
  let best: RaceStatus | null = null;
  for (const c of cards) if (!best || RANK[c.status.kind] < RANK[best.kind]) best = c.status;
  return best ?? rs("building", root.status.toLowerCase(), "cyan");
}

const COUNT_ORDER: [CandidateKind, string][] = [["passed", "passed"], ["building", "building"], ["gating", "gating"], ["reworking", "rework"], ["failed", "failed"]];

/** "2 passed, 1 rework" over the heads of open races; "1 of 3 landed" for a split goal with none; "" otherwise. */
export function goalSummary(cards: readonly CardSummary[]): string {
  const n = new Map<CandidateKind, number>();
  for (const c of cards) {
    if (!c.race || !isOpenRace(c.race)) continue;
    for (const h of c.heads) n.set(h.status.kind, (n.get(h.status.kind) ?? 0) + 1);
  }
  const parts = COUNT_ORDER.filter(([k]) => n.get(k)).map(([k, label]) => `${n.get(k)} ${label}`);
  if (parts.length) return parts.join(", ");
  if (cards.length > 1) return `${cards.filter((c) => c.status.kind === "landed").length} of ${cards.length} landed`;
  return "";
}

export interface AgentTile {
  /** `${trainId}:${kind}`: a new key per state change, so the tile remounts and its CSS animation plays. */
  key: string;
  trainId: string;
  kind: CandidateKind;
  /** Passed or won; hollow = gating, building, reworking or failed. */
  filled: boolean;
  /** Hover text: who, the claimed model, the verdict. */
  title: string;
}

export interface AgentTileGroup {
  raceId: string;
  /** The race's next deadline (entries, decision or pick) is under a minute away: the outline rings. */
  lastMinute: boolean;
  tiles: AgentTile[];
}

function nextDeadline(race: Race, now: number): number | null {
  if (race.state === "PICKING") return race.pickDeadlineAt ?? null;
  if (race.state === "RACING") return race.entryClosesAt != null && race.entryClosesAt > now ? race.entryClosesAt : race.deadlineAt;
  return null;
}

/** One tile per live candidate of each open race, grouped per race (spec §3.5). Lost heads get no tile. */
export function agentTiles(cards: readonly CardSummary[], now: number): AgentTileGroup[] {
  const out: AgentTileGroup[] = [];
  for (const c of cards) {
    if (!c.race || !isOpenRace(c.race)) continue;
    const tiles = c.heads
      .filter((h) => h.status.kind !== "lost")
      .map((h) => ({
        key: `${h.train.trainId}:${h.status.kind}`,
        trainId: h.train.trainId,
        kind: h.status.kind,
        filled: h.status.kind === "passed" || h.status.kind === "won",
        title: `${h.who}${h.claim ? ` · claims ${h.claim}` : ""} · ${h.status.text}`,
      }));
    if (!tiles.length) continue;
    const d = nextDeadline(c.race, now);
    out.push({ raceId: c.race.raceId, lastMinute: d != null && d > now && d - now <= 60_000, tiles });
  }
  return out;
}

/** Follow-ups and self-filed bugs: a loose item the swarm filed, not a person. */
export const isFollowUp = (item: Pick<WorkItem, "parentId" | "source">): boolean =>
  !item.parentId && (item.source.kind === "drone" || item.source.kind === "gatekeeper" || item.source.kind === "sentinel");

export interface GoalRow {
  root: WorkItem;
  cards: CardSummary[];
  status: RaceStatus;
  summary: string;
  tiles: AgentTileGroup[];
  followUp: boolean;
  /** Landed or cancelled: sorted after the active rows. */
  done: boolean;
}

export function goalRow(state: StatusSlice, root: WorkItem, now: number): GoalRow {
  const cards = cardItems(state, root).map((i) => cardSummary(state, i, now));
  const status = goalStatus(root, cards);
  return { root, cards, status, summary: goalSummary(cards), tiles: agentTiles(cards, now), followUp: isFollowUp(root), done: status.kind === "landed" || status.kind === "cancelled" };
}

/** The home GOALS list: one row per root (loose items are their own roots), active before done, newest first. */
export function goalRows(state: StatusSlice, now: number): GoalRow[] {
  return state.itemOrder
    .map((id) => state.items[id])
    .filter((i): i is WorkItem => !!i && (!i.parentId || !state.items[i.parentId]))
    .map((root) => goalRow(state, root, now))
    .sort((a, b) => Number(a.done) - Number(b.done) || b.root.createdAt - a.root.createdAt);
}

export interface PickRow {
  race: Race;
  item: WorkItem;
  root: WorkItem;
  status: RaceStatus;
  /** The pickable heads (passed, not rejected). */
  heads: CandidateRow[];
}

/** Every PICKING race for Needs you, the soonest auto-pick first. Races whose item the state does not hold are skipped. */
export function pickingRows(state: StatusSlice, now: number): PickRow[] {
  const all = state.trainOrder.map((id) => state.trains[id]).filter((t): t is MergeTrain => !!t);
  return Object.values(state.races)
    .filter((r) => r.state === "PICKING" && state.items[r.itemId])
    .sort((a, b) => (a.pickDeadlineAt ?? Infinity) - (b.pickDeadlineAt ?? Infinity) || a.createdAt - b.createdAt)
    .map((race) => {
      const item = state.items[race.itemId]!;
      const trains = all.filter((t) => t.raceId === race.raceId);
      return { race, item, root: rootOf(state.items, item.itemId) ?? item, status: raceStatus(race, trains, item, { now, external: isExternal(state.hive) }), heads: candidateRows(race, trains, now).heads.filter((h) => h.pickable) };
    });
}

export type HiveMood = "calm" | "racing" | "needs-you" | "degraded";

export interface HomeHeadline {
  mood: HiveMood;
  /** "2 races running, 1 waiting for your pick" / "All quiet · landed 4 today". */
  text: string;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function homeHeadline(state: StatusSlice): HomeHeadline {
  const races = Object.values(state.races);
  const racing = races.filter((r) => r.state === "RACING").length;
  const picking = races.filter((r) => r.state === "PICKING").length;
  const reworking = races.filter((r) => r.state === "REWORKING").length;
  const escalations = openEscalations(state).length;
  const h = state.hive;
  const degraded = !!h && (h.effectiveAutonomy !== h.settings.autonomy || h.effectiveAutonomy === "paused");
  const raced = new Set(races.filter(isOpenRace).map((r) => r.itemId));
  const busy = Object.values(state.items).filter((i) => (i.status === "ACTIVE" || i.status === "DECOMPOSING") && !raced.has(i.itemId)).length;
  const parts: string[] = [];
  if (racing) parts.push(`${plural(racing, "race")} running`);
  if (picking) parts.push(`${picking} waiting for your pick`);
  if (reworking) parts.push(`${reworking} reworking`);
  if (escalations) parts.push(plural(escalations, "escalation"));
  if (busy) parts.push(`${plural(busy, "item")} in progress`);
  if (degraded && h) parts.push(`autonomy ${autonomyLabel(h)}`);
  const mood: HiveMood = picking || escalations ? "needs-you" : degraded ? "degraded" : racing || reworking || busy ? "racing" : "calm";
  const landed = h?.throughput.landed24h ?? landedCount(state);
  return { mood, text: parts.length ? parts.join(", ") : `All quiet · landed ${landed} today` };
}

/** Live state with an item's REST detail folded in; live rows win (they are newer). */
export function withDetail<S extends Pick<State, "trains" | "trainOrder" | "items" | "itemOrder" | "races">>(state: S, detail: Pick<ItemDetail, "item" | "children" | "trains" | "races"> | null | undefined): S {
  if (!detail) return state;
  const trains: Record<string, MergeTrain> = { ...Object.fromEntries(detail.trains.map((t) => [t.trainId, t])), ...state.trains };
  const trainOrder = [...state.trainOrder, ...detail.trains.map((t) => t.trainId).filter((id) => !state.trains[id])].sort((a, b) => trains[a]!.createdAt - trains[b]!.createdAt);
  const fetched = [detail.item, ...detail.children];
  const items: Record<string, WorkItem> = { ...Object.fromEntries(fetched.map((i) => [i.itemId, i])), ...state.items };
  const itemOrder = [...state.itemOrder, ...[...new Set(fetched.map((i) => i.itemId))].filter((id) => !state.items[id])].sort((a, b) => items[a]!.createdAt - items[b]!.createdAt);
  const races: Record<string, Race> = { ...Object.fromEntries(detail.races.map((r) => [r.raceId, r])), ...state.races };
  return { ...state, trains, trainOrder, items, itemOrder, races };
}

/** The Queen's `goal/<slug>` addressing (apps/queen/src/work/inbox.ts `slugify`): lowercase `[a-z0-9-]`, ≤ 64. */
export function titleSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** The goal page's push command: `goal/<slug>/<your-agent-name>` for a goal with a sluggable title, else `item/<id>/<your-agent-name>`. */
export function pushCommand(item: Pick<WorkItem, "itemId" | "kind" | "title">): string {
  const slug = item.kind === "goal" ? titleSlug(item.title) : "";
  return slug ? `git push origin HEAD:goal/${slug}/<your-agent-name>` : itemPushCommand(item.itemId);
}

/**
 * Keys that appeared after the first call (state changes, never the page load). Stays fresh for the session, so a class
 * built from it never flips back mid-animation. Mutates and returns `memo.fresh`; keep `memo` in a `useRef`.
 */
export function trackFresh(memo: { seen: Set<string> | null; fresh: Set<string> }, keys: readonly string[]): ReadonlySet<string> {
  if (memo.seen) for (const k of keys) if (!memo.seen.has(k)) memo.fresh.add(k);
  memo.seen = new Set([...(memo.seen ?? []), ...keys]);
  return memo.fresh;
}

export const raceChipClass = (s: Pick<RaceStatus, "tone" | "pulse">): string => `race-chip race-chip--${s.tone}${s.pulse ? " race-chip--pulse" : ""}`;
export const candChipClass = (s: Pick<CandidateStatus, "kind">): string => `cand-chip cand-chip--${s.kind}`;
```

- [ ] **Step 4: Move `useRoom` / `Room` to `src/room.ts`**

Create `apps/dashboard/src/room.ts`:

```ts
import { useReducer } from "react";

import { initialState, reducer } from "./reducer";
import { useMockQueen } from "./useMockQueen";
import { useQueenSocket } from "./useQueenSocket";

// A build-time constant (replaced by Vite), so the mock is tree-shaken from production bundles.
const useRoomSocket = import.meta.env.VITE_MOCK_API === "1" ? useMockQueen : useQueenSocket;

/** The live link to one hive: reducer state plus the socket. Owned by the hive root so it survives page changes. */
export function useRoom(hive: string) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const link = useRoomSocket(hive, dispatch);
  return { state, dispatch, ...link };
}
export type Room = ReturnType<typeof useRoom>;
```

Remove them from `WarRoom.tsx` (Task 5 deletes the file later):

```diff
--- a/apps/dashboard/src/WarRoom.tsx
+++ b/apps/dashboard/src/WarRoom.tsx
@@ -1,24 +1,12 @@
-import { useCallback, useMemo, useReducer, useState } from "react";
+import { useCallback, useMemo, useState } from "react";
 import { HiveFooter } from "./shell";
 import { DEMO_PROMPTS } from "./demo";
 import { Composer, Lanes, LedgerPanel, MainTrack, ModelBoard, ReleaseTimeline, Sites, Ticker, TopBar } from "./components";
 import { isExternal } from "./homeLogic";
 import { currentRelease, siteReleaseView } from "./releases";
-import { useMockQueen } from "./useMockQueen";
-import { buildLanes, buildSites, initialState, reducer, type AuditCard, type Lane } from "./reducer";
-import { useQueenSocket } from "./useQueenSocket";
+import { buildLanes, buildSites, type AuditCard, type Lane } from "./reducer";
+import type { Room } from "./room";
 
-// A build-time constant (replaced by Vite), so the mock is tree-shaken from production bundles.
-const useRoomSocket = import.meta.env.VITE_MOCK_API === "1" ? useMockQueen : useQueenSocket;
-
-/** The live link to one hive: reducer state plus the socket. Owned by the hive root so it survives page changes. */
-export function useRoom(hive: string) {
-  const [state, dispatch] = useReducer(reducer, initialState);
-  const link = useRoomSocket(hive, dispatch);
-  return { state, dispatch, ...link };
-}
-export type Room = ReturnType<typeof useRoom>;
-
 /** The lanes drill-down (today's War Room): lanes, release timeline, Sites, Model Board, ticker. */
 export function WarRoom({ hive, room, backTo }: { hive: string; room: Room; backTo?: string }) {
   const { state, dispatch, status, latencyMs, retryAt, send } = room;
```

`apps/dashboard/src/App.tsx` (line 4):

```diff
-import { WarRoom, useRoom } from "./WarRoom";
+import { WarRoom } from "./WarRoom";
+import { useRoom } from "./room";
```

`apps/dashboard/src/StatusHome.tsx` (line 14):

```diff
-import type { Room } from "./WarRoom";
+import type { Room } from "./room";
```

- [ ] **Step 5: Shared pick controls in `src/RacePick.tsx`**

Export `RejectAll`, add `CandidateActions` (the Pick / Reject logic that lived inside `Card`), and make `Card` use it. The preview is a link only:

```diff
--- a/apps/dashboard/src/RacePick.tsx
+++ b/apps/dashboard/src/RacePick.tsx
@@ -88,8 +88,8 @@
   );
 }
 
-/** "Reject all" on the race panel (PICKING only). */
-function RejectAll({ hive, raceId, onChanged }: { hive: string; raceId: string; onChanged?: () => void }) {
+/** "Reject all" on the race panel (PICKING only). Also used by race cards and Needs you. */
+export function RejectAll({ hive, raceId, onChanged }: { hive: string; raceId: string; onChanged?: () => void }) {
   const [open, setOpen] = useState(false);
   const [err, setErr] = useState<string | null>(null);
   const send = async (reason: string) => {
@@ -117,7 +117,11 @@
   );
 }
 
-function Card({ hive, raceId, c, picking, onChanged }: { hive: string; raceId: string; c: PickCard; picking: boolean; onChanged?: () => void }) {
+/**
+ * Pick (with an optional reason) and Reject (with a required reason) for one pickable candidate. The caller decides
+ * pickability (`PickCard.pickable`, `CandidateRow.pickable`). `compact` labels the button "Pick" (race cards, Needs you).
+ */
+export function CandidateActions({ hive, raceId, trainId, tag, compact = false, onChanged }: { hive: string; raceId: string; trainId: string; tag: string; compact?: boolean; onChanged?: () => void }) {
   const [confirm, setConfirm] = useState(false);
   const [rejecting, setRejecting] = useState(false);
   const [reason, setReason] = useState("");
@@ -127,7 +131,7 @@
     setBusy(true);
     setErr(null);
     try {
-      await api.pickRace(hive, raceId, c.trainId, reason);
+      await api.pickRace(hive, raceId, trainId, reason);
       setConfirm(false);
       onChanged?.();
     } catch (e) {
@@ -142,7 +146,7 @@
   const reject = async (why: string) => {
     setErr(null);
     try {
-      await api.rejectRace(hive, raceId, c.trainId, why);
+      await api.rejectRace(hive, raceId, trainId, why);
       setRejecting(false);
       onChanged?.();
     } catch (e) {
@@ -152,6 +156,30 @@
       if (f.refresh) onChanged?.();
     }
   };
+  const off = MOCK ? "Mock mode: not available" : undefined;
+  return (
+    <div className={`cand__actions${compact ? " cand__actions--compact" : ""}`}>
+      {confirm ? (
+        <div className="rp__confirm">
+          <input type="text" value={reason} maxLength={PICK_REASON_MAX} onChange={(e) => setReason(e.target.value)} placeholder="why this one? (optional)" aria-label={`Reason for picking ${tag}`} />
+          <button type="button" className="btn btn--ship" disabled={busy} onClick={() => void submit()}>{busy ? "Picking…" : "Confirm pick"}</button>
+          <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
+        </div>
+      ) : rejecting ? (
+        <RejectBox label={`Reason for rejecting ${tag}`} onSend={reject} onCancel={() => setRejecting(false)} />
+      ) : (
+        <>
+          <button type="button" className="btn btn--ship cand__pick" disabled={MOCK} title={off} onClick={() => setConfirm(true)}>{compact ? "Pick" : "Pick this one"}</button>
+          <button type="button" className="btn cand__reject" disabled={MOCK} title={off} onClick={() => setRejecting(true)}>Reject</button>
+        </>
+      )}
+      {MOCK && <p className="sh-muted">Mock mode has no pick API.</p>}
+      {err && <p className="sh-err" role="alert">{err}</p>}
+    </div>
+  );
+}
+
+function Card({ hive, raceId, c, picking, onChanged }: { hive: string; raceId: string; c: PickCard; picking: boolean; onChanged?: () => void }) {
   const cls = `rp__card${c.recommended ? " rp__card--rec" : ""}${c.winner ? " rp__card--winner" : ""}${c.rejectedReason || (!picking && !c.winner) ? " rp__card--out" : ""}`;
   return (
     <div className={cls}>
@@ -161,10 +189,7 @@
         {c.winner && <span className="chip chip--sm rp__won">picked</span>}
       </p>
       {c.previewUrl ? (
-        <>
-          {picking && c.pickable && <iframe className="rp__frame" src={c.previewUrl} title={`Preview of ${c.tag}`} loading="lazy" sandbox="allow-scripts allow-forms allow-popups" />}
-          <a className="sh-link rp__link" href={c.previewUrl} target="_blank" rel="noreferrer">open preview ▸</a>
-        </>
+        <a className="sh-link rp__link" href={c.previewUrl} target="_blank" rel="noreferrer">open preview ▸</a>
       ) : (
         <p className="sh-muted">preview n/a</p>
       )}
@@ -175,26 +200,7 @@
       </dl>
       {c.notes && <p className="sh-muted rp__notes">{c.notes}</p>}
       {c.rejectedReason && <p className="sh-err">rejected: {c.rejectedReason}</p>}
-      {picking && c.pickable && (
-        confirm ? (
-          <div className="rp__confirm">
-            <input type="text" value={reason} maxLength={PICK_REASON_MAX} onChange={(e) => setReason(e.target.value)} placeholder="why this one? (optional)" aria-label={`Reason for picking ${c.tag}`} />
-            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void submit()}>{busy ? "Picking…" : "Confirm pick"}</button>
-            <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
-          </div>
-        ) : (
-          <button type="button" className="btn btn--primary" disabled={MOCK} title={MOCK ? "Mock mode: picking is not available" : undefined} onClick={() => setConfirm(true)}>Pick this one</button>
-        )
-      )}
-      {picking && c.pickable && !confirm && (
-        rejecting ? (
-          <RejectBox label={`Reason for rejecting ${c.tag}`} onSend={reject} onCancel={() => setRejecting(false)} />
-        ) : (
-          <button type="button" className="btn" disabled={MOCK} title={MOCK ? "Mock mode: not available" : undefined} onClick={() => setRejecting(true)}>Reject</button>
-        )
-      )}
-      {MOCK && picking && c.pickable && <p className="sh-muted">Mock mode has no pick API.</p>}
-      {err && <p className="sh-err" role="alert">{err}</p>}
+      {picking && c.pickable && <CandidateActions hive={hive} raceId={raceId} trainId={c.trainId} tag={c.tag} onChanged={onChanged} />}
     </div>
   );
 }
```

The existing imports stay as they are (`PICK_REASON_MAX`, `pickFailure`, `rejectFailure` are now used by `CandidateActions`).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/raceStatus.test.tsx test/racepick.test.tsx`
Expected: PASS (2 files).

- [ ] **Step 7: Package checks**

Run: `pnpm --filter @queenos/dashboard test && pnpm --filter @queenos/dashboard typecheck && pnpm --filter @queenos/dashboard lint`, then the test typecheck from Global Constraints.
Expected: 16 test files, 258 tests pass; typecheck and lint clean; test typecheck shows only the pre-existing `release-strip.test.ts(82,41)` error.

- [ ] **Step 8: Coordinator commits**

```bash
git add apps/dashboard/src/raceStatus.ts apps/dashboard/src/room.ts apps/dashboard/src/RacePick.tsx apps/dashboard/src/App.tsx apps/dashboard/src/StatusHome.tsx apps/dashboard/src/WarRoom.tsx apps/dashboard/test/raceStatus.test.tsx apps/dashboard/test/racepick.test.tsx
git commit -m "$(cat <<'MSG'
feat(dashboard): race-true status contract, room.ts, shared pick controls

Queen-Origin: agent:claude-code
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 2: U2 goal page and race cards

**Files:**
- Create: `apps/dashboard/src/GoalPage.tsx`
- Create: `apps/dashboard/src/RaceCard.tsx`
- Create: `apps/dashboard/test/goalpage.test.tsx`
- (Do not touch `ItemView.tsx` or `App.tsx`: Task 5 swaps `ItemView` for `GoalPage` and deletes `ItemView.tsx`, ruling R6.)

**Interfaces:**
- Consumes (Task 1): `rootOf`, `cardItems`, `cardSummary`, `withDetail`, `pushCommand`, `candidateStatus`, `raceChipClass`, `candChipClass`, type `CardSummary` from `./raceStatus`; `CandidateActions`, `RejectAll` from `./RacePick`.
- Consumes (existing): `RaceEntries` (`./RaceEntries`, renders "End entries now"), `raceView` (`./swarm`), `entryState` (`./raceLogic`), `useNow`, `MemoryRecall` (`./components`, kept by Task 5), `relativeTime` (`./lanes`, kept by Task 5), `useResource` (`./hooks`), `api.item`, `api.events`, `api.itemAction`, `errorMessage` (`./api`), `attemptsOf`, `gateText`, `durationText`, `validItemActions`, `isExternal` (`./homeLogic`), `CopyButton` (`./PushCode`), `itemOrigin` (`./origin`), `ErrorNotice`, `OriginChip` (`./shell`), `hrefFor`, `Link`.
- Produces: `GoalPage({ hive, itemId, state, now? }: { hive: string; itemId: string; state: State; now?: number })` (Task 5 renders it for `page === "item"`); `RaceCard({ hive, card, entries, highlight?, now, onChanged? })`.
- **Class names emitted:** `gp`, `gp__head`, `gp__crumbs`, `gp__trace`, `gp__title`, `gp__body`, `gp__chips`, `gp__acc`, `gp__push` (with existing `push__cmd`), `gp__actions`, `gp__esc`, `gp__cards`, `gp__release`; `rc`, `rc--{cyan,gold,violet,green,red,muted}`, `rc--highlight`, `rc__head`, `rc__title`, `rc__rows`, `rc__empty`, `rc__actions`, `rc__details`, `rc__more`, `rc__claims`, `rc__races`, `rc__history`, `rc__attempt`, `rc__attempt--old`, `rc__events`; `cand`, `cand--{building,gating,passed,failed,reworking,won,lost}`, `cand__who`, `cand__claim`, `cand__preview`; `skel`, `skel--card`; plus Task 1's `race-chip*`, `cand-chip*`, `cand__actions*`. Each card has `id="card-<itemId>"`.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/test/goalpage.test.tsx`:

```tsx
/** Dashboard redesign U2: the goal page and its race cards (spec §4). renderToString: effects (fetches) never run. */
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { reworkReasonText, type HiveStatus, type MergeTrain, type Race, type WorkItem } from "@queenos/queen-types";

import { GoalPage } from "../src/GoalPage";
import { initialState, type State } from "../src/reducer";

const NOW = 1_800_000_000_000;
const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  itemId: "i1", hive: "demo", kind: "feature", title: "Item", body: "", acceptance: [], priority: 2, status: "ACTIVE", parentId: null, rootId: over.itemId ?? "i1", depth: 0,
  dependsOn: [], source: { kind: "user", actor: "kyle@kaikeru.com" }, traceId: "a".repeat(32), spanId: "b".repeat(16), difficulty: "normal", bestOf: null, attempts: 0, conflicts: 0,
  paths: [], waitReason: null, duplicateOf: null, blockedReason: null, releaseId: null, escalationId: null, createdAt: NOW - 600_000, updatedAt: NOW - 600_000, ...over,
});
const race = (over: Partial<Race>): Race => ({ raceId: "r", itemId: "i1", width: 1, state: "RACING", trainIds: [], winnerTrainId: null, reason: null, deadlineAt: null, createdAt: NOW - 300_000, decidedAt: null, ...over });
const agent = (name: string, model: string) => ({ kind: "agent" as const, id: `${name}@kyle@kaikeru.com`, model });
const train = (id: string, over: Partial<MergeTrain>): MergeTrain => ({
  trainId: id, baseSha: "0".repeat(40), includedPrompts: ["i1"], artifactRepo: "demo", status: "TESTING", phase: "TESTING", lane: "BUILD", createdAt: NOW - 200_000, candidate: 0, raceOutcome: "RACING",
  previewUrl: `https://${id}.example.dev`, ...over,
});
const EXTERNAL = { settings: { executors: "external", autonomy: "autonomous" }, effectiveAutonomy: "autonomous", degradedBy: [], throughput: { landed24h: 0 } } as unknown as HiveStatus;

const goal = item({ itemId: "g", kind: "goal", title: "Rename morse key", body: "Rename the morse key from dot to dit", acceptance: ['/features/morse returns dit for "."'], judge: "human" });
const c1 = item({ itemId: "g-c1", parentId: "g", rootId: "g", depth: 1, title: "Rename in morse.js", createdAt: NOW - 500_000 });
const c2 = item({ itemId: "g-c2", parentId: "g", rootId: "g", depth: 1, title: "Update features index", createdAt: NOW - 400_000 });
const c3 = item({ itemId: "g-c3", parentId: "g", rootId: "g", depth: 1, title: "Add morse docs", createdAt: NOW - 300_000 });
const picking = race({ raceId: "r1", itemId: "g-c1", state: "PICKING", pickDeadlineAt: NOW + 250_000 });
const racing = race({ raceId: "r2", itemId: "g-c2", entryClosesAt: NOW + 192_000 });
const trains = [
  train("old", { raceId: "r1", includedPrompts: ["g-c1"], origin: agent("w1", "sonnet"), raceOutcome: "LOST", status: "EJECTED", createdAt: NOW - 290_000, previewUrl: "https://old.example.dev" }),
  train("a", { raceId: "r1", includedPrompts: ["g-c1"], origin: agent("w1", "sonnet"), raceOutcome: "PASSED" }),
  train("b", { raceId: "r1", includedPrompts: ["g-c1"], origin: agent("w2", "haiku"), raceOutcome: "PASSED", candidate: 1 }),
  train("c", { raceId: "r1", includedPrompts: ["g-c1"], origin: agent("w3", "opus"), raceOutcome: "REWORK", status: "EJECTED", candidate: 2, reason: reworkReasonText("human", NOW + 723_000, "x") }),
  train("d", { raceId: "r2", includedPrompts: ["g-c2"], origin: agent("w4", "sonnet") }),
  train("e", { raceId: "r2", includedPrompts: ["g-c2"], origin: agent("w5", "opus"), raceOutcome: "FAILED", status: "EJECTED", summary: "lint: unexpected token", candidate: 1 }),
];
const state = (over: Partial<State> = {}): State => ({
  ...initialState,
  loaded: true,
  hive: EXTERNAL,
  items: { g: goal, "g-c1": c1, "g-c2": c2, "g-c3": c3 },
  itemOrder: ["g", "g-c1", "g-c2", "g-c3"],
  races: { r1: picking, r2: racing },
  trains: Object.fromEntries(trains.map((t) => [t.trainId, t])),
  trainOrder: trains.map((t) => t.trainId),
  ...over,
});
const render = (id: string, s = state()) => renderToString(<GoalPage hive="demo" itemId={id} state={s} now={NOW} />);

describe("goal page header", () => {
  test("title, body, judge chip, acceptance, the goal push command and the trace link", () => {
    const html = render("g");
    expect(html).toContain("Rename morse key");
    expect(html).toContain("Rename the morse key from dot to dit");
    expect(html).toContain("you pick");
    expect(html).toContain("/features/morse returns dit for &quot;.&quot;");
    expect(html).toContain("git push origin HEAD:goal/rename-morse-key/&lt;your-agent-name&gt;");
    expect(html).toContain(`/traces/${"a".repeat(32)}`);
    expect(html).toContain(">Cancel<");
  });
  test("no push command on swarm hives, and no push hint on their cards", () => {
    const html = render("g", state({ hive: null }));
    expect(html).not.toContain("git push origin");
    expect(html).not.toContain("No candidates yet");
  });
});

describe("race cards", () => {
  test("one card per child in filed order, each with its race-true chip", () => {
    const html = render("g");
    const order = ["Rename in morse.js", "Update features index", "Add morse docs"].map((t) => html.indexOf(t));
    expect(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1]!))).toBe(true);
    expect(html).toContain("you pick · 4:10 left");
    expect(html).toContain("racing · entries close 3:12");
    expect(html).toContain("awaiting submissions");
  });
  test("PICKING card: Pick and Reject on each passed head only, Reject all, preview links, no iframe", () => {
    const html = render("g");
    expect(html.match(/>Pick</g)).toHaveLength(2);
    expect(html.match(/>Reject</g)).toHaveLength(2);
    expect(html.match(/Reject all/g)).toHaveLength(1);
    expect(html).toContain("passed · waiting for your pick");
    expect(html).toContain("reworking · human · due in 12:03");
    expect(html).toContain("w1@kyle");
    expect(html).toContain("claims sonnet");
    expect(html).toContain("https://a.example.dev");
    expect(html).not.toContain("<iframe");
  });
  test("superseded and rejected heads are hidden, with no preview link", () => {
    const html = render("g");
    expect(html).not.toContain("https://old.example.dev");
    expect(html).not.toContain("https://c.example.dev");
  });
  test("RACING card with open entries: End entries now; failed head shows its first finding and its preview", () => {
    const html = render("g");
    expect(html).toContain("End entries now");
    expect(html).toContain("failed: lint: unexpected token");
    expect(html).toContain("https://e.example.dev");
    expect(html).toContain("gating");
  });
  test("no race yet: the item push hint", () => {
    expect(render("g")).toContain("No candidates yet. Agents push to <code>item/g-c3/&lt;your-agent-name&gt;</code>");
  });
  test("a decided race: no Pick, no Reject all, no End entries now", () => {
    const html = render("g", state({ races: { r1: { ...picking, state: "DECIDED", winnerTrainId: "a" }, r2: { ...racing, state: "DECIDED", winnerTrainId: "d" } } }));
    expect(html).not.toMatch(/>Pick</);
    expect(html).not.toContain("Reject all");
    expect(html).not.toContain("End entries now");
    expect(html).toContain("won ★");
  });
  test("a child id renders its root's page with that card highlighted", () => {
    const html = render("g-c2");
    expect(html).toContain("Rename the morse key from dot to dit");
    expect(html).toMatch(/id="card-g-c2" class="panel rc rc--cyan rc--highlight"/);
    expect(html).not.toMatch(/id="card-g-c1" class="[^"]*rc--highlight/);
  });
  test("a loose item is its own root with one card", () => {
    const loose = item({ itemId: "bug", kind: "bug", title: "fix: typo in moon" });
    const html = render("bug", state({ items: { bug: loose }, itemOrder: ["bug"], races: {}, trains: {}, trainOrder: [] }));
    expect(html.match(/class="panel rc /g)).toHaveLength(1);
    expect(html).toContain("git push origin HEAD:item/bug/&lt;your-agent-name&gt;");
  });
  test("an id the state does not hold renders the shimmer skeleton, not an error", () => {
    const html = render("nope", state({ items: {}, itemOrder: [] }));
    expect(html).toContain("skel skel--card");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run test/goalpage.test.tsx`
Expected: FAIL: `Failed to resolve import "../src/GoalPage"`.

- [ ] **Step 3: Write `src/RaceCard.tsx`**

```tsx
import { useState } from "react";
import type { QueenEvent } from "@queenos/queen-types";

import { api } from "./api";
import { MemoryRecall } from "./components";
import { useResource } from "./hooks";
import { attemptsOf, durationText, gateText, type Attempt } from "./homeLogic";
import { relativeTime } from "./lanes";
import { RaceEntries } from "./RaceEntries";
import { CandidateActions, RejectAll } from "./RacePick";
import { candChipClass, candidateStatus, raceChipClass, type CardSummary } from "./raceStatus";
import type { RaceView } from "./swarm";

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });

/**
 * One race card on the goal page (spec §4.3): the item's title and race chip, one row per contributor's current head
 * (verdict chip, preview link, Pick / Reject while PICKING), Reject all / End entries now, and collapsed details.
 */
export function RaceCard({ hive, card, entries, highlight = false, now, onChanged }: { hive: string; card: CardSummary; entries: RaceView | null; highlight?: boolean; now: number; onChanged?: () => void }) {
  const { item, race, status, heads } = card;
  const [open, setOpen] = useState(false);
  // An external item no one pushed to yet (or a race whose entries have not arrived): say where agents push.
  const waiting = heads.length === 0 && (status.kind === "awaiting" || status.kind === "racing");
  return (
    <section id={`card-${item.itemId}`} className={`panel rc rc--${status.tone}${highlight ? " rc--highlight" : ""}`} aria-label={`Race for ${item.title}`} data-item={item.itemId}>
      <header className="rc__head">
        <h3 className="rc__title">▸ {item.title}</h3>
        <span className={raceChipClass(status)}>{status.text}</span>
      </header>
      {heads.length > 0 && (
        <ul className="rc__rows">
          {heads.map((h) => (
            <li key={h.train.trainId} className={`cand cand--${h.status.kind}`}>
              <span className="cand__who" title={h.origin.title}>{h.who}</span>
              {h.claim && <span className="cand__claim sh-muted">claims {h.claim}</span>}
              <span className={candChipClass(h.status)}>{h.status.text}</span>
              {h.previewUrl && <a className="cand__preview sh-link" href={h.previewUrl} target="_blank" rel="noreferrer">preview ▸</a>}
              {h.pickable && race && <CandidateActions hive={hive} raceId={race.raceId} trainId={h.train.trainId} tag={h.tag} compact onChanged={onChanged} />}
            </li>
          ))}
        </ul>
      )}
      {waiting && (
        <p className="rc__empty sh-muted">
          No candidates yet. Agents push to <code>{`item/${item.itemId}/<your-agent-name>`}</code>
        </p>
      )}
      <div className="rc__actions">
        {race?.state === "PICKING" && <RejectAll hive={hive} raceId={race.raceId} onChanged={onChanged} />}
        {entries && <RaceEntries hive={hive} view={entries} now={now} onChanged={onChanged} />}
      </div>
      <details className="rc__details" onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>details (claims, history, memories, events)</summary>
        {open && <CardDetails hive={hive} card={card} now={now} />}
      </details>
    </section>
  );
}

/** Claims and conflicts, attempt history (old heads and older races too), memories, the last 12 events. Mounted when opened. */
function CardDetails({ hive, card, now }: { hive: string; card: CardSummary; now: number }) {
  const { item, race, olderRaces, trains, old } = card;
  const events = useResource(() => api.events(hive, { itemId: item.itemId, limit: 12 }), `${hive}/${item.itemId}/events/${item.updatedAt}`);
  const races = race ? [race, ...olderRaces] : olderRaces;
  const attempts = attemptsOf(trains, races);
  const oldIds = new Set(old.map((t) => t.trainId));
  const claims = [...new Set(trains.filter((t) => t.status !== "EJECTED" && t.status !== "MERGED").flatMap((t) => t.changedPaths ?? []))];
  const conflicts = new Set(trains.flatMap((t) => (t.conflict ? t.conflict.paths : [])));
  const memories = [...trains].reverse().find((t) => t.memories?.length)?.memories ?? [];
  return (
    <div className="rc__more">
      <p className="rc__claims">
        <b>claims</b>{" "}
        {claims.length ? claims.map((p) => <code key={p} className={conflicts.has(p) ? "item__conflict" : ""}>{p}{conflicts.has(p) ? " (conflict)" : ""} </code>) : <span className="sh-muted">none</span>}
      </p>
      {olderRaces.length > 0 && (
        <p className="rc__races sh-muted">earlier races: {olderRaces.map((r) => `${r.raceId.slice(0, 6)} ${r.state.toLowerCase()}`).join(" · ")}</p>
      )}
      {attempts.length === 0 ? <p className="sh-muted">No attempts yet.</p> : <ul className="rc__history">{attempts.map((a) => <AttemptRow key={a.train.trainId} a={a} old={oldIds.has(a.train.trainId)} now={now} />)}</ul>}
      {memories.length > 0 && <MemoryRecall memories={memories} />}
      {events.data && events.data.length > 0 ? (
        <ol className="rc__events">
          {events.data.slice(0, 12).map((e: QueenEvent) => (
            <li key={e.eventId}><time>{clock(e.ts)}</time> <b>{e.type}</b> <span className="sh-muted">{e.summary}</span></li>
          ))}
        </ol>
      ) : (
        <p className="sh-muted">{events.loading ? "…" : "No events."}</p>
      )}
    </div>
  );
}

/** One attempt. A race train's label comes from `candidateStatus`, never from the train status alone. */
function AttemptRow({ a, old, now }: { a: Attempt; old: boolean; now: number }) {
  const t = a.train;
  const label = a.race ? candidateStatus(t, a.race, now).text : (t.phase ?? t.status).toLowerCase();
  const gate = gateText(t);
  return (
    <li className={`rc__attempt${old ? " rc__attempt--old" : ""}`}>
      <b>#{a.n} {a.kind.toLowerCase()}</b> <span>{label}</span>
      {old && <span className="sh-muted"> · old head</span>}
      <span className="sh-muted">
        {gate ? ` · ${gate}` : ""}
        {t.landedSha ? ` · landed ${t.landedSha.slice(0, 7)}` : ""}
        {t.status === "BUILDING" || t.status === "TESTING" ? ` · ${durationText(now - t.createdAt)}` : ` · ${relativeTime(t.createdAt, now)}`}
      </span>
      {t.conflict && <p className="item__conflict">⚡ conflict on {t.conflict.paths.join(", ") || "paths"} ({t.conflict.kind}): {t.conflict.summary}</p>}
    </li>
  );
}
```

- [ ] **Step 4: Write `src/GoalPage.tsx`**

```tsx
import { useEffect, useMemo, useState } from "react";
import { TERMINAL_WORK_STATUSES, type WorkItem } from "@queenos/queen-types";

import { api, errorMessage } from "./api";
import { useNow } from "./components";
import { useResource } from "./hooks";
import { isExternal, validItemActions } from "./homeLogic";
import { itemOrigin } from "./origin";
import { CopyButton } from "./PushCode";
import { RaceCard } from "./RaceCard";
import { entryState } from "./raceLogic";
import { cardItems, cardSummary, pushCommand, rootOf, withDetail } from "./raceStatus";
import type { State } from "./reducer";
import { hrefFor } from "./route";
import { Link } from "./router";
import { ErrorNotice, OriginChip } from "./shell";
import { raceView } from "./swarm";

/**
 * The goal page (spec §4): `/items/<id>` resolves `<id>` to its root and shows the root's header, one race card per
 * child (one for a loose item), and the release line. A child id highlights and scrolls to its card.
 */
export function GoalPage({ hive, itemId, state, now: nowProp }: { hive: string; itemId: string; state: State; now?: number }) {
  const tick = useNow(1000);
  const now = nowProp ?? tick;
  const known = rootOf(state.items, itemId);
  // A deep link to an item the live state does not hold: fetch it to learn its root.
  const asked = useResource(() => (known ? Promise.resolve(null) : api.item(hive, itemId)), `${hive}/${itemId}/${known ? "live" : "rest"}`);
  const rootId = known?.itemId ?? asked.data?.item.rootId ?? null;
  const live = rootId ? (state.items[rootId] ?? null) : null;
  const detail = useResource(() => (rootId ? api.item(hive, rootId) : Promise.resolve(null)), `${hive}/${rootId ?? "-"}/${live?.status ?? ""}:${live?.updatedAt ?? 0}`);
  const slice = useMemo(() => withDetail(state, detail.data ?? asked.data), [state, detail.data, asked.data]);
  const root = rootId ? (slice.items[rootId] ?? null) : null;
  const cards = useMemo(() => (root ? cardItems(slice, root).map((i) => cardSummary(slice, i, now)) : []), [slice, root, now]);

  useEffect(() => {
    if (itemId !== rootId) document.getElementById(`card-${itemId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [itemId, rootId, cards.length]);

  if (!root) {
    const error = asked.error ?? detail.error;
    if (error) return <ErrorNotice error={error} onRetry={() => { asked.reload(); detail.reload(); }} />;
    return (
      <div className="gp" aria-busy="true">
        <div className="skel skel--card" />
        <div className="skel skel--card" />
      </div>
    );
  }

  const reload = () => detail.reload();
  const trains = cards.flatMap((c) => c.trains);
  const releaseId = [root, ...cards.map((c) => c.item)].map((i) => i.releaseId).find(Boolean) ?? null;
  const release = (releaseId ? state.releases[releaseId] : null) ?? detail.data?.release ?? null;
  const ids = new Set([root.itemId, ...cards.map((c) => c.item.itemId)]);
  const escs = Object.values(state.escalations).filter((e) => e.status === "OPEN" && ids.has(e.subject.id));
  const open = root.status !== "LANDED" && !(TERMINAL_WORK_STATUSES as readonly string[]).includes(root.status);

  return (
    <div className="gp">
      <section className="panel gp__head">
        <p className="gp__crumbs">
          <Link to={hrefFor.status(hive)}>◂ {hive}</Link> / {root.kind} “{root.title}”
          <Link className="sh-link gp__trace" to={hrefFor.trace(hive, root.traceId)}>trace ▸</Link>
        </p>
        <h2 className="gp__title">{root.title}</h2>
        {root.body && <p className="gp__body">{root.body}</p>}
        <p className="gp__chips">
          <OriginChip badge={itemOrigin(root, trains)} />
          {root.judge === "human" ? <span className="chip" title="A human picks the winner">you pick</span> : <span className="chip">auto judge</span>}
          <span className="chip">P{root.priority}</span>
        </p>
        {root.acceptance.length > 0 && <ul className="gp__acc">{root.acceptance.map((a, i) => <li key={i}>☐ {a}</li>)}</ul>}
        {isExternal(state.hive) && open && (
          <div className="gp__push push__cmd" aria-label="Push command">
            <pre><code>$ {pushCommand(root)}</code></pre>
            <CopyButton text={pushCommand(root)} label="Copy push command" />
          </div>
        )}
        <ItemActions hive={hive} item={root} onDone={reload} />
        {escs.map((e) => (
          <p key={e.escalationId} className="gp__esc sh-err">⚠ {e.reason}: {e.summary} <Link to={hrefFor.status(hive)}>resolve on status ▸</Link></p>
        ))}
      </section>

      {Boolean(detail.error) && !detail.data && <ErrorNotice error={detail.error} onRetry={reload} />}

      <div className="gp__cards">
        {cards.map((c) => {
          const entries = c.race && entryState(c.race, now)?.kind === "open" ? raceView(slice, c.race.raceId, now) : null;
          return <RaceCard key={c.item.itemId} hive={hive} card={c} entries={entries} highlight={c.item.itemId === itemId && itemId !== root.itemId} now={now} onChanged={reload} />;
        })}
      </div>

      <section className="panel gp__release" aria-label="Release">
        <p className="eyebrow">RELEASE</p>
        {release ? (
          <p>
            <code>{release.releaseId.slice(0, 8)}</code> · {release.phase.toLowerCase()}
            {release.canaryPercent != null && ` · canary ${release.canaryPercent}%`}
            {release.prodUrl && <> · <a href={release.prodUrl} target="_blank" rel="noreferrer">prod ▸</a></>}
          </p>
        ) : (
          <p className="sh-muted">none yet</p>
        )}
      </section>
    </div>
  );
}

/** Retry / Cancel / Not a duplicate, only where valid for the root's status (moved from ItemView). */
function ItemActions({ hive, item, onDone }: { hive: string; item: WorkItem; onDone: () => void }) {
  const actions = validItemActions(item);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (actions.length === 0) return null;
  const run = async (action: (typeof actions)[number]) => {
    setBusy(action);
    setErr(null);
    try {
      await api.itemAction(hive, item.itemId, { action });
      onDone();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="gp__actions">
      {actions.map((a) => (
        <button key={a} type="button" className={`btn${a === "cancel" ? " btn--danger" : " btn--primary"}`} disabled={busy !== null} onClick={() => void run(a)}>
          {busy === a ? "…" : a === "not_duplicate" ? "Not a duplicate" : a === "retry" ? "Retry" : "Cancel"}
        </button>
      ))}
      {err && <span className="sh-err" role="alert">{err}</span>}
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run test/goalpage.test.tsx`
Expected: PASS (11 tests).

- [ ] **Step 6: Package checks**

Run: `pnpm --filter @queenos/dashboard test && pnpm --filter @queenos/dashboard typecheck && pnpm --filter @queenos/dashboard lint`, then the test typecheck.
Expected: tests pass; typecheck / lint clean except the wave errors Global Constraints names (in files you do not own).

- [ ] **Step 7: Coordinator commits** (after the wave lands and the full gate passes)

```bash
git add apps/dashboard/src/GoalPage.tsx apps/dashboard/src/RaceCard.tsx apps/dashboard/test/goalpage.test.tsx
git commit -m "$(cat <<'MSG'
feat(dashboard): goal page with race cards, inline pick and reject

Queen-Origin: agent:claude-code
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 3: U3 home (headline, Add a goal, Needs you, goals, hive health)

**Files:**
- Modify (rewrite): `apps/dashboard/src/StatusHome.tsx`
- Modify: `apps/dashboard/src/HomePanels.tsx` (new `AddGoal`, `Bee`, `NeedsYou`, `EscalationCard` (moved from StatusHome), `GoalList`; `ReleaseStripRow` loses its `hive` prop and the lanes link)
- Modify: `apps/dashboard/src/SwarmFloor.tsx` (no PICKING panels, ruling R11)
- Modify: `apps/dashboard/src/homeLogic.ts` (append `goalPrompt`)
- Create: `apps/dashboard/test/home.test.tsx`

**Interfaces:**
- Consumes (Task 1): `homeHeadline`, `goalRows`, `pickingRows`, `raceChipClass`, `trackFresh`, type `GoalRow` from `./raceStatus`; `CandidateActions`, `RejectAll` from `./RacePick`; type `Room` from `./room`.
- Consumes (Task 4, in flight): `MergeTreePanel({ state, hive, now? }: { state: State; hive: string; now?: number })` from `./MergeGraph.tsx` (replaces `MergeTrainStrip`).
- Consumes (existing): `prodUrlOf`, `releaseStrip` (`./releases`), `openEscalations`, `blockedOrFailed`, `pipelineCounts`, `statusTiles` (`./status`), `useNow` (`./components`), `RUNBOOK` (queen-types), `ACTION_LABEL`, `escalationButtons`, `escalationSubjectLabel`, `reasonText`, `isExternal`, `isSimulation`, `executorsMode`, `autonomyLabel`, `meterFill`, `compactNumber`, `durationText` (`./homeLogic`).
- Produces: `goalPrompt(hive, title, spec, { external, judge }): { namespace; promptText; decompose: true; judge?: "human" }` (homeLogic); `AddGoal({ hive, room })`, `Bee()`, `NeedsYou({ hive, state, now })`, `EscalationCard({ hive, e, items })`, `GoalList({ hive, state, now })`, `ReleaseStripRow({ state })` (HomePanels).
- **Class names emitted:** `sh-hero`, `sh-hero--{calm,racing,needs-you,degraded}`, `sh-hero__dot` (with existing `sh-head`, `sh-head__dot`); `home-top`; `home-composer`, `home-composer__title`, `home-composer__row`, `home-composer__judge`, `btn--launch btn--launch-sm`; `needs`, `needs--pending`, `needs__list`, `needs__race`, `needs__race-head`, `needs__rows`, `needs__row`, `needs__empty`, `bee`; `goals`, `goals__list`, `goal-row`, `goal-row--{cyan,gold,violet,green,red,muted}`, `goal-row--done`, `goal-row--celebrate`, `goal-row__main`, `goal-row__title`, `goal-row__follow`, `goal-row__summary`, `goal-row__tiles`; `atiles`, `atiles--last-minute`, `atile`, `atile--{building,gating,passed,failed,reworking,won}`, `atile--filled`, `atile--changed`; `celebrate-banner`, `celebrate-banner__crown`; `health`, `health__body`; `skel`, `skel--row`; plus `cand__who`, `cand__claim`, `cand__preview`, `cand-chip cand-chip--passed`, `race-chip*`.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/test/home.test.tsx`:

```tsx
/** Dashboard redesign U3: the hive home panels (spec §3.2-§3.5). renderToString: effects never run. */
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { type Escalation, type HiveStatus, type MergeTrain, type Race, type WorkItem } from "@queenos/queen-types";

import { goalPrompt } from "../src/homeLogic";
import { AddGoal, GoalList, NeedsYou } from "../src/HomePanels";
import { initialState, type State } from "../src/reducer";

const NOW = 1_800_000_000_000;
const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  itemId: "i1", hive: "demo", kind: "feature", title: "Item", body: "", acceptance: [], priority: 2, status: "ACTIVE", parentId: null, rootId: over.itemId ?? "i1", depth: 0,
  dependsOn: [], source: { kind: "user", actor: "kyle@kaikeru.com" }, traceId: "a".repeat(32), spanId: "b".repeat(16), difficulty: "normal", bestOf: null, attempts: 0, conflicts: 0,
  paths: [], waitReason: null, duplicateOf: null, blockedReason: null, releaseId: null, escalationId: null, createdAt: NOW - 600_000, updatedAt: NOW - 600_000, ...over,
});
const race = (over: Partial<Race>): Race => ({ raceId: "r", itemId: "i1", width: 1, state: "RACING", trainIds: [], winnerTrainId: null, reason: null, deadlineAt: null, createdAt: NOW - 300_000, decidedAt: null, ...over });
const agent = (name: string, model: string) => ({ kind: "agent" as const, id: `${name}@kyle@kaikeru.com`, model });
const train = (id: string, over: Partial<MergeTrain>): MergeTrain => ({
  trainId: id, baseSha: "0".repeat(40), includedPrompts: ["i1"], artifactRepo: "demo", status: "TESTING", phase: "TESTING", lane: "BUILD", createdAt: NOW - 200_000, candidate: 0, raceOutcome: "RACING",
  previewUrl: `https://${id}.example.dev`, ...over,
});
const EXTERNAL = { settings: { executors: "external", autonomy: "autonomous" }, effectiveAutonomy: "autonomous", degradedBy: [], throughput: { landed24h: 0 } } as unknown as HiveStatus;

const morse = item({ itemId: "m", title: "Rename morse key", createdAt: NOW - 500_000 });
const index = item({ itemId: "x", title: "Update features index", createdAt: NOW - 400_000 });
const bmi = item({ itemId: "b", title: "Add bmi page", status: "LANDED", createdAt: NOW - 100_000 });
const typo = item({ itemId: "t", kind: "bug", title: "fix: typo in moon", source: { kind: "gatekeeper", actor: "gate" }, createdAt: NOW - 50_000 });
const picking = race({ raceId: "r1", itemId: "m", state: "PICKING", pickDeadlineAt: NOW + 250_000 });
const racing = race({ raceId: "r2", itemId: "x", entryClosesAt: NOW + 192_000 });
const trains = [
  train("a", { raceId: "r1", includedPrompts: ["m"], origin: agent("w1", "sonnet"), raceOutcome: "PASSED" }),
  train("b", { raceId: "r1", includedPrompts: ["m"], origin: agent("w2", "haiku"), raceOutcome: "PASSED", candidate: 1 }),
  train("d", { raceId: "r2", includedPrompts: ["x"], origin: agent("w4", "sonnet") }),
];
const state = (over: Partial<State> = {}): State => ({
  ...initialState,
  loaded: true,
  hive: EXTERNAL,
  items: { m: morse, x: index, b: bmi, t: typo },
  itemOrder: ["m", "x", "b", "t"],
  races: { r1: picking, r2: racing },
  trains: Object.fromEntries(trains.map((t) => [t.trainId, t])),
  trainOrder: trains.map((t) => t.trainId),
  ...over,
});

describe("Needs you", () => {
  test("a PICKING race: inline Pick and Reject per passed head, Reject all, the gold glow", () => {
    const html = renderToString(<NeedsYou hive="demo" state={state()} now={NOW} />);
    expect(html).toContain("NEEDS YOU (1)");
    expect(html).toContain("needs--pending");
    expect(html).toContain("you pick · 4:10 left");
    expect(html.match(/>Pick</g)).toHaveLength(2);
    expect(html.match(/>Reject</g)).toHaveLength(2);
    expect(html.match(/Reject all/g)).toHaveLength(1);
    expect(html).toContain("w2@kyle");
    expect(html).not.toContain("<iframe");
  });
  test("RACING and decided races are not in Needs you; empty shows the bee", () => {
    const html = renderToString(<NeedsYou hive="demo" state={state({ races: { r1: { ...picking, state: "DECIDED", winnerTrainId: "a" }, r2: racing } })} now={NOW} />);
    expect(html).not.toMatch(/>Pick</);
    expect(html).toContain("Nothing needs you.");
    expect(html).toContain('class="bee"');
    expect(html).not.toContain("needs--pending");
  });
  test("open escalations are listed with their actions", () => {
    const e = { escalationId: "e1", reason: "APPROVAL_REQUIRED", status: "OPEN", subject: { type: "item", id: "m" }, summary: "ship it?", actions: ["ship", "hold"], traceId: null, createdAt: NOW } as unknown as Escalation;
    const html = renderToString(<NeedsYou hive="demo" state={state({ races: {}, escalations: { e1: e }, escalationOrder: ["e1"] })} now={NOW} />);
    expect(html).toContain("NEEDS YOU (1)");
    expect(html).toContain("Ship anyway");
  });
});

describe("Goals", () => {
  test("one row per root, active before done, race-true chips, summary and agent tiles", () => {
    const html = renderToString(<GoalList hive="demo" state={state()} now={NOW} />);
    const at = (t: string) => html.indexOf(t);
    expect(at("fix: typo in moon")).toBeLessThan(at("Update features index"));
    expect(at("Update features index")).toBeLessThan(at("Rename morse key"));
    expect(at("Rename morse key")).toBeLessThan(at("Add bmi page"));
    expect(html).toContain("you pick · 4:10 left");
    expect(html).toContain("racing · entries close 3:12");
    expect(html).toContain("2 passed");
    expect(html).toContain("1 gating");
    expect(html).toContain("follow-up");
    expect(html).toContain("goal-row--done");
    expect(html.match(/class="atile /g)).toHaveLength(3);
    expect(html.match(/atile--filled/g)).toHaveLength(2);
    expect(html).not.toContain("atile--changed");
    expect(html).not.toMatch(/building|TESTING/);
  });
  test("before the first snapshot: shimmer skeleton rows, not Loading…", () => {
    const html = renderToString(<GoalList hive="demo" state={{ ...initialState, loaded: false }} now={NOW} />);
    expect(html).toContain("skel skel--row");
    expect(html).not.toContain("Loading");
  });
});

describe("Add a goal", () => {
  const room = (s: State) => ({ state: s, status: "open" as const, send: () => true });
  test("title, work spec, the gradient Add goal button; the judge choice only on external hives; no demo buttons", () => {
    const ext = renderToString(<AddGoal hive="demo" room={room(state())} />);
    expect(ext).toContain("ADD A GOAL");
    expect(ext).toContain('aria-label="Goal title"');
    expect(ext).toContain("intent / work spec");
    expect(ext).toContain("btn--launch");
    expect(ext).toContain("you pick");
    expect(ext).not.toMatch(/[Ss]warm demo/);
    const swarm = renderToString(<AddGoal hive="demo" room={room(state({ hive: null }))} />);
    expect(swarm).not.toContain("you pick");
  });
  test("goalPrompt: one decomposed goal, title first; you pick only on external hives", () => {
    expect(goalPrompt("demo", "  Rename  morse ", " spec ", { external: true, judge: "pick" })).toEqual({ namespace: "demo", promptText: "Rename morse\n\nspec", decompose: true, judge: "human" });
    expect(goalPrompt("demo", "Rename", "", { external: true, judge: "auto" })).toEqual({ namespace: "demo", promptText: "Rename", decompose: true });
    expect(goalPrompt("demo", "Rename", "x", { external: false, judge: "pick" })).not.toHaveProperty("judge");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run test/home.test.tsx`
Expected: FAIL: `goalPrompt is not a function` and React's "Element type is invalid" for `AddGoal` / `NeedsYou` / `GoalList` (not exported yet).

- [ ] **Step 3: `goalPrompt` in `src/homeLogic.ts`**

```diff
--- a/apps/dashboard/src/homeLogic.ts
+++ b/apps/dashboard/src/homeLogic.ts
@@ -195,3 +195,14 @@
   if (!isExternal(hive) || item.kind === "goal") return false;
   return item.status !== "LANDED" && !(TERMINAL_WORK_STATUSES as readonly string[]).includes(item.status);
 }
+
+/**
+ * The ADD A GOAL composer's prompt (dashboard redesign §3.3): always one decomposed goal; the title is the first line
+ * (the Queen's `titleFromText`), the work spec the rest. "you pick" only on external hives.
+ */
+export function goalPrompt(hive: string, title: string, spec: string, opts: { external: boolean; judge: ExternalJudgeChoice }): { namespace: string; promptText: string; decompose: true; judge?: "human" } {
+  const t = title.replace(/\s+/g, " ").trim();
+  const s = spec.trim();
+  const promptText = s ? `${t}\n\n${s}` : t;
+  return { namespace: hive, promptText, decompose: true, ...(opts.external && opts.judge === "pick" ? { judge: "human" as const } : {}) };
+}
```

- [ ] **Step 4: The home panels in `src/HomePanels.tsx`**

```diff
--- a/apps/dashboard/src/HomePanels.tsx
+++ b/apps/dashboard/src/HomePanels.tsx
@@ -1,14 +1,18 @@
-import { useState, type FormEvent } from "react";
-import { GUARDRAIL_DEFAULTS, GUARDRAIL_MAX } from "@queenos/queen-types";
+import { useMemo, useRef, useState, type FormEvent } from "react";
+import { GUARDRAIL_DEFAULTS, GUARDRAIL_MAX, RUNBOOK, type Escalation, type EscalationAction } from "@queenos/queen-types";
 import { api, errorMessage } from "./api";
-import { GUARDRAIL_FIELDS, guardrailPatch, parseGuardrail, type GuardrailKey } from "./homeLogic";
-import { releaseStrip } from "./releases";
+import { ACTION_LABEL, GUARDRAIL_FIELDS, escalationButtons, escalationSubjectLabel, goalPrompt, guardrailPatch, isExternal, parseGuardrail, reasonText, type ExternalJudgeChoice, type GuardrailKey } from "./homeLogic";
+import { CandidateActions, RejectAll } from "./RacePick";
+import { goalRows, pickingRows, raceChipClass, trackFresh, type GoalRow } from "./raceStatus";
+import { prodUrlOf, releaseStrip } from "./releases";
+import type { Room } from "./room";
 import { Link } from "./router";
 import { hrefFor } from "./route";
 import type { State } from "./reducer";
+import { openEscalations } from "./status";
 
 /** One-line current-release row for the status home: phase timeline, who shipped it, prod link. */
-export function ReleaseStripRow({ hive, state }: { hive: string; state: State }) {
+export function ReleaseStripRow({ state }: { state: State }) {
   const strip = releaseStrip(state);
   if (!strip) return null;
   const { release, steps, shipper, prodUrl } = strip;
@@ -26,7 +30,6 @@
         {prodUrl && (
           <a className="rstrip__prod" href={prodUrl} target="_blank" rel="noreferrer" title={prodUrl}>prod ▸</a>
         )}
-        <Link className="sh-link rstrip__more" to={hrefFor.lanes(hive)}>lanes ▸</Link>
       </div>
       <ol className="rtl__steps rstrip__steps">
         {steps.map((s) => (
@@ -107,3 +110,230 @@
     </details>
   );
 }
+
+// ── add a goal ────────────────────────────────────────────────────────────
+
+/** ADD A GOAL (spec §3.3): title plus intent / work spec; judge auto | you pick on external hives. Always files one decomposed goal. */
+export function AddGoal({ hive, room }: { hive: string; room: Pick<Room, "state" | "status" | "send"> }) {
+  const [title, setTitle] = useState("");
+  const [spec, setSpec] = useState("");
+  const [judge, setJudge] = useState<ExternalJudgeChoice>("auto");
+  const [note, setNote] = useState<string | null>(null);
+  const external = isExternal(room.state.hive);
+  const disabled = room.status !== "open";
+  const submit = (e: FormEvent) => {
+    e.preventDefault();
+    if (!title.trim()) return;
+    const ok = room.send({ type: "submit_prompt", prompt: goalPrompt(hive, title, spec, { external, judge }) });
+    setNote(ok ? (external ? "Added. Agents can push to it now." : "Added. The Queen is splitting it into items.") : "Not linked to the Queen; nothing was sent.");
+    if (ok) {
+      setTitle("");
+      setSpec("");
+    }
+  };
+  return (
+    <form className="panel home-composer" onSubmit={submit} aria-label="Add a goal">
+      <p className="eyebrow">ADD A GOAL</p>
+      {disabled && <p className="composer__hint">Waiting for the Queen link. Adding is disabled until it opens.</p>}
+      <input className="home-composer__title" type="text" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="title" aria-label="Goal title" />
+      <textarea
+        value={spec}
+        onChange={(e) => setSpec(e.target.value)}
+        rows={4}
+        placeholder="intent / work spec …"
+        aria-label="Intent or work spec"
+        onKeyDown={(e) => {
+          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
+        }}
+      />
+      <div className="home-composer__row">
+        {external && (
+          <fieldset className="home-composer__judge">
+            <legend>judge</legend>
+            <label><input type="radio" name="judge" checked={judge === "auto"} onChange={() => setJudge("auto")} /> auto</label>
+            <label><input type="radio" name="judge" checked={judge === "pick"} onChange={() => setJudge("pick")} /> you pick</label>
+          </fieldset>
+        )}
+        <span className="sh-spacer" />
+        <button type="submit" className="btn btn--launch btn--launch-sm" disabled={disabled || !title.trim()}>Add goal</button>
+      </div>
+      {note && <p className="sh-muted" role="status">{note}</p>}
+    </form>
+  );
+}
+
+// ── needs you ─────────────────────────────────────────────────────────────
+
+/** The empty Needs you state (spec §3.7). */
+export function Bee() {
+  return (
+    <div className="needs__empty">
+      <pre className="bee" aria-hidden="true">{"   \\_/\n-=(_'_)>\n   / \\"}</pre>
+      <p><b>Nothing needs you.</b><br /><span className="sh-muted">The hive is buzzing.</span></p>
+    </div>
+  );
+}
+
+/** NEEDS YOU (spec §3.4): escalations plus every PICKING race with inline Pick / Reject / Reject all. Gold glow while a pick waits. */
+export function NeedsYou({ hive, state, now }: { hive: string; state: State; now: number }) {
+  const escalations = openEscalations(state);
+  const picks = pickingRows(state, now);
+  const count = escalations.length + picks.length;
+  return (
+    <section className={`panel needs${picks.length ? " needs--pending" : ""}`} aria-label="Needs you">
+      <p className="eyebrow">{`NEEDS YOU${count ? ` (${count})` : ""}`}</p>
+      {count === 0 ? (
+        <Bee />
+      ) : (
+        <div className="needs__list">
+          {picks.map((p) => (
+            <article key={p.race.raceId} className="needs__race" data-race={p.race.raceId}>
+              <p className="needs__race-head">
+                <Link to={hrefFor.item(hive, p.item.itemId)}>{p.root.itemId === p.item.itemId ? p.item.title : `${p.root.title} · ${p.item.title}`}</Link>{" "}
+                <span className={raceChipClass(p.status)}>{p.status.text}</span>
+              </p>
+              <ul className="needs__rows">
+                {p.heads.map((h) => (
+                  <li key={h.train.trainId} className="needs__row">
+                    <span className="cand__who" title={h.origin.title}>{h.who}</span>
+                    {h.claim && <span className="cand__claim sh-muted">{h.claim}</span>}
+                    <span className="cand-chip cand-chip--passed">passed</span>
+                    {h.previewUrl && <a className="cand__preview sh-link" href={h.previewUrl} target="_blank" rel="noreferrer">preview ▸</a>}
+                    <CandidateActions hive={hive} raceId={p.race.raceId} trainId={h.train.trainId} tag={h.tag} compact />
+                  </li>
+                ))}
+              </ul>
+              <RejectAll hive={hive} raceId={p.race.raceId} />
+            </article>
+          ))}
+          {escalations.map((e) => <EscalationCard key={e.escalationId} hive={hive} e={e} items={state.items} />)}
+        </div>
+      )}
+    </section>
+  );
+}
+
+/** One open escalation with its actions and runbook (moved from StatusHome). */
+export function EscalationCard({ hive, e, items }: { hive: string; e: Escalation; items: State["items"] }) {
+  const [busy, setBusy] = useState<EscalationAction | null>(null);
+  const [err, setErr] = useState<string | null>(null);
+  const [done, setDone] = useState<EscalationAction | null>(null);
+  const [rb, setRb] = useState(false);
+  const run = async (action: EscalationAction) => {
+    setBusy(action);
+    setErr(null);
+    try {
+      await api.resolveEscalation(hive, e.escalationId, { action });
+      setDone(action);
+    } catch (x) {
+      setErr(errorMessage(x));
+    } finally {
+      setBusy(null);
+    }
+  };
+  const runbook = RUNBOOK[e.reason];
+  const subject =
+    e.subject.type === "item" ? <Link to={hrefFor.item(hive, e.subject.id)}>{escalationSubjectLabel(e, items)}</Link> : <span>{escalationSubjectLabel(e, items)}</span>;
+  return (
+    <article className="sh-esc">
+      <p className="sh-esc__title">
+        <span aria-hidden="true">⚠</span> <b>{e.reason}</b> · {subject} · <span className="sh-muted">{reasonText(e.reason)}</span>
+      </p>
+      <p className="sh-esc__summary">{e.summary}</p>
+      <div className="sh-esc__actions">
+        {escalationButtons(e).map((b) => (
+          <button
+            key={b.action}
+            type="button"
+            className={`btn${b.primary ? " btn--primary" : ""}${b.danger ? " btn--danger" : ""}`}
+            disabled={busy !== null || done !== null}
+            onClick={() => void run(b.action)}
+            title={runbook.actions[b.action]}
+          >
+            {busy === b.action ? "…" : b.label}
+          </button>
+        ))}
+        <button type="button" className="sh-link" aria-expanded={rb} onClick={() => setRb((v) => !v)}>runbook {rb ? "▾" : "▸"}</button>
+        {e.traceId && <Link className="sh-link" to={hrefFor.trace(hive, e.traceId)}>trace ▸</Link>}
+      </div>
+      {done && <p className="sh-ok">Sent: {ACTION_LABEL[done]}. Waiting for the Queen to confirm.</p>}
+      {err && <p className="sh-err" role="alert">{err}</p>}
+      {rb && (
+        <dl className="sh-runbook">
+          <dt>What happened</dt><dd>{runbook.what}</dd>
+          <dt>What the Queen did</dt><dd>{runbook.did}</dd>
+          {Object.entries(runbook.actions).map(([a, text]) => (
+            <div key={a}><dt>{ACTION_LABEL[a as EscalationAction]}</dt><dd>{text}</dd></div>
+          ))}
+        </dl>
+      )}
+    </article>
+  );
+}
+
+// ── goals ─────────────────────────────────────────────────────────────────
+
+/** GOALS (spec §3.2): one card per root, active before done, newest first, with a race chip, a summary and agent tiles. */
+export function GoalList({ hive, state, now }: { hive: string; state: State; now: number }) {
+  const rows = useMemo(() => goalRows(state, now), [state, now]);
+  // Motion marks state changes only: tiles and landings first seen after the page loaded.
+  const memo = useRef({ seen: null as Set<string> | null, fresh: new Set<string>() });
+  const fresh = trackFresh(memo.current, rows.flatMap((r) => [...r.tiles.flatMap((g) => g.tiles.map((t) => t.key)), `${r.root.itemId}:${r.status.kind}`]));
+  const prod = prodUrlOf(state);
+  if (!state.loaded) {
+    return (
+      <section className="panel goals" aria-label="Goals" aria-busy="true">
+        <p className="eyebrow">GOALS</p>
+        <div className="skel skel--row" />
+        <div className="skel skel--row" />
+        <div className="skel skel--row" />
+      </section>
+    );
+  }
+  return (
+    <section className="panel goals" aria-label="Goals">
+      <p className="eyebrow">{`GOALS${rows.length ? ` (${rows.length})` : ""}`}</p>
+      {rows.length === 0 ? (
+        <p className="sh-muted">{isExternal(state.hive) ? "Nothing yet. Add a goal, or have your agents push to goal/<slug> or item/<id>/<agent>." : "Nothing yet. Add a goal and the Queen splits it into items."}</p>
+      ) : (
+        <ul className="goals__list">
+          {rows.map((r) => <GoalRowView key={r.root.itemId} hive={hive} row={r} fresh={fresh} prod={prod} />)}
+        </ul>
+      )}
+    </section>
+  );
+}
+
+function GoalRowView({ hive, row, fresh, prod }: { hive: string; row: GoalRow; fresh: ReadonlySet<string>; prod: string | null }) {
+  const { root, status, summary, tiles } = row;
+  const celebrate = status.kind === "landed" && fresh.has(`${root.itemId}:landed`);
+  const winner = celebrate ? row.cards.flatMap((c) => c.heads).find((h) => h.status.kind === "won") : undefined;
+  const cls = `goal-row goal-row--${status.tone}${row.done ? " goal-row--done" : ""}${celebrate ? " goal-row--celebrate" : ""}`;
+  return (
+    <li className={cls}>
+      <Link className="goal-row__main" to={hrefFor.item(hive, root.itemId)}>
+        <span className="goal-row__title">{root.title}</span>
+        {row.followUp && <span className="chip chip--sm goal-row__follow">follow-up</span>}
+        <span className={raceChipClass(status)}>{status.text}</span>
+        {summary && <span className="goal-row__summary sh-muted">{summary}</span>}
+      </Link>
+      {tiles.length > 0 && (
+        <span className="goal-row__tiles">
+          {tiles.map((g) => (
+            <span key={g.raceId} className={`atiles${g.lastMinute ? " atiles--last-minute" : ""}`} data-race={g.raceId}>
+              {g.tiles.map((t) => (
+                <span key={t.key} className={`atile atile--${t.kind}${t.filled ? " atile--filled" : ""}${fresh.has(t.key) ? " atile--changed" : ""}`} title={t.title} aria-label={t.title} />
+              ))}
+            </span>
+          ))}
+        </span>
+      )}
+      {celebrate && (
+        <p className="celebrate-banner" role="status">
+          <span className="celebrate-banner__crown" aria-hidden="true">♛</span> Landed{winner ? ` · ${winner.who}${winner.claim ? ` ${winner.claim}` : ""}` : ""}
+          {prod && <> · <a href={prod} target="_blank" rel="noreferrer">prod ▸</a></>}
+        </p>
+      )}
+    </li>
+  );
+}
```

- [ ] **Step 5: Rewrite `src/StatusHome.tsx`**

The page order is header, hero, `home-top` (Add a goal, Needs you), merge tree, goals, collapsed hive health (§3.2). The old swarm composer, external composer, demo buttons, goal trees and the inline escalation list are gone; `EscalationCard` moved to `HomePanels.tsx`. Full file:

```tsx
import { useMemo, useState } from "react";
import { api, errorMessage } from "./api";
import { useNow } from "./components";
import { autonomyLabel, compactNumber, durationText, executorsMode, isExternal, isSimulation, meterFill } from "./homeLogic";
import { MergeTreePanel } from "./MergeGraph.tsx";
import { Link } from "./router";
import { hrefFor } from "./route";
import { AddGoal, GoalList, GuardrailsPanel, NeedsYou, ReleaseStripRow } from "./HomePanels";
import { homeHeadline } from "./raceStatus";
import type { Room } from "./room";
import { HiveFooter, HiveHeader, ItemChip, OriginChip } from "./shell";
import { blockedOrFailed, pipelineCounts, statusTiles, type ItemRow } from "./status";
import { SwarmFloor } from "./SwarmFloor";

/**
 * The hive home (dashboard redesign §3.2): headline, ADD A GOAL beside NEEDS YOU, the MERGE TREE, the GOALS list and a
 * collapsed HIVE HEALTH. Every race label comes from raceStatus.ts.
 */
export function StatusHome({ hive, room }: { hive: string; room: Room }) {
  const { state, status, latencyMs } = room;
  const now = useNow(1000);
  const head = useMemo(() => homeHeadline(state), [state]);
  const external = isExternal(state.hive);

  return (
    <div className="app hive-page">
      {state.outdated && (
        <div className="update-banner" role="alert">
          <span>QueenOS was updated. Reload to get the latest dashboard</span>
          <button type="button" onClick={() => window.location.reload()}>Reload</button>
        </div>
      )}
      <HiveHeader hive={hive} status={status} latencyMs={latencyMs} sim={isSimulation(state.hive)} actions={<><ExecutorsSelect hive={hive} state={state} /><AutonomySelect hive={hive} state={state} /><Link to={hrefFor.push(hive)} className="sh-link">push code ▸</Link></>} />

      <section className={`sh-head sh-hero sh-hero--${head.mood}`} aria-live="polite">
        <span className="sh-head__dot sh-hero__dot" aria-hidden="true" />
        <h2>{head.text}</h2>
      </section>

      <div className="home-top">
        <AddGoal hive={hive} room={room} />
        <NeedsYou hive={hive} state={state} now={now} />
      </div>

      <MergeTreePanel state={state} hive={hive} />

      <GoalList hive={hive} state={state} now={now} />

      <HiveHealth hive={hive} state={state} external={external} />

      <HiveFooter hive={hive} />
    </div>
  );
}

/** HIVE HEALTH, collapsed (spec §3.2 item 5): release strip, tiles, guardrails, throughput, blocked / failed, swarm floor. */
function HiveHealth({ hive, state, external }: { hive: string; state: Room["state"]; external: boolean }) {
  const tiles = useMemo(() => statusTiles(state), [state.hive]);
  const blocked = useMemo(() => blockedOrFailed(state), [state]);
  const counts = useMemo(() => pipelineCounts(state), [state.items, state.hive]);
  return (
    <details className="panel health" aria-label="Hive health">
      <summary><span className="eyebrow">HIVE HEALTH</span> <span className="sh-muted">release, budget, guardrails, throughput{blocked.length ? `, ${blocked.length} blocked or failed` : ""}</span></summary>
      <div className="health__body">
        <ReleaseStripRow state={state} />
        <Tiles tiles={tiles} />
        <GuardrailsPanel hive={hive} state={state} />
        <div className="sh-two">
          <section className="panel" aria-label="Throughput">
            <p className="eyebrow">THROUGHPUT (24H)</p>
            <Throughput tiles={tiles} counts={counts} />
          </section>
          <section className="panel" aria-label="Blocked or failed">
            <p className="eyebrow">BLOCKED / FAILED ({blocked.length})</p>
            {blocked.length === 0 ? (
              <p className="sh-muted">Nothing is stuck.</p>
            ) : (
              <ul className="sh-tree">
                {blocked.slice(0, 8).map((r) => <Row key={r.item.itemId} hive={hive} row={r} retry />)}
              </ul>
            )}
          </section>
        </div>
        {!external && <SwarmFloor state={state} hive={hive} />}
      </div>
    </details>
  );
}

// ── autonomy ──────────────────────────────────────────────────────────────

function AutonomySelect({ hive, state }: { hive: string; state: Room["state"] }) {
  const h = state.hive;
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!h) return null;
  const set = async (autonomy: "autonomous" | "supervised" | "paused") => {
    setBusy(true);
    setErr(null);
    try {
      await api.updateSettings(hive, { autonomy });
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const degraded = h.effectiveAutonomy !== h.settings.autonomy;
  return (
    <label className={`sh-auto${degraded ? " sh-auto--degraded" : ""}`} title={err ?? "Autonomy level"}>
      <span>{autonomyLabel(h)}</span>
      <select value={h.settings.autonomy} disabled={busy} onChange={(e) => void set(e.target.value as "autonomous" | "supervised" | "paused")} aria-label="Autonomy">
        <option value="autonomous">autonomous</option>
        <option value="supervised">supervised</option>
        <option value="paused">paused</option>
      </select>
      {err && <i className="sh-auto__err">{err}</i>}
    </label>
  );
}

function ExecutorsSelect({ hive, state }: { hive: string; state: Room["state"] }) {
  const h = state.hive;
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!h) return null;
  const set = async (executors: "swarm" | "external") => {
    setBusy(true);
    setErr(null);
    try {
      await api.updateSettings(hive, { executors });
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className="sh-auto" title={err ?? "Who builds: the Queen's swarm, or your own coding agents pushing over git"}>
      <span>workers</span>
      <select value={executorsMode(h)} disabled={busy} onChange={(e) => void set(e.target.value as "swarm" | "external")} aria-label="Workers">
        <option value="swarm">swarm</option>
        <option value="external">external agents</option>
      </select>
      {err && <i className="sh-auto__err">{err}</i>}
    </label>
  );
}

// ── tiles ─────────────────────────────────────────────────────────────────

function Meter({ label, fill, text, tone }: { label: string; fill: number; text: string; tone?: "ok" | "warn" | "bad" }) {
  return (
    <div className="sh-tile">
      <p className="sh-tile__label">{label}</p>
      <div className={`sh-meter sh-meter--${tone ?? "ok"}`} role="meter" aria-label={label} aria-valuenow={Math.round(fill * 100)} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ width: `${fill * 100}%` }} />
      </div>
      <p className="sh-tile__text">{text}</p>
    </div>
  );
}

function Tiles({ tiles }: { tiles: ReturnType<typeof statusTiles> }) {
  const { slots, errorBudget, credits } = tiles;
  if (!slots && !errorBudget && !credits) return null;
  return (
    <div className="sh-tiles">
      {slots && <Meter label="Slots" fill={meterFill(slots.used, slots.total)} text={`${slots.used}/${slots.total} (lease ${slots.leased})`} tone={slots.used >= slots.total ? "warn" : "ok"} />}
      {errorBudget && (
        <Meter
          label="Error budget"
          fill={meterFill(Math.max(0, errorBudget.remaining), errorBudget.total)}
          text={errorBudget.exhausted ? "exhausted" : `${errorBudget.remaining} of ${errorBudget.total} left`}
          tone={errorBudget.exhausted ? "bad" : errorBudget.remaining <= 1 ? "warn" : "ok"}
        />
      )}
      {credits && (
        <Meter
          label="Credits today"
          fill={meterFill(credits.used, credits.limit)}
          text={`${compactNumber(credits.used)}/${compactNumber(credits.limit)}`}
          tone={credits.used >= credits.limit ? "bad" : credits.used / (credits.limit || 1) > 0.8 ? "warn" : "ok"}
        />
      )}
    </div>
  );
}

function Throughput({ tiles, counts }: { tiles: ReturnType<typeof statusTiles>; counts: ReturnType<typeof pipelineCounts> }) {
  const t = tiles.throughput;
  const c = tiles.concurrency;
  if (!t) return <p className="sh-muted">Waiting for the Queen's status.</p>;
  return (
    <>
      <dl className="sh-kv">
        <div><dt>landed</dt><dd>{t.landed24h}</dd></div>
        <div><dt>shipped</dt><dd>{t.shipped24h}</dd></div>
        <div><dt>lead p50</dt><dd>{durationText(t.leadTimeP50Ms)}</dd></div>
        <div><dt>first-try</dt><dd>{t.firstTryPassRate == null ? "–" : `${Math.round(t.firstTryPassRate * 100)}%`}</dd></div>
        {c && <div><dt>conflicts</dt><dd>{c.conflicts24h}</dd></div>}
        {c && <div><dt>bisects</dt><dd>{c.bisects24h}</dd></div>}
      </dl>
      <p className="sh-pipe">
        {(["READY", "ACTIVE", "BLOCKED", "LANDED", "SHIPPED", "FAILED"] as const).map((s) => (
          <span key={s}><b>{counts[s]}</b> {s.toLowerCase()}</span>
        ))}
      </p>
    </>
  );
}

// ── blocked / failed rows ─────────────────────────────────────────────────

function rowNote(r: ItemRow): string | null {
  if (r.race && r.subState === "racing") {
    const d = r.race.decidingInMs;
    return `racing best-of-${r.race.race.width} · ${r.race.passed} passed${d != null ? `, deciding ${Math.ceil(d / 1000)}s` : ""}`;
  }
  if (r.item.status === "SHIPPED") return `${durationText(r.item.updatedAt - r.item.createdAt)} lead time`;
  return r.note;
}

/** A blocked or failed item, with retry for FAILED ones. */
function Row({ hive, row, retry }: { hive: string; row: ItemRow; retry?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (action: "retry" | "cancel") => {
    setBusy(true);
    setErr(null);
    try {
      await api.itemAction(hive, row.item.itemId, { action });
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const note = rowNote(row);
  return (
    <li className="sh-row">
      <span className={`sh-kind sh-kind--${row.item.kind}`}>{row.item.kind}</span>
      <Link className="sh-row__title" to={hrefFor.item(hive, row.item.itemId)}>{row.item.title}</Link>
      <ItemChip status={row.item.status} sub={row.subState} />
      <OriginChip badge={row.origin} />
      {note && <span className="sh-row__note">{note}</span>}
      {retry && row.item.status === "FAILED" && (
        <button type="button" className="sh-link" disabled={busy} onClick={() => void act("retry")}>{busy ? "…" : "retry ▸"}</button>
      )}
      {err && <span className="sh-err">{err}</span>}
    </li>
  );
}
```

- [ ] **Step 6: `src/SwarmFloor.tsx` stops rendering pick panels**

```diff
--- a/apps/dashboard/src/SwarmFloor.tsx
+++ b/apps/dashboard/src/SwarmFloor.tsx
@@ -4,8 +4,7 @@
 import type { State } from "./reducer";
 import { hrefFor } from "./route";
 import { Link } from "./router";
-import { RacePick } from "./RacePick";
-import { floorSummary, raceView, swarmFloor, type SwarmGroup, type SwarmTile } from "./swarm";
+import { floorSummary, swarmFloor, type SwarmGroup, type SwarmTile } from "./swarm";
 import "./swarm.css";
 
 const mmss = (ms: number) => {
@@ -49,10 +48,6 @@
   const { trains, trainOrder, items, races, events, landed } = state;
   const floor = useMemo(() => swarmFloor({ trains, trainOrder, items, races, events, landed }), [trains, trainOrder, items, races, events, landed]);
   const summary = floorSummary(floor);
-  const picking = useMemo(
-    () => Object.values(races).filter((r) => r.state === "PICKING").sort((a, b) => a.createdAt - b.createdAt).map((r) => raceView({ trains, trainOrder, items, races, events, landed }, r.raceId, now)).filter((v) => v != null),
-    [races, trains, trainOrder, items, events, landed, now],
-  );
   const peak = Math.max(1, ...floor.groups.map((g) => g.count));
   return (
     <section className="floor" aria-label="Swarm floor">
@@ -82,7 +77,6 @@
           ))}
         </div>
       )}
-      {picking.map((v) => <RacePick key={v.race.raceId} hive={hive} view={v} now={now} showItem />)}
     </section>
   );
 }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/home.test.tsx test/swarmui.test.tsx`
Expected: PASS. (`home.test.tsx` renders the panels, not `StatusHome`, so it does not need Task 4.)

- [ ] **Step 8: Package checks**

Run: `pnpm --filter @queenos/dashboard test && pnpm --filter @queenos/dashboard typecheck && pnpm --filter @queenos/dashboard lint`, then the test typecheck.
Expected: tests pass. Until Task 4 lands, typecheck reports `MergeTreePanel` missing from `./MergeGraph.tsx` in `StatusHome.tsx`: expected; anything else is yours.

- [ ] **Step 9: Coordinator commits** (after the wave lands and the full gate passes)

```bash
git add apps/dashboard/src/StatusHome.tsx apps/dashboard/src/HomePanels.tsx apps/dashboard/src/SwarmFloor.tsx apps/dashboard/src/homeLogic.ts apps/dashboard/test/home.test.tsx
git commit -m "$(cat <<'MSG'
feat(dashboard): goal-first home with Needs you, add a goal, hive health

Queen-Origin: agent:claude-code
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 4: U4 merge tree panel

**Files:**
- Modify: `apps/dashboard/src/MergeGraph.tsx` (`MergeTreePanel` replaces `MergeTrainStrip`)
- Create: `apps/dashboard/test/mergetree.test.tsx`

**Interfaces:**
- Consumes (Task 1): `whoOf` from `./raceStatus`.
- Consumes (existing): `queueRail(state)` → `{ main: { sha; trainId } | null; cars: QueueCar[] }` and `recentBisects(state, n)` from `./swarm`; `MergeGraph`, `STRIP_SPAN_MS` (same file).
- Produces: `MergeTreePanel({ state, hive, now? }: { state: State; hive: string; now?: number })`. `MergeTrainStrip` is removed; its only caller (`StatusHome.tsx`) switches in Task 3.
- **Class names emitted:** `mtree`, `mtree__head`, `mtree__landed` (keyed by sha: remounts, so its drop animation plays per landing), `mtree__cars`, `mtree__list`, `mtree__car`, `mtree__car--{merging,gating,passed,landing}`, `mtree__car--bisect`, `mtree__car-label`, `mtree__phase`, `mtree__members`, `mtree__empty`; the graph keeps its own `mg*` classes (`mergeGraph.css`, unchanged).

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/test/mergetree.test.tsx`:

```tsx
/** Dashboard redesign U4: the MERGE TREE panel (spec §3.2 item 3). */
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";

import { MergeTreePanel } from "../src/MergeGraph.tsx";
import { buildSwarmFixture } from "../src/mockQueen";
import { initialState, reducer, type Action, type State } from "../src/reducer";

const NOW = 1_800_000_000_000;
const fx = buildSwarmFixture("demo", NOW);
const load = (): State =>
  reducer(initialState, {
    type: "server",
    at: NOW,
    message: { type: "snapshot", promptRuns: [], trains: fx.trains, recentAudit: [], items: fx.items, races: fx.races, escalations: fx.escalations, hive: fx.hive, recentEvents: fx.events },
  } as unknown as Action);

test("no cars: the graph area and CARS say No cars in line", () => {
  const html = renderToString(<MergeTreePanel state={initialState} hive="demo" now={NOW} />);
  expect(html).toContain("MERGE TREE");
  expect(html).toContain("CARS");
  expect(html).toContain("No cars in line");
  expect(html).toContain('class="mg mg--compact"');
});

test("cars: one row per live car with its label, phase and members, linking to the goal page", () => {
  const html = renderToString(<MergeTreePanel state={load()} hive="demo" now={NOW} />);
  expect(html).not.toContain("No cars in line");
  expect(html).toContain("mtree__car--landing");
  expect(html).toMatch(/class="mtree__car-label">K\d+</);
  expect(html).toContain("/p/demo/items/");
  expect(html).toContain("queue page ▸");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run test/mergetree.test.tsx`
Expected: FAIL: rendering `MergeTreePanel` throws (the export does not exist, so the element type is undefined).

- [ ] **Step 3: Replace `MergeTrainStrip` with `MergeTreePanel`**

```diff
--- a/apps/dashboard/src/MergeGraph.tsx
+++ b/apps/dashboard/src/MergeGraph.tsx
@@ -15,7 +15,8 @@
 import type { State } from "./reducer";
 import { hrefFor } from "./route";
 import { Link } from "./router";
-import { itemIdOf } from "./swarm";
+import { whoOf } from "./raceStatus";
+import { itemIdOf, queueRail, recentBisects } from "./swarm";
 import { isPushed, originBadge } from "./origin";
 import { OriginChip } from "./shell";
 import "./mergeGraph.css";
@@ -447,12 +448,16 @@
 export const STRIP_SPAN_MS = 30 * 60_000;
 
 /**
- * The status home's merge-train strip: header, the last 30 minutes of the graph, and the way to the queue page.
+ * The home's MERGE TREE panel (dashboard redesign §3.2 item 3): the last 30 minutes of the graph (always drawn, the demo's
+ * talking point), the newest commit on main, and a CARS sub-section with the current train ("No cars in line" when empty).
  * "N landed" counts landings inside the same 30-minute window the graph draws (not the session's total).
  */
-export function MergeTrainStrip({ state, hive, now }: { state: State; hive: string; now?: number }) {
+export function MergeTreePanel({ state, hive, now }: { state: State; hive: string; now?: number }) {
+  const rail = useMemo(() => queueRail(state), [state]);
+  const bisected = useMemo(() => new Set(recentBisects(state, 5).map((b) => b.trainId)), [state]);
+  const main = rail.main;
   return (
-    <section className="mq" aria-label="Merge train">
+    <section className="panel mtree" aria-label="Merge tree">
       <MergeGraph
         state={state}
         hive={hive}
@@ -460,12 +465,35 @@
         density="compact"
         now={now}
         head={(l) => (
-          <div className="mq__head">
-            <h3 className="eyebrow">MERGE TRAIN · LAST 30 MIN</h3>
+          <div className="mtree__head">
+            <h3 className="eyebrow">MERGE TREE</h3>
+            {main && <code key={main.sha} className="mtree__landed" title={`train ${main.trainId}`}>main ← {main.sha.slice(0, 7)}</code>}
             <Link to={hrefFor.queue(hive)} className="mq__meta">{l.landedInWindow} landed in 30 min · queue page ▸</Link>
           </div>
         )}
       />
+      <div className="mtree__cars" aria-label="Cars">
+        <p className="eyebrow">CARS</p>
+        {rail.cars.length === 0 ? (
+          <p className="mtree__empty sh-muted">No cars in line</p>
+        ) : (
+          <ul className="mtree__list">
+            {rail.cars.map((c) => (
+              <li key={c.train.trainId} className={`mtree__car mtree__car--${c.phase.toLowerCase()}${bisected.has(c.train.trainId) ? " mtree__car--bisect" : ""}`}>
+                <b className="mtree__car-label">{c.label}</b>
+                <span className="chip chip--sm mtree__phase">{c.phase.toLowerCase()}</span>
+                <span className="mtree__members">
+                  {c.members.map((m) => {
+                    const t = state.trains[m.trainId];
+                    const who = t ? whoOf(t).who : m.title;
+                    return m.itemId ? <Link key={m.trainId} to={hrefFor.item(hive, m.itemId)} title={m.title}>{who}</Link> : <span key={m.trainId} title={m.title}>{who}</span>;
+                  })}
+                </span>
+              </li>
+            ))}
+          </ul>
+        )}
+      </div>
     </section>
   );
 }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/mergetree.test.tsx test/mergeGraph.test.ts test/swarmui.test.tsx`
Expected: PASS.

- [ ] **Step 5: Package checks**

Run: `pnpm --filter @queenos/dashboard test && pnpm --filter @queenos/dashboard typecheck && pnpm --filter @queenos/dashboard lint`.
Expected: tests pass. Until Task 3 lands, typecheck reports `MergeTrainStrip` missing in `StatusHome.tsx`: expected.

- [ ] **Step 6: Coordinator commits** (after the wave lands and the full gate passes)

```bash
git add apps/dashboard/src/MergeGraph.tsx apps/dashboard/test/mergetree.test.tsx
git commit -m "$(cat <<'MSG'
feat(dashboard): merge tree panel with a cars sub-section

Queen-Origin: agent:claude-code
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 5: U5 remove the lanes page, route items to the goal page, Model Board to Metrics

**Files:**
- Modify: `apps/dashboard/src/route.ts` (no `"lanes"` page, `redirectTo`, no `hrefFor.lanes`)
- Modify: `apps/dashboard/src/App.tsx` (redirect effect, `GoalPage` for items, no `WarRoom` / `ItemView`)
- Modify: `apps/dashboard/src/shell.tsx` (`HiveFooter` drops lanes and models)
- Modify: `apps/dashboard/src/Metrics.tsx` (Model Board)
- Modify (rewrite): `apps/dashboard/src/components.tsx` (ruling R2), `apps/dashboard/src/lanes.ts` (ruling R1)
- Delete: `apps/dashboard/src/WarRoom.tsx`, `apps/dashboard/src/ItemView.tsx`
- Modify: `apps/dashboard/test/route.test.ts`; Modify (rewrite): `apps/dashboard/test/lanes.test.ts`
- Create: `apps/dashboard/test/metrics-models.test.tsx`

**Interfaces:**
- Consumes (Task 1): `useRoom` from `./room`. Consumes (Task 2, in flight): `GoalPage({ hive, itemId, state })` from `./GoalPage`.
- Produces: `HivePage = "status" | "queue" | "item" | "trace" | "events" | "metrics" | "push"`; `Route` `warroom` variant gains `redirectTo?: string`; `matchRoute("/p/<h>/lanes")` → `{ name: "warroom", hive: h, page: "status", redirectTo: "/p/<h>" }`; `hrefFor.lanes` deleted. `components.tsx` keeps `useNow`, `MemoryRecall`, `TierBadge`, `ModelChip`, `floorLine`, `ModelBoard`; `lanes.ts` keeps `relativeTime` only.
- **Class names emitted:** `metrics-models` (the Model Board section, `id="models"`); the board keeps its existing `models`, `side-section`, `mtier`, `mrow*` classes.

- [ ] **Step 1: Write the failing tests**

`apps/dashboard/test/route.test.ts`:

```diff
--- a/apps/dashboard/test/route.test.ts
+++ b/apps/dashboard/test/route.test.ts
@@ -40,7 +40,6 @@
 const TRACE = "4e1f9a00112233445566778899aabbcc";
 
 test("matches the v2 hive pages", () => {
-  expect(matchRoute("/p/demo/lanes")).toEqual({ name: "warroom", hive: "demo", page: "lanes" });
   expect(matchRoute("/p/demo/queue")).toEqual({ name: "warroom", hive: "demo", page: "queue" });
   expect(matchRoute("/p/demo/events")).toEqual({ name: "warroom", hive: "demo", page: "events" });
   expect(matchRoute("/p/demo/metrics")).toEqual({ name: "warroom", hive: "demo", page: "metrics" });
@@ -58,7 +57,6 @@
 });
 
 test("hrefFor round-trips the v2 pages", () => {
-  expect(matchRoute(hrefFor.lanes("h"))).toEqual({ name: "warroom", hive: "h", page: "lanes" });
   expect(matchRoute(hrefFor.queue("h"))).toEqual({ name: "warroom", hive: "h", page: "queue" });
   expect(matchRoute(hrefFor.events("h"))).toEqual({ name: "warroom", hive: "h", page: "events" });
   expect(matchRoute(hrefFor.metrics("h"))).toEqual({ name: "warroom", hive: "h", page: "metrics" });
@@ -67,3 +65,13 @@
   expect(matchRoute(hrefFor.trace("h", TRACE))).toEqual({ name: "warroom", hive: "h", page: "trace", id: TRACE });
   expect(hrefFor.status("h")).toBe(hrefFor.warroom("h"));
 });
+
+test("the lanes page is gone: /lanes renders home and redirects to it", () => {
+  expect(matchRoute("/p/demo/lanes")).toEqual({ name: "warroom", hive: "demo", page: "status", redirectTo: "/p/demo" });
+  expect(matchRoute("/p/demo/lanes/x").name).toBe("notfound");
+  expect("lanes" in hrefFor).toBe(false);
+});
+
+test("a child item id routes to the goal page with that id (GoalPage resolves the root)", () => {
+  expect(matchRoute(hrefFor.item("demo", "g1-c2"))).toEqual({ name: "warroom", hive: "demo", page: "item", id: "g1-c2" });
+});
```

Rewrite `apps/dashboard/test/lanes.test.ts` (only `relativeTime` stays):

```ts
import { expect, test } from "vitest";
import { relativeTime } from "../src/lanes";

test("relativeTime buckets", () => {
  const now = 10_000_000;
  expect(relativeTime(now - 3000, now)).toBe("just now");
  expect(relativeTime(now - 30_000, now)).toBe("30s ago");
  expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
  expect(relativeTime(now - 3 * 3600_000, now)).toBe("3h ago");
  expect(relativeTime(now - 50 * 3600_000, now)).toBe("2d ago");
  expect(relativeTime(now + 5000, now)).toBe("just now");
});
```

Create `apps/dashboard/test/metrics-models.test.tsx`:

```tsx
/** Dashboard redesign U5: the Model Board moved from the lanes page to Metrics (spec §3.6). */
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type { HiveStatus } from "@queenos/queen-types";

import { Metrics } from "../src/Metrics";
import { initialState } from "../src/reducer";
import { HiveFooter } from "../src/shell";

test("Metrics shows the Model Board on swarm hives, not on external ones", () => {
  expect(renderToString(<Metrics hive="h" state={initialState} />)).toContain("MODEL BOARD");
  const external = { ...initialState, hive: { settings: { executors: "external" } } as unknown as HiveStatus };
  expect(renderToString(<Metrics hive="h" state={external} />)).not.toContain("MODEL BOARD");
});

test("the footer drops the lanes and models links", () => {
  const html = renderToString(<HiveFooter hive="h" />);
  expect(html).not.toContain("lanes");
  expect(html).not.toContain("models");
  expect(html).toContain("metrics ▸");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run test/route.test.ts test/metrics-models.test.tsx`
Expected: FAIL: `/p/demo/lanes` still matches page `lanes`; Metrics has no MODEL BOARD; the footer still links lanes.

- [ ] **Step 3: `src/route.ts`**

```diff
--- a/apps/dashboard/src/route.ts
+++ b/apps/dashboard/src/route.ts
@@ -1,19 +1,18 @@
 /** Pure client-side route matching (no React, no DOM; unit-tested). */
 
 /** Hive-scoped pages (v2 design §5). */
-export type HivePage = "status" | "lanes" | "queue" | "item" | "trace" | "events" | "metrics" | "push";
+export type HivePage = "status" | "queue" | "item" | "trace" | "events" | "metrics" | "push";
 
 export type Route =
   | { name: "home" }
   | { name: "new" }
   | { name: "setup"; hive: string }
   /**
-   * Every hive-scoped page. `page` picks the view: `/p/:hive` is the status
-   * home ("status"), `/p/:hive/lanes` is today's War Room ("lanes"). `id` is the
-   * item id or trace id for "item" and "trace". Until the v2 UI lands, App
-   * renders the War Room for all of them.
+   * Every hive-scoped page. `page` picks the view: `/p/:hive` is the status home ("status"), `/p/:hive/items/:id` the
+   * goal page ("item"). `id` is the item id or trace id for "item" and "trace". `redirectTo`: the removed lanes page
+   * (`/p/:hive/lanes`) renders home and App replaces the URL with it.
    */
-  | { name: "warroom"; hive: string; page: HivePage; id?: string; legacy?: boolean }
+  | { name: "warroom"; hive: string; page: HivePage; id?: string; legacy?: boolean; redirectTo?: string }
   | { name: "notfound"; path: string };
 
 const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
@@ -29,7 +28,7 @@
   return SEGMENT.test(s) ? s : null;
 }
 
-const SIMPLE_PAGES: Record<string, HivePage> = { lanes: "lanes", queue: "queue", events: "events", metrics: "metrics", push: "push" };
+const SIMPLE_PAGES: Record<string, HivePage> = { queue: "queue", events: "events", metrics: "metrics", push: "push" };
 
 /**
  * Match a location to a route. `/?hive=x` keeps working (it maps to the status
@@ -50,6 +49,7 @@
       const sub = parts[2]!;
       if (parts.length === 3) {
         if (sub === "setup") return { name: "setup", hive };
+        if (sub === "lanes") return { name: "warroom", hive, page: "status", redirectTo: hv(hive) };
         const page = SIMPLE_PAGES[sub];
         if (page) return { name: "warroom", hive, page };
       } else if (sub === "items") {
@@ -73,7 +73,6 @@
   /** The hive's landing page: the status home. */
   warroom: (hive: string) => hv(hive),
   status: (hive: string) => hv(hive),
-  lanes: (hive: string) => `${hv(hive)}/lanes`,
   queue: (hive: string) => `${hv(hive)}/queue`,
   item: (hive: string, itemId: string) => `${hv(hive)}/items/${encodeURIComponent(itemId)}`,
   trace: (hive: string, traceId: string) => `${hv(hive)}/traces/${encodeURIComponent(traceId)}`,
```

- [ ] **Step 4: `src/App.tsx`**

```diff
--- a/apps/dashboard/src/App.tsx
+++ b/apps/dashboard/src/App.tsx
@@ -1,16 +1,16 @@
+import { useEffect } from "react";
 import { Home } from "./Home";
 import { NewProject } from "./NewProject";
 import { Wizard } from "./Wizard";
-import { WarRoom } from "./WarRoom";
 import { useRoom } from "./room";
 import { StatusHome } from "./StatusHome";
-import { ItemView } from "./ItemView";
+import { GoalPage } from "./GoalPage";
 import { QueuePage } from "./QueuePage";
 import { TraceView } from "./TraceView";
 import { EventLog } from "./EventLog";
 import { Metrics } from "./Metrics";
 import { PushCode } from "./PushCode";
-import { Link, useRoute } from "./router";
+import { Link, navigate, useRoute } from "./router";
 import { hrefFor, type Route } from "./route";
 import { isSimulation } from "./homeLogic";
 import { HiveFooter, HiveHeader, Shell } from "./shell";
@@ -23,11 +23,14 @@
   const room = useRoom(hive);
   const { state, status, latencyMs } = room;
   const id = route.id ?? "";
+  // The lanes page is gone: /p/<hive>/lanes renders home and swaps the URL.
+  useEffect(() => {
+    if (route.redirectTo) navigate(route.redirectTo, { replace: true });
+  }, [route.redirectTo]);
   if (page === "status") return <StatusHome hive={hive} room={room} />;
-  if (page === "lanes") return <WarRoom hive={hive} room={room} backTo={hrefFor.status(hive)} />;
   const crumbs: Record<string, { label: string }[]> = {
     queue: [{ label: "queue" }],
-    item: [{ label: "item" }, { label: id }],
+    item: [{ label: "goal" }],
     trace: [{ label: "trace" }, { label: id.slice(0, 8) }],
     events: [{ label: "events" }],
     metrics: [{ label: "metrics" }],
@@ -43,7 +46,7 @@
       )}
       <HiveHeader hive={hive} crumbs={crumbs[page]} status={status} latencyMs={latencyMs} sim={isSimulation(state.hive)} />
       {page === "queue" && <QueuePage hive={hive} state={state} />}
-      {page === "item" && <ItemView hive={hive} itemId={id} state={state} />}
+      {page === "item" && <GoalPage hive={hive} itemId={id} state={state} />}
       {page === "trace" && <TraceView hive={hive} traceId={id} state={state} />}
       {page === "events" && <EventLog hive={hive} state={state} />}
       {page === "metrics" && <Metrics hive={hive} state={state} />}
```

- [ ] **Step 5: Footer and Metrics**

`src/shell.tsx`:

```diff
--- a/apps/dashboard/src/shell.tsx
+++ b/apps/dashboard/src/shell.tsx
@@ -135,12 +135,10 @@
   return (
     <footer className="hf">
       <Link to={hrefFor.status(hive)}>status ▸</Link>
-      <Link to={hrefFor.lanes(hive)}>lanes ▸</Link>
       <Link to={hrefFor.queue(hive)}>queue ▸</Link>
       <Link to={hrefFor.events(hive)}>events ▸</Link>
       <Link to={hrefFor.metrics(hive)}>metrics ▸</Link>
       <Link to={hrefFor.push(hive)}>push code ▸</Link>
-      <Link to={`${hrefFor.lanes(hive)}#models`}>models ▸</Link>
     </footer>
   );
 }
```

`src/Metrics.tsx`:

```diff
--- a/apps/dashboard/src/Metrics.tsx
+++ b/apps/dashboard/src/Metrics.tsx
@@ -1,6 +1,8 @@
 import { useEffect, useRef, useState } from "react";
 import type { HiveStatus, HourlyMetric, QueenEvent } from "@queenos/queen-types";
 import { api, type MetricsView, type MetricsWindow } from "./api";
+import { ModelBoard } from "./components";
+import { isExternal } from "./homeLogic";
 import { ErrorNotice } from "./shell";
 import { useResource } from "./hooks";
 import { fmtDuration } from "./TraceView";
@@ -453,6 +455,11 @@
       <ErrorNotice error={res.error} onRetry={res.reload} />
       {!res.data && !res.error && <p className="obs__empty">Loading metrics…</p>}
       {res.data && <MetricsBoard data={res.data} window={win} events={state.events} now={now} />}
+      {!isExternal(state.hive) && (
+        <section className="metrics-models" id="models" aria-label="Model board">
+          <ModelBoard stats={state.modelStats} floor={state.routerFloor} />
+        </section>
+      )}
     </div>
   );
 }
```

- [ ] **Step 6: Delete the lanes page and its helpers**

```bash
git rm apps/dashboard/src/WarRoom.tsx apps/dashboard/src/ItemView.tsx
```

Rewrite `apps/dashboard/src/lanes.ts`:

```ts
/** Relative time for the dashboard. Pure; no React. (The War Room lane grouping that also lived here was removed with the lanes page.) */

/** "just now", "5m ago", "3h ago", "2d ago". */
export function relativeTime(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
```

Replace `apps/dashboard/src/components.tsx` with the file below: the kept declarations of ruling R2, verbatim from the current file, under a new import block; everything else is deleted.

```tsx
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ModelStats, ModelTier, RecalledMemory, RouterFloor } from "@queenos/queen-types";
import { usePersistedBool } from "./hooks";
import { OUTCOME_META, memoryChipLabel, scorePercent } from "./memory";
import { TIER_META, tierRank, buildModelBoard, formatDuration, modelLabel, tierClass, tierOf, type TierGroup } from "./models";

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** "🧠 N memories recalled" chip that expands into the hive memories fed to the builder. */
export function MemoryRecall({ memories }: { memories: RecalledMemory[] }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<Record<string, boolean>>({});
  if (memories.length === 0) return null;
  return (
    <div className="memories">
      <button type="button" className="memories__chip" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">🧠</span> {memoryChipLabel(memories.length)} <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <ul className="memories__list">
          {memories.map((m) => {
            const meta = OUTCOME_META[m.outcome];
            const expanded = !!full[m.memoryId];
            return (
              <li key={m.memoryId} className={`memory memory--${meta.cls}`}>
                <div className="memory__top">
                  <span className={`chip memory__outcome memory__outcome--${meta.cls}`}>{meta.label}</span>
                  <span className="memory__score" title="cosine similarity to this prompt">
                    {scorePercent(m.score)}% match
                  </span>
                </div>
                <p className="memory__prompt">{m.promptText}</p>
                <p className={`memory__text${expanded ? "" : " memory__text--clamp"}`}>{m.text}</p>
                <button type="button" className="memory__more" onClick={() => setFull((f) => ({ ...f, [m.memoryId]: !expanded }))}>
                  {expanded ? "show less" : "show more"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function TierBadge({ tier }: { tier: ModelTier }) {
  return (
    <span className={tierClass(tier)} title={TIER_META[tier].hint}>
      {TIER_META[tier].label}
    </span>
  );
}

/** The router's pick for a train: model label, tier badge and (secondary line) why. */
export function ModelChip({ model, reason, escalated }: { model: string; reason?: string | null; escalated?: boolean }) {
  const tier = tierOf(model);
  return (
    <div className={`mchip${tier ? ` mchip--${tier}` : ""}${escalated ? " mchip--escalated" : ""}`} title={reason ? `${model}\n${reason}` : model}>
      <div className="mchip__row">
        <span className="mchip__name">{modelLabel(model)}</span>
        {tier && <TierBadge tier={tier} />}
        {escalated && <span className="mchip__esc">▲ ESCALATED</span>}
      </div>
      {reason && <div className="mchip__reason">{reason}</div>}
    </div>
  );
}

/** A collapsible right-sidebar panel: sticky header, body scrolls on its own when space runs out. */
function SideSection(props: { className: string; label: string; title: string; count?: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className={`${props.className} side-section panel${props.open ? "" : " side-section--closed"}`} aria-label={props.label}>
      <button type="button" className="side-section__toggle" aria-expanded={props.open} onClick={props.onToggle}>
        <span className="eyebrow">{props.title}</span>
        {props.count && <span className="side-section__count">{props.count}</span>}
        <span className="side-section__caret" aria-hidden>
          {props.open ? "▾" : "▸"}
        </span>
      </button>
      {props.open && <div className="side-section__body">{props.children}</div>}
    </section>
  );
}


// ── model board ───────────────────────────────────────────────────────────

export function floorLine(f: RouterFloor): string {
  // probeIn is null exactly when the floor is already at the lowest builder tier: nothing to back off to.
  if (f.probeIn === null) return "at the lowest tier";
  return `${f.streak}/${f.backoffAfter} clean builds to back off · probe in ${f.probeIn}`;
}

/** Compact router floor line; flashes red when raised, green when backed off. */
function FloorLine({ floor }: { floor: RouterFloor }) {
  const prev = useRef(floor.tier);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (prev.current === floor.tier) return;
    setFlash(tierRank(floor.tier) > tierRank(prev.current) ? "up" : "down");
    prev.current = floor.tier;
    const t = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(t);
  }, [floor.tier]);
  return (
    <p className={`models__floor${flash ? ` models__floor--${flash}` : ""}`} title="Cheapest tier the Queen will route builds to right now">
      <span>Floor:</span> <TierBadge tier={floor.tier} /> <span className="models__floor-text">{floorLine(floor)}</span>
    </p>
  );
}

export function ModelBoard({ stats, floor }: { stats: ModelStats[]; floor?: RouterFloor | null }) {
  const [open, setOpen] = usePersistedBool("queenos.side.models", true);
  const groups: TierGroup[] = buildModelBoard(stats);
  const tried = groups.reduce((n, g) => n + g.rows.filter((r) => !r.untried).length, 0);
  return (
    <SideSection className="models" label="model board" title="MODEL BOARD" count={`${tried} in play`} open={open} onToggle={() => setOpen((o) => !o)}>
      <p className="models__tag">Queen routes each build to the best model on AI Gateway</p>
      {floor && <FloorLine floor={floor} />}
      {groups.map((g) => (
        <div className="mtier" key={g.tier}>
            <div className="mtier__head">
              <TierBadge tier={g.tier} />
              <span>{TIER_META[g.tier].hint}</span>
            </div>
            <ul>
              {g.rows.map((r) => (
                <li key={r.model.id} className={`mrow${r.untried ? " mrow--untried" : ""}${r.leader ? " mrow--leader" : ""}`} title={r.model.id}>
                  <span className="mrow__name">
                    {r.leader && (
                      <b className="mrow__crown" title="Leading its tier">
                        ★
                      </b>
                    )}
                    {r.model.label}
                  </span>
                  {r.untried ? (
                    <span className="mrow__untried">untried</span>
                  ) : (
                    <>
                      <span
                        className="mrow__bar"
                        role="meter"
                        aria-label={`${r.model.label} pass rate`}
                        aria-valuemin={0}
                        aria-valuemax={r.attempts}
                        aria-valuenow={r.passes}
                      >
                        <i style={{ width: `${Math.round((r.passRate ?? 0) * 100)}%` }} />
                      </span>
                      <span className="mrow__pct">{Math.round((r.passRate ?? 0) * 100)}%</span>
                      <span className="mrow__n" title="passes / attempts">
                        {r.passes}/{r.attempts}
                      </span>
                      <span className="mrow__ms" title="average build time">
                        {formatDuration(r.avgBuildMs)}
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
      ))}
    </SideSection>
  );
}
```

Then confirm nothing still imports a deleted name:

```bash
/usr/bin/grep -rnE "WarRoom|ItemView|groupLanes|earlierSummary|newestFirst|isFinishedLane|RECENT_LANES|hrefFor\.lanes|\b(TopBar|MainTrack|LedgerPanel|ReleaseTimeline|CanaryBar|ShippedBanner|Ticker|Sites)\b" src test
```

Expected: no output (Task 3 removes the `hrefFor.lanes` in `HomePanels.tsx`; if Task 3 has not landed yet, that one line is the only hit).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/route.test.ts test/lanes.test.ts test/metrics-models.test.tsx test/obs.test.tsx test/models.test.ts test/reducer.test.ts`
Expected: PASS.

- [ ] **Step 8: Package checks**

Run: `pnpm --filter @queenos/dashboard test && pnpm --filter @queenos/dashboard typecheck && pnpm --filter @queenos/dashboard lint`, then the test typecheck.
Expected: tests pass. Until Tasks 2 and 3 land, typecheck reports `./GoalPage` missing (App.tsx) and `hrefFor.lanes` (HomePanels.tsx): expected.

- [ ] **Step 9: Coordinator commits** (after the wave lands and the full gate passes)

```bash
git add apps/dashboard/src/route.ts apps/dashboard/src/App.tsx apps/dashboard/src/shell.tsx apps/dashboard/src/Metrics.tsx apps/dashboard/src/components.tsx apps/dashboard/src/lanes.ts apps/dashboard/test/route.test.ts apps/dashboard/test/lanes.test.ts apps/dashboard/test/metrics-models.test.tsx
git add -u apps/dashboard/src/WarRoom.tsx apps/dashboard/src/ItemView.tsx
git commit -m "$(cat <<'MSG'
refactor(dashboard): remove the lanes page, items open the goal page, Model Board on Metrics

Queen-Origin: agent:claude-code
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

**Coordinator after the wave (Tasks 2 to 5):** from `apps/dashboard`, `pnpm --filter @queenos/dashboard test && pnpm --filter @queenos/dashboard typecheck && pnpm --filter @queenos/dashboard lint && pnpm --filter @queenos/dashboard build` (expect 20 test files, 276 tests), the test typecheck, then the full gate from the root. Commit Tasks 2, 3, 4, 5 in that order.

---

### Task 6: U6 visual treatment (`styles.css`)

**Files:**
- Modify: `apps/dashboard/src/styles.css` (drop the two `.rp__frame` rules; append one section at the end)

**Interfaces:**
- Consumes: every class name listed in the Produces blocks of Tasks 1 to 5, and the existing vocabulary in `styles.css`: tokens `--cyan --green --yellow --red --violet --panel --panel-2 --bg-2 --line --line-2 --dim --faint --mono`; keyframes `pulse`, `slide-in`, `land`, `shake`, `ring`, `glow-yellow`, `flash-green`, `flash-red`, `shimmer`, `crown`, `step-pulse`; `.btn--launch`, `.btn--ship`, `.sh-head`.
- Produces: styles only. New keyframe `celebrate-out`.

- [ ] **Step 1: Check every emitted class has a rule**

After the wave, list the class names the new markup uses and the ones the new section styles:

```bash
/usr/bin/grep -ohE 'className=\{?[`"][^`"]*' src/GoalPage.tsx src/RaceCard.tsx src/HomePanels.tsx src/StatusHome.tsx src/MergeGraph.tsx src/RacePick.tsx src/Metrics.tsx src/raceStatus.ts | tr ' `"{}$' '\n' | /usr/bin/grep -E '^(race-chip|cand|gp|rc|needs|goal|atile|mtree|health|skel|bee|home-|sh-hero|celebrate|btn--launch-sm)' | sort -u
```

Expected after Step 2: each of these has a selector in the new section (modifiers built from a variable, like `rc--${tone}`, are covered by the per-value rules below).

- [ ] **Step 2: Append the section and drop the iframe rules**

```diff
--- a/apps/dashboard/src/styles.css
+++ b/apps/dashboard/src/styles.css
@@ -803,8 +803,6 @@
 .rp__card--out { opacity: 0.6; }
 .rp__head { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
 .rp__rec, .rp__won { color: var(--green); border-color: rgba(53, 242, 160, 0.5); }
-.rp__frame { display: none; width: 100%; height: 220px; border: 1px solid var(--line-2); border-radius: 8px; background: #fff; }
-@media (min-width: 900px) { .rp__frame { display: block; } }
 .rp__link { align-self: flex-start; }
 .rp__stats { margin: 0; display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
 .rp__stats > div { display: flex; gap: 8px; }
@@ -813,3 +811,153 @@
 .rp__notes { margin: 0; font-size: 13px; }
 .rp__confirm { display: flex; flex-wrap: wrap; gap: 6px; }
 .rp__confirm input { flex: 1 1 160px; min-width: 0; font: 14px var(--mono); color: var(--text); background: var(--panel); border: 1px solid var(--line-2); border-radius: 8px; padding: 8px 10px; min-height: 40px; }
+
+/* ── Dashboard redesign (spec 2026-10-14 §5): goal page, home, race-true chips ──
+   Motion only marks a state change or something waiting on the human; the you-pick gold pulse is the one steady one. */
+.race-chip, .cand-chip { display: inline-flex; align-items: center; gap: 6px; font: 700 12px var(--mono); letter-spacing: 0.04em; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--line-2); color: var(--dim); white-space: nowrap; }
+.race-chip--cyan, .cand-chip--gating, .cand-chip--building { color: var(--cyan); border-color: rgba(60, 217, 255, 0.5); background: rgba(60, 217, 255, 0.08); }
+.race-chip--gold, .cand-chip--won { color: var(--yellow); border-color: rgba(255, 210, 63, 0.6); background: rgba(255, 210, 63, 0.1); }
+.race-chip--violet, .cand-chip--reworking { color: var(--violet); border-color: rgba(167, 139, 250, 0.55); background: rgba(167, 139, 250, 0.1); }
+.race-chip--green, .cand-chip--passed { color: var(--green); border-color: rgba(53, 242, 160, 0.5); background: rgba(53, 242, 160, 0.08); }
+.race-chip--red, .cand-chip--failed { color: var(--red); border-color: rgba(255, 77, 99, 0.5); background: rgba(255, 77, 99, 0.08); white-space: normal; }
+.race-chip--muted, .cand-chip--lost { color: var(--dim); }
+.race-chip--pulse { animation: glow-yellow 1.6s infinite; }
+
+/* hero headline, tinted by hive mood */
+.sh-hero { background: linear-gradient(110deg, var(--hero, rgba(60, 217, 255, 0.12)), transparent 70%), var(--panel); }
+.sh-hero--calm { --hero: rgba(53, 242, 160, 0.1); color: var(--green); border-color: rgba(53, 242, 160, 0.4); }
+.sh-hero--racing { --hero: rgba(60, 217, 255, 0.16); color: var(--cyan); border-color: rgba(60, 217, 255, 0.45); }
+.sh-hero--needs-you { --hero: rgba(255, 210, 63, 0.18); color: var(--yellow); border-color: rgba(255, 210, 63, 0.6); }
+.sh-hero--degraded { --hero: rgba(255, 77, 99, 0.16); color: var(--red); border-color: rgba(255, 77, 99, 0.55); }
+.sh-hero--needs-you .sh-hero__dot { animation: pulse 1.4s infinite; }
+
+/* home: ADD A GOAL | NEEDS YOU */
+.home-top { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; align-items: start; }
+.home-composer { display: flex; flex-direction: column; gap: 10px; }
+.home-composer input, .home-composer textarea { width: 100%; font: 14px var(--mono); color: var(--text); background: var(--bg-2); border: 1px solid var(--line-2); border-radius: 8px; padding: 10px 12px; }
+.home-composer input:focus, .home-composer textarea:focus { outline: 1px solid var(--cyan); border-color: var(--cyan); }
+.home-composer__row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
+.home-composer__judge { display: flex; gap: 12px; border: 0; margin: 0; padding: 0; font: 13px var(--mono); color: var(--dim); }
+.home-composer__judge legend { float: left; margin-right: 8px; }
+.btn--launch-sm { align-self: auto; padding: 10px 22px; font-size: 15px; letter-spacing: 0.08em; border-radius: 10px; }
+.needs { display: flex; flex-direction: column; gap: 10px; border-color: var(--line); }
+.needs--pending { border-color: rgba(255, 210, 63, 0.7); animation: glow-yellow 1.8s infinite; }
+.needs__list { display: flex; flex-direction: column; gap: 12px; }
+.needs__race { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 10px; background: linear-gradient(120deg, rgba(255, 210, 63, 0.08), transparent 60%), var(--panel-2); border: 1px solid rgba(255, 210, 63, 0.35); }
+.needs__race-head { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-weight: 700; }
+.needs__rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
+.needs__row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font: 13px var(--mono); }
+.needs__empty { display: flex; align-items: center; gap: 16px; padding: 10px 4px; color: var(--dim); }
+.needs__empty p { margin: 0; }
+.bee { margin: 0; font: 700 14px/1.2 var(--mono); color: var(--yellow); text-shadow: 0 0 14px rgba(255, 210, 63, 0.45); }
+
+/* shared candidate rows (race cards, Needs you) */
+.cand { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 8px 10px; border-radius: 8px; background: var(--bg-2); border: 1px solid var(--line); font: 13px var(--mono); }
+.cand__who { font-weight: 700; color: var(--text); }
+.cand__preview { margin-left: auto; }
+.cand__actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
+.cand__actions--compact .btn { padding: 6px 12px; font-size: 13px; }
+.cand__pick { box-shadow: 0 0 18px rgba(255, 210, 63, 0.35); }
+.cand--won { border-color: rgba(255, 210, 63, 0.6); }
+.cand--lost { opacity: 0.6; }
+
+/* goal list rows: projects-home card language with a state-colored edge */
+.goals__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
+.goal-row { --edge: var(--faint); --wash: transparent; position: relative; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 12px 16px; border-radius: 12px; border: 1px solid var(--line); border-left: 4px solid var(--edge); background: linear-gradient(100deg, var(--wash), transparent 55%), var(--panel-2); transition: transform 0.25s, box-shadow 0.25s, border-color 0.25s; animation: slide-in 0.4s ease; }
+.goal-row:hover, .goal-row:focus-within { transform: translateY(-2px); box-shadow: 0 10px 32px rgba(0, 0, 0, 0.45); }
+.goal-row--cyan { --edge: var(--cyan); --wash: rgba(60, 217, 255, 0.08); }
+.goal-row--gold { --edge: var(--yellow); --wash: rgba(255, 210, 63, 0.12); animation: slide-in 0.4s ease, glow-yellow 1.8s infinite; }
+.goal-row--violet { --edge: var(--violet); --wash: rgba(167, 139, 250, 0.1); }
+.goal-row--green { --edge: var(--green); --wash: rgba(53, 242, 160, 0.07); }
+.goal-row--red { --edge: var(--red); --wash: rgba(255, 77, 99, 0.08); }
+.goal-row--done { opacity: 0.75; }
+.goal-row__main { flex: 1 1 320px; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; color: inherit; text-decoration: none; }
+.goal-row__title { font-weight: 700; font-size: 16px; overflow-wrap: anywhere; }
+.goal-row__summary { font: 12px var(--mono); }
+.goal-row__tiles { display: flex; flex-wrap: wrap; gap: 6px; }
+.goal-row--celebrate { animation: flash-green 1.2s; }
+.celebrate-banner { flex-basis: 100%; margin: 4px 0 0; display: flex; align-items: center; gap: 8px; font: 700 14px var(--mono); color: var(--green); animation: land 0.5s ease, celebrate-out 0.6s ease 6s forwards; }
+.celebrate-banner__crown { display: inline-block; color: var(--yellow); animation: crown 2.4s ease-in-out 2; }
+@keyframes celebrate-out { to { opacity: 0; height: 0; margin: 0; overflow: hidden; } }
+
+/* agent tiles: race-outlined per race, filled = passed, hollow = still working */
+.atiles { display: inline-flex; gap: 3px; padding: 3px; border: 1px dashed var(--violet); border-radius: 8px; background: rgba(167, 139, 250, 0.08); }
+.atiles--last-minute { position: relative; }
+.atiles--last-minute::after { content: ""; position: absolute; inset: -2px; border-radius: 9px; border: 1px solid var(--violet); animation: ring 1.2s infinite; pointer-events: none; }
+.atile { --c: var(--cyan); display: block; width: 18px; height: 18px; border-radius: 5px; border: 2px solid var(--c); background: transparent; }
+.atile--filled { background: var(--c); box-shadow: 0 0 10px var(--c); }
+.atile--passed { --c: var(--green); }
+.atile--won { --c: var(--yellow); }
+.atile--reworking { --c: var(--violet); }
+.atile--failed { --c: var(--red); }
+.atile--changed { animation: slide-in 0.45s ease-out both; }
+.atile--changed.atile--passed { animation: slide-in 0.45s ease-out both, flash-green 0.9s; }
+.atile--changed.atile--failed { animation: slide-in 0.45s ease-out both, flash-red 0.9s, shake 0.5s; }
+.atile--changed.atile--won { animation: crown 1.2s ease-in-out; }
+
+/* merge tree panel */
+.mtree { display: flex; flex-direction: column; gap: 10px; }
+.mtree__head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; }
+.mtree__head .eyebrow { margin: 0; }
+.mtree__landed { font: 700 13px var(--mono); color: var(--green); padding: 2px 8px; border-radius: 6px; border: 1px solid rgba(53, 242, 160, 0.4); animation: land 0.6s ease, flash-green 1s; }
+.mtree__cars { border-top: 1px solid var(--line); padding-top: 10px; }
+.mtree__list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
+.mtree__car { display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--line-2); background: var(--panel-2); font: 13px var(--mono); }
+.mtree__car-label { color: var(--violet); }
+.mtree__car--gating { border-color: rgba(60, 217, 255, 0.6); animation: step-pulse 1.6s infinite; }
+.mtree__car--landing, .mtree__car--passed { border-color: rgba(53, 242, 160, 0.55); }
+.mtree__car--bisect { border-color: rgba(255, 77, 99, 0.6); animation: shake 0.5s 2; }
+.mtree__members { display: inline-flex; flex-wrap: wrap; gap: 6px; }
+.mtree__empty { margin: 0; }
+
+/* hive health, collapsed at the bottom */
+.health > summary { cursor: pointer; display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; }
+.health > summary .eyebrow { margin: 0; }
+.health__body { display: flex; flex-direction: column; gap: 14px; margin-top: 14px; }
+
+/* goal page */
+.gp { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
+.gp__head { display: flex; flex-direction: column; gap: 10px; background: radial-gradient(700px 220px at 0 0, rgba(167, 139, 250, 0.12), transparent 70%), var(--panel); }
+.gp__crumbs { margin: 0; display: flex; flex-wrap: wrap; gap: 6px; color: var(--dim); font: 13px var(--mono); }
+.gp__trace { margin-left: auto; }
+.gp__title { margin: 0; font: 800 clamp(20px, 3.4vw, 28px)/1.2 var(--mono); overflow-wrap: anywhere; }
+.gp__body { margin: 0; white-space: pre-wrap; }
+.gp__chips { margin: 0; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
+.gp__acc { list-style: none; margin: 0; padding: 0; font: 13px var(--mono); }
+.gp__actions { display: flex; flex-wrap: wrap; gap: 8px; }
+.gp__cards { display: flex; flex-direction: column; gap: 14px; }
+.rc { --edge: var(--faint); display: flex; flex-direction: column; gap: 10px; border-left: 4px solid var(--edge); scroll-margin-top: 80px; }
+.rc--cyan { --edge: var(--cyan); }
+.rc--gold { --edge: var(--yellow); }
+.rc--violet { --edge: var(--violet); }
+.rc--green { --edge: var(--green); }
+.rc--red { --edge: var(--red); }
+.rc--highlight { box-shadow: 0 0 0 1px var(--edge), 0 0 28px rgba(60, 217, 255, 0.25); animation: flash-green 1.2s; }
+.rc__head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
+.rc__title { margin: 0; font-size: 17px; overflow-wrap: anywhere; }
+.rc__rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
+.rc__empty { margin: 0; }
+.rc__actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; }
+.rc__actions:empty { display: none; }
+.rc__details > summary { cursor: pointer; color: var(--dim); font: 13px var(--mono); }
+.rc__more { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; font-size: 14px; }
+.rc__history, .rc__events { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font: 13px var(--mono); }
+.rc__attempt--old { opacity: 0.6; }
+
+/* shimmer skeletons (instead of "Loading…") */
+.skel { border-radius: 10px; background: linear-gradient(100deg, var(--panel) 30%, var(--panel-2) 50%, var(--panel) 70%) 0 0 / 300% 100%; animation: shimmer 1.4s infinite linear; }
+.skel--card { min-height: 160px; }
+.skel--row { min-height: 52px; margin-bottom: 10px; }
+
+@media (max-width: 720px) {
+  .home-top { grid-template-columns: minmax(0, 1fr); }
+  .home-top .needs { order: -1; }
+  .cand__preview { margin-left: 0; }
+  .gp__trace { margin-left: 0; }
+}
+
+@media (prefers-reduced-motion: reduce) {
+  .race-chip--pulse, .needs--pending, .goal-row, .goal-row--gold, .goal-row--celebrate, .atile--changed, .atiles--last-minute::after,
+  .mtree__landed, .mtree__car--gating, .mtree__car--bisect, .rc--highlight, .skel, .sh-hero__dot, .celebrate-banner__crown { animation: none !important; }
+  .celebrate-banner { display: none; }
+}
```

- [ ] **Step 3: Build and look**

Run: `pnpm --filter @queenos/dashboard build && pnpm --filter @queenos/dashboard test && pnpm --filter @queenos/dashboard lint`
Expected: build succeeds (the existing chunk-size warning is fine), tests pass. Visual check is Task 7.

- [ ] **Step 4: Coordinator commits**

```bash
git add apps/dashboard/src/styles.css
git commit -m "$(cat <<'MSG'
style(dashboard): neon treatment for goal rows, race cards, Needs you and the merge tree

Queen-Origin: agent:claude-code
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 7: Full gate, sim check, handoff (coordinator)

**Files:**
- Modify: `docs/HANDOFF.md` (milestone entry)

- [ ] **Step 1: Full gate**

From the repo root: `pnpm turbo run build typecheck lint test --force --continue --concurrency=4`
Expected: `49 successful, 49 total`. Plus the dashboard test typecheck (only the pre-existing `release-strip.test.ts(82,41)` error).

- [ ] **Step 2: Start the sim on spare ports** (two background shells; note each PID; never `pkill`)

```bash
export PATH=~/.nvm/versions/node/v24.17.0/bin:$PATH
cd apps/queen && pnpm exec wrangler dev --env sim --port 8797 --inspector-port 9297
```

```bash
export PATH=~/.nvm/versions/node/v24.17.0/bin:$PATH
cd apps/dashboard && QUEEN_DEV_URL=http://localhost:8797 pnpm exec vite --port 5197 --strictPort
```

- [ ] **Step 3: You-pick race (swarm hive)**

Open `http://localhost:5197/p/redesign`. In ADD A GOAL file title `Rename morse key [you-pick]` with a one-line spec (the sim's `[you-pick]` marker, `apps/queen/src/sim/sim-v2.ts:27`, races it best-of-3 with a human judge). Check, in order:
- the hero reads "N races running" (cyan), then "… 1 waiting for your pick" (gold) once candidates pass;
- the goal row: race chip `racing …` then `you pick · m:ss left` with the gold pulse; agent tiles outlined per race, filled as candidates pass; summary like `2 passed`;
- NEEDS YOU glows gold and lists the race with `Pick` / `Reject` per passed candidate and `Reject all`; "preview ▸" links, no iframe;
- MERGE TREE always draws the graph; CARS says "No cars in line" until a car forms;
- open the goal: one race card per child, `passed · waiting for your pick` chips, Pick in the card works; after the pick the row reads `decided` then `landed` with the one-time celebration banner;
- `/p/redesign/items/<child id>` scrolls to and rings that card; `/p/redesign/lanes` lands on `/p/redesign`; the footer has no lanes or models link; Metrics shows the Model Board;
- HIVE HEALTH is collapsed at the bottom and holds the release strip, tiles, guardrails, throughput, blocked / failed and the swarm floor (with no pick panel inside).

- [ ] **Step 4: Rework demo (attempt races)**

```bash
curl -s -X POST "http://localhost:8797/sim/rework-demo?hive=redesign-rw" | jq '.log[-1]'
```

While it runs (it returns when done, up to about 5 minutes), watch `http://localhost:5197/p/redesign-rw`: a candidate chip `reworking · conflict · due in m:ss`, the race chip `reworking · due in m:ss` (violet), no preview link on the rejected head, then the same contributor's new head replacing it in one row (old head only under "details"), and finally `landed`. Expected log end: "LANDED as the same candidate".

- [ ] **Step 5: Phone width and reduced motion**

At 390 px wide: Needs you stacks above Add a goal, no horizontal scroll, race card rows wrap. With the OS "reduce motion" setting on: no pulses or flashes; colors stay.

- [ ] **Step 6: Stop the sim**

`kill <wrangler PID> <vite PID>` (only the PIDs from Step 2).

- [ ] **Step 7: Handoff entry**

Add a dated milestone line under HANDOFF §2 ("2026-10-14: dashboard redesign"): spec and plan paths, what changed (goal page, goal-first home, race-true labels, lanes page removed, Model Board on Metrics), the sim check result, and ruling R5 for the user to confirm.

- [ ] **Step 8: Coordinator commits**

```bash
git add docs/HANDOFF.md
git commit -m "$(cat <<'MSG'
docs(handoff): dashboard redesign landed

Queen-Origin: agent:claude-code
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

## Spec coverage (self-review)

| Spec | Where |
|---|---|
| §3.1 routes: `/lanes` redirect, `HivePage` / `SIMPLE_PAGES` / `hrefFor.lanes`, child id → root, loose item | Task 5 (route, App), Task 2 (`rootOf`, highlight, loose item test) |
| §3.2 home order, two-column row, phone stacking | Task 3 (`StatusHome`), Task 6 (`.home-top`, 720 px rule) |
| §3.3 composer: add goal only, judge on external, decompose on swarm, no demo buttons | Task 3 (`AddGoal`, `goalPrompt`) |
| §3.4 Needs you: escalations + PICKING with inline actions, bee empty state | Task 3 (`NeedsYou`, `Bee`), Task 1 (`pickingRows`, `CandidateActions`, `RejectAll`) |
| §3.5 agent tiles per goal, race outline, filled / hollow | Task 1 (`agentTiles`), Task 3 (`GoalRowView`), Task 6 |
| §3.6 lanes page removed, Model Board to Metrics, footer | Task 5 |
| §4.2 header incl. push command and item actions | Task 2 (`GoalPage`), Task 1 (`pushCommand`) |
| §4.3 race cards: chips, one head per contributor, verdict chips, preview links, Pick / Reject / Reject all / End entries now, details, release footer | Task 1 (`currentCandidates`, `candidateRows`, `candidateStatus`), Task 2 (`RaceCard`, `GoalPage`) |
| §4.4 labelling rule | Task 1 (sole source; "PICKING never yields building or TESTING" test) |
| §5 visuals 1 to 9 | Task 6; motion hooks: Task 1 (`trackFresh`, `raceChipClass` pulse), Task 3 (`atile--changed`, `goal-row--celebrate`), Task 4 (`mtree__landed`, `mtree__car--bisect`), skeletons in Tasks 2 and 3 |
| §7 tests: U1 exhaustive, route tests, render tests, bee, "No cars in line", mock read-only | Tasks 1 to 5; mock mode via the existing `MOCK` guard in `CandidateActions` / `RejectAll` / `RaceEntries` |
| §8 no backend | no task touches anything outside `apps/dashboard` (plus HANDOFF) |
| §10 open questions | rulings R1 to R5 |

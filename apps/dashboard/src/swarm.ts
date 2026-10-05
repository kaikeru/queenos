/**
 * Swarm selectors (v2 design §5.1): the floor of parallel BUILD trains, the
 * merge-queue rail, the waiting-to-board list, the conflict and bisect
 * stories, race views and an item's ACTIVE sub-state. Pure functions over the
 * reducer `State`; types only from queen-types.
 */
import type { MergeTrain, QueenEvent, Race, WorkItem } from "@queenos/queen-types";

import { tailOf, type State } from "./reducer";

type Slice = Pick<State, "trains" | "trainOrder" | "items" | "races" | "events" | "landed">;

/** Above this many tiles the floor collapses to per-phase bars. */
export const COLLAPSE_TILES_ABOVE = 120;

export const isBuildTrain = (t: MergeTrain): boolean => (t.lane ?? "BUILD") === "BUILD";
export const isQueueTrain = (t: MergeTrain): boolean => t.lane === "QUEUE";
const isLive = (t: MergeTrain): boolean => t.status !== "EJECTED" && t.status !== "MERGED";

/** The item a BUILD train builds (`prompt_id = item_id`). */
export const itemIdOf = (t: MergeTrain): string | undefined => tailOf(t);

// ── swarm floor ───────────────────────────────────────────────────────────

export type TileGroup = "waiting" | "building" | "deploying" | "gating" | "racing" | "queued" | "merging";
/** Display order, left to right. */
export const TILE_GROUPS: readonly TileGroup[] = ["waiting", "building", "deploying", "gating", "racing", "queued", "merging"];

export interface SwarmTile {
  trainId: string;
  itemId: string | null;
  /** Item title, falling back to the train id. */
  title: string;
  group: TileGroup;
  model: string | null;
  /** Epoch ms the train was created (the UI renders "build 1:12" from it). */
  startedAt: number;
  baseSha: string;
  raceId: string | null;
  candidate: number | null;
  /** A race candidate's standing, if any. */
  outcome: string | null;
  previewUrl: string | null;
}

export interface SwarmGroup {
  group: TileGroup;
  count: number;
  tiles: SwarmTile[];
}

export interface SwarmFloor {
  tiles: SwarmTile[];
  groups: SwarmGroup[];
  total: number;
  /** Distinct races still deciding. */
  races: number;
  /** Items READY but held by path affinity (or capacity): `waitReason` set. */
  waitingOnPaths: WorkItem[];
  /** True above COLLAPSE_TILES_ABOVE: draw `groups[].count` bars, not tiles. */
  collapsed: boolean;
}

function raceActive(state: Slice, t: MergeTrain): boolean {
  if (!t.raceId) return false;
  const race = state.races[t.raceId];
  if (race) return race.state === "RACING";
  return !t.raceOutcome || t.raceOutcome === "RACING" || t.raceOutcome === "PASSED";
}

export function tileGroup(state: Slice, t: MergeTrain): TileGroup {
  if (raceActive(state, t)) return "racing";
  if (t.carId) return "merging";
  switch (t.phase) {
    case "WAITING_PARENT":
      return "waiting";
    case "DEPLOYING":
      return "deploying";
    case "TESTING":
      return "gating";
    case "PASSED":
    case "LANDING":
      return "queued";
    default:
      return t.status === "TESTING" ? "gating" : "building";
  }
}

/** One tile per live BUILD train. */
export function swarmTiles(state: Slice): SwarmTile[] {
  const out: SwarmTile[] = [];
  for (const id of state.trainOrder) {
    const t = state.trains[id]!;
    if (!isBuildTrain(t) || !isLive(t)) continue;
    const itemId = itemIdOf(t) ?? null;
    out.push({
      trainId: t.trainId,
      itemId,
      title: (itemId && state.items[itemId]?.title) || t.trainId,
      group: tileGroup(state, t),
      model: t.model ?? null,
      startedAt: t.createdAt,
      baseSha: t.baseSha,
      raceId: t.raceId ?? null,
      candidate: t.candidate ?? null,
      outcome: t.raceOutcome ?? null,
      previewUrl: t.previewUrl ?? null,
    });
  }
  return out;
}

export function swarmFloor(state: Slice): SwarmFloor {
  const tiles = swarmTiles(state);
  const groups: SwarmGroup[] = TILE_GROUPS.map((group) => {
    const g = tiles.filter((t) => t.group === group);
    // Race candidates sit together, ordered by race then candidate.
    if (group === "racing") g.sort((a, b) => (a.raceId ?? "").localeCompare(b.raceId ?? "") || (a.candidate ?? 0) - (b.candidate ?? 0));
    return { group, count: g.length, tiles: g };
  });
  const waitingOnPaths = Object.values(state.items)
    .filter((i) => i.status === "READY" && !!i.waitReason)
    .sort((a, b) => a.createdAt - b.createdAt);
  return {
    tiles: groups.flatMap((g) => g.tiles),
    groups,
    total: tiles.length,
    races: new Set(tiles.filter((t) => t.group === "racing" && t.raceId).map((t) => t.raceId)).size,
    waitingOnPaths,
    collapsed: tiles.length > COLLAPSE_TILES_ABOVE,
  };
}

/** "building 12 · deploying 2 · gating 5 · racing 3 (1 race) · waiting on paths 1" */
export function floorSummary(floor: SwarmFloor): string {
  const parts: string[] = [];
  for (const g of floor.groups) {
    if (!g.count) continue;
    parts.push(g.group === "racing" ? `racing ${g.count} (${floor.races} ${floor.races === 1 ? "race" : "races"})` : `${g.group} ${g.count}`);
  }
  if (floor.waitingOnPaths.length) parts.push(`waiting on paths ${floor.waitingOnPaths.length}`);
  return parts.join(" · ");
}

// ── merge-queue rail ──────────────────────────────────────────────────────

export type CarPhase = "MERGING" | "GATING" | "PASSED" | "LANDING";

export interface CarMember {
  trainId: string;
  itemId: string | null;
  title: string;
}

export interface QueueCar {
  train: MergeTrain;
  /** 1-based position among every QUEUE-lane train, by creation: stable for a car's life. */
  seq: number;
  /** "K41". */
  label: string;
  phase: CarPhase;
  members: CarMember[];
  /** One member, gate skipped (`MergeResult.fastForward`): best-effort from the score. */
  fastForward: boolean;
}

export interface WaitingBuild {
  trainId: string;
  itemId: string | null;
  title: string;
  passedSeq: number | null;
}

export interface QueueRail {
  /** The newest landed commit on main, if any. */
  main: { sha: string; trainId: string } | null;
  /** Active cars, oldest (nearest main) first: render right to left, ending at main. */
  cars: QueueCar[];
  /** Passed BUILD trains not yet on a car, in boarding order. */
  waiting: WaitingBuild[];
}

function carPhase(t: MergeTrain): CarPhase {
  switch (t.phase) {
    case "LANDING":
      return "LANDING";
    case "PASSED":
      return "PASSED";
    case "DEPLOYING":
    case "TESTING":
      return "GATING";
    default:
      return t.status === "TESTING" ? "GATING" : "MERGING";
  }
}

const compareTrains = (a: MergeTrain, b: MergeTrain) => a.createdAt - b.createdAt || a.trainId.localeCompare(b.trainId);

function memberOf(state: Slice, trainId: string): CarMember {
  const t = state.trains[trainId];
  const itemId = t ? (itemIdOf(t) ?? null) : null;
  return { trainId, itemId, title: (itemId && state.items[itemId]?.title) || trainId };
}

export function waitingToBoard(state: Slice): WaitingBuild[] {
  return state.trainOrder
    .map((id) => state.trains[id]!)
    .filter((t) => isBuildTrain(t) && isLive(t) && t.phase === "PASSED" && !t.carId)
    .sort((a, b) => (a.passedSeq ?? Infinity) - (b.passedSeq ?? Infinity) || compareTrains(a, b))
    .map((t) => ({ ...memberOf(state, t.trainId), passedSeq: t.passedSeq ?? null }));
}

export function queueRail(state: Slice): QueueRail {
  const all = state.trainOrder.map((id) => state.trains[id]!).filter(isQueueTrain).sort(compareTrains);
  const cars: QueueCar[] = [];
  all.forEach((t, i) => {
    if (!isLive(t)) return;
    const members = (t.members ?? []).map((id) => memberOf(state, id));
    cars.push({
      train: t,
      seq: i + 1,
      label: `K${i + 1}`,
      phase: carPhase(t),
      members,
      fastForward: members.length === 1 && t.score?.checks === 0,
    });
  });
  const main = state.landed.at(-1);
  return { main: main ? { sha: main.sha, trainId: main.trainId } : null, cars, waiting: waitingToBoard(state) };
}

// ── conflicts and bisects ─────────────────────────────────────────────────

export interface QueueStory {
  key: string;
  kind: "conflict" | "bisect";
  ts: number;
  summary: string;
  itemId: string | null;
  /** The conflicting build (conflict) or the failed car (bisect). */
  trainId: string | null;
  traceId: string | null;
  /** Conflicting paths (conflicts only). */
  paths: string[];
  /** The event's raw `data`, for the car detail (compositions, halves). */
  data: Record<string, unknown> | null;
}

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function storyFromEvent(state: Slice, e: QueenEvent, kind: QueueStory["kind"]): QueueStory {
  const train = e.trainId ? state.trains[e.trainId] : undefined;
  return {
    key: e.eventId,
    kind,
    ts: e.ts,
    summary: e.summary,
    itemId: e.itemId ?? (train && isBuildTrain(train) ? (itemIdOf(train) ?? null) : null),
    trainId: e.trainId,
    traceId: e.traceId,
    paths: asStrings(e.data?.paths).length ? asStrings(e.data?.paths) : (train?.conflict?.paths ?? []),
    data: e.data,
  };
}

/** The last `n` conflicts, newest first: events first, then ejected BUILD trains that carry a `conflict`. */
export function recentConflicts(state: Slice, n = 3): QueueStory[] {
  const out: QueueStory[] = [];
  const seen = new Set<string>();
  for (const e of [...state.events].reverse()) {
    if (e.type !== "queue.conflict") continue;
    out.push(storyFromEvent(state, e, "conflict"));
    if (e.trainId) seen.add(e.trainId);
  }
  for (const id of state.trainOrder) {
    const t = state.trains[id]!;
    if (!t.conflict || seen.has(t.trainId)) continue;
    out.push({
      key: `conflict:${t.trainId}`,
      kind: "conflict",
      ts: t.createdAt,
      summary: t.conflict.summary,
      itemId: itemIdOf(t) ?? null,
      trainId: t.trainId,
      traceId: t.traceId ?? null,
      paths: t.conflict.paths,
      data: null,
    });
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, n);
}

/** The last `n` bisects, newest first. */
export function recentBisects(state: Slice, n = 3): QueueStory[] {
  return [...state.events]
    .reverse()
    .filter((e) => e.type === "queue.bisect")
    .slice(0, n)
    .map((e) => storyFromEvent(state, e, "bisect"));
}

// ── races and item sub-state ──────────────────────────────────────────────

export interface RaceCandidate {
  train: MergeTrain;
  candidate: number;
  model: string | null;
  group: TileGroup;
  /** Standing: RACING / PASSED / FAILED / WON / LOST. */
  outcome: string;
  winner: boolean;
  score: MergeTrain["score"] | null;
}

export interface RaceView {
  race: Race;
  item: WorkItem | null;
  candidates: RaceCandidate[];
  /** "2 passed, deciding 41s" pieces. */
  passed: number;
  failed: number;
  decidingInMs: number | null;
  /** Ranking reason once decided. */
  reason: string | null;
}

export function raceView(state: Slice, raceId: string, now = Date.now()): RaceView | null {
  const race = state.races[raceId];
  if (!race) return null;
  const trains = state.trainOrder.map((id) => state.trains[id]!).filter((t) => t.raceId === raceId);
  const candidates = trains
    .sort((a, b) => (a.candidate ?? 0) - (b.candidate ?? 0))
    .map<RaceCandidate>((t) => ({
      train: t,
      candidate: t.candidate ?? 0,
      model: t.model ?? null,
      group: tileGroup(state, t),
      outcome: t.raceOutcome ?? (t.status === "EJECTED" ? "FAILED" : "RACING"),
      winner: race.winnerTrainId === t.trainId,
      score: t.score ?? null,
    }));
  return {
    race,
    item: state.items[race.itemId] ?? null,
    candidates,
    passed: candidates.filter((c) => c.outcome === "PASSED" || c.outcome === "WON").length,
    failed: candidates.filter((c) => c.outcome === "FAILED" || c.outcome === "LOST").length,
    decidingInMs: race.state === "RACING" && race.deadlineAt ? Math.max(0, race.deadlineAt - now) : null,
    reason: race.reason,
  };
}

/** The race for an item: the active one, else the newest. */
export function raceViewForItem(state: Slice, itemId: string, now = Date.now()): RaceView | null {
  const races = Object.values(state.races)
    .filter((r) => r.itemId === itemId)
    .sort((a, b) => (a.state === "RACING" ? -1 : 0) - (b.state === "RACING" ? -1 : 0) || b.createdAt - a.createdAt);
  return races[0] ? raceView(state, races[0].raceId, now) : null;
}

export type SubState = "building" | "gating" | "racing" | "queued" | "merging" | "landing" | "reworking (conflict)";

/** An ACTIVE item's display sub-state (§2.1), derived from its live build train and car; null for other statuses. */
export function itemSubState(state: Slice, item: WorkItem): SubState | null {
  if (item.status !== "ACTIVE") return null;
  const live = state.trainOrder
    .map((id) => state.trains[id]!)
    .filter((t) => isBuildTrain(t) && isLive(t) && itemIdOf(t) === item.itemId);
  if (live.some((t) => raceActive(state, t))) return "racing";
  const t = live.at(-1);
  if (!t) return "building";
  if (t.waitForCarSeq != null) return "reworking (conflict)";
  if (t.carId) {
    const car = state.trains[t.carId];
    return car?.phase === "LANDING" ? "landing" : "merging";
  }
  if (t.phase === "PASSED") return "queued";
  if (t.phase === "TESTING" || t.status === "TESTING") return "gating";
  return "building";
}

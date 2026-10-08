/**
 * The merge-train graph (v2 design §2.3, §5.1–5.2), laid out like a git
 * commit graph with time flowing left to right:
 *
 *   main ──●──────────●─────────●──      one node per landed SHA
 *           ╲  ◆K3 ───╯  ◆K4 ───╯        QUEUE band: cars, stacked on the car ahead (or main)
 *            ╲ ╱      ╲ ╱
 *   ──────────╯        ╲                 BUILD band: one lane per concurrent branch,
 *   ─────────╯          ╲─────            converging into the car that carried it
 *
 * Pure: `(state, window) → {lanes, nodes, edges, cars, branches, …}`, with
 * SVG path strings precomputed, so the renderer only paints. Times come from
 * the trains themselves (createdAt, a car's formation), the event log
 * (`queue.landed`, `train.phase`, `queue.conflict`, …) and the reducer's
 * observed phase-change times; when none of those can say when something
 * ended, the time is estimated and flagged `approx`.
 *
 * The x axis is time, monotone but not linear: every distinct moment gets at
 * least a few pixels (so 24 forks in one second still fan out) and idle gaps
 * are capped (drawn as axis breaks), so a 24 h window stays scrollable.
 */
import type { MergeTrain, QueenEvent } from "@queenos/queen-types";

import { tailOf, type State, type TrainTimes } from "./reducer";

export type GraphSlice = Pick<State, "trains" | "trainOrder" | "items" | "races" | "events" | "landed"> & {
  trainTimes?: Record<string, TrainTimes>;
};

export interface GraphWindow {
  now: number;
  /** How far back the graph reaches (30 min on the status home, 24 h on the queue page). */
  spanMs: number;
  density?: "compact" | "full";
  /** The box's width: a short history is stretched (up to 4×) to fill it instead of hugging the left. */
  fitWidth?: number;
}

export interface Pt {
  x: number;
  y: number;
}

/** A BUILD branch's colour: its current phase. */
export type BranchTone = "waiting" | "building" | "deploying" | "gating" | "passed" | "racing" | "merged" | "ejected" | "lost" | "conflict";
/** A car's colour. */
export type CarTone = "merging" | "gating" | "passed" | "landing" | "merged" | "failed" | "superseded" | "ejected";

export interface GraphLane {
  band: "queue" | "build";
  index: number;
  y: number;
}

export interface BranchView {
  trainId: string;
  itemId: string | null;
  /** Full item title. */
  title: string;
  /** Title as drawn (prefixed ★ / ↺, truncated to the room on the line); "" = no room. */
  label: string;
  tone: BranchTone;
  lane: number;
  y: number;
  /** Where the line starts on its lane (the fork lands here), and where it leaves it. */
  x0: number;
  x1: number;
  alive: boolean;
  /** Started before the window: drawn from the left edge with no fork. */
  clippedLeft: boolean;
  /** Fork source: a known main node's SHA, or null (main at fork time). */
  forkSha: string | null;
  raceId: string | null;
  candidate: number | null;
  winner: boolean;
  loser: boolean;
  /** Cars it rode, oldest first. */
  carIds: string[];
  rework: boolean;
  infraRetries: number;
  model: string | null;
  approx: boolean;
}

export interface CarView {
  trainId: string;
  /** "K12", or "K9a" / "K9b" for bisect halves. */
  label: string;
  /** "K12": the car's own sequence label (matches the queue table). */
  kLabel: string;
  x: number;
  y: number;
  lane: number;
  /** Where the car's line ends (landing or ejection); null while alive. */
  endX: number | null;
  tone: CarTone;
  /** Display phase: MERGING, GATING, PASSED, LANDING, MERGED, FAILED, SUPERSEDED, EJECTED. */
  phase: string;
  /** Member trainIds in merge order (conflicting members included, last). */
  members: string[];
  conflicts: { trainId: string; kind: string; paths: string[]; summary: string }[];
  fastForward: boolean;
  infraRetries: number;
  /** The car it stacked on (speculative); null = forked from main. */
  predecessor: string | null;
  /** The failed car this is a bisect half of. */
  bisectOf: string | null;
  /** Bisect halves (car ids), if this car failed and was split. */
  halves: string[];
  /** A bisect half that failed: the culprit is in here. */
  culprit: boolean;
  reason: string | null;
  baseSha: string;
  headSha: string | null;
  landedSha: string | null;
  traceId: string | null;
  createdAt: number;
  endedAt: number | null;
  approx: boolean;
}

export type GraphNode =
  | { kind: "main"; id: string; x: number; y: number; sha: string; /** 0/1 = label row above main, -1 = no room (hover only). */ labelRow: number; trainIds: string[]; at: number }
  | { kind: "car"; id: string; x: number; y: number; carId: string; label: string; tone: CarTone; half: string | null }
  | { kind: "conflict"; id: string; x: number; y: number; trainId: string; carId: string | null; paths: string[]; summary: string }
  | { kind: "end"; id: string; x: number; y: number; trainId: string; tone: string }
  | { kind: "stub"; id: string; x: number; y: number; count: number; label: string; detail: string };

export type EdgeKind = "main" | "fork" | "branch" | "board" | "car" | "stack" | "land" | "bisect" | "reboard" | "rework" | "merge";

export interface GraphEdge {
  id: string;
  kind: EdgeKind;
  d: string;
  from: Pt;
  to: Pt;
  /** The train the edge belongs to (branch or car). */
  trainId: string | null;
  /** The car it leads into / out of, where relevant. */
  carId?: string;
  /** Main node SHA it touches (fork, land, merge). */
  sha?: string;
  tone: string;
  dashed?: boolean;
  faded?: boolean;
}

export interface RaceBracket {
  raceId: string;
  x: number;
  y0: number;
  y1: number;
  width: number;
  decided: boolean;
}

export interface MergeGraphLayout {
  width: number;
  height: number;
  mainY: number;
  /** x of the window's left edge (trunk start) and of now (right edge). */
  xStart: number;
  xNow: number;
  lanes: GraphLane[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  cars: CarView[];
  branches: BranchView[];
  races: RaceBracket[];
  ticks: { x: number; at: number; label: string }[];
  /** Idle stretches drawn shorter than their duration. */
  breaks: { x: number; ms: number }[];
  /** History collapsed into the "+N earlier" stub. */
  earlier: { branches: number; cars: number; landings: number };
  /** Distinct BUILD trains (items' builds) that landed on main inside the window, as `landedCount` counts them. */
  landedInWindow: number;
  /** Concurrent branches at the right edge (alive now). */
  liveBranches: number;
  /** Approximate label character width (px) the layout truncated to. */
  charW: number;
}

// ── geometry ──────────────────────────────────────────────────────────────

interface Geometry {
  laneH: number;
  carLaneH: number;
  pxPerMs: number;
  /** Longest step one gap may take (idle time beyond it is compressed). */
  maxStep: number;
  minorGap: number;
  majorGap: number;
  nowGap: number;
  charW: number;
}

const GEOMETRY: Record<"compact" | "full", Geometry> = {
  compact: { laneH: 14, carLaneH: 24, pxPerMs: 30 / 60_000, maxStep: 110, minorGap: 7, majorGap: 26, nowGap: 40, charW: 6 },
  full: { laneH: 17, carLaneH: 28, pxPerMs: 44 / 60_000, maxStep: 150, minorGap: 9, majorGap: 32, nowGap: 56, charW: 6.4 },
};

const LEFT = 92;
const RIGHT = 44;
const TOP = 30;
const FORK_DX = 26;
const BOARD_DX = 22;
const LAND_DX = 22;
const STACK_DX = 18;
const CAR_STAGGER = 26;
const LANE_PAD = 10;
/** An end with no time on record is placed this long after the start (and flagged approx). */
const FALLBACK_MS = 60_000;

const r1 = (n: number) => Math.round(n * 10) / 10;
const sCurve = (a: Pt, b: Pt): string => {
  const mx = r1((a.x + b.x) / 2);
  return `M${r1(a.x)} ${r1(a.y)}C${mx} ${r1(a.y)} ${mx} ${r1(b.y)} ${r1(b.x)} ${r1(b.y)}`;
};
const straight = (a: Pt, b: Pt): string => `M${r1(a.x)} ${r1(a.y)}H${r1(b.x)}`;

// ── event index ───────────────────────────────────────────────────────────

interface CarEventInfo {
  members?: string[];
  predecessorCarId?: string | null;
  bisectOf?: string | null;
  fastForward?: boolean;
  halves?: string[][];
}

interface EventIndex {
  /** Train id → the time the event log says it ended (MERGED / EJECTED, landed). */
  ended: Map<string, number>;
  /** Car id → formation / merge / bisect details. */
  car: Map<string, CarEventInfo>;
  /** Member train id → the car it conflicted in. */
  conflict: Map<string, { carId: string | null; paths: string[]; kind: string; summary: string; ts: number }>;
  /** Train id → highest infra retry number seen. */
  infra: Map<string, number>;
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function indexEvents(events: readonly QueenEvent[]): EventIndex {
  const ix: EventIndex = { ended: new Map(), car: new Map(), conflict: new Map(), infra: new Map() };
  const carInfo = (id: string) => {
    let c = ix.car.get(id);
    if (!c) ix.car.set(id, (c = {}));
    return c;
  };
  for (const e of events) {
    const d = e.data ?? {};
    switch (e.type) {
      case "train.phase": {
        if (!e.trainId) break;
        if (d.to === "MERGED" || d.to === "EJECTED") ix.ended.set(e.trainId, e.ts);
        if (typeof d.infraRetry === "number") ix.infra.set(e.trainId, Math.max(ix.infra.get(e.trainId) ?? 0, d.infraRetry));
        break;
      }
      case "queue.landed": {
        const id = str(d.carId) ?? e.trainId;
        if (id && !ix.ended.has(id)) ix.ended.set(id, e.ts);
        break;
      }
      case "queue.car": {
        const id = str(d.carId) ?? e.trainId;
        if (!id) break;
        const c = carInfo(id);
        if (strs(d.members).length) c.members = strs(d.members);
        if ("predecessorCarId" in d) c.predecessorCarId = str(d.predecessorCarId);
        if ("bisectOf" in d) c.bisectOf = str(d.bisectOf);
        break;
      }
      case "queue.merged": {
        if (!e.trainId) break;
        if (typeof d.fastForward === "boolean") carInfo(e.trainId).fastForward = d.fastForward;
        break;
      }
      case "queue.bisect": {
        const id = str(d.carId) ?? e.trainId;
        if (!id) break;
        const halves = Array.isArray(d.halves) ? d.halves.map(strs) : [];
        if (halves.length) carInfo(id).halves = halves;
        break;
      }
      case "queue.conflict": {
        if (!e.trainId) break;
        ix.conflict.set(e.trainId, { carId: str(d.carId), paths: strs(d.paths), kind: str(d.kind) ?? "content", summary: e.summary, ts: e.ts });
        break;
      }
      default:
        break;
    }
  }
  return ix;
}

// ── time → x ──────────────────────────────────────────────────────────────

interface Knot {
  t: number;
  /** Room wanted before / after this moment. */
  before: number;
  after: number;
}

interface TimeAxis {
  x: (t: number) => number;
  width: number;
  breaks: { x: number; ms: number }[];
}

function buildAxis(knots: Knot[], start: number, now: number, g: Geometry, fitWidth = 0): TimeAxis {
  const byT = new Map<number, Knot>();
  for (const k of knots) {
    const t = Math.min(now, Math.max(start, k.t));
    const prev = byT.get(t);
    byT.set(t, prev ? { t, before: Math.max(prev.before, k.before), after: Math.max(prev.after, k.after) } : { ...k, t });
  }
  const startKnot = byT.get(start);
  byT.set(start, { t: start, before: 0, after: startKnot?.after ?? 0 });
  const nowKnot = byT.get(now);
  byT.set(now, { t: now, before: Math.max(g.nowGap, nowKnot?.before ?? 0), after: 0 });
  const sorted = [...byT.values()].sort((a, b) => a.t - b.t);
  const xs: number[] = [LEFT];
  const breaks: TimeAxis["breaks"] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    const dt = b.t - a.t;
    const natural = dt * g.pxPerMs;
    const need = a.after + b.before;
    const step = Math.max(need, Math.min(natural, g.maxStep));
    if (natural > g.maxStep * 1.25 && dt >= 120_000) breaks.push({ x: xs[i - 1]! + step / 2, ms: dt });
    xs.push(xs[i - 1]! + step);
  }
  // Stretch everything after the first moment (the leading idle step stays as it is) to fill the box.
  const span = xs.at(-1)! - (xs[1] ?? LEFT);
  const room = fitWidth - RIGHT - (xs[1] ?? LEFT);
  if (xs.length > 2 && span > 0 && room > span) {
    const k = Math.min(4, room / span);
    const x1 = xs[1]!;
    for (let i = 2; i < xs.length; i++) xs[i] = x1 + (xs[i]! - x1) * k;
    for (const b of breaks) if (b.x > x1) b.x = x1 + (b.x - x1) * k;
  }
  const x = (t: number): number => {
    if (t <= sorted[0]!.t) return xs[0]!;
    // Binary search for the segment holding t.
    let lo = 0;
    let hi = sorted.length - 1;
    if (t >= sorted[hi]!.t) return xs[hi]!;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]!.t <= t) lo = mid;
      else hi = mid;
    }
    const a = sorted[lo]!;
    const b = sorted[hi]!;
    return xs[lo]! + ((t - a.t) / (b.t - a.t)) * (xs[hi]! - xs[lo]!);
  };
  return { x, width: xs.at(-1)! + RIGHT, breaks };
}

// ── lane packing ──────────────────────────────────────────────────────────

/**
 * Greedy interval packing: each unit (a branch, or a race's candidates as one
 * block of adjacent rows) takes the lowest block of rows free at its start, so
 * rows are reused once a branch has finished. Units arrive sorted by start.
 */
export function packLanes(units: { size: number; x0: number; x1: number }[]): number[] {
  const free: number[] = []; // row → x where it frees up
  return units.map((u) => {
    for (let r = 0; ; r++) {
      let ok = true;
      for (let k = 0; k < u.size; k++) if ((free[r + k] ?? -Infinity) > u.x0) ok = false;
      if (ok) {
        for (let k = 0; k < u.size; k++) free[r + k] = u.x1 + LANE_PAD;
        return r;
      }
    }
  });
}

// ── tones ─────────────────────────────────────────────────────────────────

const isLive = (t: MergeTrain) => t.status !== "MERGED" && t.status !== "EJECTED";
const isQueue = (t: MergeTrain) => t.lane === "QUEUE";

function branchTone(state: GraphSlice, t: MergeTrain): BranchTone {
  if (t.raceOutcome === "LOST") return "lost";
  if (t.status === "EJECTED") return t.conflict ? "conflict" : "ejected";
  if (t.status === "MERGED" || t.phase === "MERGED") return "merged";
  if (t.raceId) {
    const race = state.races[t.raceId];
    const racing = race ? race.state === "RACING" : !t.raceOutcome || t.raceOutcome === "RACING" || t.raceOutcome === "PASSED";
    if (racing) return "racing";
  }
  switch (t.phase) {
    case "WAITING_PARENT":
      return "waiting";
    case "DEPLOYING":
      return "deploying";
    case "TESTING":
      return "gating";
    case "PASSED":
    case "LANDING":
      return "passed";
    case "BUILDING":
      return "building";
    default:
      return t.status === "TESTING" ? "gating" : "building";
  }
}

function carTone(t: MergeTrain): { tone: CarTone; phase: string } {
  if (t.status === "MERGED" || t.phase === "MERGED") return { tone: "merged", phase: "MERGED" };
  if (t.status === "EJECTED") {
    const r = t.reason ?? "";
    if (r.startsWith("superseded")) return { tone: "superseded", phase: "SUPERSEDED" };
    if (r.startsWith("failed")) return { tone: "failed", phase: "FAILED" };
    return { tone: "ejected", phase: "EJECTED" };
  }
  switch (t.phase) {
    case "LANDING":
      return { tone: "landing", phase: "LANDING" };
    case "PASSED":
      return { tone: "passed", phase: "PASSED" };
    case "DEPLOYING":
    case "TESTING":
      return { tone: "gating", phase: "GATING" };
    default:
      return t.status === "TESTING" ? { tone: "gating", phase: "GATING" } : { tone: "merging", phase: "MERGING" };
  }
}

/** Truncate to `max` characters with an ellipsis; "" when not even 3 fit. */
export function fit(text: string, max: number): string {
  const n = Math.floor(max);
  if (n < 3) return "";
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

// ── layout ────────────────────────────────────────────────────────────────

interface TimedBranch {
  t: MergeTrain;
  start: number;
  /** When it left its lane: boarded its first car, or ended; null = alive. */
  end: number | null;
  carIds: string[];
  approx: boolean;
}

interface TimedCar {
  t: MergeTrain;
  kLabel: string;
  index: number;
  start: number;
  end: number | null;
  approx: boolean;
  members: string[];
}

export function mergeGraph(state: GraphSlice, win: GraphWindow): MergeGraphLayout {
  const g = GEOMETRY[win.density ?? "full"];
  const now = win.now;
  const wStart = now - win.spanMs;
  const ix = indexEvents(state.events);
  const times = state.trainTimes ?? {};
  const all = state.trainOrder.map((id) => state.trains[id]).filter((t): t is MergeTrain => !!t);
  const titleOf = (t: MergeTrain) => {
    const id = tailOf(t);
    return (id && state.items[id]?.title) || t.trainId;
  };

  // When a terminal train ended: the event log, else what this dashboard saw, else an estimate.
  const endOf = (t: MergeTrain, start: number): { at: number; approx: boolean } => {
    for (const c of [ix.ended.get(t.trainId), times[t.trainId]?.endedAt ?? undefined]) {
      if (c !== undefined && c >= start) return { at: Math.min(c, now), approx: false };
    }
    return { at: Math.min(now, start + FALLBACK_MS), approx: true };
  };

  // Cars, labelled as the queue table does: K<n> by creation over every QUEUE train.
  const carTrains = all.filter(isQueue).sort((a, b) => a.createdAt - b.createdAt || a.trainId.localeCompare(b.trainId));
  const cars = new Map<string, TimedCar>();
  carTrains.forEach((t, i) => {
    const start = Math.min(t.createdAt, now);
    const end = isLive(t) ? null : endOf(t, start);
    const evMembers = ix.car.get(t.trainId)?.members ?? [];
    const members = [...(t.members ?? [])];
    for (const m of evMembers) if (!members.includes(m)) members.push(m);
    cars.set(t.trainId, { t, kLabel: `K${i + 1}`, index: i, start, end: end?.at ?? null, approx: end?.approx ?? false, members });
  });
  // An ejected car with no recorded end ended no later than its members re-boarded (bisect halves, the next car).
  for (const c of cars.values()) {
    if (!c.approx || c.end == null || c.t.status !== "EJECTED") continue;
    let bound = Infinity;
    for (const o of cars.values()) if (o.index > c.index && o.start >= c.start && o.members.some((m) => c.members.includes(m))) bound = Math.min(bound, o.start);
    if (bound < c.end) c.end = bound;
  }
  const carsBySeq = new Map<number, TimedCar>();
  for (const c of cars.values()) if (c.t.carSeq != null) carsBySeq.set(c.t.carSeq, c);

  // Which cars each build rode: the car's member list, its formation event, the conflict event and the build's own carId.
  const rode = new Map<string, Set<string>>();
  const ride = (trainId: string, carId: string | null | undefined) => {
    if (!carId || !cars.has(carId)) return;
    let s = rode.get(trainId);
    if (!s) rode.set(trainId, (s = new Set()));
    s.add(carId);
  };
  for (const c of cars.values()) for (const m of c.members) ride(m, c.t.trainId);
  for (const [trainId, c] of ix.conflict) ride(trainId, c.carId);

  // Builds.
  const builds: TimedBranch[] = [];
  for (const t of all) {
    if (isQueue(t)) continue;
    ride(t.trainId, t.carId);
    const carIds = [...(rode.get(t.trainId) ?? [])].sort((a, b) => cars.get(a)!.start - cars.get(b)!.start || cars.get(a)!.index - cars.get(b)!.index);
    let start = Math.min(t.createdAt, now);
    // A conflict / integration rework forks only once the car it waits for is done.
    if (t.waitForCarSeq != null) {
      const waited = carsBySeq.get(t.waitForCarSeq);
      if (waited?.end != null && waited.end > start) start = waited.end;
    }
    let end: number | null = null;
    let approx = false;
    if (carIds.length) end = Math.max(start, cars.get(carIds[0]!)!.start);
    else if (!isLive(t)) ({ at: end, approx } = endOf(t, start));
    builds.push({ t, start, end, carIds, approx });
  }

  // Main nodes: one per landed SHA, at the landing time of the car (or build) that put it there.
  const landOrder = new Map<string, number>();
  state.landed.forEach((l, i) => { if (!landOrder.has(l.sha)) landOrder.set(l.sha, i); });
  const shaInfo = new Map<string, { at: number; trainIds: string[]; byCar: boolean }>();
  const addSha = (sha: string, at: number, trainId: string, byCar: boolean) => {
    const cur = shaInfo.get(sha);
    if (!cur) shaInfo.set(sha, { at, trainIds: [trainId], byCar });
    else {
      cur.trainIds.push(trainId);
      if (byCar && !cur.byCar) Object.assign(cur, { at, byCar: true });
      else if (byCar === cur.byCar) cur.at = Math.min(cur.at, at);
    }
  };
  for (const c of cars.values()) if (c.t.landedSha && c.end != null) addSha(c.t.landedSha, c.end, c.t.trainId, true);
  for (const b of builds) {
    const sha = b.t.landedSha;
    if (!sha || b.t.status !== "MERGED") continue;
    const car = b.carIds.map((id) => cars.get(id)!).find((c) => c.t.landedSha === sha);
    if (car?.end != null) addSha(sha, car.end, b.t.trainId, true);
    else addSha(sha, endOf(b.t, b.start).at, b.t.trainId, false);
  }
  const shas = [...shaInfo.entries()]
    .map(([sha, v]) => ({ sha, ...v }))
    // By landing time; the landed list (creation order after a snapshot, so not landing order) only breaks ties.
    .sort((a, b) => a.at - b.at || (landOrder.get(a.sha) ?? Infinity) - (landOrder.get(b.sha) ?? Infinity));

  // The window: anything that ended before it collapses into "+N earlier".
  const visibleBuilds = builds.filter((b) => (b.end ?? now) >= wStart);
  const visibleCars = [...cars.values()].filter((c) => (c.end ?? now) >= wStart);
  const visibleShas = shas.filter((s) => s.at >= wStart);
  const earlier = { branches: builds.length - visibleBuilds.length, cars: cars.size - visibleCars.length, landings: shas.length - visibleShas.length };
  // Landed in the window: a car counts its merged members (a batched car of 3 is 3), a direct landing counts itself.
  const landedIds = new Set<string>();
  for (const s of visibleShas) {
    for (const id of s.trainIds) {
      const car = cars.get(id);
      if (!car) landedIds.add(id);
      else for (const m of car.members) if (state.trains[m]?.status !== "EJECTED") landedIds.add(m);
    }
  }

  // Time axis knots.
  const knots: Knot[] = [];
  const sameStart = new Map<number, TimedCar[]>();
  for (const c of visibleCars) sameStart.set(c.start, [...(sameStart.get(c.start) ?? []), c]);
  for (const b of visibleBuilds) {
    knots.push({ t: b.start, before: g.minorGap, after: g.minorGap });
    if (b.end != null && !b.carIds.length) knots.push({ t: b.end, before: g.minorGap, after: g.minorGap });
  }
  for (const [t, group] of sameStart) knots.push({ t, before: g.majorGap, after: g.majorGap / 2 + (group.length - 1) * CAR_STAGGER });
  for (const c of visibleCars) if (c.end != null) knots.push({ t: c.end, before: g.majorGap, after: g.majorGap / 2 });
  for (const s of visibleShas) knots.push({ t: s.at, before: g.majorGap, after: g.majorGap / 2 });
  const axis = buildAxis(knots, wStart, now, g, win.fitWidth);
  const X = (t: number) => axis.x(Math.min(now, Math.max(wStart, t)));
  const xNow = X(now);

  // Car x: staggered when several formed in the same instant (one decide() forms up to maxQueueDepth).
  const carX = new Map<string, number>();
  for (const [t, group] of sameStart) {
    group.sort((a, b) => a.index - b.index);
    group.forEach((c, j) => carX.set(c.t.trainId, X(t) + j * CAR_STAGGER));
  }
  const carEndX = (c: TimedCar) => (c.end == null ? xNow : Math.max(carX.get(c.t.trainId)! + 4, X(c.end)));

  // Car relationships: stacking, bisect halves.
  const predecessorOf = (c: TimedCar): string | null => {
    const ev = ix.car.get(c.t.trainId);
    if (ev && "predecessorCarId" in ev) return ev.predecessorCarId && cars.has(ev.predecessorCarId) ? ev.predecessorCarId : null;
    for (const o of cars.values()) if (o !== c && o.t.headSha && o.t.headSha === c.t.baseSha && o.index < c.index) return o.t.trainId;
    // The queue rule: the newest earlier car still live when this one formed.
    let best: TimedCar | null = null;
    for (const o of cars.values()) {
      if (o.index >= c.index || o.start > c.start) continue;
      if (o.end != null && o.end <= c.start) continue;
      if (!best || o.index > best.index) best = o;
    }
    return best?.t.trainId ?? null;
  };
  const bisectParent = new Map<string, string>();
  for (const c of cars.values()) {
    const ev = ix.car.get(c.t.trainId);
    if (ev?.bisectOf && cars.has(ev.bisectOf)) {
      bisectParent.set(c.t.trainId, ev.bisectOf);
      continue;
    }
    // No formation event: a later car whose members are a strict subset of a failed car's.
    let parent: TimedCar | null = null;
    for (const f of cars.values()) {
      if (f === c || f.index > c.index || carTone(f.t).tone !== "failed" || f.members.length < 2) continue;
      if (c.members.length && c.members.length < f.members.length && c.members.every((m) => f.members.includes(m)) && c.start >= f.start) {
        if (!parent || f.index > parent.index) parent = f;
      }
    }
    if (parent) bisectParent.set(c.t.trainId, parent.t.trainId);
  }
  const halvesOf = new Map<string, string[]>();
  for (const [child, parent] of bisectParent) halvesOf.set(parent, [...(halvesOf.get(parent) ?? []), child]);
  for (const list of halvesOf.values()) list.sort((a, b) => cars.get(a)!.index - cars.get(b)!.index);
  const labelOf = (id: string, depth = 0): string => {
    const parent = bisectParent.get(id);
    if (!parent || depth > 8) return cars.get(id)!.kLabel;
    const i = halvesOf.get(parent)!.indexOf(id);
    return `${labelOf(parent, depth + 1)}${String.fromCharCode(97 + Math.min(i, 25))}`;
  };

  // ── lanes: QUEUE band ──
  const carUnits = visibleCars
    .map((c) => ({ c, x0: carX.get(c.t.trainId)! - STACK_DX, x1: carEndX(c) }))
    .sort((a, b) => a.x0 - b.x0 || a.c.index - b.c.index);
  const carRows = packLanes(carUnits.map((u) => ({ size: 1, x0: u.x0, x1: u.x1 })));
  const carRowOf = new Map<string, number>();
  carUnits.forEach((u, i) => carRowOf.set(u.c.t.trainId, carRows[i]!));
  const queueRows = Math.max(1, ...carRows.map((r) => r + 1));

  const mainY = TOP;
  const queueY0 = mainY + 34;
  const carY = (row: number) => queueY0 + row * g.carLaneH;
  const buildY0 = carY(queueRows - 1) + g.carLaneH / 2 + 22;
  const buildY = (row: number) => buildY0 + row * g.laneH;

  // ── lanes: BUILD band ──
  const mainNodeX = new Map<string, number>();
  for (const s of visibleShas) mainNodeX.set(s.sha, X(s.at));
  const forkInfo = (b: TimedBranch) => {
    const clipped = b.start < wStart;
    const xs = clipped ? LEFT : X(b.start);
    // A rework still WAITING_PARENT has not forked yet: no base node to hang it on.
    const nodeX = !clipped && b.t.baseSha && b.t.phase !== "WAITING_PARENT" ? mainNodeX.get(b.t.baseSha) : undefined;
    const forkSha = nodeX !== undefined && nodeX <= xs ? b.t.baseSha : null;
    return { clipped, xs, forkX: forkSha ? nodeX! : Math.max(LEFT, xs - FORK_DX), forkSha };
  };
  const branchEndX = (b: TimedBranch, xs: number) => {
    if (b.carIds.length) {
      const car = cars.get(b.carIds[0]!)!;
      const cx = carX.get(car.t.trainId);
      return cx === undefined ? X(car.start) : Math.max(xs, cx - BOARD_DX);
    }
    return b.end == null ? xNow : Math.max(xs + 4, X(b.end));
  };

  type Unit = { members: TimedBranch[]; x0: number; x1: number; firstCar: number; raceId: string | null };
  const raceUnits = new Map<string, Unit>();
  const units: Unit[] = [];
  for (const b of visibleBuilds) {
    const f = forkInfo(b);
    const x1 = branchEndX(b, f.xs);
    const firstCar = b.carIds.length ? cars.get(b.carIds[0]!)!.index : Infinity;
    const raceId = b.t.raceId ?? null;
    if (raceId) {
      const u = raceUnits.get(raceId);
      if (u) {
        u.members.push(b);
        u.x0 = Math.min(u.x0, f.xs);
        u.x1 = Math.max(u.x1, x1);
        u.firstCar = Math.min(u.firstCar, firstCar);
        continue;
      }
      const nu: Unit = { members: [b], x0: f.xs, x1, firstCar, raceId };
      raceUnits.set(raceId, nu);
      units.push(nu);
    } else units.push({ members: [b], x0: f.xs, x1, firstCar, raceId: null });
  }
  for (const u of units) u.members.sort((a, b) => (a.t.candidate ?? 0) - (b.t.candidate ?? 0) || a.t.trainId.localeCompare(b.t.trainId));
  // Fork time, then car membership (members of one car end up adjacent), then id.
  units.sort((a, b) => a.x0 - b.x0 || a.firstCar - b.firstCar || a.members[0]!.t.trainId.localeCompare(b.members[0]!.t.trainId));
  const rows = packLanes(units.map((u) => ({ size: u.members.length, x0: u.x0 - FORK_DX / 2, x1: u.x1 })));

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const branches: BranchView[] = [];
  const races: RaceBracket[] = [];
  const lanes: GraphLane[] = [];
  const buildRows = Math.max(0, ...rows.map((r, i) => r + units[i]!.members.length));
  for (let i = 0; i < queueRows; i++) lanes.push({ band: "queue", index: i, y: carY(i) });
  for (let i = 0; i < buildRows; i++) lanes.push({ band: "build", index: i, y: buildY(i) });

  // ── car views ──
  const carViews = new Map<string, CarView>();
  for (const u of carUnits) {
    const c = u.c;
    const t = c.t;
    const { tone, phase } = carTone(t);
    const id = t.trainId;
    const ev = ix.car.get(id);
    const conflicts = [...ix.conflict.entries()]
      .filter(([, v]) => v.carId === id)
      .map(([trainId, v]) => ({ trainId, kind: v.kind, paths: v.paths, summary: v.summary }));
    for (const b of builds) {
      if (b.t.conflict && b.carIds.includes(id) && !conflicts.some((x) => x.trainId === b.t.trainId) && !ix.conflict.has(b.t.trainId)) {
        conflicts.push({ trainId: b.t.trainId, kind: b.t.conflict.kind, paths: b.t.conflict.paths, summary: b.t.conflict.summary });
      }
    }
    const merged = (t.members ?? []).filter((m) => !conflicts.some((x) => x.trainId === m));
    const members = [...merged, ...c.members.filter((m) => !merged.includes(m))];
    const bisectOf = bisectParent.get(id) ?? null;
    carViews.set(id, {
      trainId: id,
      label: labelOf(id),
      kLabel: c.kLabel,
      x: carX.get(id)!,
      y: carY(carRowOf.get(id)!),
      lane: carRowOf.get(id)!,
      endX: c.end == null ? null : carEndX(c),
      tone,
      phase,
      members,
      conflicts,
      fastForward: t.fastForward ?? ev?.fastForward ?? (members.length === 1 && t.score?.checks === 0),
      infraRetries: ix.infra.get(id) ?? 0,
      predecessor: predecessorOf(c),
      bisectOf,
      halves: halvesOf.get(id) ?? [],
      culprit: !!bisectOf && tone === "failed",
      reason: t.reason ?? null,
      baseSha: t.baseSha,
      headSha: t.headSha ?? null,
      landedSha: t.landedSha ?? null,
      traceId: t.traceId ?? null,
      createdAt: t.createdAt,
      endedAt: c.end,
      approx: c.approx,
    });
  }

  // ── branches ──
  const endPoint = new Map<string, Pt>();
  const startPoint = new Map<string, Pt>();
  units.forEach((u, ui) => {
    const row0 = rows[ui]!;
    u.members.forEach((b, k) => {
      const t = b.t;
      const y = buildY(row0 + k);
      const f = forkInfo(b);
      const x1 = branchEndX(b, f.xs);
      const tone = branchTone(state, t);
      const race = t.raceId ? state.races[t.raceId] : undefined;
      const winner = t.raceOutcome === "WON" || (!!race?.winnerTrainId && race.winnerTrainId === t.trainId);
      const loser = t.raceOutcome === "LOST" || (!!race?.winnerTrainId && race.winnerTrainId !== t.trainId);
      const itemId = tailOf(t) ?? null;
      const siblings = builds.filter((o) => o.t !== t && tailOf(o.t) === itemId && o.t.createdAt < t.createdAt && (!t.raceId || o.t.raceId !== t.raceId));
      const rework = !!itemId && siblings.length > 0;
      const title = titleOf(t);
      const prefix = winner ? "★ " : rework ? "↺ " : "";
      const room = (x1 - f.xs - 10) / g.charW;
      const view: BranchView = {
        trainId: t.trainId,
        itemId,
        title,
        label: fit(prefix + title, Math.min(room, 34)),
        tone,
        lane: row0 + k,
        y,
        x0: f.xs,
        x1,
        alive: isLive(t),
        clippedLeft: f.clipped,
        forkSha: f.forkSha,
        raceId: t.raceId ?? null,
        candidate: t.candidate ?? null,
        winner,
        loser,
        carIds: b.carIds,
        rework,
        infraRetries: ix.infra.get(t.trainId) ?? 0,
        model: t.model ?? null,
        approx: b.approx,
      };
      branches.push(view);
      startPoint.set(t.trainId, { x: f.xs, y });
      const faded = loser;
      if (!f.clipped) {
        const from = { x: f.forkX, y: mainY };
        const to = { x: f.xs, y };
        edges.push({ id: `fork:${t.trainId}`, kind: "fork", d: sCurve(from, to), from, to, trainId: t.trainId, ...(f.forkSha ? { sha: f.forkSha } : {}), tone, faded, dashed: tone === "waiting" });
      }
      const a = { x: f.xs, y };
      const z = { x: x1, y };
      edges.push({ id: `branch:${t.trainId}`, kind: "branch", d: straight(a, z), from: a, to: z, trainId: t.trainId, tone, faded, dashed: tone === "waiting" || tone === "ejected" || tone === "conflict" });
      endPoint.set(t.trainId, z);

      const first = b.carIds[0] ? carViews.get(b.carIds[0]) : undefined;
      const conflict = t.conflict ?? (ix.conflict.has(t.trainId) ? ix.conflict.get(t.trainId)! : null);
      if (first) {
        const to = { x: first.x, y: first.y };
        const bad = !!conflict && (ix.conflict.get(t.trainId)?.carId ?? t.carId ?? first.trainId) === first.trainId;
        edges.push({ id: `board:${t.trainId}:${first.trainId}`, kind: "board", d: sCurve(z, to), from: z, to, trainId: t.trainId, carId: first.trainId, tone: bad ? "conflict" : tone, faded, dashed: bad });
      } else if (t.status === "MERGED" && t.landedSha && mainNodeX.has(t.landedSha)) {
        const to = { x: mainNodeX.get(t.landedSha)!, y: mainY };
        edges.push({ id: `merge:${t.trainId}`, kind: "merge", d: sCurve(z, to), from: z, to, trainId: t.trainId, sha: t.landedSha, tone });
      } else if (!view.alive && t.status === "EJECTED" && !conflict) {
        nodes.push({ kind: "end", id: `end:${t.trainId}`, x: z.x, y, trainId: t.trainId, tone });
      }
      if (conflict) {
        const carId = ix.conflict.get(t.trainId)?.carId ?? t.carId ?? first?.trainId ?? null;
        nodes.push({ kind: "conflict", id: `conflict:${t.trainId}`, x: z.x, y, trainId: t.trainId, carId, paths: [...conflict.paths], summary: conflict.summary });
      }
    });
    if (u.raceId && u.members.length > 1) {
      const race = state.races[u.raceId];
      const ys = u.members.map((_, k) => buildY(row0 + k));
      races.push({ raceId: u.raceId, x: Math.min(...u.members.map((b) => forkInfo(b).xs)) - 5, y0: ys[0]!, y1: ys.at(-1)!, width: race?.width ?? u.members.length, decided: !!race && race.state !== "RACING" });
    }
  });

  // Rework links: a failed attempt's end to the item's next attempt, faint and dotted.
  const byItem = new Map<string, BranchView[]>();
  for (const b of branches) if (b.itemId) byItem.set(b.itemId, [...(byItem.get(b.itemId) ?? []), b]);
  for (const list of byItem.values()) {
    list.sort((a, b) => state.trains[a.trainId]!.createdAt - state.trains[b.trainId]!.createdAt);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!;
      const next = list[i]!;
      if (!next.rework || prev.alive || (prev.raceId && prev.raceId === next.raceId)) continue;
      if (next.raceId && list.some((o, j) => j < i && o.raceId === next.raceId)) continue;
      const from = endPoint.get(prev.trainId)!;
      const to = startPoint.get(next.trainId)!;
      if (to.x <= from.x) continue;
      edges.push({ id: `rework:${prev.trainId}:${next.trainId}`, kind: "rework", d: sCurve(from, to), from, to, trainId: next.trainId, tone: "rework", dashed: true, faded: true });
    }
  }

  // ── cars: stack, line, land, bisect, reboard ──
  for (const cv of carViews.values()) {
    const c = cars.get(cv.trainId)!;
    const node = { x: cv.x, y: cv.y };
    nodes.push({ kind: "car", id: `car:${cv.trainId}`, x: cv.x, y: cv.y, carId: cv.trainId, label: cv.label, tone: cv.tone, half: cv.bisectOf ? cv.label.slice(-1) : null });
    if (c.start >= wStart) {
      const pred = cv.predecessor ? carViews.get(cv.predecessor) : undefined;
      if (pred) {
        const from = { x: Math.max(pred.x, cv.x - STACK_DX), y: pred.y };
        edges.push({ id: `stack:${cv.trainId}`, kind: "stack", d: pred.y === cv.y ? straight(from, node) : sCurve(from, node), from, to: node, trainId: cv.trainId, carId: pred.trainId, tone: cv.tone, dashed: true });
      } else {
        const nodeX = mainNodeX.get(cv.baseSha);
        const fx = nodeX !== undefined && nodeX <= cv.x ? nodeX : Math.max(LEFT, cv.x - STACK_DX);
        const from = { x: fx, y: mainY };
        edges.push({ id: `stack:${cv.trainId}`, kind: "stack", d: sCurve(from, node), from, to: node, trainId: cv.trainId, ...(nodeX !== undefined && nodeX <= cv.x ? { sha: cv.baseSha } : {}), tone: cv.tone, dashed: true });
      }
    }
    const endX = cv.endX ?? xNow;
    const landSha = cv.tone === "merged" && cv.landedSha && mainNodeX.has(cv.landedSha) ? cv.landedSha : null;
    if (landSha) {
      const mx = mainNodeX.get(landSha)!;
      const leave = { x: Math.max(cv.x, mx - LAND_DX), y: cv.y };
      edges.push({ id: `car:${cv.trainId}`, kind: "car", d: straight(node, leave), from: node, to: leave, trainId: cv.trainId, tone: cv.tone });
      const to = { x: mx, y: mainY };
      edges.push({ id: `land:${cv.trainId}`, kind: "land", d: sCurve(leave, to), from: leave, to, trainId: cv.trainId, sha: landSha, tone: cv.tone });
    } else {
      const to = { x: endX, y: cv.y };
      const bad = cv.tone === "failed" || cv.tone === "ejected" || cv.tone === "superseded";
      edges.push({ id: `car:${cv.trainId}`, kind: "car", d: straight(node, to), from: node, to, trainId: cv.trainId, tone: cv.tone, dashed: bad, faded: cv.tone === "superseded" });
      if (bad) nodes.push({ kind: "end", id: `end:${cv.trainId}`, x: to.x, y: cv.y, trainId: cv.trainId, tone: cv.tone });
    }
    for (const h of cv.halves) {
      const half = carViews.get(h);
      if (!half) continue;
      const from = { x: endX, y: cv.y };
      const to = { x: half.x, y: half.y };
      edges.push({ id: `bisect:${cv.trainId}:${h}`, kind: "bisect", d: sCurve(from, to), from, to, trainId: h, carId: cv.trainId, tone: half.culprit ? "failed" : "bisect", dashed: true });
    }
  }
  // Reboard: a member that left a car without a bisect (supersede, infra) and rode a later one.
  const reboarded = new Set<string>();
  for (const b of visibleBuilds) {
    for (let i = 1; i < b.carIds.length; i++) {
      const prev = carViews.get(b.carIds[i - 1]!);
      const next = carViews.get(b.carIds[i]!);
      if (!prev || !next || bisectParent.get(next.trainId) === prev.trainId) continue;
      const key = `${prev.trainId}:${next.trainId}`;
      if (reboarded.has(key)) continue;
      reboarded.add(key);
      const from = { x: prev.endX ?? xNow, y: prev.y };
      const to = { x: next.x, y: next.y };
      if (to.x <= from.x) continue;
      edges.push({ id: `reboard:${key}`, kind: "reboard", d: sCurve(from, to), from, to, trainId: next.trainId, carId: prev.trainId, tone: "reboard", dashed: true, faded: true });
    }
  }

  // ── main ──
  const trunkFrom = { x: LEFT - 24, y: mainY };
  const trunkTo = { x: xNow, y: mainY };
  edges.unshift({ id: "main", kind: "main", d: straight(trunkFrom, trunkTo), from: trunkFrom, to: trunkTo, trainId: null, tone: "main" });
  const lastLabelEnd = [-Infinity, -Infinity];
  const SHA_W = 7 * g.charW + 6;
  for (const s of visibleShas) {
    const x = X(s.at);
    let labelRow = -1;
    for (const row of [0, 1]) {
      if (x - SHA_W / 2 >= lastLabelEnd[row]!) {
        labelRow = row;
        lastLabelEnd[row] = x + SHA_W / 2;
        break;
      }
    }
    nodes.push({ kind: "main", id: `main:${s.sha}`, x, y: mainY, sha: s.sha, labelRow, trainIds: s.trainIds, at: s.at });
  }
  const hidden = earlier.branches + earlier.cars;
  if (hidden > 0 || earlier.landings > 0) {
    nodes.push({
      kind: "stub",
      id: "stub",
      x: LEFT - 24,
      y: mainY,
      count: hidden,
      label: `+${hidden || earlier.landings} earlier`,
      detail: `${earlier.branches} branch${earlier.branches === 1 ? "" : "es"}, ${earlier.cars} car${earlier.cars === 1 ? "" : "s"} and ${earlier.landings} landing${earlier.landings === 1 ? "" : "s"} before this window`,
    });
  }

  // ── axis ──
  const ticks = timeTicks(X, wStart, now, win.spanMs);
  const height = Math.max(buildY(Math.max(buildRows, 1) - 1) + g.laneH / 2 + 30, queueY0 + 60);

  return {
    width: Math.ceil(axis.width),
    height: Math.ceil(height),
    mainY,
    xStart: LEFT,
    xNow,
    lanes,
    nodes,
    edges,
    cars: [...carViews.values()],
    branches,
    races,
    ticks,
    breaks: axis.breaks,
    earlier,
    landedInWindow: landedIds.size,
    liveBranches: branches.filter((b) => b.alive).length,
    charW: g.charW,
  };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const clock = (t: number) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** Clock ticks on round minutes, at least 64 px apart on the (non-linear) axis. */
function timeTicks(X: (t: number) => number, start: number, now: number, span: number): MergeGraphLayout["ticks"] {
  const step = span <= 3_600_000 ? 60_000 : span <= 6 * 3_600_000 ? 5 * 60_000 : 15 * 60_000;
  const out: MergeGraphLayout["ticks"] = [];
  let last = -Infinity;
  const nowX = X(now);
  for (let t = Math.ceil(start / step) * step; t <= now; t += step) {
    const x = X(t);
    if (x - last < 64 || nowX - x < 40) continue;
    out.push({ x, at: t, label: clock(t) });
    last = x;
  }
  out.push({ x: nowX, at: now, label: "now" });
  return out;
}

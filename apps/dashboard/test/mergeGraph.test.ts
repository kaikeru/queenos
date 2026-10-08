/** Merge-train graph layout (src/mergeGraph.ts): pure (state, window) → lanes, nodes, edges, cars. */
import { describe, expect, test } from "vitest";
import type { MergeTrain, QueenEvent, Race } from "@queenos/queen-types";
import { buildSwarmFixture } from "../src/mockQueen";
import { fit, mergeGraph, packLanes, type GraphSlice } from "../src/mergeGraph";
import { initialState, reducer, type Action } from "../src/reducer";
import { landedCount } from "../src/status";

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const NOW = T0 + 20 * MIN;
const sha = (c: string) => c.repeat(40).slice(0, 40);

let seq = 0;
const build = (id: string, over: Partial<MergeTrain> = {}): MergeTrain =>
  ({
    trainId: id,
    baseSha: sha("0"),
    includedPrompts: [`item-${id}`],
    artifactRepo: `r-${id}`,
    status: "BUILDING",
    phase: "BUILDING",
    lane: "BUILD",
    createdAt: T0,
    ...over,
  }) as MergeTrain;
const car = (id: string, members: string[], over: Partial<MergeTrain> = {}): MergeTrain =>
  build(id, { lane: "QUEUE", members, includedPrompts: members.map((m) => `item-${m}`), status: "BUILDING", phase: "BUILDING", ...over });
const ev = (type: QueenEvent["type"], ts: number, over: Partial<QueenEvent> = {}): QueenEvent => ({
  seq: ++seq,
  eventId: `e${seq}`,
  ts,
  hive: "h",
  type,
  severity: "info",
  actor: "queen",
  traceId: null,
  spanId: null,
  parentSpanId: null,
  itemId: null,
  trainId: null,
  releaseId: null,
  commandId: null,
  summary: type,
  data: null,
  ...over,
});

function slice(trains: MergeTrain[], events: QueenEvent[] = [], races: Race[] = []): GraphSlice {
  const items = Object.fromEntries(
    trains.filter((t) => t.lane !== "QUEUE").map((t) => [t.includedPrompts[0]!, { itemId: t.includedPrompts[0]!, title: `Title of ${t.trainId}` }]),
  ) as unknown as GraphSlice["items"];
  const sorted = [...trains].sort((a, b) => a.createdAt - b.createdAt);
  return {
    trains: Object.fromEntries(trains.map((t) => [t.trainId, t])),
    trainOrder: sorted.map((t) => t.trainId),
    items,
    races: Object.fromEntries(races.map((r) => [r.raceId, r])),
    events,
    landed: sorted.filter((t) => t.status === "MERGED" && t.landedSha).map((t) => ({ sha: t.landedSha!, trainId: t.trainId, promptId: t.includedPrompts.at(-1)! })),
  };
}
const layoutOf = (s: GraphSlice, spanMs = 60 * MIN) => mergeGraph(s, { now: NOW, spanMs });
const landedCar = (id: string, landedSha: string, at: number, members: string[] = []) => [
  car(id, members, { status: "MERGED", phase: "MERGED", landedSha, createdAt: at - 30_000 }),
  ev("queue.landed", at, { trainId: id, data: { carId: id, landedSha } }),
] as const;

describe("forks", () => {
  test("parallel forks from one main SHA get distinct lanes and all leave that main node", () => {
    const [k1, landed] = landedCar("k1", sha("a"), T0 + MIN);
    const builds = ["b1", "b2", "b3", "b4", "b5"].map((id) => build(id, { baseSha: sha("a"), createdAt: T0 + 2 * MIN }));
    const g = layoutOf(slice([k1, ...builds], [landed]));
    const main = g.nodes.find((n) => n.kind === "main" && n.sha === sha("a"))!;
    expect(main).toBeDefined();
    const bs = g.branches.filter((b) => b.trainId.startsWith("b"));
    expect(new Set(bs.map((b) => b.lane)).size).toBe(5);
    const forks = g.edges.filter((e) => e.kind === "fork");
    expect(forks).toHaveLength(5);
    for (const f of forks) {
      expect(f.sha).toBe(sha("a"));
      expect(f.from).toEqual({ x: main.x, y: g.mainY });
    }
    // Forked in the same instant: one start x, five rows.
    expect(new Set(bs.map((b) => b.x0)).size).toBe(1);
  });

  test("an unknown base forks from main at the fork time; a base outside the window starts at the left edge", () => {
    const g = layoutOf(slice([build("x", { baseSha: sha("f"), createdAt: T0 + 5 * MIN })]));
    const fork = g.edges.find((e) => e.kind === "fork")!;
    expect(fork.sha).toBeUndefined();
    expect(fork.from.y).toBe(g.mainY);
    expect(fork.to.x).toBeGreaterThan(fork.from.x);
    expect(g.branches[0]!.forkSha).toBeNull();
  });
});

describe("cars", () => {
  test("a 4-member car has 4 edges converging on its node", () => {
    const members = ["m1", "m2", "m3", "m4"];
    const trains = [...members.map((id, i) => build(id, { createdAt: T0 + i * 10_000, phase: "PASSED", status: "TESTING", carId: "k" })), car("k", members, { createdAt: T0 + 3 * MIN })];
    const g = layoutOf(slice(trains));
    const node = g.cars.find((c) => c.trainId === "k")!;
    const boards = g.edges.filter((e) => e.kind === "board" && e.carId === "k");
    expect(boards).toHaveLength(4);
    for (const b of boards) expect(b.to).toEqual({ x: node.x, y: node.y });
    expect(new Set(boards.map((b) => b.from.y)).size).toBe(4);
    expect(node.members).toEqual(members);
    expect(node.label).toBe("K1");
  });

  test("stacked cars chain: each hangs off the car ahead, the first off main (events)", () => {
    const at = T0 + 4 * MIN;
    const trains = [car("k1", ["a"], { createdAt: at }), car("k2", ["b"], { createdAt: at }), car("k3", ["c"], { createdAt: at }), build("a"), build("b"), build("c")];
    const events = [
      ev("queue.car", at, { trainId: "k1", data: { carId: "k1", members: ["a"], predecessorCarId: null, bisectOf: null } }),
      ev("queue.car", at, { trainId: "k2", data: { carId: "k2", members: ["b"], predecessorCarId: "k1", bisectOf: null } }),
      ev("queue.car", at, { trainId: "k3", data: { carId: "k3", members: ["c"], predecessorCarId: "k2", bisectOf: null } }),
    ];
    const g = layoutOf(slice(trains, events));
    const stack = (id: string) => g.edges.find((e) => e.kind === "stack" && e.trainId === id)!;
    expect(stack("k1").carId).toBeUndefined();
    expect(stack("k1").from.y).toBe(g.mainY);
    expect(stack("k2").carId).toBe("k1");
    expect(stack("k3").carId).toBe("k2");
    // Formed in one instant: staggered left to right, each on its own row.
    const [c1, c2, c3] = ["k1", "k2", "k3"].map((id) => g.cars.find((c) => c.trainId === id)!);
    expect(c1!.x).toBeLessThan(c2!.x);
    expect(c2!.x).toBeLessThan(c3!.x);
    expect(new Set([c1!.lane, c2!.lane, c3!.lane]).size).toBe(3);
  });

  test("without events, a car stacks on the newest earlier car still live", () => {
    const trains = [
      car("k1", ["a"], { createdAt: T0 + MIN, phase: "TESTING", status: "TESTING" }),
      car("k2", ["b"], { createdAt: T0 + 2 * MIN }),
      build("a"),
      build("b"),
    ];
    const g = layoutOf(slice(trains));
    expect(g.cars.find((c) => c.trainId === "k2")!.predecessor).toBe("k1");
    expect(g.cars.find((c) => c.trainId === "k1")!.predecessor).toBeNull();
  });

  test("a landed car connects back into main at its landedSha", () => {
    const [k, landed] = landedCar("k", sha("c"), T0 + 6 * MIN, ["a", "b"]);
    const trains = [k, build("a", { status: "MERGED", phase: "MERGED", landedSha: sha("c"), carId: "k" }), build("b", { status: "MERGED", phase: "MERGED", landedSha: sha("c"), carId: "k" })];
    const g = layoutOf(slice(trains, [landed]));
    const node = g.nodes.find((n) => n.kind === "main" && n.sha === sha("c"))!;
    const land = g.edges.find((e) => e.kind === "land" && e.trainId === "k")!;
    expect(land.sha).toBe(sha("c"));
    expect(land.to).toEqual({ x: node.x, y: g.mainY });
    expect(g.nodes.filter((n) => n.kind === "main")).toHaveLength(1);
    expect(g.cars[0]!.tone).toBe("merged");
  });

  test("a fast-forward car is badged; infra retries are counted", () => {
    const trains = [build("a", { carId: "k" }), car("k", ["a"], { createdAt: T0 + MIN, phase: "PASSED", status: "TESTING" })];
    const events = [
      ev("queue.merged", T0 + MIN + 5000, { trainId: "k", data: { merged: ["a"], conflicts: [], fastForward: true } }),
      ev("train.phase", T0 + MIN + 9000, { trainId: "k", data: { from: "TESTING", to: "DEPLOYING", infraRetry: 1 } }),
      ev("train.phase", T0 + MIN + 19_000, { trainId: "k", data: { from: "TESTING", to: "DEPLOYING", infraRetry: 2 } }),
    ];
    const k = layoutOf(slice(trains, events)).cars[0]!;
    expect(k.fastForward).toBe(true);
    expect(k.infraRetries).toBe(2);
  });
});

describe("failure stories", () => {
  const failed = (members: string[]) => car("f", members, { createdAt: T0 + 2 * MIN, status: "EJECTED", phase: "TESTING", reason: "failed: integration smoke" });

  test("a bisect forks the failed car into two half nodes, the culprit half failed", () => {
    const m = ["a", "b", "c", "d"];
    const trains = [
      ...m.map((id) => build(id)),
      failed(m),
      car("h1", ["a", "b"], { createdAt: T0 + 4 * MIN, status: "MERGED", phase: "MERGED", landedSha: sha("1") }),
      car("h2", ["c", "d"], { createdAt: T0 + 4 * MIN, status: "EJECTED", phase: "TESTING", reason: "failed: integration smoke" }),
    ];
    const events = [
      ev("queue.bisect", T0 + 4 * MIN, { trainId: "f", data: { carId: "f", halves: [["a", "b"], ["c", "d"]] } }),
      ev("queue.car", T0 + 4 * MIN, { trainId: "h1", data: { carId: "h1", members: ["a", "b"], predecessorCarId: null, bisectOf: "f" } }),
      ev("queue.car", T0 + 4 * MIN, { trainId: "h2", data: { carId: "h2", members: ["c", "d"], predecessorCarId: "h1", bisectOf: "f" } }),
      ev("queue.landed", T0 + 6 * MIN, { trainId: "h1", data: { carId: "h1" } }),
    ];
    const g = layoutOf(slice(trains, events));
    const halves = g.nodes.filter((n) => n.kind === "car" && n.half);
    expect(halves.map((n) => (n.kind === "car" ? n.label : ""))).toEqual(["K1a", "K1b"]);
    const f = g.cars.find((c) => c.trainId === "f")!;
    expect(f.tone).toBe("failed");
    expect(f.halves).toEqual(["h1", "h2"]);
    expect(g.edges.filter((e) => e.kind === "bisect" && e.carId === "f")).toHaveLength(2);
    expect(g.cars.find((c) => c.trainId === "h2")!.culprit).toBe(true);
    expect(g.cars.find((c) => c.trainId === "h1")!.culprit).toBe(false);
    expect(g.edges.find((e) => e.kind === "car" && e.trainId === "f")!.dashed).toBe(true);
  });

  test("bisect halves are inferred from member subsets when the events are gone", () => {
    const m = ["a", "b", "c", "d"];
    const trains = [...m.map((id) => build(id)), failed(m), car("h1", ["a", "b"], { createdAt: T0 + 4 * MIN }), car("h2", ["c", "d"], { createdAt: T0 + 4 * MIN })];
    const g = layoutOf(slice(trains));
    expect(g.cars.find((c) => c.trainId === "f")!.halves).toEqual(["h1", "h2"]);
    expect(g.cars.find((c) => c.trainId === "h2")!.label).toBe("K1b");
  });

  test("a conflict is a marker where the member's line leaves the car, with its paths", () => {
    const conflict = { trainId: "c", kind: "content" as const, paths: ["src/lib/shared.js"], summary: "both edit shared.js" };
    const trains = [
      build("a", { carId: "k", phase: "PASSED", status: "TESTING" }),
      build("c", { status: "EJECTED", phase: "PASSED", conflict, reason: "merge conflict" }),
      car("k", ["a"], { createdAt: T0 + 3 * MIN, phase: "TESTING", status: "TESTING" }),
      build("c2", { includedPrompts: ["item-c"], createdAt: T0 + 5 * MIN, waitForCarSeq: 7 }),
    ];
    const events = [
      ev("queue.car", T0 + 3 * MIN, { trainId: "k", data: { carId: "k", members: ["a", "c"], predecessorCarId: null } }),
      ev("queue.conflict", T0 + 3 * MIN + 5000, { trainId: "c", data: { carId: "k", kind: "content", paths: ["src/lib/shared.js"] } }),
    ];
    const g = layoutOf(slice(trains, events));
    const marker = g.nodes.find((n) => n.kind === "conflict")!;
    expect(marker).toMatchObject({ trainId: "c", carId: "k", paths: ["src/lib/shared.js"] });
    const branch = g.branches.find((b) => b.trainId === "c")!;
    expect(marker.x).toBe(branch.x1);
    expect(g.edges.find((e) => e.kind === "board" && e.trainId === "c")).toMatchObject({ carId: "k", tone: "conflict", dashed: true });
    const k = g.cars.find((c) => c.trainId === "k")!;
    expect(k.members).toEqual(["a", "c"]);
    expect(k.conflicts.map((c) => c.trainId)).toEqual(["c"]);
    // The rework re-forks from main and is linked to the failed attempt.
    expect(g.branches.find((b) => b.trainId === "c2")!.rework).toBe(true);
    expect(g.edges.some((e) => e.kind === "rework" && e.trainId === "c2")).toBe(true);
  });

  test("a superseded car is greyed out", () => {
    const trains = [build("a"), car("s", ["a"], { createdAt: T0 + 3 * MIN, status: "EJECTED", phase: "BUILDING", reason: "superseded: car f failed" })];
    const g = layoutOf(slice(trains));
    const s = g.cars[0]!;
    expect(s.tone).toBe("superseded");
    expect(s.phase).toBe("SUPERSEDED");
    expect(g.edges.find((e) => e.kind === "car" && e.trainId === "s")!.faded).toBe(true);
  });

  test("race candidates are adjacent rows in one bracket; the winner is starred, losers faded", () => {
    const race: Race = { raceId: "r", itemId: "item-w", width: 3, state: "DECIDED", trainIds: ["r0", "r1", "r2"], winnerTrainId: "r1", reason: "won", deadlineAt: null, createdAt: T0, decidedAt: T0 + MIN };
    const trains = [
      build("other", { createdAt: T0 }),
      ...[0, 1, 2].map((i) =>
        build(`r${i}`, { includedPrompts: ["item-w"], raceId: "r", candidate: i, createdAt: T0 + MIN, ...(i === 1 ? { raceOutcome: "WON", phase: "PASSED", status: "TESTING" } : { raceOutcome: "LOST", status: "EJECTED", reason: "lost race to r1" }) }),
      ),
    ];
    const g = layoutOf(slice(trains, [], [race]));
    const rs = [0, 1, 2].map((i) => g.branches.find((b) => b.trainId === `r${i}`)!);
    const lanes = rs.map((b) => b.lane).sort((a, b) => a - b);
    expect(lanes[2]! - lanes[0]!).toBe(2);
    expect(rs[1]!.winner).toBe(true);
    expect(rs[1]!.label.startsWith("★")).toBe(true);
    expect(rs[0]!.loser && rs[2]!.loser).toBe(true);
    expect(g.races).toHaveLength(1);
    expect(g.edges.find((e) => e.kind === "branch" && e.trainId === "r0")!.faded).toBe(true);
  });
});

describe("lanes and window", () => {
  test("rows are reused once a branch has finished", () => {
    const trains = [
      build("a", { createdAt: T0, status: "EJECTED", phase: "BUILDING", reason: "failed: x" }),
      build("b", { createdAt: T0 + 30_000 }),
      build("c", { createdAt: T0 + 8 * MIN }),
    ];
    const g = layoutOf(slice(trains, [ev("train.phase", T0 + 2 * MIN, { trainId: "a", data: { from: "BUILDING", to: "EJECTED" } })]));
    const lane = (id: string) => g.branches.find((b) => b.trainId === id)!.lane;
    expect(lane("a")).toBe(0);
    expect(lane("b")).toBe(1);
    expect(lane("c")).toBe(0);
    expect(g.lanes.filter((l) => l.band === "build")).toHaveLength(2);
  });

  test("packLanes keeps a multi-row unit contiguous", () => {
    expect(packLanes([{ size: 1, x0: 0, x1: 100 }, { size: 2, x0: 10, x1: 50 }, { size: 1, x0: 200, x1: 300 }])).toEqual([0, 1, 0]);
  });

  test("history that ended before the window collapses into a '+N earlier' stub", () => {
    const [old, oldLanded] = landedCar("old", sha("9"), T0 - 3 * 3_600_000, ["o1"]);
    const trains = [
      old,
      build("o1", { createdAt: T0 - 4 * 3_600_000, status: "MERGED", phase: "MERGED", landedSha: sha("9"), carId: "old" }),
      build("o2", { createdAt: T0 - 4 * 3_600_000, status: "EJECTED", phase: "BUILDING", reason: "failed" }),
      build("long", { createdAt: T0 - 2 * 3_600_000 }),
      build("new", { createdAt: T0 + 5 * MIN }),
    ];
    const events = [oldLanded, ev("train.phase", T0 - 3.9 * 3_600_000, { trainId: "o2", data: { to: "EJECTED" } })];
    const g = mergeGraph(slice(trains, events), { now: NOW, spanMs: 30 * MIN });
    expect(g.earlier).toEqual({ branches: 2, cars: 1, landings: 1 });
    const stub = g.nodes.find((n) => n.kind === "stub")!;
    expect(stub).toMatchObject({ count: 3, label: "+3 earlier" });
    expect(g.branches.map((b) => b.trainId).sort()).toEqual(["long", "new"]);
    const long = g.branches.find((b) => b.trainId === "long")!;
    expect(long.clippedLeft).toBe(true);
    expect(long.x0).toBe(g.xStart);
    expect(g.edges.some((e) => e.kind === "fork" && e.trainId === "long")).toBe(false);
    // The same state over 24 h shows everything and no stub.
    const day = mergeGraph(slice(trains, events), { now: NOW, spanMs: 24 * 3_600_000 });
    expect(day.nodes.some((n) => n.kind === "stub")).toBe(false);
    expect(day.branches).toHaveLength(4);
    expect(day.breaks.length).toBeGreaterThan(0);
  });

  test("40+ concurrent branches stay one row each and everything stays in bounds", () => {
    const trains = Array.from({ length: 44 }, (_, i) => build(`p${i}`, { createdAt: T0 + i * 1000 }));
    const g = layoutOf(slice(trains));
    expect(g.liveBranches).toBe(44);
    expect(new Set(g.branches.map((b) => b.lane)).size).toBe(44);
    for (const b of g.branches) {
      expect(b.x1).toBeLessThanOrEqual(g.width);
      expect(b.y).toBeLessThan(g.height);
    }
  });

  test("label truncation", () => {
    expect(fit("Add a /features/otter endpoint", 12)).toBe("Add a /feat…");
    expect(fit("short", 12)).toBe("short");
    expect(fit("anything", 2)).toBe("");
  });
});

describe("live state", () => {
  test("the reducer records when it saw a train end; the graph uses it", () => {
    const at = (n: number) => T0 + n * MIN;
    const server = (message: unknown, t: number) => ({ type: "server", message, at: t }) as unknown as Action;
    const t = build("a", { createdAt: at(1) });
    let s = reducer(initialState, server({ type: "snapshot", promptRuns: [], trains: [], recentAudit: [] }, at(0)));
    s = reducer(s, server({ type: "train.updated", train: t }, at(1)));
    s = reducer(s, server({ type: "train.updated", train: { ...t, phase: "TESTING", status: "TESTING" } }, at(2)));
    expect(s.trainTimes.a).toMatchObject({ phaseAt: at(2), endedAt: null });
    s = reducer(s, server({ type: "train.updated", train: { ...t, phase: "EJECTED", status: "EJECTED", reason: "failed: x" } }, at(3)));
    expect(s.trainTimes.a!.endedAt).toBe(at(3));
    const g = mergeGraph(s, { now: at(10), spanMs: 30 * MIN });
    expect(g.branches[0]!.approx).toBe(false);
    expect(g.branches[0]!.tone).toBe("ejected");
  });

  test("the mock swarm fixture lays out with finite coordinates", () => {
    const fx = buildSwarmFixture("demo", NOW);
    const s = reducer(initialState, {
      type: "server",
      at: NOW,
      message: { type: "snapshot", promptRuns: [], trains: fx.trains, recentAudit: [], items: fx.items, races: fx.races, escalations: fx.escalations, hive: fx.hive, recentEvents: fx.events },
    } as unknown as Action);
    const g = mergeGraph(s, { now: NOW, spanMs: 30 * MIN, density: "compact" });
    expect(g.cars.length).toBeGreaterThanOrEqual(5);
    expect(g.nodes.some((n) => n.kind === "conflict")).toBe(true);
    expect(g.cars.find((c) => c.trainId === "c-k40")!.bisectOf).toBe("c-k39");
    for (const e of g.edges) expect(e.d).not.toMatch(/NaN|Infinity/);
    for (const n of g.nodes) expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
  });
});

test("a short history stretches to fill the box, never past it", () => {
  const trains = Array.from({ length: 6 }, (_, i) => build(`q${i}`, { createdAt: T0 + 10 * MIN + i * 1000 }));
  const tight = mergeGraph(slice(trains), { now: NOW, spanMs: 30 * MIN, density: "compact" });
  const fit = mergeGraph(slice(trains), { now: NOW, spanMs: 30 * MIN, density: "compact", fitWidth: 1200 });
  expect(fit.width).toBeGreaterThan(tight.width);
  expect(fit.width).toBeLessThanOrEqual(1200);
  expect(fit.branches[5]!.x0).toBeGreaterThan(tight.branches[5]!.x0);
});

test("an ejected car with no recorded end is bounded by its members re-boarding", () => {
  const trains = [build("a"), build("b"), car("f", ["a", "b"], { createdAt: T0 + MIN, status: "EJECTED", phase: "TESTING", reason: "failed: x" }), car("h", ["a"], { createdAt: T0 + MIN + 20_000 })];
  const g = layoutOf(slice(trains));
  const f = g.cars.find((c) => c.trainId === "f")!;
  expect(f.endedAt).toBe(T0 + MIN + 20_000);
  expect(f.approx).toBe(true);
});

test("main nodes follow landing time even when the landed list is in creation order (snapshot)", () => {
  const [k1, l1] = landedCar("k1", sha("1"), T0 + 2 * MIN, ["early"]);
  const [k2, l2] = landedCar("k2", sha("2"), T0 + 5 * MIN, ["late"]);
  const trains = [k1, k2, build("early", { createdAt: T0 + MIN, status: "MERGED", phase: "MERGED", landedSha: sha("2"), carId: "k2" }), build("late", { createdAt: T0 + 90_000, status: "MERGED", phase: "MERGED", landedSha: sha("1"), carId: "k1" })];
  const g = layoutOf(slice(trains, [l1, l2]));
  const x = (c: string) => g.nodes.find((n) => n.kind === "main" && n.sha === sha(c))!.x;
  expect(x("1")).toBeLessThan(x("2"));
});

test("landedInWindow counts only landings inside the window (the strip's 'N landed in 30 min')", () => {
  // An old batched car of 2 (hours ago), a recent car of 3, and a direct (unqueued) recent landing.
  const [old, oldLanded] = landedCar("old", sha("9"), T0 - 3 * 3_600_000, ["o1", "o2"]);
  const [k, kLanded] = landedCar("k", sha("c"), T0 + 10 * MIN, ["a", "b", "c"]);
  const merged = (id: string, s: string, over: Partial<MergeTrain> = {}) => build(id, { status: "MERGED", phase: "MERGED", landedSha: s, ...over });
  const trains = [
    old,
    merged("o1", sha("9"), { carId: "old", createdAt: T0 - 4 * 3_600_000 }),
    merged("o2", sha("9"), { carId: "old", createdAt: T0 - 4 * 3_600_000 }),
    k,
    merged("a", sha("c"), { carId: "k" }),
    merged("b", sha("c"), { carId: "k" }),
    merged("c", sha("c"), { carId: "k" }),
    merged("d", sha("d"), { createdAt: T0 + 12 * MIN }),
  ];
  const events = [oldLanded, kLanded, ev("train.phase", T0 + 14 * MIN, { trainId: "d", data: { to: "MERGED" } })];
  const s = slice(trains, events);
  expect(landedCount(s)).toBe(6); // what the old label counted, window or not
  expect(mergeGraph(s, { now: NOW, spanMs: 30 * MIN }).landedInWindow).toBe(4);
  expect(mergeGraph(s, { now: NOW, spanMs: 24 * 3_600_000 }).landedInWindow).toBe(6);
  // Nothing recent: a quiet hour later the 30-minute count is 0, not the session total.
  expect(mergeGraph(s, { now: NOW + 2 * 3_600_000, spanMs: 30 * MIN }).landedInWindow).toBe(0);
});

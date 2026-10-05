/** v2 data layer: reducer v2 messages, swarm and status selectors, against the mock swarm fixture. */
import { expect, test } from "vitest";
import { QueenServerMessageSchema } from "@queenos/queen-types";
import { buildSwarmFixture } from "../src/mockQueen";
import { initialState, reducer, type Action, type State } from "../src/reducer";
import {
  floorSummary,
  itemSubState,
  queueRail,
  raceView,
  raceViewForItem,
  recentBisects,
  recentConflicts,
  swarmFloor,
  waitingToBoard,
} from "../src/swarm";
import { blockedOrFailed, goalTrees, headline, openEscalations, pipelineCounts, statusTiles } from "../src/status";

const NOW = 1_800_000_000_000;
const fx = buildSwarmFixture("demo", NOW);
const server = (message: unknown, at = NOW) => ({ type: "server", message, at }) as unknown as Action;
const snapshot = () => ({
  type: "snapshot",
  promptRuns: [],
  trains: fx.trains,
  recentAudit: [],
  items: fx.items,
  races: fx.races,
  escalations: fx.escalations,
  hive: fx.hive,
  recentEvents: fx.events,
});
const loaded = (): State => reducer(initialState, server(snapshot()));

test("the mock swarm fixture validates against the wire contract", () => {
  expect(QueenServerMessageSchema.safeParse(snapshot()).success).toBe(true);
  for (const step of fx.steps) expect(QueenServerMessageSchema.safeParse({ type: "batch", messages: step.messages }).success).toBe(true);
});

test("the snapshot carries items, races, escalations, hive status and events", () => {
  const s = loaded();
  expect(Object.keys(s.items)).toHaveLength(fx.items.length);
  expect(s.itemOrder[0]).toBe("g1");
  expect(s.races["race-1"]?.state).toBe("RACING");
  expect(openEscalations(s)).toHaveLength(1);
  expect(s.hive?.headline).toBe("NEEDS_YOU");
  expect(s.events.map((e) => e.seq)).toEqual([...s.events.map((e) => e.seq)].sort((a, b) => a - b));
});

test("an older Queen's snapshot keeps v2 state empty and does not wipe live v2 state", () => {
  const v1 = reducer(initialState, server({ type: "snapshot", promptRuns: [], trains: [], recentAudit: [] }));
  expect(v1.items).toEqual({});
  expect(v1.hive).toBeNull();
  const reconnect = reducer(loaded(), server({ type: "snapshot", promptRuns: [], trains: [], recentAudit: [] }));
  expect(Object.keys(reconnect.items)).toHaveLength(fx.items.length);
});

test("item, race, escalation, hive and event deltas apply; stale frames are dropped", () => {
  let s = loaded();
  const it = s.items["g1-c3"]!;
  s = reducer(s, server({ type: "item.updated", item: { ...it, status: "ACTIVE", waitReason: null, updatedAt: it.updatedAt + 10 } }));
  expect(s.items["g1-c3"]!.status).toBe("ACTIVE");
  const stale = reducer(s, server({ type: "item.updated", item: { ...it, updatedAt: it.updatedAt - 10 } }));
  expect(stale).toBe(s);

  const esc = s.escalations["esc-1"]!;
  s = reducer(s, server({ type: "escalation.updated", escalation: { ...esc, status: "RESOLVED", resolvedAt: NOW, resolvedBy: "kyle", resolution: "shipped" } }));
  expect(openEscalations(s)).toHaveLength(0);
  expect(s.ticker[0]!.text).toContain("Resolved SENTINEL_INCONCLUSIVE");

  s = reducer(s, server({ type: "hive.updated", hive: { ...fx.hive, effectiveAutonomy: "supervised", degradedBy: ["ERROR_BUDGET_EXHAUSTED"] } }));
  expect(s.hive?.effectiveAutonomy).toBe("supervised");
  expect(s.ticker[0]!.text).toContain("supervised");

  const ev = { ...fx.events[0]!, seq: 99, eventId: "ev-99" };
  const once = reducer(s, server({ type: "event.appended", event: ev }));
  expect(once.events.at(-1)!.seq).toBe(99);
  expect(reducer(once, server({ type: "event.appended", event: ev }))).toBe(once);
});

test("a batch frame is applied atomically as one new state", () => {
  const s = loaded();
  const seen: State[] = [];
  const batch = fx.steps[1]!.messages;
  const next = reducer(s, server({ type: "batch", messages: batch }));
  seen.push(next);
  // Every message landed...
  expect(next.trains["t-s15"]!.phase).toBe("PASSED");
  expect(next.events.some((e) => e.seq === 8)).toBe(true);
  // ...and the input state is untouched (pure).
  expect(s.trains["t-s15"]!.phase).toBe("TESTING");
  // An empty batch is a no-op.
  expect(reducer(s, server({ type: "batch", messages: [] }))).toBe(s);
});

test("swarm floor: 20+ builds grouped by phase, race candidates together", () => {
  const f = swarmFloor(loaded());
  expect(f.total).toBeGreaterThanOrEqual(20);
  expect(f.collapsed).toBe(false);
  const count = (g: string) => f.groups.find((x) => x.group === g)!.count;
  expect(count("building")).toBe(13);
  expect(count("deploying")).toBe(2);
  expect(count("gating")).toBe(5);
  expect(count("racing")).toBe(3);
  expect(f.races).toBe(1);
  expect(f.waitingOnPaths.map((i) => i.itemId)).toEqual(["g1-c3"]);
  expect(floorSummary(f)).toContain("racing 3 (1 race)");
  expect(floorSummary(f)).toContain("waiting on paths 1");
  const racing = f.groups.find((g) => g.group === "racing")!.tiles;
  expect(racing.map((t) => t.candidate)).toEqual([0, 1, 2]);
  expect(racing[0]!.title).toBe("Dark mode toggle");
});

test("swarm floor collapses above 120 tiles", () => {
  let s = loaded();
  const base = fx.trains.find((t) => t.trainId === "t-s1")!;
  for (let i = 0; i < 100; i++) s = reducer(s, server({ type: "train.updated", train: { ...base, trainId: `x${i}`, artifactRepo: `r${i}` } }));
  expect(swarmFloor(s).collapsed).toBe(true);
});

test("queue rail: cars in order with members, then waiting to board", () => {
  const rail = queueRail(loaded());
  expect(rail.cars.map((c) => c.train.trainId)).toEqual(["c-k41", "c-k42", "c-k43"]);
  expect(rail.cars.map((c) => c.phase)).toEqual(["LANDING", "GATING", "MERGING"]);
  expect(rail.cars.map((c) => c.members.length)).toEqual([4, 2, 1]);
  expect(rail.cars[0]!.members[0]!.title).toBeTruthy();
  expect(rail.cars.every((c) => c.label.startsWith("K"))).toBe(true);
  expect(rail.main?.sha).toBeTruthy();
  expect(rail.waiting).toHaveLength(2);
  expect(waitingToBoard(loaded()).map((w) => w.passedSeq)).toEqual([8, 9]);
});

test("conflicts and bisects come from the event log and ejected trains", () => {
  const s = loaded();
  const [c] = recentConflicts(s);
  expect(c!.paths).toEqual(["src/lib/format.js"]);
  expect(c!.itemId).toBe("s29");
  expect(c!.traceId).toBeTruthy();
  const [b] = recentBisects(s);
  expect(b!.trainId).toBe("c-k39");
  expect(b!.data?.halves).toHaveLength(2);
  // Without events, the ejected train's `conflict` still tells the story.
  const noEvents = { ...s, events: [] };
  expect(recentConflicts(noEvents)[0]!.trainId).toBe("t-s29-a");
  expect(recentBisects(noEvents)).toEqual([]);
});

test("race view: candidates, standing, winner after a decision", () => {
  let s = loaded();
  const r = raceView(s, "race-1", NOW)!;
  expect(r.candidates.map((c) => c.outcome)).toEqual(["PASSED", "PASSED", "RACING"]);
  expect(r.passed).toBe(2);
  expect(r.decidingInMs).toBe(41_000);
  expect(raceViewForItem(s, "g1-c2", NOW)!.race.raceId).toBe("race-1");
  s = reducer(s, server({ type: "batch", messages: fx.steps[3]!.messages }));
  const d = raceView(s, "race-1", NOW)!;
  expect(d.candidates.find((c) => c.winner)!.train.trainId).toBe("t-g1c2-0");
  expect(d.decidingInMs).toBeNull();
  expect(d.reason).toContain("smaller diff");
  expect(swarmFloor(s).races).toBe(0);
});

test("item sub-states", () => {
  const s = loaded();
  const sub = (id: string) => itemSubState(s, s.items[id]!);
  expect(sub("g1-c2")).toBe("racing");
  expect(sub("s1")).toBe("building");
  expect(sub("s15")).toBe("gating");
  expect(sub("s20")).toBe("landing");
  expect(sub("s24")).toBe("merging");
  expect(sub("s27")).toBe("queued");
  expect(sub("s29")).toBe("reworking (conflict)");
  expect(sub("g1-c3")).toBeNull();
});

test("headline, pipeline counts and tiles", () => {
  const s = loaded();
  const h = headline(s);
  expect(h.kind).toBe("NEEDS_YOU");
  expect(h.text).toBe("NEEDS YOU · 24 building · 3 in the merge queue · 1 needs you · landed 31 today");
  expect(pipelineCounts(s).ACTIVE).toBe(33);
  expect(pipelineCounts({ ...s, hive: null }).SHIPPED).toBe(1);
  const t = statusTiles(s);
  expect(t.slots).toEqual({ used: 24, total: 24, leased: 24 });
  expect(t.credits).toEqual({ used: 31_000, limit: 50_000 });
  expect(t.errorBudget?.remaining).toBe(1);
});

test("headline derives from state when the Queen sends no hive status", () => {
  const s = { ...loaded(), hive: null };
  expect(headline(s).kind).toBe("NEEDS_YOU");
  const resolved = { ...s, escalations: {}, escalationOrder: [] };
  expect(headline(resolved).kind).toBe("SHIPPING");
  expect(headline(initialState).kind).toBe("IDLE");
  expect(headline(initialState).text).toBe("IDLE · landed 0 today");
});

test("goal trees: children, rollups, race, blocked-by and loose items", () => {
  const { goals, loose } = goalTrees(loaded(), NOW);
  expect(goals).toHaveLength(1);
  const g = goals[0]!;
  expect(g.children.map((c) => c.item.itemId)).toEqual(["g1-c1", "g1-c2", "g1-c3", "g1-c4", "g1-c5"]);
  expect(g.total).toBe(5);
  expect(g.shipped).toBe(1);
  expect(g.children[1]!.race?.race.raceId).toBe("race-1");
  expect(g.children[2]!.note).toContain("affinity");
  expect(g.children[3]!.blockedBy).toEqual(["Dark mode toggle"]);
  expect(g.children[3]!.note).toBe("needs: Dark mode toggle");
  expect(loose.length).toBe(fx.items.length - 6);
  expect(loose.every((n) => n.item.kind !== "goal")).toBe(true);
});

test("blocked and failed rows", () => {
  const rows = blockedOrFailed(loaded(), NOW).map((r) => r.item.itemId);
  expect(rows).toContain("s30");
  expect(rows).toContain("g1-c4");
});

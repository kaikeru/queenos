/** Dashboard redesign U1: race-true labels (spec §4.4, §7). One module labels races, candidates, goal rows, Needs you and tiles. */
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { reworkReasonText, type HiveStatus, type MergeTrain, type Race, type RaceState, type WorkItem } from "@queenos/queen-types";

import { CandidateActions, RacePick, RejectAll } from "../src/RacePick";
import {
  agentTiles, candChipClass, candidateRows, candidateStatus, cardItems, cardSummary, contributorKey, currentCandidates, firstFinding, goalRow, goalRows, goalStatus, goalSummary,
  attemptLabel, homeHeadline, isFollowUp, pickingRows, pushCommand, raceChipClass, raceStatus, racesForItem, rootOf, titleSlug, trackFresh, whoOf, withDetail, type StatusSlice,
} from "../src/raceStatus";
import { initialState } from "../src/reducer";
import { raceView } from "../src/swarm";

const NOW = 1_800_000_000_000;
const SHA = "0".repeat(40);

const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  itemId: "i1", hive: "demo", kind: "feature", title: "Rename morse key", body: "", acceptance: [], priority: 2, status: "ACTIVE", parentId: null, rootId: over.itemId ?? "i1", depth: 0,
  dependsOn: [], source: { kind: "user", actor: "kyle@example.com" }, traceId: "a".repeat(32), spanId: "b".repeat(16), difficulty: "normal", bestOf: null, attempts: 0, conflicts: 0,
  paths: [], waitReason: null, duplicateOf: null, blockedReason: null, releaseId: null, escalationId: null, createdAt: NOW - 600_000, updatedAt: NOW - 600_000, ...over,
});
const race = (over: Partial<Race> = {}): Race => ({
  raceId: "r1", itemId: "i1", width: 1, state: "RACING", trainIds: [], winnerTrainId: null, reason: null, deadlineAt: null, createdAt: NOW - 300_000, decidedAt: null, ...over,
});
const agent = (name: string, model = "sonnet") => ({ kind: "agent" as const, id: `${name}@kyle@example.com`, model });
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
    const OPEN: RaceState[] = ["RACING", "PICKING", "REWORKING"];
    for (const state of STATES) {
      const r = race({ state });
      const open = OPEN.includes(state);
      expect(candidateStatus(train("a", { raceOutcome: "PASSED" }), r, NOW).kind).toBe(open ? "passed" : "lost");
      expect(candidateStatus(train("a", { raceOutcome: "FAILED", status: "EJECTED", summary: "lint: unexpected token\nmore" }), r, NOW).text).toBe("failed: lint: unexpected token");
      expect(candidateStatus(train("a", { raceOutcome: "LOST", status: "EJECTED" }), r, NOW).kind).toBe("lost");
      const rework = candidateStatus(train("a", { raceOutcome: "REWORK", status: "EJECTED", reason: reworkReasonText("human", NOW + 60_000, "x") }), r, NOW);
      if (open) expect(rework.text).toBe("reworking · human · due in 1:00");
      else expect(rework.kind).toBe("lost");
    }
  });
  test("a closed race reads lost for a non-winner still running or reworking", () => {
    const running = train("a", { raceOutcome: null, status: "TESTING" });
    expect(candidateStatus(running, race({ state: "RACING" }), NOW).kind).toBe("gating");
    expect(candidateStatus(running, race({ state: "DECIDED", winnerTrainId: "w" }), NOW).kind).toBe("lost");
    const rw = candidateStatus(train("a", { raceOutcome: "REWORK", status: "EJECTED", reason: reworkReasonText("human", NOW + 60_000, "x") }), race({ state: "DECIDED", winnerTrainId: "w" }), NOW);
    expect(rw.kind).toBe("lost");
    expect(rw.text).not.toContain("due in");
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
    const r = race({ state: "PICKING", rejections: [{ trainId: "a", by: "human:k@example.org", reason: "ugly" }] });
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
    expect(contributorKey(x)).toBe("agent:w1@kyle@example.com#att_1");
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

describe("attemptLabel", () => {
  test("old heads are superseded; no race falls back to the outcome", () => {
    const rw = train("a", { raceOutcome: "REWORK", status: "EJECTED", reason: reworkReasonText("human", NOW + 60_000, "x") });
    expect(attemptLabel(rw, race({ state: "DECIDED", winnerTrainId: "w" }), NOW, true)).toBe("superseded");
    expect(attemptLabel(train("a", { raceId: "gone", raceOutcome: "PASSED" }), null, NOW, false)).toBe("passed");
    expect(attemptLabel(train("a", { status: "MERGED", raceOutcome: null }), undefined, NOW, false)).toBe("landed");
    expect(attemptLabel(train("a", { status: "EJECTED", raceOutcome: null, summary: "lint: x" }), null, NOW, false)).toBe("failed: lint: x");
  });
});

describe("who", () => {
  test("agent name@owner with its claim, a human's local part, a drone's model or tag", () => {
    expect(whoOf({ origin: agent("w1", "opus"), model: null, candidate: 0 })).toEqual({ who: "w1@kyle", claim: "opus" });
    expect(whoOf({ origin: { kind: "agent", id: "solo" }, model: null, candidate: 0 })).toEqual({ who: "solo", claim: null });
    expect(whoOf({ origin: { kind: "human", id: "kyle@example.com" }, model: null, candidate: 0 })).toEqual({ who: "kyle", claim: null });
    expect(whoOf({ origin: null, model: "kimi-k2", candidate: 0 })).toEqual({ who: "kimi-k2", claim: null });
    expect(whoOf({ origin: undefined, model: null, candidate: 1 })).toEqual({ who: "c2", claim: null });
    expect(whoOf({ origin: { kind: "agent", id: "" }, model: null, candidate: 1 })).toEqual({ who: "c2", claim: null });
    expect(whoOf({ origin: null, model: "", candidate: 0 })).toEqual({ who: "c1", claim: null });
    expect(whoOf({ origin: { kind: "human", id: "" }, model: null, candidate: 0 })).toEqual({ who: "human", claim: null });
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
    const g = item({ itemId: "g", kind: "goal" });
    const k = item({ itemId: "g-c1", parentId: "g", rootId: "g", depth: 1 });
    expect(homeHeadline(slice([g, k], [race({ itemId: "g-c1" })], [])).text).toBe("1 race running");
    expect(homeHeadline(slice([item({ itemId: "g2", kind: "goal", status: "DECOMPOSING" })], [], [])).text).toBe("1 item in progress");
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

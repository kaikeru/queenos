/** Dashboard redesign U3: the hive home panels (spec §3.2-§3.5). renderToString: effects never run. */
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { type Escalation, type HiveStatus, type MergeTrain, type Race, type WorkItem } from "@queenos/queen-types";

import { goalPrompt } from "../src/homeLogic";
import { AddGoal, GoalList, NeedsYou, freshWhenLoaded } from "../src/HomePanels";
import { initialState, type State } from "../src/reducer";

const NOW = 1_800_000_000_000;
const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  itemId: "i1", hive: "demo", kind: "feature", title: "Item", body: "", acceptance: [], priority: 2, status: "ACTIVE", parentId: null, rootId: over.itemId ?? "i1", depth: 0,
  dependsOn: [], source: { kind: "user", actor: "kyle@example.com" }, traceId: "a".repeat(32), spanId: "b".repeat(16), difficulty: "normal", bestOf: null, attempts: 0, conflicts: 0,
  paths: [], waitReason: null, duplicateOf: null, blockedReason: null, releaseId: null, escalationId: null, createdAt: NOW - 600_000, updatedAt: NOW - 600_000, ...over,
});
const race = (over: Partial<Race>): Race => ({ raceId: "r", itemId: "i1", width: 1, state: "RACING", trainIds: [], winnerTrainId: null, reason: null, deadlineAt: null, createdAt: NOW - 300_000, decidedAt: null, ...over });
const agent = (name: string, model: string) => ({ kind: "agent" as const, id: `${name}@kyle@example.com`, model });
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
    expect(html).toContain("cand-chip cand-chip--passed");
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

describe("fresh-state motion", () => {
  test("page load is the baseline: unloaded then loaded marks nothing; a later new key is fresh", () => {
    const memo = { seen: null as Set<string> | null, fresh: new Set<string>() };
    expect(freshWhenLoaded(memo, false, []).size).toBe(0);
    expect(freshWhenLoaded(memo, true, ["a:building", "x:landed"]).size).toBe(0);
    expect(freshWhenLoaded(memo, true, ["a:building", "x:landed"]).size).toBe(0);
    expect([...freshWhenLoaded(memo, true, ["a:building", "x:landed", "a:passed"])]).toEqual(["a:passed"]);
  });
  test("a loaded first render has no atile--changed and no celebrate banner", () => {
    const html = renderToString(<GoalList hive="demo" state={state({ items: { b: bmi }, itemOrder: ["b"], races: {}, trains: {}, trainOrder: [] })} now={NOW} />);
    expect(html).not.toContain("atile--changed");
    expect(html).not.toContain("celebrate-banner");
  });
});

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

describe("breadcrumb", () => {
  test("no hive link or quoted title; a goal says goal, a loose item says loose item", () => {
    const g = render("g");
    expect(g).not.toContain("◂ demo");
    expect(g).toContain("<span>goal</span>");
    const loose = item({ itemId: "l1", kind: "feature", title: "Loose thing" });
    const html = render("l1", state({ items: { l1: loose }, itemOrder: ["l1"], races: {}, trains: {}, trainOrder: [] }));
    expect(html).not.toContain("◂ demo");
    expect(html).toContain("loose item");
  });
});

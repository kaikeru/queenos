/** Reducer tests (vitest, plain node environment; the reducer has no runtime imports). */
import { expect, test } from "vitest";
import { QueenServerMessageSchema } from "@queenos/queen-types";
import {
  PHASE_FLOW,
  buildCards,
  buildLanes,
  buildSites,
  initialState,
  isUnknownFrameType,
  letterFor,
  previewView,
  reducer,
  type Action,
  type State,
} from "../src/reducer";

const prompt = (id: string, createdAt: number, status = "QUEUED", text = `prompt ${id}`) => ({
  promptId: id,
  namespace: "demo",
  promptText: text,
  status,
  createdAt,
});
const train = (id: string, included: string[], status = "BUILDING", extra: Record<string, unknown> = {}) => ({
  trainId: id,
  baseSha: "base",
  includedPrompts: included,
  artifactRepo: `demo-train-${id}`,
  status,
  createdAt: extra.createdAt ?? 1,
  ...extra,
});
const audit = (eventId: string, promptId: string, droneRole: string, status: string, createdAt: number, payload: unknown = null) => ({
  eventId,
  promptId,
  droneRole,
  status,
  gitNotesPayload: payload,
  createdAt,
});
const server = (message: unknown, at = 100) => ({ type: "server", message, at }) as unknown as Action;
const run = (...actions: Action[]): State => actions.reduce(reducer, initialState);

const snapshot = server({
  type: "snapshot",
  promptRuns: [prompt("p2", 20), prompt("p1", 10, "MERGED")],
  trains: [
    train("t1", ["p1"], "MERGED", { createdAt: 10, phase: "MERGED", landedSha: "aaaaaaa1111" }),
    train("t2", ["p1", "p2"], "TESTING", { createdAt: 20, phase: "TESTING" }),
  ],
  recentAudit: [audit("e1", "p1", "BUILDER", "PASSED", 11)],
});

test("snapshot replaces state, orders by creation and derives main", () => {
  const s = run(snapshot);
  expect(s.loaded).toBe(true);
  expect(s.promptOrder).toEqual(["p1", "p2"]);
  expect(s.trainOrder).toEqual(["t1", "t2"]);
  expect(s.landed).toEqual([{ sha: "aaaaaaa1111", trainId: "t1", promptId: "p1" }]);
  expect(s.audit.length).toBe(1);
  expect(s.ticker[0]?.kind).toBe("system");
});

test("a second snapshot (reconnect) fully replaces the first", () => {
  const s = run(snapshot, server({ type: "snapshot", promptRuns: [], trains: [], recentAudit: [] }));
  expect(s.promptOrder).toEqual([]);
  expect(s.landed).toEqual([]);
});

test("prompt.updated inserts in order, then updates status and logs the change", () => {
  let s = run(server({ type: "prompt.updated", promptRun: prompt("p1", 10) }));
  s = reducer(s, server({ type: "prompt.updated", promptRun: prompt("p0", 5) }));
  expect(s.promptOrder).toEqual(["p0", "p1"]);
  s = reducer(s, server({ type: "prompt.updated", promptRun: prompt("p1", 10, "EJECTED") }));
  expect(s.prompts.p1?.status).toBe("EJECTED");
  expect(s.ticker[0]!.text).toMatch(/-> EJECTED/);
  expect(s.promptOrder.length).toBe(2);
});

test("train.updated upserts, tracks landed commits once, and logs ejection reasons", () => {
  let s = run(snapshot);
  s = reducer(s, server({ type: "train.updated", train: train("t2", ["p1", "p2"], "EJECTED", { createdAt: 20, phase: "EJECTED", reason: "superseded: prompt p1 ejected" }) }));
  expect(s.trains.t2?.status).toBe("EJECTED");
  expect(s.ticker[0]!.text).toMatch(/ejected \(superseded by an upstream ejection\)/);
  s = reducer(s, server({ type: "train.updated", train: train("t2", ["p1", "p2"], "MERGED", { createdAt: 20, phase: "MERGED", landedSha: "bbbbbbb2222" }) }));
  s = reducer(s, server({ type: "train.updated", train: train("t2", ["p1", "p2"], "MERGED", { createdAt: 20, phase: "MERGED", landedSha: "bbbbbbb2222" }) }));
  expect(s.landed.map((l) => l.sha)).toEqual(["aaaaaaa1111", "bbbbbbb2222"]);
});

test("train summaries surface as scribe ticker lines, deduplicated", () => {
  let s = run(snapshot);
  const withSummary = server({ type: "train.updated", train: train("t2", ["p1", "p2"], "TESTING", { createdAt: 20, phase: "PASSED", summary: "All checks green." }) });
  s = reducer(s, withSummary);
  s = reducer(s, server({ type: "audit.appended", event: audit("e9", "p2", "SCRIBE", "PASSED", 30, { taskPrompt: "x", model: "m", temperature: 0, reasoningSteps: ["All checks green."], result: "success", executionTimeMs: 1, discardedPaths: [] }) }));
  expect(s.ticker.filter((t) => t.kind === "scribe").length).toBe(1);
  expect(s.ticker.find((t) => t.kind === "scribe")!.text).toMatch(/^\[B\] All checks green/);
});

test("audit.appended appends, ignores duplicates, and pairs RUNNING with its terminal event", () => {
  let s = run(snapshot);
  s = reducer(s, server({ type: "audit.appended", event: audit("e2", "p2", "SECURITY", "RUNNING", 40) }));
  s = reducer(s, server({ type: "audit.appended", event: audit("e2", "p2", "SECURITY", "RUNNING", 40) }));
  expect(s.audit.length).toBe(2);
  let cards = buildCards(s.audit).get("p2")!;
  expect(cards[0]!.status).toBe("RUNNING");
  s = reducer(s, server({ type: "audit.appended", event: audit("e3", "p2", "SECURITY", "REJECTED", 50) }));
  cards = buildCards(s.audit).get("p2")!;
  expect(cards.length).toBe(1);
  expect(cards[0]!.status).toBe("REJECTED");
  expect(s.ticker[0]!.text).toMatch(/SECURITY REJECTED/);
});

test("rework starts a new attempt; lanes expose cumulative cars and rebuilt trains", () => {
  const s = run(
    snapshot,
    server({ type: "audit.appended", event: audit("a1", "p2", "BUILDER", "RUNNING", 40) }),
    server({ type: "audit.appended", event: audit("a2", "p2", "BUILDER", "REJECTED", 41) }),
    server({ type: "audit.appended", event: audit("a3", "p2", "BUILDER", "RUNNING", 42) }),
    server({ type: "train.updated", train: train("t3", ["p1", "p2"], "BUILDING", { createdAt: 30, phase: "BUILDING" }) }),
  );
  const lanes = buildLanes(s);
  expect(lanes.map((l) => l.letter)).toEqual(["A", "B"]);
  const b = lanes[1]!;
  expect(b.trains.map((t) => t.cars.join("+"))).toEqual(["A+B", "A+B"]);
  expect(b.trains.map((t) => [t.generation, t.current])).toEqual([[1, false], [2, true]]);
  expect(b.cards.map((c) => c.attempt)).toEqual([1, 2]);
});

test("a stale drone finishing late closes the oldest open card, not the newer attempt", () => {
  const s = run(
    snapshot,
    server({ type: "audit.appended", event: audit("b1", "p2", "BUILDER", "RUNNING", 40) }),
    server({ type: "audit.appended", event: audit("b2", "p2", "BUILDER", "RUNNING", 50) }),
    server({ type: "audit.appended", event: audit("b3", "p2", "BUILDER", "REJECTED", 55) }),
  );
  expect(buildCards(s.audit).get("p2")!.map((c) => [c.attempt, c.status])).toEqual([[1, "REJECTED"], [2, "RUNNING"]]);
});

test("error and invalid frames land in the ticker; pong is a no-op", () => {
  let s = run(server({ type: "error", message: "nope", code: "CONFLICT" }));
  expect(s.ticker[0]!.text).toMatch(/nope \(CONFLICT\)/);
  s = reducer(s, { type: "invalid_frame", detail: "bad", at: 1 });
  expect(s.ticker[0]!.kind).toBe("error");
  const before = s;
  expect(reducer(s, server({ type: "pong" }))).toBe(before);
});

test("letterFor rolls past Z", () => {
  expect([0, 25, 26, 27].map(letterFor)).toEqual(["A", "Z", "AA", "AB"]);
});

const deployment = (trainId: string, status: string, updatedAt: number, extra: Record<string, unknown> = {}) => ({
  deploymentId: `preview-${trainId}`,
  hive: "demo",
  environment: "preview",
  trainId,
  status,
  url: null,
  versionId: null,
  commitSha: "abcdef1234",
  percent: null,
  summary: null,
  updatedAt,
  ...extra,
});
const URL_T2 = "https://t2-preview.sim.queenos.dev";

test("snapshots without deployments (older Queens) yield an empty map; with deployments they load", () => {
  expect(run(snapshot).deployments).toEqual({});
  const s = run(server({ type: "snapshot", promptRuns: [], trains: [], recentAudit: [], deployments: [deployment("t2", "LIVE", 5, { url: URL_T2 })] }));
  expect(Object.keys(s.deployments)).toEqual(["preview-t2"]);
});

test("deployment.updated upserts, logs status changes once, and ignores out-of-order frames", () => {
  let s = run(snapshot);
  s = reducer(s, server({ type: "deployment.updated", deployment: deployment("t2", "PENDING", 10) }));
  expect(s.ticker[0]!.text).toBe("Train A+B deploying preview @ abcdef1");
  s = reducer(s, server({ type: "deployment.updated", deployment: deployment("t2", "LIVE", 20, { url: URL_T2 }) }));
  expect(s.deployments["preview-t2"]).toMatchObject({ status: "LIVE", url: URL_T2 });
  expect(s.ticker[0]!.text).toBe(`Train A+B preview live at ${URL_T2}`);
  const ticks = s.ticker.length;
  s = reducer(s, server({ type: "deployment.updated", deployment: deployment("t2", "LIVE", 21, { url: URL_T2 }) }));
  expect(s.ticker.length).toBe(ticks); // same status: no new line
  const before = s;
  expect(reducer(s, server({ type: "deployment.updated", deployment: deployment("t2", "PENDING", 15) }))).toBe(before);
  s = reducer(s, server({ type: "deployment.updated", deployment: deployment("t2", "FAILED", 30, { summary: "teardown failed: 500" }) }));
  expect(s.ticker[0]).toMatchObject({ kind: "error", text: "Train A+B preview failed: teardown failed: 500" });
  s = reducer(s, server({ type: "deployment.updated", deployment: deployment("t2", "TORN_DOWN", 40) }));
  expect(s.ticker[0]!.text).toBe("Train A+B preview torn down");
});

test("lanes carry each train's preview; previewView covers deploying, live, failed and torn down", () => {
  const deploying = train("t2", ["p1", "p2"], "TESTING", { createdAt: 20, phase: "DEPLOYING", previewUrl: null });
  let s = run(snapshot, server({ type: "train.updated", train: deploying }), server({ type: "deployment.updated", deployment: deployment("t2", "PENDING", 10) }));
  const lt = buildLanes(s)[1]!.trains[0]!;
  expect(lt.preview?.status).toBe("PENDING");
  expect(previewView(lt.train, lt.preview)).toEqual({ kind: "deploying" });

  const live = { ...deploying, phase: "TESTING", previewUrl: URL_T2 };
  s = reducer(s, server({ type: "train.updated", train: live }));
  s = reducer(s, server({ type: "deployment.updated", deployment: deployment("t2", "LIVE", 20, { url: URL_T2 }) }));
  const lt2 = buildLanes(s)[1]!.trains[0]!;
  expect(previewView(lt2.train, lt2.preview)).toEqual({ kind: "live", url: URL_T2 });
  expect(previewView(lt2.train, { ...lt2.preview!, status: "TORN_DOWN" })).toEqual({ kind: "gone", url: URL_T2 });
  expect(previewView(lt2.train, { ...lt2.preview!, status: "FAILED", summary: "boom" })).toEqual({ kind: "failed", summary: "boom" });
  expect(previewView(train("t9", ["p1"]) as never, null)).toEqual({ kind: "none" });
  expect(PHASE_FLOW.indexOf("DEPLOYING")).toBe(PHASE_FLOW.indexOf("BUILDING") + 1);
});

test("sites list previews by environment; staging, canary and prod are not configured yet", () => {
  const s = run(
    snapshot,
    server({ type: "deployment.updated", deployment: deployment("t1", "TORN_DOWN", 10) }),
    server({ type: "deployment.updated", deployment: deployment("t2", "LIVE", 20, { url: URL_T2 }) }),
  );
  const sites = buildSites(s);
  expect(sites.map((r) => [r.environment, r.configured])).toEqual([
    ["preview", true],
    ["staging", false],
    ["canary", false],
    ["prod", false],
  ]);
  expect(sites[0]).toMatchObject({ retired: 1 });
  expect(sites[0]!.deployments.map((d) => d.trainId)).toEqual(["t2"]);
});

test("an unknown frame type from a newer Queen sets the outdated flag, with no error line", () => {
  const parsed = QueenServerMessageSchema.safeParse({ type: "brand.new.frame", x: 1 });
  expect(parsed.success).toBe(false);
  if (parsed.success) return;
  expect(isUnknownFrameType(parsed.error.issues, { type: "brand.new.frame" })).toBe(true);
  const s = reducer(initialState, { type: "invalid_frame", detail: "x", at: 1, outdated: true });
  expect(s.outdated).toBe(true);
  expect(s.ticker).toEqual([]);
  // idempotent
  expect(reducer(s, { type: "invalid_frame", detail: "x", at: 2, outdated: true })).toBe(s);
});

test("genuine malformed frames are not classed as outdated", () => {
  const knownTypeBadShape = QueenServerMessageSchema.safeParse({ type: "train.updated", train: { nope: true } });
  expect(knownTypeBadShape.success).toBe(false);
  if (!knownTypeBadShape.success) expect(isUnknownFrameType(knownTypeBadShape.error.issues, { type: "train.updated" })).toBe(false);
  const noType = QueenServerMessageSchema.safeParse({});
  if (!noType.success) expect(isUnknownFrameType(noType.error.issues, {})).toBe(false);
  const s = reducer(initialState, { type: "invalid_frame", detail: "bad", at: 1 });
  expect(s.outdated).toBe(false);
  expect(s.ticker[0]).toMatchObject({ kind: "error" });
});

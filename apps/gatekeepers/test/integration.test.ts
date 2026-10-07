import { describe, expect, it } from "vitest";
import type { GateTarget } from "@queenos/queen-types";
import { integrationRoutes } from "../src/inspect";
import { followUpsFrom } from "../src/followups";
import { lookupTrain, runGate } from "../src/orchestrate";
import { FetchSmokeProbe } from "../src/smoke";
import { FakeWorld, HIVE, InlineSteps, REPO, config, gateTask } from "./fakes";

const TRACE_A = "a".repeat(32);
const TRACE_B = "b".repeat(32);
const TRACE_CAR = "c".repeat(32);
const SHA_1 = "1".repeat(40);
const SHA_2 = "2".repeat(40);
const PREVIEW = "https://car-preview.sub.workers.dev";
const KEY = 'export const k = "AKIAABCDEFGHIJKLMNOP";\n';

function buildTarget(over: Partial<GateTarget> = {}): GateTarget {
  return { trainId: "train-1", lane: "BUILD", promptId: "prompt-1", promptText: "Add a dark mode toggle", previewUrl: null, phase: "TESTING", traceId: TRACE_A, baseSha: null, ...over };
}

function carTarget(base: string, over: Partial<GateTarget> = {}): GateTarget {
  return buildTarget({
    trainId: "car-1",
    lane: "QUEUE",
    previewUrl: PREVIEW,
    baseSha: base,
    traceId: TRACE_CAR,
    members: [
      { trainId: "m1", promptId: "p-a", artifactRepo: "hive-train-111111111111", headSha: SHA_1, title: "Add dark mode", traceId: TRACE_A, smokePaths: ["/dark"] },
      { trainId: "m2", promptId: "p-b", artifactRepo: "hive-train-222222222222", headSha: SHA_2, title: "Add pricing page", traceId: TRACE_B, smokePaths: ["/pricing", "/dark"] },
    ],
    ...over,
  });
}

/** A car fork: a base commit, then two members' merged changes on top. */
async function carWorld(base: Record<string, string> = { "README.md": "# hive\n" }) {
  const w = new FakeWorld();
  const baseSha = await w.git.seed(REPO, base);
  await w.git.build(REPO, { prompt: "Add dark mode", files: { "src/dark.ts": "export const dark = true;\n" } });
  const head = await w.git.build(REPO, { prompt: "Add pricing page", files: { "src/pricing.ts": "export const pricing = 1;\n" } });
  w.queen.serveTarget(carTarget(baseSha));
  return { w, baseSha, head };
}

describe("getGateTarget", () => {
  it("builds the lookup from the target: no snapshot scan for a car", async () => {
    const { w, baseSha } = await carWorld();
    const look = await lookupTrain(w.queen, { repo: REPO, after: "x" });
    expect(look).toMatchObject({ status: "ready", lane: "QUEUE", trainId: "car-1", baseSha, previewUrl: PREVIEW, traceId: TRACE_CAR, memberTraces: [TRACE_A, TRACE_B] });
    expect(w.queen.methods()).toEqual(["getGateTarget"]);
    if (look.status !== "ready") throw new Error("unreachable");
    expect(look.routes.map((r) => r.path)).toEqual(["/", "/health", "/dark", "/pricing"]);
    expect(look.routes.find((r) => r.path === "/dark")!.member).toEqual({ trainId: "m1", title: "Add dark mode" });
  });

  it("waits while the target is DEPLOYING and ignores a finished one", async () => {
    const w = new FakeWorld();
    w.queen.serveTarget(buildTarget({ phase: "DEPLOYING" }));
    expect(await lookupTrain(w.queen, { repo: REPO, after: "x" })).toEqual({ status: "waiting", phase: "DEPLOYING" });
    w.queen.serveTarget(buildTarget({ phase: "MERGED" as never }));
    expect(await lookupTrain(w.queen, { repo: REPO, after: "x" })).toMatchObject({ status: "ignored", reason: "phase-MERGED" });
    w.queen.serveTarget(null);
    expect(await lookupTrain(w.queen, { repo: REPO, after: "x" })).toMatchObject({ status: "ignored", reason: "unknown-train" });
  });

  it("falls back to the snapshot scan when the Queen lacks the RPC (method absent)", async () => {
    const w = new FakeWorld();
    const look = await lookupTrain(w.queen, { repo: REPO, after: "x" });
    expect(look).toMatchObject({ status: "ready", lane: "BUILD", trainId: "train-1" });
    expect(w.queen.methods()).toEqual(["getSnapshot"]);
  });

  it("falls back to the snapshot scan when the RPC throws (not implemented yet)", async () => {
    const w = new FakeWorld();
    w.queen.serveTarget(new Error("The RPC receiver does not implement the method getGateTarget"));
    const look = await lookupTrain(w.queen, { repo: REPO, after: "x" });
    expect(look).toMatchObject({ status: "ready", lane: "BUILD", trainId: "train-1" });
    expect(w.queen.methods()).toEqual(["getGateTarget", "getSnapshot"]);
  });

  it("a BUILD target still gets the builder's ledger reasoning from the snapshot (best effort)", async () => {
    const w = new FakeWorld();
    w.queen.serveTarget(buildTarget());
    const look = await lookupTrain(w.queen, { repo: REPO, after: "x" });
    expect(look).toMatchObject({ status: "ready", lane: "BUILD", routes: [], traceId: TRACE_A, builderReasoning: [] });
  });
});

describe("integration gate (lane QUEUE)", () => {
  it("passes without a reviewer or a memory write, smokes every route, and scores review: skipped", async () => {
    const { w, head } = await carWorld();
    const out = await runGate(gateTask(head), new InlineSteps(), w.ports(), config({ REVIEW_MODE: "scripted" }));
    expect(out).toMatchObject({ status: "gated", passed: true, lane: "QUEUE", summary: expect.stringContaining("Integration gate passed") });
    expect(w.queen.auditSeq()).toEqual(["POLICY:RUNNING", "SECURITY:RUNNING", "POLICY:PASSED", "SECURITY:PASSED"]);
    expect(w.smoke.paths).toEqual(["/", "/health", "/dark", "/pricing"]);
    expect(new Set(w.smoke.urls)).toEqual(new Set([PREVIEW]));
    expect(w.memory.records).toEqual([]);
    expect(w.queen.reports()).toEqual([
      { trainId: "car-1", passed: true, summary: expect.any(String), commitSha: head, score: { review: "skipped", satisfied: 0, missing: 0, changedFiles: 2, changedBytes: expect.any(Number), checks: 23 } },
    ]);
    // `train.promptId` is the car's last prompt.
    expect(new Set(w.queen.audits().map((a) => a.promptId))).toEqual(new Set(["prompt-1"]));
  });

  it("clones deep enough to see baseSha..head", async () => {
    const { w, head } = await carWorld();
    await runGate(gateTask(head), new InlineSteps(), w.ports(), config());
    expect(w.git.clones[0]).toMatchObject({ depth: 100 });
  });

  it("a failing member route fails the car; the Scribe summary names the member's route; no memory, no review", async () => {
    const { w, head } = await carWorld();
    w.smoke.byPath.set("/pricing", {
      passed: false,
      status: 404,
      log: "> smoke: GET /pricing\n FAIL  preview smoke > GET /pricing returns 2xx\nAssertionError: preview smoke failed: GET /pricing returned HTTP 404 (expected 2xx)",
      firstError: "AssertionError: preview smoke failed: GET /pricing returned HTTP 404 (expected 2xx)",
    });
    w.llm = { complete: async (req) => ({ text: "The build broke after the merge. Please fix it.", usage: { inputTokens: 1, outputTokens: 1 }, model: req.model, finishReason: "stop" }) };
    const out = await runGate(gateTask(head), new InlineSteps(), w.ports(), config({ REVIEW_MODE: "scripted" }));
    expect(out).toMatchObject({ status: "gated", passed: false, lane: "QUEUE" });
    if (out.status !== "gated") throw new Error("unreachable");
    // The (LLM) Scribe dropped the route; the gate puts it back, with the declaring member.
    expect(out.summary).toContain("GET /pricing");
    expect(out.summary).toContain("m2");
    expect(out.summary).toContain("Add pricing page");
    expect(w.queen.scribes()[0]!.summary).toBe(out.summary);
    expect(w.queen.auditSeq()).not.toContain("REVIEWER:RUNNING");
    expect(w.memory.records).toEqual([]);
    expect(w.queen.reports()[0]).toMatchObject({ trainId: "car-1", passed: false, score: { review: "skipped" } });
    // The raw log carries both the route and the member for the Scribe.
    expect(w.failures.stored[0]![0]!.text).toContain('declared by member m2 "Add pricing page"');
  });

  it("probes member routes as feature routes and base routes as base", async () => {
    const { w, head } = await carWorld();
    await runGate(gateTask(head), new InlineSteps(), w.ports(), config());
    expect(w.smoke.kinds).toEqual(["base", "base", "feature", "feature"]);
  });

  /** Real FetchSmokeProbe against a canned Worker: path -> status. */
  function realProbe(statuses: Record<string, number>) {
    return new FetchSmokeProbe({
      attempts: 1,
      fetch: async (url) => new Response(`status for ${new URL(url).pathname}`, { status: statuses[new URL(url).pathname] ?? 200 }),
    });
  }

  it("a member route answering 400 (input validation) passes the car: no failure, no bisect trigger", async () => {
    const { w, head } = await carWorld();
    const ports = { ...w.ports(), smoke: realProbe({ "/dark": 400, "/pricing": 422 }) };
    const out = await runGate(gateTask(head), new InlineSteps(), ports, config());
    expect(out).toMatchObject({ status: "gated", passed: true, lane: "QUEUE" });
    expect(w.queen.reports()[0]).toMatchObject({ trainId: "car-1", passed: true });
  });

  it("a member route answering 404 or 500 still fails the car and names the member", async () => {
    for (const code of [404, 500]) {
      const { w, head } = await carWorld();
      const ports = { ...w.ports(), smoke: realProbe({ "/pricing": code }) };
      const out = await runGate(gateTask(head), new InlineSteps(), ports, config());
      expect(out).toMatchObject({ status: "gated", passed: false });
      if (out.status !== "gated") throw new Error("unreachable");
      expect(out.summary).toContain("GET /pricing");
      expect(out.summary).toContain("m2");
      expect(w.failures.stored.at(-1)![0]!.text).toContain('declared by member m2 "Add pricing page"');
    }
  });

  it("/health answering 400 still fails the car, attributed to no member", async () => {
    const { w, head } = await carWorld();
    const ports = { ...w.ports(), smoke: realProbe({ "/health": 400 }) };
    const out = await runGate(gateTask(head), new InlineSteps(), ports, config());
    expect(out).toMatchObject({ status: "gated", passed: false });
  });

  it("a failing base route (/health) is attributed to no member", async () => {
    const { w, head } = await carWorld();
    w.smoke.byPath.set("/health", { passed: false, status: 500, log: " FAIL  preview smoke > GET /health returns 2xx\nHTTP 500", firstError: "AssertionError: GET /health returned HTTP 500" });
    const out = await runGate(gateTask(head), new InlineSteps(), w.ports(), config());
    if (out.status !== "gated") throw new Error("unreachable");
    expect(out).toMatchObject({ passed: false });
    expect(out.summary).toContain("/health");
    expect(out.summary).not.toContain("member");
  });

  it("scans baseSha..head: a finding in a changed file fails the car", async () => {
    const w = new FakeWorld();
    const baseSha = await w.git.seed(REPO);
    const head = await w.git.build(REPO, { prompt: "Add keys", files: { "src/keys.ts": KEY } });
    w.queen.serveTarget(carTarget(baseSha));
    const out = await runGate(gateTask(head), new InlineSteps(), w.ports(), config());
    expect(out).toMatchObject({ passed: false });
    expect(w.queen.auditSeq()).toContain("SECURITY:REJECTED");
    expect(w.queen.reports()[0]!.followUps).toBeUndefined();
  });

  it("scans baseSha..head: a finding outside the diff does not fail the car; it becomes a follow-up", async () => {
    const { w, head } = await carWorld({ "README.md": "# hive\n", "src/old-keys.ts": KEY });
    const out = await runGate(gateTask(head), new InlineSteps(), w.ports(), config());
    expect(out).toMatchObject({ passed: true });
    expect(w.queen.auditSeq()).toContain("SECURITY:PASSED");
    const r = w.queen.reports()[0]!;
    expect(r.passed).toBe(true);
    expect(r.followUps).toEqual([
      expect.objectContaining({ kind: "bug", priority: 1, paths: ["src/old-keys.ts"], title: expect.stringContaining("src/old-keys.ts") }),
    ]);
  });

  it("logs the gate under the car's trace and under each member's trace", async () => {
    const { w, head } = await carWorld();
    await runGate(gateTask(head), new InlineSteps(), w.ports(), config());
    const passed = w.logs.filter((l) => l.step === "gate: gate" && l.outcome === "passed");
    expect(passed.map((l) => l.trace_id)).toEqual([TRACE_CAR, TRACE_A, TRACE_B]);
    expect(passed[0]).toMatchObject({ hive: HIVE, lane: "QUEUE", train_id: "car-1", span_id: expect.stringMatching(/^[0-9a-f]{16}$/) });
  });

  it("an unknown base (not in the clone) scans everything as in-diff", async () => {
    const w = new FakeWorld();
    await w.git.seed(REPO, { "src/old-keys.ts": KEY });
    const head = await w.git.build(REPO, { prompt: "x", files: { "src/a.ts": "export const a = 1;\n" } });
    w.queen.serveTarget(carTarget("f".repeat(40)));
    const out = await runGate(gateTask(head), new InlineSteps(), w.ports(), config());
    expect(out).toMatchObject({ passed: false });
  });
});

describe("BUILD gate with a target", () => {
  it("traces from the target, reports the score, and still writes memory", async () => {
    const w = new FakeWorld();
    await w.git.seed(REPO);
    const after = await w.git.build(REPO, { prompt: "Add dark mode", files: { "src/dark.ts": "export const dark = true;\n" } });
    w.queen.serveTarget(buildTarget());
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), config());
    expect(out).toMatchObject({ passed: true, lane: "BUILD" });
    expect(w.memory.records).toHaveLength(1);
    expect(w.logs.some((l) => l.trace_id === TRACE_A && l.outcome === "passed")).toBe(true);
    expect(w.smoke.paths).toEqual([]); // no preview url on this target
  });

  it("a finding in an untouched file is a follow-up, not a failure", async () => {
    const w = new FakeWorld();
    await w.git.seed(REPO, { "src/old-keys.ts": KEY });
    const after = await w.git.build(REPO, { prompt: "Add dark mode", files: { "src/dark.ts": "export const dark = true;\n" } });
    w.queen.serveTarget(buildTarget());
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), config());
    expect(out).toMatchObject({ passed: true });
    const r = w.queen.reports()[0]!;
    expect(r.followUps).toEqual([expect.objectContaining({ kind: "bug", priority: 1, paths: ["src/old-keys.ts"] })]);
    // The ledger still shows it, as a warning.
    expect(JSON.stringify(w.queen.audits().map((a) => a.gitNotesPayload))).toContain("pre-existing, outside the diff");
  });

  it("a finding in the changed file still fails", async () => {
    const w = new FakeWorld();
    await w.git.seed(REPO, { "src/old-keys.ts": KEY });
    const after = await w.git.build(REPO, { prompt: "Add keys", files: { "src/new-keys.ts": KEY } });
    w.queen.serveTarget(buildTarget());
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), config());
    expect(out).toMatchObject({ passed: false });
    // The old file's finding rides along as a follow-up even though the gate failed.
    expect(w.queen.reports()[0]!.followUps).toEqual([expect.objectContaining({ paths: ["src/old-keys.ts"] })]);
  });
});

describe("followUpsFrom / integrationRoutes", () => {
  const f = (rule: string, file: string, message = "m") => ({ rule, file, severity: "error" as const, message, line: 3 });
  it("caps at 3, security first (P1) then policy (P2), de-duplicated", () => {
    const out = followUpsFrom([f("eval", "a.ts"), f("eval", "a.ts"), f("secret-pattern", "b.ts")], [f("disallowed-dependency", "package.json"), f("x", "c.ts")]);
    expect(out.map((o) => [o.priority, o.paths[0]])).toEqual([
      [1, "a.ts"],
      [1, "b.ts"],
      [2, "package.json"],
    ]);
  });
  it("routes: base routes first, member paths de-duplicated, junk dropped", () => {
    const routes = integrationRoutes([
      { trainId: "m1", title: "t", smokePaths: ["/a", "/health", "no-slash", "/../x", "/a b"] },
      { trainId: "m2", title: "t2", smokePaths: ["/a", "/b"] },
    ]);
    expect(routes.map((r) => r.path)).toEqual(["/", "/health", "/a", "/b"]);
    expect(routes[3]!.member!.trainId).toBe("m2");
  });
});

describe("Queen-started gates (GATE command): one gate owns a TESTING round", () => {
  const CLEAN = { "src/features/dark-mode.ts": "export const darkMode = { enabled: true } as const;\n" };
  const QGATE = "gate-hive-train-aaaaaaaaaaaa-q1";
  async function buildWorld(target: Partial<GateTarget>) {
    const w = new FakeWorld();
    await w.git.seed(REPO);
    const after = await w.git.build(REPO, { prompt: "Add a dark mode toggle", files: CLEAN });
    w.queen.train.headSha = after;
    w.queen.serveTarget(buildTarget(target));
    return { w, after };
  }

  it("the Queen's command (task.commandId = target.gateId) gates and reports its gateId", async () => {
    const { w, after } = await buildWorld({ gateId: QGATE });
    const out = await runGate(gateTask(after, { commandId: QGATE, trainId: "train-1" }), new InlineSteps(), w.ports(), config());
    expect(out).toMatchObject({ status: "gated", passed: true, queenOutcome: "applied" });
    expect(w.queen.reports()).toEqual([expect.objectContaining({ trainId: "train-1", passed: true, commitSha: after, gateId: QGATE })]);
  });

  it("the push-event gate stands down when the Queen started a gate for the round (no audits, no report)", async () => {
    const { w, after } = await buildWorld({ gateId: QGATE });
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), config());
    expect(out).toEqual({ status: "ignored", reason: "queen-gate" });
    expect(w.queen.audits()).toEqual([]);
    expect(w.queen.reports()).toEqual([]);
    expect(w.artifacts.calls).toEqual([]);
  });

  it("a replaced Queen gate (the watchdog re-dispatched the round) stands down too", async () => {
    const { w, after } = await buildWorld({ gateId: "gate-hive-train-aaaaaaaaaaaa-q2" });
    const out = await runGate(gateTask(after, { commandId: QGATE, trainId: "train-1" }), new InlineSteps(), w.ports(), config());
    expect(out).toEqual({ status: "ignored", reason: "queen-gate" });
    expect(w.queen.reports()).toEqual([]);
  });

  it("an older Queen (no gateId) or a round without a Queen gate: the push-event gate gates as before, no gateId reported", async () => {
    for (const target of [{}, { gateId: null }]) {
      const { w, after } = await buildWorld(target);
      const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), config());
      expect(out).toMatchObject({ status: "gated", passed: true });
      expect(w.queen.reports()[0]).not.toHaveProperty("gateId");
    }
  });
});

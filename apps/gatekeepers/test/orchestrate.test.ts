import { describe, expect, it } from "vitest";
import { AiGatewayError } from "@queenos/hive-kit";
import { chunkLog, runGate } from "../src/orchestrate";
import { FakeLlm, FakeWorld, HIVE, InlineSteps, REPO, config, gateTask } from "./fakes";

const CLEAN = { "src/features/dark-mode.ts": "export const darkMode = { enabled: true } as const;\n" };
const prompt = "Add a dark mode toggle to settings";

/** A fork with a base commit and a builder commit; the Queen says TESTING at that head. */
async function setup(opts: { prompt?: string; action?: "build" | "rework"; files?: Record<string, string> } = {}) {
  const w = new FakeWorld();
  const base = await w.git.seed(REPO);
  const p = opts.prompt ?? prompt;
  const after = await w.git.build(REPO, { prompt: p, ...(opts.action ? { action: opts.action } : {}), files: opts.files ?? { ...CLEAN, "features/dark-mode.md": `# ${p}\n\n## Request\n\n${p}\n` } });
  w.queen.train.headSha = after;
  w.queen.promptText = p;
  return { w, base, after };
}

describe("runGate: pass path", () => {
  it("scans, tests and reports passed:true with the pushed SHA", async () => {
    const { w, base, after } = await setup();
    const steps = new InlineSteps();
    const out = await runGate(gateTask(after, { before: base }), steps, w.ports(), config());

    expect(out).toMatchObject({ status: "gated", trainId: "train-1", passed: true, queenOutcome: "applied" });
    expect(w.queen.reports()).toEqual([{ trainId: "train-1", passed: true, summary: expect.stringContaining("Gate passed"), commitSha: after }]);
    expect(w.queen.auditSeq()).toEqual(["POLICY:RUNNING", "SECURITY:RUNNING", "POLICY:PASSED", "SECURITY:PASSED"]);
    // Audits are attached to the train's own prompt (tail of includedPrompts), not a predecessor's.
    expect(new Set(w.queen.audits().map((a) => a.promptId))).toEqual(new Set(["prompt-1"]));
    expect(w.queen.audits()[2]!.gitNotesPayload).toMatchObject({ result: "success", taskPrompt: prompt });
    expect(w.queen.scribes()).toEqual([]);
    expect(w.failures.stored).toEqual([]);
    expect(steps.names()).toEqual([
      "lookup train #1",
      "audit: policy running",
      "audit: security running",
      "inspect: clone, scan, test",
      "audit: policy result",
      "audit: security result",
      "report: train result",
    ]);
    // Read token for the fork, shallow clone of the pushed branch.
    expect(w.artifacts.calls).toEqual([{ repo: REPO, scope: "read" }]);
    expect(w.git.clones[0]).toMatchObject({ ref: "main", depth: 4 });
  });

  it("is not fooled by a [fail] marker that came from an earlier train in the chained fork", async () => {
    const w = new FakeWorld();
    await w.git.seed(REPO, { "features/old.md": "## Request\n\nsomething [fail]\n" });
    const after = await w.git.build(REPO, { prompt: "clean change", files: CLEAN });
    w.queen.train.headSha = after;
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), config());
    expect(out).toMatchObject({ passed: true });
  });
});

describe("runGate: fail path ([fail] demo)", () => {
  it("fails the first attempt, runs the Scribe, stores the log in Vectorize, reports passed:false", async () => {
    const p = "Fix the flaky retry logic in the webhook sender [fail]";
    const { w, after } = await setup({ prompt: p, files: { ...CLEAN, "features/fix.md": `# ${p}\n\n## Request\n\n${p}\n` } });
    const steps = new InlineSteps();
    const out = await runGate(gateTask(after), steps, w.ports(), config());

    expect(out).toMatchObject({ status: "gated", passed: false, scribe: "extractive", vectorized: expect.any(Number) });
    if (out.status !== "gated") throw new Error("unreachable");
    expect(w.queen.auditSeq()).toEqual(["POLICY:RUNNING", "SECURITY:RUNNING", "POLICY:PASSED", "SECURITY:PASSED", "SCRIBE:RUNNING", "SCRIBE:PASSED"]);
    expect(w.queen.methods().filter((m) => m !== "appendAudit" && m !== "getSnapshot")).toEqual(["recordScribeSummary", "reportTrainResult"]);

    expect(out.summary.length).toBeLessThanOrEqual(500);
    expect(out.summary).toContain("[fail] marker found in changed file features/fix.md");
    expect(w.queen.scribes()).toEqual([{ promptId: "prompt-1", trainId: "train-1", summary: out.summary }]);
    expect(w.queen.reports()).toEqual([{ trainId: "train-1", passed: false, summary: out.summary, commitSha: after }]);

    // Raw logs go to Vectorize (never to the Queen).
    const chunks = w.failures.stored[0]!;
    expect(chunks.length).toBeGreaterThan(1);
    expect(out.vectorized).toBe(chunks.length);
    expect(chunks[0]!.metadata).toEqual({ trainId: "train-1", promptId: "prompt-1", namespace: HIVE, kind: "failure-log", commitSha: after, chunk: 0 });
    expect(chunks[0]!.id).toBe(`train-1:${after.slice(0, 12)}:0`);
    expect(chunks[0]!.text).toContain("RUN  v4.1.11");
  });

  it("passes the REWORK of the same prompt (marker is still in the prompt text)", async () => {
    const p = "Fix the flaky retry logic in the webhook sender [fail]";
    const { w, after } = await setup({
      prompt: p,
      action: "rework",
      files: { ...CLEAN, "features/fix.md": `# ${p}\n\n## Request\n\n${p}\n\n## Rework\n\nPrevious attempt failed: Check "x" failed. First error: [fail] marker\n` },
    });
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), config());
    expect(out).toMatchObject({ passed: true });
    expect(w.queen.reports()[0]).toMatchObject({ passed: true });
  });

  it("uses the LLM Scribe when one is configured, still capped", async () => {
    const { w, after } = await setup({ prompt: "x [fail]", files: { "a.md": "x [fail]" } });
    w.llm = new FakeLlm(`The smoke test returned 500. The marker triggered it. ${"Noise. ".repeat(200)}`);
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), config());
    expect(out).toMatchObject({ passed: false, scribe: "llm", summary: "The smoke test returned 500. The marker triggered it." });
    expect((w.llm as FakeLlm).requests[0]!.system).toBe("Summarize this failure in exactly two sentences.");
  });

  it("falls back to extractive when the LLM keeps failing", async () => {
    const { w, after } = await setup({ prompt: "x [fail]", files: { "a.md": "x [fail]" } });
    w.llm = new FakeLlm(new AiGatewayError("overloaded", 529, true));
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), config());
    expect(out).toMatchObject({ passed: false, scribe: "extractive" });
  });

  it("never fails the gate because of Vectorize", async () => {
    const { w, after } = await setup({ prompt: "x [fail]", files: { "a.md": "x [fail]" } });
    w.failures.error = new Error("vectorize is down");
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), config());
    expect(out).toMatchObject({ passed: false, vectorized: 0 });
    expect(w.queen.reports()).toHaveLength(1);
  });

  it("tolerates the Queen rejecting an audit (permanent error)", async () => {
    const { w, after } = await setup();
    w.queen.appendAudit = async () => {
      throw new Error("NOT_FOUND: prompt prompt-1 not found");
    };
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), config());
    expect(out).toMatchObject({ passed: true });
  });
});

describe("runGate: static policy / security failures", () => {
  it("rejects a disallowed dependency and Node import, skips the tests, scribes the findings", async () => {
    const { w, after } = await setup({
      files: {
        "package.json": JSON.stringify({ dependencies: { "left-pad": "1.3.0" } }),
        "src/x.ts": 'import { readFileSync } from "node:fs";\nexport const x: number = 1;\n',
      },
    });
    let ran = false;
    w.tests = { mode: "scripted", run: async () => ((ran = true), { passed: true, checks: 0, log: "" }) };
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), config());
    expect(ran).toBe(false);
    expect(out).toMatchObject({ passed: false });
    expect(w.queen.auditSeq()).toEqual(["POLICY:RUNNING", "SECURITY:RUNNING", "POLICY:REJECTED", "SECURITY:PASSED", "SCRIBE:RUNNING", "SCRIBE:PASSED"]);
    if (out.status !== "gated") throw new Error("unreachable");
    expect(out.summary).toContain("policy scan");
    expect(w.queen.audits()[2]!.gitNotesPayload!.reasoningSteps.join("\n")).toContain("left-pad");
  });

  it("rejects a leaked secret via SECURITY", async () => {
    const { w, after } = await setup({ files: { "src/k.ts": 'export const k = "AKIAABCDEFGHIJKLMNOP";\n' } });
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), config());
    expect(out).toMatchObject({ passed: false });
    expect(w.queen.auditSeq()).toContain("SECURITY:REJECTED");
    expect(w.queen.auditSeq()).toContain("POLICY:PASSED");
  });
});

describe("runGate: Queen phase race and guards", () => {
  it("waits (step.sleep) until the Queen reaches TESTING", async () => {
    const { w, after } = await setup();
    w.queen.phases = ["BUILDING", "BUILDING", "TESTING"];
    const steps = new InlineSteps();
    const out = await runGate(gateTask(after), steps, w.ports(), config({ GATE_PHASE_WAIT_MS: "5000" }));
    expect(out).toMatchObject({ passed: true });
    expect(steps.names().filter((n) => n.startsWith("lookup"))).toEqual(["lookup train #1", "lookup train #2", "lookup train #3"]);
    expect(steps.sleeps).toEqual([
      { name: "wait for TESTING #1", ms: 5000 },
      { name: "wait for TESTING #2", ms: 5000 },
    ]);
  });

  it("gives up after the retry cap without touching the Queen's verdict", async () => {
    const { w, after } = await setup();
    w.queen.phases = ["BUILDING"];
    const steps = new InlineSteps();
    const out = await runGate(gateTask(after), steps, w.ports(), config({ GATE_PHASE_RETRIES: "3" }));
    expect(out).toEqual({ status: "ignored", reason: "phase-timeout" });
    expect(steps.sleeps).toHaveLength(2);
    expect(w.queen.methods()).toEqual(["getSnapshot", "getSnapshot", "getSnapshot"]);
    expect(w.artifacts.calls).toEqual([]);
  });

  it.each([
    ["an unknown train", (w: FakeWorld) => (w.queen.train.artifactRepo = "hive-train-zzzzzzzzzzzz"), "unknown-train"],
    ["a train that already passed", (w: FakeWorld) => (w.queen.phases = ["PASSED"]), "phase-PASSED"],
    ["an ejected train", (w: FakeWorld) => (w.queen.phases = ["EJECTED"]), "phase-EJECTED"],
    ["a push that is not the train head (e.g. the code commit before a ledger-file commit)", (w: FakeWorld) => (w.queen.train.headSha = "f".repeat(40)), "not-train-head"],
  ])("ignores %s", async (_n, mutate, reason) => {
    const { w, after } = await setup();
    mutate(w);
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), config());
    expect(out).toEqual({ status: "ignored", reason });
    expect(w.queen.reports()).toEqual([]);
    expect(w.queen.audits()).toEqual([]);
  });

  it("ignores a push whose branch has already moved past `after` (stale)", async () => {
    const { w, after } = await setup();
    await w.git.build(REPO, { prompt: "later", files: { "z.md": "z" }, ts: 1_790_000_100 });
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), config());
    expect(out).toEqual({ status: "ignored", reason: "stale-head" });
    expect(w.queen.reports()).toEqual([]);
  });
});

describe("runGate: infrastructure failures", () => {
  it("ejects (instead of hanging in TESTING) when the clone keeps failing", async () => {
    const { w, after } = await setup();
    w.artifacts.failWith = new Error("artifacts is unreachable");
    const steps = new InlineSteps();
    const out = await runGate(gateTask(after), steps, w.ports(), config());
    expect(out).toMatchObject({ status: "gated", passed: false, summary: expect.stringContaining("artifacts is unreachable") });
    expect(steps.log.find((l) => l.name === "inspect: clone, scan, test")).toMatchObject({ attempts: 4, ok: false }); // 1 + 3 retries
    expect(w.queen.reports()).toHaveLength(1);
  });

  it("sandbox mode surfaces 'not implemented' as the failure reason (no retries)", async () => {
    const { w, after } = await setup();
    const { createTestRunner } = await import("../src/test-runner");
    w.tests = createTestRunner("sandbox");
    const steps = new InlineSteps();
    const out = await runGate(gateTask(after), steps, w.ports(), config({ GATE_TEST_MODE: "sandbox" }));
    expect(out).toMatchObject({ passed: false, summary: expect.stringContaining("not implemented") });
    expect(steps.log.find((l) => l.name === "inspect: clone, scan, test")).toMatchObject({ attempts: 1, ok: false });
  });
});

describe("chunkLog", () => {
  it("splits and caps", () => {
    expect(chunkLog("a".repeat(4_000), 1_500, 6).map((c) => c.length)).toEqual([1_500, 1_500, 1_000]);
    expect(chunkLog("a".repeat(100_000))).toHaveLength(6);
    expect(chunkLog("")).toEqual([]);
  });
});

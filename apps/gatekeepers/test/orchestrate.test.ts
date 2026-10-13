import { describe, expect, it } from "vitest";
import { AiGatewayError } from "@queenos/hive-kit";
import { memoryIdFor } from "@queenos/hive-kit";
import type { AuditEvent } from "@queenos/queen-types";
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

describe("runGate: notBefore (automatic infra re-gate backoff)", () => {
  it("sleeps until notBefore before round 1, durably, then gates as usual", async () => {
    const { w, after } = await setup();
    const steps = new InlineSteps();
    const notBefore = Date.now() + 60_000;
    const out = await runGate(gateTask(after, { notBefore }), steps, w.ports(), config());
    expect(out).toMatchObject({ status: "gated", passed: true });
    const sleep = steps.sleeps.find((x) => x.name === "infra: re-gate backoff")!;
    expect(sleep.ms).toBeGreaterThan(55_000);
    expect(sleep.ms).toBeLessThanOrEqual(60_000);
    expect(steps.sleeps[0]).toBe(sleep);
  });

  it("a notBefore in the past sleeps 0; no notBefore does not sleep at all", async () => {
    const { w, after } = await setup();
    const past = new InlineSteps();
    await runGate(gateTask(after, { notBefore: Date.now() - 5_000 }), past, w.ports(), config());
    expect(past.sleeps.find((x) => x.name === "infra: re-gate backoff")).toEqual({ name: "infra: re-gate backoff", ms: 0 });
    const none = new InlineSteps();
    const { w: w2, after: after2 } = await setup();
    await runGate(gateTask(after2), none, w2.ports(), config());
    expect(none.sleeps.find((x) => x.name === "infra: re-gate backoff")).toBeUndefined();
  });
});

describe("runGate: pass path", () => {
  it("scans, tests and reports passed:true with the pushed SHA", async () => {
    const { w, base, after } = await setup();
    const steps = new InlineSteps();
    const out = await runGate(gateTask(after, { before: base }), steps, w.ports(), config());

    expect(out).toMatchObject({ status: "gated", trainId: "train-1", passed: true, queenOutcome: "applied" });
    expect(w.queen.reports()).toEqual([{ trainId: "train-1", passed: true, summary: expect.stringContaining("Gate passed"), commitSha: after, score: { review: "off", satisfied: 0, missing: 0, changedFiles: 2, changedBytes: expect.any(Number), checks: 19 } }]);
    expect(w.queen.auditSeq()).toEqual(["POLICY:RUNNING", "SECURITY:RUNNING", "POLICY:PASSED", "SECURITY:PASSED"]);
    // Audits are attached to the train's own prompt (tail of includedPrompts), not a predecessor's,
    // and name the train and head, so race siblings of one item never share findings (notes, REWORK brief).
    expect(new Set(w.queen.audits().map((a) => a.promptId))).toEqual(new Set(["prompt-1"]));
    expect(new Set(w.queen.audits().map((a) => `${a.trainId}@${a.commitSha}`))).toEqual(new Set([`train-1@${after}`]));
    expect(w.queen.audits()[2]!.gitNotesPayload).toMatchObject({ result: "success", taskPrompt: prompt });
    expect(w.queen.scribes()).toEqual([]);
    expect(w.failures.stored).toEqual([]);
    expect(steps.names()).toEqual([
      "lookup train #1",
      "audit: policy+security running",
      "inspect: clone, scan, test",
      "audit: policy+security result",
      "memory: remember",
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
    expect(w.queen.methods().filter((m) => m !== "appendAudits" && m !== "getSnapshot")).toEqual(["recordScribeSummary", "reportTrainResult"]);

    expect(out.summary.length).toBeLessThanOrEqual(500);
    expect(out.summary).toContain("[fail] marker found in changed file features/fix.md");
    expect(w.queen.scribes()).toEqual([{ promptId: "prompt-1", trainId: "train-1", summary: out.summary }]);
    expect(w.queen.reports()).toEqual([{ trainId: "train-1", passed: false, summary: out.summary, commitSha: after, score: expect.objectContaining({ review: "off" }) }]);

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
    w.queen.appendAudits = async () => {
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

describe("runGate: preview smoke test", () => {
  const PREVIEW = "https://t-0a1b2c3d4e5f-hive-app.sub.workers.dev";

  it("hits the train's previewUrl, then still runs the scripted runner; no warning finding", async () => {
    const { w, after } = await setup();
    w.queen.train.previewUrl = PREVIEW;
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), config());
    expect(out).toMatchObject({ passed: true });
    expect(w.smoke.urls).toEqual([PREVIEW]);
    const ledger = JSON.stringify(w.queen.audits().map((a) => a.gitNotesPayload));
    expect(ledger).not.toContain("preview-smoke-skipped");
    expect(w.queen.reports()[0]!.summary).toContain("tests (20 checks)"); // 19 scripted + 1 smoke
  });

  it("a non-2xx preview fails the gate; the Scribe gets the status + body; the scripted runner is skipped", async () => {
    const { w, after } = await setup();
    w.queen.train.previewUrl = PREVIEW;
    w.smoke.result = {
      passed: false,
      status: 500,
      log: ["> smoke: GET /", " FAIL  preview smoke > GET / returns 2xx", "AssertionError: preview smoke failed: GET / returned HTTP 500 (expected 2xx)", 'response body: {"ok":false,"error":"boom"}'].join("\n"),
      firstError: "AssertionError: preview smoke failed: GET / returned HTTP 500 (expected 2xx)",
    };
    let scriptedRan = false;
    w.tests = { mode: "scripted", run: async () => ((scriptedRan = true), { passed: true, checks: 1, log: "" }) };
    const steps = new InlineSteps();
    const out = await runGate(gateTask(after), steps, w.ports(), config());
    expect(out).toMatchObject({ status: "gated", passed: false });
    expect(scriptedRan).toBe(false);
    expect(w.queen.reports()[0]).toMatchObject({ passed: false, summary: expect.stringContaining("HTTP 500") });
    expect(w.queen.scribes()[0]!.summary).toContain("preview smoke");
    expect(w.failures.stored[0]![0]!.text).toContain('response body: {"ok":false,"error":"boom"}');
  });

  it("no previewUrl (sim / old trains): smoke is skipped with a warning finding, the gate still passes", async () => {
    const { w, after } = await setup();
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), config());
    expect(out).toMatchObject({ passed: true });
    expect(w.smoke.urls).toEqual([]);
    const securityResult = w.queen.audits().find((a) => a.droneRole === "SECURITY" && a.status === "PASSED")!;
    expect(securityResult.gitNotesPayload!.reasoningSteps.join("\n")).toMatch(/\[warning\] preview-smoke-skipped .*skipped/);
  });

  it("waits through DEPLOYING until the Queen reaches TESTING", async () => {
    const { w, after } = await setup();
    w.queen.train.previewUrl = PREVIEW;
    w.queen.phases = ["BUILDING", "DEPLOYING", "DEPLOYING", "TESTING"];
    const steps = new InlineSteps();
    const out = await runGate(gateTask(after), steps, w.ports(), config({ GATE_PHASE_RETRIES: "6" }));
    expect(out).toMatchObject({ passed: true });
    expect(steps.sleeps).toHaveLength(3);
    expect(w.smoke.urls).toEqual([PREVIEW]);
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
  it("reports infra (instead of hanging in TESTING) when the clone keeps failing; stops once the Queen ejects the train", async () => {
    const { w, after } = await setup();
    w.artifacts.failWith = new Error("artifacts is unreachable");
    // After the infra report the Queen's infra cap is spent: the train is EJECTED.
    w.queen.phases = ["TESTING", "EJECTED"];
    const steps = new InlineSteps();
    const out = await runGate(gateTask(after), steps, w.ports(), config());
    expect(out).toMatchObject({ status: "gated", passed: false, infra: true, summary: expect.stringContaining("artifacts is unreachable") });
    expect(steps.log.find((l) => l.name === "inspect: clone, scan, test")).toMatchObject({ attempts: 5, ok: false }); // 1 + 4 retries
    expect(w.queen.reports()).toEqual([expect.objectContaining({ passed: false, cause: "infra" })]);
    expect(w.queen.reports()[0]!.commandId).toBeUndefined(); // a gate report, not a drone's
  });

  it("retries a 503 from Artifacts inside the inspect step (jittered), then gates normally", async () => {
    const { w, after } = await setup();
    let n = 0;
    const real = w.artifacts.access.bind(w.artifacts);
    w.artifacts.access = async (repo, scope) => {
      if (++n <= 2) throw new Error("HttpError: HTTP Error: 503 Service Unavailable");
      return real(repo, scope);
    };
    const steps = new InlineSteps();
    const out = await runGate(gateTask(after), steps, w.ports(), config());
    expect(out).toMatchObject({ status: "gated", passed: true });
    expect(out).not.toHaveProperty("infra");
    expect(n).toBe(3);
    // All within the first try of the step: the in-step jittered retry absorbed the 503s.
    expect(steps.log.find((l) => l.name === "inspect: clone, scan, test")).toMatchObject({ attempts: 1, ok: true });
    expect(w.queen.reports()).toEqual([expect.objectContaining({ passed: true })]);
  });

  it("a 503 that outlasts every retry is reported as infra, then re-gated after the Queen re-deploys", async () => {
    const { w, after } = await setup();
    let n = 0;
    const real = w.artifacts.access.bind(w.artifacts);
    // 4 in-step tries x 5 step tries = 20 failures in round 1; round 2 succeeds.
    w.artifacts.access = async (repo, scope) => {
      if (++n <= 20) throw new Error("HttpError: HTTP Error: 503 Service Unavailable");
      return real(repo, scope);
    };
    // Round 1 sees TESTING; after the infra report the Queen re-deploys (DEPLOYING), then TESTING again.
    w.queen.phases = ["TESTING", "DEPLOYING", "DEPLOYING", "TESTING"];
    const steps = new InlineSteps();
    const out = await runGate(gateTask(after), steps, w.ports(), config());
    expect(out).toMatchObject({ status: "gated", passed: true, rounds: 2 });
    expect(w.queen.reports().map((r) => [r.passed, r.cause ?? null])).toEqual([
      [false, "infra"],
      [true, null],
    ]);
    expect(steps.log.find((l) => l.name === "inspect: clone, scan, test")).toMatchObject({ attempts: 5, ok: false });
    expect(steps.log.find((l) => l.name === "inspect: clone, scan, test ~r2")).toMatchObject({ attempts: 1, ok: true });
    expect(steps.sleeps.map((x) => x.name)).toContain("infra: wait for the re-deploy ~r2");
  });

  it("gives up after GATE_INFRA_ROUNDS runs when the Queen keeps applying infra reports", async () => {
    const { w, after } = await setup();
    w.artifacts.failWith = new Error("HTTP Error: 502 Bad Gateway");
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), config({ GATE_INFRA_ROUNDS: "3" }));
    expect(out).toMatchObject({ status: "gated", passed: false, infra: true, rounds: 3 });
    expect(w.queen.reports()).toHaveLength(3);
    expect(w.queen.reports().every((r) => r.cause === "infra")).toBe(true);
  });

  it("toStepError never makes an HTTP 503 non-retryable", async () => {
    const { toStepError } = await import("../src/orchestrate");
    const { NonRetryableError } = await import("cloudflare:workflows");
    expect(toStepError(new Error("HttpError: HTTP Error: 503 Service Unavailable"))).not.toBeInstanceOf(NonRetryableError);
    expect(toStepError(new Error("UNAVAILABLE: ARTIFACTS binding is not configured"))).toBeInstanceOf(NonRetryableError);
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

const builderEvent = (id: string, createdAt: number, steps: string[], promptId = "prompt-1"): AuditEvent => ({
  eventId: id,
  promptId,
  droneRole: "BUILDER",
  status: "PASSED",
  createdAt,
  gitNotesPayload: { taskPrompt: "p", model: "m", temperature: 0, reasoningSteps: steps, result: "success", executionTimeMs: 1, discardedPaths: [] },
});

describe("runGate: hive memory", () => {
  it("remembers a pass with the builder's reasoning, changed files and the memory id", async () => {
    const { w, base, after } = await setup();
    w.queen.recentAudit = [
      builderEvent("e3", 30, ["newest step 1", "newest step 2", "s3", "s4", "s5", "s6", "s7-dropped"]),
      builderEvent("e2", 20, ["older"]),
      builderEvent("e9", 99, ["other prompt"], "prompt-0"),
      { ...builderEvent("e8", 90, []), gitNotesPayload: null },
    ];
    const before = Date.now();
    await runGate(gateTask(after, { before: base }), new InlineSteps(), w.ports(), config());
    expect(w.memory.records).toHaveLength(1);
    const r = w.memory.records[0]!;
    expect(r).toMatchObject({
      memoryId: memoryIdFor("train-1", after),
      namespace: HIVE,
      trainId: "train-1",
      promptId: "prompt-1",
      commitSha: after,
      outcome: "PASSED",
      promptText: prompt,
    });
    expect(r.createdAt).toBeGreaterThanOrEqual(before);
    expect(r.text).toContain(`Prompt: ${prompt}`);
    expect(r.text).toContain("Changed: ");
    expect(r.text).toContain("features/dark-mode.md");
    expect(r.text).toContain("Builder: newest step 1; newest step 2; s3; s4; s5; s6");
    expect(r.text).not.toContain("s7-dropped");
    expect(r.text).not.toContain("older");
    expect(r.text).toContain("Outcome: passed the gate. Gate passed");
  });

  it("remembers a test failure with the Scribe summary", async () => {
    const p = "Fix the flaky retry logic in the webhook sender [fail]";
    const { w, after } = await setup({ prompt: p, files: { ...CLEAN, "features/fix.md": `# ${p}\n\n## Request\n\n${p}\n` } });
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), config());
    if (out.status !== "gated") throw new Error("unreachable");
    expect(w.memory.records).toHaveLength(1);
    const r = w.memory.records[0]!;
    expect(r).toMatchObject({ outcome: "FAILED", memoryId: memoryIdFor("train-1", after) });
    expect(r.text).toContain("failed the gate");
    expect(r.text).toContain("[fail] marker found in changed file features/fix.md");
  });

  it("remembers a static-scan failure too", async () => {
    const { w, after } = await setup({ files: { "src/k.ts": 'export const k = "AKIAABCDEFGHIJKLMNOP";\n' } });
    await runGate(gateTask(after), new InlineSteps(), w.ports(), config());
    expect(w.memory.records.map((r) => r.outcome)).toEqual(["FAILED"]);
  });

  it("does not remember infra failures", async () => {
    const { w, after } = await setup();
    w.artifacts.failWith = new Error("artifacts is unreachable");
    const steps = new InlineSteps();
    await runGate(gateTask(after), steps, w.ports(), config());
    expect(w.memory.records).toEqual([]);
    expect(steps.names()).not.toContain("memory: remember");
  });

  it("never fails the gate when remember throws", async () => {
    const { w, after } = await setup();
    w.memory.error = new Error("vectorize is down");
    const steps = new InlineSteps();
    const out = await runGate(gateTask(after), steps, w.ports(), config());
    expect(out).toMatchObject({ status: "gated", passed: true, queenOutcome: "applied" });
    expect(w.queen.reports()).toHaveLength(1);
    expect(steps.log.find((l) => l.name === "memory: remember")).toMatchObject({ ok: false });
  });
});

describe("chunkLog", () => {
  it("splits and caps", () => {
    expect(chunkLog("a".repeat(4_000), 1_500, 6).map((c) => c.length)).toEqual([1_500, 1_500, 1_000]);
    expect(chunkLog("a".repeat(100_000))).toHaveLength(6);
    expect(chunkLog("")).toEqual([]);
  });
});

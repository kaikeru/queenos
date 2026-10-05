import { describe, expect, it } from "vitest";
import { SentinelVerdictSchema } from "@queenos/queen-types";
import { BASELINE_PER_BATCH, CANARY_SETTLE_MS, CANDIDATE_PER_BATCH, MAX_BATCHES, OVERRIDES_HEADER, planBatches, runSentinel } from "../src/orchestrate";
import { percentile } from "../src/verdict";
import { FakeWorld, InlineSteps, canary, staging } from "./fakes";

const HEADER = OVERRIDES_HEADER;
const isCandidate = (c: { headers: Record<string, string> }) => c.headers[HEADER]?.includes("cand-111");

describe("staging", () => {
  it("promotes a healthy staging and reports a valid verdict to the hive's Queen", async () => {
    const w = new FakeWorld();
    const steps = new InlineSteps();
    const out = await runSentinel(staging(), steps, w.ports());
    expect(out).toMatchObject({ verdict: "PROMOTE", queenOutcome: "applied" });
    expect(w.hives).toEqual(["My Hive"]);
    const v = SentinelVerdictSchema.parse(w.verdicts[0]);
    expect(v).toMatchObject({ commandId: "cmd-1", releaseId: "rel-1", environment: "staging", verdict: "PROMOTE" });
    expect(v.metrics).toMatchObject({ requests: 60, errorRate: 0, p99Ms: 20, baselineErrorRate: null });
    expect(v.summary).toBe("Staging: 0/60 errors; p99 20ms → promote");
    // staging never sends an override header and probes the default paths
    expect(w.calls.every((c) => Object.keys(c.headers).length === 0)).toBe(true);
    expect(new Set(w.calls.map((c) => c.url))).toEqual(new Set(["https://my-hive-staging.sub.workers.dev/", "https://my-hive-staging.sub.workers.dev/health"]));
    expect(steps.sleeps.some((s) => s.ms === CANARY_SETTLE_MS)).toBe(false);
  });

  it("rolls back when GET / is not 2xx in the first batch (smoke failure)", async () => {
    const w = new FakeWorld((c) => ({ status: c.url.endsWith("/") ? 404 : 200 }));
    const out = await runSentinel(staging(), new InlineSteps(), w.ports());
    expect(out.verdict).toBe("ROLLBACK");
    expect(w.verdicts[0]!.summary).toContain("smoke check failed");
    // 404 is not a 5xx, so this is a smoke failure but not an error
    expect(w.verdicts[0]!.metrics.errorRate).toBe(0);
  });

  it("only smoke-tests in the first batch", async () => {
    // "/" fails only after the first batch (calls beyond index 30): not a smoke failure
    const w = new FakeWorld((c, i) => ({ status: i >= CANDIDATE_PER_BATCH && c.url.endsWith("/") ? 404 : 200 }));
    await runSentinel(staging({ minRequests: 90 }), new InlineSteps(), w.ports());
    expect(w.verdicts[0]!.verdict).toBe("PROMOTE");
  });

  it("treats network errors and timeouts as errors and rolls back", async () => {
    const w = new FakeWorld((_c, i) => (i % 2 === 0 ? "throw" : { status: 200 }));
    await runSentinel(staging(), new InlineSteps(), w.ports());
    const v = w.verdicts[0]!;
    expect(v.verdict).toBe("ROLLBACK");
    expect(v.metrics.errorRate).toBe(0.5);
    expect(v.summary).toContain("smoke check failed");
  });

  it("rolls back on 5xx above 1% but tolerates 0.x%", async () => {
    const bad = new FakeWorld((_c, i) => ({ status: i === 5 || i === 6 ? 503 : 200 }));
    await runSentinel(staging({ minRequests: 90 }), new InlineSteps(), bad.ports());
    expect(bad.verdicts[0]!.verdict).toBe("ROLLBACK"); // 2/90 = 2.2%
    const ok = new FakeWorld((_c, i) => ({ status: i === 5 ? 500 : 200 }));
    await runSentinel(staging({ minRequests: 150 }), new InlineSteps(), ok.ports());
    expect(ok.verdicts[0]!.verdict).toBe("PROMOTE"); // 1/150 = 0.67%
  });
});

describe("canary", () => {
  it("probes candidate and stable pinned by version override, waits 5s first, and promotes", async () => {
    const w = new FakeWorld((c) => ({ status: 200, ms: isCandidate(c) ? 84 : 80 }));
    const steps = new InlineSteps();
    const out = await runSentinel(canary(), steps, w.ports());
    expect(out.verdict).toBe("PROMOTE");
    expect(steps.sleeps[0]).toEqual({ name: "settle: version override propagation", ms: CANARY_SETTLE_MS });
    for (const c of w.calls) {
      expect([`my-hive-app="cand-111"`, `my-hive-app="stab-222"`]).toContain(c.headers[HEADER]);
    }
    const cand = w.calls.filter(isCandidate).length;
    const stable = w.calls.length - cand;
    expect(cand).toBe(60);
    expect(stable).toBeGreaterThan(0);
    const v = w.verdicts[0]!;
    expect(v.metrics).toMatchObject({ requests: 60, errorRate: 0, p99Ms: 84, baselineErrorRate: 0 });
    expect(v.summary).toBe(`Canary 10%: 0/60 errors vs baseline 0/${stable}; p99 84ms vs 80ms → promote`);
  });

  it("rolls back on an error regression against a clean baseline", async () => {
    const w = new FakeWorld((c, i) => ({ status: isCandidate(c) && i % 10 === 3 ? 500 : 200 }));
    await runSentinel(canary(), new InlineSteps(), w.ports());
    const v = w.verdicts[0]!;
    expect(v.verdict).toBe("ROLLBACK");
    expect(v.metrics.errorRate).toBeGreaterThan(0.01);
    expect(v.metrics.baselineErrorRate).toBe(0);
    expect(v.summary).toContain("→ rollback");
  });

  it("allows a candidate error rate within baseline + 1% only if also under the 1% absolute cap", async () => {
    // both versions error at the same ~0.7% rate: under the absolute cap, so PROMOTE
    let k = 0;
    const w = new FakeWorld(() => ({ status: ++k % 150 === 0 ? 500 : 200 }));
    await runSentinel(canary({ minRequests: 150 }), new InlineSteps(), w.ports());
    expect(w.verdicts[0]!.metrics.errorRate).toBeLessThanOrEqual(0.01);
    expect(w.verdicts[0]!.verdict).toBe("PROMOTE");
  });

  it("rolls back on a latency regression (p99 > max(2000ms, 3x baseline))", async () => {
    const w = new FakeWorld((c) => ({ status: 200, ms: isCandidate(c) ? 2500 : 80 }));
    await runSentinel(canary(), new InlineSteps(), w.ports());
    expect(w.verdicts[0]).toMatchObject({ verdict: "ROLLBACK", metrics: { p99Ms: 2500 } });
    expect(w.verdicts[0]!.summary).toContain("p99 2500ms > 2000ms");
  });

  it("allows slow-but-proportional latency when the baseline is slow too", async () => {
    const w = new FakeWorld((c) => ({ status: 200, ms: isCandidate(c) ? 2500 : 1200 }));
    await runSentinel(canary(), new InlineSteps(), w.ports());
    expect(w.verdicts[0]!.verdict).toBe("PROMOTE"); // limit = max(2000, 3600)
  });

  it("rolls back when the pinned candidate errors on the network", async () => {
    const w = new FakeWorld((c) => (isCandidate(c) ? "throw" : { status: 200 }));
    await runSentinel(canary(), new InlineSteps(), w.ports());
    expect(w.verdicts[0]).toMatchObject({ verdict: "ROLLBACK", metrics: { errorRate: 1 } });
  });

  it("without a stable version there is no baseline and no stable probes", async () => {
    const w = new FakeWorld();
    await runSentinel(canary({ stableVersionId: undefined }), new InlineSteps(), w.ports());
    expect(w.calls.every(isCandidate)).toBe(true);
    expect(w.verdicts[0]!.metrics.baselineErrorRate).toBeNull();
  });

  it("rejects a canary command without a candidate version", async () => {
    await expect(runSentinel(canary({ candidateVersionId: undefined }), new InlineSteps(), new FakeWorld().ports())).rejects.toThrow(/candidateVersionId/);
  });
});

describe("batching", () => {
  it("spreads requests over the window in bounded batches with sleeps between", async () => {
    const w = new FakeWorld();
    const steps = new InlineSteps();
    await runSentinel(staging({ minRequests: 300, windowSeconds: 300 }), steps, w.ports());
    const probeSteps = steps.log.filter((s) => s.name.startsWith("probe batch"));
    expect(probeSteps).toHaveLength(10);
    expect(w.calls).toHaveLength(300);
    const waits = steps.sleeps.filter((s) => s.name.startsWith("wait before"));
    expect(waits).toHaveLength(9);
    expect(waits.every((s) => s.ms === 30_000)).toBe(true);
    // each step returned only counts and a small latency sample
    for (const r of steps.results.filter((x) => x.includes("latencies"))) expect(r.length).toBeLessThan(600);
  });

  it("never exceeds the per-batch subrequest budget, even for huge minRequests", () => {
    const plan = planBatches(100_000, 600);
    expect(plan.perBatch).toHaveLength(MAX_BATCHES);
    expect(Math.max(...plan.perBatch)).toBeLessThanOrEqual(CANDIDATE_PER_BATCH);
    expect(CANDIDATE_PER_BATCH + BASELINE_PER_BATCH).toBeLessThanOrEqual(50);
    expect(planBatches(7, 5)).toEqual({ perBatch: [7], gapMs: 0 });
    expect(planBatches(61, 60).perBatch.reduce((a, b) => a + b, 0)).toBe(61);
  });

  it("keeps canary batches (candidate + baseline) at or under 45 subrequests", async () => {
    const w = new FakeWorld();
    const steps = new InlineSteps();
    await runSentinel(canary({ minRequests: 300, windowSeconds: 300 }), steps, w.ports());
    const perStep = steps.results.filter((r) => r.includes('"c":')).map((r) => JSON.parse(r) as { c: { total: number }; b: { total: number } });
    expect(perStep.length).toBe(10);
    for (const s of perStep) expect(s.c.total + s.b.total).toBeLessThanOrEqual(45);
  });
});

describe("reporting", () => {
  it("retries transient Queen errors", async () => {
    const w = new FakeWorld();
    w.queenFailures = 2;
    const steps = new InlineSteps();
    await runSentinel(staging(), steps, w.ports());
    expect(w.verdicts).toHaveLength(1);
    expect(steps.log.find((s) => s.name === "report: sentinel verdict")!.attempts).toBe(3);
  });

  it.each(["INVALID_INPUT", "NOT_FOUND", "CONFLICT"])("treats %s as permanent (no retry)", async (code) => {
    const w = new FakeWorld();
    w.queenError = new Error(`${code}: nope`);
    const steps = new InlineSteps();
    const out = await runSentinel(staging(), steps, w.ports());
    expect(out.queenOutcome).toMatch(new RegExp(`^rejected: ${code}`));
    expect(steps.log.find((s) => s.name === "report: sentinel verdict")!.attempts).toBe(1);
  });
});

describe("percentile", () => {
  it("is nearest-rank", () => {
    expect(percentile([], 99)).toBeNull();
    expect(percentile([5], 99)).toBe(5);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 99)).toBe(99);
  });
});

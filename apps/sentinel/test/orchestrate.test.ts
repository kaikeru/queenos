import { describe, expect, it } from "vitest";
import { SentinelVerdictSchema } from "@queenos/queen-types";
import { BASELINE_PER_BATCH, CANARY_SETTLE_MS, READY_POLL_MS, READY_TIMEOUT_DEFAULT_SECONDS, CANDIDATE_PER_BATCH, MAX_BATCHES, OVERRIDES_HEADER, planBatches, runSentinel } from "../src/orchestrate";
import { decide, percentile } from "../src/verdict";
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
    expect(v.summary).toBe("Staging: 0/60 errors; p99 20ms; ready after 4s → promote");
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

  it("network errors / timeouts with no baseline are infrastructure (could not reach the deployment): inconclusive, not a health failure", async () => {
    const w = new FakeWorld((_c, i) => (i % 2 === 0 ? "throw" : { status: 200 }));
    await runSentinel(staging(), new InlineSteps(), w.ports());
    const v = w.verdicts[0]!;
    expect(v).toMatchObject({ verdict: "ROLLBACK", inconclusive: true });
    expect(v.metrics.errorRate).toBe(0);
    expect(v.summary).toContain("probes could not reach the deployment");
    expect(v.summary).not.toContain("smoke check failed");
  });

  it("a few unreachable probes (<= 1%) are left out of the sample and still promote", async () => {
    const w = new FakeWorld((_c, i) => (i === 7 ? "throw" : { status: 200 }));
    await runSentinel(staging({ minRequests: 100 }), new InlineSteps(), w.ports());
    expect(w.verdicts[0]).toMatchObject({ verdict: "PROMOTE" });
    expect(w.verdicts[0]!.inconclusive).toBeUndefined();
  });

  it("answered 5xx are still real failures even when some probes were unreachable", async () => {
    const w = new FakeWorld((_c, i) => (i % 2 === 0 ? "throw" : { status: 503 }));
    await runSentinel(staging(), new InlineSteps(), w.ports());
    expect(w.verdicts[0]).toMatchObject({ verdict: "ROLLBACK" });
    expect(w.verdicts[0]!.inconclusive).toBeUndefined();
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
    expect(steps.sleeps.filter((x) => x.name.startsWith("ready wait"))).toHaveLength(2);
    expect(steps.sleeps.find((x) => x.name.startsWith("settle"))).toEqual({ name: "settle: version override propagation", ms: CANARY_SETTLE_MS });
    // all three gate probes were pinned to the candidate
    expect(w.gateCalls).toHaveLength(3);
    for (const c of w.gateCalls) expect(c.headers[HEADER]).toBe(`my-hive-app="cand-111"`);
    for (const c of w.calls) {
      expect([`my-hive-app="cand-111"`, `my-hive-app="stab-222"`]).toContain(c.headers[HEADER]);
    }
    const cand = w.calls.filter(isCandidate).length;
    const stable = w.calls.length - cand;
    expect(cand).toBe(60);
    expect(stable).toBeGreaterThan(0);
    const v = w.verdicts[0]!;
    expect(v.metrics).toMatchObject({ requests: 60, errorRate: 0, p99Ms: 84, baselineErrorRate: 0 });
    expect(v.summary).toBe(`Canary 10%: 0/60 errors vs baseline 0/${stable}; p99 84ms vs 80ms; ready after 4s → promote`);
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

  it("rolls back when the pinned candidate errors on the network while the stable baseline answers (the candidate hangs)", async () => {
    const w = new FakeWorld((c) => (isCandidate(c) ? "throw" : { status: 200 }));
    await runSentinel(canary(), new InlineSteps(), w.ports());
    expect(w.verdicts[0]).toMatchObject({ verdict: "ROLLBACK", metrics: { errorRate: 1 } });
    expect(w.verdicts[0]!.inconclusive).toBeUndefined();
  });

  it("is inconclusive when neither the candidate nor the baseline can be reached (infrastructure)", async () => {
    const w = new FakeWorld(() => "throw");
    await runSentinel(canary(), new InlineSteps(), w.ports());
    expect(w.verdicts[0]).toMatchObject({ verdict: "ROLLBACK", inconclusive: true });
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

describe("readiness gate", () => {
  const notReady = (n: number) => (_c: unknown, i: number) => (i < n ? { status: 503, ms: 460 } : { status: 200, ms: 10 });

  it("ignores warm-up errors, counts none of them, and promotes", async () => {
    // 5 failing polls (propagation), then healthy: exactly the live incident
    const w = new FakeWorld(notReady(5));
    w.autoReady = false;
    const steps = new InlineSteps();
    const out = await runSentinel(staging(), steps, w.ports());
    expect(out.verdict).toBe("PROMOTE");
    const v = w.verdicts[0]!;
    expect(v.metrics).toMatchObject({ requests: 60, errorRate: 0 });
    expect(v.summary).toMatch(/0\/60 errors/);
    expect(v.summary).toMatch(/ready after \d+s/);
    // 5 failed + 3 good gate polls, then 60 measured
    expect(w.calls).toHaveLength(8 + 60);
    expect(steps.log.filter((s) => s.name.startsWith("ready poll"))).toHaveLength(8);
  });

  it("an intermittent warm-up resets the consecutive streak", async () => {
    const seq = [200, 200, 500, 200, 200, 200];
    const w = new FakeWorld((_c, i) => ({ status: i < seq.length ? seq[i]! : 200 }));
    w.autoReady = false;
    const steps = new InlineSteps();
    await runSentinel(staging(), steps, w.ports());
    expect(steps.log.filter((s) => s.name.startsWith("ready poll"))).toHaveLength(6);
    expect(w.verdicts[0]!.verdict).toBe("PROMOTE");
  });

  it("the smoke check applies to the first measured request, after the gate", async () => {
    // gate passes on 3 x 200 for "/", then the first measured "/" fails
    const w = new FakeWorld((c, i) => ({ status: i >= 3 && i === 3 && c.url.endsWith("/") ? 404 : 200 }));
    w.autoReady = false;
    await runSentinel(staging(), new InlineSteps(), w.ports());
    expect(w.verdicts[0]!.summary).toContain("smoke check failed");
  });

  it("never ready: ROLLBACK 'never became reachable within Ns (last status X)', nothing measured", async () => {
    const w = new FakeWorld(() => ({ status: 503, ms: 100 }));
    w.autoReady = false;
    const out = await runSentinel(staging({ readyTimeoutSeconds: 20 }), new InlineSteps(), w.ports());
    expect(out.verdict).toBe("ROLLBACK");
    const v = SentinelVerdictSchema.parse(w.verdicts[0]);
    expect(v.summary).toBe("Staging: never became reachable within 20s (last status 503) → rollback");
    expect(v.metrics.requests).toBe(0);
    expect(v.inconclusive).toBe(true);
    expect(out).toMatchObject({ inconclusive: true });
    // only the gate probed "/": no measured traffic
    expect(w.calls.every((c) => c.url.endsWith("/"))).toBe(true);
  });

  it("reports a network error as the last status", async () => {
    const w = new FakeWorld(() => "throw");
    w.autoReady = false;
    await runSentinel(staging({ readyTimeoutSeconds: 10 }), new InlineSteps(), w.ports());
    expect(w.verdicts[0]!.summary).toContain("(last status network error)");
  });

  it("respects the cap: bounded polls, default 90s, sleeps are short steps", async () => {
    const w = new FakeWorld(() => ({ status: 503, ms: 0 }));
    w.autoReady = false;
    const steps = new InlineSteps();
    await runSentinel(staging(), steps, w.ports());
    expect(w.verdicts[0]!.summary).toContain(`within ${READY_TIMEOUT_DEFAULT_SECONDS}s`);
    const polls = steps.log.filter((s) => s.name.startsWith("ready poll")).length;
    expect(polls).toBeLessThanOrEqual(Math.ceil((READY_TIMEOUT_DEFAULT_SECONDS * 1000) / READY_POLL_MS) + 1);
    expect(polls).toBeGreaterThan(40);
    expect(steps.sleeps.every((s) => s.ms === READY_POLL_MS)).toBe(true);
    // slow responses eat into the cap too
    const slow = new FakeWorld(() => ({ status: 503, ms: 5000 }));
    slow.autoReady = false;
    const s2 = new InlineSteps();
    await runSentinel(staging({ readyTimeoutSeconds: 30 }), s2, slow.ports());
    expect(s2.log.filter((s) => s.name.startsWith("ready poll")).length).toBeLessThanOrEqual(5);
  });

  it("canary: the gate itself is pinned to the candidate by the override header", async () => {
    const w = new FakeWorld(() => ({ status: 503 }));
    w.autoReady = false;
    await runSentinel(canary({ readyTimeoutSeconds: 10 }), new InlineSteps(), w.ports());
    expect(w.calls.length).toBeGreaterThan(0);
    for (const c of w.calls) expect(c.headers[HEADER]).toBe(`my-hive-app="cand-111"`);
    expect(w.verdicts[0]).toMatchObject({ verdict: "ROLLBACK", environment: "canary" });
  });

  it("staging gate uses the plain URL with no override header", async () => {
    const w = new FakeWorld();
    await runSentinel(staging(), new InlineSteps(), w.ports());
    expect(w.gateCalls.every((c) => Object.keys(c.headers).length === 0 && c.url === "https://my-hive-staging.sub.workers.dev/")).toBe(true);
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

describe("v2: inconclusive, AE window point, trace logs", () => {
  const TRACE = "d".repeat(32);
  const trace = { traceparent: `00-${TRACE}-${"e".repeat(16)}-01` };

  it("a healthy verdict is not inconclusive, and writes one sentinel.window point", async () => {
    const w = new FakeWorld();
    const out = await runSentinel(staging({ trace }), new InlineSteps(), w.ports());
    expect(out).toMatchObject({ verdict: "PROMOTE" });
    expect(w.verdicts[0]!.inconclusive).toBeUndefined();
    expect(w.points).toEqual([{ type: "sentinel.window", hive: "My Hive", kindOrRole: "sentinel", outcome: "PROMOTE", environment: "staging", traceId: TRACE, valueMs: 20, count: 60 }]);
  });

  it("a readiness timeout writes an INCONCLUSIVE point", async () => {
    const w = new FakeWorld(() => ({ status: 503, ms: 100 }));
    w.autoReady = false;
    await runSentinel(staging({ readyTimeoutSeconds: 20 }), new InlineSteps(), w.ports());
    expect(w.points[0]).toMatchObject({ outcome: "INCONCLUSIVE", count: 0 });
    expect(w.points[0]).not.toHaveProperty("valueMs");
  });

  it("decide(): healthy but under half of minRequests is ROLLBACK + inconclusive; real failures are not", () => {
    const cmd = { commandId: "c", releaseId: "r", environment: "staging" as const, minRequests: 100 };
    const tally = (total: number, errors = 0) => ({ total, errors, smokeFailures: 0, latencies: Array(total).fill(10) as number[] });
    const few = decide(cmd, tally(49), null);
    expect(few).toMatchObject({ verdict: "ROLLBACK", inconclusive: true });
    expect(few.summary).toContain("only 49 of 100");
    expect(decide(cmd, tally(50), null)).toMatchObject({ verdict: "PROMOTE" });
    const bad = decide(cmd, tally(10, 5), null);
    expect(bad.verdict).toBe("ROLLBACK");
    expect(bad.inconclusive).toBeUndefined();
    expect(SentinelVerdictSchema.parse(few).inconclusive).toBe(true);
  });

  it("logs readiness and the verdict under the command's trace", async () => {
    const w = new FakeWorld();
    await runSentinel(staging({ trace }), new InlineSteps(), w.ports());
    expect(w.logs.map((l) => [l.step, l.outcome])).toEqual([
      ["sentinel: readiness", "ready"],
      ["sentinel: verdict", "PROMOTE"],
    ]);
    expect(w.logs[0]).toMatchObject({ trace_id: TRACE, hive: "My Hive", command_id: "cmd-1", span_id: expect.stringMatching(/^[0-9a-f]{16}$/) });
  });

  it("telemetry that throws never fails the verdict", async () => {
    const w = new FakeWorld();
    const ports = w.ports();
    ports.log = () => {
      throw new Error("log down");
    };
    ports.metric = () => {
      throw new Error("ae down");
    };
    const out = await runSentinel(staging(), new InlineSteps(), ports);
    expect(out).toMatchObject({ verdict: "PROMOTE", queenOutcome: "applied" });
  });
});

/** WP1.6: MERGE routing, finish followUps, BuildResult v2 fields, 429 handling, trace logs, AE points. */
import { NonRetryableError } from "cloudflare:workflows";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiGatewayError, parseLedger } from "@queenos/hive-kit";
import { DroneTaskSchema, spanIdFor, traceparent, type MergeResultInput } from "@queenos/queen-types";
import { readConfig } from "../src/config";
import { generateLive } from "../src/generate";
import { AGENT_PHASE_MS, MIN_MODEL_MS, runAgentBuild } from "../src/agent/run";
import { AGENT_SYSTEM_PROMPT } from "../src/agent/prompt";
import { FinishInputSchema, MAX_FOLLOW_UPS, runFinish, runVerify, EMPTY_TOOL_STATE, type DroneToolDeps, type ToolState } from "../src/agent/tools";
import { AGENT_RETRY_DELAY_MS, AGENT_STEP_RETRIES, DroneFailedError, MERGE_MODEL, agentStepConfig, isInfraFailure, runDrone, toStepError } from "../src/orchestrate";
import type { MergeCarFn } from "../src/ports";
import { FakeAgent, FakeLlm, FakeLoader, FakeWorld, InlineSteps, PASSING_VERIFY, STARTER_FILES, htmlAgent, starterResponses, task, type AgentScript } from "./fakes";

const REPO = "hive-train-aaaaaaaaaaaa";
const agentCfg = readConfig({ DRONE_LLM_MODE: "live", AI_GATEWAY_ID: "gw", MODEL_BUILDER: "@cf/zai-org/glm-5.3-flash" });
const singleShot = readConfig({ DRONE_LLM_MODE: "live", DRONE_HARNESS: "single-shot", MODEL_BUILDER: "@cf/default/model" });
const choice = (model: string, ...fallbacks: string[]) => ({ model, tier: "fast" as const, role: "builder" as const, reason: "test", fallbacks });
const parsed = (o = {}) => DroneTaskSchema.parse(task(o));

/** Zero jitter, recorded sleeps: backoff waits are 500 ms, 1000 ms, ... */
function backoff(maxAttempts = 4) {
  const sleeps: number[] = [];
  return { sleeps, opts: { maxAttempts, random: () => 0, sleep: async (ms: number) => void sleeps.push(ms) } };
}
const rateLimited = () => new AiGatewayError("AI run failed: 429 Too Many Requests", 429, true);

const goodChangeSet = JSON.stringify({
  files: [
    { path: "src/features/status.js", content: 'export const slug = "status";\nexport async function handle() { return Response.json({ ok: true }); }\n' },
    { path: "src/features/index.js", content: 'import * as f0 from "./status.js";\nexport const features = [f0];\n' },
  ],
  reasoningSteps: ["added status"],
  discardedPaths: [],
});

afterEach(() => vi.restoreAllMocks());

describe("429 / rate limit: retried with jittered backoff, never a failed model", () => {
  it("single-shot: retries in place, then succeeds with failedModels empty", async () => {
    const llm = new FakeLlm((_req, n) => (n <= 2 ? rateLimited() : goodChangeSet));
    const b = backoff();
    const out = await generateLive({ llm, task: parsed({ modelChoice: choice("@cf/a", "@cf/b") }), config: singleShot, context: null, backoff: b.opts });
    expect(out).toMatchObject({ model: "@cf/a", failedModels: [] });
    expect(llm.requests.map((r) => r.model)).toEqual(["@cf/a", "@cf/a", "@cf/a"]);
    expect(b.sleeps).toEqual([500, 1000]);
  });

  it("single-shot: a model still rate-limited after the retries is skipped without being marked failed", async () => {
    const llm = new FakeLlm((req) => (req.model === "@cf/a" ? rateLimited() : goodChangeSet));
    const b = backoff(2);
    const out = await generateLive({ llm, task: parsed({ modelChoice: choice("@cf/a", "@cf/b") }), config: singleShot, context: null, backoff: b.opts });
    expect(out).toMatchObject({ model: "@cf/b", failedModels: [] });
  });

  it("single-shot: rate-limited everywhere throws the retryable 429 (the step retries), not AllModelsFailed", async () => {
    const llm = new FakeLlm(() => rateLimited());
    const err = await generateLive({ llm, task: parsed({ modelChoice: choice("@cf/a", "@cf/b") }), config: singleShot, context: null, backoff: backoff(2).opts }).catch((e) => e);
    expect(err).toBeInstanceOf(AiGatewayError);
    expect(err).toMatchObject({ status: 429, retryable: true });
  });

  it("single-shot: bad output from one model plus a 429 on the next still reports only the bad one", async () => {
    const llm = new FakeLlm((req) => (req.model === "@cf/a" ? "garbage" : rateLimited()));
    const err = await generateLive({ llm, task: parsed({ modelChoice: choice("@cf/a", "@cf/b") }), config: singleShot, context: null, backoff: backoff(2).opts }).catch((e) => e);
    expect(err).toMatchObject({ status: 429 });
  });

  async function agentWorld(script: (model: string) => AgentScript) {
    const w = new FakeWorld();
    await w.git.seed(REPO, STARTER_FILES);
    w.agent = new FakeAgent(script);
    return { w, agent: w.agent };
  }
  const opts = (b: ReturnType<typeof backoff>) => ({ instanceId: "i", deadlineMs: AGENT_PHASE_MS, now: () => 0, backoff: b.opts });

  it("agent: a rate-limited run is re-submitted under a fresh key and the model is not failed", async () => {
    let n = 0;
    const { w, agent } = await agentWorld(() => (input, files) => (++n <= 2 ? { status: "error", error: "AiError: 429 rate limit exceeded" } : htmlAgent(input, files)));
    const b = backoff();
    const g = await runAgentBuild(parsed({ modelChoice: choice("m-a", "m-b") }), w.ports(), agentCfg, opts(b));
    expect(g).toMatchObject({ model: "m-a", failedModels: [] });
    expect(agent.calls.map((c) => c.input.idempotencyKey)).toEqual(["i:m-a", "i:m-a:rl1", "i:m-a:rl2"]);
    expect(b.sleeps).toEqual([500, 1000]);
  });

  it("agent: rate-limited past the retries propagates as a retryable 429 and never becomes failedModels", async () => {
    const { w } = await agentWorld(() => () => ({ status: "error", error: "429 Too Many Requests" }));
    const err = await runAgentBuild(parsed({ modelChoice: choice("m-a", "m-b") }), w.ports(), agentCfg, opts(backoff(2))).catch((e) => e);
    expect(err).toBeInstanceOf(AiGatewayError);
    expect(err).toMatchObject({ status: 429, retryable: true });
    expect(err).not.toHaveProperty("failedModels");
  });

  // The live failure (2026-10-06, hive demo): 12 Think builders started together, 8 hit Workers AI's
  // per-minute limit, the step's single 5 s retry re-attached to the spent submissions, and the drone
  // reported a BUILD FAILURE: the Queen reworked the items (escalating the model) and added load.
  const LIVE_429 = "3021: rate limiting: inference request per min rate reached";

  it("agent step: a rate limit past the in-step retries makes the STEP retry with a long jittered delay, then builds; no failure report, no failedModels", async () => {
    let fresh = 0;
    const { w, agent } = await agentWorld(() => (input, files) => (++fresh <= 6 ? { status: "error", error: LIVE_429 } : htmlAgent(input, files)));
    const steps = new InlineSteps();
    const out = await runDrone(task({ modelChoice: choice("m-a", "m-b") }), steps, w.ports(), agentCfg, { instanceId: "t-build", backoff: backoff().opts });
    expect(out.status).toBe("built");

    // Step attempt 1: 4 in-step tries (keys 0..3), all 429. Step attempt 2 re-attaches to those 4 spent
    // submissions without a model call, then starts key 4 (429), key 5 (429), key 6 (built).
    expect(steps.log.find((l) => l.name === "agent: build")).toMatchObject({ attempts: 2, ok: true });
    expect(agent.started).toEqual(["t-build:m-a", ...[1, 2, 3, 4, 5, 6].map((n) => `t-build:m-a:rl${n}`)]);
    expect(agent.calls.filter((c) => c.input.model === "m-b")).toEqual([]); // the fallback was never charged with it
    const [d] = steps.retryDelays;
    expect(steps.retryDelays).toHaveLength(1);
    expect(d!.error).toMatch(/rate limited: 3021/);
    expect(d!.ms).toBeGreaterThanOrEqual(15_000);
    expect(d!.ms).toBeLessThanOrEqual(30_000);

    const q = w.queen("hive");
    expect(q.calls.map((c) => c.method)).toEqual(["appendAudit", "reportBuildResult", "appendAudit"]);
    const built = q.calls.find((c) => c.method === "reportBuildResult")!.input as { model: string; failedModels?: string[] };
    expect(built.model).toBe("m-a");
    expect(built.failedModels).toBeUndefined();
    expect(steps.names()).not.toContain("report: build failure");
  });

  it("agent step: rate-limited through every step retry reports an INFRA outcome (cause: infra), never a build failure or failedModels", async () => {
    const { w } = await agentWorld(() => () => ({ status: "error", error: LIVE_429 }));
    const steps = new InlineSteps();
    const err = await runDrone(task({ modelChoice: choice("m-a", "m-b") }), steps, w.ports(), agentCfg, { instanceId: "t-build", backoff: backoff().opts }).catch((e) => e);
    expect(err).toBeInstanceOf(DroneFailedError);
    expect(steps.log.find((l) => l.name === "agent: build")).toMatchObject({ attempts: AGENT_STEP_RETRIES + 1, ok: false });
    // Every step retry waited a long, jittered, growing backoff (≤ 90 s each, ≤ 6 min in all).
    expect(steps.retryDelays).toHaveLength(AGENT_STEP_RETRIES);
    for (const d of steps.retryDelays) {
      expect(d.ms).toBeGreaterThanOrEqual(15_000);
      expect(d.ms).toBeLessThanOrEqual(90_000);
    }
    expect(steps.retryDelays.reduce((n, d) => n + d.ms, 0)).toBeLessThanOrEqual(6 * 60_000);

    expect(steps.names()).toContain("report: infra failure");
    expect(steps.names()).not.toContain("report: build failure");
    const q = w.queen("hive");
    const reports = q.calls.filter((c) => c.method === "reportTrainResult");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.input).toMatchObject({ trainId: "train-1", passed: false, cause: "infra", commandId: "t-build" });
    expect((reports[0]!.input as { summary: string }).summary).toMatch(/infrastructure limit \(not a build failure\).*rate limited: 3021/);
    expect(q.calls.some((c) => c.method === "reportBuildResult")).toBe(false);
    expect(JSON.stringify(q.calls)).not.toContain("failedModels");
  });

  it("agentStepConfig: rate limits wait 15-30 s, 30-60 s, then 45-90 s; other errors 5 s; never past the agent phase", () => {
    const at = (attempt: number, error: Error, cfg = agentStepConfig(AGENT_PHASE_MS, () => 0, () => 0.5)) => {
      const delay = cfg.retries!.delay as (i: { ctx: { attempt: number }; error: Error }) => number;
      return delay({ ctx: { attempt }, error });
    };
    const rl = new Error("AiGatewayError: rate limited: 3021: rate limiting: inference request per min rate reached");
    expect(agentStepConfig(0).retries).toMatchObject({ limit: AGENT_STEP_RETRIES, backoff: "constant" });
    expect([1, 2, 3, 4, 5].map((a) => at(a, rl))).toEqual([22_500, 45_000, 67_500, 67_500, 67_500]);
    expect(at(1, new AiGatewayError("AI run failed: 429", 429, true))).toBe(22_500);
    expect(at(1, new Error("Durable Object reset because its code was updated."))).toBe(AGENT_RETRY_DELAY_MS);
    // Near the deadline a long wait could no longer start a model: retry at once and fail fast as INFRA.
    const late = agentStepConfig(AGENT_PHASE_MS, () => AGENT_PHASE_MS - MIN_MODEL_MS - 30_000, () => 0.5);
    expect(at(1, rl, late)).toBe(22_500);
    expect(at(2, rl, late)).toBe(1_000);
  });

  it("isInfraFailure: rate limits and INFRA (budget used up by retries) are infra; model and gate failures are not", () => {
    expect(isInfraFailure(new Error(`AiGatewayError: rate limited: ${LIVE_429}`))).toBe(true);
    expect(isInfraFailure(new AiGatewayError("AI run failed: 429 Too Many Requests", 429, true))).toBe(true);
    expect(isInfraFailure(new Error("INFRA: agent wall-time budget used up by retries before any model could run (AI rate limits?)"))).toBe(true);
    expect(isInfraFailure(new Error("NonRetryableError: INFRA: agent wall-time budget used up"))).toBe(true);
    expect(isInfraFailure(new Error("no verified change from any model: m-a: no accepted finish after 16 step(s)"))).toBe(false);
    expect(isInfraFailure(new Error("3046: Request timeout"))).toBe(false);
  });

  it("agent: other provider errors are still plain failures (failedModels) with no backoff", async () => {
    const { w } = await agentWorld((m) => (m === "m-a" ? () => ({ status: "error", error: "3046: Request timeout" }) : htmlAgent));
    const b = backoff();
    const g = await runAgentBuild(parsed({ modelChoice: choice("m-a", "m-b") }), w.ports(), agentCfg, opts(b));
    expect(g.failedModels).toEqual(["m-a"]);
    expect(b.sleeps).toEqual([]);
  });
});

describe("finish followUps", () => {
  const fu = (i: number) => ({ kind: "bug" as const, title: `Problem ${i}`, body: "b", paths: ["src/x.js"], priority: 2 });
  const base = { summary: "s", reasoningSteps: ["r"] };

  it("accepts up to 3, defaults to none, rejects a 4th", () => {
    expect(MAX_FOLLOW_UPS).toBe(3);
    expect(FinishInputSchema.parse(base).followUps).toEqual([]);
    expect(FinishInputSchema.parse({ ...base, followUps: [{ kind: "chore", title: "t", body: "" }] }).followUps).toEqual([{ kind: "chore", title: "t", body: "", paths: [], priority: 2 }]);
    expect(FinishInputSchema.safeParse({ ...base, followUps: [fu(1), fu(2), fu(3)] }).success).toBe(true);
    expect(FinishInputSchema.safeParse({ ...base, followUps: [fu(1), fu(2), fu(3), fu(4)] }).success).toBe(false);
  });

  it("the system prompt states the rule", () => {
    expect(AGENT_SYSTEM_PROMPT).toMatch(/up to 3 real problems you noticed OUTSIDE your task/);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/never your own unfinished work/);
  });

  it("runFinish keeps the followUps on the accepted finish", async () => {
    let state: ToolState = EMPTY_TOOL_STATE;
    const files = { ...STARTER_FILES, "src/index.js": STARTER_FILES["src/index.js"]!.replace("ok: true, app", "html: true, app") + "// <html\n" };
    const d: DroneToolDeps = { snapshot: async () => ({ ...files }), base: () => STARTER_FILES, loader: new FakeLoader(starterResponses), state: { get: () => state, put: (s) => void (state = s) } };
    await runVerify(d, undefined);
    expect(await runFinish(d, { ...base, discardedPaths: [], followUps: [fu(1)] })).toEqual({ ok: true });
    expect(state.finish?.followUps).toEqual([fu(1)]);
  });
});

describe("BuildResult v2 fields (agent harness)", () => {
  it("reports verified, followUps, usage and changedPaths", async () => {
    const w = new FakeWorld();
    await w.git.seed(REPO, STARTER_FILES);
    const script: AgentScript = (input, files) => ({
      ...htmlAgent(input, files),
      finish: {
        summary: "Serve HTML at /",
        reasoningSteps: ["r"],
        discardedPaths: [],
        followUps: [{ kind: "bug", title: "x".repeat(200), body: "The router 404s /status", paths: ["src/index.js"] }],
      },
      usage: { inputTokens: 500, outputTokens: 50, steps: 4 },
    });
    w.agent = new FakeAgent(() => script);
    await runDrone(task({ modelChoice: choice("m-a") }), new InlineSteps(), w.ports(), agentCfg);
    const report = w.queen("hive").calls.find((c) => c.method === "reportBuildResult")!;
    expect(report.input).toMatchObject({
      verified: true,
      usage: { inputTokens: 500, outputTokens: 50, steps: 4 },
      changedPaths: ["src/index.js"],
      followUps: [{ kind: "bug", title: expect.stringMatching(/^x{119}…$/), body: "The router 404s /status", paths: ["src/index.js"], priority: 2 }],
    });
  });

  it("scripted builds report changedPaths, but no verified or followUps", async () => {
    const w = new FakeWorld();
    await w.git.seed(REPO);
    await runDrone(task(), new InlineSteps(), w.ports(), readConfig({ DRONE_LLM_MODE: "scripted" }));
    const input = w.queen("hive").calls.find((c) => c.method === "reportBuildResult")!.input as Record<string, unknown>;
    expect(input.changedPaths).toEqual(expect.arrayContaining(["src/features/index.js"]));
    expect(input).not.toHaveProperty("verified");
    expect(input).not.toHaveProperty("followUps");
  });
});

describe("MERGE", () => {
  const SHA_A = "a".repeat(40);
  const members = [{ trainId: "b-1", promptId: "p-1", artifactRepo: "hive-train-bbbbbbbbbbbb", headSha: SHA_A, title: "Add search" }];
  const mergeTask = (o = {}) => task({ action: "MERGE", role: "LANDER", trainId: "car-1", promptText: "queue car car-1: 1 members", members, ...o });
  const scriptedCfg = readConfig({ DRONE_LLM_MODE: "scripted" });

  it("routes to mergeCar with a fixed timestamp, reports reportMergeResult, audits as LANDER with queenos/merge-git", async () => {
    const w = new FakeWorld();
    const calls: { task: string; ts: number }[] = [];
    const merged: MergeResultInput = { trainId: "car-1", ok: true, headSha: "c".repeat(40), baseSha: "d".repeat(40), merged: ["b-1"], conflicts: [], fastForward: true, summary: "merged 1" };
    w.mergeCar = (async (_ports, t, ts) => (calls.push({ task: t.trainId, ts }), merged)) as MergeCarFn;
    const steps = new InlineSteps();
    const out = await runDrone(mergeTask(), steps, w.ports(), scriptedCfg);

    expect(out).toMatchObject({ action: "MERGE", status: "merged", headSha: "c".repeat(40), merged: 1, conflicts: 0, fastForward: true, queenOutcome: "applied" });
    expect(steps.names()).toEqual(["clock: start", "audit: running", "merge: members onto the car fork", "clock: merged", "report: merge result", "audit: passed"]);
    expect(calls).toEqual([{ task: "car-1", ts: expect.any(Number) }]);

    const q = w.queen("hive");
    expect(q.calls.map((c) => c.method)).toEqual(["appendAudit", "reportMergeResult", "appendAudit"]);
    expect(q.calls[1]!.input).toMatchObject({ trainId: "car-1", ok: true, merged: ["b-1"], fastForward: true, mergeMs: expect.any(Number) });
    const [running, passed] = q.audits();
    expect(running).toMatchObject({ droneRole: "LANDER", status: "RUNNING" });
    expect(passed).toMatchObject({ droneRole: "LANDER", status: "PASSED", gitNotesPayload: { model: MERGE_MODEL, result: "success" } });
    expect(MERGE_MODEL).toBe("queenos/merge-git");
    expect(parseLedger(JSON.stringify(passed!.gitNotesPayload)).model).toBe("queenos/merge-git");
  });

  it("reports conflicts to the Queen as part of an ok result", async () => {
    const w = new FakeWorld();
    w.mergeCar = async () => ({ ok: true, headSha: "c".repeat(40), merged: ["b-1"], conflicts: [{ trainId: "b-2", kind: "content", paths: ["src/theme.js"], summary: "x" }], fastForward: false });
    const out = await runDrone(mergeTask(), new InlineSteps(), w.ports(), scriptedCfg);
    expect(out).toMatchObject({ status: "merged", merged: 1, conflicts: 1 });
    expect(w.queen("hive").calls.find((c) => c.method === "reportMergeResult")!.input).toMatchObject({ conflicts: [{ trainId: "b-2", paths: ["src/theme.js"] }] });
  });

  it("an infrastructure failure is reported as ok:false (never thrown) with a REJECTED audit", async () => {
    const w = new FakeWorld();
    w.mergeCar = async () => {
      throw new Error("UNAVAILABLE: Artifacts is down");
    };
    const out = await runDrone(mergeTask(), new InlineSteps(), w.ports(), scriptedCfg);
    expect(out).toMatchObject({ action: "MERGE", status: "failed", merged: 0 });
    const q = w.queen("hive");
    expect(q.calls.find((c) => c.method === "reportMergeResult")!.input).toMatchObject({ trainId: "car-1", ok: false, summary: expect.stringContaining("Artifacts is down") });
    expect(q.audits().at(-1)).toMatchObject({ droneRole: "LANDER", status: "REJECTED", gitNotesPayload: { model: MERGE_MODEL, result: "failure" } });
  });

  it("toStepError keeps a transient 503 retryable (even with a permanent-looking prefix) but not a permanent error", () => {
    expect(toStepError(new Error("HttpError: HTTP Error: 503 Service Unavailable"), scriptedCfg)).not.toBeInstanceOf(NonRetryableError);
    expect(toStepError(new Error("UNAVAILABLE: Artifacts 503 Service Unavailable"), scriptedCfg)).not.toBeInstanceOf(NonRetryableError);
    expect(toStepError(new Error("INVALID_INPUT: bad member"), scriptedCfg)).toBeInstanceOf(NonRetryableError);
  });

  it("a transient 503 that outlasts every retry is reported ok:false with cause infra + this instance's id (the Queen re-dispatches the same car)", async () => {
    const w = new FakeWorld();
    let calls = 0;
    w.mergeCar = async () => {
      calls++;
      throw new Error("HttpError: HTTP Error: 503 Service Unavailable");
    };
    const out = await runDrone(mergeTask(), new InlineSteps(), w.ports(), scriptedCfg);
    expect(out).toMatchObject({ action: "MERGE", status: "failed" });
    expect(calls).toBe(4); // 1 + MERGE_STEP.retries.limit: the transient error stays retryable
    expect(w.queen("hive").calls.find((c) => c.method === "reportMergeResult")!.input).toMatchObject({
      trainId: "car-1", ok: false, cause: "infra", commandId: "car-1-merge", summary: expect.stringContaining("503"),
    });
  });

  it("a non-transient failure is ok:false WITHOUT cause (old semantics)", async () => {
    const w = new FakeWorld();
    w.mergeCar = async () => {
      throw new Error("UNAVAILABLE: Artifacts is down");
    };
    await runDrone(mergeTask(), new InlineSteps(), w.ports(), scriptedCfg);
    expect((w.queen("hive").calls.find((c) => c.method === "reportMergeResult")!.input as { cause?: string }).cause).toBeUndefined();
  });

  it("a 503 then success inside the step retries is a normal merged result", async () => {
    const w = new FakeWorld();
    let calls = 0;
    w.mergeCar = async () => {
      if (++calls === 1) throw new Error("HttpError: HTTP Error: 503 Service Unavailable");
      return { ok: true, headSha: "c".repeat(40), merged: ["b-1"], conflicts: [], fastForward: false };
    };
    const out = await runDrone(mergeTask(), new InlineSteps(), w.ports(), scriptedCfg);
    expect(out).toMatchObject({ status: "merged", merged: 1 });
  });

  it("the default adapter is WP1.12's mergeCar: an unreachable car fork reports ok:false", async () => {
    const w = new FakeWorld(); // no repos: the real mergeCar's clone fails, retries run out
    const out = await runDrone(mergeTask(), new InlineSteps(), w.ports(), scriptedCfg);
    expect(out).toMatchObject({ status: "failed", summary: expect.stringContaining("Merge drone failed") });
  });
});

describe("structured logs and Analytics Engine", () => {
  const traceId = "4e1f".repeat(8);
  const parent = "00f067aa0ba902b7";
  const logged = (spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] =>
    spy.mock.calls.flatMap((c) => {
      try {
        const o = JSON.parse(String(c[0]));
        return o && typeof o === "object" && "step" in o ? [o as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });

  it("logs every drone step with the trace fields from DroneTask.trace", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const w = new FakeWorld();
    await w.git.seed(REPO);
    await runDrone(task({ trace: { traceparent: traceparent(traceId, parent) } }), new InlineSteps(), w.ports(), readConfig({ DRONE_LLM_MODE: "scripted" }), { instanceId: "train-1-build" });
    const lines = logged(spy);
    expect(lines.map((l) => l.step)).toEqual(expect.arrayContaining(["drone: start", "report: build result"]));
    for (const l of lines) {
      expect(l).toMatchObject({ trace_id: traceId, parent_span_id: parent, hive: "hive", command_id: "train-1-build", action: "BUILD" });
      expect(l.span_id).toBe(spanIdFor(`train-1-build/${String(l.step)}`));
    }
    expect(lines.find((l) => l.step === "report: build result")).toMatchObject({ outcome: "applied", ms: expect.any(Number) });
  });

  it("logs without trace fields when the task has no trace (v1 Queen)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const w = new FakeWorld();
    await w.git.seed(REPO);
    await runDrone(task(), new InlineSteps(), w.ports(), readConfig({ DRONE_LLM_MODE: "scripted" }));
    const lines = logged(spy);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).not.toHaveProperty("trace_id");
  });

  it("writes one AE point per build, with the trace id, model and tokens", async () => {
    const w = new FakeWorld();
    await w.git.seed(REPO, STARTER_FILES);
    w.agent = new FakeAgent(() => (i, f) => ({ ...htmlAgent(i, f), usage: { inputTokens: 700, outputTokens: 70, steps: 3 } }));
    await runDrone(task({ modelChoice: choice("m-a"), trace: { traceparent: traceparent(traceId, parent) } }), new InlineSteps(), w.ports(), agentCfg);
    expect(w.points).toHaveLength(1);
    const p = w.points[0]!;
    expect(p.indexes).toEqual(["hive"]);
    expect(p.blobs).toEqual(["drone.build", "hive", "BUILDER", "m-a", "built", "drone", traceId, ""]);
    expect(p.doubles.slice(1, 3)).toEqual([700, 70]);
  });

  it("writes a failed point when the build fails", async () => {
    const w = new FakeWorld();
    await w.git.seed(REPO, STARTER_FILES);
    w.agent = new FakeAgent(() => () => ({ status: "error", error: "boom" }));
    await expect(runDrone(task({ modelChoice: choice("m-a") }), new InlineSteps(), w.ports(), agentCfg)).rejects.toThrow();
    expect(w.points.map((p) => p.blobs.slice(0, 5))).toEqual([["drone.build", "hive", "BUILDER", "", "failed"]]);
  });
});

void PASSING_VERIFY;

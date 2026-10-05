/** WP1.6: MERGE routing, finish followUps, BuildResult v2 fields, 429 handling, trace logs, AE points. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiGatewayError, parseLedger } from "@queenos/hive-kit";
import { DroneTaskSchema, spanIdFor, traceparent, type MergeResultInput } from "@queenos/queen-types";
import { readConfig } from "../src/config";
import { generateLive } from "../src/generate";
import { AGENT_PHASE_MS, runAgentBuild } from "../src/agent/run";
import { AGENT_SYSTEM_PROMPT } from "../src/agent/prompt";
import { FinishInputSchema, MAX_FOLLOW_UPS, runFinish, runVerify, EMPTY_TOOL_STATE, type DroneToolDeps, type ToolState } from "../src/agent/tools";
import { MERGE_MODEL, runDrone } from "../src/orchestrate";
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

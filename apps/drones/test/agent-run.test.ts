import { describe, expect, it } from "vitest";
import { parseLedger } from "@queenos/hive-kit";
import { DroneTaskSchema } from "@queenos/queen-types";
import { readConfig } from "../src/config";
import { AllModelsFailedError } from "../src/generate";
import { AGENT_PHASE_MS, PER_MODEL_MS, agentModelsFor, runAgentBuild } from "../src/agent/run";
import { DroneFailedError, runDrone } from "../src/orchestrate";
import { FakeAgent, FakeWorld, InlineSteps, PASSING_VERIFY, STARTER_FILES, htmlAgent, task, type AgentScript } from "./fakes";

const agentCfg = readConfig({ DRONE_LLM_MODE: "live", AI_GATEWAY_ID: "gw", MODEL_BUILDER: "@cf/zai-org/glm-5.3-flash" });
const REPO = "hive-train-aaaaaaaaaaaa";
const choice = (model: string, ...fallbacks: string[]) => ({ model, tier: "fast" as const, role: "builder" as const, reason: "test", fallbacks });

async function world(script: (model: string) => AgentScript) {
  const w = new FakeWorld();
  const base = await w.git.seed(REPO, STARTER_FILES);
  w.agent = new FakeAgent(script);
  return { w, base, agent: w.agent };
}

const noFinish: AgentScript = () => ({ trace: ["t1 read src/index.js"], usage: { inputTokens: 900, outputTokens: 9, steps: 16 } });
const providerError: AgentScript = () => ({ status: "error", error: "3046: Request timeout" });

describe("agentModelsFor", () => {
  it("keeps the Queen's order, drops tool-loop-excluded models, falls back to the env default", () => {
    const t = (c?: ReturnType<typeof choice>) => DroneTaskSchema.parse(task(c ? { modelChoice: c } : {}));
    expect(agentModelsFor(t(choice("@cf/qwen/qwen3.8-27b", "@cf/moonshotai/kimi-k2.7-code", "@cf/zai-org/glm-5.3-flash")), agentCfg)).toEqual([
      "@cf/moonshotai/kimi-k2.7-code",
      "@cf/zai-org/glm-5.3-flash",
    ]);
    expect(agentModelsFor(t(choice("@cf/qwen/qwen3.8-27b")), agentCfg)).toEqual(["@cf/zai-org/glm-5.3-flash"]);
    expect(agentModelsFor(t(), agentCfg)).toEqual(["@cf/zai-org/glm-5.3-flash"]);
  });
});

describe("runAgentBuild", () => {
  const parsed = (over = {}) => DroneTaskSchema.parse(task({ modelChoice: choice("m-a", "m-b", "m-c"), ...over }));
  const opts = (now = 0) => ({ instanceId: "train-1-build", deadlineMs: now + AGENT_PHASE_MS, now: () => now });

  it("tries models in order and returns the first verified, finished run as an overlay", async () => {
    const { w, agent } = await world((m) => (m === "m-a" ? providerError : m === "m-b" ? noFinish : htmlAgent));
    const g = await runAgentBuild(parsed(), w.ports(), agentCfg, opts());
    expect(agent.calls.map((c) => [c.name, c.input.idempotencyKey, c.input.model])).toEqual([
      ["train-1-build|m-a", "train-1-build:m-a", "m-a"],
      ["train-1-build|m-b", "train-1-build:m-b", "m-b"],
      ["train-1-build|m-c", "train-1-build:m-c", "m-c"],
    ]);
    // Seeded from the train branch with a read token; tasks carry the prompt, not the token.
    expect(agent.calls[0]!.input.base).toEqual(STARTER_FILES);
    expect(w.artifacts.calls).toEqual([{ repo: REPO, scope: "read" }]);
    expect(agent.calls[0]!.input.timeoutMs).toBe(PER_MODEL_MS);
    expect(agent.calls[0]!.input.skipCache).toBe(false);

    expect(g.model).toBe("m-c");
    expect(g.failedModels).toEqual(["m-a", "m-b"]);
    expect(g.changeSet.files.map((f) => f.path)).toEqual(["src/index.js"]);
    expect(g.changeSet.deletes).toEqual([]);
    expect(g.changeSet.reasoningSteps).toEqual([
      "Summary: Serve HTML at /",
      "The router owns /",
      "Edited src/index.js",
      "t1 read src/index.js",
      "t2 edit src/index.js",
      "t3 verify / 200 text/html; /health 200 json -> ok",
    ]);
    expect(g.changeSet.discardedPaths).toEqual([
      "new /features/status page",
      "model m-a: error: 3046: Request timeout",
      expect.stringMatching(/^model m-b: no accepted finish after 16 step/),
    ]);
    expect(g.agentUsage).toEqual({ inputTokens: 1100, outputTokens: 29, steps: 22 });
  });

  it("rejects runs whose overlay is empty, touches platform files, or breaks the template", async () => {
    const touch =
      (f: (files: Record<string, string>) => void): AgentScript =>
      (input, files) => (f(files), { ...htmlAgent(input, {}), finish: { summary: "s", reasoningSteps: ["r"], discardedPaths: [] }, lastVerify: PASSING_VERIFY });
    const scripts: Record<string, AgentScript> = {
      "m-a": touch(() => undefined),
      "m-b": touch((f) => void (f[".queen/deploy.json"] = "{}")),
      "m-c": touch((f) => void (f["src/lib/x.js"] = 'import x from "hono";\n')),
    };
    const { w } = await world((m) => scripts[m]!);
    const err = await runAgentBuild(parsed(), w.ports(), agentCfg, opts()).catch((e) => e);
    expect(err).toBeInstanceOf(AllModelsFailedError);
    expect(err.failedModels).toEqual(["m-a", "m-b", "m-c"]);
    expect(err.message).toMatch(/m-a: no files were changed/);
    expect(err.message).toMatch(/m-b: these paths are platform-owned/);
    expect(err.message).toMatch(/m-c: src\/lib\/x\.js: import "hono" is not allowed/);
  });

  it("skips models once the agent-phase deadline is near, and caps the last model's time", async () => {
    let now = 0;
    const { w, agent } = await world((m) => (m === "m-a" ? ((now = AGENT_PHASE_MS - 60_000), noFinish) : htmlAgent));
    const g = await runAgentBuild(parsed(), w.ports(), agentCfg, { instanceId: "i", deadlineMs: AGENT_PHASE_MS, now: () => now });
    expect(agent.calls.map((c) => [c.input.model, c.input.timeoutMs])).toEqual([
      ["m-a", PER_MODEL_MS],
      ["m-b", 60_000],
    ]);
    expect(g.model).toBe("m-b");

    now = AGENT_PHASE_MS - 10_000;
    const { w: w2, agent: a2 } = await world(() => htmlAgent);
    const err = await runAgentBuild(parsed(), w2.ports(), agentCfg, { instanceId: "i", deadlineMs: AGENT_PHASE_MS, now: () => now }).catch((e) => e);
    expect(a2.calls).toEqual([]);
    expect(err).toBeInstanceOf(AllModelsFailedError);
    expect(err.message).toMatch(/budget exhausted/);
  });

  it("REWORK bypasses the gateway cache and carries the reviewer feedback", async () => {
    const { w, agent } = await world(() => htmlAgent);
    await runAgentBuild(parsed({ action: "REWORK", scribeSummary: "Made a feature page instead of changing /" }), w.ports(), agentCfg, opts());
    expect(agent.calls[0]!.input).toMatchObject({ skipCache: true, task: { action: "REWORK", scribeSummary: "Made a feature page instead of changing /" } });
  });
});

describe("runDrone with the agent harness", () => {
  it("commits the agent's overlay (including a delete), notes the trace, and reports model + failedModels", async () => {
    const script: AgentScript = (input, files) => {
      if (input.model === "m-a") return { status: "timeout", error: "no finish within 240s" };
      delete files["src/features/index.js"];
      files["src/index.js"] = 'const features = [];\nexport default { fetch() { return new Response("<html>"); } }; // "/health"\n';
      return htmlAgent(input, {});
    };
    const { w, base, agent } = await world(() => script);
    const steps = new InlineSteps();
    const out = await runDrone(task({ modelChoice: choice("m-a", "m-b") }), steps, w.ports(), agentCfg, { instanceId: "train-1-build" });
    expect(out).toMatchObject({ status: "built", ledgerStore: "git-notes" });
    if (out.status !== "built") throw new Error("unreachable");
    expect(steps.names()).toContain("agent: build");
    expect(steps.names()).not.toContain("generate change set");
    expect(agent.started).toEqual(["train-1-build:m-a", "train-1-build:m-b"]);

    const repo = w.git.repo(REPO);
    const head = await repo.head();
    expect(head?.parents).toEqual([base]);
    expect(head?.message).toContain("- src/features/index.js (deleted)");
    expect(await repo.listFiles()).not.toContain("src/features/index.js");
    expect((await repo.readFiles(["src/index.js"]))["src/index.js"]).toContain("<html>");

    const note = parseLedger((await repo.readNote(out.codeSha))!);
    expect(note.model).toBe("m-b");
    expect(note.reasoningSteps).toContain("t2 edit src/index.js");
    expect(note.discardedPaths).toContain("model m-a: timeout: no finish within 240s");

    const report = w.queen("hive").calls.find((c) => c.method === "reportBuildResult");
    expect(report?.input).toMatchObject({ trainId: "train-1", model: "m-b", failedModels: ["m-a"], buildMs: expect.any(Number) });
    // Usage covers every model tried (the timed-out m-a run and the accepted m-b run).
    expect(report?.input.usage).toEqual({ inputTokens: 200, outputTokens: 20, steps: 6 });
  });

  it("a retried agent step re-attaches to the same submissions instead of starting new ones", async () => {
    let calls = 0;
    const flaky: AgentScript = (input, files) => {
      calls++;
      // The first model call "loses" its RPC once (e.g. the DO was reset by a deploy) after the run completed.
      return htmlAgent(input, files);
    };
    const { w, agent } = await world(() => flaky);
    const realBuild = agent.build.bind(agent);
    let failOnce = true;
    agent.build = async (name, input) => {
      const r = await realBuild(name, input);
      if (failOnce) {
        failOnce = false;
        throw new Error("Durable Object reset because its code was updated.");
      }
      return r;
    };
    const steps = new InlineSteps();
    const out = await runDrone(task({ modelChoice: choice("m-a") }), steps, w.ports(), agentCfg, { instanceId: "i-1" });
    expect(out.status).toBe("built");
    expect(steps.log.find((l) => l.name === "agent: build")).toMatchObject({ attempts: 2, ok: true });
    expect(agent.calls).toHaveLength(2);
    expect(agent.started).toEqual(["i-1:m-a"]);
    expect(calls).toBe(1);
  });

  it("budget exhaustion on every model reports a failed train and a REJECTED audit, without step retries", async () => {
    const { w, agent } = await world(() => noFinish);
    const steps = new InlineSteps();
    await expect(runDrone(task({ modelChoice: choice("m-a", "m-b") }), steps, w.ports(), agentCfg)).rejects.toBeInstanceOf(DroneFailedError);
    expect(steps.log.find((l) => l.name === "agent: build")).toMatchObject({ attempts: 1, ok: false });
    expect(agent.started).toEqual(["train-1-build:m-a", "train-1-build:m-b"]);
    const q = w.queen("hive");
    const fail = q.calls.find((c) => c.method === "reportTrainResult");
    expect(fail?.input).toMatchObject({ passed: false, summary: expect.stringMatching(/no verified change from any model: m-a: no accepted finish/) });
    expect(q.audits().map((a) => a.status)).toEqual(["RUNNING", "REJECTED"]);
    expect(w.git.pushes).toEqual([]);
  });

  it("scripted mode never touches the agent; DRONE_HARNESS=single-shot uses the legacy generator", async () => {
    const { w, agent } = await world(() => htmlAgent);
    const out = await runDrone(task(), new InlineSteps(), w.ports(), readConfig({ DRONE_LLM_MODE: "scripted" }));
    expect(out.status).toBe("built");
    expect(agent.calls).toEqual([]);
    // Scripted builds spend no tokens and report no usage.
    const report = w.queen("hive").calls.find((c) => c.method === "reportBuildResult");
    expect(report?.input).not.toHaveProperty("usage");
    expect(readConfig({ DRONE_LLM_MODE: "live", DRONE_HARNESS: "single-shot" }).harness).toBe("single-shot");
    expect(() => readConfig({ DRONE_HARNESS: "both" })).toThrow(/DRONE_HARNESS/);
  });
});

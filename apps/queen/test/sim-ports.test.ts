import { describe, expect, it } from "vitest";
import type { AppendAuditInput, BuildResult, DeployResult, ModelChoice, DroneTask, MergeTrain, PromptRun, ProvisionResult, Release, SentinelCommand, SentinelVerdict } from "@queenos/queen-types";
import {
  SimExecutors,
  TEST_RETRY_MS,
  fakeSha,
  simPreviewUrl,
  simRecall,
  simProdUrl,
  simStagingUrl,
  simVersionId,
  type SimQueen,
  type SimStore,
} from "../src/sim/sim-ports";

function harness() {
  const kv = new Map<string, unknown>();
  let alarm: number | null = null;
  let clock = 1_000;
  const calls: string[] = [];
  const audits: AppendAuditInput[] = [];
  const provisions: ProvisionResult[] = [];
  const deploys: DeployResult[] = [];
  const verdicts: SentinelVerdict[] = [];
  const builds: BuildResult[] = [];
  /** What the fake Queen's snapshot says about releases and prompts (for the sim Sentinel). */
  const world: { releases: Release[]; promptRuns: PromptRun[]; trains: MergeTrain[] } = { releases: [], promptRuns: [], trains: [] };
  /** Phase the fake Queen reports for every train (the sim gatekeeper waits for TESTING). */
  const phase: { value: MergeTrain["phase"] } = { value: "TESTING" };
  const store: SimStore = {
    get: async <T>(k: string) => kv.get(k) as T | undefined,
    put: async (k, v) => void kv.set(k, v),
    getAlarm: async () => alarm,
    setAlarm: async (t) => void (alarm = t),
  };
  const queen: SimQueen = {
    appendAudit: async (a) => {
      audits.push(a);
      return { eventId: "e", promptId: a.promptId, droneRole: a.droneRole, status: a.status, gitNotesPayload: a.gitNotesPayload ? { discardedPaths: [], ...a.gitNotesPayload } : null, createdAt: clock };
    },
    reportBuildResult: async (r) => (builds.push(r), calls.push(`build:${r.trainId}`), { outcome: "applied" }),
    reportTrainResult: async (r) => (calls.push(`test:${r.trainId}:${r.passed}`), { outcome: "applied" }),
    reportLandResult: async (r) => (calls.push(`land:${r.trainId}:${r.landed}`), { outcome: "applied" }),
    reportProvisionResult: async (r) => (provisions.push(r), calls.push(`provision:${r.op}:${r.commandId}`), { outcome: "applied" }),
    reportDeployResult: async (r) => (deploys.push(r), calls.push(`deploy:${r.op}:${r.commandId}`), { outcome: "applied" }),
    reportSentinelVerdict: async (v) => (verdicts.push(v), calls.push(`verdict:${v.verdict}:${v.commandId}`), { outcome: "applied" }),
    getSnapshot: () => ({
      trains: [
        { trainId: "t1", baseSha: "", includedPrompts: [], artifactRepo: "r", status: "TESTING", createdAt: 0, phase: phase.value, previewUrl: simPreviewUrl("t1") },
        ...world.trains,
      ],
      releases: world.releases,
      promptRuns: world.promptRuns,
    }),
  };
  const delays = { fork: 300, delete: 50, deploy: 1500, teardown: 50, build: 100, test: 100, land: 100, sentinel: 2000 };
  const sim = new SimExecutors(() => queen, store, delays, () => clock);
  const advance = async (ms: number) => {
    clock += ms;
    return sim.runDue();
  };
  return { sim, advance, calls, audits, provisions, deploys, verdicts, builds, world, phase, alarm: () => alarm };
}

const task = (over: Partial<DroneTask>): DroneTask => ({
  promptId: "p1",
  trainId: "t1",
  namespace: "n",
  artifactRepo: "n-train-t1",
  baseRef: "main",
  promptText: "add a button",
  role: "BUILDER",
  action: "BUILD",
  ragContext: [],
  ...over,
});

const fork = { op: "FORK" as const, commandId: "t1-fork-1", hive: "n", trainId: "t1", sourceRepo: "n", forkName: "n-train-t1" };
const deploy = { op: "DEPLOY" as const, commandId: "t1-deploy-1", hive: "n", environment: "preview" as const, trainId: "t1", artifactRepo: "n-train-t1", commitSha: "abc" };

describe("sim provisioner", () => {
  it("reports a FORK ok after ~300 ms with a deterministic base SHA; deletes report ok", async () => {
    const h = harness();
    expect(await h.sim.provisioner.dispatch(fork)).toEqual({ instanceId: "t1-fork-1" });
    expect(h.alarm()).toBe(1_300);
    expect(await h.advance(299)).toBe(0);
    await h.advance(1);
    expect(h.provisions).toEqual([{ commandId: "t1-fork-1", op: "FORK", trainId: "t1", ok: true, artifactRepo: "n-train-t1", baseSha: fakeSha("base:n") }]);
    await h.sim.provisioner.dispatch({ op: "DELETE", commandId: "t1-delete-1", hive: "n", trainId: "t1", repo: "n-train-t1" });
    await h.advance(50);
    expect(h.provisions.at(-1)).toEqual({ commandId: "t1-delete-1", op: "DELETE", trainId: "t1", ok: true });
    expect(fakeSha("a")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("FORK recalls no memories for the very first train of a hive", async () => {
    const h = harness();
    await h.sim.provisioner.dispatch({ ...fork, recallQuery: "add a login button" });
    await h.advance(300);
    expect(h.provisions[0]).not.toHaveProperty("memories");
  });

  it("FORK recalls earlier gate verdicts of this hive, best word overlap first", async () => {
    const h = harness();
    const train = (trainId: string, promptId: string, over: Partial<MergeTrain>): MergeTrain => ({
      trainId, baseSha: "", includedPrompts: [promptId], artifactRepo: `n-train-${trainId}`, status: "TESTING", createdAt: 10, ...over,
    });
    h.world.promptRuns.push(
      { promptId: "pa", namespace: "n", promptText: "add a login button to the header", status: "MERGED", createdAt: 1 },
      { promptId: "pb", namespace: "n", promptText: "add retries to the fetch client [fail]", status: "EJECTED", createdAt: 2 },
      { promptId: "pc", namespace: "n", promptText: "tune the cache", status: "BUILDING", createdAt: 3 },
      { promptId: "pd", namespace: "n", promptText: "add retries again", status: "QUEUED", createdAt: 4 },
    );
    h.world.trains.push(
      train("ta", "pa", { status: "MERGED", phase: "MERGED", summary: "Policy and security passed.", headSha: "a".repeat(40), createdAt: 11 }),
      train("tb", "pb", { status: "EJECTED", phase: "EJECTED", reason: "failed: Security scan rejected an unbounded retry loop.", createdAt: 12 }),
      train("tc", "pc", { status: "BUILDING", phase: "BUILDING", createdAt: 13 }), // no verdict yet
      train("td", "pd", { status: "EJECTED", phase: "EJECTED", reason: "superseded: prompt pb ejected from train tb", createdAt: 14 }),
    );
    await h.sim.provisioner.dispatch({ ...fork, recallQuery: "add retries with a cap to the fetch client" });
    await h.advance(300);
    const memories = h.provisions[0]!.memories!;
    expect(memories.map((m) => [m.trainId, m.outcome])).toEqual([
      ["tb", "FAILED"],
      ["ta", "PASSED"],
    ]);
    expect(memories[0]).toMatchObject({ memoryId: `tb:${fakeSha("head:tb").slice(0, 12)}`, promptId: "pb", promptText: "add retries to the fetch client [fail]" });
    expect(memories[0]!.text).toContain("Security scan rejected an unbounded retry loop.");
    expect(memories[1]!.memoryId).toBe(`ta:${"a".repeat(12)}`);
    expect(memories[0]!.score).toBeGreaterThan(memories[1]!.score);
    for (const m of memories) expect(m.score).toBeGreaterThanOrEqual(0.6);
    // Deterministic, and never the forking train itself.
    expect(simRecall({ trains: [...h.world.trains], promptRuns: h.world.promptRuns }, "tb", "add retries").map((m) => m.trainId)).toEqual(["ta"]);
  });

  it("runs a command id at most once, like a Workflow instance id (queued or already done)", async () => {
    const h = harness();
    await h.sim.provisioner.dispatch(fork);
    await h.sim.provisioner.dispatch(fork);
    await h.advance(300);
    await h.sim.provisioner.dispatch(fork); // reconcile re-dispatch after completion
    await h.advance(300);
    expect(h.calls).toEqual(["provision:FORK:t1-fork-1"]);
  });
});

describe("sim herald", () => {
  it("reports DEPLOY ok with a fake preview URL after ~1.5 s", async () => {
    const h = harness();
    await h.sim.herald.dispatch(deploy);
    await h.advance(1_499);
    expect(h.deploys).toEqual([]);
    await h.advance(1);
    expect(h.deploys).toEqual([
      expect.objectContaining({ commandId: "t1-deploy-1", op: "DEPLOY", environment: "preview", trainId: "t1", ok: true, url: "https://t1-preview.sim.queenos.dev", commitSha: "abc" }),
    ]);
  });

  it("records teardowns and reports them ok", async () => {
    const h = harness();
    await h.sim.herald.dispatch({ op: "TEARDOWN", commandId: "t1-teardown-1", hive: "n", environment: "preview", trainId: "t1" });
    await h.advance(50);
    expect(await h.sim.teardowns()).toEqual(["t1"]);
    expect(h.deploys).toEqual([{ commandId: "t1-teardown-1", op: "TEARDOWN", environment: "preview", trainId: "t1", ok: true }]);
  });
});

describe("sim drones", () => {
  it("a good prompt builds, waits for the preview, smoke-tests it and passes", async () => {
    const h = harness();
    await h.sim.drones.dispatch(task({}));
    expect(h.audits.map((a) => `${a.droneRole}:${a.status}`)).toEqual(["BUILDER:RUNNING"]);
    expect(h.alarm()).toBe(1_100);
    await h.advance(100);
    h.phase.value = "DEPLOYING";
    await h.advance(100);
    expect(h.calls).toEqual(["build:t1"]); // still deploying: the gatekeeper waits
    h.phase.value = "TESTING";
    await h.advance(TEST_RETRY_MS);
    expect(h.calls).toEqual(["build:t1", "test:t1:true"]);
    expect(h.audits.some((a) => a.droneRole === "BUILDER" && a.status === "PASSED" && a.gitNotesPayload?.reasoningSteps.length)).toBe(true);
    const smoke = h.audits.find((a) => a.droneRole === "GATEKEEPER" && a.status === "PASSED");
    expect(smoke?.gitNotesPayload?.reasoningSteps[0]).toContain("https://t1-preview.sim.queenos.dev");
    expect(h.audits.every((a) => !a.gitNotesPayload || a.gitNotesPayload.model === "claude-opus-5-5")).toBe(true);
  });

  it("[fail] prompts fail once; REWORK passes; dispatch is idempotent", async () => {
    const h = harness();
    await h.sim.drones.dispatch(task({ promptText: "flaky retry [fail]" }));
    await h.sim.drones.dispatch(task({ promptText: "flaky retry [fail]" }));
    await h.advance(100);
    await h.advance(100);
    expect(h.calls).toEqual(["build:t1", "test:t1:false"]);
    expect(h.audits.some((a) => a.droneRole === "SECURITY" && a.status === "REJECTED")).toBe(true);

    await h.sim.drones.dispatch(task({ trainId: "t2", action: "REWORK", promptText: "flaky retry [fail]" }));
    await h.advance(100);
    await h.advance(100);
    expect(h.calls.slice(2)).toEqual(["build:t2", "test:t2:true"]);
  });

  it("the LAND flow auto-completes", async () => {
    const h = harness();
    await h.sim.drones.dispatch(task({ role: "LANDER", action: "LAND" }));
    await h.advance(100);
    expect(h.calls).toEqual(["land:t1:true"]);
    expect(h.audits.at(-1)).toMatchObject({ droneRole: "LANDER", status: "PASSED" });
  });
});

describe("sim release executors", () => {
  const release = (releaseId: string, trainIds: string[]): Release => ({
    releaseId,
    hive: "n",
    headSha: "h",
    trainIds,
    phase: "CANARY",
    canaryPercent: 10,
    stagingUrl: null,
    prodUrl: null,
    candidateVersionId: null,
    stableVersionId: null,
    tappedBy: null,
    tappedAt: null,
    summary: null,
    createdAt: 0,
    updatedAt: 0,
  });
  const train = (trainId: string, includedPrompts: string[]): MergeTrain => ({
    trainId,
    baseSha: "",
    includedPrompts,
    artifactRepo: "r",
    status: "MERGED",
    createdAt: 0,
  });
  const prompt = (promptId: string, promptText: string): PromptRun => ({ promptId, namespace: "n", promptText, status: "MERGED", createdAt: 0 });
  const canaryCmd = (over: Partial<SentinelCommand>): SentinelCommand => ({
    commandId: "r1-verify1-1",
    hive: "n",
    releaseId: "r1",
    environment: "canary",
    scriptName: "n-app",
    url: simProdUrl("n"),
    candidateVersionId: "v-c",
    stableVersionId: "v-s",
    canaryPercent: 1,
    paths: ["/", "/health"],
    windowSeconds: 60,
    minRequests: 100,
    ...over,
  });

  it("herald: staging deploys report the staging URL with a fake version id", async () => {
    const h = harness();
    await h.sim.herald.dispatch({ op: "DEPLOY", commandId: "r1-staging-1", hive: "n", environment: "staging", releaseId: "r1", artifactRepo: "n", commitSha: "abc1234" });
    await h.advance(1500);
    expect(h.deploys).toEqual([
      expect.objectContaining({ commandId: "r1-staging-1", op: "DEPLOY", environment: "staging", releaseId: "r1", ok: true, url: simStagingUrl("n"), versionId: simVersionId("staging:r1-staging-1"), commitSha: "abc1234" }),
    ]);
    expect(simStagingUrl("n")).toBe("https://n-staging.sim.queenos.dev");
  });

  it("herald: canary step 1 uploads a candidate and names the (simulated) stable version; later steps reuse them; rollback restores stable", async () => {
    const h = harness();
    const base = { op: "DEPLOY" as const, hive: "n", environment: "canary" as const, releaseId: "r1", artifactRepo: "n", commitSha: "abc" };
    await h.sim.herald.dispatch({ ...base, commandId: "r1-canary1-1", percent: 1 });
    await h.advance(1500);
    const first = h.deploys[0]!;
    expect(first).toMatchObject({ ok: true, url: "https://n-app.sim.queenos.dev", versionId: simVersionId("candidate:r1"), stableVersionId: simVersionId("prod:n"), percent: 1 });
    await h.sim.herald.dispatch({ ...base, commandId: "r1-canary10-1", percent: 10, versionId: first.versionId!, stableVersionId: first.stableVersionId! });
    await h.advance(1500);
    expect(h.deploys[1]).toMatchObject({ versionId: first.versionId, stableVersionId: first.stableVersionId, percent: 10 });
    await h.sim.herald.dispatch({ op: "ROLLBACK", commandId: "r1-rollback-1", hive: "n", environment: "canary", toVersionId: first.stableVersionId! });
    await h.advance(50);
    expect(h.deploys[2]).toMatchObject({ op: "ROLLBACK", ok: true, versionId: first.stableVersionId, percent: 100 });
  });

  it("herald: a candidate shipped at 100% becomes the next release's stable version", async () => {
    const h = harness();
    const base = { op: "DEPLOY" as const, hive: "n", environment: "canary" as const, artifactRepo: "n", commitSha: "abc" };
    await h.sim.herald.dispatch({ ...base, releaseId: "r1", commandId: "r1-canary100-1", percent: 100, versionId: "v-r1", stableVersionId: "v-old" });
    await h.advance(1500);
    await h.sim.herald.dispatch({ ...base, releaseId: "r2", commandId: "r2-canary1-1", percent: 1 });
    await h.advance(1500);
    expect(h.deploys[1]).toMatchObject({ stableVersionId: "v-r1", versionId: simVersionId("candidate:r2") });
  });

  it("sentinel: PROMOTE after ~2 s for staging and healthy canary steps", async () => {
    const h = harness();
    await h.sim.sentinel.dispatch({ ...canaryCmd({}), commandId: "r1-validate-1", environment: "staging", scriptName: "n-staging", url: simStagingUrl("n"), candidateVersionId: undefined, stableVersionId: undefined, canaryPercent: undefined });
    await h.advance(1999);
    expect(h.verdicts).toEqual([]);
    await h.advance(1);
    expect(h.verdicts[0]).toMatchObject({ commandId: "r1-validate-1", releaseId: "r1", environment: "staging", verdict: "PROMOTE", metrics: { baselineErrorRate: null } });
    await h.sim.sentinel.dispatch(canaryCmd({}));
    await h.advance(2000);
    expect(h.verdicts[1]).toMatchObject({ environment: "canary", verdict: "PROMOTE", metrics: { baselineErrorRate: 0.001 } });
  });

  it("sentinel: ROLLBACK at the 10% step when a prompt in the release contains [canary-fail]; other steps promote", async () => {
    const h = harness();
    h.world.releases = [release("r1", ["t9"])];
    h.world.trains = [train("t9", ["p1", "p2"])];
    h.world.promptRuns = [prompt("p1", "add a page"), prompt("p2", "slow query [canary-fail]")];
    await h.sim.sentinel.dispatch(canaryCmd({ commandId: "r1-verify1-1", canaryPercent: 1 }));
    await h.sim.sentinel.dispatch(canaryCmd({ commandId: "r1-verify10-1", canaryPercent: 10 }));
    await h.advance(2000);
    expect(h.verdicts.map((v) => [v.commandId, v.verdict])).toEqual([
      ["r1-verify1-1", "PROMOTE"],
      ["r1-verify10-1", "ROLLBACK"],
    ]);
    expect(h.verdicts[1]!.summary).toMatch(/Rolling back/);

    // A release without the marker promotes at 10% too.
    h.world.releases = [release("r2", ["t8"])];
    h.world.trains = [train("t8", ["p1"])];
    await h.sim.sentinel.dispatch(canaryCmd({ commandId: "r2-verify10-1", releaseId: "r2", canaryPercent: 10 }));
    await h.advance(2000);
    expect(h.verdicts.at(-1)).toMatchObject({ commandId: "r2-verify10-1", verdict: "PROMOTE" });
  });
});

describe("sim drones: models", () => {
  const fast: ModelChoice = {
    model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
    tier: "fast",
    role: "builder",
    reason: "fast tier · no track record yet; lowest cost · floor: fast",
    fallbacks: ["@cf/zai-org/glm-5.3-flash", "@cf/moonshotai/kimi-k2.7-code"],
  };
  const frontier: ModelChoice = { model: "@cf/moonshotai/kimi-k2.7-code", tier: "frontier", role: "rework", reason: "rework → escalated to frontier", fallbacks: ["@cf/zai-org/glm-5.3"] };

  it("reports the Queen's chosen model with a plausible build time; the ledger names it", async () => {
    const h = harness();
    await h.sim.drones.dispatch(task({ modelChoice: fast }));
    expect(h.alarm()).toBe(1_100); // fast: delays.build
    await h.advance(100);
    expect(h.builds[0]).toMatchObject({ trainId: "t1", model: fast.model });
    expect(h.builds[0]!.failedModels).toBeUndefined();
    expect(h.builds[0]!.buildMs).toBeGreaterThanOrEqual(100);
    const note = h.audits.find((a) => a.droneRole === "BUILDER" && a.status === "PASSED")!.gitNotesPayload!;
    expect(note.model).toBe(fast.model);
    expect(note.reasoningSteps[0]).toContain(`Queen routed this build to ${fast.model}`);
  });

  it("frontier builds take longer", async () => {
    const h = harness();
    await h.sim.drones.dispatch(task({ action: "REWORK", modelChoice: frontier }));
    expect(h.alarm()).toBe(1_160); // 1.6 x delays.build
    await h.advance(159);
    expect(h.builds).toEqual([]);
    await h.advance(1);
    expect(h.builds[0]).toMatchObject({ model: frontier.model });
    expect(h.builds[0]!.buildMs).toBeGreaterThanOrEqual(160);
  });

  it("[bad-json]: the chosen model returns junk on the BUILD, the first fallback builds (failedModels); the REWORK is clean", async () => {
    const h = harness();
    await h.sim.drones.dispatch(task({ promptText: "parse config [bad-json]", modelChoice: fast }));
    await h.advance(150); // the fallback costs another half build
    expect(h.builds[0]).toMatchObject({ model: fast.fallbacks[0], failedModels: [fast.model] });
    const note = h.audits.find((a) => a.droneRole === "BUILDER" && a.status === "PASSED")!.gitNotesPayload!;
    expect(note.reasoningSteps.join(" ")).toContain("returned an unusable change set");

    await h.sim.drones.dispatch(task({ trainId: "t2", action: "REWORK", promptText: "parse config [bad-json]", modelChoice: frontier }));
    await h.advance(160);
    expect(h.builds[1]).toMatchObject({ trainId: "t2", model: frontier.model });
    expect(h.builds[1]!.failedModels).toBeUndefined();
  });

  it("tasks without a modelChoice report no model fields (pre-router drones)", async () => {
    const h = harness();
    await h.sim.drones.dispatch(task({}));
    await h.advance(100);
    expect(h.builds[0]).toEqual({ trainId: "t1", headSha: fakeSha("head:t1") });
  });
});

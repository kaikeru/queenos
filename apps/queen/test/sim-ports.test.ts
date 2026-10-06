import { describe, expect, it } from "vitest";
import { MODEL_CATALOG } from "@queenos/queen-types";
import type { AppendAuditInput, MergeResultInput, OracleResultInput, TrainResult, BuildResult, DeployResult, ModelChoice, DroneTask, MergeTrain, PromptRun, ProvisionResult, Release, SentinelCommand, SentinelVerdict } from "@queenos/queen-types";
import {
  BATCH_FAIL_MARKER,
  BATCH_FAIL_MAX_HOLDS,
  COLLIDE_MARKER,
  SIM_BUILD_JITTER_MS,
  DEFAULT_SIM_DELAYS,
  SimExecutors,
  demoSwarmPrompt,
  jitteredBuildMs,
  simChangedPaths,
  simDecompose,
  childKind,
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

const harnessDelays = { fork: 300, delete: 50, deploy: 1500, teardown: 50, build: 100, test: 100, land: 100, sentinel: 2000, merge: 1500 };

function harness(delays: typeof harnessDelays & { buildJitter?: { min: number; max: number } } = harnessDelays) {
  const kv = new Map<string, unknown>();
  let alarm: number | null = null;
  let clock = 1_000;
  const calls: string[] = [];
  const audits: AppendAuditInput[] = [];
  const provisions: ProvisionResult[] = [];
  const deploys: DeployResult[] = [];
  const verdicts: SentinelVerdict[] = [];
  const builds: BuildResult[] = [];
  const trainResults: TrainResult[] = [];
  const oracle: OracleResultInput[] = [];
  const merges: MergeResultInput[] = [];
  const openItems: { itemId: string; title: string; status: string }[] = [];
  const scribes: { promptId?: string | undefined; trainId?: string | undefined; summary: string }[] = [];
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
    reportOracleResult: async (r) => (oracle.push(r), { outcome: "applied" }),
    reportMergeResult: async (r) => (merges.push(r), { outcome: "applied" }),
    listOpenItems: () => openItems,
    reportTrainResult: async (r) => (trainResults.push(r), calls.push(`test:${r.trainId}:${r.passed}`), { outcome: "applied" }),
    recordScribeSummary: async (x) => (scribes.push(x), null),
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
  const sim = new SimExecutors(() => queen, store, delays, () => clock);
  const advance = async (ms: number) => {
    clock += ms;
    return sim.runDue();
  };
  return { sim, trainResults, oracle, merges, openItems, store, scribes, advance, calls, audits, provisions, deploys, verdicts, builds, world, phase, alarm: () => alarm };
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
    const ids = new Set(MODEL_CATALOG.map((m) => m.id));
    for (const a of h.audits) {
      const m = a.gitNotesPayload?.model;
      if (m) expect(ids.has(m) || m.startsWith("queenos/")).toBe(true);
    }
    expect(smoke?.gitNotesPayload?.model).toBe("@cf/zai-org/glm-4.7-flash");
  });

  it("[fail] prompts fail once; REWORK passes; dispatch is idempotent", async () => {
    const h = harness();
    await h.sim.drones.dispatch(task({ promptText: "flaky retry [fail]" }));
    await h.sim.drones.dispatch(task({ promptText: "flaky retry [fail]" }));
    await h.advance(100);
    await h.advance(100);
    expect(h.calls).toEqual(["build:t1", "test:t1:false"]);
    expect(h.audits.some((a) => a.droneRole === "SECURITY" && a.status === "REJECTED")).toBe(true);
    expect(h.audits.find((a) => a.droneRole === "POLICY" && a.gitNotesPayload)?.gitNotesPayload?.model).toBe("queenos/policy-scan-v1");
    expect(h.audits.find((a) => a.droneRole === "SECURITY" && a.gitNotesPayload)?.gitNotesPayload?.model).toBe("queenos/security-scan-v1");

    await h.sim.drones.dispatch(task({ trainId: "t2", action: "REWORK", promptText: "flaky retry [fail]" }));
    await h.advance(100);
    await h.advance(100);
    expect(h.calls.slice(2)).toEqual(["build:t2", "test:t2:true"]);
  });

  it("a clean prompt gets REVIEWER RUNNING then PASSED in the live gate's note shape", async () => {
    const h = harness();
    await h.sim.drones.dispatch(task({}));
    await h.advance(100);
    await h.advance(100);
    const reviewer = h.audits.filter((a) => a.droneRole === "REVIEWER");
    expect(reviewer.map((a) => a.status)).toEqual(["RUNNING", "PASSED"]);
    expect(reviewer[1]!.gitNotesPayload!.model).toBe("@cf/deepseek-ai/deepseek-v4-flash-0731");
    expect(reviewer[1]!.gitNotesPayload!.reasoningSteps[0]).toBe("verdict: APPROVE");
    expect(reviewer[1]!.gitNotesPayload!.reasoningSteps.some((x) => x.startsWith("feedback: "))).toBe(true);
    expect(h.scribes).toEqual([]);
  });

  it("[review-fail]: first BUILD passes policy/security, REVIEWER rejects, feedback is the scribe summary, REWORK is approved", async () => {
    const h = harness();
    await h.sim.drones.dispatch(task({ promptText: "add a changelog [review-fail]" }));
    await h.advance(100);
    await h.advance(100);
    expect(h.calls).toEqual(["build:t1", "test:t1:false"]);
    const status = (role: string) => h.audits.filter((a) => a.droneRole === role).map((a) => a.status);
    expect(status("POLICY")).toContain("PASSED");
    expect(status("SECURITY")).toEqual(["RUNNING", "PASSED"]);
    expect(status("REVIEWER")).toEqual(["RUNNING", "REJECTED"]);
    const rej = h.audits.find((a) => a.droneRole === "REVIEWER" && a.status === "REJECTED")!;
    expect(rej.gitNotesPayload!.reasoningSteps.map((x) => x.split(":")[0])).toEqual(["verdict", "satisfied", "missing", "feedback"]);
    expect(rej.gitNotesPayload!.reasoningSteps[0]).toBe("verdict: REJECT");
    expect(h.scribes).toHaveLength(1);
    expect(h.scribes[0]).toMatchObject({ promptId: "p1", trainId: "t1" });
    expect(rej.gitNotesPayload!.reasoningSteps.at(-1)).toBe(`feedback: ${h.scribes[0]!.summary}`);

    await h.sim.drones.dispatch(task({ trainId: "t2", action: "REWORK", promptText: "add a changelog [review-fail]" }));
    await h.advance(100);
    await h.advance(100);
    expect(h.calls.slice(2)).toEqual(["build:t2", "test:t2:true"]);
    expect(h.scribes).toHaveLength(1);
  });

  it("[fail] still ejects via SECURITY and never reaches the REVIEWER", async () => {
    const h = harness();
    await h.sim.drones.dispatch(task({ promptText: "flaky retry [fail]" }));
    await h.advance(100);
    await h.advance(100);
    expect(h.audits.some((a) => a.droneRole === "REVIEWER")).toBe(false);
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
    expect(h.builds[0]).toMatchObject({ trainId: "t1", headSha: fakeSha("head:t1") });
    expect(h.builds[0]).not.toHaveProperty("model");
    expect(h.builds[0]).not.toHaveProperty("failedModels");
    expect(h.builds[0]).not.toHaveProperty("buildMs");
  });

  it("builder notes name the routed model, else the catalog's default builder", async () => {
    const h = harness();
    await h.sim.drones.dispatch(task({ modelChoice: fast }));
    await h.sim.drones.dispatch(task({ trainId: "t2" }));
    await h.advance(100);
    const notes = h.audits.filter((a) => a.droneRole === "BUILDER" && a.gitNotesPayload);
    expect(notes[0]!.gitNotesPayload!.model).toBe(fast.model);
    expect(notes[1]!.gitNotesPayload!.model).toBe(MODEL_CATALOG.find((m) => m.roles.includes("builder"))!.id);
  });
});

// ── v2 ───────────────────────────────────────────────────────────────────

const decompose = (promptText: string, over: Record<string, unknown> = {}) => ({
  op: "DECOMPOSE" as const,
  commandId: "i1-decompose-1",
  hive: "n",
  itemId: "i1",
  promptText,
  model: { model: "@cf/zai-org/glm-4.7-flash", tier: "fast" as const, role: "planner" as const, reason: "", fallbacks: [] },
  openItems: [],
  limits: { maxChildren: 12 },
  ...over,
});

describe("sim paths", () => {
  it("every build changes its feature file plus the generated index; [touch:] is predicted, [collide] is not", () => {
    const plain = simChangedPaths("Add a /health endpoint");
    expect(plain).toHaveLength(2);
    expect(plain[0]).toMatch(/^src\/features\/.+\.js$/);
    expect(plain[1]).toBe("src/features/index.js");
    expect(simChangedPaths("Add theme [touch:src/lib/theme.js] [touch:src/a.js]")).toEqual(expect.arrayContaining(["src/lib/theme.js", "src/a.js"]));
    expect(simChangedPaths("Add x [collide]")).toContain("src/lib/shared.js");
    expect(simChangedPaths("Add x [collide]", { dropShared: true })).not.toContain("src/lib/shared.js");
    expect(simChangedPaths("Add x")[0]).not.toBe(simChangedPaths("Add y")[0]);
  });

  it("BUILD reports changedPaths, usage (tier-scaled) and verified", async () => {
    const h = harness();
    await h.sim.drones.dispatch(task({ promptText: "add a thing [touch:src/lib/theme.js] [collide]" }));
    await h.advance(100);
    const b = h.builds[0]!;
    expect(b.changedPaths).toEqual(expect.arrayContaining(["src/lib/theme.js", "src/lib/shared.js", "src/features/index.js"]));
    expect(b.verified).toBe(true);
    const fast = b.usage!.inputTokens;
    const h2 = harness();
    await h2.sim.drones.dispatch(task({ promptText: "add a thing", modelChoice: { model: "m", tier: "frontier", role: "builder", reason: "r", fallbacks: [] } }));
    await h2.advance(1000);
    expect(h2.builds[0]!.usage!.inputTokens).toBeGreaterThan(fast);
  });

  it("a REWORK after a merge conflict drops src/lib/shared.js", async () => {
    const h = harness();
    await h.sim.drones.dispatch(task({ action: "REWORK", promptText: "x [collide]", scribeSummary: "Merge conflict in src/lib/shared.js: rebase." }));
    await h.advance(100);
    expect(h.builds[0]!.changedPaths).not.toContain("src/lib/shared.js");
  });

  it("[spot-bug] reports one follow-up on the first BUILD only", async () => {
    const h = harness();
    await h.sim.drones.dispatch(task({ promptText: "x [spot-bug]" }));
    await h.sim.drones.dispatch(task({ trainId: "t2", action: "REWORK", promptText: "x [spot-bug]" }));
    await h.advance(100);
    expect(h.builds[0]!.followUps).toEqual([expect.objectContaining({ kind: "bug", title: "Spotted: README badge link 404s" })]);
    expect(h.builds[1]!.followUps).toBeUndefined();
  });
});

describe("build jitter", () => {
  it("is 4-12 s, stable per train id, and differs across trains", () => {
    const ms = Array.from({ length: 40 }, (_, i) => jitteredBuildMs(`train-${i}`));
    for (const m of ms) {
      expect(m).toBeGreaterThanOrEqual(SIM_BUILD_JITTER_MS.min);
      expect(m).toBeLessThanOrEqual(SIM_BUILD_JITTER_MS.max);
    }
    expect(new Set(ms).size).toBeGreaterThan(20);
    expect(jitteredBuildMs("a")).toBe(jitteredBuildMs("a"));
  });

  it("default delays jitter the build job's due time; the harness's plain delays do not", async () => {
    const h = harness({ ...harnessDelays, buildJitter: SIM_BUILD_JITTER_MS });
    await h.sim.drones.dispatch(task({ trainId: "tj" }));
    expect(h.alarm()).toBe(1_000 + jitteredBuildMs("tj"));
    expect(DEFAULT_SIM_DELAYS.buildJitter).toEqual(SIM_BUILD_JITTER_MS);
    const plain = harness();
    await plain.sim.drones.dispatch(task({ trainId: "tj" }));
    expect(plain.alarm()).toBe(1_100);
  });
});

describe("sim oracle", () => {
  it("DECOMPOSE splits bullets, assigns kinds, markers, dependencies and paths", () => {
    const kids = simDecompose(demoGoals, [], 12);
    expect(kids.map((k) => k.key)).toEqual(["c1", "c2", "c3", "c4"]);
    expect(kids[0]).toMatchObject({ difficulty: "hard", paths: ["src/lib/theme.js"], kind: "feature", acceptance: ["Add a dark theme toggle is visible at /"] });
    expect(kids[0]!.title).not.toContain("[hard]");
    expect(kids[2]!.paths).toEqual(["src/lib/theme.js"]);
    expect(kids[3]).toMatchObject({ kind: "bug", dependsOn: ["c2"] });
    expect(kids[1]!.dependsOn).toEqual([]);
  });

  it("splits on ; and numbered lists, one part gives one child, kinds by keyword", () => {
    expect(simDecompose("fix the footer; rename the module; add a page", [], 12).map((k) => k.kind)).toEqual(["bug", "chore", "feature"]);
    expect(simDecompose("1. one thing\n2. two thing", [], 12)).toHaveLength(2);
    expect(simDecompose("• a thing\n• b thing", [], 12)).toHaveLength(2);
    expect(simDecompose("just one thing", [], 12)).toHaveLength(1);
    expect(simDecompose(demoSwarmPrompt(24), [], 5)).toHaveLength(5);
  });

  it("the swarm title line is not an item; every child is a feature bullet", () => {
    const kids = simDecompose(demoSwarmPrompt(24), [], 24);
    expect(kids).toHaveLength(24);
    expect(kids.every((k) => k.title.startsWith("Add a /features/") && k.kind === "feature")).toBe(true);
  });

  it("markers are not classified: [spot-bug] keeps kind feature, a real 'bug' word still wins", () => {
    expect(childKind("Add a footer [spot-bug]")).toBe("feature");
    expect(simDecompose("- Add a footer [spot-bug]\n- Fix the bug [race]", [], 5).map((k) => k.kind)).toEqual(["feature", "bug"]);
  });

  it("keeps [collide] / [race] in the child so the build and filing logic see them", () => {
    const [k] = simDecompose("- Add thing [race] [collide]", [], 12);
    expect(k!.title).toContain("[race]");
    expect(k!.title).toContain("[collide]");
  });

  it("dedupes against open items by Jaccard >= 0.8 (closed items ignored)", () => {
    const open = [
      { itemId: "dup", title: "Add a health endpoint", status: "ACTIVE" },
      { itemId: "done", title: "Add a health endpoint", status: "SHIPPED" },
    ];
    const [k] = simDecompose("Add a health endpoint", open, 12);
    expect(k!.similar).toEqual([{ itemId: "dup", score: 0.95 }]);
    expect(simDecompose("Add a totally different page", open, 12)[0]!.similar).toEqual([]);
  });

  it("dispatches DECOMPOSE (800 ms) and reports ok with children, model and usage", async () => {
    const h = harness();
    expect(await h.sim.oracle.dispatch(decompose(demoGoals))).toEqual({ instanceId: "i1-decompose-1" });
    expect(await h.advance(799)).toBe(0);
    await h.advance(1);
    expect(h.oracle[0]).toMatchObject({ commandId: "i1-decompose-1", op: "DECOMPOSE", itemId: "i1", ok: true, usage: { inputTokens: 1000, outputTokens: 200 } });
    expect(h.oracle[0]!.children).toHaveLength(4);
    await h.sim.oracle.dispatch(decompose(demoGoals)); // idempotent
    await h.advance(1000);
    expect(h.oracle).toHaveLength(1);
  });

  it("[decompose-fail] reports ok: false", async () => {
    const h = harness();
    await h.sim.oracle.dispatch(decompose("do it [decompose-fail]"));
    await h.advance(800);
    expect(h.oracle[0]).toMatchObject({ ok: false });
    expect(h.oracle[0]!.children).toBeUndefined();
  });

  it("TRIAGE finds duplicates among open items after 300 ms", async () => {
    const h = harness();
    h.openItems.push({ itemId: "x1", title: "README badge link 404s", status: "READY" }, { itemId: "i9", title: "README badge link 404s", status: "READY" });
    await h.sim.oracle.dispatch({ op: "TRIAGE", commandId: "i9-triage-1", hive: "n", itemId: "i9", kind: "bug", title: "README badge link 404s", body: "" });
    expect(await h.advance(300)).toBe(1);
    expect(h.oracle[0]).toMatchObject({ op: "TRIAGE", ok: true, similar: [{ itemId: "x1", score: 0.95 }] });
  });
});

const demoGoals = [
  "- Add a dark theme toggle [hard] [touch:src/lib/theme.js]",
  "- Add a /health JSON endpoint",
  "- Add theme tokens for the status page [touch:src/lib/theme.js]",
  "- Fix the hardcoded footer year (after 2)",
].join("\n");

describe("demoSwarmPrompt", () => {
  it("a title line, then n bullets, distinct words, two [collide], one [batch-fail], one [race]", () => {
    const text = demoSwarmPrompt(24);
    const [title, ...lines] = text.split("\n");
    expect(title).toBe("Ship a swarm of 24 feature endpoints");
    expect(lines).toHaveLength(24);
    expect(lines.every((l) => /^- Add a \/features\/(\w+) endpoint returning \1 facts/.test(l))).toBe(true);
    expect(new Set(lines.map((l) => l.split(" ")[3])).size).toBe(24);
    expect(text.match(/\[collide\]/g)).toHaveLength(2);
    expect(text.match(/\[batch-fail\]/g)).toHaveLength(1);
    expect(text.match(/\[race\]/g)).toHaveLength(1);
    expect(demoSwarmPrompt(40).split("\n")).toHaveLength(41);
    expect(demoSwarmPrompt(6).match(/\[(collide|batch-fail|race)\]/g)).toHaveLength(4);
  });
});

// A car of members in the harness: FORK each member, BUILD it (records paths), then MERGE.
const member = (id: string, promptId = `p-${id}`) => ({ trainId: id, promptId, artifactRepo: `n-train-${id}`, headSha: fakeSha(`head:${id}`), title: id });
const carTask = (carId: string, ids: string[], action: "MERGE" | "LAND" = "MERGE"): DroneTask =>
  task({ trainId: carId, promptId: `p-${ids[0]}`, action, promptText: `queue car ${carId}: ${ids.length} members`, members: ids.map((i) => member(i)), role: action === "LAND" ? "LANDER" : "GATEKEEPER" });

async function forkAndBuild(h: ReturnType<typeof harness>, id: string, text: string, extra: Partial<DroneTask> = {}) {
  await h.sim.provisioner.dispatch({ ...fork, commandId: `${id}-fork-1`, trainId: id, forkName: `n-train-${id}` });
  await h.advance(300);
  await h.sim.drones.dispatch(task({ trainId: id, promptId: `p-${id}`, promptText: text, ...extra }));
  await h.advance(100);
}

describe("sim MERGE", () => {
  it("[collide]: two members in ONE car yield exactly one conflict", async () => {
    const h = harness();
    await forkAndBuild(h, "ma", `a ${COLLIDE_MARKER}`);
    await forkAndBuild(h, "mb", `b ${COLLIDE_MARKER}`);
    await forkAndBuild(h, "mc", "c plain");
    await h.sim.drones.dispatch(carTask("car1", ["ma", "mb", "mc"]));
    await h.advance(1500);
    expect(h.merges).toHaveLength(1);
    const r = h.merges[0]!;
    expect(r.ok).toBe(true);
    expect(r.merged).toEqual(["ma", "mc"]);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts![0]).toMatchObject({ trainId: "mb", kind: "content", paths: ["src/lib/shared.js"] });
    expect(r.fastForward).toBe(false);
  });

  it("the conflicting member's rework (shared.js dropped, forked later) merges cleanly after the car it hit", async () => {
    const h = harness();
    await forkAndBuild(h, "ma", `a ${COLLIDE_MARKER}`);
    await forkAndBuild(h, "mb", `b ${COLLIDE_MARKER}`);
    await h.sim.drones.dispatch(carTask("car1", ["ma", "mb"]));
    await h.advance(1500);
    expect(h.merges[0]!.conflicts).toHaveLength(1);
    await forkAndBuild(h, "mb2", `b ${COLLIDE_MARKER}`, { action: "REWORK", promptId: "p-mb", scribeSummary: "Merge conflict in src/lib/shared.js" });
    await h.sim.drones.dispatch({ ...carTask("car2", ["mb2"]), members: [member("mb2", "p-mb")] });
    await h.advance(1500);
    expect(h.merges[1]).toMatchObject({ merged: ["mb2"], conflicts: [] });
  });

  it("a member that forked after the other merged does not conflict; a single member on an unmoved main fast-forwards", async () => {
    const h = harness();
    await forkAndBuild(h, "ma", `a ${COLLIDE_MARKER}`);
    await h.sim.drones.dispatch(carTask("car1", ["ma"]));
    await h.advance(1500);
    expect(h.merges[0]).toMatchObject({ merged: ["ma"], fastForward: true });
    await forkAndBuild(h, "mb", `b ${COLLIDE_MARKER}`); // forks after ma merged
    await h.sim.drones.dispatch(carTask("car2", ["mb"]));
    await h.advance(1500);
    expect(h.merges[1]).toMatchObject({ merged: ["mb"], conflicts: [], fastForward: true });
  });

  it("[touch:] predicted paths also conflict; generated index never does", async () => {
    const h = harness();
    await forkAndBuild(h, "ma", "a [touch:src/lib/theme.js]");
    await forkAndBuild(h, "mb", "b [touch:src/lib/theme.js]");
    await forkAndBuild(h, "mc", "c");
    await h.sim.drones.dispatch(carTask("car1", ["ma", "mb", "mc"]));
    await h.advance(1500);
    expect(h.merges[0]!.merged).toEqual(["ma", "mc"]);
    expect(h.merges[0]!.conflicts![0]).toMatchObject({ trainId: "mb", paths: ["src/lib/theme.js"] });
  });

  it("a multi-member clean car is not a fast-forward and schedules the integration gate (no reviewer)", async () => {
    const h = harness();
    await forkAndBuild(h, "ma", "a");
    await forkAndBuild(h, "mb", "b");
    await h.sim.drones.dispatch(carTask("car1", ["ma", "mb"]));
    await h.advance(1500);
    expect(h.merges[0]).toMatchObject({ merged: ["ma", "mb"], conflicts: [], fastForward: false });
    await h.advance(100);
    const r = h.trainResults.find((t) => t.trainId === "car1")!;
    expect(r).toMatchObject({ passed: true, score: { review: "skipped", satisfied: 0, missing: 0 } });
  });

  it("LAND of a car lands its members in the sim main (landed entries survive an ejected car)", async () => {
    const h = harness();
    await forkAndBuild(h, "ma", "a");
    await forkAndBuild(h, "mb", "b");
    await h.sim.drones.dispatch(carTask("car1", ["ma", "mb"]));
    await h.advance(1500);
    await h.sim.drones.dispatch(carTask("car1", ["ma", "mb"], "LAND"));
    await h.advance(100);
    expect(h.calls).toContain("land:car1:true");
    const main = (await h.store.get<{ entries: { trainId: string; landed: boolean }[] }>("sim:main:n"))!;
    expect(main.entries.map((e) => [e.trainId, e.landed])).toEqual([["ma", true], ["mb", true]]);
  });
});

describe("sim gate: [batch-fail] and races", () => {
  it("passes alone; fails in a batch; fails again as a singleton on a moved main; its rework fast-forwards and lands", async () => {
    const h = harness();
    await forkAndBuild(h, "ma", "a plain");
    await forkAndBuild(h, "mb", `b ${BATCH_FAIL_MARKER}`);
    h.world.promptRuns.push({ promptId: "p-mb", namespace: "n", promptText: `b ${BATCH_FAIL_MARKER}`, status: "BUILDING", createdAt: 1 });
    // In a batch: fails the integration gate.
    await h.sim.drones.dispatch(carTask("car1", ["ma", "mb"]));
    await h.advance(1500);
    await h.advance(100);
    expect(h.trainResults.find((t) => t.trainId === "car1")).toMatchObject({ passed: false });
    // Bisect: the car is ejected, a and b become singleton cars; a lands, so main moves past b's fork.
    h.world.trains.push({ trainId: "car1", baseSha: "", includedPrompts: [], artifactRepo: "r", status: "EJECTED", createdAt: 0, phase: "EJECTED" });
    await h.sim.drones.dispatch(carTask("carA", ["ma"]));
    await h.advance(1500);
    expect(h.merges.at(-1)).toMatchObject({ fastForward: true });
    await h.sim.drones.dispatch(carTask("carA", ["ma"], "LAND"));
    await h.advance(100);
    await h.sim.drones.dispatch(carTask("carB", ["mb"]));
    await h.advance(1500);
    expect(h.merges.at(-1)).toMatchObject({ merged: ["mb"], fastForward: false }); // moved main: not a fast-forward
    await h.advance(100);
    expect(h.trainResults.find((t) => t.trainId === "carB")).toMatchObject({ passed: false });
    // Rework forked from the new main: fast path, lands.
    await forkAndBuild(h, "mb2", `b ${BATCH_FAIL_MARKER}`, { action: "REWORK", promptId: "p-mb" });
    h.world.trains.push({ trainId: "carB", baseSha: "", includedPrompts: [], artifactRepo: "r", status: "EJECTED", createdAt: 0, phase: "EJECTED" });
    await h.sim.drones.dispatch({ ...carTask("carC", ["mb2"]), members: [member("mb2", "p-mb")] });
    await h.advance(1500);
    expect(h.merges.at(-1)).toMatchObject({ merged: ["mb2"], fastForward: true });
  });

  it("a first-attempt [batch-fail] build holds its gate verdict until another build is waiting in the pool", async () => {
    const h = harness(); // the harness's own train t1 is "in flight" (TESTING), so the culprit must wait
    await forkAndBuild(h, "mb", `b ${BATCH_FAIL_MARKER}`);
    await h.advance(100);
    await h.advance(TEST_RETRY_MS * 4);
    expect(h.trainResults.find((t) => t.trainId === "mb")).toBeUndefined();
    h.world.trains.push({ trainId: "ma", baseSha: "", includedPrompts: [], artifactRepo: "r", status: "TESTING", createdAt: 0, phase: "PASSED", lane: "BUILD", carId: null });
    await h.advance(TEST_RETRY_MS);
    await h.advance(100);
    expect(h.trainResults.find((t) => t.trainId === "mb")).toMatchObject({ passed: true });
  });

  it("the hold gives up after BATCH_FAIL_MAX_HOLDS and never applies to a REWORK or a lone build", async () => {
    const h = harness();
    await forkAndBuild(h, "mb2", `b ${BATCH_FAIL_MARKER}`, { action: "REWORK", promptId: "p-mb" });
    await h.advance(200);
    expect(h.trainResults.find((t) => t.trainId === "mb2")).toMatchObject({ passed: true });
    const h2 = harness();
    h2.phase.value = "PASSED"; // the harness's t1 is no longer in flight: nothing to wait for
    await forkAndBuild(h2, "mc", `c ${BATCH_FAIL_MARKER}`);
    await h2.advance(200);
    expect(h2.trainResults.find((t) => t.trainId === "mc")).toMatchObject({ passed: true });
    const h3 = harness();
    await forkAndBuild(h3, "md", `d ${BATCH_FAIL_MARKER}`);
    for (let i = 0; i < BATCH_FAIL_MAX_HOLDS + 2; i++) await h3.advance(TEST_RETRY_MS);
    expect(h3.trainResults.find((t) => t.trainId === "md")).toMatchObject({ passed: true });
  });

  it("[batch-fail] alone passes (fast-forward, no gate run)", async () => {
    const h = harness();
    await forkAndBuild(h, "mb", `b ${BATCH_FAIL_MARKER}`);
    await h.sim.drones.dispatch(carTask("car1", ["mb"]));
    await h.advance(1500);
    await h.advance(1000);
    expect(h.merges[0]).toMatchObject({ fastForward: true });
    expect(h.trainResults.find((t) => t.trainId === "car1")).toBeUndefined();
  });

  it("BUILD gate reports a score with 2-12 KB changedBytes, satisfied 3, missing 0", async () => {
    const h = harness();
    await h.sim.drones.dispatch(task({}));
    await h.advance(100 + 100);
    await h.advance(200);
    const r = h.trainResults[0]!;
    expect(r.score).toMatchObject({ review: "approved", satisfied: 3, missing: 0 });
    expect(r.score!.changedBytes).toBeGreaterThanOrEqual(2048);
    expect(r.score!.changedBytes).toBeLessThanOrEqual(12_288);
  });

  it("race: [fail] fails candidate 0 only (and its build is unverified); [review-fail] rejects candidate 0 only", async () => {
    const h = harness();
    const t = (id: string, candidate: number) => ({ trainId: id, baseSha: "", includedPrompts: [], artifactRepo: "r", status: "TESTING" as const, createdAt: 0, phase: "TESTING" as const, raceId: "race1", candidate });
    h.world.trains.push(t("c0", 0), t("c1", 1), t("c2", 2));
    for (const [i, id] of ["c0", "c1", "c2"].entries()) {
      void i;
      await h.sim.drones.dispatch(task({ trainId: id, promptText: "x [fail] [gate-spot]" }));
    }
    await h.advance(100);
    await h.advance(200);
    expect(h.builds.map((b) => [b.trainId, b.verified])).toEqual([["c0", false], ["c1", true], ["c2", true]]);
    expect(h.trainResults.map((r) => [r.trainId, r.passed])).toEqual([["c0", false], ["c1", true], ["c2", true]]);
    expect(h.trainResults[1]!.followUps).toEqual([expect.objectContaining({ kind: "bug", paths: ["src/legacy/search.js"] })]);

    const h2 = harness();
    h2.world.trains.push(t("c0", 0), t("c1", 1));
    for (const id of ["c0", "c1"]) await h2.sim.drones.dispatch(task({ trainId: id, promptText: "x [review-fail]" }));
    await h2.advance(100);
    await h2.advance(200);
    expect(h2.trainResults.map((r) => [r.trainId, r.passed])).toEqual([["c0", false], ["c1", true]]);
  });
});

describe("sim sentinel: [inconclusive]", () => {
  it("staging verdict is ROLLBACK with inconclusive: true", async () => {
    const h = harness();
    h.world.trains.push({ trainId: "tr", baseSha: "", includedPrompts: ["pi"], artifactRepo: "r", status: "MERGED", createdAt: 0 });
    h.world.promptRuns.push({ promptId: "pi", namespace: "n", promptText: "ship it [inconclusive]", status: "MERGED", createdAt: 0 });
    h.world.releases.push({ releaseId: "r1", hive: "n", headSha: "h", trainIds: ["tr"], phase: "STAGING", canaryPercent: 0, stagingUrl: null, prodUrl: null, candidateVersionId: null, stableVersionId: null, tappedBy: null, tappedAt: null, summary: null, createdAt: 0, updatedAt: 0 } as Release);
    await h.sim.sentinel.dispatch({ commandId: "r1-sentinel-staging", hive: "n", releaseId: "r1", environment: "staging", scriptName: "n-staging", url: "https://n-staging.example", paths: ["/"], minRequests: 100, windowSeconds: 60 });
    await h.advance(2000);
    expect(h.verdicts[0]).toMatchObject({ verdict: "ROLLBACK", inconclusive: true });
  });
});

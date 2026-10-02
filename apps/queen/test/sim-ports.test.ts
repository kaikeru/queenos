import { describe, expect, it } from "vitest";
import type { AppendAuditInput, DeployResult, DroneTask, MergeTrain, ProvisionResult } from "@queenos/queen-types";
import { SimExecutors, TEST_RETRY_MS, fakeSha, simPreviewUrl, type SimQueen, type SimStore } from "../src/sim/sim-ports";

function harness() {
  const kv = new Map<string, unknown>();
  let alarm: number | null = null;
  let clock = 1_000;
  const calls: string[] = [];
  const audits: AppendAuditInput[] = [];
  const provisions: ProvisionResult[] = [];
  const deploys: DeployResult[] = [];
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
    reportBuildResult: async (r) => (calls.push(`build:${r.trainId}`), { outcome: "applied" }),
    reportTrainResult: async (r) => (calls.push(`test:${r.trainId}:${r.passed}`), { outcome: "applied" }),
    reportLandResult: async (r) => (calls.push(`land:${r.trainId}:${r.landed}`), { outcome: "applied" }),
    reportProvisionResult: async (r) => (provisions.push(r), calls.push(`provision:${r.op}:${r.commandId}`), { outcome: "applied" }),
    reportDeployResult: async (r) => (deploys.push(r), calls.push(`deploy:${r.op}:${r.commandId}`), { outcome: "applied" }),
    getSnapshot: () => ({
      trains: [{ trainId: "t1", baseSha: "", includedPrompts: [], artifactRepo: "r", status: "TESTING", createdAt: 0, phase: phase.value, previewUrl: simPreviewUrl("t1") }],
    }),
  };
  const delays = { fork: 300, delete: 50, deploy: 1500, teardown: 50, build: 100, test: 100, land: 100 };
  const sim = new SimExecutors(() => queen, store, delays, () => clock);
  const advance = async (ms: number) => {
    clock += ms;
    return sim.runDue();
  };
  return { sim, advance, calls, audits, provisions, deploys, phase, alarm: () => alarm };
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

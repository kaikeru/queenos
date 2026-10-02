import { describe, expect, it } from "vitest";
import type { AppendAuditInput, DroneTask } from "@queenos/queen-types";
import { SimDroneDispatcher, SimForkProvisioner, fakeSha, type SimQueen, type SimStore } from "../src/sim/sim-ports";

function harness() {
  const kv = new Map<string, unknown>();
  let alarm: number | null = null;
  let clock = 1_000;
  const calls: string[] = [];
  const audits: AppendAuditInput[] = [];
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
  };
  const delays = { fork: 0, build: 100, test: 100, land: 100 };
  const sim = new SimDroneDispatcher(() => queen, store, delays, () => clock);
  const advance = async (ms: number) => {
    clock += ms;
    return sim.runDue();
  };
  return { sim, advance, calls, audits, alarm: () => alarm };
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

describe("sim ports", () => {
  it("forks succeed with deterministic SHAs", async () => {
    const fork = await new SimForkProvisioner(0).forkTrain("hive", "hive-train-x");
    expect(fork).toEqual({ artifactRepo: "hive-train-x", baseSha: fakeSha("base:hive") });
    expect(fakeSha("a")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("a good prompt builds, passes tests, and each stage is armed on the alarm", async () => {
    const h = harness();
    await h.sim.dispatch(task({}));
    expect(h.audits.map((a) => `${a.droneRole}:${a.status}`)).toEqual(["BUILDER:RUNNING"]);
    expect(h.alarm()).toBe(1_100);
    await h.advance(100);
    await h.advance(100);
    expect(h.calls).toEqual(["build:t1", "test:t1:true"]);
    expect(h.audits.some((a) => a.droneRole === "BUILDER" && a.status === "PASSED" && a.gitNotesPayload?.reasoningSteps.length)).toBe(true);
  });

  it("[fail] prompts fail once; REWORK passes; dispatch is idempotent", async () => {
    const h = harness();
    await h.sim.dispatch(task({ promptText: "flaky retry [fail]" }));
    await h.sim.dispatch(task({ promptText: "flaky retry [fail]" }));
    await h.advance(100);
    await h.advance(100);
    expect(h.calls).toEqual(["build:t1", "test:t1:false"]);
    expect(h.audits.some((a) => a.droneRole === "SECURITY" && a.status === "REJECTED")).toBe(true);

    await h.sim.dispatch(task({ trainId: "t2", action: "REWORK", promptText: "flaky retry [fail]" }));
    await h.advance(100);
    await h.advance(100);
    expect(h.calls.slice(2)).toEqual(["build:t2", "test:t2:true"]);
  });

  it("the LAND flow auto-completes", async () => {
    const h = harness();
    await h.sim.dispatch(task({ role: "LANDER", action: "LAND" }));
    await h.advance(100);
    expect(h.calls).toEqual(["land:t1:true"]);
    expect(h.audits.at(-1)).toMatchObject({ droneRole: "LANDER", status: "PASSED" });
  });
});

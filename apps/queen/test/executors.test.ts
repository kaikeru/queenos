import { describe, expect, it } from "vitest";
import type { DeployCommand, ProvisionCommand } from "@queenos/queen-types";
import { WorkflowDroneDispatcher, droneInstanceId } from "../src/drones";
import { WorkflowCommandDispatcher } from "../src/executors";

/** Minimal Workflow binding fake: ids are unique, like real instance ids. */
function fakeWorkflow() {
  const created = new Map<string, unknown>();
  const wf = {
    async create({ id, params }: { id: string; params: unknown }) {
      if (created.has(id)) throw new Error("instance already exists");
      created.set(id, params);
      return { id };
    },
    async get(id: string) {
      if (!created.has(id)) throw new Error("not found");
      return { id };
    },
  } as unknown as Workflow;
  return { wf, created };
}

describe("WorkflowCommandDispatcher", () => {
  const fork: ProvisionCommand = { op: "FORK", commandId: "t1-fork-1", hive: "h", trainId: "t1", sourceRepo: "h", forkName: "h-train-t1" };

  it("creates the executor instance with id = commandId and the command as params; re-dispatch is a no-op", async () => {
    const { wf, created } = fakeWorkflow();
    const d = new WorkflowCommandDispatcher<ProvisionCommand>(wf, "PROVISIONER");
    expect(await d.dispatch(fork)).toEqual({ instanceId: "t1-fork-1" });
    expect(await d.dispatch(fork)).toEqual({ instanceId: "t1-fork-1" });
    expect([...created.entries()]).toEqual([["t1-fork-1", fork]]);
  });

  it("surfaces real create errors and a missing binding as UNAVAILABLE", async () => {
    const broken = {
      create: async () => {
        throw new Error("quota exceeded");
      },
      get: async () => {
        throw new Error("not found");
      },
    } as unknown as Workflow;
    await expect(new WorkflowCommandDispatcher<ProvisionCommand>(broken, "PROVISIONER").dispatch(fork)).rejects.toThrow("quota exceeded");
    const deploy: DeployCommand = { op: "TEARDOWN", commandId: "t1-teardown-1", hive: "h", environment: "preview", trainId: "t1" };
    await expect(new WorkflowCommandDispatcher<DeployCommand>(undefined, "HERALD").dispatch(deploy)).rejects.toThrow(
      /^UNAVAILABLE: HERALD workflow binding is not configured/,
    );
  });
});

describe("createBatch that silently omits instances (array form: ids it could not create are left out, no error)", () => {
  const cmd = (n: number): ProvisionCommand => ({ op: "DELETE", commandId: `t${n}-delete-1`, hive: "h", trainId: `t${n}`, repo: `h-train-t${n}` });

  /** createBatch drops every instance it is given `drop` times (prod 2026-10-07: a retire plan's 3 FORK/DELETEs never started). */
  function droppingWorkflow(drop: number, failCreate = false) {
    const { wf, created } = fakeWorkflow();
    let left = drop;
    const batches: string[][] = [];
    const w = wf as unknown as { create(o: { id: string; params: unknown }): Promise<{ id: string }>; createBatch?: unknown };
    const create = w.create.bind(w);
    if (failCreate) w.create = async () => { throw new Error("workflows.api.error.internal"); };
    w.createBatch = async (batch: { id: string; params: unknown }[]) => {
      batches.push(batch.map((b) => b.id));
      if (left > 0) {
        left--;
        return [];
      }
      return Promise.all(batch.map((b) => create(b)));
    };
    return { wf, created, batches };
  }

  it("instances the batch left out are created one by one, in the same call", async () => {
    const { wf, created, batches } = droppingWorkflow(1);
    const d = new WorkflowCommandDispatcher<ProvisionCommand>(wf, "PROVISIONER");
    expect(await d.dispatchMany([cmd(1), cmd(2), cmd(3)])).toEqual({ failed: [] });
    expect(batches).toHaveLength(1);
    expect([...created.keys()].sort()).toEqual(["t1-delete-1", "t2-delete-1", "t3-delete-1"]);
  });

  it("left-out instances that cannot be created either are reported failed (the Queen reconciles in 15 s)", async () => {
    const { wf, created } = droppingWorkflow(1, true);
    const d = new WorkflowCommandDispatcher<ProvisionCommand>(wf, "PROVISIONER");
    expect((await d.dispatchMany([cmd(1), cmd(2)])).failed.sort()).toEqual(["t1-delete-1", "t2-delete-1"]);
    expect(created.size).toBe(0);
  });

  it("a re-dispatch whose ids already exist (left out by the batch) still counts as started", async () => {
    const { wf, created } = droppingWorkflow(0);
    const d = new WorkflowCommandDispatcher<ProvisionCommand>(wf, "PROVISIONER");
    await d.dispatchMany([cmd(1), cmd(2)]);
    const w = wf as unknown as { createBatch(b: { id: string }[]): Promise<{ id: string }[]> };
    const real = w.createBatch.bind(w);
    // A real createBatch omits existing ids from its result.
    w.createBatch = async (b) => (await real(b.filter((x) => !created.has(x.id)))) ;
    expect(await d.dispatchMany([cmd(1), cmd(2)])).toEqual({ failed: [] });
  });
});

describe("WorkflowDroneDispatcher", () => {
  const task = {
    promptId: "p",
    trainId: "t1",
    namespace: "hive",
    artifactRepo: "hive-train-t1",
    baseRef: "main",
    promptText: "x",
    role: "BUILDER" as const,
    action: "BUILD" as const,
    ragContext: [],
  };

  it("creates a Workflow instance with a deterministic id and treats re-dispatch as success", async () => {
    const { wf } = fakeWorkflow();
    const d = new WorkflowDroneDispatcher(wf);
    expect(await d.dispatch(task)).toEqual({ instanceId: "t1-build" });
    expect(await d.dispatch(task)).toEqual({ instanceId: droneInstanceId(task) });
    await expect(new WorkflowDroneDispatcher(undefined).dispatch(task)).rejects.toThrow(/^UNAVAILABLE/);
  });
});

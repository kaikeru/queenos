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

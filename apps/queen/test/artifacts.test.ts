import { describe, expect, it } from "vitest";
import { ArtifactsForkProvisioner } from "../src/artifacts";
import { WorkflowDroneDispatcher, droneInstanceId } from "../src/drones";

const artifactsError = (code: string) => Object.assign(new Error(code), { name: "ArtifactsError", code });

/** Minimal fake of the Artifacts binding, recording calls and disposals. */
function fakeArtifacts(script: { forkErrors?: string[]; getErrors?: Record<string, string[]>; head?: string }) {
  const calls: string[] = [];
  let disposed = 0;
  const forkErrors = [...(script.forkErrors ?? [])];
  const binding = {
    async get(name: string) {
      calls.push(`get:${name}`);
      const err = script.getErrors?.[name]?.shift();
      if (err) throw artifactsError(err);
      return {
        async fork(target: string, opts: { defaultBranchOnly?: boolean }) {
          calls.push(`fork:${name}->${target}:${opts.defaultBranchOnly}`);
          const e = forkErrors.shift();
          if (e) throw artifactsError(e);
          return { name: target };
        },
        async log(opts: { ref?: string; limit?: number }) {
          calls.push(`log:${name}:${opts.ref}:${opts.limit}`);
          return script.head ? [{ hash: script.head }] : [];
        },
        [Symbol.dispose]() {
          disposed++;
        },
      };
    },
    async delete(name: string) {
      calls.push(`delete:${name}`);
      return true;
    },
  };
  return { binding: binding as unknown as Artifacts, calls, disposed: () => disposed };
}

const noSleep = async () => {};

describe("ArtifactsForkProvisioner", () => {
  it("forks with the real API, reads the base SHA via log, and disposes handles", async () => {
    const f = fakeArtifacts({ head: "abc123" });
    const p = new ArtifactsForkProvisioner(f.binding, { sleep: noSleep });
    expect(await p.forkTrain("hive", "hive-train-1")).toEqual({ artifactRepo: "hive-train-1", baseSha: "abc123" });
    expect(f.calls).toEqual(["get:hive", "fork:hive->hive-train-1:true", "get:hive-train-1", "log:hive-train-1:main:1"]);
    expect(f.disposed()).toBe(2);
  });

  it("retries FORK_IN_PROGRESS and reuses an existing fork", async () => {
    const f = fakeArtifacts({
      head: "abc",
      forkErrors: ["FORK_IN_PROGRESS", "ALREADY_EXISTS"],
      getErrors: { "hive-train-2": ["FORK_IN_PROGRESS", "FORK_IN_PROGRESS"] },
    });
    const p = new ArtifactsForkProvisioner(f.binding, { sleep: noSleep });
    expect((await p.forkTrain("hive", "hive-train-2")).baseSha).toBe("abc");
    expect(f.calls.filter((c) => c.startsWith("fork:"))).toHaveLength(2);
    expect(f.calls.filter((c) => c === "get:hive-train-2")).toHaveLength(3);
  });

  it("does not retry other errors, and gives up after the attempt budget", async () => {
    const bad = fakeArtifacts({ forkErrors: ["INVALID_REPO_NAME"] });
    await expect(new ArtifactsForkProvisioner(bad.binding, { sleep: noSleep }).forkTrain("hive", "x")).rejects.toThrow("INVALID_REPO_NAME");
    const stuck = fakeArtifacts({ forkErrors: Array(10).fill("FORK_IN_PROGRESS") });
    await expect(new ArtifactsForkProvisioner(stuck.binding, { sleep: noSleep, attempts: 3 }).forkTrain("hive", "x")).rejects.toThrow(
      "FORK_IN_PROGRESS",
    );
  });

  it("deletes forks and reports a missing binding as UNAVAILABLE", async () => {
    const f = fakeArtifacts({});
    expect(await new ArtifactsForkProvisioner(f.binding).deleteFork("hive-train-1")).toBe(true);
    await expect(new ArtifactsForkProvisioner(undefined).forkTrain("a", "b")).rejects.toThrow(/^UNAVAILABLE: /);
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
    const created = new Set<string>();
    const wf = {
      async create({ id }: { id: string }) {
        if (created.has(id)) throw new Error("instance already exists");
        created.add(id);
        return { id };
      },
      async get(id: string) {
        if (!created.has(id)) throw new Error("not found");
        return { id };
      },
    } as unknown as Workflow;
    const d = new WorkflowDroneDispatcher(wf);
    expect(await d.dispatch(task)).toEqual({ instanceId: "t1-build" });
    expect(await d.dispatch(task)).toEqual({ instanceId: droneInstanceId(task) });
    await expect(new WorkflowDroneDispatcher(undefined).dispatch(task)).rejects.toThrow(/^UNAVAILABLE/);
  });
});

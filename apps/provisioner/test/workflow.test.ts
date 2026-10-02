import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { FakeWorld, fork, del, setWorld } from "./fakes";

afterEach(() => setWorld(null));

describe("ProvisionerWorkflow (Workflows runtime, fake ports)", () => {
  it("runs a FORK instance (id = commandId) and reports to the Queen", async () => {
    const w = new FakeWorld();
    setWorld(w);
    await using instance = await introspectWorkflowInstance(env.PROVISIONER_WORKFLOW, "cmd-1");
    await env.PROVISIONER_WORKFLOW.create({ id: "cmd-1", params: fork() });
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toMatchObject({ commandId: "cmd-1", op: "FORK", ok: true, queenOutcome: "applied" });
    expect(w.queen.results).toEqual([
      expect.objectContaining({ commandId: "cmd-1", ok: true, artifactRepo: "hive-train-aaaaaaaaaaaa", baseSha: "a".repeat(40) }),
    ]);
  });

  it("runs a DELETE instance", async () => {
    const w = new FakeWorld();
    w.artifacts.existing.add("hive-train-aaaaaaaaaaaa");
    setWorld(w);
    await using instance = await introspectWorkflowInstance(env.PROVISIONER_WORKFLOW, "cmd-2");
    await env.PROVISIONER_WORKFLOW.create({ id: "cmd-2", params: del() });
    await instance.waitForStatus("complete");
    expect(w.queen.results[0]).toMatchObject({ op: "DELETE", ok: true });
  });

  it("errors the instance on an invalid command", async () => {
    setWorld(new FakeWorld());
    await using instance = await introspectWorkflowInstance(env.PROVISIONER_WORKFLOW, "bad");
    await env.PROVISIONER_WORKFLOW.create({ id: "bad", params: { op: "NOPE" } as never });
    await instance.waitForStatus("errored");
    expect((await instance.getError()).message).toMatch(/invalid ProvisionCommand/);
  });
});

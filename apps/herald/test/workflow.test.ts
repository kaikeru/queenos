import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { FakeWorld, deploy, setWorld, teardown } from "./fakes";

afterEach(() => setWorld(null));

describe("HeraldWorkflow (Workflows runtime, fake ports)", () => {
  it("runs a preview DEPLOY instance (id = commandId) and reports to the Queen", async () => {
    const w = new FakeWorld();
    setWorld(w);
    await using instance = await introspectWorkflowInstance(env.HERALD_WORKFLOW, "cmd-1");
    await env.HERALD_WORKFLOW.create({ id: "cmd-1", params: deploy() });
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toMatchObject({ commandId: "cmd-1", ok: true, queenOutcome: "applied" });
    expect(w.queen.results[0]).toMatchObject({ ok: true, op: "DEPLOY", url: expect.stringMatching(/^https:\/\//) });
  });

  it("runs a TEARDOWN instance", async () => {
    const w = new FakeWorld();
    setWorld(w);
    await using instance = await introspectWorkflowInstance(env.HERALD_WORKFLOW, "cmd-2");
    await env.HERALD_WORKFLOW.create({ id: "cmd-2", params: teardown() });
    await instance.waitForStatus("complete");
    expect(w.queen.results[0]).toMatchObject({ op: "TEARDOWN", ok: true });
  });

  it("errors the instance on an invalid command", async () => {
    setWorld(new FakeWorld());
    await using instance = await introspectWorkflowInstance(env.HERALD_WORKFLOW, "bad");
    await env.HERALD_WORKFLOW.create({ id: "bad", params: { op: "NOPE" } as never });
    await instance.waitForStatus("errored");
    expect((await instance.getError()).message).toMatch(/invalid DeployCommand/);
  });
});

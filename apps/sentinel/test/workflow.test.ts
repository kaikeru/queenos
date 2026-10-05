import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { SentinelCommandSchema } from "@queenos/queen-types";
import { afterEach, describe, expect, it } from "vitest";
import { FakeWorld, canary, setWorld, staging } from "./fakes";

afterEach(() => setWorld(null));

describe("SentinelWorkflow (Workflows runtime, fake ports)", () => {
  it("runs a staging instance (id = commandId) and reports to the Queen", async () => {
    const w = new FakeWorld();
    setWorld(w);
    await using instance = await introspectWorkflowInstance(env.SENTINEL_WORKFLOW, "cmd-1");
    await instance.modify(async (m) => {
      await m.disableSleeps();
    });
    await env.SENTINEL_WORKFLOW.create({ id: "cmd-1", params: SentinelCommandSchema.parse(staging({ minRequests: 40, windowSeconds: 10 })) });
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toMatchObject({ commandId: "cmd-1", verdict: "PROMOTE", queenOutcome: "applied" });
    expect(w.verdicts[0]).toMatchObject({ environment: "staging", verdict: "PROMOTE" });
  });

  it("runs a canary instance with pinned probes", async () => {
    const w = new FakeWorld();
    setWorld(w);
    await using instance = await introspectWorkflowInstance(env.SENTINEL_WORKFLOW, "cmd-2");
    await instance.modify(async (m) => {
      await m.disableSleeps();
    });
    await env.SENTINEL_WORKFLOW.create({ id: "cmd-2", params: SentinelCommandSchema.parse(canary({ minRequests: 40, windowSeconds: 10 })) });
    await instance.waitForStatus("complete");
    expect(w.calls.every((c) => c.headers["Cloudflare-Workers-Version-Overrides"])).toBe(true);
    expect(w.verdicts[0]).toMatchObject({ environment: "canary", verdict: "PROMOTE" });
  });

  it("errors the instance on an invalid command", async () => {
    setWorld(new FakeWorld());
    await using instance = await introspectWorkflowInstance(env.SENTINEL_WORKFLOW, "bad");
    await env.SENTINEL_WORKFLOW.create({ id: "bad", params: { environment: "nope" } as never });
    await instance.waitForStatus("errored");
    expect((await instance.getError()).message).toMatch(/invalid SentinelCommand/);
  });
});

import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { FakeWorld, decomposeCmd, setWorld, triageCmd } from "./fakes";

afterEach(() => setWorld(null));

describe("OracleWorkflow (Workflows runtime, fake ports)", () => {
  it("runs a DECOMPOSE instance (id = commandId) and reports to the Queen", async () => {
    const w = new FakeWorld();
    w.llm.script = [JSON.stringify({ children: [{ key: "c1", title: "Footer", body: "b", paths: ["src/footer.js"] }] })];
    setWorld(w);
    await using instance = await introspectWorkflowInstance(env.ORACLE_WORKFLOW, "g1-decompose-1");
    await env.ORACLE_WORKFLOW.create({ id: "g1-decompose-1", params: decomposeCmd() });
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toMatchObject({ commandId: "g1-decompose-1", op: "DECOMPOSE", ok: true, queenOutcome: "applied" });
    expect(w.queen.results[0]).toMatchObject({ ok: true, children: [expect.objectContaining({ key: "c1", paths: ["src/footer.js"] })] });
  });

  it("runs a TRIAGE instance", async () => {
    const w = new FakeWorld();
    setWorld(w);
    await using instance = await introspectWorkflowInstance(env.ORACLE_WORKFLOW, "b1-triage-1");
    await env.ORACLE_WORKFLOW.create({ id: "b1-triage-1", params: triageCmd() });
    await instance.waitForStatus("complete");
    expect(w.queen.results[0]).toMatchObject({ op: "TRIAGE", ok: true, similar: [] });
  });

  it("errors the instance on an invalid command", async () => {
    setWorld(new FakeWorld());
    await using instance = await introspectWorkflowInstance(env.ORACLE_WORKFLOW, "bad");
    await env.ORACLE_WORKFLOW.create({ id: "bad", params: { op: "NOPE" } as never });
    await instance.waitForStatus("errored");
    expect((await instance.getError()).message).toMatch(/invalid OracleCommand/);
  });
});

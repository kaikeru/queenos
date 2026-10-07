import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { GateCommandSchema, type GateCommand } from "@queenos/queen-types";
import { gateInstanceId } from "../src/event";
import { FakeWorld, REPO, pushedEnvelope, gateTask, setWorld } from "./fakes";

afterEach(() => setWorld(null));

describe("GatekeeperWorkflow (Workflows runtime, scripted mode, fake ports)", () => {
  it("gate instance: runs a real clone/scan on MemFS and reports the verdict", async () => {
    const w = new FakeWorld();
    await w.git.seed(REPO);
    const after = await w.git.build(REPO, { prompt: "Add dark mode", files: { "src/a.ts": "export const a = 1;\n" } });
    w.queen.train.headSha = after;
    setWorld(w);

    const id = gateInstanceId({ repo: REPO, after });
    await using instance = await introspectWorkflowInstance(env.GATEKEEPER_WORKFLOW, id);
    await env.GATEKEEPER_WORKFLOW.create({ id, params: gateTask(after) });
    await instance.waitForStatus("complete");

    expect(await instance.getOutput()).toMatchObject({ status: "gated", passed: true, queenOutcome: "applied" });
    expect(w.queen.reports()).toEqual([{ trainId: "train-1", passed: true, summary: expect.any(String), commitSha: after, score: expect.objectContaining({ review: "approved" }) }]);
    expect(w.queen.auditSeq()).toEqual(["POLICY:RUNNING", "SECURITY:RUNNING", "POLICY:PASSED", "SECURITY:PASSED", "REVIEWER:RUNNING", "REVIEWER:PASSED"]);
  });

  it("Queen GATE command: the Queen's own payload (commandId, trainId, trace) runs as the gate and reports its gateId", async () => {
    const w = new FakeWorld();
    await w.git.seed(REPO);
    const after = await w.git.build(REPO, { prompt: "Add dark mode", files: { "src/a.ts": "export const a = 1;\n" } });
    w.queen.train.headSha = after;
    const id = `gate-${REPO}-${after}-q1`;
    w.queen.serveTarget({ trainId: "train-1", lane: "BUILD", promptId: "prompt-1", promptText: "Add dark mode", previewUrl: null, phase: "TESTING", traceId: null, baseSha: null, gateId: id });
    setWorld(w);
    const command: GateCommand = { kind: "gate", commandId: id, hive: "hive", trainId: "train-1", repo: REPO, branch: "main", after, trace: { traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01` } };
    expect(GateCommandSchema.parse(command)).toEqual(command);
    await using instance = await introspectWorkflowInstance(env.GATEKEEPER_WORKFLOW, id);
    await env.GATEKEEPER_WORKFLOW.create({ id, params: command });
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toMatchObject({ status: "gated", passed: true, queenOutcome: "applied" });
    expect(w.queen.reports()).toEqual([expect.objectContaining({ trainId: "train-1", passed: true, commitSha: after, gateId: id })]);
  });

  it("gate instance: the [fail] demo fails, scribes and reports passed:false", async () => {
    const w = new FakeWorld();
    await w.git.seed(REPO);
    const after = await w.git.build(REPO, { prompt: "Fix retries [fail]", files: { "features/x.md": "Fix retries [fail]\n" } });
    w.queen.train.headSha = after;
    setWorld(w);

    const id = gateInstanceId({ repo: REPO, after });
    await using instance = await introspectWorkflowInstance(env.GATEKEEPER_WORKFLOW, id);
    await env.GATEKEEPER_WORKFLOW.create({ id, params: gateTask(after) });
    await instance.waitForStatus("complete");

    expect(await instance.getOutput()).toMatchObject({ status: "gated", passed: false, scribe: "extractive", vectorized: expect.any(Number) });
    expect(w.queen.auditSeq().slice(-2)).toEqual(["SCRIBE:RUNNING", "SCRIBE:PASSED"]);
    expect(w.queen.reports()[0]).toMatchObject({ passed: false, commitSha: after });
    expect(w.failures.stored).toHaveLength(1);
    expect(w.failures.stored[0]!.length).toBeGreaterThan(1);
  });

  it("trigger instance: a pushed envelope dispatches a deterministic gate instance", async () => {
    const w = new FakeWorld();
    setWorld(w);
    const id = "evt-1";
    await using instance = await introspectWorkflowInstance(env.GATEKEEPER_WORKFLOW, id);
    await env.GATEKEEPER_WORKFLOW.create({ id, params: pushedEnvelope({ after: "c".repeat(40) }) });
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toMatchObject({ status: "dispatched", gateId: gateInstanceId({ repo: REPO, after: "c".repeat(40) }) });
    expect(w.dispatcher.started).toHaveLength(1);
  });

  it("trigger instance: the lander's push to the hive repo is ignored", async () => {
    const w = new FakeWorld();
    setWorld(w);
    const id = "evt-2";
    await using instance = await introspectWorkflowInstance(env.GATEKEEPER_WORKFLOW, id);
    await env.GATEKEEPER_WORKFLOW.create({ id, params: pushedEnvelope({ repoName: "hive" }) });
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({ status: "ignored", reason: "not-a-train-fork" });
    expect(w.dispatcher.started).toEqual([]);
  });

  it("serves /health", async () => {
    const { SELF } = await import("cloudflare:test");
    const res = await SELF.fetch("https://gk.test/health");
    expect(await res.json()).toEqual({ ok: true, service: "gatekeepers", testMode: "scripted", scribeMode: "extractive" });
    expect((await SELF.fetch("https://gk.test/events/push", { method: "POST" })).status).toBe(404);
  });
});

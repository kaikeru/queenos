/**
 * Queen-started gates. The gatekeeper Workflow triggered by the push event polls the Queen for TESTING only
 * about 2 minutes, then gives up ("phase-timeout"); its instance id is deterministic per (repo, after), so the
 * push cannot be replayed. A pushed train parked in BUILDING (paused hive, budget, capacity, dependencies),
 * or any train whose preview takes longer, would never be gated. So the Queen dispatches a GATE command
 * (gatekeepers Workflow, deterministic id) whenever a train enters TESTING; the gatekeeper's GateTarget names
 * it (`gateId`), every other gate instance for that round stands down, and a report from a gate the Queen has
 * replaced is ignored. A gate that does not report within the gate timeout is re-dispatched once, then the
 * train takes the infra path (re-deploy, re-gate; past the cap, EXECUTOR_LOST).
 */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { DeployCommand, DroneTask, GateCommand, ProvisionCommand } from "@queenos/queen-types";
import type { QueenNode } from "../src/queen-node";
import { DEFAULT_COMMAND_TIMEOUT_MS as COMMAND_TIMEOUT_MS, GATE_TIMEOUT_MS, gateCommandId } from "../src/train/planner";
import type { RecordingDispatcher, RecordingGatekeeper, RecordingHerald, RecordingProvisioner } from "./fakes";

const USER = "ada@example.com";
const newHive = () => `qg-${crypto.randomUUID().slice(0, 8)}`;
const stubFor = (ns: string) => env.QUEEN_NODE.get(env.QUEEN_NODE.idFromName(ns));
let shaN = 0;
const sha = () => (0xabc000 + ++shaN).toString(16).padStart(40, "0");

type Row = { train_id: string; phase: string; lane: string; head_sha: string | null; artifact_repo: string; deploy_state: string; deploy_command_id: string | null; gate_command_id: string | null; reason: string | null };

function look(ns: string) {
  return runInDurableObject(stubFor(ns), (q: QueenNode) => ({
    gates: (q.ports.gatekeeper as RecordingGatekeeper).commands.map((c) => ({ ...c })) as GateCommand[],
    deploys: (q.ports.herald as RecordingHerald).commands.map((c) => ({ ...c })) as DeployCommand[],
    provisions: (q.ports.provisioner as RecordingProvisioner).commands.map((c) => ({ ...c })) as ProvisionCommand[],
    tasks: (q.ports.dispatcher as RecordingDispatcher).tasks.map((t) => ({ ...t })) as DroneTask[],
    trains: q.sql.exec("SELECT * FROM merge_trains ORDER BY seq").toArray() as unknown as Row[],
    events: q.sql.exec("SELECT type, summary, train_id, command_id FROM event_log ORDER BY seq").toArray() as { type: string; summary: string; train_id: string | null; command_id: string | null }[],
  }));
}

/** Move the Queen's clock forward and run its alarm (watchdogs + reconcile). */
async function later(ns: string, ms: number): Promise<void> {
  await runInDurableObject(stubFor(ns), async (q: QueenNode) => {
    (q as unknown as { clockOffset: number }).clockOffset += ms;
    await q.alarm();
  });
}

/** Report the newest preview DEPLOY of `trainId` as live. */
async function previewLive(ns: string, trainId: string): Promise<void> {
  const c = (await look(ns)).deploys.filter((d): d is Extract<DeployCommand, { op: "DEPLOY" }> => d.op === "DEPLOY" && d.trainId === trainId).at(-1)!;
  expect(await stubFor(ns).reportDeployResult({ commandId: c.commandId, op: "DEPLOY", environment: "preview", trainId, ok: true, url: `https://${trainId}.test.dev`, commitSha: c.commitSha })).toMatchObject({ outcome: "applied" });
}

async function pushParked(ns: string): Promise<{ trainId: string; repo: string; head: string }> {
  const stub = stubFor(ns);
  await stub.updateSettings({ hive: ns, user: USER, patch: { autonomy: "paused" } });
  const head = sha();
  const d = await stub.gitIntent({ hive: ns, user: USER, ref: "refs/heads/late", oldSha: "0".repeat(40), newSha: head });
  if (d.verdict !== "accept") throw new Error("refused");
  await stub.gitPushed({ hive: ns, trainId: d.trainId, repo: d.repo, ref: "refs/heads/late", headSha: head, baseSha: "f".repeat(40), title: "Late push", message: "Late push", trailers: {} });
  return { trainId: d.trainId, repo: d.repo, head };
}

describe("Queen-started gates", () => {
  it("gateCommandId: deterministic, Workflow-safe (≤ 100 chars), never the push-triggered gate's id", () => {
    const repo = "hive-train-0123456789ab";
    const head = "a".repeat(40);
    expect(gateCommandId(repo, head, 1)).toBe(`gate-${repo}-${head}-q1`);
    expect(gateCommandId(repo, head, 2)).toBe(`gate-${repo}-${head}-q2`);
    const long = gateCommandId(`${"h".repeat(60)}-train-0123456789ab-r2`, head, 12);
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long).toMatch(/^gate-[A-Za-z0-9_-]+-q12$/);
  });

  it("a pushed train parked far longer than the push gate waits is gated by the Queen once it reaches TESTING", async () => {
    const ns = newHive();
    const stub = stubFor(ns);
    const { trainId, repo, head } = await pushParked(ns);
    let s = await look(ns);
    expect(s.trains.find((t) => t.train_id === trainId)).toMatchObject({ phase: "BUILDING" });
    expect(s.gates).toEqual([]);
    // Parked for an hour: the push-triggered gate gave up long ago (phase-timeout).
    await later(ns, 60 * 60_000);
    await stub.updateSettings({ hive: ns, user: USER, patch: { autonomy: "autonomous" } });
    s = await look(ns);
    expect(s.trains.find((t) => t.train_id === trainId)).toMatchObject({ phase: "DEPLOYING" });
    expect(s.gates).toEqual([]);
    await previewLive(ns, trainId);
    s = await look(ns);
    const id = gateCommandId(repo, head, 1);
    expect(s.gates).toEqual([{ kind: "gate", commandId: id, hive: ns, trainId, repo, branch: "main", after: head, trace: expect.any(Object) }]);
    expect(s.trains.find((t) => t.train_id === trainId)).toMatchObject({ phase: "TESTING", gate_command_id: id });
    expect(s.events.some((e) => e.type === "command.issued" && e.command_id === id)).toBe(true);
    // The gatekeeper's lookup names the gate that owns this round: every other instance stands down.
    expect(await stub.getGateTarget(repo)).toMatchObject({ trainId, phase: "TESTING", gateId: id });
    // The alarm's reconcile re-sends the same id (idempotent), and records no second command.issued.
    await later(ns, 1_000);
    s = await look(ns);
    expect(new Set(s.gates.map((g) => g.commandId))).toEqual(new Set([id]));
    expect(s.events.filter((e) => e.type === "command.issued" && e.command_id === id)).toHaveLength(1);
    // A report from another gate (the push-triggered one, or a replaced Queen gate) is stale; the owner's applies.
    expect(await stub.reportTrainResult({ trainId, passed: true, summary: "green", commitSha: head, gateId: `${id}x` })).toMatchObject({ outcome: "ignored:stale" });
    expect(await stub.reportTrainResult({ trainId, passed: true, summary: "green", commitSha: head, gateId: id })).toMatchObject({ outcome: "applied" });
    expect((await look(ns)).trains.find((t) => t.train_id === trainId)!.phase).toBe("PASSED");
    // No gate is outstanding any more: the alarm does not re-send it.
    const before = (await look(ns)).gates.length;
    await later(ns, GATE_TIMEOUT_MS + 1);
    expect((await look(ns)).gates.filter((g) => g.trainId === trainId)).toHaveLength(before);
  });

  it("a drone BUILD train is gated by the Queen too; a report without gateId (an older gatekeeper) is still honoured", async () => {
    const ns = newHive();
    const stub = stubFor(ns);
    await stub.submitWork({ namespace: ns, promptText: "Add /features/otter" });
    let s = await look(ns);
    const fork = s.provisions.find((c): c is Extract<ProvisionCommand, { op: "FORK" }> => c.op === "FORK")!;
    await stub.reportProvisionResult({ commandId: fork.commandId, op: "FORK", trainId: fork.trainId, ok: true, artifactRepo: fork.forkName, baseSha: "b".repeat(40) });
    const head = sha();
    await stub.reportBuildResult({ trainId: fork.trainId, headSha: head });
    await previewLive(ns, fork.trainId);
    s = await look(ns);
    expect(s.gates).toEqual([expect.objectContaining({ commandId: gateCommandId(fork.forkName, head, 1), trainId: fork.trainId, repo: fork.forkName, after: head })]);
    expect(await stub.reportTrainResult({ trainId: fork.trainId, passed: true, summary: "green", commitSha: head })).toMatchObject({ outcome: "applied" });
  });

  it("watchdog: no verdict within the gate timeout → re-gated once (a new id; the old gate's late report is stale), then the infra path", async () => {
    const ns = newHive();
    const stub = stubFor(ns);
    const { trainId, repo, head } = await pushParked(ns);
    await stub.updateSettings({ hive: ns, user: USER, patch: { autonomy: "autonomous" } });
    await previewLive(ns, trainId);
    const q1 = gateCommandId(repo, head, 1);
    // Not before the timeout.
    await later(ns, GATE_TIMEOUT_MS - 60_000);
    expect(new Set((await look(ns)).gates.map((g) => g.commandId))).toEqual(new Set([q1]));
    await later(ns, 60_001);
    let s = await look(ns);
    const q2 = gateCommandId(repo, head, 2);
    expect(s.gates.at(-1)).toMatchObject({ commandId: q2, trainId, after: head });
    expect(s.trains.find((t) => t.train_id === trainId)).toMatchObject({ phase: "TESTING", gate_command_id: q2 });
    expect(await stub.getGateTarget(repo)).toMatchObject({ gateId: q2 });
    expect(await stub.reportTrainResult({ trainId, passed: true, summary: "late", commitSha: head, gateId: q1 })).toMatchObject({ outcome: "ignored:stale" });
    // The re-gate is silent too: the infra path (preview re-deployed after a backoff, then a fresh gate).
    await later(ns, GATE_TIMEOUT_MS + 1);
    s = await look(ns);
    const t = s.trains.find((x) => x.train_id === trainId)!;
    expect(t).toMatchObject({ phase: "DEPLOYING", deploy_state: "FAILED" });
    expect(s.events.some((e) => e.train_id === trainId && /gate did not report/.test(e.summary))).toBe(true);
    await later(ns, COMMAND_TIMEOUT_MS); // past the infra backoff: the alarm re-deploys
    await previewLive(ns, trainId);
    s = await look(ns);
    expect(s.gates.at(-1)).toMatchObject({ commandId: gateCommandId(repo, head, 3), trainId });
  });

  it("a train already in TESTING without a Queen gate (from before this Queen) is gated by the next alarm", async () => {
    const ns = newHive();
    const stub = stubFor(ns);
    const { trainId, repo, head } = await pushParked(ns);
    await stub.updateSettings({ hive: ns, user: USER, patch: { autonomy: "autonomous" } });
    await previewLive(ns, trainId);
    // Simulate a pre-v15 row: TESTING, no gate recorded, nothing dispatched.
    await runInDurableObject(stub, (q: QueenNode) => {
      q.sql.exec("UPDATE merge_trains SET gate_command_id = NULL, gate_issued_at = NULL WHERE train_id = ?", trainId);
      (q.ports.gatekeeper as RecordingGatekeeper).commands.length = 0;
      q.cache.invalidate();
    });
    expect(await stub.getGateTarget(repo)).toMatchObject({ phase: "TESTING", gateId: null });
    await later(ns, 1_000);
    expect((await look(ns)).gates).toEqual([expect.objectContaining({ commandId: gateCommandId(repo, head, 1), trainId })]);
    expect(await stub.getGateTarget(repo)).toMatchObject({ gateId: gateCommandId(repo, head, 1) });
  });

  it("a car is gated by the Queen as well (its own repo and head)", async () => {
    const ns = newHive();
    const stub = stubFor(ns);
    const { trainId } = await pushParked(ns);
    await stub.updateSettings({ hive: ns, user: USER, patch: { autonomy: "autonomous" } });
    await previewLive(ns, trainId);
    const id = (await look(ns)).trains.find((t) => t.train_id === trainId)!.gate_command_id!;
    await stub.reportTrainResult({ trainId, passed: true, summary: "green", gateId: id });
    let s = await look(ns);
    const car = s.trains.find((t) => t.lane === "QUEUE")!;
    const fork = s.provisions.find((c): c is Extract<ProvisionCommand, { op: "FORK" }> => c.op === "FORK" && c.trainId === car.train_id)!;
    await stub.reportProvisionResult({ commandId: fork.commandId, op: "FORK", trainId: car.train_id, ok: true, artifactRepo: fork.forkName, baseSha: "b".repeat(40) });
    const carHead = sha();
    await stub.reportMergeResult({ trainId: car.train_id, ok: true, headSha: carHead, baseSha: "b".repeat(40), merged: [trainId], fastForward: false });
    s = await look(ns);
    if (s.trains.find((t) => t.train_id === car.train_id)!.phase === "DEPLOYING") await previewLive(ns, car.train_id);
    s = await look(ns);
    expect(s.gates.at(-1)).toMatchObject({ commandId: gateCommandId(fork.forkName, carHead, 1), trainId: car.train_id, repo: fork.forkName, after: carHead });
  });
});

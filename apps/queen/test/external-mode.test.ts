/**
 * `executors: "external"` (per-hive setting): the Queen runs no Oracle and no drone BUILD/REWORK. A goal is
 * one inbox item, READY items wait for git-pushed submissions ("awaiting submissions"), and a push to
 * `item/<id>` / `goal/<slug>` becomes the build: the parked train resumes into preview → gate. The merge
 * queue's MERGE / LANDER drones are unchanged.
 */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { DeployCommand, DroneTask, OracleCommand, ProvisionCommand } from "@queenos/queen-types";
import type { QueenNode } from "../src/queen-node";
import type { RecordingDispatcher, RecordingHerald, RecordingOracle, RecordingProvisioner } from "./fakes";

const ADA = "ada@example.com";
const BOB = "bob@example.com";
const newHive = () => `ext-${crypto.randomUUID().slice(0, 8)}`;
const stubFor = (ns: string) => env.QUEEN_NODE.get(env.QUEEN_NODE.idFromName(ns));
let shaN = 0;
const sha = () => (0xe00000 + ++shaN).toString(16).padStart(40, "0");

type Row = Record<string, unknown>;

const look = (ns: string) =>
  runInDurableObject(stubFor(ns), (q: QueenNode) => ({
    oracle: (q.ports.oracle as RecordingOracle).commands.map((c) => ({ ...c })) as OracleCommand[],
    provisions: (q.ports.provisioner as RecordingProvisioner).commands.map((c) => ({ ...c })) as ProvisionCommand[],
    deploys: (q.ports.herald as RecordingHerald).commands.map((c) => ({ ...c })) as DeployCommand[],
    tasks: (q.ports.dispatcher as RecordingDispatcher).tasks.map((t) => ({ ...t })) as DroneTask[],
    trains: q.sql.exec("SELECT train_id, prompt_id, phase, fork_state, action, race_id FROM merge_trains ORDER BY seq").toArray() as Row[],
    items: q.sql.exec("SELECT item_id, kind, status, parent_id, title, wait_reason FROM work_items ORDER BY seq").toArray() as Row[],
    races: q.sql.exec("SELECT item_id, width, state, train_ids FROM races").toArray() as Row[],
    escalations: q.sql.exec("SELECT reason, status FROM escalations").toArray() as Row[],
    events: q.sql.exec("SELECT type, summary FROM event_log ORDER BY seq").toArray() as { type: string; summary: string }[],
  }));

async function push(ns: string, ref: string, message: string, user = ADA) {
  const stub = stubFor(ns);
  const head = sha();
  const decision = await stub.gitIntent({ hive: ns, user, ref, oldSha: "0".repeat(40), newSha: head });
  if (decision.verdict !== "accept") throw new Error(`refused: ${decision.reason}`);
  const result = await stub.gitPushed({
    hive: ns,
    trainId: decision.trainId,
    repo: decision.repo,
    ref,
    headSha: head,
    baseSha: "f".repeat(40),
    title: message.split("\n")[0]!,
    message,
    trailers: {},
  });
  return { decision, head, result };
}

async function externalHive(): Promise<{ ns: string; stub: ReturnType<typeof stubFor> }> {
  const ns = newHive();
  const stub = stubFor(ns);
  const status = await stub.updateSettings({ hive: ns, user: ADA, patch: { executors: "external" } });
  expect(status.settings.executors).toBe("external");
  return { ns, stub };
}

describe("executors: external (integration)", () => {
  it("PATCH /settings stores the mode (merged with other overrides); default is swarm", async () => {
    const ns = newHive();
    const stub = stubFor(ns);
    expect((await stub.updateSettings({ hive: ns, user: ADA, patch: { budget: { dailyDispatches: 50 } } })).settings.executors).toBe("swarm");
    const ext = await stub.updateSettings({ hive: ns, user: ADA, patch: { executors: "external" } });
    expect(ext.settings).toMatchObject({ executors: "external", budget: { dailyDispatches: 50 } });
    // A later unrelated patch keeps the mode; switching back works.
    expect((await stub.updateSettings({ hive: ns, user: ADA, patch: { autonomy: "supervised" } })).settings.executors).toBe("external");
    expect((await stub.updateSettings({ hive: ns, user: ADA, patch: { executors: "swarm" } })).settings.executors).toBe("swarm");
  });

  it("a goal is one inbox item: no Oracle command, no drone, no fork; the item waits for submissions", async () => {
    const { ns, stub } = await externalHive();
    const { item: goal } = await stub.submitWork({ namespace: ns, promptText: "Dark mode\n- add a toggle\n- persist it", decompose: true });
    const s = await look(ns);
    expect(s.oracle).toEqual([]);
    expect(s.tasks).toEqual([]);
    expect(s.provisions).toEqual([]);
    expect(s.trains).toEqual([]);
    expect(s.escalations).toEqual([]);
    const kids = s.items.filter((i) => i.parent_id === goal.itemId);
    expect(kids).toHaveLength(1);
    expect(s.items.find((i) => i.item_id === goal.itemId)).toMatchObject({ kind: "goal", status: "ACTIVE" });
    expect(kids[0]).toMatchObject({ kind: "feature", status: "READY", wait_reason: "awaiting submissions" });
    expect(s.events.find((e) => e.type === "item.decomposed")!.summary).toBe("external hive: goal filed as one inbox item");
  });

  it("a plain item also waits (no BUILD dispatch); the swarm default dispatches a builder for the same filing", async () => {
    const { ns, stub } = await externalHive();
    await stub.submitWork({ namespace: ns, promptText: "Add /features/otter" });
    const s = await look(ns);
    expect(s.tasks).toEqual([]);
    expect(s.provisions.filter((c) => c.op === "FORK")).toEqual([]);
    expect(s.items).toEqual([expect.objectContaining({ status: "READY", wait_reason: "awaiting submissions" })]);

    const swarm = newHive();
    await stubFor(swarm).submitWork({ namespace: swarm, promptText: "Add /features/otter" });
    expect((await look(swarm)).provisions.some((c) => c.op === "FORK")).toBe(true);
  });

  it("a push to goal/<slug> resolves to the inbox child and resumes into preview → gate; a second user's push joins the race as candidate 2", async () => {
    const { ns, stub } = await externalHive();
    const { item: goal } = await stub.submitWork({ namespace: ns, promptText: "Dark mode\n- toggle", decompose: true });
    const child = (await look(ns)).items.find((i) => i.parent_id === goal.itemId)!;

    // goal/<slug> is the goal's title slug.
    const first = await push(ns, "refs/heads/goal/dark-mode", "Dark mode by Ada");
    expect(first.result).toMatchObject({ itemId: child.item_id });
    let s = await look(ns);
    expect(s.items.find((i) => i.item_id === child.item_id)).toMatchObject({ status: "ACTIVE", wait_reason: null });
    const t1 = s.trains.find((t) => t.prompt_id === child.item_id)!;
    expect(t1).toMatchObject({ train_id: first.decision.trainId, phase: "DEPLOYING", fork_state: "READY" });
    expect(s.deploys.some((d) => d.op === "DEPLOY" && d.environment === "preview" && d.trainId === t1.train_id)).toBe(true);
    expect(s.tasks).toEqual([]);
    expect(s.oracle).toEqual([]);

    // Bob pushes to the same item while Ada's is still gating: one more candidate, no drone.
    const second = await push(ns, `refs/heads/item/${child.item_id}`, "Dark mode by Bob", BOB);
    expect(second.result).toMatchObject({ disposition: "joined-race", itemId: child.item_id });
    s = await look(ns);
    expect(s.races).toHaveLength(1);
    expect(JSON.parse(String(s.races[0]!.train_ids))).toEqual([first.decision.trainId, second.decision.trainId]);
    expect(s.races[0]).toMatchObject({ item_id: child.item_id, state: "RACING" });
    expect(s.trains.filter((t) => t.prompt_id === child.item_id)).toHaveLength(2);
    expect(s.tasks).toEqual([]);
  });

  it("a push to item/<id> of a READY item resumes the parked train (no fork, no builder)", async () => {
    const { ns, stub } = await externalHive();
    const { item } = await stub.fileWorkItem({ hive: ns, user: ADA, item: { kind: "feature", title: "Dark mode" } });
    expect((await look(ns)).items[0]).toMatchObject({ status: "READY", wait_reason: "awaiting submissions" });
    const p = await push(ns, `refs/heads/item/${item.itemId}`, "Dark mode");
    expect(p.result).toMatchObject({ disposition: "joined-race", itemId: item.itemId });
    const s = await look(ns);
    expect(s.items[0]).toMatchObject({ status: "ACTIVE" });
    expect(s.trains).toEqual([expect.objectContaining({ train_id: p.decision.trainId, phase: "DEPLOYING" })]);
    expect(s.tasks).toEqual([]);
    expect(s.provisions.filter((c) => c.op === "FORK")).toEqual([]);
  });

  it("handoff is refused (409) in an external hive", async () => {
    const { ns, stub } = await externalHive();
    const { item } = await stub.fileWorkItem({ hive: ns, user: ADA, item: { kind: "feature", title: "Dark mode" } });
    const err = await stub.workAction({ hive: ns, user: ADA, itemId: item.itemId, action: { action: "handoff" } }).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(err).toMatch(/no swarm/);
  });

  it("a `Queen: rework` trailer is ignored: no swarm remote line, no handoff, and a gate reject awaits the contributor (no REWORK)", async () => {
    const { ns, stub } = await externalHive();
    const { item } = await stub.fileWorkItem({ hive: ns, user: ADA, item: { kind: "feature", title: "Dark mode" } });
    const p = await push(ns, `refs/heads/item/${item.itemId}`, "Dark mode\n\nQueen: rework");
    expect(p.result.messages.join("\n")).not.toContain("the swarm takes over");
    const inbox = await runInDurableObject(stub, (q: QueenNode) => q.sql.exec("SELECT inbox_json FROM work_items WHERE item_id = ?", item.itemId).one().inbox_json);
    expect(JSON.parse(String(inbox)).handoff).toBe(false);
    await stub.reportTrainResult({ trainId: p.decision.trainId, passed: false, summary: "security: nope" });
    const s = await look(ns);
    expect(s.items.find((i) => i.item_id === item.itemId)).toMatchObject({ status: "FAILED" });
    expect(s.trains.filter((t) => t.action === "REWORK")).toEqual([]);
    expect(s.trains).toHaveLength(1);
    expect(s.tasks).toEqual([]);
    expect(s.escalations).toEqual([]);

    // Control: the swarm still announces (and honours) the trailer.
    const swarm = newHive();
    const { item: it2 } = await stubFor(swarm).fileWorkItem({ hive: swarm, user: ADA, item: { kind: "feature", title: "Dark mode" } });
    await stubFor(swarm).updateSettings({ hive: swarm, user: ADA, patch: { autonomy: "paused" } });
    const q = await push(swarm, `refs/heads/item/${it2.itemId}`, "Dark mode\n\nQueen: rework");
    expect(q.result.messages.join("\n")).toContain("the swarm takes over");
  });

  it("a parked push does not consume the capacity its own item needs (maxActiveTrains 1)", async () => {
    const { ns, stub } = await externalHive();
    await stub.updateSettings({ hive: ns, user: ADA, patch: { autonomy: "paused", guardrails: { maxActiveTrains: 1 } } });
    const { item } = await stub.fileWorkItem({ hive: ns, user: ADA, item: { kind: "feature", title: "Dark mode" } });
    const p = await push(ns, `refs/heads/item/${item.itemId}`, "Dark mode");
    let s = await look(ns);
    expect(s.items[0]).toMatchObject({ status: "READY", wait_reason: "paused" });
    expect(s.trains).toEqual([expect.objectContaining({ train_id: p.decision.trainId, phase: "BUILDING" })]);
    await stub.updateSettings({ hive: ns, user: ADA, patch: { autonomy: "autonomous" } });
    s = await look(ns);
    expect(s.items[0]).toMatchObject({ status: "ACTIVE", wait_reason: null });
    expect(s.trains).toEqual([expect.objectContaining({ train_id: p.decision.trainId, phase: "DEPLOYING" })]);
  });
});

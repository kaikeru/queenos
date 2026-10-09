/**
 * `executors: "external"` (per-hive setting): the Queen runs no Oracle and no drone BUILD/REWORK. A goal is
 * one inbox item, READY items wait for git-pushed submissions ("awaiting submissions"), and a push to
 * `item/<id>` / `goal/<slug>` becomes the build: the parked train resumes into preview → gate. The merge
 * queue's MERGE / LANDER drones are unchanged.
 */
import { env, exports } from "cloudflare:workers";
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
    races: q.sql.exec("SELECT race_id, item_id, width, state, train_ids, entry_closes_at, deadline_at, decided_by FROM races").toArray() as Row[],
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

async function externalHive(race?: { entryWindowMs?: number; judge?: "auto" | "human" }): Promise<{ ns: string; stub: ReturnType<typeof stubFor> }> {
  const ns = newHive();
  const stub = stubFor(ns);
  const status = await stub.updateSettings({ hive: ns, user: ADA, patch: { executors: "external", ...(race ? { race: race as never } : {}) } });
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
    const { ns, stub } = await externalHive({ entryWindowMs: 0 }); // no entry window: the race decides as soon as it reported
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

  it("settings: race.entryWindowMs is stored, clamped by effectiveSettings (0 = none), and rejected over 1 h", async () => {
    const ns = newHive();
    const stub = stubFor(ns);
    const status = await stub.updateSettings({ hive: ns, user: ADA, patch: { executors: "external", race: { entryWindowMs: 120_000 } } });
    expect(status.settings.race.entryWindowMs).toBe(120_000);
    expect((await stub.updateSettings({ hive: ns, user: ADA, patch: { race: { entryWindowMs: 0 } } })).settings.race.entryWindowMs).toBe(0);
    expect(await stub.updateSettings({ hive: ns, user: ADA, patch: { race: { entryWindowMs: 3_600_001 } } }).then(() => null, (e: Error) => e.message)).toMatch(/INVALID_INPUT/);
  });
});

// ── the entry window and per-agent branches (human-push design §2.5) ────────────────────────────────

/** Report the newest preview DEPLOY of `trainId` as live, then its gate as passed. */
async function gatePass(ns: string, trainId: string) {
  const c = (await look(ns)).deploys.filter((d): d is Extract<DeployCommand, { op: "DEPLOY" }> => d.op === "DEPLOY" && d.trainId === trainId).at(-1)!;
  await stubFor(ns).reportDeployResult({ commandId: c.commandId, op: "DEPLOY", environment: "preview", trainId, ok: true, url: `https://${trainId}.test.dev`, commitSha: c.commitSha });
  return stubFor(ns).reportTrainResult({ trainId, passed: true, summary: "green" });
}

/** Move the Queen's clock forward and run its alarm (watchdogs, race deadlines, the entry-window close). */
async function later(ns: string, ms: number): Promise<void> {
  await runInDurableObject(stubFor(ns), async (q: QueenNode) => {
    (q as unknown as { clockOffset: number }).clockOffset += ms;
    await q.alarm();
  });
}

const rpcError = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e.message);
const trainIdsOf = (race: Row) => JSON.parse(String(race.train_ids)) as string[];

describe("executors: external: dynamic race entry", () => {
  const WINDOW = 15 * 60_000;

  it("agents sharing one token race one item on item/<id>/<agent> (no supersede); re-pushing your own branch supersedes only it; the push says the race is open", async () => {
    const { ns, stub } = await externalHive();
    const { item } = await stub.fileWorkItem({ hive: ns, user: ADA, item: { kind: "feature", title: "Haiku endpoint" } });
    const before = Date.now();
    const haiku = await push(ns, `refs/heads/item/${item.itemId}/haiku`, "Haiku by haiku");
    expect(haiku.result.messages.some((m) => /^race open to entries until \d\d:\d\d UTC \(1 candidate\)$/.test(m))).toBe(true);
    const opus = await push(ns, `refs/heads/item/${item.itemId}/opus`, "Haiku by opus");
    expect(opus.result).toMatchObject({ disposition: "joined-race", itemId: item.itemId });
    expect(opus.result.messages.some((m) => m.endsWith("(2 candidates)"))).toBe(true);
    let s = await look(ns);
    expect(s.races).toHaveLength(1);
    expect(trainIdsOf(s.races[0]!)).toEqual([haiku.decision.trainId, opus.decision.trainId]);
    // The window is measured from the race's creation (the first push) and the second push does not move it.
    expect(Number(s.races[0]!.entry_closes_at)).toBeGreaterThanOrEqual(before + WINDOW);
    expect(Number(s.races[0]!.entry_closes_at)).toBeLessThanOrEqual(Date.now() + WINDOW);
    const active = (id: string) => s.trains.find((t) => t.train_id === id)!.phase;
    expect([active(haiku.decision.trainId), active(opus.decision.trainId)]).toEqual(["DEPLOYING", "DEPLOYING"]);

    // haiku re-pushes its branch: its own train is replaced; opus's is untouched; still one race.
    const again = await push(ns, `refs/heads/item/${item.itemId}/haiku`, "Haiku by haiku, v2");
    expect(again.result.disposition).toBe("superseded");
    s = await look(ns);
    expect(s.trains.find((t) => t.train_id === haiku.decision.trainId)!.phase).toBe("EJECTED");
    expect(s.trains.find((t) => t.train_id === opus.decision.trainId)!.phase).toBe("DEPLOYING");
    expect(s.trains.find((t) => t.train_id === again.decision.trainId)!.phase).toBe("DEPLOYING");
    expect(s.races).toHaveLength(1);
    expect(trainIdsOf(s.races[0]!)).toContain(again.decision.trainId);
    expect(s.races[0]).toMatchObject({ state: "RACING" });
  });

  it("a pass does not decide while entries are open; close-entries decides (auto judge); a push after the close files a follow-up", async () => {
    const { ns, stub } = await externalHive();
    const { item } = await stub.fileWorkItem({ hive: ns, user: ADA, item: { kind: "feature", title: "Haiku endpoint" } });
    const a = await push(ns, `refs/heads/item/${item.itemId}/haiku`, "by haiku");
    expect(await gatePass(ns, a.decision.trainId)).toMatchObject({ outcome: "applied" });
    let s = await look(ns);
    expect(s.races[0]).toMatchObject({ state: "RACING" });
    expect(s.trains.find((t) => t.train_id === a.decision.trainId)).toMatchObject({ phase: "TESTING" });

    // A late-joining agent still enters (the window is open).
    const b = await push(ns, `refs/heads/item/${item.itemId}/opus`, "by opus");
    expect(b.result.disposition).toBe("joined-race");
    expect((await look(ns)).races[0]).toMatchObject({ state: "RACING" });

    // Close early: opus is still pending, so the race waits at most the grace, then decides for haiku.
    const raceId = String((await look(ns)).races[0]!.race_id);
    const res = await stub.closeRaceEntries({ hive: ns, raceId, user: ADA });
    expect(res.outcome).toBe("applied");
    expect(res.race).toMatchObject({ state: "RACING", raceId });
    expect(res.race.entryClosesAt).toBeLessThanOrEqual(Date.now());
    expect(res.race.deadlineAt).toBeLessThanOrEqual(Date.now() + 90_000);
    expect((await look(ns)).events.some((e) => e.type === "race.entries-closed")).toBe(true);
    // A second close, or a push after it, is refused / filed as a follow-up.
    expect(await rpcError(stub.closeRaceEntries({ hive: ns, raceId, user: ADA }))).toMatch(/^CONFLICT: .*already closed/);
    const late = await push(ns, `refs/heads/item/${item.itemId}/codex`, "by codex", BOB);
    expect(late.result.disposition).toBe("late-new-item");

    await later(ns, 91_000);
    s = await look(ns);
    expect(s.races[0]).toMatchObject({ state: "DECIDED" });
    expect(await rpcError(stub.closeRaceEntries({ hive: ns, raceId, user: ADA }))).toMatch(/^CONFLICT: .*DECIDED/);
    expect(await rpcError(stub.closeRaceEntries({ hive: ns, raceId: "nope", user: ADA }))).toMatch(/^NOT_FOUND: /);
  });

  it("a re-push on your own branch after entries closed (race still RACING) files a follow-up; the passed candidate stays in the race", async () => {
    const { ns, stub } = await externalHive();
    const { item } = await stub.fileWorkItem({ hive: ns, user: ADA, item: { kind: "feature", title: "Haiku endpoint" } });
    const a = await push(ns, `refs/heads/item/${item.itemId}/haiku`, "by haiku");
    await push(ns, `refs/heads/item/${item.itemId}/opus`, "by opus"); // stays pending, so the race is "closed · deciding"
    await gatePass(ns, a.decision.trainId);
    const raceId = String((await look(ns)).races[0]!.race_id);
    await stub.closeRaceEntries({ hive: ns, raceId, user: ADA });
    const again = await push(ns, `refs/heads/item/${item.itemId}/haiku`, "by haiku, v2");
    expect(again.result.disposition).toBe("late-new-item");
    expect(again.result.itemId).not.toBe(item.itemId);
    const s = await look(ns);
    expect(s.trains.find((t) => t.train_id === a.decision.trainId)).toMatchObject({ phase: "TESTING", race_id: raceId });
    expect(s.races[0]).toMatchObject({ state: "RACING" });
    expect(trainIdsOf(s.races[0]!)).toContain(a.decision.trainId);
    expect(trainIdsOf(s.races[0]!)).not.toContain(again.decision.trainId);
  });

  it("a candidate that failed while the window is open: re-pushing its branch joins the same race as a new candidate", async () => {
    const { ns, stub } = await externalHive();
    const { item } = await stub.fileWorkItem({ hive: ns, user: ADA, item: { kind: "feature", title: "Haiku endpoint" } });
    const ref = `refs/heads/item/${item.itemId}/haiku`;
    const first = await push(ns, ref, "by haiku");
    await stub.reportTrainResult({ trainId: first.decision.trainId, passed: false, summary: "security: nope" });
    let s = await look(ns);
    expect(s.races[0]).toMatchObject({ state: "RACING" }); // held: another agent (or the same one) may still enter
    expect(s.items.find((i) => i.item_id === item.itemId)).toMatchObject({ status: "ACTIVE" });
    const raceId = String(s.races[0]!.race_id);
    const second = await push(ns, ref, "by haiku, fixed");
    expect(second.result).toMatchObject({ disposition: "joined-race", itemId: item.itemId });
    s = await look(ns);
    expect(s.races).toHaveLength(1);
    expect(String(s.races[0]!.race_id)).toBe(raceId);
    expect(trainIdsOf(s.races[0]!)).toEqual([first.decision.trainId, second.decision.trainId]);
    expect(s.trains.find((t) => t.train_id === second.decision.trainId)).toMatchObject({ phase: "DEPLOYING", race_id: raceId });
  });

  it("close-entries on a race with no entry window (entryWindowMs 0) is a 409", async () => {
    const { ns, stub } = await externalHive({ entryWindowMs: 0 });
    const { item } = await stub.fileWorkItem({ hive: ns, user: ADA, item: { kind: "feature", title: "Haiku endpoint" } });
    await push(ns, `refs/heads/item/${item.itemId}/haiku`, "by haiku");
    const raceId = String((await look(ns)).races[0]!.race_id);
    expect(await rpcError(stub.closeRaceEntries({ hive: ns, raceId, user: ADA }))).toMatch(/^CONFLICT: .*no entry window/);
    expect((await look(ns)).races[0]).toMatchObject({ state: "RACING" });
  });

  it("judge human: two agents pass while entries are open (race stays RACING), closing entries then enters PICKING", async () => {
    const { ns, stub } = await externalHive({ judge: "human" });
    const { item } = await stub.fileWorkItem({ hive: ns, user: ADA, item: { kind: "feature", title: "Haiku endpoint" } });
    const a = await push(ns, `refs/heads/item/${item.itemId}/haiku`, "by haiku");
    const b = await push(ns, `refs/heads/item/${item.itemId}/opus`, "by opus");
    await gatePass(ns, a.decision.trainId);
    await gatePass(ns, b.decision.trainId);
    expect((await look(ns)).races[0]).toMatchObject({ state: "RACING" });
    const raceId = String((await look(ns)).races[0]!.race_id);
    const res = await stub.closeRaceEntries({ hive: ns, raceId, user: ADA });
    expect(res.race.state).toBe("PICKING");
    expect((await look(ns)).events.map((e) => e.type)).toEqual(expect.arrayContaining(["race.entries-closed", "race.picking"]));
  });

  it("the window closing on its own (alarm) decides a passed lone candidate; entryWindowMs 0 decides at once", async () => {
    const { ns, stub } = await externalHive({ entryWindowMs: 60_000 });
    const { item } = await stub.fileWorkItem({ hive: ns, user: ADA, item: { kind: "feature", title: "Haiku endpoint" } });
    const a = await push(ns, `refs/heads/item/${item.itemId}/haiku`, "by haiku");
    await gatePass(ns, a.decision.trainId);
    expect((await look(ns)).races[0]).toMatchObject({ state: "RACING" });
    const alarm = await runInDurableObject(stub, (_q: QueenNode, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    await later(ns, 61_000);
    expect((await look(ns)).races[0]).toMatchObject({ state: "DECIDED" });

    const none = await externalHive({ entryWindowMs: 0 });
    const { item: i2 } = await none.stub.fileWorkItem({ hive: none.ns, user: ADA, item: { kind: "feature", title: "Otter endpoint" } });
    const p = await push(none.ns, `refs/heads/item/${i2.itemId}`, "by ada");
    expect(p.result.messages.some((m) => m.startsWith("race open to entries"))).toBe(false);
    expect((await look(none.ns)).races[0]!.entry_closes_at).toBeNull();
    await gatePass(none.ns, p.decision.trainId);
    expect((await look(none.ns)).races[0]).toMatchObject({ state: "DECIDED" });
  });

  it("a swarm hive's race never gets an entry window", async () => {
    const ns = newHive();
    const stub = stubFor(ns);
    await stub.updateSettings({ hive: ns, user: ADA, patch: { autonomy: "paused" } }); // paused first: the swarm builds nothing, the item waits READY
    const { item } = await stub.fileWorkItem({ hive: ns, user: ADA, item: { kind: "feature", title: "Haiku endpoint" } });
    const p = await push(ns, `refs/heads/item/${item.itemId}`, "by ada");
    expect(p.result.messages.some((m) => m.startsWith("race open to entries"))).toBe(false);
    const races = (await look(ns)).races;
    expect(races).toHaveLength(1);
    expect(races[0]!.entry_closes_at).toBeNull();
  });

  describe("POST /hives/:hive/races/:raceId/close-entries", () => {
    const route = (hive: string, raceId: string, user?: string) =>
      exports.default.fetch(`http://queen.test/hives/${hive}/races/${raceId}/close-entries`, { method: "POST", headers: user === undefined ? {} : { "x-queen-user": user } });

    it("is a user route: 401 without x-queen-user, 404 unknown race, 200 with the updated race, then 409", async () => {
      const { ns, stub } = await externalHive();
      expect((await route(ns, "r1")).status).toBe(401);
      const res404 = await route(ns, "r1", ADA);
      expect(res404.status).toBe(404);
      expect(await res404.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
      const { item } = await stub.fileWorkItem({ hive: ns, user: ADA, item: { kind: "feature", title: "Haiku endpoint" } });
      await push(ns, `refs/heads/item/${item.itemId}/haiku`, "by haiku");
      const raceId = String((await look(ns)).races[0]!.race_id);
      const ok = await route(ns, raceId, ADA);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ outcome: "applied", race: { raceId, state: "RACING" } });
      const again = await route(ns, raceId, ADA);
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ error: { code: "CONFLICT" } });
    });
  });
});

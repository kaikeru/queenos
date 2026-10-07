/**
 * WP2.1 e2e (v2 design §8, Phase 2 row 2.1, acceptance (a)–(j)): the whole
 * decision pipeline under vitest-pool-workers. Most scenarios run the real
 * sim ports (test/worker.ts SimQueenNode: src/sim fakes with fast delays,
 * stepped through the DO alarm); (d) drives the executors by hand with the
 * recording ports so the merge-queue timing is exact.
 */
import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { DeployCommand, DroneTask, Escalation, HiveStatus, ProvisionCommand, QueenEvent, QueenServerMessage, QueueView, SentinelCommand } from "@queenos/queen-types";
import { NotesProjectionSchema, currentVerdict, parseNotes } from "@queenos/queen-types";

type Snapshot = Extract<QueenServerMessage, { type: "snapshot" }>;
import { demoSwarmPrompt } from "../src/sim/sim-v2";
import type { QueenNode } from "../src/queen-node";
import type { RecordingDispatcher, RecordingHerald, RecordingProvisioner, RecordingSentinel } from "./fakes";
import type { SimQueenNode } from "./worker";

const worker = exports.default;
const AUTH = { authorization: "Bearer test-internal-token" };
const newHive = () => `e2e-${crypto.randomUUID().slice(0, 8)}`;
const simNs = () => (env as unknown as { SIM_QUEEN: DurableObjectNamespace<SimQueenNode> }).SIM_QUEEN;
const simStub = (hive: string) => simNs().get(simNs().idFromName(hive));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = Record<string, unknown>;

function rows(stub: DurableObjectStub<SimQueenNode> | DurableObjectStub<QueenNode>, query: string, ...args: (string | number)[]): Promise<Row[]> {
  return runInDurableObject(stub as DurableObjectStub<QueenNode>, (q: QueenNode) => q.sql.exec(query, ...args).toArray() as Row[]);
}

/** Step the sim (alarm-driven fakes) until `done`, or fail after `timeoutMs`. */
async function pump(stub: DurableObjectStub<SimQueenNode>, done: () => Promise<boolean>, timeoutMs = 40_000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await done()) return;
    await runDurableObjectAlarm(stub);
    await sleep(5);
  }
  throw new Error(`pump: timed out waiting for ${what}`);
}

async function items(stub: DurableObjectStub<SimQueenNode>) {
  return (await rows(stub, "SELECT item_id, kind, title, status, parent_id, trace_id, attempts, conflicts, wait_reason, priority, source_kind, landed_at FROM work_items ORDER BY seq")) as {
    item_id: string;
    kind: string;
    title: string;
    status: string;
    parent_id: string | null;
    trace_id: string;
    attempts: number;
    conflicts: number;
    wait_reason: string | null;
    priority: number;
    source_kind: string;
    landed_at: number | null;
  }[];
}

async function settings(stub: DurableObjectStub<SimQueenNode>, patch: Record<string, unknown>, user = "e2e@example.com"): Promise<HiveStatus> {
  return (await stub.updateSettings({ hive: await hiveOf(stub), user, patch })) as HiveStatus;
}

const hives = new WeakMap<object, string>();
async function hiveOf(stub: object): Promise<string> {
  return hives.get(stub)!;
}

function sim(hive: string) {
  const stub = simStub(hive);
  hives.set(stub, hive);
  return stub;
}

const events = async (stub: DurableObjectStub<SimQueenNode>, type: string) =>
  (await rows(stub, "SELECT * FROM event_log WHERE type = ? ORDER BY seq", type)) as unknown as (Row & { item_id: string | null; train_id: string | null; data: string; ts: number; seq: number })[];

describe("(a) a 4-bullet goal fans out, the dependent waits, everything ships, one trace id", () => {
  it("decomposes, dispatches, lands and ships automatically", async () => {
    const hive = newHive();
    const stub = sim(hive);
    const prompt = [
      "- Add a dark theme toggle [hard] [touch:src/lib/theme.js]",
      "- Add a /health JSON endpoint",
      "- Add theme tokens for the status page [touch:src/lib/theme.js]",
      "- Fix the hardcoded footer year (after 2)",
    ].join("\n");
    const { item: goal } = await stub.submitWork({ namespace: hive, promptText: prompt, decompose: true });
    expect(goal).toMatchObject({ kind: "goal", status: "DECOMPOSING" });

    await pump(stub, async () => (await items(stub)).length === 5, 10_000, "children");
    const children = (await items(stub)).filter((i) => i.parent_id === goal.itemId);
    expect(children.map((c) => c.item_id)).toEqual([1, 2, 3, 4].map((n) => `${goal.itemId}-c${n}`));
    // The dependent was filed BLOCKED (waiting on c2) and only went ACTIVE after c2 LANDED.
    const filed = (await events(stub, "item.filed")).find((e) => e.item_id === children[3]!.item_id)!;
    expect(JSON.parse(filed.data).status).toBe("BLOCKED");

    await pump(stub, async () => (await items(stub)).every((i) => i.status === "SHIPPED"), 60_000, "everything SHIPPED");
    const st = await events(stub, "item.status");
    const c2Landed = st.find((e) => e.item_id === children[1]!.item_id && JSON.parse(e.data).to === "LANDED")!;
    const c4Active = st.find((e) => e.item_id === children[3]!.item_id && JSON.parse(e.data).to === "ACTIVE")!;
    expect(c4Active.seq).toBeGreaterThan(c2Landed.seq);
    const releases = await rows(stub, "SELECT phase, tapped_by FROM releases WHERE phase = 'SHIPPED'");
    expect(releases.length).toBeGreaterThan(0);
    expect(releases.every((r) => r.tapped_by === "queen:autonomous")).toBe(true);

    // One trace id across every event about the goal and its children.
    const ids = [goal.itemId, ...children.map((c) => c.item_id)];
    const traces = await rows(stub, `SELECT DISTINCT trace_id FROM event_log WHERE item_id IN (${ids.map(() => "?").join(",")})`, ...ids);
    expect(traces).toEqual([{ trace_id: goal.traceId }]);
    expect(children.every((c) => c.trace_id === goal.traceId)).toBe(true);
  });
});

const buildTrains = async (stub: DurableObjectStub<SimQueenNode>, itemId?: string) =>
  (await rows(
    stub,
    `SELECT train_id, prompt_id, phase, lane, fork_source, created_at, race_id, race_outcome, car_id, reason, action, wait_for_car_seq, members FROM merge_trains WHERE lane = 'BUILD'${itemId ? " AND prompt_id = ?" : ""} ORDER BY seq`,
    ...(itemId ? [itemId] : []),
  )) as {
    train_id: string;
    prompt_id: string;
    phase: string;
    lane: string;
    fork_source: string | null;
    created_at: number;
    race_id: string | null;
    race_outcome: string | null;
    car_id: string | null;
    reason: string | null;
    action: string;
    wait_for_car_seq: number | null;
    members: string | null;
  }[];

const itemStatus = async (stub: DurableObjectStub<SimQueenNode>, itemId: string) => (await items(stub)).find((i) => i.item_id === itemId)?.status;
const landedOrShipped = (s: string | undefined) => s === "LANDED" || s === "SHIPPED";

describe("(b) best-of-3 race", () => {
  it("3 candidates fork from main together; the winner boards a car and lands; the losers are EJECTED", async () => {
    const hive = newHive();
    const stub = sim(hive);
    const { item } = await stub.submitWork({ namespace: hive, promptText: "Add a /features/otter endpoint returning otter facts [race]" });
    expect(item.bestOf).toBe(3);
    const cands = await buildTrains(stub, item.itemId);
    expect(cands).toHaveLength(3);
    expect(new Set(cands.map((c) => c.race_id)).size).toBe(1);
    expect(cands.every((c) => c.fork_source === hive && c.created_at === cands[0]!.created_at)).toBe(true);

    await pump(stub, async () => landedOrShipped(await itemStatus(stub, item.itemId)), 30_000, "race winner landed");
    const [race] = await rows(stub, "SELECT * FROM races WHERE item_id = ?", item.itemId);
    expect(race).toMatchObject({ width: 3, state: "DECIDED" });
    const after = await buildTrains(stub, item.itemId);
    const winner = after.find((t) => t.train_id === race!.winner_train_id)!;
    expect(winner).toMatchObject({ phase: "MERGED", race_outcome: "WON" });
    expect(winner.car_id).toBeTruthy();
    const [car] = await rows(stub, "SELECT phase, lane, members FROM merge_trains WHERE train_id = ?", winner.car_id!);
    expect(car).toMatchObject({ phase: "MERGED", lane: "QUEUE" });
    expect(JSON.parse(String(car!.members))).toEqual([winner.train_id]);
    const losers = after.filter((t) => t !== winner);
    expect(losers.every((t) => t.phase === "EJECTED" && t.race_outcome === "LOST" && t.reason?.startsWith("lost race to"))).toBe(true);
  });
});

describe("(c) parallel builds", () => {
  it("6 independent items: 6 FORKs from main in one apply, ≥ 5 building at once, all land", async () => {
    const hive = newHive();
    const stub = sim(hive);
    const words = ["otter", "falcon", "maple", "comet", "harbor", "lantern"];
    const { item: goal } = await stub.submitWork({ namespace: hive, promptText: words.map((w) => `- Add a /features/${w} endpoint returning ${w} facts`).join("\n"), decompose: true });
    await pump(stub, async () => (await buildTrains(stub)).length >= 6, 10_000, "6 build trains");
    const trains = await buildTrains(stub);
    expect(trains).toHaveLength(6);
    // One decision: the same clock, every fork sourced from hive main.
    expect(new Set(trains.map((t) => t.created_at)).size).toBe(1);
    expect(trains.every((t) => t.fork_source === hive)).toBe(true);
    const enq = (await events(stub, "train.enqueued")).filter((e) => JSON.parse(e.data).lane === "BUILD");
    expect(enq).toHaveLength(6);
    expect(new Set(enq.map((e) => e.ts)).size).toBe(1);
    const forks = await events(stub, "command.issued");
    expect(forks.filter((e) => JSON.parse(e.data).action === "FORK" && e.ts === enq[0]!.ts)).toHaveLength(6);
    await pump(
      stub,
      async () => (await items(stub)).filter((i) => i.parent_id === goal.itemId).every((i) => landedOrShipped(i.status)),
      30_000,
      "all 6 landed",
    );
    // ≥ 5 BUILDING at once: replay the train.phase events in order (no sampling race).
    const building = new Set<string>();
    let peak = 0;
    for (const e of await events(stub, "train.phase")) {
      const d = JSON.parse(e.data) as { from: string; to: string; lane: string };
      if (d.lane !== "BUILD") continue;
      if (d.to === "BUILDING") building.add(e.train_id!);
      else if (d.from === "BUILDING") building.delete(e.train_id!);
      peak = Math.max(peak, building.size);
    }
    expect(peak).toBeGreaterThanOrEqual(5);
  });
});

describe("(c2) a decomposed swarm does not inherit a child's [race] marker", () => {
  it("only the [race] child races best-of-3; the rest dispatch at width 1 and build in parallel", async () => {
    const hive = newHive();
    const stub = sim(hive);
    await settings(stub, { guardrails: { maxActiveTrains: 64, maxChildrenPerItem: 24 } }); // the dev:sim defaults
    const text = demoSwarmPrompt(24);
    const { item: goal } = await stub.submitWork({ namespace: hive, promptText: text, decompose: true });
    expect(goal.bestOf ?? null).toBeNull();
    await pump(stub, async () => (await items(stub)).filter((i) => i.parent_id === goal.itemId).length >= 24, 8_000, "24 children");
    await pump(stub, async () => (await buildTrains(stub)).length >= 22, 8_000, "22+ build trains at once");
    const kids = await rows(stub, "SELECT title, best_of, difficulty FROM work_items WHERE parent_id = ?", goal.itemId);
    expect(kids.filter((k) => k.best_of !== null)).toHaveLength(0);
    const races = await rows(stub, "SELECT r.width, w.title FROM races r JOIN work_items w ON w.item_id = r.item_id");
    for (const r of races) expect(String(r.title)).toContain("[race]");
    expect(races.every((r) => r.width === 3)).toBe(true);
    expect(races).toHaveLength(1);
  });
});

describe("(e) conflict → rework", () => {
  it("a [collide] pair yields one queue.conflict, a REWORK that waits for the car, and both land", async () => {
    const hive = newHive();
    const stub = sim(hive);
    const { item: goal } = await stub.submitWork({
      namespace: hive,
      promptText: "- Add a /features/otter endpoint returning otter facts [collide]\n- Add a /features/falcon endpoint returning falcon facts [collide]",
      decompose: true,
    });
    await pump(
      stub,
      async () => {
        const kids = (await items(stub)).filter((i) => i.parent_id === goal.itemId);
        return kids.length === 2 && kids.every((i) => landedOrShipped(i.status));
      },
      40_000,
      "both collide items landed",
    );
    const conflicts = await events(stub, "queue.conflict");
    expect(conflicts).toHaveLength(1);
    const loser = conflicts[0]!.item_id!;
    const reworks = (await buildTrains(stub, loser)).filter((t) => t.action === "REWORK");
    expect(reworks.length).toBeGreaterThan(0);
    expect(reworks.every((t) => t.wait_for_car_seq !== null)).toBe(true);
    const kids = (await items(stub)).filter((i) => i.parent_id === goal.itemId);
    expect(kids.find((k) => k.item_id === loser)).toMatchObject({ conflicts: 1, attempts: 0 });
  });
});

describe("(f) bisect", () => {
  it("[batch-fail] + 3 others: one queue.bisect, the others land, the culprit is reworked once and lands", async () => {
    const hive = newHive();
    const stub = sim(hive);
    await settings(stub, { guardrails: { maxQueueDepth: 1 } });
    // Hold every car's fork, and the culprit's build, so the culprit boards a car of three behind the others.
    await stub.setHolds({ carForks: true, text: "[batch-fail]" });
    const { item: goal } = await stub.submitWork({
      namespace: hive,
      promptText: [
        "- Add a /features/otter endpoint returning otter facts",
        "- Add a /features/falcon endpoint returning falcon facts",
        "- Add a /features/maple endpoint returning maple facts",
        "- Add a /features/comet endpoint returning comet facts [batch-fail]",
      ].join("\n"),
      decompose: true,
    });
    const culpritId = `${goal.itemId}-c4`;
    const passedOthers = async () => (await buildTrains(stub)).filter((t) => t.prompt_id !== culpritId && t.phase === "PASSED").length === 3;
    await pump(stub, passedOthers, 20_000, "the 3 others passed");
    await stub.setHolds({ text: null });
    await pump(stub, async () => (await buildTrains(stub, culpritId)).some((t) => t.phase === "PASSED"), 20_000, "the culprit passed");
    await stub.setHolds({ carForks: false });
    await pump(
      stub,
      async () => (await items(stub)).filter((i) => i.parent_id === goal.itemId).every((i) => landedOrShipped(i.status)),
      40_000,
      "all 4 landed",
    );
    expect(await events(stub, "queue.bisect")).toHaveLength(1);
    const culprit = (await items(stub)).find((i) => i.item_id === culpritId)!;
    expect(culprit).toMatchObject({ attempts: 1 });
    expect(landedOrShipped(culprit.status)).toBe(true);
    expect((await buildTrains(stub, culpritId)).filter((t) => t.action === "REWORK").length).toBeGreaterThan(0);
  });
});

describe("(g) path affinity", () => {
  it("two items touching src/lib/theme.js: the second waits until the first LANDED", async () => {
    const hive = newHive();
    const stub = sim(hive);
    const { item: goal } = await stub.submitWork({
      namespace: hive,
      promptText: "- Add a theme switcher [touch:src/lib/theme.js]\n- Add theme tokens for the status page [touch:src/lib/theme.js]",
      decompose: true,
    });
    const [c1, c2] = [`${goal.itemId}-c1`, `${goal.itemId}-c2`];
    await pump(stub, async () => landedOrShipped(await itemStatus(stub, c2)), 30_000, "second landed");
    const waits = await events(stub, "affinity.wait");
    expect(waits.map((e) => e.item_id)).toEqual([c2]);
    expect(JSON.parse(waits[0]!.data)).toEqual({ path: "src/lib/theme.js", holder: c1 });
    expect(waits[0]!.summary).toBe(`affinity: src/lib/theme.js held by ${c1}`);
    const status = await events(stub, "item.status");
    const landed1 = status.find((e) => e.item_id === c1 && JSON.parse(e.data).to === "LANDED")!;
    const active2 = status.find((e) => e.item_id === c2 && JSON.parse(e.data).to === "ACTIVE")!;
    expect(active2.seq).toBeGreaterThan(landed1.seq);
  });
});

describe("(h) rollbacks", () => {
  it("[canary-fail] rolls back, files a P0 bug that is dispatched; a second rollback degrades to supervised with ROLLBACK_STREAK", async () => {
    const hive = newHive();
    const stub = sim(hive);
    await stub.submitWork({ namespace: hive, promptText: "Add a /features/otter endpoint returning otter facts [canary-fail]" });
    const openStreak = async () =>
      (await rows(stub, "SELECT * FROM escalations WHERE reason = 'ROLLBACK_STREAK' AND status = 'OPEN'")).length === 1;
    await pump(stub, openStreak, 60_000, "ROLLBACK_STREAK");
    const rolled = await rows(stub, "SELECT release_id FROM releases WHERE phase = 'ROLLED_BACK' ORDER BY seq");
    expect(rolled.length).toBeGreaterThanOrEqual(2);
    const bugs = (await items(stub)).filter((i) => i.source_kind === "queen");
    expect(bugs.length).toBeGreaterThanOrEqual(1);
    expect(bugs[0]).toMatchObject({ kind: "bug", priority: 0 });
    // The P0 bug was dispatched: it has a prompt run (and trains).
    expect(await rows(stub, "SELECT prompt_id FROM prompt_runs WHERE prompt_id = ?", bugs[0]!.item_id)).toHaveLength(1);
    const status = ((await stub.getSnapshot()) as unknown as Snapshot).hive!;
    expect(status).toMatchObject({ effectiveAutonomy: "supervised" });
    expect(status.degradedBy).toContain("ROLLBACK_STREAK");
    expect(status.headline).toBe("NEEDS_YOU");
    expect(status.mode).toBe("sim");
  });
});

describe("(i) supervised hive", () => {
  it("parks at AWAITING_TAP with APPROVAL_REQUIRED; resolving with ship starts the canary", async () => {
    const hive = newHive();
    const stub = sim(hive);
    await settings(stub, { autonomy: "supervised" });
    await stub.submitWork({ namespace: hive, promptText: "Add a /features/otter endpoint returning otter facts" });
    const approval = async () => (await rows(stub, "SELECT escalation_id FROM escalations WHERE reason = 'APPROVAL_REQUIRED' AND status = 'OPEN'"))[0];
    await pump(stub, async () => !!(await approval()), 30_000, "APPROVAL_REQUIRED");
    const [rel] = await rows(stub, "SELECT release_id, phase FROM releases WHERE phase = 'AWAITING_TAP'");
    expect(rel).toBeDefined();
    const id = String((await approval())!.escalation_id);
    const res = (await stub.resolveEscalation({ hive, escalationId: id, user: "kyle@kaikeru.com", action: { action: "ship" } })) as { outcome: string; escalation: Escalation };
    expect(res).toMatchObject({ outcome: "applied", escalation: { status: "RESOLVED", resolvedBy: "kyle@kaikeru.com" } });
    const [after] = await rows(stub, "SELECT phase, tapped_by FROM releases WHERE release_id = ?", String(rel!.release_id));
    expect(after).toMatchObject({ phase: "CANARY", tapped_by: "kyle@kaikeru.com" });
    await pump(stub, async () => (await rows(stub, "SELECT 1 FROM releases WHERE release_id = ? AND phase = 'SHIPPED'", String(rel!.release_id))).length === 1, 30_000, "SHIPPED");
  });
});

describe("(j) budget", () => {
  it("an exhausted daily budget stops dispatch and escalates; raise_budget resumes it", async () => {
    const hive = newHive();
    const stub = sim(hive);
    await settings(stub, { budget: { dailyDispatches: 1 } });
    const { item: a } = await stub.submitWork({ namespace: hive, promptText: "Add a /features/otter endpoint" });
    const { item: b } = await stub.submitWork({ namespace: hive, promptText: "Add a /features/falcon endpoint" });
    expect(await itemStatus(stub, a.itemId)).toBe("ACTIVE");
    expect((await items(stub)).find((i) => i.item_id === b.itemId)).toMatchObject({ status: "READY", wait_reason: "budget" });
    expect(await buildTrains(stub, b.itemId)).toHaveLength(0);
    const [esc] = await rows(stub, "SELECT escalation_id FROM escalations WHERE reason = 'BUDGET_EXHAUSTED' AND status = 'OPEN'");
    expect(esc).toBeDefined();
    expect(((await stub.getSnapshot()) as unknown as Snapshot).hive).toMatchObject({ headline: "NEEDS_YOU" });

    await stub.resolveEscalation({ hive, escalationId: String(esc!.escalation_id), user: "kyle@kaikeru.com", action: { action: "raise_budget" } });
    expect(await itemStatus(stub, b.itemId)).toBe("ACTIVE");
    expect((await buildTrains(stub, b.itemId)).length).toBeGreaterThan(0);
  });
});

describe("(l) sim: pushed code is gated by the Queen-started gate", () => {
  it("a push parked behind a paused hive (far past the push gate's patience) is gated once it reaches TESTING, then lands; [fail] is rejected", async () => {
    const hive = newHive();
    const stub = sim(hive);
    await settings(stub, { autonomy: "paused" });
    const intake = async (ref: string, title: string) => {
      const head = crypto.randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40);
      const d = await stub.gitIntent({ hive, user: "ada@example.com", ref, oldSha: "0".repeat(40), newSha: head });
      if (d.verdict !== "accept") throw new Error("refused");
      const r = await stub.gitPushed({ hive, trainId: d.trainId, repo: d.repo, ref, headSha: head, baseSha: "f".repeat(40), title, message: title, trailers: {} });
      return { ...d, head, itemId: r.itemId };
    };
    const ok = await intake("refs/heads/tip-jar", "Add a tip jar");
    const bad = await intake("refs/heads/broken", "Add a broken thing [fail]");
    await settings(stub, { autonomy: "autonomous" });
    await pump(stub, async () => (await items(stub)).find((i) => i.item_id === ok.itemId)?.status === "SHIPPED", 40_000, "the pushed item to ship");
    expect(await itemStatus(stub, bad.itemId)).toBe("FAILED");
    const gated = (await rows(stub, "SELECT train_id, gate_command_id FROM merge_trains WHERE train_id IN (?, ?)", ok.trainId, bad.trainId)) as { train_id: string; gate_command_id: string | null }[];
    expect(gated.every((t) => /-q1$/.test(t.gate_command_id ?? ""))).toBe(true);
    const audits = await rows(stub, "SELECT train_id FROM event_log WHERE type = 'drone.audit' AND item_id = ?", bad.itemId);
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.every((a) => a.train_id === bad.trainId)).toBe(true);
  });
});

describe("(d) merge-queue batching", () => {
  const stubFor = (ns: string) => env.QUEEN_NODE.get(env.QUEEN_NODE.idFromName(ns));
  const post = (ns: string, path: string, body: unknown) =>
    worker.fetch(`http://queen.test/hives/${ns}${path}`, { method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: JSON.stringify(body) });
  const ports = (ns: string) =>
    runInDurableObject(stubFor(ns), (q: QueenNode) => ({
      provisions: (q.ports.provisioner as RecordingProvisioner).commands.map((c) => ({ ...c })) as ProvisionCommand[],
      deploys: (q.ports.herald as RecordingHerald).commands.map((c) => ({ ...c })),
      tasks: (q.ports.dispatcher as RecordingDispatcher).tasks.map((t) => ({ ...t })) as DroneTask[],
      trains: q.sql.exec("SELECT train_id, prompt_id, phase, lane, car_id, members, passed_seq FROM merge_trains ORDER BY seq").toArray() as Row[],
    }));
  /** Report every new FORK and preview DEPLOY as ok. */
  async function settle(ns: string, seen: Set<string>) {
    for (let round = 0; round < 10; round++) {
      const s = await ports(ns);
      let progressed = false;
      for (const c of s.provisions) {
        if (c.op !== "FORK" || seen.has(c.commandId)) continue;
        seen.add(c.commandId);
        progressed = true;
        await post(ns, "/internal/webhook/provision-result", { commandId: c.commandId, op: "FORK", trainId: c.trainId, ok: true, artifactRepo: c.forkName, baseSha: "a".repeat(40) });
      }
      for (const c of s.deploys) {
        if (c.op !== "DEPLOY" || c.environment !== "preview" || seen.has(c.commandId)) continue;
        seen.add(c.commandId);
        progressed = true;
        await post(ns, "/internal/webhook/deploy-result", { commandId: c.commandId, op: "DEPLOY", environment: "preview", trainId: c.trainId, ok: true, url: `https://${c.trainId}.test.dev` });
      }
      if (!progressed) return;
    }
  }

  it("with maxQueueDepth cars in flight, 4 more passed builds wait, then board ONE car: one LANDER push, 4 items LANDED", async () => {
    const ns = newHive();
    const stub = stubFor(ns);
    await stub.updateSettings({ hive: ns, user: "e2e@example.com", patch: { guardrails: { maxQueueDepth: 1, maxQueueBatch: 4 } } });
    const ids: string[] = [];
    for (const w of ["otter", "falcon", "maple", "comet", "harbor"]) ids.push((await stub.submitWork({ namespace: ns, promptText: `Add /features/${w}` })).item.itemId);
    const seen = new Set<string>();
    await settle(ns, seen);
    const builds = (await ports(ns)).trains.filter((t) => t.lane === "BUILD");
    expect(builds).toHaveLength(5);
    for (const t of builds) await post(ns, "/internal/webhook/build-result", { trainId: t.train_id, headSha: `${"1".repeat(39)}${ids.indexOf(String(t.prompt_id))}` });
    await settle(ns, seen);
    // The first pass forms car K1 (depth 1 is now full); the next 4 passes wait to board.
    for (const t of builds) await post(ns, "/internal/webhook/train-result", { trainId: t.train_id, passed: true, summary: "green" });
    let s = await ports(ns);
    const cars = s.trains.filter((t) => t.lane === "QUEUE");
    expect(cars).toHaveLength(1);
    const k1 = String(cars[0]!.train_id);
    expect(JSON.parse(String(cars[0]!.members))).toEqual([builds[0]!.train_id]);
    expect(s.trains.filter((t) => t.lane === "BUILD" && t.phase === "PASSED" && t.car_id === null)).toHaveLength(4);
    expect(((await stub.getQueue()) as unknown as QueueView).waiting).toHaveLength(4);

    // K1: fork → MERGE (fast path) → LANDER → MERGED. The slot frees: K2 boards all 4.
    await settle(ns, seen);
    await post(ns, "/internal/webhook/merge-result", { trainId: k1, ok: true, headSha: "c".repeat(40), merged: [builds[0]!.train_id], fastForward: true });
    await post(ns, "/internal/webhook/land-result", { trainId: k1, landed: true, mainSha: "d".repeat(40) });
    s = await ports(ns);
    const k2row = s.trains.find((t) => t.lane === "QUEUE" && t.train_id !== k1)!;
    const k2 = String(k2row.train_id);
    const members = builds.slice(1).map((t) => t.train_id);
    expect(JSON.parse(String(k2row.members))).toEqual(members);

    // K2: fork → MERGE (4 merged, not fast) → preview → integration gate → one LANDER push.
    await settle(ns, seen);
    expect(s.tasks.length).toBeGreaterThan(0);
    const mr = await post(ns, "/internal/webhook/merge-result", { trainId: k2, ok: true, headSha: "e".repeat(40), baseSha: "d".repeat(40), merged: members, fastForward: false });
    expect(await mr.json()).toMatchObject({ outcome: "applied", train: { phase: "DEPLOYING" } });
    await settle(ns, seen);
    await post(ns, "/internal/webhook/train-result", { trainId: k2, passed: true, summary: "integration green" });
    s = await ports(ns);
    const lands = s.tasks.filter((t) => t.action === "LAND" && t.trainId === k2);
    expect(lands).toHaveLength(1);
    expect(lands[0]!.members!.map((m) => m.trainId)).toEqual(members);
    await post(ns, "/internal/webhook/land-result", { trainId: k2, landed: true, mainSha: "f".repeat(40) });

    const status = await runInDurableObject(stub, (q: QueenNode) => q.sql.exec("SELECT item_id, status FROM work_items ORDER BY seq").toArray());
    expect(status.map((r) => r.status)).toEqual(["LANDED", "LANDED", "LANDED", "LANDED", "LANDED"]);
    const landed = (await stub.queryEvents({ typePrefix: "queue.landed" })) as QueenEvent[];
    expect(landed.map((e) => e.trainId)).toContain(k2);
    // Every car member's release: one release carries all five members.
    const [rel] = await runInDurableObject(stub, (q: QueenNode) => q.sql.exec("SELECT train_ids FROM releases ORDER BY seq DESC LIMIT 1").toArray());
    expect(JSON.parse(String(rel!.train_ids))).toEqual(builds.map((t) => t.train_id));
  });
});

// ── T1: git intake (human-push design rev 2 §12 acceptance 1–8): recording ports, executors played by hand ──

describe("(k) git intake: gitIntent → gitPushed → the same pipeline as a drone build", () => {
  const stubFor = (ns: string) => env.QUEEN_NODE.get(env.QUEEN_NODE.idFromName(ns));
  const USER = "ada@example.com";
  let shaN = 0;
  const sha = () => (++shaN).toString(16).padStart(40, "0");
  const verdict = (c: SentinelCommand) => ({
    commandId: c.commandId,
    releaseId: c.releaseId,
    environment: c.environment,
    verdict: "PROMOTE" as const,
    metrics: { requests: 320, errorRate: 0, p99Ms: 40, baselineErrorRate: null },
    summary: "healthy",
  });

  type TrainRow = { train_id: string; prompt_id: string; phase: string; lane: string; head_sha: string | null; artifact_repo: string; action: string; origin_json: string | null; fork_state: string; race_id: string | null; reason: string | null; car_id: string | null; base_sha: string };
  const look = (ns: string) =>
    runInDurableObject(stubFor(ns), (q: QueenNode) => ({
      provisions: (q.ports.provisioner as RecordingProvisioner).commands.map((c) => ({ ...c })) as ProvisionCommand[],
      deploys: (q.ports.herald as RecordingHerald).commands.map((c) => ({ ...c })) as DeployCommand[],
      sentinels: (q.ports.sentinel as RecordingSentinel).commands.map((c) => ({ ...c })) as SentinelCommand[],
      tasks: (q.ports.dispatcher as RecordingDispatcher).tasks.map((t) => ({ ...t })) as DroneTask[],
      instanceIds: [...(q.ports.dispatcher as RecordingDispatcher).instanceIds],
      trains: q.sql.exec("SELECT * FROM merge_trains ORDER BY seq").toArray() as unknown as TrainRow[],
      items: q.sql.exec("SELECT item_id, status, attempts, blocked_reason, wait_reason, title, parent_id, source_kind, inbox_json FROM work_items ORDER BY seq").toArray() as Row[],
      escalations: q.sql.exec("SELECT reason, subject_id, status FROM escalations").toArray() as Row[],
      submissions: q.sql.exec("SELECT * FROM submissions ORDER BY created_at, rowid").toArray() as Row[],
    }));

  /**
   * Play every executor: forks (a seeded fork's base is the head it forks from), deletes, preview and
   * release deploys, Sentinel, builders, MERGE and LANDER drones; gate every BUILD train / car that is
   * TESTING (`gate(trainId)` false = reject). Loops until nothing new happens.
   */
  async function drive(ns: string, seen: Set<string>, gate: (t: TrainRow) => boolean = () => true, beforeGates?: (testing: TrainRow[]) => Promise<void>): Promise<void> {
    const stub = stubFor(ns);
    for (let round = 0; round < 40; round++) {
      const s = await look(ns);
      let progressed = false;
      const once = (key: string) => (seen.has(key) ? false : (seen.add(key), (progressed = true)));
      for (const c of s.provisions) {
        if (!once(c.commandId)) continue;
        if (c.op === "FORK") {
          const seed = c.from ? s.trains.find((t) => t.artifact_repo === c.from)?.head_sha : null;
          await stub.reportProvisionResult({ commandId: c.commandId, op: "FORK", trainId: c.trainId, ok: true, artifactRepo: c.forkName, baseSha: seed ?? "f".repeat(40) });
        } else if (c.op === "DELETE") {
          await stub.reportProvisionResult({ commandId: c.commandId, op: "DELETE", trainId: c.trainId, ok: true });
        }
      }
      for (const c of s.deploys) {
        if (!once(c.commandId)) continue;
        if (c.op === "DEPLOY" && c.environment === "preview") {
          await stub.reportDeployResult({ commandId: c.commandId, op: "DEPLOY", environment: "preview", trainId: c.trainId, ok: true, url: `https://${c.trainId}.test.dev`, commitSha: c.commitSha });
        } else if (c.op === "DEPLOY") {
          await stub.reportDeployResult({ commandId: c.commandId, op: "DEPLOY", environment: c.environment, releaseId: c.releaseId, ok: true, url: `https://${ns}-${c.environment}.test.dev`, versionId: `v-${c.commandId}`, ...(c.percent ? { percent: c.percent } : {}) });
        } else if (c.op === "TEARDOWN") {
          await stub.reportDeployResult({ commandId: c.commandId, op: "TEARDOWN", environment: "preview", trainId: c.trainId, ok: true });
        }
      }
      for (const c of s.sentinels) if (once(c.commandId)) await stub.reportSentinelVerdict(verdict(c));
      for (let i = 0; i < s.tasks.length; i++) {
        const task = s.tasks[i]!;
        if (!once(`drone:${s.instanceIds[i]}`)) continue;
        const t = s.trains.find((x) => x.train_id === task.trainId);
        if (task.action === "BUILD" || task.action === "REWORK") await stub.reportBuildResult({ trainId: task.trainId, headSha: sha() });
        else if (task.action === "MERGE") {
          const members = (task.members ?? []).map((m) => m.trainId);
          await stub.reportMergeResult({ trainId: task.trainId, ok: true, headSha: sha(), baseSha: t?.base_sha || "f".repeat(40), merged: members, fastForward: members.length === 1 });
        } else if (task.action === "LAND") await stub.reportLandResult({ trainId: task.trainId, landed: true, mainSha: sha() });
      }
      const testing = (await look(ns)).trains.filter((t) => t.phase === "TESTING" && !seen.has(`gate:${t.train_id}`));
      if (testing.length && beforeGates) await beforeGates(testing);
      for (const t of testing) {
        if (!once(`gate:${t.train_id}`)) continue;
        const pass = t.lane === "QUEUE" || gate(t);
        await stub.reportTrainResult({ trainId: t.train_id, passed: pass, summary: pass ? "all gates green" : "REVIEWER rejected the change" });
      }
      if (!progressed) return;
    }
  }

  async function push(ns: string, ref: string, message: string, opts: { user?: string; head?: string } = {}) {
    const stub = stubFor(ns);
    const head = opts.head ?? sha();
    const decision = await stub.gitIntent({ hive: ns, user: opts.user ?? USER, ref, oldSha: "0".repeat(40), newSha: head });
    if (decision.verdict !== "accept") return { decision, head, result: null };
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

  async function rpcError(p: Promise<unknown>): Promise<string | null> {
    try {
      await p;
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  it("1. an uncorrelated push: a new item (filed, no race), DEPLOYING → gate → car → LANDED → SHIPPED; notesFor shows PASSED, LANDED, SHIPPED", async () => {
    const ns = newHive();
    const stub = stubFor(ns);
    const { decision, head, result } = await push(ns, "refs/heads/tip-jar", "Add a tip jar at /features/tip-jar\n\nAcceptance:\n- shows a jar");
    expect(decision).toMatchObject({ verdict: "accept", repo: `${ns}-train-${decision.verdict === "accept" ? decision.trainId.replace(/-/g, "").slice(0, 12) : ""}` });
    if (decision.verdict !== "accept") throw new Error("refused");
    expect(result!.disposition).toBe("filed");
    expect(result!.messages[0]).toBe(`submission received → item ${result!.itemId} "Add a tip jar at /features/tip-jar" (new item, fully gated)`);
    expect(result!.messages).toContain("git fetch origin '+refs/notes/*:refs/notes/*' && git log --notes=verdict -1");
    let s = await look(ns);
    const t = s.trains.find((x) => x.train_id === decision.trainId)!;
    expect(t).toMatchObject({ phase: "DEPLOYING", fork_state: "READY", head_sha: head, base_sha: "f".repeat(40), race_id: null, prompt_id: result!.itemId });
    expect(JSON.parse(t.origin_json!)).toEqual({ kind: "human", id: USER });
    expect(s.provisions.filter((c) => c.op === "FORK")).toEqual([]); // the proxy forked, not the Provisioner
    expect(s.tasks).toEqual([]); // no builder
    expect(s.items).toEqual([expect.objectContaining({ item_id: result!.itemId, status: "ACTIVE", source_kind: "user", title: "Add a tip jar at /features/tip-jar" })]);
    expect(JSON.parse(String(s.items[0]!.inbox_json))).toMatchObject({ repo: decision.repo, ref: "refs/heads/tip-jar", handle: "ada", headSha: head, handoff: false });
    expect(s.submissions).toEqual([expect.objectContaining({ repo: decision.repo, head_sha: head, outcome: "applied", disposition: "filed", item_id: result!.itemId, train_id: decision.trainId, origin_id: USER })]);
    // The gatekeepers see whose code it is and the diff base.
    expect(await stub.getGateTarget(decision.repo)).toMatchObject({ trainId: decision.trainId, lane: "BUILD", origin: { kind: "human", id: USER }, baseSha: "f".repeat(40) });
    // A repeat of gitPushed is idempotent.
    expect(await stub.gitPushed({ hive: ns, trainId: decision.trainId, repo: decision.repo, ref: "refs/heads/tip-jar", headSha: head, baseSha: "f".repeat(40), title: "x", message: "x", trailers: {} })).toMatchObject({
      disposition: "filed",
      itemId: result!.itemId,
    });

    await drive(ns, new Set());
    s = await look(ns);
    expect(s.items[0]).toMatchObject({ status: "SHIPPED" });
    const notes = await stub.notesFor(ns, "refs/notes/verdict");
    expect(notes.version).toBeGreaterThan(0);
    const note = notes.notes.find((n) => n.sha === head)!;
    const entries = parseNotes(note.text, { ref: "refs/notes/verdict" });
    expect(entries.map((e) => e.summary.split(/[: ]/)[0])).toEqual(["PASSED", "LANDED", "SHIPPED"]);
    expect(entries.map((e) => e.verdict)).toEqual(["PASSED", "LANDED", undefined]);
    expect(entries[0]).toMatchObject({ itemId: result!.itemId, trainId: decision.trainId, origin: `human:${USER}` });
    expect(currentVerdict(entries)).toBe("LANDED");
    expect(NotesProjectionSchema.safeParse(notes).success).toBe(true);
    expect(await rpcError(Promise.resolve().then(() => stub.notesFor(ns, "refs/notes/queen")))).toMatch(/INVALID_INPUT/);
  });

  it("2–3. a rejected push: FAILED awaiting contributor (no REWORK, no escalation, fork kept); handoff → REWORK from the kept fork, brief = the note; it lands and replies to the rejected sha", async () => {
    const ns = newHive();
    const stub = stubFor(ns);
    const { decision, head, result } = await push(ns, "refs/heads/tip-jar", "Add a tip jar");
    if (decision.verdict !== "accept") throw new Error("refused");
    const seen = new Set<string>();
    await drive(ns, seen, () => false);
    let s = await look(ns);
    expect(s.items[0]).toMatchObject({ item_id: result!.itemId, status: "FAILED", blocked_reason: "awaiting contributor", attempts: 0 });
    expect(s.escalations).toEqual([]);
    expect(s.trains.filter((t) => t.lane === "BUILD")).toHaveLength(1); // no REWORK
    const rejected = s.trains.find((t) => t.train_id === decision.trainId)!;
    expect(rejected).toMatchObject({ phase: "EJECTED", fork_state: "READY" }); // kept for a handoff
    expect(s.provisions.filter((c) => c.op === "DELETE")).toEqual([]);
    const before = (await stub.notesFor(ns, "refs/notes/verdict")).notes.find((n) => n.sha === head)!;
    expect(parseNotes(before.text)[0]).toMatchObject({ verdict: "REJECTED", summary: "REJECTED by GATE: REVIEWER rejected the change" });
    expect(parseNotes(before.text)[0]!.body).toMatch(/^Push a fix to tip-jar, or hand off/);

    // Handoff (the dashboard's "Let the swarm fix it").
    const handed = await stub.workAction({ hive: ns, itemId: result!.itemId, user: USER, action: { action: "handoff" } });
    expect(handed).toMatchObject({ outcome: "applied", item: { status: "ACTIVE", inbox: { handoff: true } } });
    s = await look(ns);
    const fork = s.provisions.find((c): c is Extract<ProvisionCommand, { op: "FORK" }> => c.op === "FORK")!;
    expect(fork).toMatchObject({ sourceRepo: ns, from: decision.repo });
    await stub.reportProvisionResult({ commandId: fork.commandId, op: "FORK", trainId: fork.trainId, ok: true, artifactRepo: fork.forkName, baseSha: head });
    seen.add(fork.commandId);
    s = await look(ns);
    const task = s.tasks.find((x) => x.action === "REWORK")!;
    expect(task.seed).toEqual({ repo: decision.repo, ref: "refs/heads/main", headSha: head });
    // The brief is byte-identical to the verdict note `git log --notes=verdict` shows on the rejected commit.
    const note = (await stub.notesFor(ns, "refs/notes/verdict")).notes.find((n) => n.sha === head)!;
    expect(task.brief).toBe(note.text);
    expect(task.brief).toBe(before.text);

    await drive(ns, seen);
    s = await look(ns);
    expect(s.items[0]!.status).toBe("SHIPPED");
    const rework = s.trains.find((t) => t.action === "REWORK")!;
    const reworkNote = (await stub.notesFor(ns, "refs/notes/verdict")).notes.find((n) => n.sha === rework.head_sha)!;
    expect(parseNotes(reworkNote.text).every((e) => e.repliesTo === head)).toBe(true);
    // The kept fork is released once the item left FAILED and the rework is done (alarm).
    await runInDurableObject(stub, (q: QueenNode) => q.alarm());
    expect((await look(ns)).provisions.some((c) => c.op === "DELETE" && c.repo === decision.repo)).toBe(true);
    // A second handoff on a non-FAILED item is a 409.
    expect(await rpcError(stub.workAction({ hive: ns, itemId: result!.itemId, user: USER, action: { action: "handoff" } }))).toMatch(/CONFLICT/);
  });

  it("4. `Queen: rework` in the head commit hands off automatically on a reject", async () => {
    const ns = newHive();
    const { decision, head, result } = await push(ns, "refs/heads/fix", "Fix the footer\n\nQueen: rework");
    if (decision.verdict !== "accept") throw new Error("refused");
    expect(result!.messages.some((m) => m.startsWith("Queen: rework"))).toBe(true);
    const seen = new Set<string>();
    await drive(ns, seen, (t) => t.train_id !== decision.trainId);
    const s = await look(ns);
    const rework = s.trains.find((t) => t.action === "REWORK")!;
    expect(rework).toBeDefined();
    expect(s.provisions.find((c) => c.op === "FORK" && c.trainId === rework.train_id)).toMatchObject({ from: decision.repo });
    expect(s.tasks.find((t) => t.action === "REWORK")).toMatchObject({ seed: { headSha: head } });
    expect(s.items[0]).toMatchObject({ item_id: result!.itemId, status: "SHIPPED", attempts: 1 });
    expect(s.escalations).toEqual([]);
  });

  it("5. a re-push before boarding supersedes (old train EJECTED, no attempt, one item); after boarding it files a follow-up item", async () => {
    const ns = newHive();
    const stub = stubFor(ns);
    const first = await push(ns, "refs/heads/tip-jar", "Add a tip jar");
    const second = await push(ns, "refs/heads/tip-jar", "Add a tip jar (v2)");
    if (first.decision.verdict !== "accept" || second.decision.verdict !== "accept") throw new Error("refused");
    const d1 = first.decision;
    const d2 = second.decision;
    expect(second.result).toMatchObject({ disposition: "superseded", itemId: first.result!.itemId });
    expect(second.result!.messages[0]).toBe(`replaces your earlier push ${first.head.slice(0, 7)} (train ${d1.trainId})`);
    let s = await look(ns);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ attempts: 0, status: "ACTIVE" });
    expect(s.trains.find((t) => t.train_id === d1.trainId)).toMatchObject({ phase: "EJECTED", reason: `superseded by push ${second.head.slice(0, 7)}` });
    expect(s.provisions.some((c) => c.op === "DELETE" && c.repo === d1.repo)).toBe(true);
    const sup = parseNotes((await stub.notesFor(ns, "refs/notes/verdict")).notes.find((n) => n.sha === first.head)!.text);
    expect(sup[0]).toMatchObject({ verdict: "SUPERSEDED" });

    // Pass the second one; it boards a car (stop before it lands).
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      s = await look(ns);
      for (const c of s.deploys) if (c.op === "DEPLOY" && c.environment === "preview" && !seen.has(c.commandId)) {
        seen.add(c.commandId);
        await stub.reportDeployResult({ commandId: c.commandId, op: "DEPLOY", environment: "preview", trainId: c.trainId, ok: true, url: `https://${c.trainId}.test.dev` });
      }
    }
    await stub.reportTrainResult({ trainId: d2.trainId, passed: true, summary: "green" });
    s = await look(ns);
    expect(s.trains.find((t) => t.train_id === d2.trainId)!.car_id).not.toBeNull();
    const third = await push(ns, "refs/heads/tip-jar", "Add a tip jar (v3)");
    expect(third.result).toMatchObject({ disposition: "late-new-item" });
    expect(third.result!.itemId).not.toBe(first.result!.itemId);
    s = await look(ns);
    expect(s.items.map((i) => i.title)).toEqual(["Add a tip jar", "Add a tip jar (follow-up)"]);
    expect(s.trains.find((t) => t.train_id === d2.trainId)!.phase).not.toBe("EJECTED");
  });

  it("6. refusals at push time: duplicate head, unknown item, over cap (a 4th open item); a late item/<id> is accepted as late-new-item; paused accepts and waits READY", async () => {
    const ns = newHive();
    const stub = stubFor(ns);
    const a = await push(ns, "refs/heads/a", "A");
    const dup = await stub.gitIntent({ hive: ns, user: USER, ref: "refs/heads/other", oldSha: "0".repeat(40), newSha: a.head });
    expect(dup).toMatchObject({ verdict: "refuse", reason: `already submitted as item ${a.result!.itemId} (train ${a.decision.verdict === "accept" ? a.decision.trainId : ""})` });
    expect(await stub.gitIntent({ hive: ns, user: USER, ref: "refs/heads/item/nope", oldSha: "0".repeat(40), newSha: sha() })).toMatchObject({ verdict: "refuse", reason: "no item nope in this hive" });
    expect(await stub.gitIntent({ hive: ns, user: USER, ref: "refs/heads/main", oldSha: "0".repeat(40), newSha: sha() })).toMatchObject({ verdict: "refuse" });
    await push(ns, "refs/heads/b", "B");
    await push(ns, "refs/heads/c", "C");
    const capped = await stub.gitIntent({ hive: ns, user: USER, ref: "refs/heads/d", oldSha: "0".repeat(40), newSha: sha() });
    expect(capped).toMatchObject({ verdict: "refuse", reason: "over cap: 3 open items; wait for a verdict", messages: ["push refused: over cap: 3 open items; wait for a verdict"] });
    // Another contributor is not capped by ada's items.
    expect((await push(ns, "refs/heads/d", "D", { user: "bob@example.com" })).decision.verdict).toBe("accept");
    let s = await look(ns);
    expect(s.submissions.filter((r) => String(r.outcome).startsWith("refused:")).map((r) => r.outcome)).toEqual(["refused:duplicate", "refused:unknown-item", "refused:rule", "refused:over-cap"]);

    // A landed item: item/<id> is late → a follow-up item (bob has room).
    await drive(ns, new Set());
    const landed = (await look(ns)).items.find((i) => i.title === "A")!;
    expect(["LANDED", "SHIPPED"]).toContain(landed.status);
    const late = await push(ns, `refs/heads/item/${landed.item_id}`, "More A", { user: "bob@example.com" });
    expect(late.result).toMatchObject({ disposition: "late-new-item" });
    expect(late.result!.messages[0]).toMatch(new RegExp(`^item ${landed.item_id} is (landed|shipped); filed follow-up item ${late.result!.itemId}$`));

    // Paused: accepted, the item waits READY ("paused") with its push parked; it resumes when the hive does.
    await stub.updateSettings({ hive: ns, user: USER, patch: { autonomy: "paused" } });
    const p = await push(ns, "refs/heads/p", "Paused push", { user: "cy@example.com" });
    expect(p.decision).toMatchObject({ verdict: "accept", messages: ["queued: hive paused (your submission waits until it resumes)"] });
    expect(p.result!.messages).toContain("queued: paused");
    s = await look(ns);
    expect(s.items.find((i) => i.item_id === p.result!.itemId)).toMatchObject({ status: "READY", wait_reason: "paused" });
    const parked = s.trains.find((t) => t.prompt_id === p.result!.itemId)!;
    expect(parked).toMatchObject({ phase: "BUILDING", fork_state: "READY" });
    await stub.updateSettings({ hive: ns, user: USER, patch: { autonomy: "autonomous" } });
    s = await look(ns);
    expect(s.items.find((i) => i.item_id === p.result!.itemId)!.status).toBe("ACTIVE");
    expect(s.trains.find((t) => t.train_id === parked.train_id)!.phase).toBe("DEPLOYING");
    expect(s.trains.filter((t) => t.prompt_id === p.result!.itemId)).toHaveLength(1);
  });

  it("6b. a correlated push joins the item: a width-1 race for a READY item, or a drone race as one more candidate", async () => {
    const ns = newHive();
    const stub = stubFor(ns);
    await stub.updateSettings({ hive: ns, user: USER, patch: { autonomy: "paused" } });
    const { item } = await stub.fileWorkItem({ hive: ns, user: USER, item: { kind: "feature", title: "Dark mode" } });
    const j = await push(ns, `refs/heads/item/${item.itemId}`, "My dark mode");
    expect(j.result).toMatchObject({ disposition: "joined-race", itemId: item.itemId });
    expect(j.result!.messages[0]).toBe(`submission received → item ${item.itemId} "Dark mode" (joined its race)`);
    let races = await runInDurableObject(stub, (q: QueenNode) => q.sql.exec("SELECT * FROM races").toArray());
    expect(races).toHaveLength(1);
    expect(races[0]).toMatchObject({ item_id: item.itemId, width: 1, state: "RACING" });

    // A drone best-of-2 race: a push to the ACTIVE item enters it as a third candidate.
    await stub.updateSettings({ hive: ns, user: USER, patch: { autonomy: "autonomous" } });
    const { item: raced } = await stub.fileWorkItem({ hive: ns, user: USER, item: { kind: "feature", title: "Race me", bestOf: 2 } });
    const seen = new Set<string>();
    races = await runInDurableObject(stub, (q: QueenNode) => q.sql.exec("SELECT * FROM races WHERE item_id = ?", raced.itemId).toArray());
    expect(JSON.parse(String(races[0]!.train_ids))).toHaveLength(2);
    const k = await push(ns, `refs/heads/item/${raced.itemId}`, "Mine is better", { user: "bob@example.com" });
    expect(k.result).toMatchObject({ disposition: "joined-race", itemId: raced.itemId });
    races = await runInDurableObject(stub, (q: QueenNode) => q.sql.exec("SELECT * FROM races WHERE item_id = ?", raced.itemId).toArray());
    expect(races[0]).toMatchObject({ width: 2, state: "RACING" });
    expect(JSON.parse(String(races[0]!.train_ids))).toHaveLength(3);
    await drive(ns, seen);
    races = await runInDurableObject(stub, (q: QueenNode) => q.sql.exec("SELECT * FROM races WHERE item_id = ?", raced.itemId).toArray());
    expect(races[0]!.state).toBe("DECIDED");
    expect(["LANDED", "SHIPPED"]).toContain((await look(ns)).items.find((i) => i.item_id === raced.itemId)!.status);
  });

  it("7. an intent never followed by gitPushed expires after the command timeout (fork deleted, aborted:transient); gitAborted does the same at once", async () => {
    const ns = newHive();
    const stub = stubFor(ns);
    const d = await stub.gitIntent({ hive: ns, user: USER, ref: "refs/heads/x", oldSha: "0".repeat(40), newSha: sha() });
    if (d.verdict !== "accept") throw new Error("refused");
    expect(await runInDurableObject(stub, async (q: QueenNode) => (await (q as unknown as { ctx: DurableObjectState }).ctx.storage.getAlarm()) !== null)).toBe(true);
    await runInDurableObject(stub, async (q: QueenNode) => {
      (q as unknown as { clockOffset: number }).clockOffset = 10 * 60_000 + 1;
      await q.alarm();
    });
    let s = await look(ns);
    expect(s.trains[0]).toMatchObject({ train_id: d.trainId, phase: "EJECTED" });
    expect(s.trains[0]!.reason).toMatch(/push intent expired/);
    expect(s.provisions).toEqual([expect.objectContaining({ op: "DELETE", repo: d.repo })]);
    expect(s.submissions[0]).toMatchObject({ outcome: "aborted:transient", train_id: d.trainId });
    // A late gitPushed for it is refused; the client retries the push.
    const late = await rpcError(stub.gitPushed({ hive: ns, trainId: d.trainId, repo: d.repo, ref: "refs/heads/x", headSha: String(s.submissions[0]!.head_sha), baseSha: "f".repeat(40), title: "x", message: "x", trailers: {} }));
    expect(late).toMatch(/CONFLICT/);

    const e = await stub.gitIntent({ hive: ns, user: USER, ref: "refs/heads/y", oldSha: "0".repeat(40), newSha: sha() });
    if (e.verdict !== "accept") throw new Error("refused");
    expect(await stub.gitAborted({ hive: ns, trainId: e.trainId, reason: "upstream receive-pack failed" })).toEqual({ outcome: "applied" });
    s = await look(ns);
    expect(s.trains.find((t) => t.train_id === e.trainId)).toMatchObject({ phase: "EJECTED", reason: "push aborted: upstream receive-pack failed" });
    expect(s.submissions.find((r) => r.train_id === e.trainId)).toMatchObject({ outcome: "aborted:transient" });
    expect(s.items).toEqual([]);
    // The same head may be pushed again after an abort.
    expect((await stub.gitIntent({ hive: ns, user: USER, ref: "refs/heads/y", oldSha: "0".repeat(40), newSha: String(s.submissions.find((r) => r.train_id === e.trainId)!.head_sha) })).verdict).toBe("accept");
  });

  it("7b. a sick fork re-forked as <repo>-rN: gitPushed adopts it (gate target, cleanup and landing use it); anything else is refused", async () => {
    const ns = newHive();
    const stub = stubFor(ns);
    const other = await stub.gitIntent({ hive: ns, user: USER, ref: "refs/heads/other", oldSha: "0".repeat(40), newSha: sha() });
    const head = sha();
    const d = await stub.gitIntent({ hive: ns, user: USER, ref: "refs/heads/sick", oldSha: "0".repeat(40), newSha: head });
    if (d.verdict !== "accept" || other.verdict !== "accept") throw new Error("refused");
    const pushed = (repo: string) =>
      stub.gitPushed({ hive: ns, trainId: d.trainId, repo, ref: "refs/heads/sick", headSha: head, baseSha: "f".repeat(40), title: "Sick fork", message: "Sick fork", trailers: {} });
    // Only `<the intent's repo>-r<N>`: not a look-alike, not another train's fork (or its re-fork).
    for (const bad of [`${d.repo}-r2x`, `${d.repo}-r`, `${d.repo}r2`, `${d.repo}-r2-r3`, other.repo, `${other.repo}-r2`, `x${d.repo}-r2`]) {
      expect(await rpcError(pushed(bad)), bad).toMatch(/INVALID_INPUT/);
    }
    const repo = `${d.repo}-r2`;
    const result = await pushed(repo);
    expect(result.disposition).toBe("filed");
    let s = await look(ns);
    expect(s.trains.find((t) => t.train_id === d.trainId)).toMatchObject({ artifact_repo: repo, phase: "DEPLOYING", fork_state: "READY", head_sha: head });
    expect(s.submissions.find((r) => r.train_id === d.trainId)).toMatchObject({ repo: d.repo, outcome: "applied", disposition: "filed" });
    expect(JSON.parse(String(s.items.find((i) => i.item_id === result.itemId)!.inbox_json))).toMatchObject({ repo });
    expect(await stub.getGateTarget(repo)).toMatchObject({ trainId: d.trainId, lane: "BUILD", origin: { kind: "human", id: USER } });
    expect(await stub.getGateTarget(d.repo)).toBeNull();
    // Idempotent under the adopted name (the proxy retries gitPushed on a transport error).
    expect(await pushed(repo)).toMatchObject({ disposition: "filed", itemId: result.itemId });

    // Gate, car (MERGE takes the member from the adopted repo), land; cleanup deletes the adopted repo.
    await drive(ns, new Set());
    s = await look(ns);
    expect(s.items.find((i) => i.item_id === result.itemId)).toMatchObject({ status: "SHIPPED" });
    const merge = s.tasks.find((t) => t.action === "MERGE" && t.members?.some((m) => m.trainId === d.trainId))!;
    expect(merge.members!.find((m) => m.trainId === d.trainId)).toMatchObject({ artifactRepo: repo, headSha: head });
    const deletes = s.provisions.filter((c): c is Extract<ProvisionCommand, { op: "DELETE" }> => c.op === "DELETE" && c.trainId === d.trainId);
    expect(deletes.map((c) => c.repo)).toEqual([repo]); // the proxy deleted the abandoned first fork itself
  });

  it("9. race siblings get only their own findings: per-train audits feed notesFor and the REWORK brief", async () => {
    const ns = newHive();
    const stub = stubFor(ns);
    await stub.updateSettings({ hive: ns, user: USER, patch: { autonomy: "paused" } });
    const { item } = await stub.fileWorkItem({ hive: ns, user: USER, item: { kind: "feature", title: "Dark mode" } });
    const a = await push(ns, `refs/heads/item/${item.itemId}`, "Dark mode by Ada");
    const b = await push(ns, `refs/heads/item/${item.itemId}`, "Dark mode by Bob", { user: "bob@example.com" });
    if (a.decision.verdict !== "accept" || b.decision.verdict !== "accept") throw new Error("refused");
    expect(b.result).toMatchObject({ disposition: "joined-race", itemId: item.itemId });
    await stub.updateSettings({ hive: ns, user: USER, patch: { autonomy: "autonomous" } });
    const finding = (trainId: string) => (trainId === (a.decision as { trainId: string }).trainId ? "[error] no-eval src/a.js:3: eval is not allowed" : "[error] no-fetch src/b.js:9: fetch to an unknown host");
    const rejected = (steps: string[]) => ({ taskPrompt: "x", model: "queenos/security-scan-v1", temperature: 0, reasoningSteps: steps, result: "failure" as const, executionTimeMs: 1 });
    // Both gates report their findings before either verdict (interleaved, as concurrent gates do).
    await drive(ns, new Set(), () => false, async (testing) => {
      for (const t of testing) await stub.appendAudits([{ promptId: item.itemId, trainId: t.train_id, commitSha: t.head_sha!, droneRole: "SECURITY", status: "REJECTED", gitNotesPayload: rejected([finding(t.train_id)]) }]);
    });
    const notes = await stub.notesFor(ns, "refs/notes/verdict");
    const verdictOf = (head: string) => parseNotes(notes.notes.find((n) => n.sha === head)!.text).find((e) => e.verdict === "REJECTED")!;
    expect(verdictOf(a.head).findings!.map((f) => f.path)).toEqual(["src/a.js"]);
    expect(verdictOf(b.head).findings!.map((f) => f.path)).toEqual(["src/b.js"]);
    expect(verdictOf(a.head).summary).toMatch(/^REJECTED by SECURITY/);
    const review = await stub.notesFor(ns, "refs/notes/review");
    expect(review.notes.find((n) => n.sha === a.head)!.text).not.toContain("src/b.js");
    expect(review.notes.find((n) => n.sha === b.head)!.text).not.toContain("src/a.js");
    // The REWORK brief (handoff) is the same per-head note.
    const brief = await runInDurableObject(stub, (q: QueenNode) => q.verdictNote(a.head));
    expect(brief).toContain("src/a.js");
    expect(brief).not.toContain("src/b.js");
  });

  it("8. drone items and pushed submissions share the merge queue: everything lands", async () => {
    const ns = newHive();
    const stub = stubFor(ns);
    await stub.updateSettings({ hive: ns, user: USER, patch: { guardrails: { maxQueueBatch: 8, maxQueueDepth: 1 } } });
    for (const w of ["otter", "falcon", "maple"]) await stub.submitWork({ namespace: ns, promptText: `Add /features/${w}` });
    const seen = new Set<string>();
    await drive(ns, seen);
    await push(ns, "refs/heads/one", "Pushed one");
    await push(ns, "refs/heads/two", "Pushed two", { user: "bob@example.com" });
    await drive(ns, seen);
    const s = await look(ns);
    expect(s.items).toHaveLength(5);
    expect(s.items.every((i) => i.status === "SHIPPED")).toBe(true);
  });

  it("the /internal/git/* routes take the same calls over HTTP behind the bearer token; pruneSubmissions runs in the alarm", async () => {
    const ns = newHive();
    const head = sha();
    const body = { hive: ns, user: USER, ref: "refs/heads/http", oldSha: "0".repeat(40), newSha: head };
    const noAuth = await worker.fetch(`http://queen.test/hives/${ns}/internal/git/intent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(noAuth.status).toBe(401);
    const res = await worker.fetch(`http://queen.test/hives/${ns}/internal/git/intent`, { method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: JSON.stringify(body) });
    const d = (await res.json()) as { verdict: string; trainId: string; repo: string };
    expect(d.verdict).toBe("accept");
    const pushedRes = await worker.fetch(`http://queen.test/hives/${ns}/internal/git/pushed`, {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ hive: ns, trainId: d.trainId, repo: d.repo, ref: "refs/heads/http", headSha: head, baseSha: "f".repeat(40), title: "HTTP push", message: "HTTP push", trailers: {} }),
    });
    expect(await pushedRes.json()).toMatchObject({ disposition: "filed" });
    const notes = await worker.fetch(`http://queen.test/hives/${ns}/internal/git/notes?ref=refs/notes/provenance`, { headers: AUTH });
    expect(await notes.json()).toMatchObject({ ref: "refs/notes/provenance", notes: [{ sha: head }] });
    const mismatch = await worker.fetch(`http://queen.test/hives/${ns}/internal/git/intent`, { method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: JSON.stringify({ ...body, hive: "other" }) });
    expect(mismatch.status).toBe(400);

    const stub = stubFor(ns);
    await runInDurableObject(stub, async (q: QueenNode) => {
      (q as unknown as { clockOffset: number }).clockOffset = 31 * 24 * 3_600_000;
      await q.alarm();
    });
    expect(await runInDurableObject(stub, (q: QueenNode) => q.sql.exec("SELECT COUNT(*) AS n FROM submissions").one().n)).toBe(0);
  });
});

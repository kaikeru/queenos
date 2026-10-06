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
import type { DroneTask, Escalation, HiveStatus, ProvisionCommand, QueenEvent, QueenServerMessage, QueueView } from "@queenos/queen-types";

type Snapshot = Extract<QueenServerMessage, { type: "snapshot" }>;
import { demoSwarmPrompt } from "../src/sim/sim-v2";
import type { QueenNode } from "../src/queen-node";
import type { RecordingDispatcher, RecordingHerald, RecordingProvisioner } from "./fakes";
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

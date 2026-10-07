/**
 * Prod 2026-10-07 (hive demo): car K48 (1 member) was DEPLOYING its preview, car K49 (1 member) was
 * stacked on it and PASSED. K48's preview deploy failed on infra (Artifacts 503): K48 was retired,
 * K49 superseded, and both members re-boarded one fresh car (K50). The K48 / K49 DELETEs and K50's
 * FORK were only dispatched ~7 min later, by an alarm. This drives that exact sequence through the
 * QueenNode RPC / webhooks and asserts every effect of the retire plan is dispatched within the call.
 */
import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { DeployCommand, DroneTask, ProvisionCommand } from "@queenos/queen-types";
import { RECONCILE_DELAY_MS, type QueenNode } from "../src/queen-node";
import { WorkflowCommandDispatcher } from "../src/executors";
import type { RecordingDispatcher, RecordingHerald, RecordingProvisioner } from "./fakes";

const worker = exports.default;
const AUTH = { authorization: "Bearer test-internal-token" };
const newHive = () => `hive-${crypto.randomUUID().slice(0, 8)}`;
const stubFor = (ns: string) => env.QUEEN_NODE.get(env.QUEEN_NODE.idFromName(ns));

function post(ns: string, path: string, body: unknown): Promise<Response> {
  return worker.fetch(`http://queen.test/hives/${ns}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(path === "/prompts" ? {} : AUTH) },
    body: JSON.stringify(body),
  });
}

async function submit(ns: string, promptText: string): Promise<string> {
  const res = await post(ns, "/prompts", { namespace: ns, promptText });
  expect(res.status).toBe(201);
  return (await res.json<{ promptRun: { promptId: string } }>()).promptRun.promptId;
}

interface Row {
  train_id: string;
  prompt_id: string;
  phase: string;
  lane: string;
  members: string | null;
  artifact_repo: string;
  fork_source: string | null;
  fork_state: string;
  wait_for_car_seq: number | null;
  seq: number;
}

function inspect(ns: string) {
  return runInDurableObject(stubFor(ns), (q: QueenNode) => {
    const provisions = (q.ports.provisioner as RecordingProvisioner).commands.map((c) => ({ ...c })) as ProvisionCommand[];
    return {
      provisions,
      forks: provisions.flatMap((c) => (c.op === "FORK" ? [{ trainId: c.trainId, source: c.sourceRepo, commandId: c.commandId }] : [])),
      deletes: provisions.flatMap((c) => (c.op === "DELETE" ? [c.commandId] : [])),
      deploys: (q.ports.herald as RecordingHerald).commands.map((c) => ({ ...c })) as DeployCommand[],
      tasks: (q.ports.dispatcher as RecordingDispatcher).tasks.map((t) => ({ ...t })) as DroneTask[],
      trains: q.sql.exec("SELECT * FROM merge_trains ORDER BY seq").toArray() as unknown as Row[],
    };
  });
}

/** Report every not-yet-reported FORK as ok. */
async function reportForks(ns: string, reported: Set<string>): Promise<void> {
  for (const c of (await inspect(ns)).provisions) {
    if (c.op !== "FORK" || reported.has(c.commandId)) continue;
    reported.add(c.commandId);
    const res = await post(ns, "/internal/webhook/provision-result", { commandId: c.commandId, op: "FORK", trainId: c.trainId, ok: true, artifactRepo: c.forkName, baseSha: "b".repeat(40) });
    expect(res.status).toBe(200);
  }
}

async function deployOk(ns: string, trainId: string): Promise<void> {
  const c = (await inspect(ns)).deploys.flatMap((d) => (d.op === "DEPLOY" && d.trainId === trainId ? [d] : [])).at(-1)!;
  const res = await post(ns, "/internal/webhook/deploy-result", { commandId: c.commandId, op: "DEPLOY", environment: "preview", trainId, ok: true, url: `https://${trainId}.preview`, commitSha: c.commitSha });
  expect(await res.json()).toMatchObject({ outcome: "applied" });
}

const carOf = (rows: Row[], member: string) => rows.find((t) => t.lane === "QUEUE" && t.phase !== "EJECTED" && t.phase !== "MERGED" && JSON.parse(t.members ?? "[]").includes(member));

/** Build trains A and B to PASSED; A rides car K48 (DEPLOYING, preview pending), B rides K49 stacked on K48 (PASSED). */
async function k48k49(ns: string) {
  await submit(ns, "A");
  await submit(ns, "B");
  const reported = new Set<string>();
  await reportForks(ns, reported);
  const [a, b] = (await inspect(ns)).trains;
  for (const t of [a!, b!]) {
    await post(ns, "/internal/webhook/build-result", { trainId: t.train_id, headSha: `h-${t.train_id}` });
    await deployOk(ns, t.train_id);
  }
  // A passes: boards K48 (forked from main), MERGE (not fast-forward) → DEPLOYING, preview pending.
  await post(ns, "/internal/webhook/train-result", { trainId: a!.train_id, passed: true, summary: "A green" });
  await reportForks(ns, reported);
  const k48 = carOf((await inspect(ns)).trains, a!.train_id)!;
  expect(k48.fork_source).toBe(ns);
  let res = await post(ns, "/internal/webhook/merge-result", { trainId: k48.train_id, ok: true, headSha: "c".repeat(40), baseSha: "b".repeat(40), merged: [a!.train_id], conflicts: [], fastForward: false });
  expect(await res.json()).toMatchObject({ outcome: "applied", train: { phase: "DEPLOYING" } });
  // B passes: boards K49 stacked on K48 (pushed), merges, deploys and passes its gate.
  await post(ns, "/internal/webhook/train-result", { trainId: b!.train_id, passed: true, summary: "B green" });
  await reportForks(ns, reported);
  const k49 = carOf((await inspect(ns)).trains, b!.train_id)!;
  expect(k49.fork_source).toBe(k48.artifact_repo);
  res = await post(ns, "/internal/webhook/merge-result", { trainId: k49.train_id, ok: true, headSha: "d".repeat(40), baseSha: "c".repeat(40), merged: [b!.train_id], conflicts: [], fastForward: false });
  expect(await res.json()).toMatchObject({ outcome: "applied", train: { phase: "DEPLOYING" } });
  await deployOk(ns, k49.train_id);
  res = await post(ns, "/internal/webhook/train-result", { trainId: k49.train_id, passed: true, summary: "K49 green" });
  expect(await res.json()).toMatchObject({ outcome: "applied", train: { phase: "PASSED" } });
  const s = await inspect(ns);
  expect(s.trains.find((t) => t.train_id === k48.train_id)).toMatchObject({ phase: "DEPLOYING" });
  return { a: a!.train_id, b: b!.train_id, k48: k48.train_id, k49: k49.train_id };
}

describe("prod K48/K49/K50: a car's preview deploy fails on infra with a PASSED car stacked on it", () => {
  it("the retire / supersede DELETEs and the re-boarded car's FORK (from main) are dispatched within the deploy-result call", async () => {
    const ns = newHive();
    const { a, b, k48, k49 } = await k48k49(ns);
    const before = await inspect(ns);
    const deploy = before.deploys.filter((d) => d.op === "DEPLOY" && d.trainId === k48).at(-1)!;

    const res = await post(ns, "/internal/webhook/deploy-result", {
      commandId: deploy.commandId, op: "DEPLOY", environment: "preview", trainId: k48, ok: false, retryable: true,
      summary: "Artifacts returned 503 Service Unavailable",
    });
    expect(await res.json()).toMatchObject({ outcome: "applied", train: { phase: "EJECTED" } });

    const s = await inspect(ns);
    expect(s.trains.find((t) => t.train_id === k48)).toMatchObject({ phase: "EJECTED" });
    expect(s.trains.find((t) => t.train_id === k49)).toMatchObject({ phase: "EJECTED" });
    const k50 = carOf(s.trains, a)!;
    expect(k50).toBeDefined();
    expect(JSON.parse(k50.members!)).toEqual([a, b]);
    expect(k50).toMatchObject({ phase: "BUILDING", fork_state: "PENDING", fork_source: ns });
    // Dispatched now, not by a later alarm.
    expect(s.forks.slice(before.forks.length)).toEqual([{ trainId: k50.train_id, source: ns, commandId: `${k50.train_id}-fork-1` }]);
    expect(s.deletes.slice(before.deletes.length).sort()).toEqual([`${k48}-delete-1`, `${k49}-delete-1`].sort());
  });

  it("a car left WAITING_PARENT with nothing ahead of it is forked by the next alarm (liveness net)", async () => {
    const ns = newHive();
    const { a, k48 } = await k48k49(ns);
    const deploy = (await inspect(ns)).deploys.filter((d) => d.op === "DEPLOY" && d.trainId === k48).at(-1)!;
    await post(ns, "/internal/webhook/deploy-result", { commandId: deploy.commandId, op: "DEPLOY", environment: "preview", trainId: k48, ok: false, retryable: true, summary: "503" });
    // Simulate the stranded state prod reached: K50 WAITING_PARENT, its fork never issued, no alarm due soon.
    const k50 = carOf((await inspect(ns)).trains, a)!;
    const forksBefore = (await inspect(ns)).forks.length;
    await runInDurableObject(stubFor(ns), async (q: QueenNode, state) => {
      q.sql.exec("UPDATE merge_trains SET phase = 'WAITING_PARENT', status = 'BUILDING', fork_state = 'NONE', fork_source = NULL, fork_command_id = NULL, fork_issued_at = NULL WHERE train_id = ?", k50.train_id);
      (q as unknown as { invalidate(): void }).invalidate();
      await state.storage.deleteAlarm();
    });
    // Any decision (here a duplicate late report) must leave the alarm armed for the stranded car.
    await post(ns, "/internal/webhook/deploy-result", { commandId: deploy.commandId, op: "DEPLOY", environment: "preview", trainId: k48, ok: false, retryable: true, summary: "503" });
    const armed = await runInDurableObject(stubFor(ns), (_q: QueenNode, state) => state.storage.getAlarm());
    expect(armed).not.toBeNull();
    expect(armed! - Date.now()).toBeLessThan(60_000);
    expect(await runDurableObjectAlarm(stubFor(ns))).toBe(true);
    const s = await inspect(ns);
    expect(s.forks.slice(forksBefore)).toEqual([{ trainId: k50.train_id, source: ns, commandId: `${k50.train_id}-fork-1` }]);
  });

  it("a hung Provisioner dispatch (Workflows create never settles) does not strand the retire plan: the call returns and a reconcile re-sends it within RECONCILE_DELAY_MS", async () => {
    const ns = newHive();
    const { a, k48, k49 } = await k48k49(ns);
    const before = await inspect(ns);
    const deploy = before.deploys.filter((d) => d.op === "DEPLOY" && d.trainId === k48).at(-1)!;
    await runInDurableObject(stubFor(ns), (q: QueenNode) => {
      (q.ports.provisioner as RecordingProvisioner).hangNext = 1;
      (q as unknown as { dispatchTimeout: number }).dispatchTimeout = 50;
    });
    const t0 = Date.now();
    const res = await post(ns, "/internal/webhook/deploy-result", { commandId: deploy.commandId, op: "DEPLOY", environment: "preview", trainId: k48, ok: false, retryable: true, summary: "503" });
    expect(await res.json()).toMatchObject({ outcome: "applied", train: { phase: "EJECTED" } });
    let s = await inspect(ns);
    expect(s.forks.length).toBe(before.forks.length); // the hung batch recorded nothing
    // The hung dispatch counts as failed: reconcile is due within RECONCILE_DELAY_MS, not at a 10-min watchdog.
    const armed = await runInDurableObject(stubFor(ns), (_q: QueenNode, state) => state.storage.getAlarm());
    expect(armed).not.toBeNull();
    expect(armed!).toBeLessThanOrEqual(Date.now() + RECONCILE_DELAY_MS);
    expect(armed!).toBeGreaterThanOrEqual(t0);
    expect(await runDurableObjectAlarm(stubFor(ns))).toBe(true);
    s = await inspect(ns);
    const k50 = carOf(s.trains, a)!;
    expect(s.forks.slice(before.forks.length)).toEqual([{ trainId: k50.train_id, source: ns, commandId: `${k50.train_id}-fork-1` }]);
    expect(s.deletes.slice(before.deletes.length).sort()).toEqual([`${k48}-delete-1`, `${k49}-delete-1`].sort());
  });

  it("prod 15:01:18: Workflows createBatch (array form) left the retire plan's instances out without an error; they are still started inside the deploy-result call", async () => {
    const ns = newHive();
    const { a, k48, k49 } = await k48k49(ns);
    const deploy = (await inspect(ns)).deploys.flatMap((d) => (d.op === "DEPLOY" && d.trainId === k48 ? [d] : [])).at(-1)!;
    // The REAL dispatcher (createMany) over a Workflow whose first createBatch omits every instance, as the
    // array form does for ids it could not create. Real infraRetryDelayMs / jitter: nothing is shortened.
    const t0 = Date.now();
    await runInDurableObject(stubFor(ns), (q: QueenNode) => {
      const started = new Map<string, number>();
      (globalThis as unknown as { started: Map<string, number> }).started = started;
      const workflow = (dropFirst: boolean) => {
        let drop = dropFirst;
        const create = async ({ id }: { id: string }) => {
          if (started.has(id)) throw new Error("instance.already_exists");
          started.set(id, Date.now());
          return { id };
        };
        return {
          create,
          get: async (id: string) => {
            if (!started.has(id)) throw new Error("instance.not_found");
            return { id };
          },
          createBatch: async (batch: { id: string }[]) => {
            if (drop) {
              drop = false;
              return [];
            }
            return Promise.all(batch.filter((b) => !started.has(b.id)).map(create));
          },
        } as unknown as Workflow;
      };
      const ports = q.ports as unknown as Record<string, unknown>;
      ports.provisioner = new WorkflowCommandDispatcher(workflow(true), "PROVISIONER");
      ports.herald = new WorkflowCommandDispatcher(workflow(true), "HERALD");
    });
    const res = await post(ns, "/internal/webhook/deploy-result", { commandId: deploy.commandId, op: "DEPLOY", environment: "preview", trainId: k48, ok: false, retryable: true, summary: "Artifacts returned 503 Service Unavailable" });
    expect(await res.json()).toMatchObject({ outcome: "applied", train: { phase: "EJECTED" } });
    const { started, k50, alarm } = await runInDurableObject(stubFor(ns), async (q: QueenNode, state) => {
      const rows = q.sql.exec("SELECT * FROM merge_trains ORDER BY seq").toArray() as unknown as Row[];
      return { started: [...(globalThis as unknown as { started: Map<string, number> }).started.keys()], k50: carOf(rows, a)!, alarm: await state.storage.getAlarm() };
    });
    expect(started.sort()).toEqual([`${k50.train_id}-fork-1`, `${k48}-delete-1`, `${k49}-delete-1`, `${k48}-teardown-1`, `${k49}-teardown-1`].sort());
    // Nothing is left for a later alarm: the next one is a watchdog deadline, not a missed dispatch.
    expect(alarm! - t0).toBeGreaterThan(RECONCILE_DELAY_MS);
  });
});


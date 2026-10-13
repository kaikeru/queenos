import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { DeployCommand, DroneTask, ProvisionCommand, QueenServerMessage, RecalledMemory, SentinelCommand } from "@queenos/queen-types";
import { modelPin, RECONCILE_DELAY_MS, routerPolicy, type QueenNode, type SocketAttachment } from "../src/queen-node";
import { migrate } from "../src/db";
import { GATE_TIMEOUT_MS } from "../src/train/planner";
import type { RecordingDispatcher, RecordingHerald, RecordingProvisioner, RecordingSentinel } from "./fakes";

const worker = exports.default;
/** wrangler.jsonc env.test sets QUEEN_INTERNAL_TOKEN. */
const AUTH = { authorization: "Bearer test-internal-token" };

/** Unique hive per test: no shared DO storage between tests. */
const newHive = () => `hive-${crypto.randomUUID().slice(0, 8)}`;
const stubFor = (ns: string) => env.QUEEN_NODE.get(env.QUEEN_NODE.idFromName(ns));

/**
 * Settle an RPC promise into its error message. (Asserting with
 * `expect(rpc).rejects` leaves the RPC thenable flagged as unhandled.)
 */
async function rpcError(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

function post(ns: string, path: string, body: unknown): Promise<Response> {
  return worker.fetch(`http://queen.test/hives/${ns}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(path === "/prompts" ? {} : AUTH) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function submit(ns: string, promptText: string): Promise<string> {
  const res = await post(ns, "/prompts", { namespace: ns, promptText });
  expect(res.status).toBe(201);
  const { promptRun } = await res.json<{ promptRun: { promptId: string } }>();
  return promptRun.promptId;
}

interface TrainRow {
  train_id: string;
  prompt_id: string;
  status: string;
  phase: string;
  included_prompts: string;
  artifact_repo: string;
  fork_source: string | null;
  fork_state: string;
  deploy_state: string;
  preview_url: string | null;
}

type Fork = Extract<ProvisionCommand, { op: "FORK" }>;

function inspect(ns: string) {
  return runInDurableObject(stubFor(ns), (q: QueenNode) => {
    const provisioner = q.ports.provisioner as RecordingProvisioner;
    const herald = q.ports.herald as RecordingHerald;
    const drones = q.ports.dispatcher as RecordingDispatcher;
    const sentinel = q.ports.sentinel as RecordingSentinel;
    const provisions = provisioner.commands.map((c) => ({ ...c })) as ProvisionCommand[];
    const deploys = herald.commands.map((c) => ({ ...c })) as DeployCommand[];
    return {
      provisions,
      deploys,
      forks: provisions.filter((c): c is Fork => c.op === "FORK").map((c) => ({ source: c.sourceRepo, name: c.forkName, commandId: c.commandId, trainId: c.trainId })),
      deleted: provisions.flatMap((c) => (c.op === "DELETE" ? [c.repo] : [])),
      tasks: drones.tasks.map((t) => ({ ...t })) as DroneTask[],
      sentinels: sentinel.commands.map((c) => ({ ...c })) as SentinelCommand[],
      trains: q.sql.exec("SELECT * FROM merge_trains ORDER BY seq").toArray() as unknown as TrainRow[],
      prompts: q.sql.exec("SELECT prompt_id, status, summary, attempts FROM prompt_runs ORDER BY seq").toArray(),
    };
  });
}

const previewUrl = (trainId: string) => `https://${trainId}-preview.test.dev`;

/**
 * Play the executors: report every not-yet-reported FORK (and, unless
 * `deploys` is false, every preview DEPLOY) as ok over the HTTP webhooks,
 * until nothing new is dispatched.
 */
async function settle(ns: string, reported: Set<string>, opts: { deploys?: boolean } = {}): Promise<void> {
  for (let round = 0; round < 20; round++) {
    const s = await inspect(ns);
    let progressed = false;
    for (const c of s.provisions) {
      if (c.op !== "FORK" || reported.has(c.commandId)) continue;
      reported.add(c.commandId);
      progressed = true;
      const res = await post(ns, "/internal/webhook/provision-result", {
        commandId: c.commandId,
        op: "FORK",
        trainId: c.trainId,
        ok: true,
        artifactRepo: c.forkName,
        baseSha: `sha-of-${c.sourceRepo}`,
      });
      expect(res.status).toBe(200);
    }
    if (opts.deploys !== false) {
      for (const c of s.deploys) {
        if (c.op !== "DEPLOY" || c.environment !== "preview" || reported.has(c.commandId)) continue;
        reported.add(c.commandId);
        progressed = true;
        const res = await post(ns, "/internal/webhook/deploy-result", {
          commandId: c.commandId,
          op: "DEPLOY",
          environment: "preview",
          trainId: c.trainId,
          ok: true,
          url: previewUrl(c.trainId!),
          commitSha: c.commitSha,
        });
        expect(res.status).toBe(200);
      }
    }
    if (!progressed) return;
  }
}

/**
 * v2 merge queue: a passed build boards a car (a QUEUE-lane train) that forks
 * from main, runs the MERGE drone (fast path: one member, fast-forward) and is
 * landed by the LANDER. Plays those executors; returns the car id.
 */
async function landViaQueue(ns: string, trainId: string, reported: Set<string>, mainSha = "main-1"): Promise<string> {
  await settle(ns, reported);
  let s = await inspect(ns);
  const car = s.trains.find((t) => (t as unknown as { lane: string }).lane === "QUEUE" && JSON.parse(String((t as unknown as { members: string }).members)).includes(trainId));
  expect(car).toBeDefined();
  const carId = car!.train_id;
  expect(s.tasks.at(-1)).toMatchObject({ trainId: carId, action: "MERGE", role: "LANDER", members: [expect.objectContaining({ trainId })] });
  const merged = await post(ns, "/internal/webhook/merge-result", { trainId: carId, ok: true, headSha: "c".repeat(40), baseSha: "b".repeat(40), merged: [trainId], fastForward: true });
  expect(await merged.json()).toMatchObject({ outcome: "applied", train: { phase: "LANDING" } });
  s = await inspect(ns);
  expect(s.tasks.at(-1)).toMatchObject({ trainId: carId, action: "LAND", members: [expect.objectContaining({ trainId })] });
  const landed = await post(ns, "/internal/webhook/land-result", { trainId: carId, landed: true, mainSha });
  expect(await landed.json()).toMatchObject({ outcome: "applied", train: { phase: "MERGED" } });
  return carId;
}

async function connect(path: string): Promise<{ ws: WebSocket; next: (pred?: (m: QueenServerMessage) => boolean) => Promise<QueenServerMessage> }> {
  const res = await worker.fetch(`http://queen.test${path}`, { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const inbox: QueenServerMessage[] = [];
  ws.addEventListener("message", (e) => {
    if (e.data === "pong") return;
    const m = JSON.parse(e.data as string) as QueenServerMessage;
    // v2: broadcasts arrive coalesced in `batch` frames; tests read the messages inside.
    if (m.type === "batch") inbox.push(...m.messages);
    else inbox.push(m);
  });
  ws.accept();
  const next = async (pred: (m: QueenServerMessage) => boolean = () => true) => {
    for (let i = 0; i < 200; i++) {
      const idx = inbox.findIndex(pred);
      if (idx >= 0) return inbox.splice(0, idx + 1).at(-1)!;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("timed out waiting for a frame");
  };
  return { ws, next };
}

describe("queen worker", () => {
  it("GET /health returns 200", async () => {
    const res = await worker.fetch("http://example.com/health");
    expect(res.status).toBe(200);
  });

  it("GET /ws without upgrade returns 426", async () => {
    const res = await worker.fetch("http://example.com/ws");
    expect(res.status).toBe(426);
  });

  it("GET /room and /hives/:ns/room without upgrade return 426", async () => {
    expect((await worker.fetch("http://example.com/room")).status).toBe(426);
    expect((await worker.fetch(`http://example.com/hives/${newHive()}/room`)).status).toBe(426);
  });
});

describe("merge train via HTTP", () => {
  it("submitting 3 prompts creates 3 independent BUILD trains, all forked from main at once", async () => {
    const ns = newHive();
    const [a, b, c] = [await submit(ns, "A"), await submit(ns, "B"), await submit(ns, "C")];
    let s = await inspect(ns);
    expect(s.trains.map((t) => JSON.parse(t.included_prompts))).toEqual([[a], [b], [c]]);
    expect(s.trains.map((t) => t.status)).toEqual(["BUILDING", "BUILDING", "BUILDING"]);
    const [t1, t2, t3] = s.trains;
    expect(t1!.artifact_repo).toMatch(new RegExp(`^${ns}-train-[0-9a-f]{12}$`));
    // The Queen only dispatches the forks; nothing is built until the Provisioner reports.
    expect(s.forks).toEqual([t1!, t2!, t3!].map((t) => ({ source: ns, name: t.artifact_repo, commandId: `${t.train_id}-fork-1`, trainId: t.train_id })));
    expect(s.tasks).toEqual([]);
    const reported = new Set<string>();
    await settle(ns, reported);
    s = await inspect(ns);
    expect(s.tasks).toEqual([a, b, c].map((p) => expect.objectContaining({ promptId: p, role: "BUILDER", action: "BUILD", ragContext: [] })));

    for (const t of [t1!, t2!]) {
      const res = await post(ns, "/internal/webhook/build-result", { trainId: t.train_id, headSha: `h-${t.train_id}` });
      expect(await res.json()).toMatchObject({ outcome: "applied", train: { status: "TESTING", phase: "DEPLOYING" } });
      await settle(ns, reported, { deploys: false });
    }
    s = await inspect(ns);
    expect(s.deploys.map((d) => d.op === "DEPLOY" && [d.trainId, d.environment, d.artifactRepo, d.commitSha])).toEqual([
      [t1!.train_id, "preview", t1!.artifact_repo, `h-${t1!.train_id}`],
      [t2!.train_id, "preview", t2!.artifact_repo, `h-${t2!.train_id}`],
    ]);
    // A push forks nobody: still exactly the three forks of hive main.
    expect(s.forks.map((f) => f.source)).toEqual([ns, ns, ns]);
  });

  it("results drive MERGED / EJECTED in SQLite", async () => {
    const ns = newHive();
    const [a, b, c] = [await submit(ns, "A"), await submit(ns, "B"), await submit(ns, "C")];
    const [t1, t2, t3] = (await inspect(ns)).trains;
    const reported = new Set<string>();
    await settle(ns, reported);
    for (const t of [t1!, t2!, t3!]) {
      await post(ns, "/internal/webhook/build-result", { trainId: t.train_id, headSha: `h-${t.prompt_id}` });
      await settle(ns, reported);
    }

    // B fails: only B is ejected; its rework forks from main. C is untouched (no supersede).
    const fail = await post(ns, "/internal/webhook/train-result", { trainId: t2!.train_id, passed: false, summary: "B: 3 tests failed" });
    expect(await fail.json()).toMatchObject({ outcome: "applied", train: { status: "EJECTED" } });
    let s = await inspect(ns);
    const byId = Object.fromEntries(s.trains.map((t) => [t.train_id, t]));
    expect(byId[t2!.train_id]!.status).toBe("EJECTED");
    expect(byId[t3!.train_id]!.status).toBe("TESTING");
    expect(s.deleted).toEqual([t2!.artifact_repo]);
    const active = s.trains.filter((t) => t.status !== "EJECTED");
    expect(active.map((t) => JSON.parse(t.included_prompts))).toEqual([[a], [c], [b], [b]]);
    expect(active.at(-1)!.fork_source).toBe(ns);
    expect(s.prompts).toContainEqual({ prompt_id: b, status: "QUEUED", summary: "B: 3 tests failed", attempts: 1 });

    // A passes (via the /trains/:id/result alias) -> boards a merge-queue car, which lands it.
    const pass = await post(ns, `/trains/${t1!.train_id}/result`, { passed: true, summary: "A green", commitSha: "h-a" });
    expect(await pass.json()).toMatchObject({ outcome: "applied", train: { status: "TESTING", phase: "PASSED" } });
    await landViaQueue(ns, t1!.train_id, reported);
    s = await inspect(ns);
    expect(s.trains.find((t) => t.train_id === t1!.train_id)).toMatchObject({ phase: "MERGED" });
    expect(s.prompts.find((p) => p.prompt_id === a)!.status).toBe("MERGED");
    expect(s.deleted).toContain(t1!.artifact_repo);

    // A late result for the ejected train is ignored idempotently.
    const late = await post(ns, "/internal/webhook/train-result", { trainId: t2!.train_id, passed: true, summary: "late" });
    expect(await late.json()).toMatchObject({ outcome: "ignored:stale", train: { status: "EJECTED" } });

    // A REWORK drone (a race of reworkWidth 2) carries the Scribe summary as soon as B's new trains fork (from main, no waiting).
    await settle(ns, reported);
    s = await inspect(ns);
    const reworks = s.tasks.filter((t) => t.action === "REWORK");
    expect(reworks.length).toBe(2);
    for (const r of reworks) expect(r).toMatchObject({ promptId: b, scribeSummary: "B: 3 tests failed" });
  });

  it("appends audit events and records scribe summaries", async () => {
    const ns = newHive();
    const a = await submit(ns, "A");
    const note = { taskPrompt: "A", model: "m", temperature: 0, reasoningSteps: ["r"], result: "success", executionTimeMs: 3 };
    const res = await post(ns, "/audit", { promptId: a, droneRole: "SECURITY", status: "PASSED", gitNotesPayload: note });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ event: { promptId: a, droneRole: "SECURITY", status: "PASSED" } });
    const sc = await post(ns, "/scribe", { promptId: a, summary: "short" });
    expect(sc.status).toBe(200);
    const snap = await (await worker.fetch(`http://q/hives/${ns}/snapshot`)).json<{ recentAudit: unknown[]; promptRuns: unknown[] }>();
    expect(snap.recentAudit).toHaveLength(1);
    expect(snap.promptRuns).toHaveLength(1);
  });
});

type Snapshot = Extract<QueenServerMessage, { type: "snapshot" }>;
const snapshotOf = async (ns: string) => (await worker.fetch(`http://q/hives/${ns}/snapshot`)).json<Snapshot>();

/** One prompt, forked, built and (optionally) with its preview live. Returns the train. */
async function oneTrain(ns: string, opts: { live?: boolean } = {}) {
  await submit(ns, "A");
  const reported = new Set<string>();
  await settle(ns, reported);
  const [t] = (await inspect(ns)).trains;
  await post(ns, "/internal/webhook/build-result", { trainId: t!.train_id, headSha: "h-a" });
  if (opts.live) await settle(ns, reported);
  return { trainId: t!.train_id, repo: t!.artifact_repo, reported };
}

describe("executor results", () => {
  it("reportProvisionResult (RPC) advances the planner exactly like the old inline fork; duplicates are no-ops", async () => {
    const ns = newHive();
    await submit(ns, "A");
    const [t] = (await inspect(ns)).trains;
    const result = { commandId: `${t!.train_id}-fork-1`, op: "FORK" as const, trainId: t!.train_id, ok: true, artifactRepo: t!.artifact_repo, baseSha: "base-1" };
    const first = await stubFor(ns).reportProvisionResult(result);
    expect(first).toMatchObject({ outcome: "applied", train: { baseSha: "base-1", status: "BUILDING", phase: "BUILDING" } });
    const dup = await stubFor(ns).reportProvisionResult(result);
    expect(dup.outcome).toBe("ignored:duplicate");
    const stale = await stubFor(ns).reportProvisionResult({ ...result, commandId: "old-fork-0" });
    expect(stale.outcome).toBe("ignored:stale");
    const s = await inspect(ns);
    expect(s.tasks).toHaveLength(1);
    expect(s.trains[0]).toMatchObject({ fork_state: "READY" });
    expect(await rpcError(stubFor(ns).reportProvisionResult({ ...result, trainId: "nope" }))).toMatch(/^NOT_FOUND: /);
    expect(await rpcError(stubFor(ns).reportProvisionResult({ ...result, op: "MOVE" } as never))).toMatch(/^INVALID_INPUT: /);
  });

  it("a failed fork is retried under a new command id (provision-result over HTTP)", async () => {
    const ns = newHive();
    await submit(ns, "A");
    const [t] = (await inspect(ns)).trains;
    const res = await post(ns, "/internal/webhook/provision-result", { commandId: `${t!.train_id}-fork-1`, op: "FORK", trainId: t!.train_id, ok: false, summary: "503" });
    expect(await res.json()).toMatchObject({ outcome: "applied", train: { phase: "BUILDING" } });
    expect((await inspect(ns)).forks.map((f) => f.commandId)).toEqual([`${t!.train_id}-fork-1`, `${t!.train_id}-fork-2`]);
  });

  it("deploy-result (HTTP): a LIVE preview moves DEPLOYING -> TESTING and shows in snapshots", async () => {
    const ns = newHive();
    const { trainId } = await oneTrain(ns);
    let snap = await snapshotOf(ns);
    expect(snap.trains[0]).toMatchObject({ phase: "DEPLOYING", status: "TESTING", previewUrl: null });
    expect(snap.deployments).toEqual([expect.objectContaining({ deploymentId: `preview-${trainId}`, environment: "preview", status: "PENDING", commitSha: "h-a" })]);

    const body = { commandId: `${trainId}-deploy-1`, op: "DEPLOY", environment: "preview", trainId, ok: true, url: previewUrl(trainId), versionId: "v-1" };
    const res = await post(ns, "/internal/webhook/deploy-result", body);
    expect(await res.json()).toMatchObject({ outcome: "applied", train: { phase: "TESTING", previewUrl: previewUrl(trainId) } });
    expect(await (await post(ns, "/internal/webhook/deploy-result", body)).json()).toMatchObject({ outcome: "ignored:duplicate" });

    snap = await snapshotOf(ns);
    expect(snap.trains[0]).toMatchObject({ phase: "TESTING", previewUrl: previewUrl(trainId) });
    expect(snap.deployments).toEqual([expect.objectContaining({ status: "LIVE", url: previewUrl(trainId), versionId: "v-1", hive: ns })]);
    // Gatekeepers can now pass the train.
    const pass = await post(ns, "/internal/webhook/train-result", { trainId, passed: true, summary: "smoke ok" });
    expect(await pass.json()).toMatchObject({ outcome: "applied", train: { phase: "PASSED", passedSeq: 1, carId: expect.any(String) } });
  });

  it("a gatekeeper pass while DEPLOYING is premature", async () => {
    const ns = newHive();
    const { trainId } = await oneTrain(ns);
    const res = await post(ns, "/internal/webhook/train-result", { trainId, passed: true, summary: "too early" });
    expect(await res.json()).toMatchObject({ outcome: "ignored:premature", train: { phase: "DEPLOYING" } });
  });

  it("reportDeployResult (RPC) failure ejects the train for rework and tears the preview down", async () => {
    const ns = newHive();
    const { trainId } = await oneTrain(ns);
    const r = await stubFor(ns).reportDeployResult({
      commandId: `${trainId}-deploy-1`,
      op: "DEPLOY",
      environment: "preview",
      trainId,
      ok: false,
      summary: "Worker threw on startup.",
    });
    expect(r).toMatchObject({ outcome: "applied", train: { status: "EJECTED", reason: "failed: preview deploy failed: Worker threw on startup." } });
    const s = await inspect(ns);
    expect(s.deploys.map((d) => [d.op, d.commandId])).toEqual([
      ["DEPLOY", `${trainId}-deploy-1`],
      ["TEARDOWN", `${trainId}-teardown-1`],
    ]);
    expect(s.prompts[0]).toMatchObject({ status: "QUEUED", summary: "Worker threw on startup.", attempts: 1 });
    const snap = await snapshotOf(ns);
    expect(snap.deployments?.[0]).toMatchObject({ status: "FAILED", summary: "Worker threw on startup." });
  });

  it("MERGED tears the preview down; a teardown result without trainId is matched by command id", async () => {
    const ns = newHive();
    const { trainId, reported } = await oneTrain(ns, { live: true });
    await post(ns, "/internal/webhook/train-result", { trainId, passed: true, summary: "ok" });
    await landViaQueue(ns, trainId, reported, "m1");
    const s = await inspect(ns);
    expect(s.deploys.filter((d) => d.op === "TEARDOWN")).toEqual([
      { op: "TEARDOWN", commandId: `${trainId}-teardown-1`, hive: ns, environment: "preview", trainId, trace: { traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/) } },
    ]);
    // The merge also cut a release: its staging deploy goes to the Herald.
    expect(s.deploys.at(-1)).toMatchObject({ op: "DEPLOY", environment: "staging", artifactRepo: ns, commitSha: "m1" });
    expect(s.trains[0]).toMatchObject({ phase: "MERGED", deploy_state: "TEARING_DOWN", preview_url: previewUrl(trainId) });

    const td = { commandId: `${trainId}-teardown-1`, op: "TEARDOWN", environment: "preview", ok: true };
    expect(await (await post(ns, "/internal/webhook/deploy-result", td)).json()).toMatchObject({ outcome: "applied", train: { status: "MERGED" } });
    expect(await (await post(ns, "/internal/webhook/deploy-result", td)).json()).toMatchObject({ outcome: "ignored:duplicate" });
    expect((await snapshotOf(ns)).deployments?.find((d) => d.environment === "preview")).toMatchObject({ status: "TORN_DOWN" });
    expect(await rpcError(stubFor(ns).reportDeployResult({ commandId: "unknown-cmd", op: "TEARDOWN", environment: "preview", ok: true }))).toMatch(
      /^NOT_FOUND: /,
    );
  });

  it("a failed dispatch is re-sent by the reconcile alarm under the same command id", async () => {
    const ns = newHive();
    await runInDurableObject(stubFor(ns), (q: QueenNode) => {
      (q.ports.provisioner as RecordingProvisioner).failNext = 1;
    });
    await submit(ns, "A");
    expect((await inspect(ns)).forks).toEqual([]);
    const [t] = (await inspect(ns)).trains;
    expect(t).toMatchObject({ fork_state: "PENDING" });
    expect(await runDurableObjectAlarm(stubFor(ns))).toBe(true);
    expect((await inspect(ns)).forks.map((f) => f.commandId)).toEqual([`${t!.train_id}-fork-1`]);
  });
});

describe("command watchdog (alarm)", () => {
  const T = 600_000; // wrangler.jsonc env.test COMMAND_TIMEOUT_MS
  const skew = (ns: string, ms: number) =>
    runInDurableObject(stubFor(ns), (q: QueenNode) => {
      (q as unknown as { clockOffset: number }).clockOffset = ms;
    });
  const alarmAt = (ns: string) => runInDurableObject(stubFor(ns), (_q: QueenNode, state) => state.storage.getAlarm());

  it("arms the alarm while a command is outstanding; a stuck fork is retried, a late old-id result is stale, then the train is ejected", async () => {
    const ns = newHive();
    const t0 = Date.now();
    await submit(ns, "A");
    const [t] = (await inspect(ns)).trains;
    const id = t!.train_id;
    // Armed at the watchdog deadline (issue time + COMMAND_TIMEOUT_MS + slack).
    const armed = await alarmAt(ns);
    expect(armed).not.toBeNull();
    expect(armed!).toBeGreaterThanOrEqual(t0 + T);
    expect(armed!).toBeLessThanOrEqual(Date.now() + T + 2_000);

    // Executor died: nothing reported. Ten minutes later the alarm re-issues under a new id.
    await skew(ns, T + 2_000);
    expect(await runDurableObjectAlarm(stubFor(ns))).toBe(true);
    expect((await inspect(ns)).forks.map((f) => f.commandId)).toEqual([`${id}-fork-1`, `${id}-fork-2`]);
    expect(await alarmAt(ns)).not.toBeNull(); // still outstanding: re-armed

    // The first Provisioner's late report is ignored as stale.
    const late = await post(ns, "/internal/webhook/provision-result", { commandId: `${id}-fork-1`, op: "FORK", trainId: id, ok: true, artifactRepo: t!.artifact_repo });
    expect(await late.json()).toMatchObject({ outcome: "ignored:stale", train: { phase: "BUILDING" } });
    expect((await inspect(ns)).trains[0]).toMatchObject({ fork_state: "PENDING", fork_command_id: `${id}-fork-2` });

    await skew(ns, 2 * (T + 2_000));
    expect(await runDurableObjectAlarm(stubFor(ns))).toBe(true);
    expect((await inspect(ns)).forks.map((f) => f.commandId).at(-1)).toBe(`${id}-fork-3`);

    // Attempt cap reached: the executor is lost (infrastructure), not the change: EJECTED, prompt FAILED, no rework charged.
    await skew(ns, 3 * (T + 2_000));
    expect(await runDurableObjectAlarm(stubFor(ns))).toBe(true);
    const s = await inspect(ns);
    expect(s.trains[0]).toMatchObject({ train_id: id, phase: "EJECTED", fork_state: "DELETING" });
    expect(String((s.trains[0] as unknown as { reason: string }).reason)).toMatch(/^failed on infrastructure: fork failed: Provisioner FORK .*-fork-3 did not report/);
    expect(s.trains).toHaveLength(1);
    expect(s.prompts[0]).toMatchObject({ status: "FAILED", attempts: 0 });
    expect(s.provisions.filter((c) => c.op === "DELETE").map((c) => c.commandId)).toEqual([`${id}-delete-1`]);
    expect(await alarmAt(ns)).not.toBeNull(); // the delete is outstanding
  });

  type AlarmApi = { alarmNoLaterThan(at: number): Promise<void>; ioFailed(): Promise<void> };
  const api = (q: QueenNode) => q as unknown as AlarmApi;

  it("alarmNoLaterThan never overwrites a past-due (sim-style now+1ms) alarm with a later one", async () => {
    const ns = newHive();
    await submit(ns, "A");
    const booked = await runInDurableObject(stubFor(ns), async (q: QueenNode, state) => {
      const at = Date.now() - 5;
      await state.storage.setAlarm(at);
      await api(q).alarmNoLaterThan(Date.now() + 600_000);
      return { at, now: await state.storage.getAlarm() };
    });
    // The runtime may clamp a past time to "now"; what matters is that it was not pushed 10 minutes out.
    expect(booked.now!).toBeLessThan(booked.at + 60_000);
  });

  it("ioFailed pulls a minutes-away alarm in to about RECONCILE_DELAY_MS", async () => {
    const ns = newHive();
    const got = await runInDurableObject(stubFor(ns), async (q: QueenNode, state) => {
      await state.storage.setAlarm(Date.now() + 300_000);
      await api(q).ioFailed();
      return (await state.storage.getAlarm())! - Date.now();
    });
    expect(got).toBeLessThanOrEqual(RECONCILE_DELAY_MS + 1_000);
    expect(got).toBeGreaterThan(0);
  });

  it("re-arming works inside alarm(): the outstanding command's watchdog is armed again", async () => {
    const ns = newHive();
    await submit(ns, "A");
    await skew(ns, T + 2_000);
    expect(await runDurableObjectAlarm(stubFor(ns))).toBe(true);
    const next = await alarmAt(ns);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(Date.now());
  });

  it("a drone that never reports is re-dispatched under a new instance id", async () => {
    const ns = newHive();
    await submit(ns, "A");
    await settle(ns, new Set());
    await skew(ns, T + 2_000);
    expect(await runDurableObjectAlarm(stubFor(ns))).toBe(true);
    const ids = await runInDurableObject(stubFor(ns), (q: QueenNode) => [...(q.ports.dispatcher as RecordingDispatcher).instanceIds]);
    const [t] = (await inspect(ns)).trains;
    expect(ids).toEqual([`${t!.train_id}-build`, `${t!.train_id}-build-2`]);
  });

  /** A car at BUILDING with its MERGE drone out (live: e388fc21, 2026-10-06). */
  async function carMerging(ns: string) {
    const { trainId, reported } = await oneTrain(ns, { live: true });
    await post(ns, "/internal/webhook/train-result", { trainId, passed: true, summary: "ok" });
    await settle(ns, reported);
    const s = await inspect(ns);
    const car = s.trains.find((t) => (t as unknown as { lane: string }).lane === "QUEUE")!;
    expect(s.tasks.at(-1)).toMatchObject({ trainId: car.train_id, action: "MERGE" });
    return { carId: car.train_id, memberId: trainId };
  }
  const droneIds = (ns: string) => runInDurableObject(stubFor(ns), (q: QueenNode) => [...(q.ports.dispatcher as RecordingDispatcher).instanceIds]);
  const failDrones = (ns: string, n: number) =>
    runInDurableObject(stubFor(ns), (q: QueenNode) => {
      (q.ports.dispatcher as RecordingDispatcher).failNext = n;
    });

  it("a MERGE infra failure retires the car after one round; its member re-boards a fresh car forked from main", async () => {
    const ns = newHive();
    const { carId, memberId } = await carMerging(ns);
    const r = await post(ns, "/internal/webhook/merge-result", {
      trainId: carId, ok: false, cause: "infra", merged: [], conflicts: [], fastForward: false, summary: "Merge drone failed: HttpError: HTTP Error: 503 Service Unavailable",
    });
    expect(await r.json()).toMatchObject({ outcome: "applied", train: { phase: "EJECTED" } });
    expect(await droneIds(ns)).not.toContain(`${carId}-merge-2`);
    const s = await inspect(ns);
    const cars = s.trains.filter((t) => (t as unknown as { lane: string }).lane === "QUEUE" && t.train_id !== carId);
    expect(cars).toHaveLength(1);
    expect(JSON.parse(String((cars[0] as unknown as { members: string }).members))).toEqual([memberId]);
    expect(cars[0]).toMatchObject({ fork_source: ns });
  });

  it("a re-dispatch whose Workflows create fails is retried within RECONCILE_DELAY_MS, even with a later alarm already armed", async () => {
    const ns = newHive();
    const { carId, memberId } = await carMerging(ns);
    // Fast path to LANDING: the LANDER is the drone that retries the same car on infra.
    const merged = await post(ns, "/internal/webhook/merge-result", { trainId: carId, ok: true, headSha: "c".repeat(40), baseSha: "b".repeat(40), merged: [memberId], fastForward: true });
    expect(await merged.json()).toMatchObject({ outcome: "applied", train: { phase: "LANDING" } });
    // The LANDER's watchdog alarm is ~10 min out.
    expect(await alarmAt(ns)).toBeGreaterThan(Date.now() + T / 2);
    await failDrones(ns, 1);
    const t0 = Date.now();
    const r = await post(ns, "/internal/webhook/land-result", { trainId: carId, landed: false, cause: "infra", summary: "Lander failed: HttpError: HTTP Error: 503 Service Unavailable" });
    expect(await r.json()).toMatchObject({ outcome: "applied", train: { phase: "LANDING" } });
    expect((await droneIds(ns)).filter((id) => id === `${carId}-land-2`)).toEqual([]); // create failed: no instance
    const armed = await alarmAt(ns);
    expect(armed).not.toBeNull();
    expect(armed!).toBeLessThanOrEqual(Date.now() + RECONCILE_DELAY_MS + 2_000);
    expect(armed!).toBeGreaterThanOrEqual(t0);
    expect(await runDurableObjectAlarm(stubFor(ns))).toBe(true);
    expect((await droneIds(ns)).at(-1)).toBe(`${carId}-land-2`);
    expect((await inspect(ns)).trains.find((t) => t.train_id === carId)).toMatchObject({ dispatched: 1 });
    // Dispatched: back on the ~10 min watchdog clock.
    expect(await alarmAt(ns)).toBeGreaterThan(Date.now() + T / 2);
  });

  it("a BUILDER infra re-dispatch whose create fails is retried as <train>-build-2 within RECONCILE_DELAY_MS", async () => {
    const ns = newHive();
    await submit(ns, "A");
    await settle(ns, new Set());
    const [t] = (await inspect(ns)).trains;
    const id = t!.train_id;
    expect(await droneIds(ns)).toEqual([`${id}-build`]);
    await failDrones(ns, 1);
    const r = await post(ns, "/internal/webhook/train-result", { trainId: id, passed: false, cause: "infra", summary: "rate limited: 3021", commandId: `${id}-build` });
    expect(await r.json()).toMatchObject({ outcome: "applied" });
    expect(await droneIds(ns)).toEqual([`${id}-build`]);
    expect(await alarmAt(ns)).toBeLessThanOrEqual(Date.now() + RECONCILE_DELAY_MS + 2_000);
    expect(await runDurableObjectAlarm(stubFor(ns))).toBe(true);
    expect(await droneIds(ns)).toEqual([`${id}-build`, `${id}-build-2`]);
  });

  it("an undispatched drone (no dispatch failure seen, e.g. a crash before create) is retried well before the 10 min watchdog", async () => {
    const ns = newHive();
    await submit(ns, "A");
    await failDrones(ns, 1);
    await settle(ns, new Set());
    const [t] = (await inspect(ns)).trains;
    expect(await droneIds(ns)).toEqual([]);
    // Lose the reconcile alarm ioFailed set: only the watchdog can bring the drone back.
    await runInDurableObject(stubFor(ns), (_q: QueenNode, state) => state.storage.deleteAlarm());
    await runInDurableObject(stubFor(ns), (q: QueenNode) => (q as unknown as { armWatchdog(): Promise<void> }).armWatchdog());
    const armed = await alarmAt(ns);
    expect(armed).not.toBeNull();
    expect(armed!).toBeLessThanOrEqual(Date.now() + RECONCILE_DELAY_MS + 2_000);
    expect(await runDurableObjectAlarm(stubFor(ns))).toBe(true);
    expect(await droneIds(ns)).toEqual([`${t!.train_id}-build`]);
  });

  it("TESTING waits only on its Queen-started gate (alarm at the gate deadline, not sooner); re-armed as soon as a command is issued", async () => {
    const ns = newHive();
    const { trainId } = await oneTrain(ns, { live: true });
    // TESTING with a live preview: no executor command outstanding, only the gate (GATE_TIMEOUT_MS watchdog).
    await runInDurableObject(stubFor(ns), (_q: QueenNode, state) => state.storage.deleteAlarm());
    const dup = await post(ns, "/internal/webhook/deploy-result", { commandId: `${trainId}-deploy-1`, op: "DEPLOY", environment: "preview", trainId, ok: true, url: previewUrl(trainId) });
    expect(await dup.json()).toMatchObject({ outcome: "ignored:duplicate", train: { phase: "TESTING" } });
    expect(await alarmAt(ns)).toBeGreaterThan(Date.now() + GATE_TIMEOUT_MS - 60_000);
    await post(ns, "/internal/webhook/train-result", { trainId, passed: false, summary: "smoke failed" });
    // Ejection issues DELETE + TEARDOWN (and a rework fork): armed again.
    expect(await alarmAt(ns)).not.toBeNull();
  });
});

/** One prompt merged to main as `mainSha`: a release is cut. Returns the staging DEPLOY. */
/** A supervised hive (releases park at AWAITING_TAP) with one landed train and its release. */
async function mergedRelease(ns: string, mainSha = "main-1") {
  const sup = await worker.fetch(`http://queen.test/hives/${ns}/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-queen-user": "kyle@kaikeru.com" },
    body: JSON.stringify({ autonomy: "supervised" }),
  });
  expect(sup.status).toBe(200);
  const { trainId, reported } = await oneTrain(ns, { live: true });
  await post(ns, "/internal/webhook/train-result", { trainId, passed: true, summary: "ok" });
  await landViaQueue(ns, trainId, reported, mainSha);
  const s = await inspect(ns);
  const staging = s.deploys.find((d): d is Extract<DeployCommand, { op: "DEPLOY" }> => d.op === "DEPLOY" && d.environment === "staging");
  expect(staging).toBeDefined();
  return { trainId, staging: staging! };
}

function tap(ns: string, releaseId: string, user?: string, extra: Record<string, string> = {}) {
  return worker.fetch(`http://queen.test/hives/${ns}/releases/${releaseId}/tap`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(user === undefined ? {} : { "x-queen-user": user }), ...extra },
    body: JSON.stringify({ releaseId }),
  });
}

const verdict = (c: SentinelCommand, v: "PROMOTE" | "ROLLBACK" = "PROMOTE") => ({
  commandId: c.commandId,
  releaseId: c.releaseId,
  environment: c.environment,
  verdict: v,
  metrics: { requests: 320, errorRate: 0, p99Ms: 40, baselineErrorRate: null },
  summary: v === "PROMOTE" ? "healthy" : "5xx spike",
});

describe("release train", () => {
  it("a merge cuts a release; staging -> validation -> AWAITING_TAP -> tap -> canary 1%, all over HTTP; snapshot lists releases", async () => {
    const ns = newHive();
    const { trainId, staging } = await mergedRelease(ns);
    const releaseId = staging.releaseId!;
    expect(staging).toEqual({ op: "DEPLOY", commandId: `${releaseId}-staging-1`, hive: ns, environment: "staging", releaseId, artifactRepo: ns, commitSha: "main-1" });
    let snap = await snapshotOf(ns);
    expect(snap.releases).toEqual([expect.objectContaining({ releaseId, phase: "STAGING", headSha: "main-1", trainIds: [trainId], hive: ns })]);

    // Herald reports staging without releaseId: resolved from the command id.
    const res = await post(ns, "/internal/webhook/deploy-result", { commandId: staging.commandId, op: "DEPLOY", environment: "staging", ok: true, url: `https://${ns}-staging.test.dev` });
    expect(await res.json()).toMatchObject({ outcome: "applied", release: { phase: "VALIDATING", stagingUrl: `https://${ns}-staging.test.dev` } });
    const [validate] = (await inspect(ns)).sentinels;
    expect(validate).toMatchObject({ commandId: `${releaseId}-validate-1`, environment: "staging", scriptName: `${ns}-staging`, windowSeconds: 60, minRequests: 100 });

    // Not tappable yet.
    expect((await tap(ns, releaseId, "kyle@kaikeru.com")).status).toBe(409);

    const v = await post(ns, "/internal/webhook/sentinel-verdict", verdict(validate!));
    expect(await v.json()).toMatchObject({ outcome: "applied", release: { phase: "AWAITING_TAP" } });
    expect(await (await post(ns, "/internal/webhook/sentinel-verdict", verdict(validate!))).json()).toMatchObject({ outcome: "ignored:duplicate" });

    // The tap route is a user route: no bearer token needed, but x-queen-user is.
    const anon = await tap(ns, releaseId);
    expect(anon.status).toBe(401);
    expect(await anon.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    expect((await tap(ns, releaseId, "   ", AUTH)).status).toBe(401);
    const ok = await tap(ns, releaseId, "kyle@kaikeru.com");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ outcome: "applied", release: { phase: "CANARY", tappedBy: "kyle@kaikeru.com" } });
    expect((await tap(ns, releaseId, "kyle@kaikeru.com")).status).toBe(409);
    expect((await tap(ns, "no-such-release", "kyle@kaikeru.com")).status).toBe(404);
    const mismatch = await worker.fetch(`http://queen.test/hives/${ns}/releases/${releaseId}/tap`, {
      method: "POST",
      headers: { "x-queen-user": "kyle@kaikeru.com" },
      body: JSON.stringify({ releaseId: "other" }),
    });
    expect(mismatch.status).toBe(400);

    const s = await inspect(ns);
    expect(s.deploys.at(-1)).toEqual({ op: "DEPLOY", commandId: `${releaseId}-canary1-1`, hive: ns, environment: "canary", releaseId, artifactRepo: ns, commitSha: "main-1", percent: 1 });
    snap = await snapshotOf(ns);
    expect(snap.releases?.[0]).toMatchObject({ phase: "CANARY", tappedBy: "kyle@kaikeru.com" });
    expect(snap.deployments?.find((d) => d.environment === "staging")).toMatchObject({ status: "LIVE", url: `https://${ns}-staging.test.dev` });
    expect(snap.deployments?.find((d) => d.environment === "canary")).toMatchObject({ status: "PENDING", percent: 1 });
  });

  it("the root alias routes the tap with the x-queen-hive header", async () => {
    const ns = newHive();
    const { staging } = await mergedRelease(ns);
    const res = await worker.fetch(`http://queen.test/releases/${staging.releaseId}/tap`, {
      method: "POST",
      headers: { "x-queen-hive": ns, "x-queen-user": "kyle@kaikeru.com" },
    });
    expect(res.status).toBe(409); // STAGING: wrong phase, but routed to the right hive
  });

  it("reportSentinelVerdict (RPC): NOT_FOUND for an unknown release, INVALID_INPUT for bad input, stale for an old command", async () => {
    const ns = newHive();
    const { staging } = await mergedRelease(ns);
    await stubFor(ns).reportDeployResult({ commandId: staging.commandId, op: "DEPLOY", environment: "staging", releaseId: staging.releaseId, ok: true, url: "https://s.test.dev" });
    const [validate] = (await inspect(ns)).sentinels;
    const good = verdict(validate!);
    expect(await rpcError(stubFor(ns).reportSentinelVerdict({ ...good, releaseId: "nope" }))).toMatch(/^NOT_FOUND: /);
    expect(await rpcError(stubFor(ns).reportSentinelVerdict({ ...good, verdict: "MAYBE" } as never))).toMatch(/^INVALID_INPUT: /);
    expect((await stubFor(ns).reportSentinelVerdict({ ...good, commandId: `${staging.releaseId}-validate-0` })).outcome).toBe("ignored:stale");
    expect((await stubFor(ns).reportSentinelVerdict(good)).outcome).toBe("applied");
    expect(await rpcError(stubFor(ns).reportDeployResult({ commandId: "unknown-cmd", op: "DEPLOY", environment: "canary", ok: true }))).toMatch(/^NOT_FOUND: /);
    expect((await post(ns, "/internal/webhook/sentinel-verdict", { ...good, summary: "x".repeat(501) })).status).toBe(400);
  });

  it("broadcasts release.updated and sentinel.verdict to the War Room", async () => {
    const ns = newHive();
    const { ws, next } = await connect(`/hives/${ns}/room`);
    await next();
    const { staging } = await mergedRelease(ns);
    expect(await next((m) => m.type === "release.updated")).toMatchObject({ release: { phase: "STAGING", releaseId: staging.releaseId } });
    await post(ns, "/internal/webhook/deploy-result", { commandId: staging.commandId, op: "DEPLOY", environment: "staging", ok: true, url: "https://s.test.dev" });
    const [validate] = (await inspect(ns)).sentinels;
    await post(ns, "/internal/webhook/sentinel-verdict", verdict(validate!));
    expect(await next((m) => m.type === "sentinel.verdict")).toMatchObject({ verdict: { verdict: "PROMOTE", releaseId: staging.releaseId } });
    expect(await next((m) => m.type === "release.updated")).toMatchObject({ release: { phase: "AWAITING_TAP" } });
    ws.close(1000, "done");
  });

  it("persists the latest verdict per (release, environment) and serves it in the snapshot", async () => {
    const ns = newHive();
    const { staging } = await mergedRelease(ns);
    await post(ns, "/internal/webhook/deploy-result", { commandId: staging.commandId, op: "DEPLOY", environment: "staging", ok: true, url: "https://s.test.dev" });
    const [validate] = (await inspect(ns)).sentinels;
    await post(ns, "/internal/webhook/sentinel-verdict", verdict(validate!));
    // A fresh connection (page reload) gets the verdict in its snapshot.
    const { ws, next } = await connect(`/hives/${ns}/room`);
    const snap = (await next()) as { type: string; verdicts?: { releaseId: string; environment: string; verdict: string }[] };
    expect(snap.type).toBe("snapshot");
    expect(snap.verdicts).toEqual([expect.objectContaining({ releaseId: staging.releaseId, environment: "staging", verdict: "PROMOTE" })]);
    ws.close(1000, "done");
  });

  it("the watchdog alarm covers release commands", async () => {
    const ns = newHive();
    const { staging } = await mergedRelease(ns);
    await runInDurableObject(stubFor(ns), (q: QueenNode) => {
      (q as unknown as { clockOffset: number }).clockOffset = 600_000 + 2_000;
    });
    expect(await runDurableObjectAlarm(stubFor(ns))).toBe(true);
    const ids = (await inspect(ns)).deploys.filter((d) => d.op === "DEPLOY" && d.environment === "staging").map((d) => d.commandId);
    expect(ids).toEqual([staging.commandId, `${staging.releaseId}-staging-2`]);
  });
});

describe("validation", () => {
  it("rejects invalid payloads with 400 / 404", async () => {
    const ns = newHive();
    const cases: [string, unknown, number][] = [
      ["/prompts", {}, 400],
      ["/prompts", "{not json", 400],
      ["/prompts", { namespace: "other", promptText: "x" }, 400],
      ["/internal/webhook/train-result", { trainId: "t", passed: "yes", summary: "" }, 400],
      ["/internal/webhook/train-result", { trainId: "missing", passed: true, summary: "" }, 404],
      ["/internal/webhook/land-result", { trainId: "t", landed: true }, 400],
      ["/internal/webhook/provision-result", { commandId: "c", op: "FORK", trainId: "t", ok: "yes" }, 400],
      ["/internal/webhook/provision-result", { commandId: "c", op: "FORK", trainId: "missing", ok: true }, 404],
      ["/internal/webhook/deploy-result", { commandId: "c", op: "DEPLOY", environment: "preview", ok: true, url: "nope" }, 400],
      ["/internal/webhook/deploy-result", { commandId: "c", op: "DEPLOY", environment: "preview", ok: true }, 404],
      ["/audit", { promptId: "p", droneRole: "BUILDER", status: "ok" }, 400],
      ["/audit", { promptId: "missing", droneRole: "BUILDER", status: "RUNNING" }, 404],
      ["/scribe", { summary: "no ids" }, 400],
    ];
    for (const [path, body, status] of cases) {
      const res = await post(ns, path, body);
      expect([path, res.status]).toEqual([path, status]);
      const json = await res.json<{ error: { code: string } }>();
      expect(json.error.code).toBe(status === 404 ? "NOT_FOUND" : "INVALID_INPUT");
    }
    expect((await worker.fetch("http://q/hives/bad%20name/snapshot")).status).toBe(400);
  });

  it("rejects Scribe summaries over 500 characters", async () => {
    const ns = newHive();
    const a = await submit(ns, "A");
    const long = "x".repeat(501);
    expect((await post(ns, "/scribe", { promptId: a, summary: long })).status).toBe(400);
    const [t] = (await inspect(ns)).trains;
    expect((await post(ns, "/internal/webhook/train-result", { trainId: t!.train_id, passed: true, summary: long })).status).toBe(400);
    // The DO validates RPC input too, and the typed error survives the stub boundary.
    expect(await rpcError(stubFor(ns).recordScribeSummary({ promptId: a, summary: long }))).toMatch(/^INVALID_INPUT: /);
    expect((await post(ns, "/scribe", { promptId: a, summary: "x".repeat(500) })).status).toBe(200);
  });

  it("rejects a prompt for another namespace over RPC with CONFLICT", async () => {
    const ns = newHive();
    await submit(ns, "A");
    expect(await rpcError(stubFor(ns).submitPrompt({ namespace: newHive(), promptText: "x" }))).toMatch(/^CONFLICT: /);
  });
});

describe("War Room WebSocket", () => {
  it("sends a snapshot on connect, then train.updated broadcasts", async () => {
    const ns = newHive();
    await submit(ns, "existing");
    const { ws, next } = await connect(`/hives/${ns}/room`);
    const snap = await next();
    expect(snap.type).toBe("snapshot");
    if (snap.type === "snapshot") expect(snap.promptRuns).toHaveLength(1);

    const [t] = (await inspect(ns)).trains;
    await settle(ns, new Set());
    await post(ns, "/internal/webhook/build-result", { trainId: t!.train_id, headSha: "h" });
    const upd = await next((m) => m.type === "train.updated" && m.train.phase === "DEPLOYING");
    expect(upd).toMatchObject({ type: "train.updated", train: { trainId: t!.train_id, status: "TESTING", phase: "DEPLOYING" } });
    expect(await next((m) => m.type === "deployment.updated")).toMatchObject({ deployment: { trainId: t!.train_id, status: "PENDING" } });
    ws.close(1000, "done");
  });

  it("handles submit_prompt, ping and subscribe; replies with error frames for bad input", async () => {
    const ns = newHive();
    const { ws, next } = await connect(`/ws?namespace=${ns}`);
    expect((await next()).type).toBe("snapshot");

    ws.send(JSON.stringify({ type: "ping" }));
    expect(await next()).toEqual({ type: "pong" });

    ws.send(JSON.stringify({ type: "submit_prompt", prompt: { namespace: ns, promptText: "via ws" } }));
    expect(await next((m) => m.type === "prompt.updated")).toMatchObject({ promptRun: { promptText: "via ws", namespace: ns } });

    ws.send("{oops");
    expect(await next((m) => m.type === "error")).toMatchObject({ code: "INVALID_INPUT", message: "invalid JSON" });
    ws.send(JSON.stringify({ type: "nope" }));
    expect(await next((m) => m.type === "error")).toMatchObject({ code: "INVALID_INPUT" });
    ws.send(JSON.stringify({ type: "submit_prompt", prompt: { namespace: "elsewhere", promptText: "x" } }));
    expect(await next((m) => m.type === "error")).toMatchObject({ code: "CONFLICT" });
    ws.send(JSON.stringify({ type: "subscribe", namespace: "elsewhere" }));
    expect(await next((m) => m.type === "error")).toMatchObject({ code: "CONFLICT" });

    ws.send(JSON.stringify({ type: "subscribe" }));
    const snap = await next((m) => m.type === "snapshot");
    if (snap.type === "snapshot") expect(snap.promptRuns.map((p) => p.promptText)).toEqual(["via ws"]);
    ws.close(1000, "done");
  });

  it("closes with 1009 on oversized frames", async () => {
    const { ws, next } = await connect(`/hives/${newHive()}/room`);
    await next();
    const closed = new Promise<number>((r) => ws.addEventListener("close", (e) => r(e.code)));
    ws.send("x".repeat(70 * 1024));
    expect(await closed).toBe(1009);
  });

  it("answers the literal 'ping' heartbeat with 'pong'", async () => {
    const res = await worker.fetch(`http://q/hives/${newHive()}/room`, { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket!;
    const pong = new Promise<string>((r) =>
      ws.addEventListener("message", (e) => {
        if (e.data === "pong") r(e.data);
      }),
    );
    ws.accept();
    ws.send("ping");
    expect(await pong).toBe("pong");
    ws.close(1000, "done");
  });
});

describe("hive memory", () => {
  const mem = (over: Partial<RecalledMemory> = {}): RecalledMemory => ({
    memoryId: "old:aaaaaaaaaaaa",
    trainId: "old",
    promptId: "p-old",
    outcome: "FAILED",
    promptText: "add retries",
    text: "Prompt: add retries. Gate: security rejected an unbounded retry loop.",
    createdAt: 1,
    score: 0.81,
    ...over,
  });

  it("forks with recallQuery, persists the recalled memories, exposes them and feeds the builder's ragContext", async () => {
    const ns = newHive();
    await submit(ns, "add retries to the fetch client");
    const s0 = await inspect(ns);
    const fork = s0.provisions[0] as Fork;
    expect(fork.recallQuery).toBe("add retries to the fetch client");
    const memories = [mem(), mem({ memoryId: "older:bbbbbbbbbbbb", outcome: "PASSED", text: "Prompt: add a cap. Gate: passed.", score: 0.7 })];
    const res = await post(ns, "/internal/webhook/provision-result", {
      commandId: fork.commandId,
      op: "FORK",
      trainId: fork.trainId,
      ok: true,
      artifactRepo: fork.forkName,
      baseSha: "b",
      memories,
    });
    expect(await res.json()).toMatchObject({ outcome: "applied", train: { trainId: fork.trainId, memories } });
    const s1 = await inspect(ns);
    expect(JSON.parse(String((s1.trains[0] as unknown as { memories: string }).memories))).toEqual(memories);
    expect(s1.tasks.at(-1)!.ragContext).toEqual([
      "[FAILED] Prompt: add retries. Gate: security rejected an unbounded retry loop.",
      "[PASSED] Prompt: add a cap. Gate: passed.",
    ]);
    expect((await snapshotOf(ns)).trains[0]!.memories).toEqual(memories);
  });

  it("a FORK result without memories stores [] and a train broadcast carries it", async () => {
    const ns = newHive();
    const { ws, next } = await connect(`/hives/${ns}/room`);
    await next();
    await submit(ns, "A");
    await settle(ns, new Set());
    const upd = await next((m) => m.type === "train.updated" && m.train.phase === "BUILDING" && m.train.baseSha !== "");
    expect(upd).toMatchObject({ type: "train.updated", train: { memories: [] } });
    expect((await inspect(ns)).tasks[0]!.ragContext).toEqual([]);
    ws.close(1000, "done");
  });

  it("degrades malformed stored memories to [] (bad JSON, non-array, invalid entries dropped)", async () => {
    const ns = newHive();
    await submit(ns, "A");
    const good = mem();
    const read = (raw: string | null) =>
      runInDurableObject(stubFor(ns), (q: QueenNode) => {
        q.sql.exec("UPDATE merge_trains SET memories = ?", raw);
        return q.getSnapshot().trains[0]!.memories;
      });
    expect(await read("{not json")).toEqual([]);
    expect(await read('{"a":1}')).toEqual([]);
    expect(await read(null)).toEqual([]);
    expect(await read(JSON.stringify([{ nope: true }, good]))).toEqual([good]);
  });
});

describe("hibernation-ish", () => {
  it("keeps per-socket state in tags + attachments and re-runs migrations idempotently", async () => {
    const ns = newHive();
    const { ws, next } = await connect(`/hives/${ns}/room?role=drone`);
    await next();
    const state = await runInDurableObject(stubFor(ns), (q: QueenNode, ctx) => {
      const sockets = ctx.getWebSockets("role:drone");
      // Simulate a wake: the constructor's migration must be a cheap no-op.
      const before = q.sql.exec("SELECT COUNT(*) AS n FROM _migrations").one().n;
      const version = migrate(ctx.storage);
      const after = q.sql.exec("SELECT COUNT(*) AS n FROM _migrations").one().n;
      return {
        count: sockets.length,
        tags: ctx.getTags(sockets[0]!),
        attachment: sockets[0]!.deserializeAttachment() as SocketAttachment,
        before,
        after,
        version,
        tables: q.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name").toArray().map((r) => r.name),
      };
    });
    expect(state.count).toBe(1);
    expect(state.tags).toEqual(["role:drone", `hive:${ns}`]);
    expect(state.attachment).toMatchObject({ role: "drone", hive: ns, subscribed: true });
    expect([state.before, state.after, state.version]).toEqual([18, 18, 18]);
    expect(state.tables).toEqual([
      "attempts", "audit_trail", "deployments", "escalations", "event_log", "hive_settings", "inboxes", "merge_trains", "metrics_hourly", "model_preference", "model_router",
      "model_stats", "path_claims", "prompt_runs", "races", "releases", "repo_deletes", "sentinel_verdicts", "sqlite_sequence", "submissions", "work_items",
    ]);
    ws.close(1000, "done");
  });
});

describe("model router (DO)", () => {
  const DS_FLASH = "@cf/deepseek-ai/deepseek-v4-flash-0731";
  const GLM_FLASH = "@cf/zai-org/glm-5.3-flash";

  it("dispatches with a modelChoice, persists model stats once per result, and broadcasts models.updated + the floor", async () => {
    const ns = newHive();
    await submit(ns, "add a health route");
    const { ws, next } = await connect(`/hives/${ns}/room`);
    const first = await next();
    expect(first).toMatchObject({ type: "snapshot", modelStats: [], routerFloor: { tier: "fast", streak: 0, backoffAfter: 3, probeIn: null } });

    const reported = new Set<string>();
    await settle(ns, reported);
    let s = await inspect(ns);
    const task = s.tasks.find((t) => t.role === "BUILDER")!;
    expect(task.modelChoice).toMatchObject({ model: DS_FLASH, tier: "fast", role: "builder" });
    const trainId = s.trains[0]!.train_id;
    let row = (await runInDurableObject(stubFor(ns), (q: QueenNode) => q.sql.exec("SELECT model, model_reason FROM merge_trains").one())) as { model: string; model_reason: string };
    expect(row).toEqual({ model: DS_FLASH, model_reason: task.modelChoice!.reason });

    // The chosen model returned junk; the first fallback built the head.
    const built = await post(ns, "/internal/webhook/build-result", { trainId, headSha: "h1", model: GLM_FLASH, failedModels: [DS_FLASH], buildMs: 4100 });
    expect(await built.json()).toMatchObject({ outcome: "applied", train: { model: GLM_FLASH } });
    const upd = await next((m) => m.type === "models.updated");
    expect(upd).toMatchObject({ type: "models.updated", floor: { tier: "frontier", streak: 0, probeIn: 4 } });
    if (upd.type === "models.updated") {
      expect(upd.stats).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ model: DS_FLASH, role: "builder", attempts: 1, passes: 0, failures: 1 }),
          expect.objectContaining({ model: GLM_FLASH, role: "builder", attempts: 1, passes: 0, failures: 0, avgBuildMs: 4100 }),
        ]),
      );
      expect(upd.stats[0]).not.toHaveProperty("failStreak");
    }

    await settle(ns, reported);
    const pass = { trainId, passed: true, summary: "green", commitSha: "h1" };
    expect(await (await post(ns, "/internal/webhook/train-result", pass)).json()).toMatchObject({ outcome: "applied" });
    expect(await (await post(ns, "/internal/webhook/train-result", pass)).json()).toMatchObject({ outcome: "ignored:duplicate" });
    // A duplicate build-result is ignored too.
    await post(ns, "/internal/webhook/build-result", { trainId, headSha: "h1", model: GLM_FLASH, buildMs: 1 });

    const snap = await snapshotOf(ns);
    expect(snap.modelStats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: GLM_FLASH, attempts: 1, passes: 1, failures: 0, avgBuildMs: 4100 }),
        expect.objectContaining({ model: DS_FLASH, attempts: 1, passes: 0, failures: 1 }),
      ]),
    );
    expect(snap.modelStats).toHaveLength(2);
    expect(snap.routerFloor).toEqual({ tier: "frontier", streak: 0, backoffAfter: 3, probeIn: 4 });
    expect(snap.trains[0]).toMatchObject({ model: GLM_FLASH, modelReason: expect.stringContaining("fell back to") });
    row = (await runInDurableObject(stubFor(ns), (q: QueenNode) => q.sql.exec("SELECT model, model_reason FROM merge_trains WHERE lane = 'BUILD'").one())) as typeof row;
    expect(row.model).toBe(GLM_FLASH);
    ws.close(1000, "done");

    // The next first-attempt build routes at the raised floor, and says why.
    await submit(ns, "add a metrics route");
    await settle(ns, reported);
    s = await inspect(ns);
    const second = s.tasks.filter((t) => t.role === "BUILDER").at(-1)!;
    expect(second.modelChoice).toMatchObject({ tier: "frontier" });
    expect(second.modelChoice!.reason).toMatch(/^raised to frontier after an unusable change set · frontier tier/);
  });

  it("reads MODEL_ROUTER_PIN_BUILDER, ROUTER_BACKOFF_STREAK and ROUTER_PROBE_AFTER", () => {
    expect(modelPin({})).toBeNull();
    expect(modelPin({ MODEL_ROUTER_PIN_BUILDER: "  " })).toBeNull();
    expect(modelPin({ MODEL_ROUTER_PIN_BUILDER: " @cf/zai-org/glm-5.3 " })).toBe("@cf/zai-org/glm-5.3");
    expect(routerPolicy({})).toEqual({ backoffStreak: 3, probeAfter: 4 });
    expect(routerPolicy({ ROUTER_BACKOFF_STREAK: "5", ROUTER_PROBE_AFTER: "2" })).toEqual({ backoffStreak: 5, probeAfter: 2 });
    expect(routerPolicy({ ROUTER_BACKOFF_STREAK: "0", ROUTER_PROBE_AFTER: "x" })).toEqual({ backoffStreak: 3, probeAfter: 4 });
  });
});

describe("appendAudits (batched ledger entries)", () => {
  it("writes the entries in order in one call, and rejects the whole batch when one is bad", async () => {
    const ns = newHive();
    const stub = stubFor(ns);
    const { promptId } = await stub.submitPrompt({ namespace: ns, promptText: "Add a /health endpoint" });
    const events = await stub.appendAudits([
      { promptId, droneRole: "POLICY", status: "RUNNING" },
      { promptId, droneRole: "SECURITY", status: "RUNNING" },
      { promptId, droneRole: "POLICY", status: "PASSED" },
    ]);
    expect(events.map((e) => `${e.droneRole}:${e.status}`)).toEqual(["POLICY:RUNNING", "SECURITY:RUNNING", "POLICY:PASSED"]);
    expect(await rpcError(stub.appendAudits([{ promptId, droneRole: "SCRIBE", status: "PASSED" }, { promptId: "nope", droneRole: "SCRIBE", status: "PASSED" }]))).toMatch(/^NOT_FOUND: /);
    expect(await rpcError(stub.appendAudits([]))).toMatch(/^INVALID_INPUT: /);
    await runInDurableObject(stub, (q: QueenNode) => {
      expect(q.sql.exec("SELECT COUNT(*) AS n FROM audit_trail").one().n).toBe(3);
      expect(q.getSnapshot().recentAudit.map((e) => e.eventId).sort()).toEqual(events.map((e) => e.eventId).sort());
    });
    const http = await worker.fetch(`http://queen.test/hives/${ns}/audits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ promptId, droneRole: "SCRIBE", status: "PASSED" }]),
    });
    expect(http.status).toBe(201);
  });
});

describe("v2 surface (routes and RPCs, §3.6)", () => {
  const user = { "x-queen-user": "kyle@kaikeru.com" };
  const req = (ns: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    worker.fetch(`http://queen.test/hives/${ns}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("files a goal, takes the Oracle's answer, and serves items, events, traces, metrics and the queue", async () => {
    const ns = newHive();
    expect((await req(ns, "PATCH", "/settings", { autonomy: "supervised" })).status).toBe(401);
    const patched = await req(ns, "PATCH", "/settings", { guardrails: { maxQueueBatch: 2 } }, user);
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ hive: ns, settings: { guardrails: { maxQueueBatch: 2 } }, effectiveAutonomy: "autonomous" });

    const res = await req(ns, "POST", "/prompts", { namespace: ns, promptText: "- Add a /health endpoint\n- Add a /version endpoint", decompose: true });
    expect(res.status).toBe(201);
    const { item: goal, promptRun } = await res.json<{ item: { itemId: string; kind: string; status: string; traceId: string }; promptRun: { promptId: string; status: string } }>();
    expect(goal).toMatchObject({ kind: "goal", status: "DECOMPOSING" });
    expect(promptRun).toMatchObject({ promptId: goal.itemId, status: "QUEUED" });
    const oracle = await runInDurableObject(stubFor(ns), (q: QueenNode) => (q.ports.oracle as unknown as { commands: { op: string; commandId: string }[] }).commands.map((c) => ({ ...c })));
    expect(oracle).toEqual([expect.objectContaining({ op: "DECOMPOSE", commandId: `${goal.itemId}-decompose-1` })]);

    const answer = {
      commandId: `${goal.itemId}-decompose-1`,
      op: "DECOMPOSE",
      itemId: goal.itemId,
      ok: true,
      children: [
        { key: "c1", kind: "feature", title: "Add a /health endpoint", body: "", paths: ["src/features/health.js"] },
        { key: "c2", kind: "feature", title: "Add a /version endpoint", body: "", dependsOn: ["c1"] },
      ],
    };
    const ok = await post(ns, "/internal/webhook/oracle-result", answer);
    expect(await ok.json()).toEqual({ outcome: "applied" });
    expect(await (await post(ns, "/internal/webhook/oracle-result", answer)).json()).toEqual({ outcome: "ignored:duplicate" });
    expect((await post(ns, "/internal/webhook/oracle-result", { ...answer, itemId: "nope" })).status).toBe(404);
    expect((await req(ns, "POST", "/internal/webhook/oracle-result", answer)).status).toBe(401);

    const detail = await (await req(ns, "GET", `/items/${goal.itemId}`)).json<{ item: { status: string }; children: { itemId: string; status: string }[] }>();
    expect(detail.item.status).toBe("ACTIVE");
    expect(detail.children.map((c) => [c.itemId, c.status])).toEqual([
      [`${goal.itemId}-c1`, "ACTIVE"],
      [`${goal.itemId}-c2`, "BLOCKED"],
    ]);
    expect((await req(ns, "GET", "/items/nope")).status).toBe(404);
    const c1 = await (await req(ns, "GET", `/items/${goal.itemId}-c1`)).json<{ trains: { trainId: string; traceId: string }[] }>();
    expect(c1.trains).toHaveLength(1);
    expect(c1.trains[0]!.traceId).toBe(goal.traceId);

    const evs = await (await req(ns, "GET", `/events?item=${goal.itemId}-c1&limit=50`)).json<{ events: { type: string; traceId: string }[] }>();
    expect(evs.events.map((e) => e.type)).toEqual(expect.arrayContaining(["item.filed", "item.status", "train.enqueued", "command.issued"]));
    expect(evs.events.every((e) => e.traceId === goal.traceId)).toBe(true);
    const trace = await (await req(ns, "GET", `/traces/${goal.traceId}`)).json<{ traceId: string; spans: { kind: string }[]; events: unknown[] }>();
    expect(trace.traceId).toBe(goal.traceId);
    expect(trace.spans.map((s) => s.kind)).toEqual(expect.arrayContaining(["item", "train", "command"]));
    expect((await req(ns, "GET", "/traces/not-a-trace")).status).toBe(400);

    const metrics = await (await req(ns, "GET", "/metrics?window=24h")).json<{ rollups: { name: string }[]; hive: { headline: string; mode?: string }; source: string }>();
    expect(metrics.rollups.map((r) => r.name)).toEqual(expect.arrayContaining(["items_filed", "active_builds"]));
    expect(metrics.hive.headline).toBe("SHIPPING");
    expect(metrics.hive.mode).toBe("live");
    expect((await req(ns, "GET", "/metrics?window=1y")).status).toBe(400);
    expect(await (await req(ns, "GET", "/queue")).json()).toEqual({ cars: [], waiting: [], conflicts: [], bisects: [] });

    // The snapshot carries the v2 fields.
    const snap = await snapshotOf(ns);
    expect(snap.items?.map((i) => i.kind)).toEqual(["goal", "feature", "feature"]);
    expect(snap.hive).toMatchObject({ hive: ns, counts: { ACTIVE: 2, BLOCKED: 1 } });
    expect(snap.trains[0]).toMatchObject({ traceId: goal.traceId });
    expect(snap.recentEvents?.length).toBeGreaterThan(0);

    // Gatekeepers resolve a pushed repo to its train.
    const [t] = (await inspect(ns)).trains;
    expect(await stubFor(ns).getGateTarget(t!.artifact_repo)).toMatchObject({ trainId: t!.train_id, lane: "BUILD", promptId: `${goal.itemId}-c1`, traceId: goal.traceId });
    expect(await stubFor(ns).getGateTarget("no-such-repo")).toBeNull();
    expect((await post(ns, "/internal/webhook/merge-result", { trainId: "nope", ok: true })).status).toBe(404);
  });

  it("files items, takes item actions and resolves escalations as user routes", async () => {
    const ns = newHive();
    const anon = await req(ns, "POST", "/items", { kind: "bug", title: "x" });
    expect(anon.status).toBe(401);
    const a = await req(ns, "POST", "/items", { kind: "feature", title: "Add /a" }, user);
    expect(a.status).toBe(201);
    const { item } = await a.json<{ item: { itemId: string; status: string; source: { actor: string } } }>();
    expect(item).toMatchObject({ status: "ACTIVE", source: { actor: "user:kyle@kaikeru.com" } });
    expect((await req(ns, "POST", "/items", { kind: "feature", title: "Add /b", dependsOn: ["nope"] }, user)).status).toBe(400);
    const b = await (await req(ns, "POST", "/items", { kind: "feature", title: "Add /b", dependsOn: [item.itemId] }, user)).json<{ item: { itemId: string; status: string } }>();
    expect(b.item.status).toBe("BLOCKED");
    expect((await req(ns, "POST", `/items/${item.itemId}/actions`, { action: "cancel" }, user)).status).toBe(409);
    const cancel = await req(ns, "POST", `/items/${b.item.itemId}/actions`, { action: "cancel", note: "not needed" }, user);
    expect(await cancel.json()).toMatchObject({ outcome: "applied", item: { status: "CANCELLED" } });
    expect((await req(ns, "POST", "/escalations/nope/resolve", { action: "ack" }, user)).status).toBe(404);
    expect((await req(ns, "POST", "/escalations/nope/resolve", { action: "ack" })).status).toBe(401);
  });
});

import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { DeployCommand, DroneTask, ProvisionCommand, QueenServerMessage } from "@queenos/queen-types";
import type { QueenNode, SocketAttachment } from "../src/queen-node";
import { migrate } from "../src/db";
import type { RecordingDispatcher, RecordingHerald, RecordingProvisioner } from "./fakes";

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
    const provisions = provisioner.commands.map((c) => ({ ...c })) as ProvisionCommand[];
    const deploys = herald.commands.map((c) => ({ ...c })) as DeployCommand[];
    return {
      provisions,
      deploys,
      forks: provisions.filter((c): c is Fork => c.op === "FORK").map((c) => ({ source: c.sourceRepo, name: c.forkName, commandId: c.commandId, trainId: c.trainId })),
      deleted: provisions.flatMap((c) => (c.op === "DELETE" ? [c.repo] : [])),
      tasks: drones.tasks.map((t) => ({ ...t })) as DroneTask[],
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
        if (c.op !== "DEPLOY" || reported.has(c.commandId)) continue;
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

async function connect(path: string): Promise<{ ws: WebSocket; next: (pred?: (m: QueenServerMessage) => boolean) => Promise<QueenServerMessage> }> {
  const res = await worker.fetch(`http://queen.test${path}`, { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const inbox: QueenServerMessage[] = [];
  ws.addEventListener("message", (e) => {
    if (e.data !== "pong") inbox.push(JSON.parse(e.data as string));
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
  it("submitting 3 prompts creates 3 cumulative trains with chained forks", async () => {
    const ns = newHive();
    const [a, b, c] = [await submit(ns, "A"), await submit(ns, "B"), await submit(ns, "C")];
    let s = await inspect(ns);
    expect(s.trains.map((t) => JSON.parse(t.included_prompts))).toEqual([[a], [a, b], [a, b, c]]);
    expect(s.trains.map((t) => t.status)).toEqual(["BUILDING", "BUILDING", "BUILDING"]);
    const [t1, t2, t3] = s.trains;
    expect(t1!.artifact_repo).toMatch(new RegExp(`^${ns}-train-[0-9a-f]{12}$`));
    // The Queen only dispatches the fork; nothing is built until the Provisioner reports.
    expect(s.forks).toEqual([{ source: ns, name: t1!.artifact_repo, commandId: `${t1!.train_id}-fork-1`, trainId: t1!.train_id }]);
    expect(s.tasks).toEqual([]);
    const reported = new Set<string>();
    await settle(ns, reported);
    s = await inspect(ns);
    expect(s.tasks).toEqual([
      expect.objectContaining({ trainId: t1!.train_id, promptId: a, role: "BUILDER", action: "BUILD", ragContext: [] }),
    ]);

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
    expect(s.forks.map((f) => f.source)).toEqual([ns, t1!.artifact_repo, t2!.artifact_repo]);
    expect(s.forks.map((f) => f.name)).toEqual([t1!.artifact_repo, t2!.artifact_repo, t3!.artifact_repo]);
    expect(s.tasks.map((t) => t.promptId)).toEqual([a, b, c]);
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

    // B fails: B ejected (rework), C superseded and re-provisioned as main+[A,C].
    const fail = await post(ns, "/internal/webhook/train-result", { trainId: t2!.train_id, passed: false, summary: "B: 3 tests failed" });
    expect(await fail.json()).toMatchObject({ outcome: "applied", train: { status: "EJECTED" } });
    let s = await inspect(ns);
    const byId = Object.fromEntries(s.trains.map((t) => [t.train_id, t]));
    expect(byId[t2!.train_id]!.status).toBe("EJECTED");
    expect(byId[t3!.train_id]!.status).toBe("EJECTED");
    expect(s.deleted).toEqual([t2!.artifact_repo, t3!.artifact_repo]);
    const active = s.trains.filter((t) => t.status !== "EJECTED");
    expect(active.map((t) => JSON.parse(t.included_prompts))).toEqual([[a], [a, c], [a, c, b]]);
    expect(s.prompts).toContainEqual({ prompt_id: b, status: "QUEUED", summary: "B: 3 tests failed", attempts: 1 });

    // A passes (via the /trains/:id/result alias) -> head lands through a LANDER drone.
    const pass = await post(ns, `/trains/${t1!.train_id}/result`, { passed: true, summary: "A green", commitSha: "h-a" });
    expect(await pass.json()).toMatchObject({ outcome: "applied", train: { status: "TESTING" } });
    s = await inspect(ns);
    expect(s.tasks.at(-1)).toMatchObject({ trainId: t1!.train_id, role: "LANDER", action: "LAND", baseRef: "h-a" });

    const landed = await post(ns, "/internal/webhook/land-result", { trainId: t1!.train_id, landed: true, mainSha: "main-1" });
    expect(await landed.json()).toMatchObject({ outcome: "applied", train: { status: "MERGED" } });
    s = await inspect(ns);
    expect(s.prompts.find((p) => p.prompt_id === a)!.status).toBe("MERGED");
    expect(s.deleted).toContain(t1!.artifact_repo);

    // A late result for the superseded train is ignored idempotently.
    const late = await post(ns, "/internal/webhook/train-result", { trainId: t3!.train_id, passed: true, summary: "late" });
    expect(await late.json()).toMatchObject({ outcome: "ignored:stale", train: { status: "EJECTED" } });

    // A REWORK drone carries the Scribe summary once B's new train forks.
    await settle(ns, reported);
    const cTrain = active[1]!;
    await post(ns, "/internal/webhook/build-result", { trainId: cTrain.train_id, headSha: "h-c2" });
    await settle(ns, reported);
    s = await inspect(ns);
    expect(s.tasks.at(-1)).toMatchObject({ promptId: b, action: "REWORK", scribeSummary: "B: 3 tests failed" });
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
    expect(await pass.json()).toMatchObject({ outcome: "applied", train: { phase: "LANDING" } });
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
    const { trainId } = await oneTrain(ns, { live: true });
    await post(ns, "/internal/webhook/train-result", { trainId, passed: true, summary: "ok" });
    await post(ns, "/internal/webhook/land-result", { trainId, landed: true, mainSha: "m1" });
    const s = await inspect(ns);
    expect(s.deploys.at(-1)).toEqual({ op: "TEARDOWN", commandId: `${trainId}-teardown-1`, hive: ns, environment: "preview", trainId });
    expect(s.trains[0]).toMatchObject({ phase: "MERGED", deploy_state: "TEARING_DOWN", preview_url: previewUrl(trainId) });

    const td = { commandId: `${trainId}-teardown-1`, op: "TEARDOWN", environment: "preview", ok: true };
    expect(await (await post(ns, "/internal/webhook/deploy-result", td)).json()).toMatchObject({ outcome: "applied", train: { status: "MERGED" } });
    expect(await (await post(ns, "/internal/webhook/deploy-result", td)).json()).toMatchObject({ outcome: "ignored:duplicate" });
    expect((await snapshotOf(ns)).deployments?.[0]).toMatchObject({ status: "TORN_DOWN" });
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
    expect([state.before, state.after, state.version]).toEqual([2, 2, 2]);
    expect(state.tables).toEqual(["audit_trail", "deployments", "merge_trains", "prompt_runs"]);
    ws.close(1000, "done");
  });
});

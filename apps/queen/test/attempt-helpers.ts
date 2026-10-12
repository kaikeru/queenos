/** Shared helpers of the MCP attempt tests (docs/superpowers/specs/2026-10-12-queenos-mcp-design.md). */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import type { AttemptIntentDecision, DeployCommand, McpAgentIdentity, ProvisionCommand } from "@queenos/queen-types";
import type { QueenNode } from "../src/queen-node";
import type { RecordingHerald, RecordingProvisioner } from "./fakes";

export const OWNER = "ada@example.com";
export const OTHER = "bob@example.com";
export const MODEL = "claude-opus-5-5";
export const BASE_SHA = "b".repeat(40);
export type Row = Record<string, unknown>;

export const stubFor = (ns: string) => env.QUEEN_NODE.get(env.QUEEN_NODE.idFromName(ns));
export const newHive = () => `att-${crypto.randomUUID().slice(0, 8)}`;
let n = 0;
export const sha = () => (0xa70000 + ++n).toString(16).padStart(40, "0");
export function agent(over: Partial<McpAgentIdentity> = {}): McpAgentIdentity {
  return { agentId: `ag_${(0x1000 + ++n).toString(16).padStart(32, "0")}`, name: "opus", model: MODEL, role: "worker", owner: OWNER, ...over };
}
export const rpcError = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e.message);

export async function externalHive(opts: { guardrails?: Record<string, number>; race?: { entryWindowMs?: number; judge?: "auto" | "human" } } = {}) {
  const ns = newHive();
  const stub = stubFor(ns);
  await stub.updateSettings({ hive: ns, user: OWNER, patch: { executors: "external", ...(opts.guardrails ? { guardrails: opts.guardrails } : {}), ...(opts.race ? { race: opts.race } : {}) } as never });
  return { ns, stub };
}

export async function fileItem(ns: string, title = "Tip jar", parentId?: string): Promise<string> {
  const { item } = await stubFor(ns).fileWorkItem({ hive: ns, user: OWNER, item: { kind: "feature", title, ...(parentId ? { parentId } : {}) } });
  return item.itemId;
}

export function accepted(d: AttemptIntentDecision): Extract<AttemptIntentDecision, { verdict: "accept" }> {
  if (d.verdict !== "accept") throw new Error(`refused: ${d.code} ${d.message}`);
  return d;
}

/** intent → (create the base → baseReady) → ready: a READY attempt on `itemId`. */
export async function readyAttempt(ns: string, itemId: string, a: McpAgentIdentity = agent(), baseSha = BASE_SHA) {
  const stub = stubFor(ns);
  const d = accepted(await stub.attemptIntent({ hive: ns, owner: a.owner, agent: a, target: { itemId } }));
  if (d.base.kind === "create") await stub.attemptBaseReady({ hive: ns, itemId: d.itemId, baseRepo: d.base.baseRepo, baseSha });
  const r = await stub.attemptReady({ hive: ns, attemptId: d.attemptId, repo: d.repo, baseSha, expiresAt: Date.now() + 7_200_000 });
  if (!r.ok) throw new Error(`ready refused: ${r.code} ${r.message}`);
  return { ...d, agent: a };
}

/** A human git push through the existing intake (gitIntent + gitPushed). */
export async function gitPush(ns: string, ref: string, message: string, user = OWNER) {
  const stub = stubFor(ns);
  const head = sha();
  const decision = await stub.gitIntent({ hive: ns, user, ref, oldSha: "0".repeat(40), newSha: head });
  if (decision.verdict !== "accept") throw new Error(`refused: ${decision.reason}`);
  const result = await stub.gitPushed({ hive: ns, trainId: decision.trainId, repo: decision.repo, ref, headSha: head, baseSha: "f".repeat(40), title: message.split("\n")[0]!, message, trailers: {} });
  return { decision, head, result };
}

export const look = (ns: string) =>
  runInDurableObject(stubFor(ns), (q: QueenNode) => ({
    provisions: (q.ports.provisioner as RecordingProvisioner).commands.map((c) => ({ ...c })) as ProvisionCommand[],
    deploys: (q.ports.herald as RecordingHerald).commands.map((c) => ({ ...c })) as DeployCommand[],
    attempts: q.sql.exec("SELECT * FROM attempts ORDER BY created_at, attempt_id").toArray() as Row[],
    items: q.sql.exec("SELECT item_id, kind, status, wait_reason, parent_id, base_repo, base_sha, base_pending_at, entry_window_ms FROM work_items ORDER BY seq").toArray() as Row[],
    trains: q.sql.exec("SELECT train_id, prompt_id, phase, fork_state, artifact_repo, race_id, race_outcome, car_id, attempt_id, origin_json, delete_command_id FROM merge_trains ORDER BY seq").toArray() as Row[],
    races: q.sql.exec("SELECT race_id, item_id, state, train_ids, entry_closes_at, winner_train_id FROM races ORDER BY created_at").toArray() as Row[],
    submissions: q.sql.exec("SELECT * FROM submissions ORDER BY created_at").toArray() as Row[],
    events: q.sql.exec("SELECT type, summary, data FROM event_log ORDER BY seq").toArray() as { type: string; summary: string; data: string }[],
  }));

export const deletesOf = (provisions: ProvisionCommand[], repo: string) => provisions.filter((c) => c.op === "DELETE" && c.repo === repo);

/** Report the newest preview DEPLOY of `trainId` as live, then its gate as passed. */
export async function gatePass(ns: string, trainId: string) {
  const c = (await look(ns)).deploys.filter((d): d is Extract<DeployCommand, { op: "DEPLOY" }> => d.op === "DEPLOY" && d.trainId === trainId).at(-1)!;
  await stubFor(ns).reportDeployResult({ commandId: c.commandId, op: "DEPLOY", environment: "preview", trainId, ok: true, url: `https://${trainId}.test.dev`, commitSha: c.commitSha });
  return stubFor(ns).reportTrainResult({ trainId, passed: true, summary: "green" });
}

export const gateFail = (ns: string, trainId: string, summary = "security: nope") => stubFor(ns).reportTrainResult({ trainId, passed: false, summary });

/** Move the Queen's clock forward and run its alarm (watchdogs, race deadlines, entry windows). */
export async function later(ns: string, ms: number): Promise<void> {
  await runInDurableObject(stubFor(ns), async (q: QueenNode) => {
    (q as unknown as { clockOffset: number }).clockOffset += ms;
    await q.alarm();
  });
}

export const trainOf = async (ns: string, trainId: string) => (await look(ns)).trains.find((t) => t.train_id === trainId)!;

/** Play the car executors for `memberId`'s car: its fork, the MERGE drone (fast-forward), the LANDER. */
export async function landCarOf(ns: string, memberId: string): Promise<string> {
  const stub = stubFor(ns);
  const carId = String((await trainOf(ns, memberId)).car_id);
  const fork = (await look(ns)).provisions.find((c) => c.op === "FORK" && c.trainId === carId);
  if (fork && fork.op === "FORK") await stub.reportProvisionResult({ commandId: fork.commandId, op: "FORK", trainId: carId, ok: true, artifactRepo: fork.forkName, baseSha: "c".repeat(40) });
  await stub.reportMergeResult({ trainId: carId, ok: true, headSha: "d".repeat(40), baseSha: "c".repeat(40), merged: [memberId], fastForward: true });
  await stub.reportLandResult({ trainId: carId, landed: true, mainSha: "e".repeat(40) });
  expect(await trainOf(ns, memberId)).toMatchObject({ phase: "MERGED" });
  return carId;
}

export const distinctDeletes = (s: Awaited<ReturnType<typeof look>>, repo: string) => new Set(deletesOf(s.provisions, repo).map((c) => c.commandId)).size;

/**
 * Agent identity on git tokens: a token bound to an agent (name + claimed model) makes the git proxy pass
 * `agent` in the push intent. The Queen records that identity as the train's origin (the token is
 * authoritative: a `Queen-Origin` trailer is ignored), keeps `origin_id` = the owner so per-owner caps span
 * all of an owner's agents, and makes each agent its own supersede chain. The claimed model is display
 * only: it never reaches the model router or model_stats.
 */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { DeployCommand } from "@queenos/queen-types";
import type { QueenNode } from "../src/queen-node";
import type { RecordingDispatcher, RecordingHerald, RecordingOracle } from "./fakes";

const OWNER = "ada@example.com";
const OTHER = "bob@example.com";
const MODEL = "claude-opus-4-5";
const newHive = () => `agt-${crypto.randomUUID().slice(0, 8)}`;
const stubFor = (ns: string) => env.QUEEN_NODE.get(env.QUEEN_NODE.idFromName(ns));
let shaN = 0;
const sha = () => (0xa00000 + ++shaN).toString(16).padStart(40, "0");

type Row = Record<string, unknown>;
type Agent = { name: string; model?: string };

async function externalHive(guardrails?: Record<string, number>) {
  const ns = newHive();
  const stub = stubFor(ns);
  await stub.updateSettings({ hive: ns, user: OWNER, patch: { executors: "external", race: { entryWindowMs: 0 }, ...(guardrails ? { guardrails } : {}) } as never });
  return { ns, stub };
}

async function push(ns: string, ref: string, message: string, opts: { user?: string; agent?: Agent; trailers?: Record<string, string> } = {}) {
  const stub = stubFor(ns);
  const head = sha();
  const decision = await stub.gitIntent({
    hive: ns,
    user: opts.user ?? OWNER,
    ref,
    oldSha: "0".repeat(40),
    newSha: head,
    ...(opts.agent ? { agent: opts.agent } : {}),
  });
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
    trailers: opts.trailers ?? {},
  });
  return { decision, head, result };
}

const sql = <T = Row>(ns: string, query: string, ...args: (string | number)[]) =>
  runInDurableObject(stubFor(ns), (q: QueenNode) => q.sql.exec(query, ...args).toArray() as unknown as T[]);

const trainOrigin = async (ns: string, trainId: string) => {
  const [r] = await sql(ns, "SELECT origin_json FROM merge_trains WHERE train_id = ?", trainId);
  return JSON.parse(String(r!.origin_json));
};

const accepted = (p: { decision: { verdict: string; trainId?: string } }) => {
  if (p.decision.verdict !== "accept") throw new Error(`refused: ${JSON.stringify(p.decision)}`);
  return (p.decision as { trainId: string }).trainId;
};

describe("agent tokens: identity on the intent", () => {
  it("an agent-token intent records an agent origin (with the claimed model) on the train and the submission, and an agent actor on the event", async () => {
    const { ns, stub } = await externalHive();
    const { item } = await stub.fileWorkItem({ hive: ns, user: OWNER, item: { kind: "feature", title: "Haiku endpoint" } });
    const head = sha();
    const d = await stub.gitIntent({ hive: ns, user: OWNER, ref: `refs/heads/item/${item.itemId}`, oldSha: "0".repeat(40), newSha: head, agent: { name: "opus", model: MODEL } });
    if (d.verdict !== "accept") throw new Error("refused");
    // At intent, before the push lands.
    expect(await trainOrigin(ns, d.trainId)).toEqual({ kind: "agent", id: `opus@${OWNER}`, model: MODEL });
    const [sub] = await sql(ns, "SELECT * FROM submissions WHERE train_id = ?", d.trainId);
    expect(sub).toMatchObject({ origin_kind: "agent", origin_id: OWNER, agent: "opus", outcome: "pending" });
    const [ev] = await sql(ns, "SELECT * FROM event_log WHERE type = 'submission.pending' OR (summary LIKE 'push intent accepted%') ORDER BY seq LIMIT 1");
    expect(ev).toMatchObject({ actor: `agent:opus@${OWNER}` });
    expect(JSON.parse(String(ev!.data))).toMatchObject({ agent: "opus", model: MODEL, user: OWNER });

    const res = await stub.gitPushed({ hive: ns, trainId: d.trainId, repo: d.repo, ref: `refs/heads/item/${item.itemId}`, headSha: head, baseSha: "f".repeat(40), title: "Haiku", message: "Haiku", trailers: {} });
    expect(res).toMatchObject({ disposition: "joined-race", itemId: item.itemId });
    // After the push the origin is still the token's, model included, and the submission is applied.
    expect(await trainOrigin(ns, d.trainId)).toEqual({ kind: "agent", id: `opus@${OWNER}`, model: MODEL });
    expect((await sql(ns, "SELECT * FROM submissions WHERE train_id = ?", d.trainId))[0]).toMatchObject({ origin_kind: "agent", origin_id: OWNER, agent: "opus", outcome: "applied" });
    const received = (await sql<{ actor: string; summary: string }>(ns, "SELECT actor, summary FROM event_log WHERE summary LIKE 'submission received%'"))[0]!;
    expect(received.actor).toBe(`agent:opus@${OWNER}`);
    expect(received.summary).toContain(`from agent:opus@${OWNER} (claims ${MODEL})`);
  });

  it("an agent token without a model has no model on its origin; a human token keeps the human origin and a NULL agent", async () => {
    const { ns, stub } = await externalHive();
    const { item } = await stub.fileWorkItem({ hive: ns, user: OWNER, item: { kind: "feature", title: "Haiku endpoint" } });
    const a = await push(ns, `refs/heads/item/${item.itemId}`, "by agent", { agent: { name: "haiku" } });
    expect(await trainOrigin(ns, accepted(a))).toEqual({ kind: "agent", id: `haiku@${OWNER}` });
    const h = await push(ns, `refs/heads/item/${item.itemId}`, "by human", { user: OTHER });
    expect(await trainOrigin(ns, accepted(h))).toEqual({ kind: "human", id: OTHER });
    const [row] = await sql(ns, "SELECT * FROM submissions WHERE train_id = ?", accepted(h));
    expect(row).toMatchObject({ origin_kind: "human", origin_id: OTHER, agent: null });
    const [ev] = await sql(ns, "SELECT actor FROM event_log WHERE summary LIKE 'push intent accepted%' ORDER BY seq DESC LIMIT 1");
    expect(ev).toMatchObject({ actor: `user:${OTHER}` });
  });

  it("a refused agent push records an agent submission row and an agent actor", async () => {
    const { ns } = await externalHive();
    const r = await push(ns, "refs/heads/item/nope", "x", { agent: { name: "opus", model: MODEL } });
    expect(r.decision).toMatchObject({ verdict: "refuse" });
    const [row] = await sql(ns, "SELECT * FROM submissions");
    expect(row).toMatchObject({ outcome: "refused:unknown-item", origin_kind: "agent", origin_id: OWNER, agent: "opus", train_id: null });
    const [ev] = await sql(ns, "SELECT actor, data FROM event_log WHERE summary LIKE 'push refused%'");
    expect(ev).toMatchObject({ actor: `agent:opus@${OWNER}` });
    expect(JSON.parse(String(ev!.data))).toMatchObject({ agent: "opus", model: MODEL });
  });
});

describe("agent tokens: swarm hive", () => {
  it("an agent token pushing item/<id> on a default (swarm) hive gets the agent origin on the train and the submission", async () => {
    const ns = newHive();
    const stub = stubFor(ns);
    const status = await stub.updateSettings({ hive: ns, user: OWNER, patch: { autonomy: "paused" } }); // the item waits READY; the push joins it
    expect(status.settings.executors).toBe("swarm");
    const { item } = await stub.fileWorkItem({ hive: ns, user: OWNER, item: { kind: "feature", title: "Haiku endpoint" } });
    const p = await push(ns, `refs/heads/item/${item.itemId}`, "Haiku", { agent: { name: "opus", model: MODEL } });
    expect(p.result).toMatchObject({ disposition: "joined-race", itemId: item.itemId });
    const trainId = accepted(p);
    expect(await trainOrigin(ns, trainId)).toEqual({ kind: "agent", id: `opus@${OWNER}`, model: MODEL });
    expect((await sql(ns, "SELECT * FROM submissions WHERE train_id = ?", trainId))[0]).toMatchObject({ origin_kind: "agent", origin_id: OWNER, agent: "opus", outcome: "applied" });
  });
});

describe("agent tokens: the Queen-Origin trailer", () => {
  it("is ignored for an agent token (the token identity is authoritative) and still honoured for a human token", async () => {
    const { ns, stub } = await externalHive();
    const { item } = await stub.fileWorkItem({ hive: ns, user: OWNER, item: { kind: "feature", title: "Haiku endpoint" } });
    const msg = "Haiku\n\nQueen-Origin: agent:other";
    const viaToken = await push(ns, `refs/heads/item/${item.itemId}`, msg, { agent: { name: "opus", model: MODEL }, trailers: { "queen-origin": "agent:other" } });
    expect(await trainOrigin(ns, accepted(viaToken))).toEqual({ kind: "agent", id: `opus@${OWNER}`, model: MODEL });
    expect((await sql(ns, "SELECT actor FROM event_log WHERE summary LIKE 'submission received%'")).map((e) => e.actor)).toEqual([`agent:opus@${OWNER}`]);

    const viaHuman = await push(ns, `refs/heads/item/${item.itemId}`, msg, { user: OTHER, trailers: { "queen-origin": "agent:other" } });
    expect(await trainOrigin(ns, accepted(viaHuman))).toEqual({ kind: "agent", id: `other@${OTHER}` });
  });
});

describe("agent tokens: race candidates and supersede", () => {
  it("two agent tokens of one owner pushing item/<id> are separate race candidates; the same agent re-pushing supersedes only itself", async () => {
    const { ns, stub } = await externalHive();
    const { item } = await stub.fileWorkItem({ hive: ns, user: OWNER, item: { kind: "feature", title: "Haiku endpoint" } });
    const ref = `refs/heads/item/${item.itemId}`;
    const a = await push(ns, ref, "by a", { agent: { name: "a", model: MODEL } });
    const b = await push(ns, ref, "by b", { agent: { name: "b" } });
    expect(a.result).toMatchObject({ disposition: "joined-race", itemId: item.itemId });
    expect(b.result).toMatchObject({ disposition: "joined-race", itemId: item.itemId });
    const [race] = await sql(ns, "SELECT * FROM races");
    expect(JSON.parse(String(race!.train_ids))).toEqual([accepted(a), accepted(b)]);
    const phase = async (id: string) => String((await sql(ns, "SELECT phase FROM merge_trains WHERE train_id = ?", id))[0]!.phase);
    expect(await phase(accepted(a))).not.toBe("EJECTED");
    expect(await phase(accepted(b))).not.toBe("EJECTED");

    const again = await push(ns, ref, "by a, v2", { agent: { name: "a", model: MODEL } });
    expect(again.result).toMatchObject({ disposition: "superseded" });
    expect(await phase(accepted(a))).toBe("EJECTED");
    expect(await phase(accepted(b))).not.toBe("EJECTED");
    expect(await phase(accepted(again))).not.toBe("EJECTED");
  });

  it("a human token never supersedes an agent token's push of the same ref (and vice versa), same owner", async () => {
    const { ns, stub } = await externalHive();
    const { item } = await stub.fileWorkItem({ hive: ns, user: OWNER, item: { kind: "feature", title: "Haiku endpoint" } });
    const ref = `refs/heads/item/${item.itemId}`;
    const agent = await push(ns, ref, "by agent", { agent: { name: "a" } });
    const human = await push(ns, ref, "by human");
    expect(human.result).toMatchObject({ disposition: "joined-race" });
    const humanAgain = await push(ns, ref, "by human v2");
    expect(humanAgain.result).toMatchObject({ disposition: "superseded" });
    const [row] = await sql(ns, "SELECT phase FROM merge_trains WHERE train_id = ?", accepted(agent));
    expect(row!.phase).not.toBe("EJECTED");
  });
});

describe("agent tokens: same head", () => {
  it("another agent of the same owner pushing a pending head is a duplicate and leaves the first train alone; the same agent retrying replaces it", async () => {
    const { ns, stub } = await externalHive();
    const { item } = await stub.fileWorkItem({ hive: ns, user: OWNER, item: { kind: "feature", title: "Haiku endpoint" } });
    const ref = `refs/heads/item/${item.itemId}`;
    const head = sha();
    const intent = (agent?: Agent) => stub.gitIntent({ hive: ns, user: OWNER, ref, oldSha: "0".repeat(40), newSha: head, ...(agent ? { agent } : {}) });
    const phase = async (id: string) => String((await sql(ns, "SELECT phase FROM merge_trains WHERE train_id = ?", id))[0]!.phase);
    const a = await intent({ name: "a" });
    if (a.verdict !== "accept") throw new Error("refused");
    const b = await intent({ name: "b" });
    expect(b).toMatchObject({ verdict: "refuse", reason: expect.stringContaining("already being submitted") });
    expect(await phase(a.trainId)).toBe("BUILDING");
    expect(await intent()).toMatchObject({ verdict: "refuse" }); // the owner's human token neither
    expect(await phase(a.trainId)).toBe("BUILDING");
    expect((await sql(ns, "SELECT outcome FROM submissions WHERE train_id = ?", a.trainId))[0]).toMatchObject({ outcome: "pending" });
    // Refusals are keyed (hive, headSha): the first one is the row that is kept.
    expect((await sql(ns, "SELECT outcome, agent FROM submissions WHERE outcome LIKE 'refused:%'")).map((r) => [r.outcome, r.agent])).toEqual([["refused:duplicate", "b"]]);
    // The same agent retrying the same push (its proxy died after the intent) replaces the stale intent.
    const retry = await intent({ name: "a" });
    if (retry.verdict !== "accept") throw new Error("refused");
    expect(await phase(a.trainId)).toBe("EJECTED");
    expect(retry.trainId).not.toBe(a.trainId);
  });

  it("a human token's retry of its own pending head still replaces the stale intent", async () => {
    const { ns, stub } = await externalHive();
    const head = sha();
    const first = await stub.gitIntent({ hive: ns, user: OWNER, ref: "refs/heads/x", oldSha: "0".repeat(40), newSha: head });
    const retry = await stub.gitIntent({ hive: ns, user: OWNER, ref: "refs/heads/x", oldSha: "0".repeat(40), newSha: head });
    if (first.verdict !== "accept" || retry.verdict !== "accept") throw new Error("refused");
    expect(String((await sql(ns, "SELECT phase FROM merge_trains WHERE train_id = ?", first.trainId))[0]!.phase)).toBe("EJECTED");
  });
});

describe("agent tokens: per-owner caps", () => {
  it("maxInboxPushesPerHour counts an owner's pushes across all their agents (and their human token)", async () => {
    const { ns } = await externalHive({ maxInboxPushesPerHour: 3, maxInboxOpenPerContributor: 10 });
    expect((await push(ns, "refs/heads/one", "1", { agent: { name: "a" } })).decision.verdict).toBe("accept");
    expect((await push(ns, "refs/heads/two", "2", { agent: { name: "b" } })).decision.verdict).toBe("accept");
    expect((await push(ns, "refs/heads/three", "3")).decision.verdict).toBe("accept");
    const capped = await push(ns, "refs/heads/four", "4", { agent: { name: "c" } });
    expect(capped.decision).toMatchObject({ verdict: "refuse" });
    const refused = await sql(ns, "SELECT outcome, origin_id, agent FROM submissions WHERE outcome LIKE 'refused:%'");
    expect(refused).toEqual([{ outcome: "refused:over-cap", origin_id: OWNER, agent: "c" }]);
    // Another owner is unaffected.
    expect((await push(ns, "refs/heads/five", "5", { user: OTHER, agent: { name: "a" } })).decision.verdict).toBe("accept");
  });

  it("maxInboxOpenPerContributor counts an owner's open items across agents", async () => {
    const { ns } = await externalHive({ maxInboxOpenPerContributor: 2, maxInboxPushesPerHour: 60 });
    expect((await push(ns, "refs/heads/one", "1", { agent: { name: "a" } })).decision.verdict).toBe("accept");
    expect((await push(ns, "refs/heads/two", "2", { agent: { name: "b" } })).decision.verdict).toBe("accept");
    const capped = await push(ns, "refs/heads/three", "3", { agent: { name: "c" } });
    expect(capped.decision).toMatchObject({ verdict: "refuse" });
    expect((await sql(ns, "SELECT outcome FROM submissions WHERE outcome LIKE 'refused:%'")).map((r) => r.outcome)).toEqual(["refused:over-cap"]);
  });
});

describe("agent tokens: the claimed model is display only", () => {
  it("never reaches model_stats, model_preference, the router's inputs (oracle, drone tasks, deploys) after the race decides", async () => {
    const { ns, stub } = await externalHive();
    const { item } = await stub.fileWorkItem({ hive: ns, user: OWNER, item: { kind: "feature", title: "Haiku endpoint" } });
    const p = await push(ns, `refs/heads/item/${item.itemId}`, "Haiku", { agent: { name: "opus", model: MODEL } });
    const trainId = accepted(p);
    const deploy = await runInDurableObject(stubFor(ns), (q: QueenNode) =>
      (q.ports.herald as RecordingHerald).commands.filter((c): c is Extract<DeployCommand, { op: "DEPLOY" }> => c.op === "DEPLOY" && c.trainId === trainId).at(-1)!,
    );
    await stub.reportDeployResult({ commandId: deploy.commandId, op: "DEPLOY", environment: "preview", trainId, ok: true, url: "https://x.test.dev", commitSha: deploy.commitSha });
    expect(await stub.reportTrainResult({ trainId, passed: true, summary: "green" })).toMatchObject({ outcome: "applied" });
    const seen = await runInDurableObject(stubFor(ns), (q: QueenNode) => ({
      tasks: JSON.stringify((q.ports.dispatcher as RecordingDispatcher).tasks),
      oracle: JSON.stringify((q.ports.oracle as RecordingOracle).commands),
      stats: JSON.stringify(q.sql.exec("SELECT * FROM model_stats").toArray()),
      prefs: JSON.stringify(q.sql.exec("SELECT * FROM model_preference").toArray()),
    }));
    for (const [k, v] of Object.entries(seen)) expect(v, k).not.toContain(MODEL);
    // The race did decide (entryWindowMs: 0) with the agent's train as the winner, and the origin still carries the claim.
    const [race] = await sql(ns, "SELECT state, winner_train_id FROM races");
    expect(race).toMatchObject({ state: "DECIDED", winner_train_id: trainId });
    expect((await trainOrigin(ns, trainId)).model).toBe(MODEL);
  });
});

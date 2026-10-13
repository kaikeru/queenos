/**
 * MCP attempts, push half (spec §7, §8.3): attemptPushed (the push is the submission), supersede by attempt, rework,
 * race entry and decision, fork ownership (one DELETE, on the terminal transition), refresh / end.
 */
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { QueenNode } from "../src/queen-node";
import { attemptStateOf } from "../src/work/attempts";
import { BASE_SHA, MODEL, OTHER, OWNER, accepted, agent, deletesOf, distinctDeletes, externalHive, fileItem, gateFail, gatePass, landCarOf, later, look, push, readyAttempt, sha, stubFor, trainOf } from "./attempt-helpers";

const attemptRow = async (ns: string, attemptId: string) => (await look(ns)).attempts.find((a) => a.attempt_id === attemptId)!;

describe("attemptStateOf", () => {
  it.each([
    [{ phase: "DEPLOYING", raceOutcome: "RACING", carId: null }, "PUSHED"],
    [{ phase: "BUILDING", raceOutcome: null, carId: null }, "PUSHED"],
    [{ phase: "TESTING", raceOutcome: "PASSED", carId: null }, "PASSED"],
    [{ phase: "PASSED", raceOutcome: "WON", carId: null }, "WON"],
    [{ phase: "PASSED", raceOutcome: "WON", carId: "car-1" }, "WON"],
    [{ phase: "LANDING", raceOutcome: "WON", carId: null }, "WON"],
    [{ phase: "MERGED", raceOutcome: "WON", carId: "car-1" }, "LANDED"],
    [{ phase: "EJECTED", raceOutcome: "LOST", carId: null }, "LOST"],
    [{ phase: "EJECTED", raceOutcome: "FAILED", carId: null }, "REJECTED"],
    [{ phase: "EJECTED", raceOutcome: "WON", carId: "car-1" }, "REJECTED"],
  ] as const)("%j → %s", (t, state) => {
    expect(attemptStateOf(t as never)).toBe(state);
  });
});

describe("attemptPushed", () => {
  it("the first push creates the reserved train on the fork: agent origin with the claimed model, the attempt id, a new race, a preview of the fork", async () => {
    const { ns, stub } = await externalHive();
    const itemId = await fileItem(ns);
    const r = await readyAttempt(ns, itemId);
    const { after, res } = await push(ns, r);
    expect(res).toEqual({ outcome: "applied", attemptId: r.attemptId, state: "PUSHED", itemId, trainId: r.trainId, disposition: "joined-race" });
    const s = await look(ns);
    const t = s.trains.find((x) => x.train_id === r.trainId)!;
    expect(t).toMatchObject({ phase: "DEPLOYING", fork_state: "READY", artifact_repo: r.repo, attempt_id: r.attemptId, prompt_id: itemId });
    expect(JSON.parse(String(t.origin_json))).toEqual({ kind: "agent", id: `opus@${OWNER}`, model: MODEL });
    expect(s.attempts[0]).toMatchObject({ state: "PUSHED", head_sha: after, train_id: r.trainId, race_id: t.race_id });
    expect(s.submissions[0]).toMatchObject({ repo: r.repo, head_sha: after, origin_kind: "agent", origin_id: OWNER, agent: "opus", attempt_id: r.attemptId, outcome: "applied" });
    expect(s.deploys.some((d) => d.op === "DEPLOY" && d.artifactRepo === r.repo && d.commitSha === after)).toBe(true);
    expect(s.races).toHaveLength(1);
    const snap = await runInDurableObject(stub, (q: QueenNode) => q.getSnapshot().trains.find((x) => x.trainId === r.trainId));
    expect(snap).toMatchObject({ attemptId: r.attemptId });
    expect(await stub.getAttempt(r.attemptId)).toMatchObject({ state: "PUSHED", verdict: "pending", train: { trainId: r.trainId, phase: "DEPLOYING" } });
  });

  it("a replayed push is a duplicate; the base sha, an unknown attempt, a foreign repo and an INTENT attempt are ignored", async () => {
    const { ns, stub } = await externalHive();
    const itemId = await fileItem(ns);
    const r = await readyAttempt(ns, itemId);
    const { after } = await push(ns, r);
    expect((await push(ns, r, after)).res).toMatchObject({ outcome: "duplicate", trainId: r.trainId });
    expect((await push(ns, r, BASE_SHA)).res).toMatchObject({ outcome: "ignored:base" });
    expect((await push(ns, { attemptId: "att_ffffffffffff", repo: r.repo })).res).toMatchObject({ outcome: "ignored:unknown" });
    expect((await push(ns, { attemptId: r.attemptId, repo: `${ns}-att-ffffffffffff` })).res).toMatchObject({ outcome: "ignored:unknown" });
    const d = accepted(await stub.attemptIntent({ hive: ns, owner: OWNER, agent: agent(), target: { itemId } }));
    expect((await push(ns, d)).res).toMatchObject({ outcome: "ignored:state", state: "INTENT" });
    expect((await look(ns)).trains).toHaveLength(1);
  });

  it("a re-push supersedes the attempt's unboarded train and never deletes the shared fork", async () => {
    const { ns } = await externalHive();
    const itemId = await fileItem(ns);
    const r = await readyAttempt(ns, itemId);
    await push(ns, r);
    const { after: h2, res } = await push(ns, r, sha(), "Add a tip jar, v2");
    expect(res).toMatchObject({ outcome: "applied", disposition: "superseded", state: "PUSHED" });
    expect(res.trainId).not.toBe(r.trainId);
    const s = await look(ns);
    expect(s.trains.find((t) => t.train_id === r.trainId)).toMatchObject({ phase: "EJECTED", fork_state: "NONE" });
    expect(s.trains.find((t) => t.train_id === res.trainId)).toMatchObject({ phase: "DEPLOYING", artifact_repo: r.repo, attempt_id: r.attemptId });
    expect(s.attempts[0]).toMatchObject({ train_id: res.trainId, head_sha: h2 });
    expect(deletesOf(s.provisions, r.repo)).toEqual([]);
  });

  it("REJECTED, then a rework push: PUSHED again on a new train in the same race", async () => {
    const { ns, stub } = await externalHive();
    const itemId = await fileItem(ns);
    const r = await readyAttempt(ns, itemId);
    await push(ns, r);
    await gateFail(ns, r.trainId);
    expect(await attemptRow(ns, r.attemptId)).toMatchObject({ state: "REJECTED" });
    expect(await stub.getAttempt(r.attemptId)).toMatchObject({ verdict: "rejected" });
    const raceId = String((await look(ns)).races[0]!.race_id);
    const { res } = await push(ns, r, sha(), "Add a tip jar, fixed");
    expect(res).toMatchObject({ outcome: "applied", state: "PUSHED", disposition: "joined-race", itemId });
    expect(await trainOf(ns, res.trainId!)).toMatchObject({ phase: "DEPLOYING", race_id: raceId });
    expect(deletesOf((await look(ns)).provisions, r.repo)).toEqual([]);
  });

  it("two attempts race: both pass, entries close, one WON one LOST; the loser's fork is deleted exactly once; the claimed model never reaches model_stats", async () => {
    const { ns, stub } = await externalHive();
    const itemId = await fileItem(ns);
    const a = await readyAttempt(ns, itemId, agent());
    const b = await readyAttempt(ns, itemId, agent({ name: "haiku" }));
    expect(b.base).toMatchObject({ kind: "existing", baseSha: BASE_SHA });
    await push(ns, a);
    await push(ns, b);
    await gatePass(ns, a.trainId);
    await gatePass(ns, b.trainId);
    const raceId = String((await look(ns)).races[0]!.race_id);
    await stub.closeRaceEntries({ hive: ns, raceId, user: OWNER });
    let s = await look(ns);
    expect(s.races[0]).toMatchObject({ state: "DECIDED" });
    const [won, lost] = s.races[0]!.winner_train_id === a.trainId ? [a, b] : [b, a];
    expect(s.attempts.find((x) => x.attempt_id === won.attemptId)).toMatchObject({ state: "WON" });
    expect(s.attempts.find((x) => x.attempt_id === lost.attemptId)).toMatchObject({ state: "LOST" });
    expect(deletesOf(s.provisions, lost.repo)).toHaveLength(1);
    expect(deletesOf(s.provisions, lost.repo)[0]).toMatchObject({ trainId: lost.trainId });
    expect(deletesOf(s.provisions, won.repo)).toEqual([]);
    await later(ns, 0);
    s = await look(ns);
    // The alarm's reconcile re-sends a pending DELETE under the same command id (at-least-once); no new DELETE is decided.
    expect(new Set(deletesOf(s.provisions, lost.repo).map((c) => c.commandId)).size).toBe(1);
    expect(s.events.some((e) => e.type === "attempt.state" && e.summary.includes("→ LOST"))).toBe(true);
    const stats = await runInDurableObject(stubFor(ns), (q: QueenNode) => Number(q.sql.exec("SELECT COUNT(*) AS n FROM model_stats WHERE model = ?", MODEL).one().n));
    expect(stats).toBe(0);
  });

  it("a late push after entries closed files a follow-up item and moves the attempt to it; the passed train stays in the race", async () => {
    const { ns, stub } = await externalHive();
    const itemId = await fileItem(ns);
    const a = await readyAttempt(ns, itemId, agent());
    const b = await readyAttempt(ns, itemId, agent({ name: "haiku" }));
    await push(ns, a);
    await push(ns, b); // stays pending: the race is "closed · deciding"
    await gatePass(ns, a.trainId);
    const raceId = String((await look(ns)).races[0]!.race_id);
    await stub.closeRaceEntries({ hive: ns, raceId, user: OWNER });
    const { res } = await push(ns, a, sha(), "Add a tip jar, v2");
    expect(res.disposition).toBe("late-new-item");
    expect(res.itemId).not.toBe(itemId);
    expect(await attemptRow(ns, a.attemptId)).toMatchObject({ item_id: res.itemId, train_id: res.trainId });
    expect(await trainOf(ns, a.trainId)).toMatchObject({ phase: "TESTING", race_id: raceId });
  });

  it("an agent-bound git push on the item's branch never supersedes an attempt's train", async () => {
    const { ns, stub } = await externalHive();
    const itemId = await fileItem(ns);
    const r = await readyAttempt(ns, itemId);
    await push(ns, r);
    const head = sha();
    const ref = `refs/heads/item/${itemId}`;
    const d = await stub.gitIntent({ hive: ns, user: OWNER, ref, oldSha: "0".repeat(40), newSha: head, agent: { name: "opus" } });
    if (d.verdict !== "accept") throw new Error(d.reason);
    const res = await stub.gitPushed({ hive: ns, trainId: d.trainId, repo: d.repo, ref, headSha: head, baseSha: "f".repeat(40), title: "by git", message: "by git", trailers: {} });
    expect(res.disposition).toBe("joined-race");
    expect(await trainOf(ns, r.trainId)).toMatchObject({ phase: "DEPLOYING" });
  });
});

describe("attemptRefresh / attemptEnd", () => {
  it("check owner and agent; refresh extends expiry; refresh on a terminal attempt is ATTEMPT_EXPIRED, end is a no-op", async () => {
    const { ns, stub } = await externalHive();
    const r = await readyAttempt(ns, await fileItem(ns));
    const own = { hive: ns, attemptId: r.attemptId, owner: OWNER, agentId: r.agent.agentId };
    expect(await stub.attemptRefresh({ ...own, owner: OTHER })).toMatchObject({ ok: false, code: "FORBIDDEN_OWNER" });
    expect(await stub.attemptRefresh({ ...own, agentId: agent().agentId })).toMatchObject({ ok: false, code: "FORBIDDEN_OWNER" });
    const before = Number((await attemptRow(ns, r.attemptId)).expires_at);
    const ok = await stub.attemptRefresh(own);
    expect(ok).toMatchObject({ ok: true, changed: true, attempt: { state: "READY" } });
    if (ok.ok) expect(ok.attempt.expiresAt).toBeGreaterThanOrEqual(before);
    expect(await stub.attemptEnd(own)).toMatchObject({ ok: true, changed: true, attempt: { state: "ABANDONED" } });
    expect(await stub.attemptRefresh(own)).toMatchObject({ ok: false, code: "ATTEMPT_EXPIRED" });
    // M1: ending a terminal attempt is idempotent (its own agent gets the terminal view back).
    expect(await stub.attemptEnd(own)).toMatchObject({ ok: true, changed: false, attempt: { state: "ABANDONED" } });
  });

  it("ending a READY attempt deletes its fork with a repo DELETE keyed by the attempt; the provisioner's report is acknowledged", async () => {
    const { ns, stub } = await externalHive();
    const r = await readyAttempt(ns, await fileItem(ns));
    await stub.attemptEnd({ hive: ns, attemptId: r.attemptId, owner: OWNER, agentId: r.agent.agentId });
    const del = deletesOf((await look(ns)).provisions, r.repo);
    expect(del).toHaveLength(1);
    expect(del[0]).toMatchObject({ trainId: r.attemptId, commandId: `${r.attemptId}-delete-1` });
    expect(await stub.reportProvisionResult({ commandId: del[0]!.commandId, op: "DELETE", trainId: r.attemptId, ok: true })).toMatchObject({ outcome: "applied", train: null });
  });

  it("ending the lone candidate withdraws it: the item awaits a contributor (not stuck ACTIVE), the fork is deleted once, a new attempt is accepted", async () => {
    const { ns, stub } = await externalHive();
    const itemId = await fileItem(ns);
    const r = await readyAttempt(ns, itemId);
    await push(ns, r);
    expect(await stub.attemptEnd({ hive: ns, attemptId: r.attemptId, owner: OWNER, agentId: r.agent.agentId })).toMatchObject({ ok: true, attempt: { state: "ABANDONED" } });
    const s = await look(ns);
    expect(s.trains.find((t) => t.train_id === r.trainId)).toMatchObject({ phase: "EJECTED", race_outcome: "LOST" });
    expect(s.items.find((i) => i.item_id === itemId)).toMatchObject({ status: "FAILED" });
    expect(deletesOf(s.provisions, r.repo)).toHaveLength(1);
    expect(await stub.attemptIntent({ hive: ns, owner: OWNER, agent: agent(), target: { itemId } })).toMatchObject({ verdict: "accept" });
  });

  it("end on the winner that boarded a car is a no-op", async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 } });
    const r = await readyAttempt(ns, await fileItem(ns));
    await push(ns, r);
    await gatePass(ns, r.trainId);
    expect(await trainOf(ns, r.trainId)).toMatchObject({ race_outcome: "WON" });
    expect((await trainOf(ns, r.trainId)).car_id).not.toBeNull();
    expect(await attemptRow(ns, r.attemptId)).toMatchObject({ state: "WON" });
    expect(await stub.attemptEnd({ hive: ns, attemptId: r.attemptId, owner: OWNER, agentId: r.agent.agentId })).toMatchObject({ ok: true, changed: false, attempt: { state: "WON" } });
    expect(deletesOf((await look(ns)).provisions, r.repo)).toEqual([]);
  });
});

describe("fork ownership across a car landing (fix round 1)", () => {
  it("a WON attempt in a car pushes a follow-up; the car landing never deletes the shared fork; ending the attempt deletes it once", async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 } });
    const r = await readyAttempt(ns, await fileItem(ns));
    await push(ns, r);
    await gatePass(ns, r.trainId);
    expect((await trainOf(ns, r.trainId)).car_id).not.toBeNull();
    const { res } = await push(ns, r, sha(), "Add a tip jar, v2");
    expect(res.outcome).toBe("applied");
    expect(res.trainId).not.toBe(r.trainId);
    await landCarOf(ns, r.trainId);
    let s = await look(ns);
    expect(s.trains.find((t) => t.train_id === res.trainId)).toMatchObject({ phase: "DEPLOYING", artifact_repo: r.repo });
    expect(deletesOf(s.provisions, r.repo)).toEqual([]);
    expect(await stub.attemptEnd({ hive: ns, attemptId: r.attemptId, owner: OWNER, agentId: r.agent.agentId })).toMatchObject({ ok: true, attempt: { state: "ABANDONED" } });
    s = await look(ns);
    expect(distinctDeletes(s, r.repo)).toBe(1);
  });

  it("after a late push, the old passed train wins its race and lands by car without deleting the follow-up's fork", async () => {
    // No rework slots: b's rejection must not hold the race (today's path).
    const { ns, stub } = await externalHive({ guardrails: { maxReworksPerAttempt: 0 } });
    const itemId = await fileItem(ns);
    const a = await readyAttempt(ns, itemId, agent());
    const b = await readyAttempt(ns, itemId, agent({ name: "haiku" }));
    await push(ns, a);
    await push(ns, b);
    await gatePass(ns, a.trainId);
    const raceId = String((await look(ns)).races[0]!.race_id);
    await stub.closeRaceEntries({ hive: ns, raceId, user: OWNER });
    const { res } = await push(ns, a, sha(), "Add a tip jar, v2");
    expect(res.disposition).toBe("late-new-item");
    await gateFail(ns, b.trainId);
    expect(await trainOf(ns, a.trainId)).toMatchObject({ race_outcome: "WON" });
    expect((await trainOf(ns, a.trainId)).car_id).not.toBeNull();
    await landCarOf(ns, a.trainId);
    let s = await look(ns);
    expect(s.trains.find((t) => t.train_id === res.trainId)).toMatchObject({ phase: "DEPLOYING", artifact_repo: a.repo });
    expect(s.attempts.find((x) => x.attempt_id === a.attemptId)).toMatchObject({ state: "PUSHED", train_id: res.trainId });
    expect(deletesOf(s.provisions, a.repo)).toEqual([]);
    await stub.attemptEnd({ hive: ns, attemptId: a.attemptId, owner: OWNER, agentId: a.agent.agentId });
    s = await look(ns);
    expect(distinctDeletes(s, a.repo)).toBe(1);
  });
});

describe("out-of-order push events (fix round 1)", () => {
  const pushAt = (ns: string, att: { attemptId: string; repo: string }, before: string, after: string, title: string) =>
    stubFor(ns).attemptPushed({ hive: ns, attemptId: att.attemptId, repo: att.repo, before, after, title, message: title });

  it("a newer push processed first: the older event (its after is the newer push's before) is ignored and the newer stays the candidate", async () => {
    const { ns } = await externalHive();
    const r = await readyAttempt(ns, await fileItem(ns));
    const x = sha();
    const y = sha();
    const b = await pushAt(ns, r, x, y, "B");
    expect(b).toMatchObject({ outcome: "applied", trainId: r.trainId, state: "PUSHED" });
    const a = await pushAt(ns, r, BASE_SHA, x, "A");
    expect(a).toMatchObject({ outcome: "duplicate", trainId: r.trainId });
    const s = await look(ns);
    expect(s.trains).toHaveLength(1);
    expect(s.trains[0]).toMatchObject({ train_id: r.trainId, phase: "DEPLOYING" });
    expect(s.attempts[0]).toMatchObject({ head_sha: y, train_id: r.trainId });
    expect(s.submissions).toHaveLength(1);
    expect(s.events.some((e) => e.type === "attempt.state" && JSON.parse(e.data).outcome === "stale")).toBe(true);
  });

  it("in order: the second push supersedes the first", async () => {
    const { ns } = await externalHive();
    const r = await readyAttempt(ns, await fileItem(ns));
    const x = sha();
    const y = sha();
    expect(await pushAt(ns, r, BASE_SHA, x, "A")).toMatchObject({ outcome: "applied", trainId: r.trainId });
    const b = await pushAt(ns, r, x, y, "B");
    expect(b).toMatchObject({ outcome: "applied", disposition: "superseded" });
    const s = await look(ns);
    expect(s.trains.find((t) => t.train_id === r.trainId)).toMatchObject({ phase: "EJECTED" });
    expect(s.attempts[0]).toMatchObject({ head_sha: y, train_id: b.trainId });
    expect(s.submissions.map((x) => x.before_sha)).toEqual([BASE_SHA, x]);
  });
});

/**
 * Rework loop, the Queen (rework-loop spec §5.1, §5.3, §5.6, §6.2): slots on attempt rows, the alarm's slot deadline, the
 * watchdog leaving a slot alone, refresh, the fresh-base rule (R6), a winner's conflict → REWORKING, and the verdict fix.
 */
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { INFRA_SUMMARY_PREFIX, REWORK_EXPIRY_GRACE_MS, parseReworkReason, reworkReasonText } from "@queenos/queen-types";
import type { QueenNode } from "../src/queen-node";
import { WATCHDOG_SLACK_MS } from "../src/queen-node";
import { attemptVerdict, attemptVerdictKind } from "../src/work/attempts";
import { OTHER, agent, conflictCarOf, deletesOf, distinctDeletes, externalHive, fileItem, gateFail, gatePass, goLive, later, look, own, push, readyAttempt, stubFor, trainOf } from "./attempt-helpers";

const MIN = 60_000;

/** Item A raced by two agents (no entry window): A passes, B is rejected on findings. */
async function aPassesBRejected(opts: { guardrails?: Record<string, number> } = {}) {
  const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 }, ...opts });
  const itemId = await fileItem(ns);
  const a = await readyAttempt(ns, itemId);
  const b = await readyAttempt(ns, itemId, agent({ owner: OTHER, name: "kimi" }));
  await push(ns, a);
  await push(ns, b);
  await gatePass(ns, a.trainId);
  await goLive(ns, b.trainId);
  await gateFail(ns, b.trainId, "lint: unused variable x");
  return { ns, stub, itemId, a, b };
}

/** One attempt on a fresh item fails its gate alone. */
async function aloneRejected(opts: { guardrails?: Record<string, number>; beforeFail?: (ns: string, a: { attemptId: string }) => Promise<void>; bystander?: boolean } = {}) {
  const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 }, ...(opts.guardrails ? { guardrails: opts.guardrails } : {}) });
  const itemId = await fileItem(ns);
  const a = await readyAttempt(ns, itemId);
  // F3: a second attempt that never pushes (READY on the same base).
  const bystander = opts.bystander ? await readyAttempt(ns, itemId, agent({ owner: OTHER, name: "kimi" })) : null;
  await push(ns, a);
  await goLive(ns, a.trainId);
  if (opts.beforeFail) await opts.beforeFail(ns, a);
  await gateFail(ns, a.trainId);
  return { ns, stub, itemId, a, bystander };
}

describe("rework slots on attempt rows (§5.1)", () => {
  it("a findings rejection opens a slot: REJECTED with rework, expires_at extended, the view carries it, the race holds", async () => {
    const { ns, stub, b } = await aPassesBRejected();
    const v = (await stub.getAttempt(b.attemptId))!;
    expect(v).toMatchObject({ state: "REJECTED", verdict: "rejected", verdictKind: "findings", reworks: 1, rework: { reason: "findings", round: 1 } });
    expect(v.expiresAt).toBeGreaterThanOrEqual(v.rework!.dueAt + REWORK_EXPIRY_GRACE_MS);
    expect(v.train).toMatchObject({ phase: "EJECTED", raceOutcome: "REWORK", conflict: null });
    expect(parseReworkReason(v.train!.reason)).toEqual({ reason: "findings", dueAt: v.rework!.dueAt });
    expect(v.race).toMatchObject({ state: "RACING", reopens: 0 });
    expect((await look(ns)).events.some((e) => e.type === "attempt.state" && /rework slot 1\/3 \(findings\) until /.test(e.summary))).toBe(true);
    const due = await runInDurableObject(stubFor(ns), (q: QueenNode) => (q as unknown as { attemptDeadline(t: number): number | null }).attemptDeadline(10 * MIN));
    expect(due).not.toBeNull();
    expect(due!).toBeLessThanOrEqual(v.rework!.dueAt);
  });

  it("the hold ends 10 min after the first pass: B loses (LOST), A wins", async () => {
    const { ns, stub, a, b } = await aPassesBRejected();
    await later(ns, 5 * MIN);
    expect((await stub.getAttempt(b.attemptId))!.state).toBe("REJECTED");
    await later(ns, 5 * MIN + 5_000);
    expect((await stub.getAttempt(b.attemptId))!).toMatchObject({ state: "LOST", verdict: "rejected" });
    expect((await stub.getAttempt(a.attemptId))!.state).toBe("WON");
  });

  it("the alarm is armed for the hold end, not only for the slot's dueAt (§12)", async () => {
    // A 5 min hold: earlier than B's dueAt (30 min) and than B's preview teardown watchdog (the command timeout).
    const { ns } = await aPassesBRejected({ guardrails: { reworkHoldMs: 5 * MIN } });
    // Past the race's 90 s grace: the race stays RACING only because B's hold has not ended.
    await later(ns, 2 * MIN);
    expect((await look(ns)).races.at(-1)).toMatchObject({ state: "RACING" });
    const alarm = await runInDurableObject(stubFor(ns), (q: QueenNode) => (q as unknown as { ctx: DurableObjectState }).ctx.storage.getAlarm());
    // The hold ends 5 min after the first pass, ≈ 3 min from the Queen's clock now.
    expect(alarm).not.toBeNull();
    expect(alarm! - Date.now()).toBeLessThanOrEqual(3 * MIN + WATCHDOG_SLACK_MS + 5_000);
    await later(ns, 3 * MIN + 5_000);
    expect((await look(ns)).races.at(-1)).toMatchObject({ state: "DECIDED" });
  });

  it("alone and unfixed: the slot expires at dueAt → race ABANDONED, item FAILED, attempt REJECTED without a slot, base deleted once (R6)", async () => {
    const { ns, stub, itemId, a } = await aloneRejected();
    let s = await look(ns);
    expect(s.items.find((i) => i.item_id === itemId)).toMatchObject({ status: "ACTIVE", base_repo: a.base.baseRepo });
    expect(deletesOf(s.provisions, a.base.baseRepo)).toHaveLength(0);
    await later(ns, 30 * MIN + 5_000);
    s = await look(ns);
    expect(s.races.at(-1)).toMatchObject({ state: "ABANDONED" });
    expect(s.items.find((i) => i.item_id === itemId)).toMatchObject({ status: "FAILED", base_repo: null });
    expect(deletesOf(s.provisions, a.base.baseRepo)).toHaveLength(1);
    expect(await stub.getAttempt(a.attemptId)).toMatchObject({ state: "REJECTED", rework: null, reworks: 1 });
    expect((await look(ns)).events.some((e) => e.type === "attempt.state" && /rework slot 1 closed/.test(e.summary))).toBe(true);
    await later(ns, 20 * MIN);
    // Unreported DELETEs are re-sent under the same command id: still one delete.
    expect(distinctDeletes(await look(ns), a.base.baseRepo)).toBe(1);
  });

  it("F3: after the fallback a READY attempt does not hold the base; only an INTENT would (§5.6.3)", async () => {
    const { ns, stub, itemId, a, bystander } = await aloneRejected({ bystander: true });
    expect((await stub.getAttempt(bystander!.attemptId))!.state).toBe("READY");
    expect(deletesOf((await look(ns)).provisions, a.base.baseRepo)).toHaveLength(0);
    await later(ns, 30 * MIN + 5_000);
    const s = await look(ns);
    expect(s.races.at(-1)).toMatchObject({ state: "ABANDONED" });
    expect(s.items.find((i) => i.item_id === itemId)).toMatchObject({ base_repo: null });
    expect(deletesOf(s.provisions, a.base.baseRepo)).toHaveLength(1);
    expect((await stub.getAttempt(bystander!.attemptId))!.state).toBe("READY");
    // The next attempt forks a fresh base, which it holds (READY) like any attempt outside a fallback.
    const c = await readyAttempt(ns, itemId, agent({ owner: OTHER, name: "glm" }));
    expect(c.base).toMatchObject({ kind: "create" });
    expect(c.base.baseRepo).not.toBe(a.base.baseRepo);
    await later(ns, MIN);
    const after = await look(ns);
    expect(after.items.find((i) => i.item_id === itemId)).toMatchObject({ base_repo: c.base.baseRepo });
    expect(deletesOf(after.provisions, c.base.baseRepo)).toHaveLength(0);
  });

  it("the watchdog leaves an open slot alone: a slot opened near the attempt's expiry extends it past dueAt", async () => {
    const { ns, stub, a } = await aloneRejected({
      beforeFail: (n, att) => runInDurableObject(stubFor(n), (q: QueenNode) => void q.sql.exec("UPDATE attempts SET expires_at = ? WHERE attempt_id = ?", Date.now() + 5 * MIN, att.attemptId)),
    });
    const v = (await stub.getAttempt(a.attemptId))!;
    expect(v.expiresAt).toBe(v.rework!.dueAt + REWORK_EXPIRY_GRACE_MS);
    await later(ns, 20 * MIN);
    expect(await stub.getAttempt(a.attemptId)).toMatchObject({ state: "REJECTED", rework: { reason: "findings" } });
  });

  it("refresh_attempt with an open slot never shortens expires_at: max(now + 2 h, dueAt + 10 min)", async () => {
    const { ns, stub, a } = await aloneRejected({ guardrails: { reworkWindowMs: 7_200_000 } });
    const v = (await stub.getAttempt(a.attemptId))!;
    const r = await stub.attemptRefresh(own(ns, a));
    expect(r.ok && r.attempt.expiresAt).toBe(v.rework!.dueAt + REWORK_EXPIRY_GRACE_MS);
  });

  it("maxReworksPerAttempt 0: no slot, today's path (item FAILED awaiting contributor at once)", async () => {
    const { ns, stub, itemId, a } = await aloneRejected({ guardrails: { maxReworksPerAttempt: 0 } });
    expect(await stub.getAttempt(a.attemptId)).toMatchObject({ state: "REJECTED", rework: null });
    expect((await look(ns)).items.find((i) => i.item_id === itemId)).toMatchObject({ status: "FAILED" });
  });
});

describe("a winner rejected in the train (§5.3)", () => {
  it("a merge conflict: race REWORKING, item ACTIVE awaiting rework, attempt REJECTED (conflict) with the conflicting paths; no new attempts", async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 } });
    const itemId = await fileItem(ns);
    const a = await readyAttempt(ns, itemId);
    await push(ns, a);
    await gatePass(ns, a.trainId);
    expect(await trainOf(ns, a.trainId)).toMatchObject({ race_outcome: "WON", car_id: expect.any(String) });
    await conflictCarOf(ns, a.trainId);
    const s = await look(ns);
    expect(s.races.at(-1)).toMatchObject({ state: "REWORKING", winner_train_id: a.trainId });
    expect(s.items.find((i) => i.item_id === itemId)).toMatchObject({ status: "ACTIVE", wait_reason: expect.stringMatching(/^awaiting rework \(attempt att_[0-9a-f]{12}, due 20\d\d-/) });
    // A REWORKING race holds the base (it is open, like RACING / PICKING).
    expect(deletesOf(s.provisions, a.base.baseRepo)).toHaveLength(0);
    const v = (await stub.getAttempt(a.attemptId))!;
    expect(v).toMatchObject({ state: "REJECTED", verdict: "rejected", verdictKind: "conflict", rework: { reason: "conflict", round: 1 } });
    expect(v.train!.conflict).toEqual({ paths: ["src/shared.js"], summary: "Merge conflict in src/shared.js" });
    const other = await stub.attemptIntent({ hive: ns, owner: OTHER, agent: agent({ owner: OTHER }), target: { itemId } });
    expect(other).toMatchObject({ verdict: "refuse", code: "ITEM_NOT_ACCEPTING" });
  });
});

describe("attemptVerdict / attemptVerdictKind (§6.2)", () => {
  it("an ejected winner reads rejected (conflict); REWORK is rejected; a REWORK that lost stays rejected; human from the slot or the reason", () => {
    const conflict = { trainId: "t", kind: "content" as const, paths: ["src/a.js"], summary: "Merge conflict in src/a.js" };
    const human = reworkReasonText("human", 5, "rejected by k@kaikeru.com: ugly");
    expect(attemptVerdict({ phase: "EJECTED", raceOutcome: "WON", reason: "failed: Merge conflict" })).toBe("rejected");
    expect(attemptVerdictKind({ phase: "EJECTED", raceOutcome: "WON", reason: "x", summary: null, conflict })).toBe("conflict");
    expect(attemptVerdict({ phase: "EJECTED", raceOutcome: "REWORK", reason: "x" })).toBe("rejected");
    expect(attemptVerdict({ phase: "EJECTED", raceOutcome: "LOST", reason: human })).toBe("rejected");
    expect(attemptVerdict({ phase: "EJECTED", raceOutcome: "LOST", reason: "lost race r: ranked lower" })).toBe("passed");
    // N3: a human-rejected candidate that ended LOST for want of a slot reads rejected / human, not passed
    const lostRejected = { phase: "EJECTED", raceOutcome: "LOST", reason: "lost race r1: rejected by k@kaikeru.com: ugly", summary: null, conflict: null } as const;
    expect(attemptVerdict(lostRejected)).toBe("rejected");
    expect(attemptVerdictKind(lostRejected)).toBe("human");
    expect(attemptVerdictKind({ phase: "EJECTED", raceOutcome: "REWORK", reason: human, summary: null, conflict: null })).toBe("human");
    expect(attemptVerdictKind({ phase: "EJECTED", raceOutcome: "REWORK", reason: "x", summary: null, conflict: null }, { reason: "human", dueAt: 5, round: 1 })).toBe("human");
    expect(attemptVerdictKind({ phase: "EJECTED", raceOutcome: "FAILED", reason: "x", summary: `${INFRA_SUMMARY_PREFIX}gate`, conflict: null })).toBe("infra");
    expect(attemptVerdictKind({ phase: "EJECTED", raceOutcome: "REWORK", reason: "x", summary: "lint", conflict: null })).toBe("findings");
    expect(attemptVerdict({ phase: "PASSED", raceOutcome: "WON", reason: null })).toBe("passed");
    expect(attemptVerdict({ phase: "MERGED", raceOutcome: "WON", reason: null })).toBe("passed");
  });
});

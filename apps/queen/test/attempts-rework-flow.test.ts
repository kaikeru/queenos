/**
 * Rework loop end to end through the QueenNode DO (rework-loop spec §5.1-§5.3, §5.6; Review Focus 1-3): the slot push
 * rejoins its race (after entry close, in REWORKING), a second push supersedes in place, late and replayed pushes,
 * retry_gates on a REWORKING fix, end_attempt and expiry fall back once, and a fresh base afterwards.
 */
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { QueenNode } from "../src/queen-node";
import { MAX_GATE_INFRA_ROUNDS } from "../src/train/planner";
import { type IntakeItem, lateReason } from "../src/work/inbox";
import {
  OTHER,
  agent,
  conflictCarOf,
  deletesOf,
  externalHive,
  fileItem,
  gateFail,
  gateInfra,
  gatePass,
  goLive,
  landCarOf,
  later,
  look,
  own,
  push,
  readyAttempt,
  sha,
  stubFor,
  trainOf,
} from "./attempt-helpers";

const MIN = 60_000;
/** Move the Queen's clock without running the alarm (a late alarm). */
const skew = (ns: string, ms: number) => runInDurableObject(stubFor(ns), (q: QueenNode) => void ((q as unknown as { clockOffset: number }).clockOffset += ms));
/** Force an attempt's expires_at to the Queen's now (the next alarm's watchdog expires it). */
const expireNow = (ns: string, attemptId: string) =>
  runInDurableObject(stubFor(ns), (q: QueenNode) => {
    const now = Date.now() + (q as unknown as { clockOffset: number }).clockOffset;
    q.sql.exec("UPDATE attempts SET expires_at = ? WHERE attempt_id = ?", now, attemptId);
  });

/** One attempt wins item A alone (no entry window) and boards a car; then its car conflicts. */
async function reworking() {
  const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 } });
  const itemId = await fileItem(ns);
  const a = await readyAttempt(ns, itemId);
  await push(ns, a);
  await gatePass(ns, a.trainId);
  await conflictCarOf(ns, a.trainId);
  const raceId = String((await look(ns)).races.at(-1)!.race_id);
  expect((await look(ns)).races.at(-1)).toMatchObject({ state: "REWORKING" });
  return { ns, stub, itemId, a, raceId };
}

/** A and B race item A with a 15 min entry window: A passes, B is rejected (REWORK); the clock is moved past the close. */
async function reworkAfterClose() {
  const { ns, stub } = await externalHive({ race: { entryWindowMs: 15 * MIN } });
  const itemId = await fileItem(ns);
  const a = await readyAttempt(ns, itemId);
  const b = await readyAttempt(ns, itemId, agent({ owner: OTHER, name: "kimi" }));
  await push(ns, a);
  await push(ns, b);
  await gatePass(ns, a.trainId);
  await goLive(ns, b.trainId);
  await gateFail(ns, b.trainId);
  await later(ns, 16 * MIN);
  const raceId = String((await look(ns)).races.at(-1)!.race_id);
  return { ns, stub, itemId, a, b, raceId };
}

/** One attempt alone in a RACING race (no entry window) is rejected on findings: the race is held only by its REWORK candidate. */
async function racingHeldByRework() {
  const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 } });
  const itemId = await fileItem(ns);
  const a = await readyAttempt(ns, itemId);
  await push(ns, a);
  await goLive(ns, a.trainId);
  await gateFail(ns, a.trainId);
  expect(await trainOf(ns, a.trainId)).toMatchObject({ race_outcome: "REWORK" });
  expect((await look(ns)).races.at(-1)).toMatchObject({ state: "RACING" });
  return { ns, stub, itemId, a };
}

describe("the winner's rework: conflict → REWORKING → fix → WON → LANDED (§5.3)", () => {
  it("the fix push rejoins the same race (no new race, no window), is gated, wins and lands", async () => {
    const { ns, stub, itemId, a, raceId } = await reworking();
    const { res } = await push(ns, a);
    expect(res).toMatchObject({ outcome: "applied", disposition: "joined-race" });
    const fix = res.trainId!;
    expect(await trainOf(ns, fix)).toMatchObject({ race_id: raceId, race_outcome: "RACING" });
    expect((await look(ns)).races).toHaveLength(1);
    expect(await stub.getAttempt(a.attemptId)).toMatchObject({ state: "PUSHED", rework: null, reworks: 1 });
    await gatePass(ns, fix);
    expect(await trainOf(ns, fix)).toMatchObject({ race_outcome: "WON" });
    expect((await look(ns)).races.at(-1)).toMatchObject({ state: "DECIDED", winner_train_id: fix });
    expect((await look(ns)).items.find((i) => i.item_id === itemId)!.wait_reason).toBeNull();
    await landCarOf(ns, fix);
    expect((await stub.getAttempt(a.attemptId))!.state).toBe("LANDED");
    expect((await look(ns)).items.find((i) => i.item_id === itemId)!.status).toBe("LANDED");
  });

  it("an integration-gate failure of the winner reworks it too (kind findings)", async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 } });
    const itemId = await fileItem(ns);
    const a = await readyAttempt(ns, itemId);
    await push(ns, a);
    await gatePass(ns, a.trainId);
    const carId = String((await trainOf(ns, a.trainId)).car_id);
    const fork = (await look(ns)).provisions.find((c) => c.op === "FORK" && c.trainId === carId);
    if (fork && fork.op === "FORK") await stub.reportProvisionResult({ commandId: fork.commandId, op: "FORK", trainId: carId, ok: true, artifactRepo: fork.forkName, baseSha: "c".repeat(40) });
    await stub.reportMergeResult({ trainId: carId, ok: true, headSha: "d".repeat(40), baseSha: "c".repeat(40), merged: [a.trainId], fastForward: false });
    await goLive(ns, carId);
    await stub.reportTrainResult({ trainId: carId, passed: false, summary: "integration: smoke /tip failed" });
    expect((await look(ns)).races.at(-1)).toMatchObject({ state: "REWORKING" });
    expect(await stub.getAttempt(a.attemptId)).toMatchObject({ state: "REJECTED", verdictKind: "findings", rework: { reason: "findings" } });
  });

  it("REWORKING slot expiry falls back: ABANDONED, item FAILED, base deleted once; a new agent gets a fresh base and a new race while the old teardown is still out", async () => {
    const { ns, stub, itemId, a } = await reworking();
    await later(ns, 30 * MIN + 5_000);
    let s = await look(ns);
    expect(s.races.at(-1)).toMatchObject({ state: "ABANDONED" });
    expect(s.items.find((i) => i.item_id === itemId)).toMatchObject({ status: "FAILED", base_repo: null });
    expect(deletesOf(s.provisions, a.base.baseRepo)).toHaveLength(1);
    expect(await stub.getAttempt(a.attemptId)).toMatchObject({ state: "REJECTED", rework: null });
    expect(s.deploys.some((c) => c.op === "TEARDOWN" && c.trainId === a.trainId)).toBe(true);
    const b = await readyAttempt(ns, itemId, agent({ owner: OTHER, name: "kimi" }));
    expect(b.base.kind).toBe("create");
    expect(b.base.baseRepo).not.toBe(a.base.baseRepo);
    await push(ns, b);
    s = await look(ns);
    expect(s.races).toHaveLength(2);
    expect(s.races.at(-1)).toMatchObject({ state: "RACING" });
    expect(deletesOf(s.provisions, a.base.baseRepo)).toHaveLength(1);
  });

  it("end_attempt while the fix is gated in a REWORKING race falls back once; a second end_attempt is a no-op", async () => {
    const { ns, stub, itemId, a } = await reworking();
    const { res } = await push(ns, a);
    await goLive(ns, res.trainId!);
    const r = await stub.attemptEnd(own(ns, a));
    expect(r).toMatchObject({ ok: true, changed: true, attempt: { state: "ABANDONED" } });
    const s = await look(ns);
    expect(s.races.at(-1)).toMatchObject({ state: "ABANDONED" });
    expect(s.items.find((i) => i.item_id === itemId)).toMatchObject({ status: "FAILED" });
    expect(deletesOf(s.provisions, a.base.baseRepo)).toHaveLength(1);
    expect(await stub.attemptEnd(own(ns, a))).toMatchObject({ ok: true, changed: false });
    expect(deletesOf((await look(ns)).provisions, a.base.baseRepo)).toHaveLength(1);
  });

  it("end_attempt inside the REWORKING slot (no fix pushed) falls back at once (check 1)", async () => {
    const { ns, stub, itemId, a } = await reworking();
    const r = await stub.attemptEnd(own(ns, a));
    expect(r).toMatchObject({ ok: true, changed: true, attempt: { state: "ABANDONED" } });
    const s = await look(ns);
    expect(s.races.at(-1)).toMatchObject({ state: "ABANDONED" });
    expect(s.items.find((i) => i.item_id === itemId)).toMatchObject({ status: "FAILED" });
    expect(deletesOf(s.provisions, a.base.baseRepo)).toHaveLength(1);
  });

  it("retry_gates on an infra-stopped fix rejoins the REWORKING race (R7)", async () => {
    const { ns, stub, a, raceId } = await reworking();
    const { res } = await push(ns, a);
    const fix = res.trainId!;
    await goLive(ns, fix);
    for (let i = 0; i <= MAX_GATE_INFRA_ROUNDS; i++) await gateInfra(ns, fix);
    expect(await stub.getAttempt(a.attemptId)).toMatchObject({ state: "REJECTED", verdictKind: "infra" });
    expect((await look(ns)).races.at(-1)).toMatchObject({ state: "REWORKING" });
    const r = await stub.attemptRegate(own(ns, a));
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(await trainOf(ns, r.ok ? r.attempt.trainId : "")).toMatchObject({ race_id: raceId, race_outcome: "RACING" });
  });

  it("the watchdog expiring an attempt whose infra-stopped fix holds a REWORKING race falls back", async () => {
    const { ns, a } = await reworking();
    const { res } = await push(ns, a);
    await goLive(ns, res.trainId!);
    for (let i = 0; i <= MAX_GATE_INFRA_ROUNDS; i++) await gateInfra(ns, res.trainId!);
    await later(ns, 3 * 60 * MIN);
    expect((await look(ns)).races.at(-1)).toMatchObject({ state: "ABANDONED" });
  });

  it("a winner's push after dueAt (alarm not run yet) is a late push: never rejoins the REWORKING race (check 3)", async () => {
    const { ns, a, raceId } = await reworking();
    await skew(ns, 31 * MIN);
    const { res } = await push(ns, a);
    expect(res.disposition).toBe("late-new-item");
    const race = (await look(ns)).races.find((r) => r.race_id === raceId)!;
    expect(JSON.parse(String(race.train_ids))).not.toContain(res.trainId);
  });
});

describe("only the winner's attempt enters a REWORKING race (§5.3; check 2)", () => {
  /** A and B race (no window): B's gate cannot run (infra-stopped, FAILED), A wins, then A's car conflicts → REWORKING. */
  async function reworkingWithLoser() {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 } });
    const itemId = await fileItem(ns);
    const a = await readyAttempt(ns, itemId);
    const b = await readyAttempt(ns, itemId, agent({ owner: OTHER, name: "kimi" }));
    await push(ns, a);
    await push(ns, b);
    await goLive(ns, b.trainId);
    for (let i = 0; i <= MAX_GATE_INFRA_ROUNDS; i++) await gateInfra(ns, b.trainId);
    await gatePass(ns, a.trainId);
    expect(await trainOf(ns, a.trainId)).toMatchObject({ race_outcome: "WON" });
    await conflictCarOf(ns, a.trainId);
    const raceId = String((await look(ns)).races.at(-1)!.race_id);
    expect((await look(ns)).races.at(-1)).toMatchObject({ state: "REWORKING" });
    expect(await stub.getAttempt(b.attemptId)).toMatchObject({ state: "REJECTED", verdictKind: "infra" });
    return { ns, stub, itemId, a, b, raceId };
  }

  it("retry_gates of a non-winner's infra-stopped candidate never rejoins the REWORKING race", async () => {
    const { ns, stub, b, raceId } = await reworkingWithLoser();
    const before = JSON.parse(String((await look(ns)).races.find((r) => r.race_id === raceId)!.train_ids)) as string[];
    const r = await stub.attemptRegate(own(ns, b));
    expect(r).toMatchObject({ ok: false, code: "ITEM_NOT_ACCEPTING" });
    expect(JSON.parse(String((await look(ns)).races.find((r) => r.race_id === raceId)!.train_ids))).toEqual(before);
  });

  it("a non-winner's push is today's 'already being built' follow-up, and start_attempt is refused", async () => {
    const { ns, stub, itemId, b, raceId } = await reworkingWithLoser();
    const { res } = await push(ns, b);
    expect(res).toMatchObject({ outcome: "applied", disposition: "late-new-item" });
    expect(res.itemId).not.toBe(itemId);
    const race = (await look(ns)).races.find((r) => r.race_id === raceId)!;
    expect(race).toMatchObject({ state: "REWORKING" });
    expect(JSON.parse(String(race.train_ids))).not.toContain(res.trainId);
    // Today's follow-up reason for a correlated push to an ACTIVE item with nothing racing.
    const why = await runInDurableObject(stubFor(ns), (q: QueenNode) => {
      const x = q as unknown as { intakeLookup(d: { state: unknown }): { item(id: string): IntakeItem | null }; activeState(): unknown; clockOffset: number };
      return lateReason(x.intakeLookup({ state: x.activeState() }).item(itemId)!, Date.now() + x.clockOffset);
    });
    expect(why).toBe(`item ${itemId} is already being built`);
    expect((await look(ns)).items.find((i) => i.item_id === itemId)).toMatchObject({ status: "ACTIVE", wait_reason: expect.stringMatching(/^awaiting rework/) });
    const c = agent({ name: "glm" });
    const d = await stub.attemptIntent({ hive: ns, owner: c.owner, agent: c, target: { itemId } });
    expect(d).toMatchObject({ verdict: "refuse", code: "ITEM_NOT_ACCEPTING" });
  });

  it("a non-winner holding an open slot that names the REWORKING race is still routed through intake (defence in depth)", async () => {
    const { ns, b, raceId } = await reworkingWithLoser();
    await runInDurableObject(stubFor(ns), (q: QueenNode) => {
      const now = Date.now() + (q as unknown as { clockOffset: number }).clockOffset;
      q.sql.exec("UPDATE attempts SET rework_reason = 'findings', rework_due_at = ?, reworks = 1 WHERE attempt_id = ?", now + 20 * MIN, b.attemptId);
    });
    const { res } = await push(ns, b);
    expect(res.disposition).toBe("late-new-item");
    expect(JSON.parse(String((await look(ns)).races.find((r) => r.race_id === raceId)!.train_ids))).not.toContain(res.trainId);
  });
});

describe("end_attempt and expiry end the attempt's rework in a RACING race (§5.6; check 1)", () => {
  it("end_attempt on an attempt whose REWORK candidate alone holds the race: the race resolves (fallback), item FAILED", async () => {
    const { ns, stub, itemId, a } = await racingHeldByRework();
    const r = await stub.attemptEnd(own(ns, a));
    expect(r).toMatchObject({ ok: true, changed: true, attempt: { state: "ABANDONED", rework: null } });
    const s = await look(ns);
    expect(s.races.at(-1)).toMatchObject({ state: "ABANDONED" });
    expect(await trainOf(ns, a.trainId)).toMatchObject({ race_outcome: "FAILED" });
    expect(s.items.find((i) => i.item_id === itemId)).toMatchObject({ status: "FAILED" });
  });

  it("the watchdog expiring an attempt whose REWORK candidate alone holds the race: the race resolves (fallback)", async () => {
    const { ns, stub, itemId, a } = await racingHeldByRework();
    await expireNow(ns, a.attemptId);
    await later(ns, 1_000);
    expect(await stub.getAttempt(a.attemptId)).toMatchObject({ state: "EXPIRED" });
    const s = await look(ns);
    expect(s.races.at(-1)).toMatchObject({ state: "ABANDONED" });
    expect(await trainOf(ns, a.trainId)).toMatchObject({ race_outcome: "FAILED" });
    expect(s.items.find((i) => i.item_id === itemId)).toMatchObject({ status: "FAILED" });
  });

  it("end_attempt of a REWORK candidate while another passed: the race decides for the other at once", async () => {
    const { ns, stub, a, b, raceId } = await reworkAfterClose();
    expect((await look(ns)).races.find((r) => r.race_id === raceId)).toMatchObject({ state: "RACING" });
    await stub.attemptEnd(own(ns, b));
    expect((await look(ns)).races.find((r) => r.race_id === raceId)).toMatchObject({ state: "DECIDED", winner_train_id: a.trainId });
  });
});

describe("the slot fix in a RACING race (§5.1, §5.2; Review Focus 1, 2)", () => {
  it("the fix rejoins after entry close as the same candidate: no follow-up item, the old train FAILED, the slot closed", async () => {
    const { ns, stub, b, raceId } = await reworkAfterClose();
    const items = (await look(ns)).items.length;
    const { res } = await push(ns, b);
    expect(res).toMatchObject({ outcome: "applied", disposition: "joined-race" });
    expect(await trainOf(ns, res.trainId!)).toMatchObject({ race_id: raceId, race_outcome: "RACING" });
    expect(await trainOf(ns, b.trainId)).toMatchObject({ race_outcome: "FAILED" });
    expect((await look(ns)).items).toHaveLength(items);
    expect(await stub.getAttempt(b.attemptId)).toMatchObject({ state: "PUSHED", rework: null, reworks: 1 });
  });

  it("a second push before the fix's verdict supersedes it in place (R4): no follow-up, no second slot", async () => {
    const { ns, stub, b, raceId } = await reworkAfterClose();
    const first = (await push(ns, b)).res.trainId!;
    const items = (await look(ns)).items.length;
    const { res } = await push(ns, b);
    expect(res).toMatchObject({ outcome: "applied", disposition: "joined-race" });
    expect(await trainOf(ns, first)).toMatchObject({ phase: "EJECTED", race_outcome: "LOST" });
    expect(await trainOf(ns, res.trainId!)).toMatchObject({ race_id: raceId, race_outcome: "RACING" });
    expect((await look(ns)).items).toHaveLength(items);
    expect((await stub.getAttempt(b.attemptId))!.reworks).toBe(1);
  });

  it("a replayed slot push is a duplicate: one train, one closed slot", async () => {
    const { ns, stub, b } = await reworkAfterClose();
    const after = sha();
    const first = await push(ns, b, after);
    const again = await push(ns, b, after);
    expect(again.res).toMatchObject({ outcome: "duplicate", trainId: first.res.trainId });
    expect((await stub.getAttempt(b.attemptId))!.reworks).toBe(1);
  });

  it("a push after dueAt is a late push even before the alarm ran: normal intake (a follow-up), never the old slot's candidate", async () => {
    const { ns, b, raceId } = await reworkAfterClose();
    await skew(ns, 15 * MIN); // t0 + 31 min, past dueAt (t0 + 30 min); no alarm
    const { res } = await push(ns, b);
    expect(res.disposition).toBe("late-new-item");
    const race = (await look(ns)).races.find((r) => r.race_id === raceId)!;
    expect(JSON.parse(String(race.train_ids))).not.toContain(res.trainId);
  });

  it("after its slot expired, a late entrant's re-push into the new race is normal intake, not R4 (a follow-up after entry close)", async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 15 * MIN } });
    const itemId = await fileItem(ns);
    const a = await readyAttempt(ns, itemId);
    await push(ns, a);
    await goLive(ns, a.trainId);
    await gateFail(ns, a.trainId);
    await later(ns, 31 * MIN); // the slot expires: race ABANDONED, item FAILED
    const r1 = String((await look(ns)).races.at(-1)!.race_id);
    expect((await look(ns)).races.at(-1)).toMatchObject({ state: "ABANDONED" });
    const late = await push(ns, a); // a late push: intake reopens the item with a new race R2
    expect(late.res.disposition).not.toBe("late-new-item");
    const r2 = (await look(ns)).races.at(-1)!;
    expect(r2.race_id).not.toBe(r1);
    expect(await stub.getAttempt(a.attemptId)).toMatchObject({ state: "PUSHED", reworks: 1 });
    await skew(ns, 16 * MIN); // past R2's entry close, the first R2 head still gating
    const { res } = await push(ns, a);
    expect(res.disposition).toBe("late-new-item");
    expect(await trainOf(ns, late.res.trainId!)).toMatchObject({ race_id: r2.race_id, race_outcome: "RACING" });
    expect(JSON.parse(String((await look(ns)).races.find((r) => r.race_id === r2.race_id)!.train_ids))).not.toContain(res.trainId);
  });

  it("a slot fix pushed before dueAt survives the expiry alarm (Review Focus 1)", async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 } });
    const itemId = await fileItem(ns);
    const a = await readyAttempt(ns, itemId);
    await push(ns, a);
    await goLive(ns, a.trainId);
    await gateFail(ns, a.trainId);
    await later(ns, 29 * MIN);
    const { res } = await push(ns, a);
    await later(ns, 2 * MIN);
    expect(await stub.getAttempt(a.attemptId)).toMatchObject({ state: "PUSHED", trainId: res.trainId });
    expect((await look(ns)).races.at(-1)).toMatchObject({ state: "RACING" });
  });
});

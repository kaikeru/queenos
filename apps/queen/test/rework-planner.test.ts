/** Rework loop, planner (rework-loop spec §5.2, §5.5, §5.6): REWORK candidates, holds, slot expiry, caps. Pure. */
import { describe, expect, it } from "vitest";
import { INFRA_SUMMARY_PREFIX, parseReworkReason } from "@queenos/queen-types";
import { graceStartOf, holdEnd, nextSlot, reworkDeadlines, type ReworkSettings } from "../src/train/rework";
import { A1, B1, C1, MIN, ReworkHive } from "./rework-harness";

const S: ReworkSettings = { windowMs: 30 * MIN, holdMs: 10 * MIN, maxPerAttempt: 3, maxRaceReopens: 3 };

describe("rework.ts: pure rules", () => {
  it("nextSlot: round = reworks + 1, due now + window; none past the cap or on a closed item", () => {
    expect(nextSlot(undefined, A1, "findings", S, 1000)).toEqual({ attemptId: A1, reworks: 1, rework: { reason: "findings", dueAt: 1000 + 30 * MIN, round: 1 } });
    expect(nextSlot({ attemptId: A1, reworks: 2, rework: null }, A1, "conflict", S, 0)!.rework).toEqual({ reason: "conflict", dueAt: 30 * MIN, round: 3 });
    expect(nextSlot({ attemptId: A1, reworks: 3, rework: null }, A1, "human", S, 0)).toBeNull();
    expect(nextSlot(undefined, A1, "findings", { ...S, maxPerAttempt: 0 }, 0)).toBeNull();
    expect(nextSlot(undefined, A1, "findings", S, 0, "LANDED")).toBeNull();
  });

  it("holdEnd: dueAt with no pass; min(dueAt, graceStart + hold) after a pass; a human reject holds until dueAt", () => {
    const g = { holdMs: 10 * MIN, graceMs: 90_000 };
    const race = { deadlineAt: 5 * MIN + 90_000 }; // the first pass at 5 min
    expect(graceStartOf(race, 90_000)).toBe(5 * MIN);
    expect(holdEnd({ reason: "findings", dueAt: 30 * MIN, round: 1 }, race, false, g)).toBe(30 * MIN);
    expect(holdEnd({ reason: "findings", dueAt: 30 * MIN, round: 1 }, race, true, g)).toBe(15 * MIN);
    expect(holdEnd({ reason: "findings", dueAt: 12 * MIN, round: 1 }, race, true, g)).toBe(12 * MIN);
    expect(holdEnd({ reason: "human", dueAt: 30 * MIN, round: 1 }, race, true, g)).toBe(30 * MIN);
    expect(holdEnd({ reason: "findings", dueAt: 30 * MIN, round: 1 }, { deadlineAt: null }, true, g)).toBe(30 * MIN);
  });
});

describe("planner: a rejected attempt candidate keeps its place (§5.2)", () => {
  it("a findings rejection opens a slot: REWORK, EJECTED, the due time in the reason; the race stays RACING", () => {
    const h = new ReworkHive();
    h.push(A1);
    const b = h.push(B1);
    h.fail(b);
    expect(h.t(b)).toMatchObject({ phase: "EJECTED", raceOutcome: "REWORK", summary: "lint: unused variable x" });
    expect(h.slot(B1)).toEqual({ attemptId: B1, reworks: 1, rework: { reason: "findings", dueAt: h.now + 30 * MIN, round: 1 } });
    expect(parseReworkReason(h.t(b).reason)).toEqual({ reason: "findings", dueAt: h.now + 30 * MIN });
    expect(h.race().state).toBe("RACING");
  });

  it("with nothing passed, a REWORK candidate holds the race until dueAt; then it fails and the race is abandoned (the fallback)", () => {
    const h = new ReworkHive();
    const a = h.push(A1);
    h.fail(a);
    h.at(29 * MIN);
    expect(h.race().state).toBe("RACING");
    expect(h.awaiting).toEqual([]);
    h.at(2 * MIN);
    expect(h.t(a).raceOutcome).toBe("FAILED");
    expect(h.slot(A1)).toEqual({ attemptId: A1, reworks: 1, rework: null });
    expect(h.race().state).toBe("ABANDONED");
    expect(h.awaiting).toEqual(["A"]);
  });

  it("with another candidate passed, a findings hold ends at graceStart + reworkHoldMs (not 90 s, not dueAt); it loses and the race decides", () => {
    const h = new ReworkHive();
    const a = h.push(A1);
    const b = h.push(B1);
    h.pass(a); // the grace clock starts now
    h.fail(b);
    h.at(2 * MIN);
    expect(h.race().state).toBe("RACING");
    h.at(7 * MIN);
    expect(h.race().state).toBe("RACING");
    h.at(MIN + 1000);
    expect(h.race()).toMatchObject({ state: "DECIDED", winnerTrainId: a });
    expect(h.t(b).raceOutcome).toBe("LOST");
    expect(parseReworkReason(h.t(b).reason)?.reason).toBe("findings"); // R20: still reads as rejected
    expect(h.slot(B1)!.rework).toBeNull();
  });

  it("the hold ends at dueAt when that comes before graceStart + reworkHoldMs", () => {
    const h = new ReworkHive();
    h.rework = { ...S, windowMs: 5 * MIN };
    const a = h.push(A1);
    const b = h.push(B1);
    h.pass(a);
    h.fail(b);
    h.at(4 * MIN);
    expect(h.race().state).toBe("RACING");
    h.at(MIN + 1000);
    expect(h.race()).toMatchObject({ state: "DECIDED", winnerTrainId: a });
    expect(["FAILED", "LOST"]).toContain(h.t(b).raceOutcome);
  });

  it("a RACING candidate is still capped by raceGraceMs", () => {
    const h = new ReworkHive();
    const a = h.push(A1);
    const c = h.push(C1);
    h.pass(a);
    h.at(91_000);
    expect(h.race()).toMatchObject({ state: "DECIDED", winnerTrainId: a });
    expect(h.t(c)).toMatchObject({ raceOutcome: "LOST", reason: expect.stringMatching(/still running at the race deadline/) });
  });

  it("an infra-stopped candidate takes no slot (infra keeps its own path)", () => {
    const h = new ReworkHive();
    h.push(A1);
    const b = h.push(B1);
    h.fail(b, `${INFRA_SUMMARY_PREFIX}gate could not run after 4 tries: reviewer empty`);
    expect(h.t(b).raceOutcome).toBe("FAILED");
    expect(h.slot(B1)).toBeUndefined();
  });

  it("an attempt past maxReworksPerAttempt fails as today; maxReworksPerAttempt 0 gives no slot", () => {
    const h = new ReworkHive();
    h.slots.set(B1, { attemptId: B1, reworks: 3, rework: null });
    h.push(A1);
    const b = h.push(B1);
    h.fail(b);
    expect(h.t(b).raceOutcome).toBe("FAILED");
    expect(h.slot(B1)).toEqual({ attemptId: B1, reworks: 3, rework: null });

    const z = new ReworkHive();
    z.rework = { ...S, maxPerAttempt: 0 };
    const y = z.push(A1);
    z.fail(y);
    expect(z.t(y).raceOutcome).toBe("FAILED");
    expect(z.race().state).toBe("ABANDONED");
  });

  it("judge human: once the hold ends the race goes to PICKING with the REWORK candidate LOST", () => {
    const h = new ReworkHive();
    h.judge = "human";
    const a = h.push(A1);
    const b = h.push(B1);
    const c = h.push(C1);
    h.pass(a);
    h.pass(c);
    h.fail(b);
    h.at(10 * MIN + 1000);
    expect(h.race().state).toBe("PICKING");
    expect(h.t(b).raceOutcome).toBe("LOST");
  });

  it("no rework settings (a swarm hive, an older caller): a failed candidate is FAILED as before", () => {
    const h = new ReworkHive();
    h.rework = undefined;
    h.push(A1);
    const b = h.push(B1);
    h.fail(b);
    expect(h.t(b).raceOutcome).toBe("FAILED");
    expect(h.slots.size).toBe(0);
  });

  it("reworkDeadlines: the open slot's dueAt and its hold end (alarm), only future ones", () => {
    const h = new ReworkHive();
    const a = h.push(A1);
    const b = h.push(B1);
    h.pass(a);
    h.fail(b);
    const input = { races: [...h.races.values()], trains: [...h.trains.values()], slots: [...h.slots.values()], holdMs: 10 * MIN, graceMs: h.graceMs };
    expect(reworkDeadlines({ ...input, now: h.now }).sort((x, y) => x - y)).toEqual([h.now + 10 * MIN, h.now + 30 * MIN]);
    expect(reworkDeadlines({ ...input, now: h.now + 20 * MIN })).toEqual([h.now + 30 * MIN]);
  });
});

describe("planner: the slot fix (§5.1, §5.2)", () => {
  /** A passed at t0, B rejected at t0 (REWORK); entries close at t0 + 15 min. */
  function reworkAfterClose() {
    const h = new ReworkHive();
    h.entryWindowMs = 15 * MIN;
    const t0 = h.now;
    const a = h.push(A1);
    const b = h.push(B1);
    h.pass(a);
    h.fail(b);
    h.at(16 * MIN); // entries closed; B's hold ends at the grace start (entry close) + 10 min = t0 + 25 min
    return { h, t0, a, b };
  }

  it("the fix rejoins its own race after entry close as the same candidate; the old REWORK train fails; the slot closes", () => {
    const { h, a, b } = reworkAfterClose();
    expect(h.race().state).toBe("RACING");
    const fix = h.push(B1, { rejoin: true });
    expect(h.t(fix)).toMatchObject({ raceId: h.race().raceId, raceOutcome: "RACING", phase: "DEPLOYING" });
    expect(h.race().trainIds).toEqual([a, b, fix]);
    expect(h.races.size).toBe(1);
    expect(h.t(b).raceOutcome).toBe("FAILED");
    expect(h.slot(B1)).toEqual({ attemptId: B1, reworks: 1, rework: null });
  });

  it("R3: the fix is not cut off by the old grace clock; the race waits for its verdict up to the hold end", () => {
    const { h, t0, a } = reworkAfterClose();
    const fix = h.push(B1, { rejoin: true });
    expect(h.race().deadlineAt).toBe(t0 + 25 * MIN);
    h.at(2 * MIN); // t0 + 18 min: past the old deadline (t0 + 16.5 min), the fix still gating
    expect(h.race().state).toBe("RACING");
    h.pass(fix);
    expect(h.race().state).toBe("DECIDED");
    expect([a, fix]).toContain(h.race().winnerTrainId);
  });

  it("a slot fix pushed before dueAt survives the slot's expiry alarm", () => {
    const h = new ReworkHive();
    const a = h.push(A1);
    h.fail(a);
    h.at(29 * MIN);
    const fix = h.push(A1, { rejoin: true });
    h.at(2 * MIN); // past the old dueAt: nothing to expire, the slot closed with the push
    expect(h.t(fix).raceOutcome).toBe("RACING");
    expect(h.race().state).toBe("RACING");
    h.pass(fix);
    expect(h.race()).toMatchObject({ state: "DECIDED", winnerTrainId: fix });
  });

  it("a second push before the fix's verdict supersedes it in place: no new slot, still one race", () => {
    const { h } = reworkAfterClose();
    const fix = h.push(B1, { rejoin: true });
    const second = h.push(B1, { rejoin: true });
    h.run((p) => p.supersede(fix, "f".repeat(40)));
    expect(h.t(fix)).toMatchObject({ phase: "EJECTED", raceOutcome: "LOST" });
    expect(h.t(second).raceOutcome).toBe("RACING");
    expect(h.slot(B1)).toEqual({ attemptId: B1, reworks: 1, rework: null });
    expect(h.races.size).toBe(1);
    expect(h.race().state).toBe("RACING");
  });
});

describe("planner: a winner rejected in the train (§5.3)", () => {
  function winner() {
    const h = new ReworkHive();
    h.queue = { settings: { maxQueueBatch: 1, maxQueueDepth: 1 } };
    const a = h.push(A1);
    h.pass(a);
    expect(h.race()).toMatchObject({ state: "DECIDED", winnerTrainId: a });
    const car = h.forkCar(a);
    return { h, a, car };
  }

  it("a merge conflict: race REWORKING, the winner REWORK with a conflict slot, the item waits (no awaiting contributor)", () => {
    const { h, a, car } = winner();
    h.conflict(car, a);
    expect(h.t(a)).toMatchObject({ phase: "EJECTED", raceOutcome: "REWORK", conflict: { paths: ["src/shared.js"] } });
    expect(parseReworkReason(h.t(a).reason)?.reason).toBe("conflict");
    expect(h.race()).toMatchObject({ state: "REWORKING", winnerTrainId: a });
    expect(h.slot(A1)!.rework).toMatchObject({ reason: "conflict", round: 1 });
    expect(h.waits.get("A")).toMatch(/^awaiting rework \(attempt att_aaaaaaaaaaaa, due \d{4}-\d\d-\d\dT[\d:.]+Z\)$/);
    expect(h.awaiting).toEqual([]);
  });

  it("the fix rejoins the REWORKING race (no new race, no window), is gated, wins on PASS and takes a queue ticket", () => {
    const { h, a, car } = winner();
    h.conflict(car, a);
    const fix = h.push(A1, { rejoin: true });
    expect(h.t(fix)).toMatchObject({ raceId: h.race().raceId, raceOutcome: "RACING", phase: "DEPLOYING" });
    expect(h.races.size).toBe(1);
    expect(h.t(a).raceOutcome).toBe("FAILED");
    h.pass(fix);
    expect(h.t(fix)).toMatchObject({ phase: "PASSED", raceOutcome: "WON", passedSeq: expect.any(Number) });
    expect(h.race()).toMatchObject({ state: "DECIDED", winnerTrainId: fix });
    expect(h.waits.get("A")).toBeNull();
  });

  it("an integration-gate failure of the winner also reworks it (reason findings)", () => {
    const { h, a, car } = winner();
    h.integrationFail(car, a);
    expect(h.t(a).raceOutcome).toBe("REWORK");
    expect(h.race().state).toBe("REWORKING");
    expect(h.slot(A1)!.rework).toMatchObject({ reason: "findings", round: 1 });
  });

  it("a rebased head rejected again keeps the race REWORKING with the next round", () => {
    const { h, a, car } = winner();
    h.conflict(car, a);
    const fix = h.push(A1, { rejoin: true });
    h.fail(fix);
    expect(h.t(fix).raceOutcome).toBe("REWORK");
    expect(h.slot(A1)!.rework).toMatchObject({ reason: "findings", round: 2 });
    expect(h.race().state).toBe("REWORKING");
  });

  it("slot expiry in REWORKING is the fallback: ABANDONED, the REWORK train FAILED, the item awaits any agent", () => {
    const { h, a, car } = winner();
    h.conflict(car, a);
    h.at(31 * MIN);
    expect(h.race()).toMatchObject({ state: "ABANDONED", reason: expect.stringMatching(/rework slot 1 of attempt att_aaaaaaaaaaaa expired/) });
    expect(h.t(a).raceOutcome).toBe("FAILED");
    expect(h.awaiting).toEqual(["A"]);
    expect(h.waits.get("A")).toBeNull();
  });

  it("R8: no slot left when the winner conflicts: the fallback at once", () => {
    const { h, a, car } = winner();
    h.rework = { ...h.rework!, maxPerAttempt: 0 };
    h.conflict(car, a);
    expect(h.t(a).raceOutcome).toBe("FAILED");
    expect(h.race().state).toBe("ABANDONED");
    expect(h.awaiting).toEqual(["A"]);
  });

  it("R7: an infra-stopped fix leaves the race REWORKING; the attempt ending then falls back", () => {
    const { h, a, car } = winner();
    h.conflict(car, a);
    const fix = h.push(A1, { rejoin: true });
    h.fail(fix, `${INFRA_SUMMARY_PREFIX}gate could not run after 4 tries: reviewer empty`);
    expect(h.t(fix).raceOutcome).toBe("FAILED");
    expect(h.race().state).toBe("REWORKING");
    expect(h.run((p) => p.attemptEnded(A1, "attempt expired")).outcome).toBe("applied");
    expect(h.race().state).toBe("ABANDONED");
    expect(h.awaiting).toEqual(["A"]);
  });

  it("withdrawing the fix in flight (end_attempt) falls back once", () => {
    const { h, a, car } = winner();
    h.conflict(car, a);
    const fix = h.push(A1, { rejoin: true });
    h.run((p) => p.withdraw(fix, "opus ended attempt"));
    expect(h.t(fix)).toMatchObject({ phase: "EJECTED", raceOutcome: "LOST" });
    expect(h.race().state).toBe("ABANDONED");
    expect(h.run((p) => p.attemptEnded(A1, "end_attempt")).outcome).toBe("ignored:stale");
    expect(h.awaiting).toEqual(["A"]);
  });
});

describe("planner: attemptEnded in a RACING race", () => {
  it("the REWORK candidate fails and the race decides without it; a loser's attempt ending never touches a REWORKING race", () => {
    const h = new ReworkHive();
    const a = h.push(A1);
    const b = h.push(B1);
    h.pass(a);
    h.fail(b);
    expect(h.run((p) => p.attemptEnded(B1, "end_attempt")).outcome).toBe("applied");
    expect(h.t(b).raceOutcome).toBe("FAILED");
    expect(h.slot(B1)!.rework).toBeNull();
    h.at(91_000);
    expect(h.race()).toMatchObject({ state: "DECIDED", winnerTrainId: a });
  });
});

describe("planner: withdraw while a REWORK slot holds the race (pre-flight F4)", () => {
  it("withdrawing the only live candidate does not fail the item while another attempt's REWORK slot holds the RACING race", () => {
    const h = new ReworkHive();
    const a = h.push(A1);
    h.fail(a); // REWORK: A1's slot holds the race (nothing passed: until dueAt)
    const b = h.push(B1);
    expect(h.t(b).raceId).toBe(h.race().raceId);
    expect(h.run((p) => p.withdraw(b, "opus ended attempt")).outcome).toBe("applied");
    expect(h.t(b)).toMatchObject({ phase: "EJECTED", raceOutcome: "LOST" });
    expect(h.race().state).toBe("RACING");
    expect(h.t(a).raceOutcome).toBe("REWORK");
    expect(h.awaiting).toEqual([]);
    expect(h.prompts.get("A")!.status).not.toBe("FAILED");
    // The fix still rejoins as the same candidate; with no fix, the slot's expiry is the one fallback.
    h.at(31 * MIN);
    expect(h.race().state).toBe("ABANDONED");
    expect(h.awaiting).toEqual(["A"]);
  });
});

describe("planner: the grace start is fixed (review fix 1: R3 never moves it)", () => {
  it("one attempt's slot fix does not extend another REWORK candidate's hold (first pass or entry close + reworkHoldMs)", () => {
    const h = new ReworkHive();
    h.entryWindowMs = 15 * MIN;
    const t0 = h.now;
    const a = h.push(A1);
    const b = h.push(B1);
    const c = h.push(C1);
    h.pass(a);
    h.fail(b);
    h.fail(c);
    expect(h.race().graceFrom).toBe(t0 + 15 * MIN); // entry close is later than the first pass
    h.at(16 * MIN);
    const fix = h.push(B1, { rejoin: true }); // R3: deadlineAt moves out to B's hold end (t0 + 25 min)
    expect(h.race()).toMatchObject({ deadlineAt: t0 + 25 * MIN, graceFrom: t0 + 15 * MIN });
    h.at(MIN);
    h.pass(fix);
    expect(h.race().state).toBe("RACING"); // C still holds until t0 + 25 min
    const alarm = reworkDeadlines({ races: [...h.races.values()], trains: [...h.trains.values()], slots: [...h.slots.values()], holdMs: 10 * MIN, graceMs: h.graceMs, now: h.now });
    expect(alarm).toContain(t0 + 25 * MIN);
    expect(alarm.filter((x) => x < t0 + 30 * MIN)).toEqual([t0 + 25 * MIN]);
    h.at(t0 + 25 * MIN + 1000 - h.now);
    expect(h.race().state).toBe("DECIDED");
    expect(h.t(c).raceOutcome).toBe("LOST");
  });

  it("entries closed early after a pass: graceFrom becomes that close (first pass or entry close, if later); set once otherwise", () => {
    const h = new ReworkHive();
    h.entryWindowMs = 15 * MIN;
    const t0 = h.now;
    const a = h.push(A1);
    h.pass(a);
    expect(h.race().graceFrom).toBe(t0 + 15 * MIN);
    h.at(5 * MIN);
    expect(h.run((p) => p.closeEntries({ raceId: h.race().raceId, by: "human:kyle" })).outcome).toBe("applied");
    expect(h.race().graceFrom).toBe(t0 + 5 * MIN);
  });

  it("entries closed early after a pass: a findings hold ends at that close + reworkHoldMs, not the old window's end + hold", () => {
    const h = new ReworkHive();
    h.entryWindowMs = 15 * MIN;
    const t0 = h.now;
    const a = h.push(A1);
    const b = h.push(B1);
    h.pass(a);
    h.fail(b);
    h.at(5 * MIN);
    h.run((p) => p.closeEntries({ raceId: h.race().raceId, by: "human:kyle" }));
    h.at(10 * MIN - 1000); // t0 + 15 min − 1 s: B still holds
    expect(h.now).toBe(t0 + 15 * MIN - 1000);
    expect(h.race().state).toBe("RACING");
    h.at(2000); // t0 + 15 min + 1 s: past close + hold (the old window would hold until t0 + 25 min)
    expect(h.race()).toMatchObject({ state: "DECIDED", winnerTrainId: a });
    expect(h.t(b).raceOutcome).toBe("LOST");
  });

  it("the grace clock stops when every pass leaves: a later pass restarts graceFrom, and holds measure from the re-pass", () => {
    const h = new ReworkHive();
    const t0 = h.now;
    const a = h.push(A1);
    const b = h.push(B1);
    h.pass(a);
    h.fail(b); // findings-REWORK: holds until graceFrom (t0) + 10 min
    expect(h.race().graceFrom).toBe(t0);
    h.run((p) => p.withdraw(a, "opus ended attempt")); // no pass left: the grace clock stops
    expect(h.race()).toMatchObject({ state: "RACING", deadlineAt: null, graceFrom: null });
    h.at(15 * MIN);
    const c = h.push(C1);
    h.pass(c); // the clock restarts at t0 + 15 min
    expect(h.race()).toMatchObject({ state: "RACING", graceFrom: t0 + 15 * MIN });
    expect(h.t(b).raceOutcome).toBe("REWORK");
    h.at(10 * MIN - 1000);
    expect(h.race().state).toBe("RACING");
    h.at(2000);
    expect(h.race()).toMatchObject({ state: "DECIDED", winnerTrainId: c });
    expect(h.t(b).raceOutcome).toBe("LOST");
  });

  it("graceStartOf: graceFrom when set, else deadlineAt − grace (rows written before it existed)", () => {
    expect(graceStartOf({ deadlineAt: 20 * MIN, graceFrom: 5 * MIN }, 90_000)).toBe(5 * MIN);
    expect(graceStartOf({ deadlineAt: 20 * MIN, graceFrom: null }, 90_000)).toBe(20 * MIN - 90_000);
    expect(graceStartOf({ deadlineAt: 20 * MIN }, 90_000)).toBe(20 * MIN - 90_000);
    expect(graceStartOf({ deadlineAt: null }, 90_000)).toBeNull();
  });
});

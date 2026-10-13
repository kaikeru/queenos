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

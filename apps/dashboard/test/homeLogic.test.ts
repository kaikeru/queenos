import { describe, expect, it } from "vitest";
import type { MergeTrain, Race } from "@queenos/queen-types";
import { demoSwarmPrompt } from "../src/demo";
import { attemptsOf, autonomyLabel, compactNumber, durationText, escalationButtons, gateText, meterFill, validItemActions } from "../src/homeLogic";

const train = (o: Partial<MergeTrain>): MergeTrain => ({ trainId: "t", baseSha: "a", includedPrompts: ["p"], artifactRepo: "r", status: "BUILDING", createdAt: 1, ...o }) as MergeTrain;

describe("demoSwarmPrompt", () => {
  it("makes n bullets with one race, two collide and one batch-fail marker", () => {
    const p = demoSwarmPrompt(24);
    const lines = p.split("\n");
    expect(lines).toHaveLength(24);
    expect(lines.every((l) => l.startsWith("- Add a /features/"))).toBe(true);
    expect(p.match(/\[race\]/g)).toHaveLength(1);
    expect(p.match(/\[collide\]/g)).toHaveLength(2);
    expect(p.match(/\[batch-fail\]/g)).toHaveLength(1);
  });
  it("handles tiny and huge sizes", () => {
    expect(demoSwarmPrompt(0).split("\n")).toHaveLength(1);
    expect(new Set(demoSwarmPrompt(40).split("\n")).size).toBe(40);
  });
});

describe("homeLogic", () => {
  it("escalation buttons: first is primary, cancel is danger", () => {
    const b = escalationButtons({ actions: ["retry", "cancel"] });
    expect(b[0]).toMatchObject({ action: "retry", primary: true, danger: false });
    expect(b[1]).toMatchObject({ action: "cancel", primary: false, danger: true });
  });
  it("autonomy label shows degradation", () => {
    expect(autonomyLabel({ effectiveAutonomy: "autonomous", degradedBy: [], settings: { autonomy: "autonomous" } })).toBe("autonomous");
    expect(autonomyLabel({ effectiveAutonomy: "supervised", degradedBy: ["ERROR_BUDGET_EXHAUSTED"], settings: { autonomy: "autonomous" } })).toBe("autonomous → supervised (error budget)");
  });
  it("meter, numbers, durations", () => {
    expect(meterFill(5, 0)).toBe(0);
    expect(meterFill(15, 10)).toBe(1);
    expect(compactNumber(31000)).toBe("31k");
    expect(compactNumber(1500000)).toBe("1.5M");
    expect(durationText(null)).toBe("–");
    expect(durationText(660_000)).toBe("11m");
    expect(durationText(5_400_000)).toBe("1h 30m");
  });
  it("valid item actions by status", () => {
    expect(validItemActions({ status: "FAILED" })).toEqual(["retry", "cancel"]);
    expect(validItemActions({ status: "DUPLICATE" })).toEqual(["not_duplicate"]);
    expect(validItemActions({ status: "SHIPPED" })).toEqual([]);
    expect(validItemActions({ status: "ACTIVE" })).toEqual(["cancel"]);
  });
  it("attempts: build, rework, race", () => {
    const race = { raceId: "r1", winnerTrainId: "c2" } as Race;
    const a = attemptsOf([train({ trainId: "b2", createdAt: 5 }), train({ trainId: "b1", createdAt: 1 })], []);
    expect(a.map((x) => x.kind)).toEqual(["BUILD", "REWORK"]);
    const r = attemptsOf([train({ trainId: "c1", raceId: "r1", candidate: 0 }), train({ trainId: "c2", raceId: "r1", candidate: 1 })], [race]);
    expect(r.map((x) => [x.kind, x.winner])).toEqual([["RACE", false], ["RACE", true]]);
  });
  it("gate text", () => {
    expect(gateText(train({}))).toBeNull();
    expect(gateText(train({ score: { review: "approved", satisfied: 3, missing: 0, changedFiles: 2, changedBytes: 2457, checks: 4 } }))).toContain("2.4 KB");
  });
});

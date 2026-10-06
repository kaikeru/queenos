import { describe, expect, it } from "vitest";
import type { AutonomyLevel, Escalation, EscalationReason } from "@queenos/queen-types";
import { newEscalation, resolvedEscalation } from "../src/autonomy/escalation";
import {
  autonomyResumedAt,
  autonomyTransition,
  changeSuccessFromReleases,
  effectiveAutonomy,
  errorBudget,
  hiveHeadline,
  type SloStatus,
} from "../src/autonomy/policy";

const healthy = (): SloStatus => errorBudget({ shipped: 20, rolledBack: 0, canaryFailed: 0, target: 0.9, window: 20 });
const exhausted = (lastFailureAt = 500): SloStatus => errorBudget({ shipped: 17, rolledBack: 2, canaryFailed: 1, target: 0.9, window: 20, lastFailureAt });

const esc = (reason: EscalationReason, now = 100) => newEscalation("hive", now, { reason, subject: { type: "hive", id: "hive" }, summary: "s" });

describe("error budget (§2.8)", () => {
  it("floor((1 − target) × window) − failures, robust to float error", () => {
    expect(healthy()).toMatchObject({ window: 20, attempted: 20, failed: 0, errorBudgetRemaining: 2, exhausted: false });
    expect(errorBudget({ shipped: 18, rolledBack: 1, canaryFailed: 1, target: 0.9, window: 20 })).toMatchObject({ errorBudgetRemaining: 0, exhausted: false });
    expect(exhausted()).toMatchObject({ attempted: 20, failed: 3, errorBudgetRemaining: -1, exhausted: true, lastFailureAt: 500 });
    expect(errorBudget({ shipped: 0, rolledBack: 0, canaryFailed: 0, target: 1, window: 5 })).toMatchObject({ errorBudgetRemaining: 0, exhausted: false });
    expect(errorBudget({ shipped: 0, rolledBack: 1, canaryFailed: 0, target: 1, window: 5 }).exhausted).toBe(true);
  });

  it("changeSuccessFromReleases counts the newest window of SHIPPED, ROLLED_BACK and canary-FAILED", () => {
    const rel = (phase: string, updatedAt: number, tappedAt: number | null = 1) => ({ phase: phase as never, updatedAt, tappedAt });
    const input = changeSuccessFromReleases(
      [
        rel("ROLLED_BACK", 1), // outside the window (oldest)
        rel("SHIPPED", 2),
        rel("FAILED", 3, null), // staging failure: not counted
        rel("SUPERSEDED", 4),
        rel("FAILED", 5), // canary failure
        rel("SHIPPED", 6),
        rel("ROLLED_BACK", 7),
        rel("CANARY", 8),
      ],
      { changeSuccessTarget: 0.9, window: 4 },
    );
    expect(input).toEqual({ shipped: 2, rolledBack: 1, canaryFailed: 1, target: 0.9, window: 4, lastFailureAt: 7 });
  });
});

describe("effectiveAutonomy (§2.4)", () => {
  it("no degradation when healthy", () => {
    for (const configured of ["autonomous", "supervised", "paused"] as AutonomyLevel[]) {
      const r = effectiveAutonomy({ configured, slo: healthy(), rollbackStreak: 0, escalations: [] });
      expect(r).toEqual({ configured, level: configured, degraded: false, reasons: [], autoShip: configured === "autonomous", paused: configured === "paused" });
    }
  });

  const triggers: { name: string; reason: EscalationReason; slo?: SloStatus; streak?: number; escalations?: Escalation[] }[] = [
    { name: "exhausted error budget", reason: "ERROR_BUDGET_EXHAUSTED", slo: exhausted() },
    { name: "rollback_streak ≥ 2", reason: "ROLLBACK_STREAK", streak: 2 },
    { name: "open ROLLBACK_FAILED", reason: "ROLLBACK_FAILED", escalations: [esc("ROLLBACK_FAILED")] },
  ];
  for (const t of triggers) {
    it(`${t.name}: autonomous → supervised; supervised and paused unchanged`, () => {
      const input = { slo: t.slo ?? healthy(), rollbackStreak: t.streak ?? 0, escalations: t.escalations ?? [] };
      expect(effectiveAutonomy({ configured: "autonomous", ...input })).toEqual({
        configured: "autonomous",
        level: "supervised",
        degraded: true,
        reasons: [t.reason],
        autoShip: false,
        paused: false,
      });
      expect(effectiveAutonomy({ configured: "supervised", ...input })).toMatchObject({ level: "supervised", degraded: false, reasons: [] });
      expect(effectiveAutonomy({ configured: "paused", ...input })).toMatchObject({ level: "paused", paused: true, reasons: [] });
    });
  }

  it("all reasons at once, in a fixed order", () => {
    const r = effectiveAutonomy({ configured: "autonomous", slo: exhausted(), rollbackStreak: 3, escalations: [esc("ROLLBACK_FAILED")] });
    expect(r.reasons).toEqual(["ERROR_BUDGET_EXHAUSTED", "ROLLBACK_STREAK", "ROLLBACK_FAILED"]);
  });

  it("recovery: streak of 1, a resolved ROLLBACK_FAILED, and a slid window all restore autonomy", () => {
    const failed = resolvedEscalation(esc("ROLLBACK_FAILED"), "kyle", "ack", 200);
    expect(effectiveAutonomy({ configured: "autonomous", slo: healthy(), rollbackStreak: 1, escalations: [failed] })).toMatchObject({ level: "autonomous", autoShip: true });
  });

  it("resume_autonomy waives an exhausted budget until the next failure", () => {
    const resumed = resolvedEscalation(esc("ERROR_BUDGET_EXHAUSTED"), "kyle", "resume_autonomy: I checked", 600);
    expect(autonomyResumedAt([resumed])).toBe(600);
    expect(effectiveAutonomy({ configured: "autonomous", slo: exhausted(500), rollbackStreak: 0, escalations: [resumed] }).level).toBe("autonomous");
    // A new failure after the waiver degrades again.
    expect(effectiveAutonomy({ configured: "autonomous", slo: exhausted(700), rollbackStreak: 0, escalations: [resumed] }).reasons).toEqual(["ERROR_BUDGET_EXHAUSTED"]);
    // An ack is no waiver.
    const acked = resolvedEscalation(esc("ERROR_BUDGET_EXHAUSTED"), "kyle", "ack", 600);
    expect(effectiveAutonomy({ configured: "autonomous", slo: exhausted(500), rollbackStreak: 0, escalations: [acked] }).level).toBe("supervised");
  });
});

describe("autonomyTransition", () => {
  const ctx = (slo: SloStatus, escalations: Escalation[] = []) => ({ hive: "hive", now: 1000, slo, escalations });

  it("newly exhausted: autonomy.degraded + ERROR_BUDGET_EXHAUSTED opened once", () => {
    const next = effectiveAutonomy({ configured: "autonomous", slo: exhausted(), rollbackStreak: 0, escalations: [] });
    const t = autonomyTransition([], next, ctx(exhausted()));
    expect(t.degradedBy).toEqual(["ERROR_BUDGET_EXHAUSTED"]);
    expect(t.changed).toBe(true);
    expect(t.events.map((e) => e.type)).toEqual(["autonomy.degraded", "escalation.opened"]);
    expect(t.escalations).toEqual([expect.objectContaining({ reason: "ERROR_BUDGET_EXHAUSTED", status: "OPEN", subject: { type: "hive", id: "hive" }, actions: ["resume_autonomy", "ack"] })]);
    // Unchanged next time (even after an ack resolved it): nothing reopens.
    const again = autonomyTransition(["ERROR_BUDGET_EXHAUSTED"], next, ctx(exhausted()));
    expect(again).toMatchObject({ changed: false, events: [], escalations: [] });
  });

  it("cleared: autonomy.restored and the open ERROR_BUDGET_EXHAUSTED resolves", () => {
    const open = esc("ERROR_BUDGET_EXHAUSTED");
    const next = effectiveAutonomy({ configured: "autonomous", slo: healthy(), rollbackStreak: 0, escalations: [open] });
    const t = autonomyTransition(["ERROR_BUDGET_EXHAUSTED"], next, ctx(healthy(), [open]));
    expect(t.degradedBy).toEqual([]);
    expect(t.events.map((e) => e.type)).toEqual(["autonomy.restored", "escalation.resolved"]);
    expect(t.escalations).toEqual([expect.objectContaining({ escalationId: open.escalationId, status: "RESOLVED", resolution: "cleared: error budget 2" })]);
  });

  it("a streak degradation emits autonomy.degraded but no budget escalation (the release planner opens ROLLBACK_STREAK)", () => {
    const next = effectiveAutonomy({ configured: "autonomous", slo: healthy(), rollbackStreak: 2, escalations: [] });
    const t = autonomyTransition([], next, ctx(healthy()));
    expect(t.events.map((e) => e.type)).toEqual(["autonomy.degraded"]);
    expect(t.escalations).toEqual([]);
  });
});

describe("hiveHeadline", () => {
  const base = { openEscalations: 0, level: "autonomous" as AutonomyLevel, budgetExhausted: false, counts: {}, queueCars: 0, releaseInFlight: false };
  it("NEEDS_YOU > BLOCKED > SHIPPING > IDLE", () => {
    expect(hiveHeadline(base)).toBe("IDLE");
    expect(hiveHeadline({ ...base, releaseInFlight: true })).toBe("SHIPPING");
    expect(hiveHeadline({ ...base, counts: { ACTIVE: 1, READY: 3 } })).toBe("SHIPPING");
    expect(hiveHeadline({ ...base, counts: { READY: 3 } })).toBe("BLOCKED");
    expect(hiveHeadline({ ...base, level: "paused", releaseInFlight: true })).toBe("BLOCKED");
    expect(hiveHeadline({ ...base, budgetExhausted: true })).toBe("BLOCKED");
    expect(hiveHeadline({ ...base, openEscalations: 1, level: "paused" })).toBe("NEEDS_YOU");
  });
});

describe("infrastructure never charges the error budget", () => {
  it("isReleaseFailure / changeSuccessFromReleases skip a release stopped by infrastructure", async () => {
    const { isReleaseFailure, changeSuccessFromReleases } = await import("../src/autonomy/policy");
    const infra = { phase: "FAILED" as const, tappedAt: 5, updatedAt: 10, summary: "Infrastructure: Canary deploy at 1% did not complete after 3 attempts: 503" };
    const real = { phase: "ROLLED_BACK" as const, tappedAt: 5, updatedAt: 11, summary: "Canary at 10% failed: 5xx" };
    expect(isReleaseFailure(infra)).toBe(false);
    expect(isReleaseFailure(real)).toBe(true);
    const c = changeSuccessFromReleases([infra, real], { changeSuccessTarget: 0.9, window: 20 });
    expect(c.rolledBack + c.canaryFailed).toBe(1);
  });
});

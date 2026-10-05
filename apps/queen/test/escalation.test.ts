import { describe, expect, it } from "vitest";
import { RUNBOOK, type Escalation, type EscalationAction, type EscalationReason, type EscalationSubject } from "@queenos/queen-types";
import {
  EscalationPlanner,
  escalationIdFor,
  newEscalation,
  resolutionAction,
  type EscalationIntent,
  type SubjectView,
} from "../src/autonomy/escalation";

const ctx = { hive: "hive", now: 1000 };
const USER = "kyle@kaikeru.com";

function opened(reason: EscalationReason, subject: EscalationSubject): Escalation {
  return newEscalation("hive", 500, { reason, subject, summary: `${reason} happened` });
}

const release = { type: "release", id: "r1" } as const;
const item = { type: "item", id: "i1" } as const;
const hive = { type: "hive", id: "hive" } as const;

describe("escalation planner: open", () => {
  it("opens with the runbook's actions, a deterministic id and an escalation.opened event; a second open is a duplicate", () => {
    const p = new EscalationPlanner([], ctx);
    const r = p.open({ reason: "APPROVAL_REQUIRED", subject: release, summary: "passed staging", traceId: "a".repeat(32) });
    expect(r.outcome).toBe("applied");
    expect(r.escalations).toEqual([
      {
        escalationId: escalationIdFor("APPROVAL_REQUIRED", release, 1000),
        hive: "hive",
        reason: "APPROVAL_REQUIRED",
        status: "OPEN",
        subject: release,
        traceId: "a".repeat(32),
        summary: "passed staging",
        actions: ["ship", "hold"],
        createdAt: 1000,
        resolvedAt: null,
        resolvedBy: null,
        resolution: null,
      },
    ]);
    expect(r.events).toEqual([expect.objectContaining({ type: "escalation.opened", releaseId: "r1", actor: "queen" })]);
    expect(p.open({ reason: "APPROVAL_REQUIRED", subject: release, summary: "again" }).outcome).toBe("ignored:duplicate");
    expect(p.open({ reason: "SENTINEL_INCONCLUSIVE", subject: release, summary: "other reason" }).outcome).toBe("applied");
  });

  it("long summaries are clipped to 500", () => {
    const r = new EscalationPlanner([], ctx).open({ reason: "GUARDRAIL_TRIPPED", subject: hive, summary: "x".repeat(800) });
    expect(r.escalations[0]!.summary).toHaveLength(500);
  });
});

/** Every reason × every runbook action: the intents it maps to. */
const paths: { reason: EscalationReason; subject: EscalationSubject; action: EscalationAction; view?: SubjectView; intents: EscalationIntent[] }[] = [
  { reason: "APPROVAL_REQUIRED", subject: release, action: "ship", view: { releasePhase: "AWAITING_TAP" }, intents: [{ type: "release.tap", releaseId: "r1", user: USER }] },
  { reason: "APPROVAL_REQUIRED", subject: release, action: "hold", intents: [] },
  { reason: "SENTINEL_INCONCLUSIVE", subject: release, action: "ship", intents: [{ type: "release.tap", releaseId: "r1", user: USER }] },
  { reason: "SENTINEL_INCONCLUSIVE", subject: release, action: "hold", intents: [] },
  { reason: "REWORK_EXHAUSTED", subject: item, action: "retry", view: { itemStatus: "FAILED" }, intents: [{ type: "work.retry", itemId: "i1", user: USER, resetAttempts: true, resetConflicts: true }] },
  { reason: "REWORK_EXHAUSTED", subject: item, action: "cancel", intents: [{ type: "work.cancel", itemId: "i1", user: USER }] },
  { reason: "ROLLBACK_STREAK", subject: hive, action: "resume_autonomy", intents: [{ type: "autonomy.resume", resetStreak: true }] },
  { reason: "ROLLBACK_STREAK", subject: hive, action: "ack", intents: [] },
  { reason: "ROLLBACK_FAILED", subject: release, action: "ack", intents: [] },
  { reason: "ERROR_BUDGET_EXHAUSTED", subject: hive, action: "resume_autonomy", intents: [{ type: "autonomy.resume", resetStreak: true }] },
  { reason: "ERROR_BUDGET_EXHAUSTED", subject: hive, action: "ack", intents: [] },
  {
    reason: "BUDGET_EXHAUSTED",
    subject: hive,
    action: "raise_budget",
    view: { budget: { dailyCredits: 50_000, dailyDispatches: 401 } },
    intents: [{ type: "budget.raise", dailyCredits: 75_000, dailyDispatches: 602 }],
  },
  { reason: "BUDGET_EXHAUSTED", subject: hive, action: "ack", intents: [] },
  { reason: "GUARDRAIL_TRIPPED", subject: item, action: "ack", intents: [] },
  { reason: "EXECUTOR_LOST", subject: hive, action: "retry", intents: [{ type: "queue.resume" }] },
  { reason: "EXECUTOR_LOST", subject: item, action: "retry", intents: [{ type: "work.retry", itemId: "i1", user: USER, resetAttempts: true, resetConflicts: true }] },
  { reason: "EXECUTOR_LOST", subject: hive, action: "ack", intents: [] },
];

describe("escalation planner: resolve, every reason and action", () => {
  it("the table covers every reason and every runbook action", () => {
    for (const reason of Object.keys(RUNBOOK) as EscalationReason[]) {
      for (const action of Object.keys(RUNBOOK[reason].actions)) {
        expect(paths.some((p) => p.reason === reason && p.action === action), `${reason}/${action}`).toBe(true);
      }
    }
  });

  for (const t of paths) {
    it(`${t.reason} (${t.subject.type}) + ${t.action}`, () => {
      const e = opened(t.reason, t.subject);
      const p = new EscalationPlanner([e], ctx);
      const r = p.resolve(e.escalationId, t.action, USER, undefined, t.view);
      expect(r.outcome).toBe("applied");
      expect(r.effects).toEqual(t.intents);
      expect(r.escalations[0]).toMatchObject({ escalationId: e.escalationId, status: "RESOLVED", resolvedBy: USER, resolvedAt: 1000, resolution: t.action });
      expect(r.events[0]).toMatchObject({ type: "escalation.resolved", actor: USER });
      expect(resolutionAction(r.escalations[0]!)).toBe(t.action);
      // Resolving twice is a duplicate with no effects.
      expect(p.resolve(e.escalationId, t.action, USER)).toMatchObject({ outcome: "ignored:duplicate", effects: [], escalations: [] });
    });
  }

  it("a note is kept in the resolution and the action still parses", () => {
    const e = opened("ROLLBACK_FAILED", release);
    const r = new EscalationPlanner([e], ctx).resolve(e.escalationId, "ack", USER, "fixed: rolled back by hand");
    expect(r.escalations[0]!.resolution).toBe("ack: fixed: rolled back by hand");
    expect(resolutionAction(r.escalations[0]!)).toBe("ack");
  });

  it("conflicts: an action not offered, or a subject that moved on", () => {
    const appr = opened("APPROVAL_REQUIRED", release);
    const rework = opened("REWORK_EXHAUSTED", item);
    const budget = opened("BUDGET_EXHAUSTED", hive);
    const p = new EscalationPlanner([appr, rework, budget], ctx);
    expect(p.resolve(appr.escalationId, "retry", USER).outcome).toBe("conflict");
    expect(p.resolve(appr.escalationId, "ship", USER, undefined, { releasePhase: "SUPERSEDED" }).outcome).toBe("conflict");
    expect(p.resolve(rework.escalationId, "retry", USER, undefined, { itemStatus: "READY" }).outcome).toBe("conflict");
    expect(p.resolve(budget.escalationId, "raise_budget", USER).outcome).toBe("conflict"); // no budget view
    expect(p.resolve("nope", "ack", USER).outcome).toBe("ignored:unknown");
    // Nothing was resolved by the conflicts.
    expect(p.all().every((e) => e.status === "OPEN")).toBe(true);
  });

  it("resume_autonomy also resolves the other open resumable degradation (not ROLLBACK_FAILED)", () => {
    const streak = opened("ROLLBACK_STREAK", hive);
    const budget = opened("ERROR_BUDGET_EXHAUSTED", hive);
    const failed = opened("ROLLBACK_FAILED", release);
    const r = new EscalationPlanner([streak, budget, failed], ctx).resolve(streak.escalationId, "resume_autonomy", USER);
    expect(r.escalations.map((e) => [e.reason, e.resolution])).toEqual([
      ["ROLLBACK_STREAK", "resume_autonomy"],
      ["ERROR_BUDGET_EXHAUSTED", "resume_autonomy"],
    ]);
    expect(r.effects).toEqual([{ type: "autonomy.resume", resetStreak: true }]);
  });
});

describe("escalation planner: auto-resolve", () => {
  it("a superseded APPROVAL_REQUIRED resolves as superseded; a tapped one as cleared; parked ones stay", () => {
    const r1 = opened("APPROVAL_REQUIRED", { type: "release", id: "r1" });
    const r2 = opened("SENTINEL_INCONCLUSIVE", { type: "release", id: "r2" });
    const r3 = opened("APPROVAL_REQUIRED", { type: "release", id: "r3" });
    const r4 = opened("APPROVAL_REQUIRED", { type: "release", id: "r4" }); // not in view
    const res = new EscalationPlanner([r1, r2, r3, r4], ctx).resolveStale({
      releases: [
        { releaseId: "r1", phase: "SUPERSEDED" },
        { releaseId: "r2", phase: "CANARY" },
        { releaseId: "r3", phase: "AWAITING_TAP" },
      ],
    });
    expect(res.escalations.map((e) => [e.subject.id, e.resolution, e.resolvedBy])).toEqual([
      ["r1", "superseded", "queen"],
      ["r2", "cleared: release canary", "queen"],
    ]);
    expect(resolutionAction(res.escalations[0]!)).toBeNull();
  });

  it("an informational (ack-only) canary SENTINEL_INCONCLUSIVE outlives its release", () => {
    const e = newEscalation("hive", 1, { reason: "SENTINEL_INCONCLUSIVE", subject: release, summary: "canary", actions: ["ack"] });
    expect(new EscalationPlanner([e], ctx).resolveStale({ releases: [{ releaseId: "r1", phase: "ROLLED_BACK" }] }).escalations).toEqual([]);
  });

  it("REWORK_EXHAUSTED resolves when its item left FAILED", () => {
    const e = opened("REWORK_EXHAUSTED", item);
    const p = new EscalationPlanner([e], ctx);
    expect(p.resolveStale({ items: [{ itemId: "i1", status: "FAILED" }] }).escalations).toEqual([]);
    expect(p.resolveStale({ items: [{ itemId: "i1", status: "CANCELLED" }] }).escalations).toEqual([
      expect.objectContaining({ status: "RESOLVED", resolution: "cleared: item cancelled" }),
    ]);
  });

  it("autoResolve by id", () => {
    const e = opened("GUARDRAIL_TRIPPED", hive);
    const p = new EscalationPlanner([e], ctx);
    expect(p.autoResolve(e.escalationId, "cleared: test").escalations[0]).toMatchObject({ status: "RESOLVED", resolvedBy: "queen" });
    expect(p.autoResolve(e.escalationId, "again").outcome).toBe("ignored:duplicate");
    expect(p.autoResolve("nope", "x").outcome).toBe("ignored:unknown");
  });
});

/**
 * Autonomy policy (v2 design §2.4, §2.8, §2.10). Pure: no I/O, no clock.
 *
 * The configured level (`hive_settings.autonomy`) degrades to `supervised`
 * while any of these holds:
 *   - ERROR_BUDGET_EXHAUSTED: the change-success SLO's error budget is < 0
 *     (unless a human resumed autonomy after the last counted failure);
 *   - ROLLBACK_STREAK: `rollback_streak ≥ 2`;
 *   - ROLLBACK_FAILED: an escalation of that reason is OPEN (prod may split).
 * `paused` never degrades (it is already the most restrictive level) and
 * `supervised` has nothing to degrade from, so only an `autonomous` hive
 * reports reasons.
 */
import type { AutonomyLevel, Escalation, EscalationReason, EventDraft, HiveHeadline, Release } from "@queenos/queen-types";
import { QUEEN_ACTOR, RESUMABLE_REASONS, escalationOpenedEvent, escalationResolvedEvent, newEscalation, resolutionAction, resolvedEscalation } from "./escalation";

/** Consecutive rollbacks (ROLLED_BACK or canary-FAILED) that degrade the hive. */
export const ROLLBACK_STREAK_LIMIT = 2;

// ── error budget (§2.8) ─────────────────────────────────────────────────

/** Counts over the SLO window: the last `window` terminal releases (SHIPPED, ROLLED_BACK, canary-FAILED). */
export interface ChangeSuccessInput {
  shipped: number;
  rolledBack: number;
  /** FAILED after the canary started (staging failures never reached users and do not count). */
  canaryFailed: number;
  /** `slo.changeSuccessTarget`, e.g. 0.9. */
  target: number;
  /** `slo.window`, e.g. 20. */
  window: number;
  /** When the newest counted failure happened (for the resume_autonomy waiver). */
  lastFailureAt?: number | null;
}

/** Same shape as `HiveStatus.slo`. */
export interface SloStatus {
  window: number;
  attempted: number;
  failed: number;
  target: number;
  errorBudgetRemaining: number;
  exhausted: boolean;
  lastFailureAt: number | null;
}

/** error budget = floor((1 − target) × window) − failures; < 0 ⇒ exhausted. */
export function errorBudget(input: ChangeSuccessInput): SloStatus {
  const failed = input.rolledBack + input.canaryFailed;
  // 1e-9 absorbs float error: (1 − 0.9) × 20 = 1.9999999999999996.
  const allowed = Math.floor((1 - input.target) * input.window + 1e-9);
  const remaining = allowed - failed;
  return {
    window: input.window,
    attempted: input.shipped + failed,
    failed,
    target: input.target,
    errorBudgetRemaining: remaining,
    exhausted: remaining < 0,
    lastFailureAt: input.lastFailureAt ?? null,
  };
}

/** A release that counts against change success: ROLLED_BACK, or FAILED once it had been tapped (canary). */
export function isReleaseFailure(r: Pick<Release, "phase" | "tappedAt">): boolean {
  return r.phase === "ROLLED_BACK" || (r.phase === "FAILED" && r.tappedAt !== null);
}

/**
 * The ChangeSuccessInput from release rows (any order): the newest `window`
 * terminal releases that count (SHIPPED, ROLLED_BACK, canary-FAILED), by updatedAt.
 */
export function changeSuccessFromReleases(
  releases: readonly Pick<Release, "phase" | "tappedAt" | "updatedAt">[],
  slo: { changeSuccessTarget: number; window: number },
): ChangeSuccessInput {
  const counted = releases
    .filter((r) => r.phase === "SHIPPED" || isReleaseFailure(r))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, slo.window);
  const failures = counted.filter(isReleaseFailure);
  return {
    shipped: counted.filter((r) => r.phase === "SHIPPED").length,
    rolledBack: failures.filter((r) => r.phase === "ROLLED_BACK").length,
    canaryFailed: failures.filter((r) => r.phase === "FAILED").length,
    target: slo.changeSuccessTarget,
    window: slo.window,
    lastFailureAt: failures.length ? Math.max(...failures.map((r) => r.updatedAt)) : null,
  };
}

// ── effective autonomy (§2.4) ───────────────────────────────────────────

export interface AutonomyInput {
  configured: AutonomyLevel;
  slo: SloStatus;
  rollbackStreak: number;
  /**
   * The hive's OPEN escalations, plus the most recent resolved
   * ROLLBACK_STREAK / ERROR_BUDGET_EXHAUSTED ones (their `resume_autonomy`
   * resolution waives an exhausted budget until the next failure).
   */
  escalations: readonly Escalation[];
}

export interface EffectiveAutonomy {
  configured: AutonomyLevel;
  level: AutonomyLevel;
  /** True when an autonomous hive runs as supervised. */
  degraded: boolean;
  /** Why (in a fixed order), for `autonomy.degraded`, `hive_settings.degraded_by` and the home page. */
  reasons: EscalationReason[];
  /** ReleasePlanner `ctx.autoShip`. */
  autoShip: boolean;
  /** ReleasePlanner `ctx.paused`; WorkPlanner dispatches nothing. */
  paused: boolean;
}

/** When a human last resumed autonomy (resume_autonomy on a resumable escalation), or null. */
export function autonomyResumedAt(escalations: readonly Escalation[]): number | null {
  let at: number | null = null;
  for (const e of escalations) {
    if (!RESUMABLE_REASONS.has(e.reason) || resolutionAction(e) !== "resume_autonomy" || e.resolvedAt === null) continue;
    at = at === null ? e.resolvedAt : Math.max(at, e.resolvedAt);
  }
  return at;
}

/** True when the budget is exhausted and no human waived it after the last counted failure. */
export function budgetDegrades(slo: SloStatus, escalations: readonly Escalation[]): boolean {
  if (!slo.exhausted) return false;
  const resumed = autonomyResumedAt(escalations);
  return resumed === null || (slo.lastFailureAt !== null && slo.lastFailureAt > resumed);
}

export function effectiveAutonomy(input: AutonomyInput): EffectiveAutonomy {
  const reasons: EscalationReason[] = [];
  if (input.configured === "autonomous") {
    if (budgetDegrades(input.slo, input.escalations)) reasons.push("ERROR_BUDGET_EXHAUSTED");
    if (input.rollbackStreak >= ROLLBACK_STREAK_LIMIT) reasons.push("ROLLBACK_STREAK");
    if (input.escalations.some((e) => e.status === "OPEN" && e.reason === "ROLLBACK_FAILED")) reasons.push("ROLLBACK_FAILED");
  }
  const level: AutonomyLevel = reasons.length ? "supervised" : input.configured;
  return { configured: input.configured, level, degraded: reasons.length > 0, reasons, autoShip: level === "autonomous", paused: level === "paused" };
}

// ── degradation transitions ─────────────────────────────────────────────

export interface AutonomyTransition {
  /** The new `hive_settings.degraded_by`. */
  degradedBy: EscalationReason[];
  changed: boolean;
  /** `autonomy.degraded` (new reasons) and/or `autonomy.restored` (all cleared). */
  events: EventDraft[];
  /** ERROR_BUDGET_EXHAUSTED opened when the budget newly degrades; auto-resolved when it no longer does. */
  escalations: Escalation[];
}

/**
 * Compare the stored `degraded_by` with the newly computed reasons. Opens
 * ERROR_BUDGET_EXHAUSTED (subject: hive) only on the transition, so an `ack`
 * that leaves the hive supervised does not reopen it; resolves an open one as
 * `cleared: …` when the budget no longer degrades. ROLLBACK_STREAK and
 * ROLLBACK_FAILED are opened by the release planner, where they happen.
 */
export function autonomyTransition(
  prev: readonly EscalationReason[],
  next: EffectiveAutonomy,
  ctx: { hive: string; now: number; slo: SloStatus; escalations: readonly Escalation[] },
): AutonomyTransition {
  const added = next.reasons.filter((r) => !prev.includes(r));
  const removed = prev.filter((r) => !next.reasons.includes(r));
  const events: EventDraft[] = [];
  const escalations: Escalation[] = [];
  if (added.length) {
    events.push({
      type: "autonomy.degraded",
      severity: "warn",
      actor: QUEEN_ACTOR,
      summary: `Autonomy degraded: ${next.configured} → ${next.level} (${next.reasons.join(", ")}).`,
      data: { configured: next.configured, level: next.level, reasons: next.reasons, added },
    });
  }
  if (removed.length && !next.reasons.length) {
    events.push({
      type: "autonomy.restored",
      actor: QUEEN_ACTOR,
      summary: `Autonomy restored: ${next.level} (${removed.join(", ")} cleared).`,
      data: { configured: next.configured, level: next.level, cleared: removed },
    });
  }
  const openBudget = ctx.escalations.find((e) => e.status === "OPEN" && e.reason === "ERROR_BUDGET_EXHAUSTED");
  if (added.includes("ERROR_BUDGET_EXHAUSTED") && !openBudget) {
    const e = newEscalation(ctx.hive, ctx.now, {
      reason: "ERROR_BUDGET_EXHAUSTED",
      subject: { type: "hive", id: ctx.hive },
      summary: `Change success ${ctx.slo.attempted - ctx.slo.failed}/${ctx.slo.attempted} over the last ${ctx.slo.window} releases (target ${ctx.slo.target}); error budget ${ctx.slo.errorBudgetRemaining}.`,
    });
    escalations.push(e);
    events.push(escalationOpenedEvent(e));
  }
  if (openBudget && !next.reasons.includes("ERROR_BUDGET_EXHAUSTED") && !budgetDegrades(ctx.slo, ctx.escalations)) {
    const e = resolvedEscalation(openBudget, QUEEN_ACTOR, `cleared: error budget ${ctx.slo.errorBudgetRemaining}`, ctx.now);
    escalations.push(e);
    events.push(escalationResolvedEvent(e));
  }
  return { degradedBy: [...next.reasons], changed: added.length > 0 || removed.length > 0, events, escalations };
}

// ── headline (§2.10) ────────────────────────────────────────────────────

export interface HeadlineInput {
  openEscalations: number;
  level: AutonomyLevel;
  budgetExhausted: boolean;
  /** Items by WorkStatus. */
  counts: Readonly<Record<string, number>>;
  queueCars: number;
  releaseInFlight: boolean;
}

export function hiveHeadline(i: HeadlineInput): HiveHeadline {
  const n = (s: string) => i.counts[s] ?? 0;
  if (i.openEscalations > 0) return "NEEDS_YOU";
  if (i.level === "paused" || i.budgetExhausted || (n("READY") + n("BLOCKED") > 0 && n("ACTIVE") === 0)) return "BLOCKED";
  if (n("ACTIVE") + n("LANDED") + n("DECOMPOSING") > 0 || i.queueCars > 0 || i.releaseInFlight) return "SHIPPING";
  return "IDLE";
}

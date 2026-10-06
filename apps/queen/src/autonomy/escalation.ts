/**
 * Escalations (v2 design §2.5, §3.5). Pure: no I/O, no clock, no randomness.
 *
 * The Queen acts first (parks, degrades, stops) and then asks a human through
 * an escalation with a fixed reason, a subject and the actions the RUNBOOK
 * allows. This module opens, resolves and auto-resolves escalations and maps
 * each human action to a transition intent the Queen applies with the owning
 * planner:
 *
 *   ship            → ReleasePlanner.tap(releaseId, user)
 *   hold            → nothing (the release stays parked; auto-ship is blocked for it)
 *   retry           → WorkPlanner.retry(itemId) (attempts and conflicts reset),
 *                     or resume merge-car formation (EXECUTOR_LOST on the hive),
 *                     or ReleasePlanner.retry(releaseId) (EXECUTOR_LOST on a release)
 *   cancel          → WorkPlanner.cancel(itemId)
 *   resume_autonomy → rollback streak = 0, error budget waived until the next failure,
 *                     sibling degradation escalations resolved
 *   raise_budget    → today's credits and dispatch limits × 1.5
 *   ack             → nothing
 *
 * Resolution text: `<action>` or `<action>: <note>` for a human; `superseded`
 * or `cleared: …` / `auto-shipped` when the Queen resolves a stale one.
 * `resolutionAction()` reads the action back (policy.ts uses it for the
 * budget waiver; the release planner for `hold`).
 */
import {
  EscalationActionSchema,
  escalationActions,
  type Escalation,
  type EscalationAction,
  type EscalationReason,
  type EscalationSubject,
  type EventDraft,
  type ReleasePhase,
  type WorkStatus,
} from "@queenos/queen-types";

/** Actor of escalations the Queen opens or resolves on its own. */
export const QUEEN_ACTOR = "queen";
/** Resolution of an APPROVAL_REQUIRED / SENTINEL_INCONCLUSIVE whose release was superseded. */
export const SUPERSEDED_RESOLUTION = "superseded";
/** `raise_budget` multiplies today's limits by this. */
export const RAISE_BUDGET_FACTOR = 1.5;

/** Reasons whose subject is a release parked at AWAITING_TAP. */
export const PARKED_RELEASE_REASONS: ReadonlySet<EscalationReason> = new Set(["APPROVAL_REQUIRED", "SENTINEL_INCONCLUSIVE"]);
/** Reasons that degrade autonomy and are lifted by `resume_autonomy`. */
export const RESUMABLE_REASONS: ReadonlySet<EscalationReason> = new Set(["ROLLBACK_STREAK", "ERROR_BUDGET_EXHAUSTED"]);

const clip = (s: string) => (s.length > 500 ? `${s.slice(0, 497)}...` : s);

/** Deterministic id: `<reason>:<subject type>:<subject id>:<now>` (one OPEN per reason + subject, so unique). */
export function escalationIdFor(reason: EscalationReason, subject: EscalationSubject, now: number): string {
  return `${reason.toLowerCase().replace(/_/g, "-")}:${subject.type}:${subject.id}:${now}`;
}

export interface EscalationDraft {
  reason: EscalationReason;
  subject: EscalationSubject;
  summary: string;
  traceId?: string | null;
  /** Default: the runbook's actions for the reason. */
  actions?: EscalationAction[];
}

/** A new OPEN escalation row. */
export function newEscalation(hive: string, now: number, d: EscalationDraft): Escalation {
  return {
    escalationId: escalationIdFor(d.reason, d.subject, now),
    hive,
    reason: d.reason,
    status: "OPEN",
    subject: { ...d.subject },
    traceId: d.traceId ?? null,
    summary: clip(d.summary),
    actions: [...(d.actions ?? escalationActions(d.reason))],
    createdAt: now,
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
  };
}

/** The same escalation, RESOLVED. */
export function resolvedEscalation(e: Escalation, by: string, resolution: string, now: number): Escalation {
  return { ...e, subject: { ...e.subject }, actions: [...e.actions], status: "RESOLVED", resolvedAt: now, resolvedBy: by, resolution: clip(resolution) };
}

/** The human action an escalation was resolved with (null when open, or resolved by the Queen). */
export function resolutionAction(e: Pick<Escalation, "status" | "resolution">): EscalationAction | null {
  if (e.status !== "RESOLVED" || !e.resolution) return null;
  const parsed = EscalationActionSchema.safeParse(e.resolution.split(":")[0]!.trim());
  return parsed.success ? parsed.data : null;
}

/** True when `subject` matches. */
export function isAbout(e: Pick<Escalation, "subject">, type: EscalationSubject["type"], id: string): boolean {
  return e.subject.type === type && e.subject.id === id;
}

export function escalationOpenedEvent(e: Escalation, actor = QUEEN_ACTOR): EventDraft {
  return {
    type: "escalation.opened",
    severity: e.reason === "ROLLBACK_FAILED" ? "error" : "warn",
    actor,
    traceId: e.traceId,
    itemId: e.subject.type === "item" ? e.subject.id : null,
    releaseId: e.subject.type === "release" ? e.subject.id : null,
    summary: clip(`${e.reason}: ${e.summary}`),
    data: { escalationId: e.escalationId, reason: e.reason, subject: e.subject, actions: e.actions },
  };
}

export function escalationResolvedEvent(e: Escalation): EventDraft {
  return {
    type: "escalation.resolved",
    actor: e.resolvedBy ?? QUEEN_ACTOR,
    traceId: e.traceId,
    itemId: e.subject.type === "item" ? e.subject.id : null,
    releaseId: e.subject.type === "release" ? e.subject.id : null,
    summary: clip(`${e.reason} resolved: ${e.resolution ?? ""}`),
    data: { escalationId: e.escalationId, reason: e.reason, resolution: e.resolution },
  };
}

// ── intents ─────────────────────────────────────────────────────────────

/** A transition the Queen applies with the owning planner (or on hive_settings). */
export type EscalationIntent =
  /** ReleasePlanner.tap(releaseId, user). */
  | { type: "release.tap"; releaseId: string; user: string }
  /** ReleasePlanner.retry(releaseId, user): re-run the step infrastructure stopped (EXECUTOR_LOST on a release). */
  | { type: "release.retry"; releaseId: string; user: string }
  /** WorkPlanner.retry(itemId): FAILED → READY, attempts and conflicts reset. */
  | { type: "work.retry"; itemId: string; user: string; resetAttempts: true; resetConflicts: true }
  /** WorkPlanner.cancel(itemId). */
  | { type: "work.cancel"; itemId: string; user: string }
  /** Resume merge-car formation: hive_settings.car_infra_failures = 0. */
  | { type: "queue.resume" }
  /** hive_settings.rollback_streak = 0 and degraded_by cleared; the budget waiver is the resolution itself. */
  | { type: "autonomy.resume"; resetStreak: true }
  /** Today's limits become `dailyCredits` / `dailyDispatches` (× RAISE_BUDGET_FACTOR, rounded up). */
  | { type: "budget.raise"; dailyCredits: number; dailyDispatches: number };

export type EscalationOutcome =
  | "applied"
  | "ignored:unknown"
  /** Already resolved (a double click), or an identical escalation is already open. */
  | "ignored:duplicate"
  /** The action is not allowed for this escalation, or its subject is no longer in a state the action can act on. */
  | "conflict";

export interface EscalationPlanResult {
  outcome: EscalationOutcome;
  /** Rows to upsert (opened or resolved). */
  escalations: Escalation[];
  /** Transitions for the Queen to apply, in order, in the same decide(). */
  effects: EscalationIntent[];
  events: EventDraft[];
}

export interface EscalationContext {
  hive: string;
  now: number;
}

/** What the subject looks like now; checked before an action is turned into an intent. */
export interface SubjectView {
  /** Phase of the subject release (ship needs AWAITING_TAP). */
  releasePhase?: ReleasePhase;
  /** Status of the subject item (retry and cancel need FAILED). */
  itemStatus?: WorkStatus;
  /** Today's effective limits, for raise_budget. */
  budget?: { dailyCredits: number; dailyDispatches: number };
}

/**
 * Pure escalation planner over the hive's escalations (OPEN ones, plus any
 * resolved ones the caller wants considered). Each call returns the rows that
 * changed and the intents to apply; the planner keeps its copy in sync so
 * calls can be chained within one decide().
 */
export class EscalationPlanner {
  private readonly rows: Escalation[];
  private changed = new Map<string, Escalation>();
  private effects: EscalationIntent[] = [];
  private events: EventDraft[] = [];

  constructor(
    escalations: readonly Escalation[],
    private readonly ctx: EscalationContext,
  ) {
    this.rows = escalations.map((e) => ({ ...e, subject: { ...e.subject }, actions: [...e.actions] }));
  }

  /** The open escalation of this reason about this subject, if any. */
  findOpen(reason: EscalationReason, subject: EscalationSubject): Escalation | undefined {
    return this.rows.find((e) => e.status === "OPEN" && e.reason === reason && isAbout(e, subject.type, subject.id));
  }

  /** Open an escalation; a second OPEN one of the same reason and subject is a duplicate. */
  open(d: EscalationDraft, actor = QUEEN_ACTOR): EscalationPlanResult {
    if (this.findOpen(d.reason, d.subject)) return this.finish("ignored:duplicate");
    const e = newEscalation(this.ctx.hive, this.ctx.now, d);
    this.rows.push(e);
    this.changed.set(e.escalationId, e);
    this.events.push(escalationOpenedEvent(e, actor));
    return this.finish("applied");
  }

  /**
   * A human resolves an escalation (`POST /hives/:hive/escalations/:id/resolve`).
   * The action must be one the escalation offers, and the subject must still be
   * actionable (pass `subject` when known; it is not checked otherwise).
   */
  resolve(escalationId: string, action: EscalationAction, user: string, note?: string, subject: SubjectView = {}): EscalationPlanResult {
    const e = this.rows.find((x) => x.escalationId === escalationId);
    if (!e) return this.finish("ignored:unknown");
    if (e.status === "RESOLVED") return this.finish("ignored:duplicate");
    if (!e.actions.includes(action)) return this.finish("conflict");
    const intents = this.intentsFor(e, action, user, subject);
    if (intents === null) return this.finish("conflict");
    this.settle(e, user, note ? `${action}: ${note}` : action);
    if (action === "resume_autonomy") {
      // Restoring autonomy lifts every resumable degradation, not just this one.
      for (const sib of this.rows) {
        if (sib.status === "OPEN" && sib !== e && RESUMABLE_REASONS.has(sib.reason)) this.settle(sib, user, "resume_autonomy");
      }
    }
    this.effects.push(...intents);
    return this.finish("applied");
  }

  /** The Queen resolves an escalation on its own (cause cleared, superseded, auto-shipped). */
  autoResolve(escalationId: string, resolution: string, by = QUEEN_ACTOR): EscalationPlanResult {
    const e = this.rows.find((x) => x.escalationId === escalationId);
    if (!e) return this.finish("ignored:unknown");
    if (e.status === "RESOLVED") return this.finish("ignored:duplicate");
    this.settle(e, by, resolution);
    return this.finish("applied");
  }

  /**
   * Resolve escalations whose subject moved on without a human:
   * - APPROVAL_REQUIRED / SENTINEL_INCONCLUSIVE whose release left AWAITING_TAP
   *   (SUPERSEDED → `superseded`; tapped or otherwise → `cleared: release <phase>`);
   * - EXECUTOR_LOST on a release that is no longer parked (superseded or ended);
   * - REWORK_EXHAUSTED whose item is no longer FAILED (retried or cancelled elsewhere).
   * Subjects not listed are left alone.
   */
  resolveStale(view: {
    releases?: readonly { releaseId: string; phase: ReleasePhase }[];
    items?: readonly { itemId: string; status: WorkStatus }[];
  }): EscalationPlanResult {
    const releases = new Map((view.releases ?? []).map((r) => [r.releaseId, r.phase]));
    const items = new Map((view.items ?? []).map((i) => [i.itemId, i.status]));
    for (const e of this.rows) {
      if (e.status !== "OPEN") continue;
      if (PARKED_RELEASE_REASONS.has(e.reason) && e.subject.type === "release") {
        const phase = releases.get(e.subject.id);
        if (phase === undefined || phase === "AWAITING_TAP") continue;
        // A canary-time SENTINEL_INCONCLUSIVE is informational (ack only): it outlives its release.
        if (!e.actions.includes("ship")) continue;
        this.settle(e, QUEEN_ACTOR, phase === "SUPERSEDED" ? SUPERSEDED_RESOLUTION : `cleared: release ${phase.toLowerCase()}`);
      } else if (e.reason === "EXECUTOR_LOST" && e.subject.type === "release") {
        // A release parked on infrastructure that moved on without a retry (superseded, or ended).
        const phase = releases.get(e.subject.id);
        if (phase === undefined || phase === "STAGING" || phase === "AWAITING_TAP" || phase === "CANARY") continue;
        this.settle(e, QUEEN_ACTOR, phase === "SUPERSEDED" ? SUPERSEDED_RESOLUTION : `cleared: release ${phase.toLowerCase()}`);
      } else if (e.reason === "REWORK_EXHAUSTED" && e.subject.type === "item") {
        const status = items.get(e.subject.id);
        if (status === undefined || status === "FAILED") continue;
        this.settle(e, QUEEN_ACTOR, `cleared: item ${status.toLowerCase()}`);
      }
    }
    return this.finish("applied");
  }

  /** All rows as the planner now sees them. */
  all(): Escalation[] {
    return this.rows.map((e) => ({ ...e, subject: { ...e.subject }, actions: [...e.actions] }));
  }

  // ── internals ─────────────────────────────────────────────────────────

  /** The intents for `action` on `e`, or null when the subject cannot take it. */
  private intentsFor(e: Escalation, action: EscalationAction, user: string, s: SubjectView): EscalationIntent[] | null {
    const { type, id } = e.subject;
    switch (action) {
      case "ship":
        if (type !== "release") return null;
        if (s.releasePhase !== undefined && s.releasePhase !== "AWAITING_TAP") return null;
        return [{ type: "release.tap", releaseId: id, user }];
      case "hold":
      case "ack":
        return [];
      case "retry":
        if (type === "item") {
          if (s.itemStatus !== undefined && s.itemStatus !== "FAILED") return null;
          return [{ type: "work.retry", itemId: id, user, resetAttempts: true, resetConflicts: true }];
        }
        if (type === "hive" && e.reason === "EXECUTOR_LOST") return [{ type: "queue.resume" }];
        if (type === "release" && e.reason === "EXECUTOR_LOST") return [{ type: "release.retry", releaseId: id, user }];
        return null;
      case "cancel":
        if (type !== "item") return null;
        if (s.itemStatus !== undefined && s.itemStatus !== "FAILED") return null;
        return [{ type: "work.cancel", itemId: id, user }];
      case "resume_autonomy":
        return [{ type: "autonomy.resume", resetStreak: true }];
      case "raise_budget": {
        if (!s.budget) return null;
        return [
          {
            type: "budget.raise",
            dailyCredits: Math.ceil(s.budget.dailyCredits * RAISE_BUDGET_FACTOR),
            dailyDispatches: Math.ceil(s.budget.dailyDispatches * RAISE_BUDGET_FACTOR),
          },
        ];
      }
    }
  }

  private settle(e: Escalation, by: string, resolution: string): void {
    Object.assign(e, resolvedEscalation(e, by, resolution, this.ctx.now));
    this.changed.set(e.escalationId, e);
    this.events.push(escalationResolvedEvent(e));
  }

  private finish(outcome: EscalationOutcome): EscalationPlanResult {
    const result: EscalationPlanResult = {
      outcome,
      escalations: [...this.changed.values()].map((e) => ({ ...e, subject: { ...e.subject }, actions: [...e.actions] })),
      effects: this.effects,
      events: this.events,
    };
    this.changed = new Map();
    this.effects = [];
    this.events = [];
    return result;
  }
}

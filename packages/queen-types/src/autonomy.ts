import { z } from "zod";
import { TraceIdSchema } from "./trace.js";
import { GUARDRAIL_DEFAULTS, GuardrailsSchema } from "./work.js";

/**
 * Autonomy, escalations and hive settings (v2 design §2.4, §2.5, §2.8, §2.9).
 * Releases ship on their own while the gates, Sentinel and the error budget
 * are green; the Queen acts first (parks, degrades, stops) and then asks a
 * human through an escalation with a fixed reason and runbook.
 */

export const AutonomyLevelSchema = z.enum(["autonomous", "supervised", "paused"]);
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;

/** `tappedBy` of a release the Queen shipped on its own. */
export const AUTO_SHIP_ACTOR = "queen:autonomous";

export const EscalationReasonSchema = z.enum([
  "APPROVAL_REQUIRED",
  "SENTINEL_INCONCLUSIVE",
  "REWORK_EXHAUSTED",
  "ROLLBACK_STREAK",
  "ROLLBACK_FAILED",
  "ERROR_BUDGET_EXHAUSTED",
  "BUDGET_EXHAUSTED",
  "GUARDRAIL_TRIPPED",
  "EXECUTOR_LOST",
]);
export type EscalationReason = z.infer<typeof EscalationReasonSchema>;

export const EscalationActionSchema = z.enum(["ship", "hold", "retry", "cancel", "resume_autonomy", "raise_budget", "ack"]);
export type EscalationAction = z.infer<typeof EscalationActionSchema>;

export const EscalationSubjectSchema = z.object({ type: z.enum(["item", "release", "hive"]), id: z.string() });
export type EscalationSubject = z.infer<typeof EscalationSubjectSchema>;

export const EscalationSchema = z.object({
  escalationId: z.string(),
  hive: z.string(),
  reason: EscalationReasonSchema,
  status: z.enum(["OPEN", "RESOLVED"]),
  subject: EscalationSubjectSchema,
  traceId: TraceIdSchema.nullable(),
  summary: z.string().max(500),
  actions: z.array(EscalationActionSchema),
  createdAt: z.number().int(),
  resolvedAt: z.number().int().nullable(),
  resolvedBy: z.string().nullable(),
  resolution: z.string().max(500).nullable(),
});
export type Escalation = z.infer<typeof EscalationSchema>;

export interface RunbookEntry {
  /** What happened. */
  what: string;
  /** What the Queen already did. */
  did: string;
  /** What each allowed action does (the keys are the escalation's default actions). */
  actions: Partial<Record<EscalationAction, string>>;
}

/** Versioned with the code: the dashboard shows it on every escalation card (§2.5). */
export const RUNBOOK: Readonly<Record<EscalationReason, RunbookEntry>> = {
  APPROVAL_REQUIRED: {
    what: "A release passed staging and Sentinel in a supervised hive.",
    did: "Parked the release at AWAITING_TAP; no canary has started.",
    actions: { ship: "Tap to ship: start the canary at 1%.", hold: "Keep it parked; a newer landing supersedes it." },
  },
  SENTINEL_INCONCLUSIVE: {
    what: "Sentinel could not measure staging (readiness timeout, or fewer than half the minimum requests).",
    did: "Parked the release at AWAITING_TAP, even in an autonomous hive.",
    actions: {
      ship: "Ship anyway: start the canary at 1% (each step is still checked).",
      hold: "Keep it parked.",
      ack: "Acknowledge; the release was already rolled back or is superseded.",
    },
  },
  REWORK_EXHAUSTED: {
    what: "An item failed its gate after the maximum reworks, or hit the merge-conflict rework cap.",
    did: "Stopped the item (FAILED) and released its path claims; the Scribe or conflict summaries are attached.",
    actions: { retry: "Reset attempts and conflicts and put the item back to READY.", cancel: "Cancel the item." },
  },
  ROLLBACK_STREAK: {
    what: "Two releases in a row were rolled back or failed their canary.",
    did: "Degraded the hive to supervised and filed a P0 bug per rollback.",
    actions: { resume_autonomy: "Reset the streak and restore the configured autonomy.", ack: "Acknowledge; stay supervised." },
  },
  ROLLBACK_FAILED: {
    what: "The Herald could not roll a canary back after its retries.",
    did: "Prod may be splitting traffic; the hive is supervised.",
    actions: { ack: "Acknowledge after fixing the deployment by hand." },
  },
  ERROR_BUDGET_EXHAUSTED: {
    what: "The change-success SLO's error budget is below zero.",
    did: "Degraded the hive to supervised until the window slides or a release ships.",
    actions: { resume_autonomy: "Restore the configured autonomy now.", ack: "Acknowledge; stay supervised." },
  },
  BUDGET_EXHAUSTED: {
    what: "Today's credits or dispatches hit the hive budget.",
    did: "Paused dispatch until the next UTC day; in-flight work finishes.",
    actions: { raise_budget: "Raise today's budget by 50% and resume dispatch.", ack: "Acknowledge; wait for tomorrow." },
  },
  GUARDRAIL_TRIPPED: {
    what: "A guardrail tripped: children truncated, the open-item cap hit, or the depth cap exceeded.",
    did: "Dropped or truncated the extra items.",
    actions: { ack: "Acknowledge." },
  },
  EXECUTOR_LOST: {
    what: "An executor command exhausted its watchdog attempts, or three merge-queue cars in a row failed on infrastructure.",
    did: "Failed the item (or fell back), or paused merge-car formation.",
    actions: { retry: "Retry: resume the merge queue or re-issue the command.", ack: "Acknowledge." },
  },
};

/** The actions an escalation of this reason offers (the runbook's keys, in display order). */
export function escalationActions(reason: EscalationReason): EscalationAction[] {
  return Object.keys(RUNBOOK[reason].actions) as EscalationAction[];
}

/** POST /hives/:hive/escalations/:id/resolve. */
export const ResolveEscalationSchema = z.object({ action: EscalationActionSchema, note: z.string().max(500).optional() });
export type ResolveEscalation = z.infer<typeof ResolveEscalationSchema>;

export const HiveSettingsSchema = z.object({
  autonomy: AutonomyLevelSchema,
  guardrails: GuardrailsSchema,
  budget: z.object({ dailyCredits: z.number().int().min(0), dailyDispatches: z.number().int().min(0) }),
  slo: z.object({ changeSuccessTarget: z.number().min(0.5).max(1), window: z.number().int().min(5).max(100) }),
  race: z.object({ reworkWidth: z.number().int().min(1).max(5), hardWidth: z.number().int().min(1).max(5) }),
});
export type HiveSettings = z.infer<typeof HiveSettingsSchema>;

/** Settings of a NEW hive (D2: existing hives migrate as `supervised`, see migration v10). */
export const HIVE_SETTINGS_DEFAULTS: HiveSettings = {
  autonomy: "autonomous",
  guardrails: { ...GUARDRAIL_DEFAULTS },
  budget: { dailyCredits: 50_000, dailyDispatches: 400 },
  slo: { changeSuccessTarget: 0.9, window: 20 },
  race: { reworkWidth: 2, hardWidth: 3 },
};

/** Per-hive overrides of HIVE_SETTINGS_DEFAULTS, as stored (`hive_settings.settings`); autonomy has its own column. */
export const HiveSettingsOverridesSchema = z.object({
  guardrails: GuardrailsSchema.partial().optional(),
  budget: HiveSettingsSchema.shape.budget.partial().optional(),
  slo: HiveSettingsSchema.shape.slo.partial().optional(),
  race: HiveSettingsSchema.shape.race.partial().optional(),
});
export type HiveSettingsOverrides = z.infer<typeof HiveSettingsOverridesSchema>;

/**
 * A today-only raise of the budget (the `raise_budget` escalation action): the
 * limits that apply on `day` (UTC, YYYY-MM-DD); ignored on any other day.
 */
export const BudgetBoostSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dailyCredits: z.number().int().min(0),
  dailyDispatches: z.number().int().min(0),
});
export type BudgetBoost = z.infer<typeof BudgetBoostSchema>;

/** PATCH /hives/:hive/settings. */
export const UpdateHiveSettingsSchema = z.object({
  autonomy: AutonomyLevelSchema.optional(),
  guardrails: GuardrailsSchema.partial().optional(),
  budget: HiveSettingsSchema.shape.budget.partial().optional(),
  race: HiveSettingsSchema.shape.race.partial().optional(),
});
export type UpdateHiveSettings = z.infer<typeof UpdateHiveSettingsSchema>;

export const HiveHeadlineSchema = z.enum(["SHIPPING", "BLOCKED", "NEEDS_YOU", "IDLE"]);
export type HiveHeadline = z.infer<typeof HiveHeadlineSchema>;

export const HiveStatusSchema = z.object({
  hive: z.string(),
  /** `sim` when the Queen runs against simulated executors (dev:sim), `live` otherwise. Absent on old Queens. */
  mode: z.enum(["sim", "live"]).optional(),
  settings: HiveSettingsSchema,
  effectiveAutonomy: AutonomyLevelSchema,
  degradedBy: z.array(EscalationReasonSchema).max(5),
  headline: HiveHeadlineSchema,
  budget: z.object({
    day: z.string(),
    creditsUsed: z.number(),
    creditsLimit: z.number(),
    dispatches: z.number().int(),
    dispatchLimit: z.number().int(),
  }),
  slo: z.object({
    window: z.number().int(),
    attempted: z.number().int(),
    failed: z.number().int(),
    target: z.number(),
    errorBudgetRemaining: z.number().int(),
    exhausted: z.boolean(),
  }),
  /** By WorkStatus. */
  counts: z.record(z.string(), z.number().int()),
  throughput: z.object({
    shipped24h: z.number().int(),
    landed24h: z.number().int(),
    leadTimeP50Ms: z.number().nullable(),
    firstTryPassRate: z.number().nullable(),
  }),
  concurrency: z
    .object({
      activeBuilds: z.number().int(),
      slots: z.number().int(),
      leasedSlots: z.number().int(),
      affinityWaits: z.number().int(),
      queueDepth: z.number().int(),
      waitingToBoard: z.number().int(),
      landed1h: z.number().int(),
      conflicts24h: z.number().int(),
      bisects24h: z.number().int(),
      queueWaitP50Ms: z.number().nullable(),
    })
    .optional(),
});
export type HiveStatus = z.infer<typeof HiveStatusSchema>;

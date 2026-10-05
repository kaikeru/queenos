/**
 * v2 row records (WP0 seam): the in-memory shape of the v8–v11 tables, shared
 * by db.ts (row mapping) and the pure planners (work ledger, races, affinity,
 * autonomy). Each extends its queen-types contract with Queen-internal columns.
 */
import type { AutonomyLevel, BudgetBoost, Escalation, EscalationReason, HiveSettingsOverrides, Race, WorkItem } from "@queenos/queen-types";

/** Row of `work_items`. */
export interface WorkItemRecord extends WorkItem {
  /** Filing order (dispatch order is priority, then seq). */
  seq: number;
  /** Current Oracle command (DECOMPOSE / TRIAGE) and its watchdog clock. */
  commandId: string | null;
  commandIssuedAt: number | null;
  /** Exact-dedupe key: lowercased, whitespace-collapsed title. */
  normalizedTitle: string;
  /** Lead / cycle time. */
  landedAt: number | null;
  shippedAt: number | null;
}

/** Row of `races`. */
export type RaceRecord = Race;

/** Row of `escalations`. */
export type EscalationRecord = Escalation;

/** The single `hive_settings` row (id = 1). */
export interface HiveSettingsRecord {
  hive: string;
  /** Configured level; the effective level comes from autonomy/policy.ts. */
  autonomy: AutonomyLevel;
  /** Overrides of HIVE_SETTINGS_DEFAULTS (`hive_settings.settings` JSON). */
  overrides: HiveSettingsOverrides;
  /** UTC day (YYYY-MM-DD) the budget counters belong to. */
  budgetDay: string | null;
  creditsUsed: number;
  dispatches: number;
  /** Epoch hour of `autoFiledCount`. */
  autoFiledHour: number | null;
  autoFiledCount: number;
  rollbackStreak: number;
  degradedBy: EscalationReason[];
  updatedBy: string | null;
  updatedAt: number;
  /** SwarmGovernor lease (§4.3). */
  leasedSlots: number;
  leaseExpiresAt: number | null;
  /** Consecutive merge-queue cars failed on infrastructure (3 → EXECUTOR_LOST). */
  carInfraFailures: number;
  /** Today-only budget raise (v12 `budget_boost`); only in effect while `day` is the current UTC day. */
  budgetBoost?: BudgetBoost | null;
}

export type PathClaimSource = "predicted" | "actual" | "conflict";

/** Row of `path_claims`: an ACTIVE item temporarily owns a path (§2.3.5). */
export interface PathClaim {
  path: string;
  itemId: string;
  source: PathClaimSource;
  createdAt: number;
}

/** A delta to `metrics_hourly` (accumulated: count/sum add, min/max fold). */
export interface MetricDelta {
  /** Epoch ms of the hour start. */
  bucket: number;
  name: string;
  labels: Record<string, string>;
  count: number;
  sum: number;
  min: number;
  max: number;
}

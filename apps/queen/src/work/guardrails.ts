/**
 * Guardrails and budget (v2 design §2.9): who can file what, hard caps, the
 * daily budget and path normalisation. Pure: no I/O, no clock (callers pass
 * `now`), no randomness.
 */
import {
  ENTRY_WINDOW_DEFAULT_MS,
  ENTRY_WINDOW_MAX_MS,
  GUARDRAIL_DEFAULTS,
  GUARDRAIL_MAX,
  HIVE_SETTINGS_DEFAULTS,
  MODEL_CATALOG,
  PICK_WINDOW_DEFAULT_MS,
  PICK_WINDOW_MAX_MS,
  PathPatternSchema,
  isGeneratedPath,
  type BuildUsage,
  type FollowUp,
  type Guardrails,
  type HiveSettings,
  type HiveSettingsOverrides,
  type WorkSourceKind,
} from "@queenos/queen-types";
import type { HiveSettingsRecord } from "../records";

/** Max predicted paths per item (WorkItemSchema.paths). */
export const MAX_ITEM_PATHS = 10;
const HOUR_MS = 3_600_000;
/** The shortest pick window (RaceSettingsSchema min; train/pick.ts PICK_WINDOW_MIN_MS). */
const PICK_WINDOW_MIN_MS = 60_000;

// ── settings ─────────────────────────────────────────────────────────────

function clampInt(v: number | undefined, min: number, max: number, fallback: number): number {
  if (v === undefined || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

/**
 * GUARDRAIL_DEFAULTS with per-hive overrides, each clamped to [1 (0 where allowed), GUARDRAIL_MAX].
 * `maxPickingRaces` is clamped to at least 1 although its schema allows 0 (human-push design §13 seams):
 * 0 would turn every human-judged race into a `queen:cap` decision.
 */
export function effectiveGuardrails(overrides: Partial<Guardrails> | undefined): Guardrails {
  const o = overrides ?? {};
  const out = { ...GUARDRAIL_DEFAULTS } as Guardrails;
  for (const key of Object.keys(GUARDRAIL_DEFAULTS) as (keyof Guardrails)[]) {
    const min = key === "maxAutoFiledPerHour" || key === "maxFollowUpsPerBuild" || key === "maxConflictReworks" ? 0 : 1;
    out[key] = clampInt(o[key], min, GUARDRAIL_MAX[key], GUARDRAIL_DEFAULTS[key]);
  }
  return out;
}

/**
 * The hive's effective settings: HIVE_SETTINGS_DEFAULTS + stored overrides (guardrails clamped).
 * With `now`, a `budgetBoost` for that UTC day (the `raise_budget` action) replaces the daily limits.
 */
export function effectiveSettings(record: Pick<HiveSettingsRecord, "autonomy" | "overrides" | "budgetBoost"> | null, now?: number): HiveSettings {
  const o: HiveSettingsOverrides = record?.overrides ?? {};
  const d = HIVE_SETTINGS_DEFAULTS;
  const boost = now !== undefined && record?.budgetBoost && record.budgetBoost.day === utcDay(now) ? record.budgetBoost : null;
  return {
    autonomy: record?.autonomy ?? d.autonomy,
    guardrails: effectiveGuardrails(o.guardrails),
    budget: {
      dailyCredits: boost?.dailyCredits ?? clampInt(o.budget?.dailyCredits, 0, Number.MAX_SAFE_INTEGER, d.budget.dailyCredits),
      dailyDispatches: boost?.dailyDispatches ?? clampInt(o.budget?.dailyDispatches, 0, Number.MAX_SAFE_INTEGER, d.budget.dailyDispatches),
    },
    slo: { ...d.slo, ...(o.slo ?? {}) },
    race: {
      reworkWidth: clampInt(o.race?.reworkWidth, 1, 5, d.race.reworkWidth),
      hardWidth: clampInt(o.race?.hardWidth, 1, 5, d.race.hardWidth),
      // Human-judged races (§10.2): who decides a race, and how long a PICKING race waits for a human.
      judge: o.race?.judge ?? d.race.judge ?? "auto",
      pickWindowMs: clampInt(o.race?.pickWindowMs, PICK_WINDOW_MIN_MS, PICK_WINDOW_MAX_MS, d.race.pickWindowMs ?? PICK_WINDOW_DEFAULT_MS),
      // External hives: how long a race a push opened stays open to entries (0 = no window).
      entryWindowMs: clampInt(o.race?.entryWindowMs, 0, ENTRY_WINDOW_MAX_MS, d.race.entryWindowMs ?? ENTRY_WINDOW_DEFAULT_MS),
    },
    executors: o.executors ?? d.executors ?? "swarm",
  };
}

/** A fresh `hive_settings` row (first filing in a new hive: autonomous, D2). */
export function defaultSettingsRecord(hive: string, now: number): HiveSettingsRecord {
  return {
    hive,
    autonomy: HIVE_SETTINGS_DEFAULTS.autonomy,
    overrides: {},
    budgetDay: utcDay(now),
    creditsUsed: 0,
    dispatches: 0,
    autoFiledHour: null,
    autoFiledCount: 0,
    rollbackStreak: 0,
    degradedBy: [],
    updatedBy: "queen",
    updatedAt: now,
    leasedSlots: 0,
    leaseExpiresAt: null,
    carInfraFailures: 0,
  };
}

// ── clocks (pure: derived from `now`) ────────────────────────────────────

/** UTC day `YYYY-MM-DD` of an epoch-ms instant. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Epoch hour (floor(now / 1h)). */
export function epochHour(now: number): number {
  return Math.floor(now / HOUR_MS);
}

// ── budget ───────────────────────────────────────────────────────────────

export interface BudgetLimits {
  dailyCredits: number;
  dailyDispatches: number;
}

/** The budget counters for `now`: reset to zero when the UTC day changed. Returns the same object when unchanged. */
export function rollBudgetDay(s: HiveSettingsRecord, now: number): HiveSettingsRecord {
  const day = utcDay(now);
  if (s.budgetDay === day) return s;
  return { ...s, budgetDay: day, creditsUsed: 0, dispatches: 0 };
}

/** Today's budget is spent (credits or dispatches at or over the limit). Assumes the counters are rolled to today. */
export function budgetExhausted(s: Pick<HiveSettingsRecord, "creditsUsed" | "dispatches">, limits: BudgetLimits): boolean {
  return s.creditsUsed >= limits.dailyCredits || s.dispatches >= limits.dailyDispatches;
}

/** Dispatches still allowed today (≥ 0). */
export function dispatchesLeft(s: Pick<HiveSettingsRecord, "dispatches">, limits: BudgetLimits): number {
  return Math.max(0, limits.dailyDispatches - s.dispatches);
}

/**
 * Credits of one LLM call or build (§2.9): `(inputTokens + outputTokens) / 1000 × catalog cost`.
 * An unknown or missing model costs 1 per 1k tokens; no usage costs nothing.
 */
export function creditsFor(model: string | null | undefined, usage: BuildUsage | null | undefined): number {
  if (!usage) return 0;
  const cost = MODEL_CATALOG.find((m) => m.id === model)?.cost ?? 1;
  return ((usage.inputTokens + usage.outputTokens) / 1000) * cost;
}

// ── normalisation ────────────────────────────────────────────────────────

/** Exact-dedupe key: lowercased, whitespace-collapsed, trimmed title. */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * One predicted path pattern, normalised (hive-kit `assertRepoPath` rules plus
 * PathPatternSchema): a leading "./" is stripped; absolute paths, "..", "." or
 * empty segments, backslashes, `.git/` and globs are rejected (null). A
 * trailing "/" (directory) is kept. Generated paths normalise to null (never claimed).
 */
export function normalizePath(raw: string): string | null {
  let p = raw.trim().replace(/^(\.\/)+/, "");
  if (p.length === 0 || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return null;
  const dir = p.endsWith("/");
  if (dir) p = p.slice(0, -1);
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..") || parts[0] === ".git") return null;
  const out = dir ? `${p}/` : p;
  if (!PathPatternSchema.safeParse(out).success || isGeneratedPath(out)) return null;
  return out;
}

/** Normalise a predicted path list: invalid and generated paths dropped, duplicates removed, ≤ MAX_ITEM_PATHS. */
export function normalizePaths(paths: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of paths ?? []) {
    const p = normalizePath(raw);
    if (p !== null && !out.includes(p)) out.push(p);
    if (out.length === MAX_ITEM_PATHS) break;
  }
  return out;
}

// ── who may file what ────────────────────────────────────────────────────

/** Sources whose filings are "auto-filed" (subject to the hourly cap, TRIAGE dedupe, and drops instead of 409s). */
export function isAutoFiled(kind: WorkSourceKind): boolean {
  return kind === "drone" || kind === "gatekeeper" || kind === "sentinel" || kind === "queen";
}

/**
 * The priority an auto-filed follow-up gets (§2.9 "max priority"): drones are
 * clamped to P2 at best; gatekeepers to P1 (security) / P2 (policy), i.e. P1 at
 * best; the Queen files P0.
 */
export function followUpPriority(source: WorkSourceKind, fu: Pick<FollowUp, "priority">): number {
  switch (source) {
    case "drone":
      return Math.max(2, fu.priority);
    case "gatekeeper":
      return Math.max(1, fu.priority);
    case "queen":
    case "sentinel":
      return 0;
    default:
      return fu.priority;
  }
}

export type FilingVerdict =
  | { ok: true }
  | { ok: false; reason: "max_depth" | "max_open_items" | "max_auto_filed_per_hour"; message: string };

/**
 * Hard caps on one filing (§2.9): depth, the hive's open-item cap, and (for
 * auto-filed items) the hourly cap. `autoFiledThisHour` is the count already
 * filed this epoch hour. The caller decides the trip action (user: 409 +
 * GUARDRAIL_TRIPPED; auto-filed: dropped).
 */
export function checkFiling(input: {
  depth: number;
  openItems: number;
  autoFiled: boolean;
  autoFiledThisHour: number;
  guardrails: Guardrails;
}): FilingVerdict {
  const g = input.guardrails;
  if (input.depth > g.maxDepth) {
    return { ok: false, reason: "max_depth", message: `depth ${input.depth} exceeds maxDepth ${g.maxDepth}` };
  }
  if (input.openItems >= g.maxOpenItems) {
    return { ok: false, reason: "max_open_items", message: `${input.openItems} open items: maxOpenItems is ${g.maxOpenItems}` };
  }
  if (input.autoFiled && input.autoFiledThisHour >= g.maxAutoFiledPerHour) {
    return {
      ok: false,
      reason: "max_auto_filed_per_hour",
      message: `${input.autoFiledThisHour} items auto-filed this hour: maxAutoFiledPerHour is ${g.maxAutoFiledPerHour}`,
    };
  }
  return { ok: true };
}

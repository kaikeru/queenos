/**
 * Model routing helpers for the War Room: catalog lookups, tier badges and the
 * Model Board (per-tier leaderboard). Pure functions; the Queen decides routing,
 * the dashboard only presents it.
 */
import { MODEL_CATALOG, type CatalogModel, type ModelStats, type ModelTier } from "@queenos/queen-types";

export const TIERS: readonly ModelTier[] = ["frontier", "fast", "light"];

const TIER_RANK: Record<ModelTier, number> = { light: 0, fast: 1, frontier: 2 };

export const tierRank = (tier: ModelTier | null | undefined): number => (tier ? TIER_RANK[tier] : -1);

export const TIER_META: Record<ModelTier, { label: string; hint: string }> = {
  light: { label: "LIGHT", hint: "Cheap and quick: scribes and small jobs" },
  fast: { label: "FAST", hint: "Everyday builder tier" },
  frontier: { label: "FRONTIER", hint: "Heavy reasoning: reworks and hard builds" },
};

/** CSS class for a tier badge. */
export const tierClass = (tier: ModelTier): string => `tier tier--${tier}`;

const byId = new Map<string, CatalogModel>(MODEL_CATALOG.map((m) => [m.id, m]));

export const catalogModel = (id: string | null | undefined): CatalogModel | null => (id ? (byId.get(id) ?? null) : null);

/** Tier of a model id, or null when it is not in the catalog. */
export const tierOf = (id: string | null | undefined): ModelTier | null => catalogModel(id)?.tier ?? null;

/** Catalog label, falling back to the raw id. */
export const modelLabel = (id: string): string => catalogModel(id)?.label ?? id;

/** True when `next` is a strictly higher tier than `prev` (both must be catalog models). */
export function isEscalation(prev: string | null | undefined, next: string | null | undefined): boolean {
  const a = tierOf(prev);
  const b = tierOf(next);
  return a !== null && b !== null && tierRank(b) > tierRank(a);
}

export interface ModelRow {
  model: CatalogModel;
  attempts: number;
  passes: number;
  failures: number;
  /** passes / attempts, or null when untried. */
  passRate: number | null;
  /** Attempt-weighted average build time across roles. */
  avgBuildMs: number | null;
  untried: boolean;
  /** Best pass rate in its tier (needs at least one attempt). */
  leader: boolean;
}

export interface TierGroup {
  tier: ModelTier;
  rows: ModelRow[];
}

/** Collapse per-(model, role) stats into one row per catalog model, grouped by tier. */
export function buildModelBoard(stats: readonly ModelStats[]): TierGroup[] {
  const rows: ModelRow[] = MODEL_CATALOG.map((model) => {
    const mine = stats.filter((s) => s.model === model.id);
    const attempts = mine.reduce((n, s) => n + s.attempts, 0);
    const passes = mine.reduce((n, s) => n + s.passes, 0);
    const failures = mine.reduce((n, s) => n + s.failures, 0);
    const timed = mine.filter((s) => s.avgBuildMs != null && s.attempts > 0);
    const weight = timed.reduce((n, s) => n + s.attempts, 0);
    const avgBuildMs = weight > 0 ? timed.reduce((n, s) => n + (s.avgBuildMs as number) * s.attempts, 0) / weight : null;
    return {
      model,
      attempts,
      passes,
      failures,
      passRate: attempts > 0 ? passes / attempts : null,
      avgBuildMs,
      untried: attempts === 0,
      leader: false,
    };
  });
  return TIERS.map((tier) => {
    const inTier = rows.filter((r) => r.model.tier === tier);
    const leader = pickLeader(inTier);
    return { tier, rows: inTier.map((r) => (r === leader ? { ...r, leader: true } : r)) };
  });
}

/** Highest pass rate, then more attempts, then cheaper, then catalog order. Untried models never lead. */
export function pickLeader(rows: readonly ModelRow[]): ModelRow | null {
  let best: ModelRow | null = null;
  for (const r of rows) {
    if (r.untried || r.passRate === null) continue;
    if (!best) {
      best = r;
      continue;
    }
    const better =
      r.passRate > (best.passRate as number) ||
      (r.passRate === best.passRate && (r.attempts > best.attempts || (r.attempts === best.attempts && r.model.cost < best.model.cost)));
    if (better) best = r;
  }
  return best;
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return "–";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Metric rollups (v2 design §2.8, layer 1): events → `metrics_hourly` deltas,
 * applied in the apply transaction, plus the SLO window counts that the
 * error-budget function (WP1.3) consumes.
 *
 * Planners put these keys in an event's `data` (all optional; a missing label
 * becomes "unknown"):
 *   item.filed            kind, source
 *   item.status           to (WorkStatus), kind
 *   gate.verdict          outcome, attempt
 *   race.started          width
 *   race.decided          winnerModel
 *   command.result        action (BUILD|REWORK), model, role, outcome, ms, credits
 *   queue.landed          size (or members[]), waitMs
 *   queue.bisect          size (or members[])
 *   queue.conflict        kind
 *   release.phase         to (terminal phase)
 *   escalation.opened     reason
 */
import type { HourlyMetric, QueenEvent } from "@queenos/queen-types";
import { rowToMetric, upsertMetric } from "../db";
import type { MetricDelta } from "../records";

const HOUR_MS = 3_600_000;
const TERMINAL_RELEASE = ["SHIPPED", "FAILED", "ROLLED_BACK", "SUPERSEDED"];
/** Releases that count against the change-success SLO. */
const SLO_PHASES = ["SHIPPED", "ROLLED_BACK", "FAILED"] as const;

/** Epoch ms of the start of the hour containing `ts`. */
export const hourBucket = (ts: number): number => Math.floor(ts / HOUR_MS) * HOUR_MS;

type EventLike = Pick<QueenEvent, "type" | "ts" | "data">;

const label = (v: unknown): string => (typeof v === "string" && v ? v.slice(0, 64) : typeof v === "number" ? String(v) : "unknown");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function delta(ts: number, name: string, labels: Record<string, string>, value = 1): MetricDelta {
  return { bucket: hourBucket(ts), name, labels, count: 1, sum: value, min: value, max: value };
}

function carSize(d: Record<string, unknown>): string {
  const size = num(d.size) ?? (Array.isArray(d.members) ? d.members.length : null);
  return size === null ? "unknown" : String(size);
}

/** The deltas one event contributes (pure). */
export function metricsForEvent(e: EventLike): MetricDelta[] {
  const d = e.data ?? {};
  const out: MetricDelta[] = [];
  switch (e.type) {
    case "item.filed":
      out.push(delta(e.ts, "items_filed", { kind: label(d.kind), source: label(d.source) }));
      break;
    case "item.status":
      if (d.to === "LANDED") out.push(delta(e.ts, "items_landed", { kind: label(d.kind) }));
      else if (d.to === "SHIPPED") out.push(delta(e.ts, "items_shipped", { kind: label(d.kind) }));
      break;
    case "gate.verdict":
      out.push(delta(e.ts, "gate_verdicts", { outcome: label(d.outcome), attempt: label(d.attempt) }));
      break;
    case "race.started":
      out.push(delta(e.ts, "races", { width: label(d.width) }));
      break;
    case "race.decided":
      out.push(delta(e.ts, "race_wins", { model: label(d.winnerModel) }));
      break;
    case "command.result":
      if (d.action === "BUILD" || d.action === "REWORK") {
        out.push(delta(e.ts, "builds", { model: label(d.model), role: label(d.role), outcome: label(d.outcome) }));
        const ms = num(d.ms);
        if (ms !== null) out.push(delta(e.ts, "build_ms", { model: label(d.model) }, ms));
        const credits = num(d.credits);
        if (credits !== null) out.push(delta(e.ts, "credits", { role: label(d.role) }, credits));
      }
      break;
    case "queue.landed": {
      out.push(delta(e.ts, "queue_cars", { outcome: "landed", size: carSize(d) }));
      const wait = num(d.waitMs);
      if (wait !== null) out.push(delta(e.ts, "queue_wait_ms", {}, wait));
      break;
    }
    case "queue.bisect":
      out.push(delta(e.ts, "queue_bisects", {}));
      out.push(delta(e.ts, "queue_cars", { outcome: "failed", size: carSize(d) }));
      break;
    case "queue.conflict":
      out.push(delta(e.ts, "queue_conflicts", { kind: label(d.kind) }));
      break;
    case "affinity.wait":
      out.push(delta(e.ts, "affinity_waits", {}));
      break;
    case "release.phase":
      if (typeof d.to === "string" && TERMINAL_RELEASE.includes(d.to)) out.push(delta(e.ts, "releases", { outcome: d.to }));
      break;
    case "escalation.opened":
      out.push(delta(e.ts, "escalations", { reason: label(d.reason) }));
      break;
    default:
      break;
  }
  return out;
}

/** The `active_builds` gauge: every apply samples the current count (read `max` for the peak). */
export function activeBuildsDelta(ts: number, active: number): MetricDelta {
  return delta(ts, "active_builds", {}, active);
}

/**
 * Roll events up into `metrics_hourly` (upsert SQL in db.ts `upsertMetric`),
 * sampling the `active_builds` gauge when given. Returns the deltas applied.
 */
export function recordMetrics(sql: SqlStorage, events: readonly EventLike[], opts: { now: number; activeBuilds?: number }): MetricDelta[] {
  const deltas = events.flatMap(metricsForEvent);
  if (opts.activeBuilds !== undefined) deltas.push(activeBuildsDelta(opts.now, opts.activeBuilds));
  for (const m of deltas) upsertMetric(sql, m);
  return deltas;
}

/** Rows for `[from, to)` hourly buckets, optionally one metric name. */
export function queryMetrics(sql: SqlStorage, from: number, to: number, name?: string): HourlyMetric[] {
  const rows = name
    ? sql.exec("SELECT * FROM metrics_hourly WHERE bucket >= ? AND bucket < ? AND name = ? ORDER BY bucket, name, labels", from, to, name)
    : sql.exec("SELECT * FROM metrics_hourly WHERE bucket >= ? AND bucket < ? ORDER BY bucket, name, labels", from, to);
  return rows.toArray().map(rowToMetric);
}

export interface SloWindowCounts {
  /** The requested window size (terminal releases). */
  window: number;
  /** Terminal releases actually in the window (≤ window). */
  attempted: number;
  /** ROLLED_BACK + FAILED among them. */
  failed: number;
}

/**
 * Change-success SLO inputs: the last `window` terminal releases
 * (SHIPPED / ROLLED_BACK / FAILED; SUPERSEDED is neither). WP1.3's error
 * budget is `floor((1 - target) * window) - failed`.
 */
export function sloWindowCounts(sql: SqlStorage, window: number): SloWindowCounts {
  const phases = SLO_PHASES.map((p) => `'${p}'`).join(", ");
  const rows = sql
    .exec(`SELECT phase FROM releases WHERE phase IN (${phases}) ORDER BY updated_at DESC, seq DESC LIMIT ?`, window)
    .toArray();
  return { window, attempted: rows.length, failed: rows.filter((r) => r.phase !== "SHIPPED").length };
}

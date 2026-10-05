/**
 * Analytics Engine sink (v2 design §2.8, layer 2). Wraps `writeDataPoint`:
 * a no-op without a binding (sim, tests), at most 200 points per invocation
 * (the platform allows 250), drops counted, never throws.
 */
import { AE_MAX_POINTS_PER_INVOCATION, type AnalyticsPoint, type QueenEvent } from "@queenos/queen-types";

/** The AE binding surface (mirrors hive-kit's `DataPointWriter`; the Queen does not depend on hive-kit). */
export interface DataPoint {
  indexes: string[];
  blobs: string[];
  doubles: number[];
}
export interface DataPointWriter {
  writeDataPoint(point: DataPoint): void;
}

const MAX_INDEX_BYTES = 96;
const MAX_BLOB_CHARS = 512;

function clipBytes(s: string, max: number): string {
  const enc = new TextEncoder();
  let out = s;
  while (out.length > 0 && enc.encode(out).length > max) out = out.slice(0, -1);
  return out;
}

/** Same layout as hive-kit's `metricPoint` (keep the two in step). */
export function metricPoint(p: AnalyticsPoint): DataPoint {
  const num = (n: number | undefined, dflt = 0) => (typeof n === "number" && Number.isFinite(n) ? n : dflt);
  return {
    indexes: [clipBytes(p.hive, MAX_INDEX_BYTES)],
    blobs: [p.type, p.hive, p.kindOrRole ?? "", p.model ?? "", p.outcome ?? "", p.environment ?? "", p.traceId ?? "", p.itemId ?? ""].map((b) =>
      b.slice(0, MAX_BLOB_CHARS),
    ),
    doubles: [num(p.valueMs), num(p.tokensIn), num(p.tokensOut), num(p.credits), num(p.count, 1)],
  };
}

export class AnalyticsSink {
  written = 0;
  dropped = 0;

  constructor(
    private readonly dataset: DataPointWriter | undefined,
    private readonly maxPerInvocation = AE_MAX_POINTS_PER_INVOCATION,
  ) {}

  /** Start a new invocation's budget (call at the top of each fetch/alarm/RPC). */
  beginInvocation(): void {
    this.written = 0;
  }

  /** True when the point was handed to AE. Over the cap counts a drop; a missing binding does not. */
  write(p: AnalyticsPoint): boolean {
    if (!this.dataset) return false;
    if (this.written >= this.maxPerInvocation) {
      this.dropped++;
      return false;
    }
    try {
      this.dataset.writeDataPoint(metricPoint(p));
      this.written++;
      return true;
    } catch {
      this.dropped++;
      return false;
    }
  }

  /** Points for the notable events of an apply, after commit (never awaited). */
  writeEvents(events: readonly QueenEvent[], environment?: string): number {
    let n = 0;
    for (const e of events) {
      const p = eventToPoint(e, environment);
      if (p && this.write(p)) n++;
    }
    return n;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const nm = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** One AE point per notable (non-debug) event; null for debug rows. */
export function eventToPoint(e: QueenEvent, environment?: string): AnalyticsPoint | null {
  if (e.severity === "debug") return null;
  const d = e.data ?? {};
  return {
    type: e.type,
    hive: e.hive,
    kindOrRole: str(d.kind) ?? str(d.role) ?? e.droneRole,
    model: str(d.model) ?? str(d.winnerModel),
    outcome: str(d.outcome) ?? str(d.to) ?? e.auditStatus,
    environment,
    traceId: e.traceId ?? undefined,
    itemId: e.itemId ?? undefined,
    valueMs: nm(d.ms) ?? nm(d.waitMs),
    tokensIn: nm(d.tokensIn),
    tokensOut: nm(d.tokensOut),
    credits: nm(d.credits),
  };
}

/**
 * Analytics Engine points for executors (v2 design §2.8). Fire-and-forget:
 * `writeDataPoint` is non-blocking and never awaited; a missing binding is a
 * no-op (sim and tests).
 */
import type { AnalyticsPoint } from "@queenos/queen-types";

/** The Analytics Engine data point layout (`writeDataPoint` argument). */
export interface DataPoint {
  indexes: string[];
  blobs: string[];
  doubles: number[];
}

/** The binding's surface we use (AnalyticsEngineDataset). */
export interface DataPointWriter {
  writeDataPoint(point: DataPoint): void;
}

/**
 * The AE layout of `queenos_events`: indexes [hive]; blobs [type, hive,
 * kindOrRole, model, outcome, environment, traceId, itemId]; doubles
 * [valueMs, tokensIn, tokensOut, credits, count].
 */
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

/** AE limits an index to 96 bytes. */
const MAX_INDEX_BYTES = 96;
/** Keeps 8 blobs far under the 16 KB total. */
const MAX_BLOB_CHARS = 512;

function clipBytes(s: string, max: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= max) return s;
  let out = s;
  while (out.length > 0 && enc.encode(out).length > max) out = out.slice(0, -1);
  return out;
}

/** Write one point if the binding exists; never throws. */
export function writeMetric(dataset: DataPointWriter | undefined, p: AnalyticsPoint): void {
  if (!dataset) return;
  try {
    dataset.writeDataPoint(metricPoint(p));
  } catch {
    /* telemetry must never break an executor */
  }
}

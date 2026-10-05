/**
 * Analytics Engine points for executors (v2 design §2.8). Fire-and-forget:
 * `writeDataPoint` is non-blocking and never awaited; a missing binding is a
 * no-op (sim and tests).
 *
 * WP0 seam; WP1.4 implements it.
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
  void p;
  throw new Error("not implemented");
}

/** Write one point if the binding exists; never throws. */
export function writeMetric(dataset: DataPointWriter | undefined, p: AnalyticsPoint): void {
  void dataset;
  void p;
  throw new Error("not implemented");
}

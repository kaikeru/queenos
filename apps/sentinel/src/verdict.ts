/** Pure verdict logic: no I/O. */
import type { SentinelCommand, SentinelVerdict } from "@queenos/queen-types";

export const MAX_ERROR_RATE = 0.01;
export const BASELINE_ERROR_MARGIN = 0.01;
export const P99_FLOOR_MS = 2000;
export const P99_BASELINE_FACTOR = 3;

/** Compact result of probing one target (the only thing a step returns). */
export interface Tally {
  total: number;
  errors: number;
  smokeFailures: number;
  /** Latency (ms) of each answered or failed request. */
  latencies: number[];
}

export const emptyTally = (): Tally => ({ total: 0, errors: 0, smokeFailures: 0, latencies: [] });

export function mergeTallies(parts: Tally[]): Tally {
  const out = emptyTally();
  for (const p of parts) {
    out.total += p.total;
    out.errors += p.errors;
    out.smokeFailures += p.smokeFailures;
    out.latencies.push(...p.latencies);
  }
  return out;
}

/** Nearest-rank percentile; null when there are no samples. */
export function percentile(samples: number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

const pct = (r: number) => `${Math.round(r * 1000) / 10}%`;
const ms = (v: number | null) => (v === null ? "n/a" : `${Math.round(v)}ms`);

export type VerdictInput = Pick<SentinelCommand, "commandId" | "releaseId" | "environment" | "canaryPercent"> & Partial<Pick<SentinelCommand, "minRequests">>;

/** Fewer than half of `minRequests` answered: the sample is too small to promote on. */
export const isTooFewRequests = (total: number, minRequests: number | undefined): boolean => minRequests !== undefined && total < Math.ceil(minRequests / 2);

/** Whole seconds, for summaries. */
const secs = (v: number) => `${Math.round(v / 1000)}s`;

/** The target never passed the readiness gate: nothing was measured. */
export function gateTimeoutVerdict(cmd: VerdictInput, timeoutSeconds: number, lastStatus: number | null): SentinelVerdict {
  const label = cmd.environment === "canary" ? `Canary ${cmd.canaryPercent ?? "?"}%` : "Staging";
  const last = lastStatus === null ? "network error" : String(lastStatus);
  return {
    commandId: cmd.commandId,
    releaseId: cmd.releaseId,
    environment: cmd.environment,
    verdict: "ROLLBACK",
    metrics: { requests: 0, errorRate: 1, p99Ms: null, baselineErrorRate: null },
    summary: `${label}: never became reachable within ${timeoutSeconds}s (last status ${last}) → rollback`,
    // Nothing was measured: the Queen parks staging for a human (SENTINEL_INCONCLUSIVE) instead of treating it as a bad build.
    inconclusive: true,
  };
}

export function decide(cmd: VerdictInput, candidate: Tally, baseline: Tally | null, readyMs: number | null = null): SentinelVerdict {
  const errorRate = candidate.total === 0 ? 0 : candidate.errors / candidate.total;
  const p99 = percentile(candidate.latencies, 99);
  const hasBaseline = baseline !== null && baseline.total > 0;
  const baseRate = hasBaseline ? baseline.errors / baseline.total : null;
  const baseP99 = hasBaseline ? percentile(baseline.latencies, 99) : null;

  const reasons: string[] = [];
  if (candidate.smokeFailures > 0) reasons.push("smoke check failed");
  if (errorRate > MAX_ERROR_RATE) reasons.push(`error rate ${pct(errorRate)} > ${pct(MAX_ERROR_RATE)}`);
  if (baseRate !== null && errorRate > baseRate + BASELINE_ERROR_MARGIN) reasons.push(`error rate ${pct(errorRate)} regressed vs baseline ${pct(baseRate)}`);
  const p99Limit = Math.max(P99_FLOOR_MS, P99_BASELINE_FACTOR * (baseP99 ?? 0));
  if (p99 !== null && p99 > p99Limit) reasons.push(`p99 ${ms(p99)} > ${ms(p99Limit)}`);

  // Healthy but under-sampled: still ROLLBACK (old Queens stay safe), flagged inconclusive. Real failures are not.
  const inconclusive = reasons.length === 0 && isTooFewRequests(candidate.total, cmd.minRequests);
  if (inconclusive) reasons.push(`inconclusive: only ${candidate.total} of ${cmd.minRequests} requests answered`);
  const verdict = reasons.length > 0 ? "ROLLBACK" : "PROMOTE";
  const label = cmd.environment === "canary" ? `Canary ${cmd.canaryPercent ?? "?"}%` : "Staging";
  const base = hasBaseline ? ` vs baseline ${baseline.errors}/${baseline.total}` : "";
  const lat = hasBaseline ? `p99 ${ms(p99)} vs ${ms(baseP99)}` : `p99 ${ms(p99)}`;
  const ready = readyMs === null ? "" : `; ready after ${secs(readyMs)}`;
  const why = reasons.length > 0 ? ` (${reasons.join("; ")})` : "";
  let summary = `${label}: ${candidate.errors}/${candidate.total} errors${base}; ${lat}${ready}${why} → ${verdict === "PROMOTE" ? "promote" : "rollback"}`;
  if (summary.length > 500) summary = `${summary.slice(0, 499)}…`;

  return {
    commandId: cmd.commandId,
    releaseId: cmd.releaseId,
    environment: cmd.environment,
    verdict,
    metrics: { requests: candidate.total, errorRate, p99Ms: p99, baselineErrorRate: baseRate },
    summary,
    ...(inconclusive ? { inconclusive: true } : {}),
  };
}

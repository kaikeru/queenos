/**
 * The Sentinel control flow, written against a minimal StepRunner and the
 * SentinelPorts seam (same split as apps/herald). SentinelWorkflow.run() is a
 * thin adapter. Synthetic probing only: public workers.dev URLs, no credentials.
 *
 * Probe budget: at most MAX_BATCHES batches; each batch (one step) issues at
 * most CANDIDATE_PER_BATCH + BASELINE_PER_BATCH = 45 subrequests. Steps return
 * only counts and a latency sample, never bodies.
 */
import type { WorkflowStepConfig } from "cloudflare:workers";
import { SentinelCommandSchema, spanIdFor, type AnalyticsPoint, type SentinelCommand, type SentinelVerdict } from "@queenos/queen-types";
import type { SentinelPorts } from "./ports";
import { decide, emptyTally, gateTimeoutVerdict, mergeTallies, type Tally } from "./verdict";

export interface StepRunner {
  do<T>(name: string, config: WorkflowStepConfig, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

export const PROBE_STEP: WorkflowStepConfig = { retries: { limit: 2, delay: "2 seconds", backoff: "exponential" }, timeout: "2 minutes" };
export const REPORT_STEP: WorkflowStepConfig = { retries: { limit: 5, delay: "2 seconds", backoff: "exponential" }, timeout: "30 seconds" };

export const CANDIDATE_PER_BATCH = 30;
export const BASELINE_PER_BATCH = 15;
export const MAX_BATCHES = 30;
/** Readiness gate: consecutive 2xx on GET / required before measuring, poll spacing, default cap. */
export const READY_CONSECUTIVE = 3;
export const READY_POLL_MS = 2_000;
export const READY_TIMEOUT_DEFAULT_SECONDS = 90;
/** One probe per step; the probe never throws, so a single retry is plenty. */
export const GATE_STEP: WorkflowStepConfig = { retries: { limit: 1, delay: "1 second" }, timeout: "30 seconds" };
/** Override propagation lag after the gate, before the first canary batch (docs/deploy-discovery.md §3). */
export const CANARY_SETTLE_MS = 5_000;
export const OVERRIDES_HEADER = "Cloudflare-Workers-Version-Overrides";

const messageOf = (e: unknown) => String((e as Error)?.message ?? e);
const isPermanentQueenError = (e: unknown) => /^(INVALID_INPUT|NOT_FOUND|CONFLICT): /.test(messageOf(e));

export class SentinelFailedError extends Error {
  override readonly name = "SentinelFailedError";
}

export type SentinelRunResult = { commandId: string; verdict: SentinelVerdict["verdict"]; summary: string; queenOutcome: string; inconclusive?: boolean };

/** Trace id out of a W3C traceparent (`00-<32 hex>-<16 hex>-<flags>`). */
export function traceIdOf(cmd: Pick<SentinelCommand, "trace">): string | null {
  return /^00-([0-9a-f]{32})-/.exec(cmd.trace?.traceparent ?? "")?.[1] ?? null;
}

/** The AE point for one window: type `sentinel.window`; value = p99 ms, count = requests. */
export function windowPoint(cmd: SentinelCommand, v: SentinelVerdict): AnalyticsPoint {
  return {
    type: "sentinel.window",
    hive: cmd.hive,
    kindOrRole: "sentinel",
    outcome: v.inconclusive ? "INCONCLUSIVE" : v.verdict,
    environment: cmd.environment,
    ...(traceIdOf(cmd) ? { traceId: traceIdOf(cmd)! } : {}),
    ...(v.metrics.p99Ms !== null ? { valueMs: v.metrics.p99Ms } : {}),
    count: v.metrics.requests,
  };
}

function slog(ports: SentinelPorts, cmd: SentinelCommand, step: string, outcome: string, extra: Record<string, unknown> = {}): void {
  try {
    ports.log?.({
      trace_id: traceIdOf(cmd),
      span_id: spanIdFor(`${cmd.commandId}/${step}`),
      parent_span_id: spanIdFor(cmd.commandId),
      hive: cmd.hive,
      command_id: cmd.commandId,
      step: `sentinel: ${step}`,
      outcome,
      environment: cmd.environment,
      ...extra,
    });
  } catch {
    /* logging never fails a verdict */
  }
}

export interface BatchPlan {
  /** Candidate requests per batch (sums to ~minRequests). */
  perBatch: number[];
  /** Sleep between batches. */
  gapMs: number;
}

export function planBatches(minRequests: number, windowSeconds: number): BatchPlan {
  const batches = Math.min(MAX_BATCHES, Math.max(1, Math.ceil(minRequests / CANDIDATE_PER_BATCH)));
  const total = Math.min(minRequests, batches * CANDIDATE_PER_BATCH);
  const base = Math.floor(total / batches);
  const extra = total - base * batches;
  const perBatch = Array.from({ length: batches }, (_, i) => base + (i < extra ? 1 : 0));
  return { perBatch, gapMs: batches > 1 ? Math.floor((windowSeconds * 1000) / batches) : 0 };
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

/** Probe `n` requests round-robin over `paths`, offset so batches keep rotating. */
export async function probeBatch(ports: SentinelPorts, baseUrl: string, paths: string[], n: number, offset: number, headers: Record<string, string>, smoke: boolean): Promise<Tally> {
  const targets: string[] = [];
  if (smoke) targets.push("/");
  while (targets.length < n) targets.push(paths[(offset + targets.length) % paths.length]!);
  const results = await Promise.all(targets.map((p) => ports.probe(joinUrl(baseUrl, p), headers)));
  const tally = emptyTally();
  results.forEach((r, i) => {
    tally.total++;
    if (r.status === null || r.status >= 500) tally.errors++;
    if (smoke && i === 0 && (r.status === null || r.status < 200 || r.status >= 300)) tally.smokeFailures++;
    tally.latencies.push(Math.round(r.ms));
  });
  return tally;
}

export type GateResult = { ready: true; readyMs: number } | { ready: false; lastStatus: number | null };

/**
 * Readiness gate: poll `GET /` (pinned to the candidate when headers are given)
 * until READY_CONSECUTIVE 2xx in a row, READY_POLL_MS apart. Elapsed time is
 * derived from step results (probe latency + sleeps), never a clock, so it is
 * replay-safe. Each poll is its own step and the gap a step.sleep, so the cap
 * (up to 600s => ~300 polls) stays well inside Workflows' step limit. Warm-up
 * responses are discarded: nothing here reaches the metrics.
 */
export async function readinessGate(ports: SentinelPorts, step: StepRunner, baseUrl: string, headers: Record<string, string>, timeoutSeconds: number): Promise<GateResult> {
  const capMs = timeoutSeconds * 1000;
  let elapsed = 0;
  let streak = 0;
  let last: number | null = null;
  for (let attempt = 1; ; attempt++) {
    const r = await step.do(`ready poll ${attempt}`, GATE_STEP, () => ports.probe(joinUrl(baseUrl, "/"), headers));
    elapsed += r.ms;
    last = r.status;
    streak = r.status !== null && r.status >= 200 && r.status < 300 ? streak + 1 : 0;
    if (streak >= READY_CONSECUTIVE) return { ready: true, readyMs: elapsed };
    if (elapsed + READY_POLL_MS > capMs) return { ready: false, lastStatus: last };
    await step.sleep(`ready wait ${attempt}`, READY_POLL_MS);
    elapsed += READY_POLL_MS;
  }
}

export async function runSentinel(payload: unknown, step: StepRunner, ports: SentinelPorts): Promise<SentinelRunResult> {
  const parsed = SentinelCommandSchema.safeParse(payload);
  if (!parsed.success) {
    throw new SentinelFailedError(`invalid SentinelCommand: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  const cmd: SentinelCommand = parsed.data;
  const canary = cmd.environment === "canary";
  if (canary && !cmd.candidateVersionId) {
    throw new SentinelFailedError("invalid SentinelCommand: candidateVersionId is required for canary");
  }
  const withBaseline = canary && !!cmd.stableVersionId;
  const pin = (id: string) => ({ [OVERRIDES_HEADER]: `${cmd.scriptName}="${id}"` });
  const candHeaders: Record<string, string> = canary ? pin(cmd.candidateVersionId!) : {};
  const baseHeaders: Record<string, string> = withBaseline ? pin(cmd.stableVersionId!) : {};

  const plan = planBatches(cmd.minRequests, cmd.windowSeconds);
  const timeoutSeconds = cmd.readyTimeoutSeconds ?? READY_TIMEOUT_DEFAULT_SECONDS;

  const gate = await readinessGate(ports, step, cmd.url, candHeaders, timeoutSeconds);
  slog(ports, cmd, "readiness", gate.ready ? "ready" : "timeout", gate.ready ? { ms: gate.readyMs } : { last_status: gate.lastStatus });
  let verdict: SentinelVerdict;
  if (!gate.ready) {
    verdict = gateTimeoutVerdict(cmd, timeoutSeconds, gate.lastStatus);
  } else {
    if (canary) await step.sleep("settle: version override propagation", CANARY_SETTLE_MS);

    const candidate: Tally[] = [];
    const baseline: Tally[] = [];
    let offset = 0;
    for (let i = 0; i < plan.perBatch.length; i++) {
      const n = plan.perBatch[i]!;
      const first = i === 0;
      const off = offset;
      const result = await step.do(`probe batch ${i + 1}/${plan.perBatch.length}`, PROBE_STEP, async () => {
        const [c, b] = await Promise.all([
          probeBatch(ports, cmd.url, cmd.paths, n, off, candHeaders, first),
          withBaseline ? probeBatch(ports, cmd.url, cmd.paths, Math.min(BASELINE_PER_BATCH, Math.max(1, Math.ceil(n / 2))), off, baseHeaders, false) : Promise.resolve(null),
        ]);
        return { c, b };
      });
      candidate.push(result.c);
      if (result.b) baseline.push(result.b);
      offset += n;
      if (i < plan.perBatch.length - 1) await step.sleep(`wait before batch ${i + 2}`, plan.gapMs);
    }
    verdict = decide(cmd, mergeTallies(candidate), withBaseline ? mergeTallies(baseline) : null, gate.readyMs);
  }
  slog(ports, cmd, "verdict", verdict.inconclusive ? "inconclusive" : verdict.verdict, { requests: verdict.metrics.requests, error_rate: verdict.metrics.errorRate, p99_ms: verdict.metrics.p99Ms });
  // One AE point per window (never awaited, never fails the verdict).
  try {
    ports.metric?.(windowPoint(cmd, verdict));
  } catch {
    /* telemetry is best effort */
  }

  const queenOutcome = await step.do("report: sentinel verdict", REPORT_STEP, async () => {
    try {
      const r = (await ports.queen(cmd.hive).reportSentinelVerdict(verdict)) as { outcome?: unknown } | null | undefined;
      return String(r?.outcome ?? "reported");
    } catch (e) {
      if (!isPermanentQueenError(e)) throw e;
      return `rejected: ${messageOf(e).slice(0, 200)}`;
    }
  });

  return { commandId: cmd.commandId, verdict: verdict.verdict, summary: verdict.summary, queenOutcome, ...(verdict.inconclusive ? { inconclusive: true } : {}) };
}

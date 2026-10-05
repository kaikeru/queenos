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
import { SentinelCommandSchema, type SentinelCommand, type SentinelVerdict } from "@queenos/queen-types";
import type { SentinelPorts } from "./ports";
import { decide, emptyTally, mergeTallies, type Tally } from "./verdict";

export interface StepRunner {
  do<T>(name: string, config: WorkflowStepConfig, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

export const PROBE_STEP: WorkflowStepConfig = { retries: { limit: 2, delay: "2 seconds", backoff: "exponential" }, timeout: "2 minutes" };
export const REPORT_STEP: WorkflowStepConfig = { retries: { limit: 5, delay: "2 seconds", backoff: "exponential" }, timeout: "30 seconds" };

export const CANDIDATE_PER_BATCH = 30;
export const BASELINE_PER_BATCH = 15;
export const MAX_BATCHES = 30;
/** Override propagation lag before the first canary batch (docs/deploy-discovery.md §3). */
export const CANARY_SETTLE_MS = 5_000;
export const OVERRIDES_HEADER = "Cloudflare-Workers-Version-Overrides";

const messageOf = (e: unknown) => String((e as Error)?.message ?? e);
const isPermanentQueenError = (e: unknown) => /^(INVALID_INPUT|NOT_FOUND|CONFLICT): /.test(messageOf(e));

export class SentinelFailedError extends Error {
  override readonly name = "SentinelFailedError";
}

export type SentinelRunResult = { commandId: string; verdict: SentinelVerdict["verdict"]; summary: string; queenOutcome: string };

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

  const verdict = decide(cmd, mergeTallies(candidate), withBaseline ? mergeTallies(baseline) : null);

  const queenOutcome = await step.do("report: sentinel verdict", REPORT_STEP, async () => {
    try {
      const r = (await ports.queen(cmd.hive).reportSentinelVerdict(verdict)) as { outcome?: unknown } | null | undefined;
      return String(r?.outcome ?? "reported");
    } catch (e) {
      if (!isPermanentQueenError(e)) throw e;
      return `rejected: ${messageOf(e).slice(0, 200)}`;
    }
  });

  return { commandId: cmd.commandId, verdict: verdict.verdict, summary: verdict.summary, queenOutcome };
}

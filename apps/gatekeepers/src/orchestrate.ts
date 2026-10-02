/**
 * The gate control flow ("The Bouncer and The Scribe"), written against a
 * minimal StepRunner and the GatekeeperPorts seam so it is testable without
 * Workflows, Artifacts or the Queen. GatekeeperWorkflow.run() is a thin adapter.
 *
 * Two entry points, one Workflow class:
 * - handlePush: the instance Artifacts starts per push event. Pure filtering,
 *   then dispatches ONE deterministic instance per (repo, after) = idempotency.
 * - runGate: that deterministic instance. Waits for the Queen to reach TESTING,
 *   clone+scan+test in one step, audits, Scribe, Vectorize, verdict.
 *
 * Replay rules: all clock reads and I/O are inside steps; steps return small
 * serializable values.
 */
import type { WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { AppendAuditInput, AuditStatus, DroneRole, GitNotesPayload } from "@queenos/queen-types";
import { AiGatewayError, LedgerError, buildGitNotesPayload } from "@queenos/hive-kit";
import type { GateConfig } from "./config";
import { classifyPush, gateInstanceId, parsePushEvent, type GateTask } from "./event";
import { formatFinding, type ScanReport } from "./findings";
import { inspectPush, type Inspection } from "./inspect";
import type { FailureChunk, GatekeeperPorts, QueenPort } from "./ports";
import { MAX_SUMMARY_CHARS, clip, extractiveSummary, summarizeFailure, type ScribeResult } from "./scribe";
import { NotImplementedError } from "./test-runner";

export interface StepRunner {
  do<T>(name: string, config: WorkflowStepConfig, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

export const LOOKUP_STEP: WorkflowStepConfig = { retries: { limit: 4, delay: "2 seconds", backoff: "exponential" }, timeout: "30 seconds" };
export const INSPECT_STEP: WorkflowStepConfig = { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" };
export const SCRIBE_STEP: WorkflowStepConfig = { retries: { limit: 2, delay: "3 seconds", backoff: "exponential" }, timeout: "2 minutes" };
export const REPORT_STEP: WorkflowStepConfig = { retries: { limit: 5, delay: "2 seconds", backoff: "exponential" }, timeout: "30 seconds" };
export const BEST_EFFORT_STEP: WorkflowStepConfig = { retries: { limit: 1, delay: "2 seconds" }, timeout: "1 minute" };
export const DISPATCH_STEP: WorkflowStepConfig = { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" }, timeout: "30 seconds" };

export const POLICY_MODEL = "queenos/policy-scan-v1";
export const SECURITY_MODEL = "queenos/security-scan-v1";
export const SCRIBE_EXTRACTIVE_MODEL = "queenos/scribe-extractive-v1";

const messageOf = (e: unknown) => String((e as Error)?.message ?? e);

export function isPermanentQueenError(e: unknown): boolean {
  return /^(INVALID_INPUT|NOT_FOUND|CONFLICT): /.test(messageOf(e));
}

/** Errors that will not get better on retry become NonRetryableError inside steps. */
export function toStepError(e: unknown): unknown {
  if (e instanceof NonRetryableError) return e;
  const permanent = e instanceof NotImplementedError || (e instanceof AiGatewayError && !e.retryable) || e instanceof LedgerError || /^(INVALID_INPUT|NOT_FOUND|CONFLICT|UNAVAILABLE): /.test(messageOf(e));
  return permanent ? new NonRetryableError(clip(messageOf(e), 1_000)) : e;
}

// ── trigger instance ────────────────────────────────────────────────────────

export type PushRunResult =
  | { status: "ignored"; reason: string }
  | { status: "dispatched" | "duplicate"; gateId: string; repo: string; after: string };

export async function handlePush(payload: unknown, step: StepRunner, ports: GatekeeperPorts, config: GateConfig): Promise<PushRunResult> {
  const parsed = parsePushEvent(payload);
  if (!parsed.ok) {
    console.warn("gatekeeper: unparseable push event", parsed.error);
    return { status: "ignored", reason: "invalid-event" };
  }
  const c = classifyPush(parsed.event, { artifactsNamespace: config.artifactsNamespace });
  if (c.action === "ignore") return { status: "ignored", reason: c.reason };
  const gateId = gateInstanceId(c.task);
  const started = await step.do("dispatch gate", DISPATCH_STEP, () => ports.dispatcher.start(gateId, c.task).catch((e) => Promise.reject(toStepError(e))));
  return { status: started === "started" ? "dispatched" : "duplicate", gateId, repo: c.task.repo, after: c.task.after };
}

// ── the gate ────────────────────────────────────────────────────────────────

export type Lookup =
  | { status: "ready"; trainId: string; promptId: string; promptText: string }
  | { status: "waiting"; phase: string }
  | { status: "ignored"; reason: string };

/** Which train does this push belong to, and is it ready to be gated? */
export async function lookupTrain(queen: QueenPort, task: Pick<GateTask, "repo" | "after">): Promise<Lookup> {
  // No lookup-by-repo RPC exists yet: scan the snapshot (see report: proposed getTrainByRepo).
  const snap = await queen.getSnapshot();
  const train = snap.trains.find((t) => t.artifactRepo === task.repo);
  if (!train) return { status: "ignored", reason: "unknown-train" };
  const phase = train.phase ?? train.status;
  if (phase === "BUILDING" || phase === "WAITING_PARENT") return { status: "waiting", phase };
  if (phase !== "TESTING") return { status: "ignored", reason: `phase-${phase}` };
  if (train.headSha && train.headSha !== task.after) return { status: "ignored", reason: "not-train-head" };
  const promptId = train.includedPrompts.at(-1) ?? "";
  if (!promptId) return { status: "ignored", reason: "train-without-prompt" };
  const promptText = snap.promptRuns.find((p) => p.promptId === promptId)?.promptText ?? promptId;
  return { status: "ready", trainId: train.trainId, promptId, promptText: promptText.slice(0, 500) };
}

export type GateRunResult =
  | { status: "ignored"; reason: string }
  | {
      status: "gated";
      trainId: string;
      passed: boolean;
      summary: string;
      queenOutcome: string;
      scribe?: ScribeResult["method"];
      vectorized?: number;
    };

interface Ctx {
  task: GateTask;
  step: StepRunner;
  ports: GatekeeperPorts;
  config: GateConfig;
  train: Extract<Lookup, { status: "ready" }>;
}

export async function runGate(task: GateTask, step: StepRunner, ports: GatekeeperPorts, config: GateConfig): Promise<GateRunResult> {
  // 1. Wait for the Queen to process the builder's build-result (push event vs RPC race).
  let train: Extract<Lookup, { status: "ready" }> | null = null;
  for (let i = 1; i <= config.phaseRetries; i++) {
    const look = await step.do(`lookup train #${i}`, LOOKUP_STEP, () => lookupTrain(ports.queen(task.hive), task));
    if (look.status === "ignored") return { status: "ignored", reason: look.reason };
    if (look.status === "ready") {
      train = look;
      break;
    }
    if (i < config.phaseRetries) await step.sleep(`wait for TESTING #${i}`, config.phaseWaitMs);
  }
  if (!train) return { status: "ignored", reason: "phase-timeout" };

  const ctx: Ctx = { task, step, ports, config, train };

  // 2. POLICY + SECURITY run while the dashboard shows yellow.
  await audit(ctx, "audit: policy running", "POLICY", "RUNNING", null);
  await audit(ctx, "audit: security running", "SECURITY", "RUNNING", null);

  let inspection: Inspection;
  try {
    inspection = await step.do("inspect: clone, scan, test", INSPECT_STEP, () =>
      inspectPush(ports, task, config, train.trainId).catch((e) => Promise.reject(toStepError(e))),
    );
  } catch (e) {
    return failInfra(ctx, e);
  }
  if (inspection.status === "stale") return { status: "ignored", reason: "stale-head" };

  const ms = Math.max(0, inspection.endedAtMs - inspection.startedAtMs);
  await audit(ctx, "audit: policy result", "POLICY", inspection.policy.passed ? "PASSED" : "REJECTED", ledgerFor(ctx, POLICY_MODEL, ms, scanSteps("policy", inspection.policy), inspection.policy.passed));
  await audit(ctx, "audit: security result", "SECURITY", inspection.security.passed ? "PASSED" : "REJECTED", ledgerFor(ctx, SECURITY_MODEL, ms, scanSteps("security", inspection.security), inspection.security.passed));

  const passed = inspection.policy.passed && inspection.security.passed && (inspection.tests?.passed ?? false);
  if (passed) {
    const summary = clip(
      `Gate passed: policy (${inspection.policy.filesScanned} files), security, tests (${inspection.tests?.checks ?? 0} checks) at ${task.after.slice(0, 12)}.`,
      MAX_SUMMARY_CHARS,
    );
    const queenOutcome = await report(ctx, true, summary);
    return { status: "gated", trainId: train.trainId, passed: true, summary, queenOutcome };
  }

  // 3. Failure: the Scribe compacts the raw log; the Queen only ever sees the summary.
  const rawLog = inspection.failureLog ?? "gate failed (no log captured)";
  await audit(ctx, "audit: scribe running", "SCRIBE", "RUNNING", null);
  let scribe: ScribeResult;
  try {
    scribe = await step.do("scribe: summarize", SCRIBE_STEP, () =>
      summarizeFailure({
        log: rawLog,
        ...(inspection.failingCheck ? { failingCheck: inspection.failingCheck } : {}),
        llm: ports.llm,
        metadata: { trainId: train.trainId, promptId: train.promptId, role: "SCRIBE" },
      }).catch((e) => Promise.reject(toStepError(e))),
    );
  } catch (e) {
    console.warn("gatekeeper: scribe LLM failed; using extractive summary", messageOf(e));
    scribe = { summary: extractiveSummary(rawLog, inspection.failingCheck ?? undefined), method: "extractive" };
  }
  const summary = clip(scribe.summary, MAX_SUMMARY_CHARS);
  await step.do("scribe: record summary", REPORT_STEP, async () => {
    try {
      await ports.queen(task.hive).recordScribeSummary({ promptId: train.promptId, trainId: train.trainId, summary });
    } catch (e) {
      if (!isPermanentQueenError(e)) throw e;
      console.warn("gatekeeper: Queen rejected the scribe summary", messageOf(e));
    }
    return { recorded: true };
  });
  await audit(ctx, "audit: scribe result", "SCRIBE", "PASSED", ledgerFor(ctx, scribe.model ?? SCRIBE_EXTRACTIVE_MODEL, 0, [`method: ${scribe.method}`, summary], true));

  const vectorized = await vectorize(ctx, rawLog);
  const queenOutcome = await report(ctx, false, summary);
  return { status: "gated", trainId: train.trainId, passed: false, summary, queenOutcome, scribe: scribe.method, vectorized };
}

// ── helpers ───────────────────────────────────────────────────────────────

function scanSteps(label: string, r: ScanReport): string[] {
  if (r.findings.length === 0) return [`${label}: ${r.filesScanned} files scanned, no findings`];
  return [`${label}: ${r.findings.length} finding(s) in ${r.filesScanned} files`, ...r.findings.slice(0, 8).map(formatFinding)];
}

function ledgerFor(ctx: Ctx, model: string, executionTimeMs: number, reasoningSteps: string[], ok: boolean): GitNotesPayload | null {
  try {
    return buildGitNotesPayload({
      taskPrompt: ctx.train.promptText,
      model,
      temperature: 0,
      reasoningSteps,
      result: ok ? "success" : "failure",
      executionTimeMs,
    });
  } catch (e) {
    console.warn("gatekeeper: could not build ledger payload", messageOf(e));
    return null;
  }
}

async function audit(ctx: Ctx, name: string, role: DroneRole, status: AuditStatus, gitNotesPayload: GitNotesPayload | null): Promise<void> {
  const input: AppendAuditInput = { promptId: ctx.train.promptId, droneRole: role, status, gitNotesPayload };
  // Auditing never blocks the gate: permanent Queen errors are logged and skipped.
  await ctx.step.do(name, REPORT_STEP, async () => {
    try {
      const ev = await ctx.ports.queen(ctx.task.hive).appendAudit(input);
      return { eventId: ev.eventId as string | null };
    } catch (e) {
      if (!isPermanentQueenError(e)) throw e;
      console.warn(`gatekeeper: audit ${role} ${status} rejected by the Queen`, messageOf(e));
      return { eventId: null };
    }
  });
}

async function report(ctx: Ctx, passed: boolean, summary: string): Promise<string> {
  return ctx.step.do("report: train result", REPORT_STEP, async () => {
    try {
      const r = await ctx.ports.queen(ctx.task.hive).reportTrainResult({ trainId: ctx.train.trainId, passed, summary, commitSha: ctx.task.after });
      return String(r.outcome);
    } catch (e) {
      if (!isPermanentQueenError(e)) throw e;
      return `rejected: ${clip(messageOf(e), 200)}`;
    }
  });
}

/** The gate itself broke (clone failed, sandbox not implemented, ...): eject rather than hang in TESTING. */
async function failInfra(ctx: Ctx, err: unknown): Promise<GateRunResult> {
  const summary = clip(`Gatekeeper could not inspect the push: ${messageOf(err)}`, MAX_SUMMARY_CHARS);
  const steps = [summary];
  await audit(ctx, "audit: policy result", "POLICY", "REJECTED", ledgerFor(ctx, POLICY_MODEL, 0, steps, false));
  await audit(ctx, "audit: security result", "SECURITY", "REJECTED", ledgerFor(ctx, SECURITY_MODEL, 0, steps, false));
  await ctx.step.do("scribe: record summary", REPORT_STEP, async () => {
    try {
      await ctx.ports.queen(ctx.task.hive).recordScribeSummary({ promptId: ctx.train.promptId, trainId: ctx.train.trainId, summary });
    } catch (e) {
      if (!isPermanentQueenError(e)) throw e;
    }
    return { recorded: true };
  });
  const queenOutcome = await report(ctx, false, summary);
  return { status: "gated", trainId: ctx.train.trainId, passed: false, summary, queenOutcome };
}

export const CHUNK_CHARS = 1_500;
export const MAX_CHUNKS = 6;

export function chunkLog(log: string, size = CHUNK_CHARS, max = MAX_CHUNKS): string[] {
  const out: string[] = [];
  for (let i = 0; i < log.length && out.length < max; i += size) out.push(log.slice(i, i + size));
  return out;
}

/** Best effort: Vectorize/AI trouble never fails the gate. */
async function vectorize(ctx: Ctx, rawLog: string): Promise<number> {
  const { task, train } = ctx;
  const chunks: FailureChunk[] = chunkLog(rawLog).map((text, i) => ({
    id: `${train.trainId}:${task.after.slice(0, 12)}:${i}`,
    text,
    metadata: { trainId: train.trainId, promptId: train.promptId, namespace: task.hive, kind: "failure-log", commitSha: task.after, chunk: i },
  }));
  try {
    const r = await ctx.step.do("vectorize: store failure log", BEST_EFFORT_STEP, () => ctx.ports.failures.store(chunks));
    return r.stored;
  } catch (e) {
    console.warn("gatekeeper: vectorize failed (ignored)", messageOf(e));
    return 0;
  }
}

/**
 * The drone control flow, written against a minimal StepRunner and the
 * DronePorts seam so it can be tested without Workflows, Artifacts or the
 * Queen. DroneWorkflow.run() is a thin adapter around runDrone().
 *
 * Replay rules (Workflows re-runs `run()` and skips completed steps):
 * - Every clock read happens inside a step, so executionTimeMs and the commit
 *   timestamp are stable across replays and retries.
 * - Steps return only small, serializable values (SHAs, change set ≤ 512 KiB).
 */
import type { WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  DroneTaskSchema,
  type AppendAuditInput,
  type AuditStatus,
  type BuildUsage,
  type DroneRole,
  type DroneTask,
  type FollowUp,
  type GitNotesPayload,
  type MergeResult,
  MergeResultSchema,
  isTransientError,
} from "@queenos/queen-types";
import {
  AiGatewayError,
  LedgerError,
  buildGitNotesPayload,
  isRateLimited,
  jitteredBackoffMs,
  structuredLog,
  traceFields,
  writeMetric,
  type BackoffOptions,
} from "@queenos/hive-kit";
import { commitAndPush, generateChangeSet, type CommitPushResult, type Generated, type LedgerStore } from "./build";
import { ChangeSetError } from "./change-set";
import { AllModelsFailedError } from "./generate";
import { ConfigError, type DroneConfig } from "./config";
import { landTrain, type LandOutcome } from "./land";
import type { NetRetry } from "./net-retry";
import { defaultMergeCar } from "./merge-adapter";
import type { DronePorts, QueenPort } from "./ports";
import { SCRIPTED_MODEL } from "./scripted";
import { AGENT_PHASE_MS, INFRA_PREFIX, MIN_MODEL_MS, runAgentBuild, type AgentGenerated } from "./agent/run";

export interface StepRunner {
  do<T>(name: string, config: WorkflowStepConfig, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

export const GENERATE_STEP: WorkflowStepConfig = { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" };
export const GIT_STEP: WorkflowStepConfig = { retries: { limit: 4, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" };
/**
 * MERGE / LAND: transient Artifacts errors (503 / 429) are retried in place with jitter first (net-retry.ts),
 * then Workflows retries the step 3 more times (10 s, 20 s, 40 s). Only then is it reported, as infra.
 */
export const MERGE_STEP: WorkflowStepConfig = { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" };
export const LAND_STEP: WorkflowStepConfig = { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" };
export const REPORT_STEP: WorkflowStepConfig = { retries: { limit: 5, delay: "2 seconds", backoff: "exponential" }, timeout: "30 seconds" };
/** Step retries of the tool-loop agent (a rate limit that outlasts the in-step retries, a DO reset, an RPC error). */
export const AGENT_STEP_RETRIES = 5;
/** Delay before re-running the agent step after a non-rate-limit error (it re-attaches to the same submissions). */
export const AGENT_RETRY_DELAY_MS = 5_000;
/** Rate-limit step retries: equal-jitter exponential from 15 s, capped at 90 s (≤ 6 min over all 5 retries). */
export const AGENT_RATE_LIMIT_BACKOFF = { baseMs: 15_000, maxMs: 90_000 } as const;

/**
 * The `agent: build` step config. Workflows calls `retries.delay` with the error after each failed attempt
 * (`backoff: "constant"`, so the returned delay is used as is):
 * - a rate limit (Workers AI 429 / 3021 "inference request per min rate reached") waits a long, jittered
 *   backoff so a swarm of builders that hit the per-minute limit together do not retry in lockstep;
 * - anything else waits AGENT_RETRY_DELAY_MS (the retry re-attaches to the same BuilderAgent submission).
 * The wait never runs past the agent phase (`deadlineMs`, minus the time a model needs): once a retry could
 * no longer start a model, it waits 1 s and fails fast as INFRA (the drone reports `cause: "infra"`), so the
 * whole drone stays well inside the Queen's watchdog (COMMAND_TIMEOUT_MS, 10 min).
 */
export function agentStepConfig(deadlineMs: number, now: () => number = Date.now, random: () => number = Math.random): WorkflowStepConfig {
  const delay = ({ ctx, error }: { ctx: { attempt: number }; error: Error }): number => {
    if (!isRateLimited(error)) return AGENT_RETRY_DELAY_MS;
    const wait = jitteredBackoffMs(Math.max(1, ctx.attempt), { ...AGENT_RATE_LIMIT_BACKOFF, random });
    const room = deadlineMs - MIN_MODEL_MS - now();
    return wait <= room ? wait : 1_000;
  };
  return { retries: { limit: AGENT_STEP_RETRIES, delay, backoff: "constant" }, timeout: "8 minutes" };
}
export const CLOCK_STEP: WorkflowStepConfig = { retries: { limit: 2, delay: "1 second" }, timeout: "10 seconds" };

export const LANDER_MODEL = "queenos/lander-git-push";
/** The MERGE drone is deterministic git, audited under the LANDER role. */
export const MERGE_MODEL = "queenos/merge-git";
const MAX_SUMMARY = 500;

export type DroneRunResult =
  | {
      action: "BUILD" | "REWORK";
      trainId: string;
      status: "built";
      headSha: string;
      codeSha: string;
      ledgerStore: LedgerStore;
      notesError?: string;
      queenOutcome: string;
    }
  | {
      action: "MERGE";
      /** The car id. */
      trainId: string;
      status: "merged" | "failed";
      headSha?: string;
      merged: number;
      conflicts: number;
      fastForward: boolean;
      summary: string;
      queenOutcome: string;
    }
  | {
      action: "LAND";
      trainId: string;
      status: "landed" | "not-landed";
      mainSha?: string;
      summary: string;
      notesCarried: number;
      notesError?: string;
      queenOutcome: string;
    };

export class DroneFailedError extends Error {
  override readonly name = "DroneFailedError";
}

const clip = (s: string, n = MAX_SUMMARY) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const messageOf = (e: unknown) => String((e as Error)?.message ?? e);

/** Errors that will not get better on retry become NonRetryableError inside steps. */
export function toStepError(e: unknown, config: Pick<DroneConfig, "llmMode">): unknown {
  if (e instanceof NonRetryableError) return e;
  // A 503 / 429 from Artifacts is never permanent: it must stay retryable (Workflows retries it, then the drone reports infra).
  if (
    isTransientError(e) &&
    !(e instanceof AiGatewayError || e instanceof ConfigError || e instanceof LedgerError || e instanceof ChangeSetError) &&
    !messageOf(e).startsWith(INFRA_PREFIX)
  ) {
    return e;
  }
  const code = String((e as { code?: unknown } | null)?.code ?? "");
  const permanent =
    (e instanceof AiGatewayError && !e.retryable) ||
    e instanceof ConfigError ||
    e instanceof LedgerError ||
    (e instanceof ChangeSetError && (config.llmMode === "scripted" || e instanceof AllModelsFailedError)) ||
    code === "NOTHING_TO_COMMIT" ||
    code === "INVALID_PATH" ||
    messageOf(e).startsWith(INFRA_PREFIX) ||
    /^(INVALID_INPUT|NOT_FOUND|CONFLICT|UNAVAILABLE): /.test(messageOf(e));
  return permanent ? new NonRetryableError(clip(messageOf(e), 1_000)) : e;
}

/** The Queen's RPC errors that mean "do not retry" (stale/unknown train, bad input). */
function isPermanentQueenError(e: unknown): boolean {
  return /^(INVALID_INPUT|NOT_FOUND|CONFLICT): /.test(messageOf(e));
}

export interface DroneRunMeta {
  /** Workflow instance id; names the BuilderAgent DOs. Defaults to the Queen's `<trainId>-<action>`. */
  instanceId?: string;
  /** Rate-limit (429) retry policy for model calls; tests inject `sleep` and `random`. */
  backoff?: BackoffOptions;
  /** In-step retry policy for MERGE / LAND git calls; tests inject `sleep` and `random`. */
  net?: NetRetry;
}

export async function runDrone(payload: unknown, step: StepRunner, ports: DronePorts, config: DroneConfig, meta: DroneRunMeta = {}): Promise<DroneRunResult> {
  const parsed = DroneTaskSchema.safeParse(payload);
  if (!parsed.success) {
    // Outside any step, so never retried. (A NonRetryableError here aborts the engine and loses the message.)
    throw new DroneFailedError(`invalid DroneTask: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  const task = parsed.data;
  const role: DroneRole = task.action === "LAND" || task.action === "MERGE" ? "LANDER" : "BUILDER";
  const queen = () => ports.queen(task.namespace);
  const instanceId = meta.instanceId ?? `${task.trainId}-${task.action.toLowerCase()}`;
  const ctx: RunCtx = { task, role, step, ports, config, queen, instanceId, ...(meta.backoff ? { backoff: meta.backoff } : {}), ...(meta.net ? { net: meta.net } : {}) };

  const { startedAtMs } = await step.do("clock: start", CLOCK_STEP, async () => ({ startedAtMs: Date.now() }));
  ctx.startedAtMs = startedAtMs;
  note(ctx, "drone: start", "started");
  await audit(ctx, "audit: running", "RUNNING", null);

  return task.action === "LAND" ? runLand(ctx) : task.action === "MERGE" ? runMerge(ctx) : runBuild(ctx);
}

interface RunCtx {
  task: DroneTask;
  role: DroneRole;
  step: StepRunner;
  ports: DronePorts;
  config: DroneConfig;
  queen: () => QueenPort;
  instanceId: string;
  startedAtMs?: number;
  backoff?: BackoffOptions;
  net?: NetRetry;
}

/**
 * One structured log line per drone step (design §2.6 (b)): trace fields from `DroneTask.trace`
 * (empty for a v1 Queen), `command_id` = the Workflow instance id. Never throws.
 */
function note(ctx: RunCtx, stepName: string, outcome: string, extra: Record<string, unknown> = {}): void {
  try {
    const { task, instanceId } = ctx;
    structuredLog({
      ...traceFields(task.trace, instanceId, stepName),
      hive: task.namespace,
      command_id: instanceId,
      step: stepName,
      outcome,
      action: task.action,
      train_id: task.trainId,
      ...(ctx.startedAtMs !== undefined ? { ms: Math.max(0, Date.now() - ctx.startedAtMs) } : {}),
      ...extra,
    });
  } catch {
    /* logging must never break a drone */
  }
}

/** One Analytics Engine point (design §2.8); fire-and-forget, a missing binding is a no-op. */
function metric(ctx: RunCtx, p: { type: string; model?: string; outcome: string; valueMs?: number; tokensIn?: number; tokensOut?: number }): void {
  writeMetric(ctx.ports.analytics, {
    hive: ctx.task.namespace,
    kindOrRole: ctx.role,
    environment: "drone",
    ...(ctx.task.trace ? traceIdOf(ctx.task.trace.traceparent) : {}),
    ...p,
  });
}

const traceIdOf = (tp: string): { traceId: string } | Record<string, never> => {
  const f = traceFields({ traceparent: tp }, "x");
  return f.trace_id ? { traceId: f.trace_id } : {};
};

async function elapsed(ctx: RunCtx, name: string): Promise<number> {
  const { atMs } = await ctx.step.do(name, CLOCK_STEP, async () => ({ atMs: Date.now() }));
  return Math.max(0, atMs - (ctx.startedAtMs ?? atMs));
}

/** Unix seconds for commits/notes, fixed by the start step. */
const commitTimestamp = (ctx: RunCtx) => Math.floor((ctx.startedAtMs ?? 0) / 1000);

async function audit(ctx: RunCtx, name: string, status: AuditStatus, gitNotesPayload: GitNotesPayload | null): Promise<void> {
  const input: AppendAuditInput = { promptId: ctx.task.promptId, droneRole: ctx.role, status, gitNotesPayload };
  // Auditing never blocks the drone: permanent Queen errors are logged and skipped.
  await ctx.step.do(name, REPORT_STEP, async () => {
    try {
      const event = await ctx.queen().appendAudit(input);
      return { eventId: event.eventId as string | null };
    } catch (e) {
      if (!isPermanentQueenError(e)) throw e;
      console.warn(`drone: audit "${status}" rejected by the Queen`, messageOf(e));
      return { eventId: null };
    }
  });
}

async function report(ctx: RunCtx, name: string, call: (q: QueenPort) => Promise<{ outcome: string }>): Promise<string> {
  const outcome = await ctx.step.do(name, REPORT_STEP, async () => {
    try {
      return String((await call(ctx.queen())).outcome);
    } catch (e) {
      if (!isPermanentQueenError(e)) throw e;
      return `rejected: ${clip(messageOf(e), 200)}`;
    }
  });
  note(ctx, name, outcome);
  return outcome;
}

// ── BUILD / REWORK ─────────────────────────────────────────────────────────

async function runBuild(ctx: RunCtx): Promise<DroneRunResult> {
  const { task, step, ports, config } = ctx;
  let gen: Generated & { genMs: number };
  try {
    if (config.llmMode === "scripted" && config.scriptedDelayMs > 0) {
      await step.sleep("scripted: thinking", config.scriptedDelayMs);
    }
    if (config.llmMode === "live" && config.harness === "agent") {
      // The Think tool loop replaces the single-shot generator; everything after this step is unchanged.
      const deadlineMs = (ctx.startedAtMs ?? Date.now()) + AGENT_PHASE_MS;
      gen = await step.do("agent: build", agentStepConfig(deadlineMs), async () => {
        const t0 = Date.now();
        const g = await runAgentBuild(task, ports, config, { instanceId: ctx.instanceId, deadlineMs, ...(ctx.backoff ? { backoff: ctx.backoff } : {}) }).catch((e) => Promise.reject(toStepError(e, config)));
        console.log(`drone: agent ${g.model} built ${task.trainId} in ${g.agentUsage.steps} step(s), ${g.agentUsage.inputTokens}/${g.agentUsage.outputTokens} tokens`);
        return { ...g, genMs: Date.now() - t0 };
      });
    } else {
      gen = await step.do("generate change set", GENERATE_STEP, async () => {
        const t0 = Date.now();
        const g = await generateChangeSet(task, ports, config, ctx.backoff).catch((e) => Promise.reject(toStepError(e, config)));
        return { ...g, genMs: Date.now() - t0 };
      });
    }
  } catch (e) {
    return failBuild(ctx, "generation", e);
  }

  const executionTimeMs = await elapsed(ctx, "clock: generated");
  const ledger = buildGitNotesPayload({
    taskPrompt: task.promptText,
    model: gen.model,
    temperature: gen.temperature,
    reasoningSteps: gen.changeSet.reasoningSteps,
    result: "success",
    executionTimeMs,
    discardedPaths: gen.changeSet.discardedPaths,
  });

  let pushed: CommitPushResult & { pushMs: number };
  try {
    pushed = await step.do("clone, commit, note, push", GIT_STEP, async () => {
      const t0 = Date.now();
      const r = await commitAndPush(ports, { task, changeSet: gen.changeSet, ledger, timestamp: commitTimestamp(ctx) }).catch((e) =>
        Promise.reject(toStepError(e, config)),
      );
      return { ...r, pushMs: Date.now() - t0 };
    });
  } catch (e) {
    return failBuild(ctx, "commit/push", e, gen.model);
  }

  const buildMs = Math.max(0, Math.round(gen.genMs + pushed.pushMs));
  const agentGen = gen as Partial<AgentGenerated>;
  const verified = agentGen.verified;
  const followUps = normalizeFollowUps(agentGen.followUps);
  const queenOutcome = await report(ctx, "report: build result", (q) =>
    q.reportBuildResult({
      trainId: task.trainId,
      headSha: pushed.headSha,
      model: gen.model,
      ...(gen.failedModels.length ? { failedModels: gen.failedModels.slice(0, 5) } : {}),
      buildMs,
      ...(config.llmMode === "live" ? { usage: buildUsage(gen) } : {}),
      ...(verified !== undefined ? { verified } : {}),
      ...(followUps.length ? { followUps } : {}),
      ...(pushed.changedPaths.length ? { changedPaths: pushed.changedPaths } : {}),
    }),
  );
  metric(ctx, { type: "drone.build", model: gen.model, outcome: "built", valueMs: buildMs, tokensIn: gen.usage.inputTokens, tokensOut: gen.usage.outputTokens });
  await audit(ctx, "audit: passed", "PASSED", ledger);
  return {
    action: task.action === "REWORK" ? "REWORK" : "BUILD",
    trainId: task.trainId,
    status: "built",
    headSha: pushed.headSha,
    codeSha: pushed.codeSha,
    ledgerStore: pushed.ledgerStore,
    ...(pushed.notesError ? { notesError: pushed.notesError } : {}),
    queenOutcome,
  };
}

/** The builder's `finish.followUps` as the Queen's FollowUp shape (≤3; defaults filled, strings clipped). */
function normalizeFollowUps(raw: AgentGenerated["followUps"] | undefined): FollowUp[] {
  return (raw ?? []).slice(0, 3).map((f) => ({
    kind: f.kind,
    title: clip(f.title, 120),
    body: clip(f.body, 1_000),
    paths: (f.paths ?? []).slice(0, 10).map((p) => p.slice(0, 200)),
    priority: f.priority ?? 2,
  }));
}

/** Tokens across every model tried; the agent harness also reports its tool-loop steps. */
function buildUsage(gen: Generated): BuildUsage {
  const steps = (gen as Partial<AgentGenerated>).agentUsage?.steps;
  return { inputTokens: gen.usage.inputTokens, outputTokens: gen.usage.outputTokens, ...(steps !== undefined ? { steps } : {}) };
}

/**
 * An infrastructure failure, not the model's: Workers AI rate limits that outlasted every retry, or an agent
 * phase used up by those retries before any model could run. Matched on the message, since a step error
 * comes back from Workflows as a plain Error.
 */
export function isInfraFailure(e: unknown): boolean {
  const msg = messageOf(e);
  return isRateLimited(e) || msg.startsWith(INFRA_PREFIX) || msg.includes(`: ${INFRA_PREFIX}`);
}

/**
 * Report the failure (train result + REJECTED audit), then fail the instance. An infrastructure failure
 * (isInfraFailure) is reported as `cause: "infra"` with this instance's id: the Queen re-dispatches the drone
 * (same item, no rework, no verdict against the model, the AIMD floor untouched) instead of reworking it.
 */
async function failBuild(ctx: RunCtx, stage: string, err: unknown, model?: string): Promise<never> {
  const { task, config } = ctx;
  const infra = isInfraFailure(err);
  const summary = clip(`Builder drone ${infra ? "hit an infrastructure limit (not a build failure)" : "failed"} during ${stage}: ${messageOf(err)}`);
  const executionTimeMs = await elapsed(ctx, "clock: failed");
  const ledger = buildGitNotesPayload({
    taskPrompt: task.promptText,
    model: model ?? (config.llmMode === "scripted" ? SCRIPTED_MODEL : (task.modelChoice?.model ?? config.aiGateway.model)),
    temperature: config.llmMode === "scripted" ? 0 : config.temperature,
    reasoningSteps: [summary],
    result: "failure",
    executionTimeMs,
  });
  if (infra) {
    await report(ctx, "report: infra failure", (q) => q.reportTrainResult({ trainId: task.trainId, passed: false, summary, cause: "infra", commandId: ctx.instanceId }));
  } else {
    await report(ctx, "report: build failure", (q) => q.reportTrainResult({ trainId: task.trainId, passed: false, summary }));
  }
  metric(ctx, { type: "drone.build", ...(model ? { model } : {}), outcome: infra ? "infra" : "failed", valueMs: executionTimeMs });
  await audit(ctx, "audit: rejected", "REJECTED", ledger);
  throw new DroneFailedError(summary);
}

// ── LAND ───────────────────────────────────────────────────────────────────

async function runLand(ctx: RunCtx): Promise<DroneRunResult> {
  const { task, step, ports, config } = ctx;
  let outcome: LandOutcome;
  /** A transient error outlasted every retry: the Queen re-dispatches the lander instead of failing the car. */
  let infra = false;
  try {
    outcome = await step.do("land: push train head to hive main", LAND_STEP, () =>
      landTrain(ports, task, commitTimestamp(ctx), ctx.net).catch((e) => Promise.reject(toStepError(e, config))),
    );
  } catch (e) {
    outcome = { landed: false, summary: clip(`Lander failed: ${messageOf(e)}`), notesCarried: 0 };
    infra = isTransientError(e);
  }

  const executionTimeMs = await elapsed(ctx, "clock: landed");
  const ledger = buildGitNotesPayload({
    taskPrompt: task.promptText,
    model: LANDER_MODEL,
    temperature: 0,
    reasoningSteps: [
      `Push train head ${task.baseRef.slice(0, 12)} from ${task.artifactRepo} to ${task.namespace}/main.`,
      outcome.summary,
      ...(outcome.landed ? [`Carried ${outcome.notesCarried} ledger note(s) to the hive.`] : []),
    ],
    result: outcome.landed ? "success" : "failure",
    executionTimeMs,
  });

  const queenOutcome = await report(ctx, "report: land result", (q) =>
    q.reportLandResult(
      outcome.landed && outcome.mainSha
        ? { trainId: task.trainId, landed: true, mainSha: outcome.mainSha, summary: clip(outcome.summary) }
        : { trainId: task.trainId, landed: false, summary: clip(outcome.summary), ...(infra ? { cause: "infra" as const, commandId: ctx.instanceId } : {}) },
    ),
  );
  metric(ctx, { type: "drone.land", model: LANDER_MODEL, outcome: outcome.landed ? "landed" : infra ? "infra" : "not-landed", valueMs: executionTimeMs });
  await audit(ctx, outcome.landed ? "audit: passed" : "audit: rejected", outcome.landed ? "PASSED" : "REJECTED", ledger);
  return {
    action: "LAND",
    trainId: task.trainId,
    status: outcome.landed ? "landed" : "not-landed",
    ...(outcome.mainSha ? { mainSha: outcome.mainSha } : {}),
    summary: outcome.summary,
    notesCarried: outcome.notesCarried,
    ...(outcome.notesError ? { notesError: outcome.notesError } : {}),
    queenOutcome,
  };
}

// ── MERGE ──────────────────────────────────────────────────────────────────

/**
 * The merge-queue drone (design §2.3.4): `mergeCar` (WP1.12) 3-way merges the car's members onto its fork
 * and pushes. Deterministic and idempotent for the fixed step timestamp; no LLM. An infrastructure failure
 * is reported as `ok: false` (the Queen decides about bisect/infra), never thrown, so the Queen always hears.
 */
async function runMerge(ctx: RunCtx): Promise<DroneRunResult> {
  const { task, step, ports, config } = ctx;
  const mergeCar = ports.mergeCar ?? defaultMergeCar;
  let result: MergeResult;
  try {
    result = await step.do("merge: members onto the car fork", MERGE_STEP, async () => {
      const t0 = Date.now();
      const r = await mergeCar(ports, task, commitTimestamp(ctx), ctx.net).catch((e) => Promise.reject(toStepError(e, config)));
      return MergeResultSchema.parse({ ...r, trainId: task.trainId, mergeMs: r.mergeMs ?? Date.now() - t0 });
    });
  } catch (e) {
    // A transient error that outlasted every retry is infra: the Queen re-dispatches the same car.
    result = MergeResultSchema.parse({
      trainId: task.trainId,
      ok: false,
      summary: clip(`Merge drone failed: ${messageOf(e)}`),
      ...(isTransientError(e) ? { cause: "infra" as const, commandId: ctx.instanceId } : {}),
    });
  }
  result = { ...result, summary: clip(result.summary) };

  const executionTimeMs = await elapsed(ctx, "clock: merged");
  const ok = result.ok;
  const ledger = buildGitNotesPayload({
    taskPrompt: task.promptText,
    model: MERGE_MODEL,
    temperature: 0,
    reasoningSteps: [
      `Merge ${task.members?.length ?? 0} member(s) onto car fork ${task.artifactRepo}.`,
      ...(ok
        ? [
            `Merged ${result.merged.length}: ${result.merged.join(", ") || "none"}.`,
            ...result.conflicts.map((c) => `Conflict (${c.kind}) in ${c.trainId}: ${c.paths.join(", ") || "n/a"}`),
            ...(result.fastForward ? ["Fast-forwarded the single member."] : []),
          ]
        : [result.summary]),
    ].map((r) => clip(r, 2_000)),
    result: ok ? "success" : "failure",
    executionTimeMs,
  });

  const queenOutcome = await report(ctx, "report: merge result", (q) => q.reportMergeResult({ ...result, mergeMs: result.mergeMs ?? executionTimeMs }));
  metric(ctx, { type: "drone.merge", model: MERGE_MODEL, outcome: ok ? (result.merged.length ? "merged" : "empty") : result.cause === "infra" ? "infra" : "failed", valueMs: result.mergeMs ?? executionTimeMs });
  await audit(ctx, ok ? "audit: passed" : "audit: rejected", ok ? "PASSED" : "REJECTED", ledger);
  return {
    action: "MERGE",
    trainId: task.trainId,
    status: ok ? "merged" : "failed",
    ...(result.headSha ? { headSha: result.headSha } : {}),
    merged: result.merged.length,
    conflicts: result.conflicts.length,
    fastForward: result.fastForward,
    summary: result.summary,
    queenOutcome,
  };
}

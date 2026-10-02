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
  type DroneRole,
  type DroneTask,
  type GitNotesPayload,
} from "@queenos/queen-types";
import { AiGatewayError, LedgerError, buildGitNotesPayload } from "@queenos/hive-kit";
import { commitAndPush, generateChangeSet, type CommitPushResult, type Generated, type LedgerStore } from "./build";
import { ChangeSetError } from "./change-set";
import { ConfigError, type DroneConfig } from "./config";
import { landTrain, type LandOutcome } from "./land";
import type { DronePorts, QueenPort } from "./ports";
import { SCRIPTED_MODEL } from "./scripted";

export interface StepRunner {
  do<T>(name: string, config: WorkflowStepConfig, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

export const GENERATE_STEP: WorkflowStepConfig = { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" };
export const GIT_STEP: WorkflowStepConfig = { retries: { limit: 4, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" };
export const REPORT_STEP: WorkflowStepConfig = { retries: { limit: 5, delay: "2 seconds", backoff: "exponential" }, timeout: "30 seconds" };
export const CLOCK_STEP: WorkflowStepConfig = { retries: { limit: 2, delay: "1 second" }, timeout: "10 seconds" };

export const LANDER_MODEL = "queenos/lander-git-push";
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
  const code = String((e as { code?: unknown } | null)?.code ?? "");
  const permanent =
    (e instanceof AiGatewayError && !e.retryable) ||
    e instanceof ConfigError ||
    e instanceof LedgerError ||
    (e instanceof ChangeSetError && config.llmMode === "scripted") ||
    code === "NOTHING_TO_COMMIT" ||
    code === "INVALID_PATH" ||
    /^(INVALID_INPUT|NOT_FOUND|CONFLICT|UNAVAILABLE): /.test(messageOf(e));
  return permanent ? new NonRetryableError(clip(messageOf(e), 1_000)) : e;
}

/** The Queen's RPC errors that mean "do not retry" (stale/unknown train, bad input). */
function isPermanentQueenError(e: unknown): boolean {
  return /^(INVALID_INPUT|NOT_FOUND|CONFLICT): /.test(messageOf(e));
}

export async function runDrone(payload: unknown, step: StepRunner, ports: DronePorts, config: DroneConfig): Promise<DroneRunResult> {
  const parsed = DroneTaskSchema.safeParse(payload);
  if (!parsed.success) {
    // Outside any step, so never retried. (A NonRetryableError here aborts the engine and loses the message.)
    throw new DroneFailedError(`invalid DroneTask: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  const task = parsed.data;
  const role: DroneRole = task.action === "LAND" ? "LANDER" : "BUILDER";
  const queen = () => ports.queen(task.namespace);
  const ctx: RunCtx = { task, role, step, ports, config, queen };

  const { startedAtMs } = await step.do("clock: start", CLOCK_STEP, async () => ({ startedAtMs: Date.now() }));
  ctx.startedAtMs = startedAtMs;
  await audit(ctx, "audit: running", "RUNNING", null);

  return task.action === "LAND" ? runLand(ctx) : runBuild(ctx);
}

interface RunCtx {
  task: DroneTask;
  role: DroneRole;
  step: StepRunner;
  ports: DronePorts;
  config: DroneConfig;
  queen: () => QueenPort;
  startedAtMs?: number;
}

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
  return ctx.step.do(name, REPORT_STEP, async () => {
    try {
      return String((await call(ctx.queen())).outcome);
    } catch (e) {
      if (!isPermanentQueenError(e)) throw e;
      return `rejected: ${clip(messageOf(e), 200)}`;
    }
  });
}

// ── BUILD / REWORK ─────────────────────────────────────────────────────────

async function runBuild(ctx: RunCtx): Promise<DroneRunResult> {
  const { task, step, ports, config } = ctx;
  let gen: Generated;
  try {
    if (config.llmMode === "scripted" && config.scriptedDelayMs > 0) {
      await step.sleep("scripted: thinking", config.scriptedDelayMs);
    }
    gen = await step.do("generate change set", GENERATE_STEP, () =>
      generateChangeSet(task, ports, config).catch((e) => Promise.reject(toStepError(e, config))),
    );
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

  let pushed: CommitPushResult;
  try {
    pushed = await step.do("clone, commit, note, push", GIT_STEP, () =>
      commitAndPush(ports, { task, changeSet: gen.changeSet, ledger, timestamp: commitTimestamp(ctx) }).catch((e) =>
        Promise.reject(toStepError(e, config)),
      ),
    );
  } catch (e) {
    return failBuild(ctx, "commit/push", e, gen.model);
  }

  const queenOutcome = await report(ctx, "report: build result", (q) =>
    q.reportBuildResult({ trainId: task.trainId, headSha: pushed.headSha }),
  );
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

/** Report the failure (train result + REJECTED audit), then fail the instance. */
async function failBuild(ctx: RunCtx, stage: string, err: unknown, model?: string): Promise<never> {
  const { task, config } = ctx;
  const summary = clip(`Builder drone failed during ${stage}: ${messageOf(err)}`);
  const executionTimeMs = await elapsed(ctx, "clock: failed");
  const ledger = buildGitNotesPayload({
    taskPrompt: task.promptText,
    model: model ?? (config.llmMode === "scripted" ? SCRIPTED_MODEL : config.aiGateway.model),
    temperature: config.llmMode === "scripted" ? 0 : config.temperature,
    reasoningSteps: [summary],
    result: "failure",
    executionTimeMs,
  });
  await report(ctx, "report: build failure", (q) => q.reportTrainResult({ trainId: task.trainId, passed: false, summary }));
  await audit(ctx, "audit: rejected", "REJECTED", ledger);
  throw new DroneFailedError(summary);
}

// ── LAND ───────────────────────────────────────────────────────────────────

async function runLand(ctx: RunCtx): Promise<DroneRunResult> {
  const { task, step, ports, config } = ctx;
  let outcome: LandOutcome;
  try {
    outcome = await step.do("land: push train head to hive main", GIT_STEP, () =>
      landTrain(ports, task, commitTimestamp(ctx)).catch((e) => Promise.reject(toStepError(e, config))),
    );
  } catch (e) {
    outcome = { landed: false, summary: clip(`Lander failed: ${messageOf(e)}`), notesCarried: 0 };
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
        : { trainId: task.trainId, landed: false, summary: clip(outcome.summary) },
    ),
  );
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

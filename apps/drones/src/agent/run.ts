/**
 * Body of the `agent: build` Workflow step: seed a BuilderAgent per model (Queen's choice, then its
 * fallbacks), take the first run that finished with a passing verify and a clean overlay, and return
 * it as a change set (overlay + ledger reasoning). Commit/push stay in their own step.
 */
import { supportsToolLoop, type DroneTask } from "@queenos/queen-types";
import { AiGatewayError, isRateLimited, withRateLimitRetry, type BackoffOptions } from "@queenos/hive-kit";
import { templateFitProblems, validateChangeSet } from "../change-set";
import type { DroneConfig } from "../config";
import { AllModelsFailedError, modelsFor, type Generated } from "../generate";
import type { DronePorts } from "../ports";
import { branchOf } from "../build";
import type { AgentBuildResult, AgentUsage } from "./contract";
import { MAX_SEED_FILE_CHARS } from "./limits";
import type { FinishFollowUp } from "./tools";
import { MAX_FOLLOW_UPS } from "./tools";
import { diffTrees, overlayProblems } from "./overlay";
import { ledgerDiscarded, ledgerReasoning } from "./trace";

/** Whole agent phase, from the drone's replay-stable start clock (Queen watchdog: 10 min). */
export const AGENT_PHASE_MS = 7 * 60_000;
/** Wall time per model run. */
export const PER_MODEL_MS = 240_000;
/** Do not start a model with less than this left. */
export const MIN_MODEL_MS = 45_000;
export const MAX_SEED_FILES = 400;
/** Submission keys per (instance, model): in-step 429 retries × step retries, with room to spare. */
export const MAX_SUBMISSIONS_PER_MODEL = 48;

/** Prefix of an infrastructure failure (not the model's fault): the drone reports it as `cause: "infra"`. */
export const INFRA_PREFIX = "INFRA: ";

/** The `n`th submission key for a model: `<instance>:<model>`, then `<instance>:<model>:rl<n>`. */
export function submissionKey(instanceId: string, model: string, n: number): string {
  return n === 0 ? `${instanceId}:${model}` : `${instanceId}:${model}:rl${n}`;
}

export interface AgentGenerated extends Generated {
  trace: string[];
  agentUsage: AgentUsage;
  /** The accepted run's last verify passed and its finish was accepted (finish is refused otherwise). */
  verified: boolean;
  /** Out-of-scope problems the builder reported in `finish` (≤ MAX_FOLLOW_UPS). */
  followUps: FinishFollowUp[];
}

export interface AgentRunOptions {
  /** Workflow instance id (`<trainId>-build[-n]`): names the DOs and keys the submissions. */
  instanceId: string;
  /** Absolute ms deadline for the whole agent phase. */
  deadlineMs: number;
  now?: () => number;
  /** Rate-limit (429) retry policy; tests inject `sleep` and `random`. */
  backoff?: BackoffOptions;
}

/** Tool-loop model order: the Queen's choice + fallbacks minus models that cannot drive a tool loop. */
export function agentModelsFor(task: Pick<DroneTask, "modelChoice">, config: Pick<DroneConfig, "aiGateway">): string[] {
  const usable = modelsFor(task, config).filter((m) => supportsToolLoop(m));
  if (usable.length) return usable;
  const fallback = !supportsToolLoop(config.aiGateway.model) ? "@cf/zai-org/glm-5.3-flash" : config.aiGateway.model;
  return [fallback];
}

/** Read the train branch into a text tree (binary/oversized files are left out and so untouchable). */
export async function readBaseTree(task: DroneTask, ports: Pick<DronePorts, "artifacts" | "git">): Promise<Record<string, string>> {
  const access = await ports.artifacts.access(task.artifactRepo, "read");
  const repo = await ports.git.clone({ remote: access.remote, token: access.token, ref: branchOf(task.baseRef), depth: 1 });
  const paths = (await repo.listFiles())
    .filter((f) => !f.startsWith(".git/") && !f.startsWith("node_modules/"))
    .sort()
    .slice(0, MAX_SEED_FILES);
  const read = paths.length ? await repo.readFiles(paths) : {};
  const base: Record<string, string> = {};
  for (const p of paths) {
    const c = read[p];
    if (typeof c === "string" && c.length <= MAX_SEED_FILE_CHARS && !c.includes("�")) base[p] = c;
  }
  return base;
}

/** Why a run is not acceptable, or null when it is. */
export function rejectReason(r: AgentBuildResult, base: Record<string, string>): string | null {
  if (r.status !== "completed") return `${r.status}${r.error ? `: ${r.error}` : ""}`;
  if (!r.finish) {
    const v = r.lastVerify;
    return `no accepted finish${v && !v.ok ? ` (last verify: ${v.error ?? v.problems[0] ?? "failed"})` : ""} after ${r.usage.steps} step(s)`;
  }
  if (r.lastVerify && !r.lastVerify.ok) return `verify did not pass: ${r.lastVerify.error ?? r.lastVerify.problems[0] ?? "failed"}`;
  const overlay = diffTrees(base, r.files);
  const problems = [...overlayProblems(overlay), ...templateFitProblems(overlay, Object.keys(base))];
  return problems.length ? problems.slice(0, 3).join("; ") : null;
}

const SKIPPED_BUDGET = "skipped: agent wall-time budget exhausted";

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export async function runAgentBuild(task: DroneTask, ports: Pick<DronePorts, "agent" | "artifacts" | "git">, config: DroneConfig, opts: AgentRunOptions): Promise<AgentGenerated> {
  const agent = ports.agent;
  if (!agent) throw new Error("UNAVAILABLE: no BuilderAgent port (BUILDER binding missing?)");
  const now = opts.now ?? Date.now;
  const base = await readBaseTree(task, ports);
  const failures: { model: string; reason: string }[] = [];
  const total: AgentUsage = { inputTokens: 0, outputTokens: 0, steps: 0 };

  for (const model of agentModelsFor(task, config)) {
    const remaining = opts.deadlineMs - now();
    if (remaining < MIN_MODEL_MS) {
      failures.push({ model, reason: SKIPPED_BUDGET });
      continue;
    }
    // A thrown error here (DO reset by a deploy, RPC failure) propagates: the step retries and
    // re-attaches to the same submission through the same name + idempotency key.
    // A 429 inside the agent run is the platform's problem, not the model's: back off and run the same
    // model again under the next submission key (so it does not re-attach to the rate-limited one).
    // If it outlasts the in-step retries it propagates as a retryable 429: the Workflow step retries
    // with a long jittered delay (orchestrate.ts agentStepConfig), and the model is never added to
    // `failedModels`. On that step retry the earlier keys re-attach to their spent (rate-limited)
    // submissions: those are skipped at once, with no new model call and no backoff, until a key
    // that is fresh (or still running) is reached.
    let key = 0;
    const r = await withRateLimitRetry(async () => {
      for (;;) {
        const res = await agent.build(`${opts.instanceId}|${model}`, {
          base,
          task: {
            promptId: task.promptId,
            trainId: task.trainId,
            action: task.action,
            promptText: task.promptText,
            ragContext: task.ragContext,
            ...(task.scribeSummary ? { scribeSummary: task.scribeSummary } : {}),
          },
          model,
          idempotencyKey: submissionKey(opts.instanceId, model, key),
          timeoutMs: Math.min(PER_MODEL_MS, Math.max(0, opts.deadlineMs - now())),
          skipCache: task.action === "REWORK",
        });
        if (!(res.status === "error" && !res.finish && isRateLimited(res.error ?? ""))) return res;
        key += 1;
        if (res.reattached && key < MAX_SUBMISSIONS_PER_MODEL) continue; // spent by an earlier step attempt
        throw new AiGatewayError(clip(`rate limited: ${res.error}`, 300), 429, true);
      }
    }, opts.backoff);
    total.inputTokens += r.usage.inputTokens;
    total.outputTokens += r.usage.outputTokens;
    total.steps += r.usage.steps;

    const reason = rejectReason(r, base);
    if (reason) {
      failures.push({ model, reason: clip(reason, 160) });
      console.warn(`drone: agent ${model} rejected for ${task.trainId}: ${reason}`);
      continue;
    }
    const overlay = diffTrees(base, r.files);
    const changeSet = validateChangeSet({
      files: overlay.files,
      deletes: overlay.deletes,
      reasoningSteps: ledgerReasoning(r.finish, r.trace),
      discardedPaths: ledgerDiscarded(r.finish, failures),
    });
    return {
      changeSet,
      model,
      failedModels: failures.map((f) => f.model),
      repaired: false,
      temperature: config.temperature,
      usage: { inputTokens: total.inputTokens, outputTokens: total.outputTokens },
      trace: r.trace,
      agentUsage: total,
      verified: r.lastVerify?.ok === true,
      followUps: (r.finish?.followUps ?? []).slice(0, MAX_FOLLOW_UPS),
    };
  }
  if (failures.length > 0 && failures.every((f) => f.reason === SKIPPED_BUDGET)) {
    // No model ran at all: earlier step attempts (rate limits, transient errors) used up the agent phase.
    // That says nothing about the models, so it is not AllModelsFailed (no failedModels, no rework).
    throw new Error(`${INFRA_PREFIX}agent wall-time budget used up by retries before any model could run (AI rate limits?)`);
  }
  const why = failures.map((f) => `${f.model}: ${f.reason}`).join(" | ");
  throw new AllModelsFailedError(clip(`no verified change from any model: ${why || "no model available"}`, 900), failures.map((f) => f.model));
}

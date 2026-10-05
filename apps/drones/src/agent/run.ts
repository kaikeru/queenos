/**
 * Body of the `agent: build` Workflow step: seed a BuilderAgent per model (Queen's choice, then its
 * fallbacks), take the first run that finished with a passing verify and a clean overlay, and return
 * it as a change set (overlay + ledger reasoning). Commit/push stay in their own step.
 */
import type { DroneTask } from "@queenos/queen-types";
import { templateFitProblems, validateChangeSet } from "../change-set";
import type { DroneConfig } from "../config";
import { AllModelsFailedError, modelsFor, type Generated } from "../generate";
import type { DronePorts } from "../ports";
import { branchOf } from "../build";
import type { AgentBuildResult, AgentUsage } from "./contract";
import { MAX_SEED_FILE_CHARS } from "./limits";
import { diffTrees, overlayProblems } from "./overlay";
import { ledgerDiscarded, ledgerReasoning } from "./trace";

/** Workers AI models that time out in tool loops (spike: 3046 after 138–166 s, 0/2). The drone skips them. */
export const TOOL_LOOP_EXCLUDED: ReadonlySet<string> = new Set(["@cf/qwen/qwen3.8-27b"]);
/** Whole agent phase, from the drone's replay-stable start clock (Queen watchdog: 10 min). */
export const AGENT_PHASE_MS = 7 * 60_000;
/** Wall time per model run. */
export const PER_MODEL_MS = 240_000;
/** Do not start a model with less than this left. */
export const MIN_MODEL_MS = 45_000;
export const MAX_SEED_FILES = 400;

export interface AgentGenerated extends Generated {
  trace: string[];
  agentUsage: AgentUsage;
}

export interface AgentRunOptions {
  /** Workflow instance id (`<trainId>-build[-n]`): names the DOs and keys the submissions. */
  instanceId: string;
  /** Absolute ms deadline for the whole agent phase. */
  deadlineMs: number;
  now?: () => number;
}

/** Tool-loop model order: the Queen's choice + fallbacks minus models that cannot drive a tool loop. */
export function agentModelsFor(task: Pick<DroneTask, "modelChoice">, config: Pick<DroneConfig, "aiGateway">): string[] {
  const usable = modelsFor(task, config).filter((m) => !TOOL_LOOP_EXCLUDED.has(m));
  if (usable.length) return usable;
  const fallback = TOOL_LOOP_EXCLUDED.has(config.aiGateway.model) ? "@cf/zai-org/glm-5.3-flash" : config.aiGateway.model;
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

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export async function runAgentBuild(task: DroneTask, ports: Pick<DronePorts, "agent" | "artifacts" | "git">, config: DroneConfig, opts: AgentRunOptions): Promise<AgentGenerated> {
  if (!ports.agent) throw new Error("UNAVAILABLE: no BuilderAgent port (BUILDER binding missing?)");
  const now = opts.now ?? Date.now;
  const base = await readBaseTree(task, ports);
  const failures: { model: string; reason: string }[] = [];
  const total: AgentUsage = { inputTokens: 0, outputTokens: 0, steps: 0 };

  for (const model of agentModelsFor(task, config)) {
    const remaining = opts.deadlineMs - now();
    if (remaining < MIN_MODEL_MS) {
      failures.push({ model, reason: "skipped: agent wall-time budget exhausted" });
      continue;
    }
    // A thrown error here (DO reset by a deploy, RPC failure) propagates: the step retries and
    // re-attaches to the same submission through the same name + idempotency key.
    const r = await ports.agent.build(`${opts.instanceId}|${model}`, {
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
      idempotencyKey: `${opts.instanceId}:${model}`,
      timeoutMs: Math.min(PER_MODEL_MS, remaining),
      skipCache: task.action === "REWORK",
    });
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
    };
  }
  const why = failures.map((f) => `${f.model}: ${f.reason}`).join(" | ");
  throw new AllModelsFailedError(clip(`no verified change from any model: ${why || "no model available"}`, 900), failures.map((f) => f.model));
}

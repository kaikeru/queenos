/** The RPC contract between the drone Workflow step (run.ts) and the BuilderAgent DO. */
import type { DroneTask } from "@queenos/queen-types";
import type { FinishArgs } from "./tools";
import type { VerifyResult } from "./verify";

export type AgentTask = Pick<DroneTask, "promptId" | "trainId" | "action" | "promptText" | "ragContext"> & { scribeSummary?: string | undefined };

export interface AgentBuildInput {
  /** The train branch tree the workspace is seeded with (repo-relative path -> text). */
  base: Record<string, string>;
  task: AgentTask;
  model: string;
  /** Workflow instance + model: a retried step re-attaches to the same submission. */
  idempotencyKey: string;
  /** Wall-time budget for this call; the submission is cancelled when it runs out. */
  timeoutMs: number;
  /** Bypass the AI Gateway cache (REWORK: a cached replay would repeat the rejected attempt). */
  skipCache: boolean;
}

export type AgentRunStatus = "completed" | "error" | "aborted" | "skipped" | "timeout";

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  steps: number;
}

export interface AgentBuildResult {
  status: AgentRunStatus;
  error?: string;
  /** Final workspace snapshot (repo-relative). */
  files: Record<string, string>;
  /** The accepted finish call, or null when the agent never finished. */
  finish: FinishArgs | null;
  lastVerify: VerifyResult | null;
  /** Compact tool trace (`t1 read src/index.js`, …). */
  trace: string[];
  usage: AgentUsage;
  /** True when this call joined a submission started by an earlier (retried) call. */
  reattached: boolean;
}

/** How the step reaches a BuilderAgent (prod: DO stub by name; tests: an in-memory fake). */
export interface AgentPort {
  build(name: string, input: AgentBuildInput): Promise<AgentBuildResult>;
}

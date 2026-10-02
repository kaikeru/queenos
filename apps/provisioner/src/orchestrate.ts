/**
 * The provisioner control flow, written against a minimal StepRunner and the
 * ProvisionerPorts seam so it can be tested without Workflows, Artifacts or the
 * Queen. ProvisionerWorkflow.run() is a thin adapter around runProvision().
 *
 * Contract (packages/queen-types/src/executors.ts): the Queen starts one
 * instance per command (instance id = commandId, params = the command). We
 * ALWAYS report a ProvisionResult back, ok or not, then finish.
 *
 * Steps return only small values (repo name, SHA, a short summary).
 */
import type { WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { ProvisionCommandSchema, type ProvisionCommand, type ProvisionResult } from "@queenos/queen-types";
import { errorCode, type ProvisionerPorts } from "./ports";

export interface StepRunner {
  do<T>(name: string, config: WorkflowStepConfig, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

export const PROVISION_STEP: WorkflowStepConfig = { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "3 minutes" };
export const REPORT_STEP: WorkflowStepConfig = { retries: { limit: 5, delay: "2 seconds", backoff: "exponential" }, timeout: "30 seconds" };

const MAX_SUMMARY = 500;
const clip = (s: string, n = MAX_SUMMARY) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const messageOf = (e: unknown) => String((e as Error)?.message ?? e);

export class ProvisionFailedError extends Error {
  override readonly name = "ProvisionFailedError";
}

/** Artifacts codes that will not get better on retry. */
const PERMANENT_CODES = new Set(["NOT_FOUND", "INVALID_NAME", "INVALID_INPUT", "PERMISSION_DENIED", "UNAUTHORIZED"]);

/** Errors that will not get better on retry become NonRetryableError inside steps. */
export function toStepError(e: unknown): unknown {
  if (e instanceof NonRetryableError) return e;
  const permanent = PERMANENT_CODES.has(errorCode(e) ?? "") || /^(INVALID_INPUT|NOT_FOUND|CONFLICT|UNAVAILABLE): /.test(messageOf(e));
  return permanent ? new NonRetryableError(clip(messageOf(e), 1_000)) : e;
}

/** The Queen's RPC errors that mean "do not retry" (stale/unknown train, bad input). */
function isPermanentQueenError(e: unknown): boolean {
  return /^(INVALID_INPUT|NOT_FOUND|CONFLICT): /.test(messageOf(e));
}

export type ProvisionRunResult = { commandId: string; op: ProvisionCommand["op"]; ok: boolean; summary: string; queenOutcome: string };

type Work = { ok: true; artifactRepo?: string; baseSha?: string; summary: string } | { ok: false; summary: string };

export async function runProvision(payload: unknown, step: StepRunner, ports: ProvisionerPorts): Promise<ProvisionRunResult> {
  const parsed = ProvisionCommandSchema.safeParse(payload);
  if (!parsed.success) {
    // Outside any step, so never retried; there is no commandId to report against.
    throw new ProvisionFailedError(`invalid ProvisionCommand: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  const cmd = parsed.data;

  let work: Work;
  try {
    work = await step.do(cmd.op === "FORK" ? "fork" : "delete", PROVISION_STEP, async (): Promise<Work> => {
      try {
        if (cmd.op === "FORK") {
          const r = await ports.artifacts.forkTrain(cmd.sourceRepo, cmd.forkName);
          return { ok: true, artifactRepo: r.artifactRepo, baseSha: r.baseSha, summary: `Forked ${cmd.sourceRepo} to ${r.artifactRepo} at ${r.baseSha.slice(0, 12)}.` };
        }
        const existed = await ports.artifacts.deleteRepo(cmd.repo);
        return { ok: true, summary: existed ? `Deleted ${cmd.repo}.` : `${cmd.repo} was already gone.` };
      } catch (e) {
        throw toStepError(e);
      }
    });
  } catch (e) {
    work = { ok: false, summary: clip(`${cmd.op === "FORK" ? "Fork" : "Delete"} failed: ${messageOf(e)}`) };
  }

  const result: ProvisionResult = {
    commandId: cmd.commandId,
    op: cmd.op,
    trainId: cmd.trainId,
    ok: work.ok,
    ...(work.ok && work.artifactRepo ? { artifactRepo: work.artifactRepo } : {}),
    ...(work.ok && work.baseSha ? { baseSha: work.baseSha } : {}),
    summary: clip(work.summary),
  };

  const queenOutcome = await step.do("report: provision result", REPORT_STEP, async () => {
    try {
      const r = (await ports.queen(cmd.hive).reportProvisionResult(result)) as { outcome?: unknown } | null | undefined;
      return String(r?.outcome ?? "reported");
    } catch (e) {
      if (!isPermanentQueenError(e)) throw e;
      return `rejected: ${clip(messageOf(e), 200)}`;
    }
  });

  return { commandId: cmd.commandId, op: cmd.op, ok: work.ok, summary: result.summary ?? "", queenOutcome };
}

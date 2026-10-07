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
import {
  ProvisionCommandSchema,
  type HiveCreatedResult,
  type ProvisionCommand,
  type ProvisionResult,
  type RecalledMemory,
} from "@queenos/queen-types";
import { errorCode, SEED_TRAILER, type ProvisionerPorts } from "./ports";
import { TEMPLATES } from "./templates.generated";

export interface StepRunner {
  do<T>(name: string, config: WorkflowStepConfig, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

export const PROVISION_STEP: WorkflowStepConfig = { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "3 minutes" };
export const REPORT_STEP: WorkflowStepConfig = { retries: { limit: 5, delay: "2 seconds", backoff: "exponential" }, timeout: "30 seconds" };

/** Best effort: one retry, short timeout; the caller turns a final failure into []. */
export const RECALL_STEP: WorkflowStepConfig = { retries: { limit: 1, delay: "2 seconds", backoff: "constant" }, timeout: "30 seconds" };

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

  // Log trace context if present
  if (cmd.trace) {
    const traceparentParts = cmd.trace.traceparent.split("-");
    console.log(
      JSON.stringify({
        trace_id: traceparentParts[1],
        span_id: traceparentParts[2],
        hive: cmd.hive,
        command_id: cmd.commandId,
        step: "provisioner_start",
        op: cmd.op,
      })
    );
  }

  if (cmd.op === "CREATE_HIVE") return runCreateHive(cmd, step, ports);

  let work: Work;
  try {
    const stepName = cmd.op === "FORK" ? "fork" : cmd.op === "DELETE" ? "delete" : "note";
    work = await step.do(stepName, PROVISION_STEP, async (): Promise<Work> => {
      try {
        switch (cmd.op) {
          case "FORK": {
            const r = await ports.artifacts.forkTrain(cmd.sourceRepo, cmd.forkName);
            return { ok: true, artifactRepo: r.artifactRepo, baseSha: r.baseSha, summary: `Forked ${cmd.sourceRepo} to ${r.artifactRepo} at ${r.baseSha.slice(0, 12)}.` };
          }
          case "DELETE": {
            const existed = await ports.artifacts.deleteRepo(cmd.repo);
            return { ok: true, summary: existed ? `Deleted ${cmd.repo}.` : `${cmd.repo} was already gone.` };
          }
          case "NOTE":
            // Non-destructive until a real implementation lands.
            return { ok: false, summary: "NOTE not supported by this provisioner yet" };
          default: {
            const unhandled: never = cmd;
            throw new NonRetryableError(`INVALID_INPUT: unhandled provision op ${JSON.stringify(unhandled)}`);
          }
        }
      } catch (e) {
        throw toStepError(e);
      }
    });
  } catch (e) {
    const label = cmd.op === "FORK" ? "Fork" : cmd.op === "DELETE" ? "Delete" : "Note";
    work = { ok: false, summary: clip(`${label} failed: ${messageOf(e)}`) };
  }

  // Best effort, after the fork succeeded: any failure is [] and never fails the fork.
  let memories: RecalledMemory[] | undefined;
  if (cmd.op === "FORK" && work.ok && cmd.recallQuery?.trim()) {
    const { hive, trainId, recallQuery } = cmd;
    try {
      memories = await step.do("memory: recall", RECALL_STEP, () => ports.recall.recall(hive, recallQuery, { excludeTrainId: trainId }));
    } catch (e) {
      console.warn(`memory recall failed for ${hive}: ${messageOf(e)}`);
      memories = [];
    }
  }

  const result: ProvisionResult = {
    commandId: cmd.commandId,
    op: cmd.op,
    trainId: cmd.trainId,
    ok: work.ok,
    ...(work.ok && work.artifactRepo ? { artifactRepo: work.artifactRepo } : {}),
    ...(work.ok && work.baseSha ? { baseSha: work.baseSha } : {}),
    ...(memories ? { memories } : {}),
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

  // Log trace context for result if present
  if (cmd.trace) {
    const traceparentParts = cmd.trace.traceparent.split("-");
    console.log(
      JSON.stringify({
        trace_id: traceparentParts[1],
        span_id: traceparentParts[2],
        hive: cmd.hive,
        command_id: cmd.commandId,
        step: "provisioner_result",
        op: cmd.op,
        outcome: work.ok ? "ok" : "fail",
        ms: 0, // timing collected by Workflows
      })
    );
  }

  return { commandId: cmd.commandId, op: cmd.op, ok: work.ok, summary: result.summary ?? "", queenOutcome };
}

// ── CREATE_HIVE ──────────────────────────────────────────────────────────

const SEED_IDENTITY = { name: "QueenOS Genesis", email: "genesis@queenos.dev" };

/** Reported to Genesis, never to the Queen. Genesis RPC errors that mean "do not retry". */
function isPermanentGenesisError(e: unknown): boolean {
  return /^(INVALID_INPUT|NOT_FOUND|CONFLICT): /.test(messageOf(e));
}

/** The seed commit message. The trailer makes a retried or re-dispatched command find its own work. */
export function seedMessage(commandId: string): string {
  return `Seed hive from worker-starter\n\n${SEED_TRAILER}: ${commandId}\n`;
}

/**
 * CREATE_HIVE: create the repo (ALREADY_EXISTS is success), write the template
 * plus .queen/charter.json, commit on main with a step-fixed timestamp, push,
 * and report to Genesis. A repo whose main already carries a seed commit is
 * reported as is, so retries and re-launches converge.
 */
async function runCreateHive(
  cmd: Extract<ProvisionCommand, { op: "CREATE_HIVE" }>,
  step: StepRunner,
  ports: ProvisionerPorts,
): Promise<ProvisionRunResult> {
  let work: { ok: true; mainSha: string; summary: string } | { ok: false; summary: string };
  try {
    const files = TEMPLATES[cmd.template];
    if (!files) throw new NonRetryableError(`INVALID_INPUT: unknown template ${cmd.template}`);
    let charterPretty: string;
    try {
      charterPretty = `${JSON.stringify(JSON.parse(cmd.charterJson), null, 2)}\n`;
    } catch {
      throw new NonRetryableError("INVALID_INPUT: charterJson is not valid JSON");
    }

    await step.do("create repo", PROVISION_STEP, async () => {
      try {
        await ports.artifacts.ensureRepo(cmd.hive);
        return true;
      } catch (e) {
        throw toStepError(e);
      }
    });
    // Fixed once so a retried seed step rebuilds the identical commit.
    const timestamp = await step.do("seed timestamp", PROVISION_STEP, async () => Math.floor(Date.now() / 1000));
    const mainSha = await step.do("seed main", PROVISION_STEP, async () => {
      try {
        const existing = await ports.artifacts.findSeed(cmd.hive);
        if (existing) return existing;
        const access = await ports.artifacts.access(cmd.hive, "write");
        const repo = await ports.git.init({ url: access.remote, token: access.token });
        await repo.writeFiles([
          ...Object.entries(files).map(([path, content]) => ({ path, content })),
          { path: ".queen/charter.json", content: charterPretty },
        ]);
        const oid = await repo.commitAll({
          message: seedMessage(cmd.commandId),
          timestamp,
          author: SEED_IDENTITY,
          committer: SEED_IDENTITY,
        });
        await repo.push({ ref: "main" });
        return oid;
      } catch (e) {
        throw toStepError(e);
      }
    });
    work = { ok: true, mainSha, summary: `Seeded ${cmd.hive} from ${cmd.template} at ${mainSha.slice(0, 12)}.` };
  } catch (e) {
    work = { ok: false, summary: clip(`Create hive failed: ${messageOf(e)}`) };
  }

  const result: HiveCreatedResult = {
    commandId: cmd.commandId,
    hive: cmd.hive,
    ok: work.ok,
    ...(work.ok ? { mainSha: work.mainSha } : {}),
    summary: clip(work.summary),
  };
  const outcome = await step.do("report: hive created", REPORT_STEP, async () => {
    try {
      const r = (await ports.genesis(cmd.hive).reportHiveCreated(result)) as { outcome?: unknown } | null | undefined;
      return String(r?.outcome ?? "reported");
    } catch (e) {
      if (!isPermanentGenesisError(e)) throw e;
      return `rejected: ${clip(messageOf(e), 200)}`;
    }
  });
  return { commandId: cmd.commandId, op: cmd.op, ok: work.ok, summary: result.summary ?? "", queenOutcome: outcome };
}

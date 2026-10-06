/**
 * Executor dispatch. The Queen performs no external I/O: it persists a
 * command (its id is stored on the train / release / item row first), then
 * starts an executor Workflow whose instance id IS the command id.
 * Re-dispatching the same command is therefore a no-op, and executors report
 * back over DO RPC (`reportProvisionResult` / `reportDeployResult` / ...).
 *
 * - PROVISIONER: `ProvisionerWorkflow` in apps/provisioner (Artifacts fork / delete).
 * - HERALD: `HeraldWorkflow` in apps/herald (preview deploy / teardown; staging,
 *   canary and rollback for the release train).
 * - SENTINEL: `SentinelWorkflow` in apps/sentinel (health verdicts for staging
 *   and each canary step; reports back with `reportSentinelVerdict`).
 * - ORACLE: `OracleWorkflow` in apps/oracle (DECOMPOSE / TRIAGE; reports back
 *   with `reportOracleResult`).
 *
 * v2 (§4.3, item 3): a decision may issue dozens of commands of one kind (a
 * fan-out of FORKs). `dispatchMany` groups them into Workflows `createBatch`
 * calls of at most 100 instances; `createBatch` skips ids already in use, so
 * a re-dispatch stays idempotent. Any batch error falls back to one-by-one
 * dispatch (which treats an existing instance as success).
 */
import type { DeployCommand, OracleCommand, ProvisionCommand, SentinelCommand } from "@queenos/queen-types";
import { QueenError } from "./errors";

/** Workflows `createBatch` takes at most this many instances per call. */
export const MAX_BATCH = 100;

export interface CommandDispatcher<C extends { commandId: string }> {
  /** Start the executor for `command`. Idempotent per commandId. */
  dispatch(command: C): Promise<{ instanceId: string }>;
  /**
   * Start several (optional; the Queen falls back to `dispatch` per command).
   * Returns the command ids that failed to start.
   */
  dispatchMany?(commands: readonly C[]): Promise<{ failed: string[] }>;
}

/** Forks and deletes train repos (Provisioner Workflow). */
export type ProvisionerDispatcher = CommandDispatcher<ProvisionCommand>;
/** Deploys and tears down environments (Herald Workflow). */
export type DeployDispatcher = CommandDispatcher<DeployCommand>;
/** Judges release health (Sentinel Workflow). */
export type SentinelDispatcher = CommandDispatcher<SentinelCommand>;
/** Decomposes goals and triages auto-filed items (Oracle Workflow). */
export type OracleDispatcher = CommandDispatcher<OracleCommand>;

/** Start one instance; an instance that already exists counts as success. */
export async function createOrExisting(workflow: Workflow, id: string, params: unknown): Promise<void> {
  try {
    await workflow.create({ id, params });
  } catch (e) {
    // Already created by an earlier dispatch? Then this dispatch succeeded.
    try {
      await workflow.get(id);
    } catch {
      throw e;
    }
  }
}

/**
 * Start many instances with `createBatch` (≤ MAX_BATCH per call). A failed
 * batch is retried one instance at a time. Returns the ids that did not start.
 */
export async function createMany(workflow: Workflow, instances: readonly { id: string; params: unknown }[]): Promise<{ failed: string[] }> {
  const failed: string[] = [];
  for (let i = 0; i < instances.length; i += MAX_BATCH) {
    const chunk = instances.slice(i, i + MAX_BATCH);
    try {
      if (chunk.length === 1 || typeof workflow.createBatch !== "function") throw new Error("single");
      await workflow.createBatch(chunk.map((c) => ({ id: c.id, params: c.params })));
    } catch {
      for (const c of chunk) {
        try {
          await createOrExisting(workflow, c.id, c.params);
        } catch (e) {
          console.error(`queen: could not start workflow instance ${c.id}`, e);
          failed.push(c.id);
        }
      }
    }
  }
  return { failed };
}

/** Starts a Workflow instance with `id = params.commandId`; an existing instance counts as success. */
export class WorkflowCommandDispatcher<C extends { commandId: string }> implements CommandDispatcher<C> {
  constructor(
    private readonly workflow: Workflow | undefined,
    private readonly bindingName: string,
  ) {}

  async dispatch(command: C): Promise<{ instanceId: string }> {
    if (!this.workflow) throw new QueenError("UNAVAILABLE", `${this.bindingName} workflow binding is not configured`);
    await createOrExisting(this.workflow, command.commandId, command);
    return { instanceId: command.commandId };
  }

  async dispatchMany(commands: readonly C[]): Promise<{ failed: string[] }> {
    if (!this.workflow) throw new QueenError("UNAVAILABLE", `${this.bindingName} workflow binding is not configured`);
    return createMany(
      this.workflow,
      commands.map((c) => ({ id: c.commandId, params: c })),
    );
  }
}

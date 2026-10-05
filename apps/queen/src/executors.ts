/**
 * Executor dispatch. The Queen performs no external I/O: it persists a
 * command (its id is stored on the train row first), then starts an executor
 * Workflow whose instance id IS the command id. Re-dispatching the same
 * command is therefore a no-op, and executors report back over DO RPC
 * (`reportProvisionResult` / `reportDeployResult`).
 *
 * - PROVISIONER: `ProvisionerWorkflow` in apps/provisioner (Artifacts fork / delete).
 * - HERALD: `HeraldWorkflow` in apps/herald (preview deploy / teardown; staging,
 *   canary and rollback for the release train).
 * - SENTINEL: `SentinelWorkflow` in apps/sentinel (health verdicts for staging
 *   and each canary step; reports back with `reportSentinelVerdict`).
 */
import type { DeployCommand, ProvisionCommand, SentinelCommand } from "@queenos/queen-types";
import { QueenError } from "./errors";

export interface CommandDispatcher<C extends { commandId: string }> {
  /** Start the executor for `command`. Idempotent per commandId. */
  dispatch(command: C): Promise<{ instanceId: string }>;
}

/** Forks and deletes train repos (Provisioner Workflow). */
export type ProvisionerDispatcher = CommandDispatcher<ProvisionCommand>;
/** Deploys and tears down environments (Herald Workflow). */
export type DeployDispatcher = CommandDispatcher<DeployCommand>;
/** Judges release health (Sentinel Workflow). */
export type SentinelDispatcher = CommandDispatcher<SentinelCommand>;

/** Starts a Workflow instance with `id = params.commandId`; an existing instance counts as success. */
export class WorkflowCommandDispatcher<C extends { commandId: string }> implements CommandDispatcher<C> {
  constructor(
    private readonly workflow: Workflow | undefined,
    private readonly bindingName: string,
  ) {}

  async dispatch(command: C): Promise<{ instanceId: string }> {
    if (!this.workflow) throw new QueenError("UNAVAILABLE", `${this.bindingName} workflow binding is not configured`);
    const id = command.commandId;
    try {
      await this.workflow.create({ id, params: command });
    } catch (e) {
      // Already created by an earlier dispatch? Then this dispatch succeeded.
      try {
        await this.workflow.get(id);
      } catch {
        throw e;
      }
    }
    return { instanceId: id };
  }
}

import type { DeployCommand, DroneTask, OracleCommand, ProvisionCommand, SentinelCommand } from "@queenos/queen-types";
import { droneInstanceId, type DroneDispatcher } from "../src/drones";
import type { CommandDispatcher } from "../src/executors";

/** Records every dispatched executor command; results are reported by the test. */
export class RecordingCommands<C extends { commandId: string }> implements CommandDispatcher<C> {
  readonly commands: C[] = [];
  /** Throw on the next N dispatches (exercises the reconcile alarm). */
  failNext = 0;
  /** Number of dispatchMany calls (createBatch analogue). */
  batches = 0;

  async dispatch(command: C): Promise<{ instanceId: string }> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("UNAVAILABLE: fake executor is down");
    }
    this.commands.push(command);
    return { instanceId: command.commandId };
  }

  async dispatchMany(commands: readonly C[]): Promise<{ failed: string[] }> {
    this.batches++;
    const failed: string[] = [];
    for (const c of commands) {
      try {
        await this.dispatch(c);
      } catch {
        failed.push(c.commandId);
      }
    }
    return { failed };
  }
}

export class RecordingProvisioner extends RecordingCommands<ProvisionCommand> {}
export class RecordingHerald extends RecordingCommands<DeployCommand> {}
export class RecordingSentinel extends RecordingCommands<SentinelCommand> {}
export class RecordingOracle extends RecordingCommands<OracleCommand> {}

export class RecordingDispatcher implements DroneDispatcher {
  readonly tasks: DroneTask[] = [];
  /** Workflow instance ids, in dispatch order (attempts > 1 carry a suffix). */
  readonly instanceIds: string[] = [];
  /** Throw on the next N dispatches (a Workflows create that fails, e.g. a 503). */
  failNext = 0;

  async dispatch(task: DroneTask, attempt?: number): Promise<{ instanceId: string }> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("UNAVAILABLE: fake Workflows create failed");
    }
    this.tasks.push(task);
    const instanceId = droneInstanceId(task, attempt);
    this.instanceIds.push(instanceId);
    return { instanceId };
  }
}

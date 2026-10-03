import type { DeployCommand, DroneTask, ProvisionCommand } from "@queenos/queen-types";
import { droneInstanceId, type DroneDispatcher } from "../src/drones";
import type { CommandDispatcher } from "../src/executors";

/** Records every dispatched executor command; results are reported by the test. */
export class RecordingCommands<C extends { commandId: string }> implements CommandDispatcher<C> {
  readonly commands: C[] = [];
  /** Throw on the next N dispatches (exercises the reconcile alarm). */
  failNext = 0;

  async dispatch(command: C): Promise<{ instanceId: string }> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("UNAVAILABLE: fake executor is down");
    }
    this.commands.push(command);
    return { instanceId: command.commandId };
  }
}

export class RecordingProvisioner extends RecordingCommands<ProvisionCommand> {}
export class RecordingHerald extends RecordingCommands<DeployCommand> {}

export class RecordingDispatcher implements DroneDispatcher {
  readonly tasks: DroneTask[] = [];
  /** Workflow instance ids, in dispatch order (attempts > 1 carry a suffix). */
  readonly instanceIds: string[] = [];

  async dispatch(task: DroneTask, attempt?: number): Promise<{ instanceId: string }> {
    this.tasks.push(task);
    const instanceId = droneInstanceId(task, attempt);
    this.instanceIds.push(instanceId);
    return { instanceId };
  }
}

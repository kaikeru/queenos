/**
 * Drone dispatch. Drones are the `DroneWorkflow` in apps/drones, reached
 * through the cross-script Workflow binding `DRONES` (wrangler.jsonc).
 */
import type { DroneTask } from "@queenos/queen-types";
import { QueenError } from "./errors";

export interface DroneDispatcher {
  /** Start a drone. Idempotent per (train, action): re-dispatching is a no-op. */
  dispatch(task: DroneTask): Promise<{ instanceId: string }>;
}

/** Deterministic Workflow instance id, so a retried dispatch cannot double-start a drone. */
export function droneInstanceId(task: DroneTask): string {
  return `${task.trainId}-${task.action.toLowerCase()}`;
}

export class WorkflowDroneDispatcher implements DroneDispatcher {
  constructor(private readonly workflow: Workflow | undefined) {}

  async dispatch(task: DroneTask): Promise<{ instanceId: string }> {
    if (!this.workflow) throw new QueenError("UNAVAILABLE", "DRONES workflow binding is not configured");
    const id = droneInstanceId(task);
    try {
      await this.workflow.create({ id, params: task });
    } catch (e) {
      // Already created by an earlier attempt? Then the dispatch succeeded.
      try {
        await this.workflow.get(id);
      } catch {
        throw e;
      }
    }
    return { instanceId: id };
  }
}

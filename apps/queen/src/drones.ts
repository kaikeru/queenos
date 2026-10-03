/**
 * Drone dispatch. Drones are the `DroneWorkflow` in apps/drones, reached
 * through the cross-script Workflow binding `DRONES` (wrangler.jsonc).
 */
import type { DroneTask } from "@queenos/queen-types";
import { QueenError } from "./errors";

export interface DroneDispatcher {
  /**
   * Start a drone. Idempotent per (train, action, attempt): re-dispatching is
   * a no-op. A new `attempt` (the Queen watchdog) starts a new instance.
   */
  dispatch(task: DroneTask, attempt?: number): Promise<{ instanceId: string }>;
}

/**
 * Deterministic Workflow instance id, so a retried dispatch cannot double-start
 * a drone: `<trainId>-<action>`, plus `-<attempt>` from the second attempt on.
 */
export function droneInstanceId(task: DroneTask, attempt = 1): string {
  const base = `${task.trainId}-${task.action.toLowerCase()}`;
  return attempt > 1 ? `${base}-${attempt}` : base;
}

export class WorkflowDroneDispatcher implements DroneDispatcher {
  constructor(private readonly workflow: Workflow | undefined) {}

  async dispatch(task: DroneTask, attempt = 1): Promise<{ instanceId: string }> {
    if (!this.workflow) throw new QueenError("UNAVAILABLE", "DRONES workflow binding is not configured");
    const id = droneInstanceId(task, attempt);
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

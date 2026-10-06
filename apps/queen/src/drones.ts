/**
 * Drone dispatch. Drones are the `DroneWorkflow` in apps/drones, reached
 * through the cross-script Workflow binding `DRONES` (wrangler.jsonc).
 * BUILD / REWORK (builder), MERGE (a merge-queue car) and LAND (the lander).
 */
import type { DroneTask } from "@queenos/queen-types";
import { QueenError } from "./errors";
import { createMany, createOrExisting } from "./executors";

export interface DroneDispatcher {
  /**
   * Start a drone. Idempotent per (train, action, attempt): re-dispatching is
   * a no-op. A new `attempt` (the Queen watchdog) starts a new instance.
   */
  dispatch(task: DroneTask, attempt?: number): Promise<{ instanceId: string }>;
  /** Start several in `createBatch` calls (optional). Returns the instance ids that did not start. */
  dispatchMany?(tasks: readonly { task: DroneTask; attempt: number }[]): Promise<{ failed: string[] }>;
}

/**
 * Deterministic Workflow instance id, so a retried dispatch cannot double-start
 * a drone: `<trainId>-<action>`, plus `-<attempt>` from the second attempt on.
 */
export function droneInstanceId(task: Pick<DroneTask, "trainId" | "action">, attempt = 1): string {
  const base = `${task.trainId}-${task.action.toLowerCase()}`;
  return attempt > 1 ? `${base}-${attempt}` : base;
}

export class WorkflowDroneDispatcher implements DroneDispatcher {
  constructor(private readonly workflow: Workflow | undefined) {}

  async dispatch(task: DroneTask, attempt = 1): Promise<{ instanceId: string }> {
    if (!this.workflow) throw new QueenError("UNAVAILABLE", "DRONES workflow binding is not configured");
    const id = droneInstanceId(task, attempt);
    await createOrExisting(this.workflow, id, task);
    return { instanceId: id };
  }

  async dispatchMany(tasks: readonly { task: DroneTask; attempt: number }[]): Promise<{ failed: string[] }> {
    if (!this.workflow) throw new QueenError("UNAVAILABLE", "DRONES workflow binding is not configured");
    return createMany(
      this.workflow,
      tasks.map((t) => ({ id: droneInstanceId(t.task, t.attempt), params: t.task })),
    );
  }
}

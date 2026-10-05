import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { DroneTask } from "@queenos/queen-types";
import { readConfig, type DroneConfig } from "./config";
import { runDrone, type DroneRunResult, type StepRunner } from "./orchestrate";
import { createProdPorts, type DronePorts } from "./ports";

/** Adapt the Workflows step API to the minimal StepRunner used by runDrone. */
export function stepRunner(step: WorkflowStep): StepRunner {
  return {
    // Step results are plain JSON-ish objects; the Serializable constraint is checked at runtime.
    do: <T>(name: string, config: Parameters<StepRunner["do"]>[1], fn: () => Promise<T>) =>
      (step.do as unknown as (n: string, c: typeof config, f: () => Promise<T>) => Promise<T>)(name, config, fn),
    sleep: (name, ms) => step.sleep(name, ms),
  };
}

/**
 * A QueenOS drone: one Workflow instance per (train, action), started by the
 * Queen through its cross-script `DRONES` binding (instance id
 * `<trainId>-<action>`).
 */
export class DroneWorkflow extends WorkflowEntrypoint<Env, DroneTask> {
  /** Seam for tests: override to inject fake Artifacts / git / Queen / LLM ports. */
  protected createPorts(env: Env, config: DroneConfig): DronePorts {
    return createProdPorts(env, config);
  }

  override async run(event: Readonly<WorkflowEvent<DroneTask>>, step: WorkflowStep): Promise<DroneRunResult> {
    const config = readConfig(this.env);
    return runDrone(event.payload, stepRunner(step), this.createPorts(this.env, config), config, { instanceId: event.instanceId });
  }
}

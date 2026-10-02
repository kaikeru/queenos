import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { ProvisionCommand } from "@queenos/queen-types";
import { runProvision, type ProvisionRunResult, type StepRunner } from "./orchestrate";
import { createProdPorts, type ProvisionerPorts } from "./ports";

/** Adapt the Workflows step API to the minimal StepRunner used by runProvision. */
export function stepRunner(step: WorkflowStep): StepRunner {
  return {
    // Step results are plain JSON-ish objects; the Serializable constraint is checked at runtime.
    do: <T>(name: string, config: Parameters<StepRunner["do"]>[1], fn: () => Promise<T>) =>
      (step.do as unknown as (n: string, c: typeof config, f: () => Promise<T>) => Promise<T>)(name, config, fn),
    sleep: (name, ms) => step.sleep(name, ms),
  };
}

/**
 * Executes Queen commands that touch Artifacts (fork / delete a train repo).
 * One instance per command, id = commandId, params = the ProvisionCommand.
 */
export class ProvisionerWorkflow extends WorkflowEntrypoint<Env, ProvisionCommand> {
  /** Seam for tests: override to inject fake Artifacts / Queen ports. */
  protected createPorts(env: Env): ProvisionerPorts {
    return createProdPorts(env);
  }

  override async run(event: Readonly<WorkflowEvent<ProvisionCommand>>, step: WorkflowStep): Promise<ProvisionRunResult> {
    return runProvision(event.payload, stepRunner(step), this.createPorts(this.env));
  }
}

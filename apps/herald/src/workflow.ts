import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { DeployCommand } from "@queenos/queen-types";
import { runHerald, type HeraldRunResult, type StepRunner } from "./orchestrate";
import { createProdPorts, type HeraldPorts } from "./ports";

/** Adapt the Workflows step API to the minimal StepRunner used by runHerald. */
export function stepRunner(step: WorkflowStep): StepRunner {
  return {
    // Step results are plain JSON-ish objects; the Serializable constraint is checked at runtime.
    do: <T>(name: string, config: Parameters<StepRunner["do"]>[1], fn: () => Promise<T>) =>
      (step.do as unknown as (n: string, c: typeof config, f: () => Promise<T>) => Promise<T>)(name, config, fn),
    sleep: (name, ms) => step.sleep(name, ms),
  };
}

/**
 * Executes Queen deploy commands. One instance per command, id = commandId,
 * params = the DeployCommand. P1 implements preview DEPLOY / TEARDOWN.
 */
export class HeraldWorkflow extends WorkflowEntrypoint<Env, DeployCommand> {
  /** Seam for tests: override to inject fake Artifacts / git / Cloudflare / Queen ports. */
  protected createPorts(env: Env): HeraldPorts {
    return createProdPorts(env);
  }

  override async run(event: Readonly<WorkflowEvent<DeployCommand>>, step: WorkflowStep): Promise<HeraldRunResult> {
    return runHerald(event.payload, stepRunner(step), this.createPorts(this.env));
  }
}

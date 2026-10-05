import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { OracleCommand } from "@queenos/queen-types";
import { runOracle, type OracleRunResult, type StepRunner } from "./orchestrate";
import { createProdPorts, type OraclePorts } from "./ports";

/** Adapt the Workflows step API to the minimal StepRunner used by runOracle. */
export function stepRunner(step: WorkflowStep): StepRunner {
  return {
    // Step results are plain JSON-ish objects; the Serializable constraint is checked at runtime.
    do: <T>(name: string, config: Parameters<StepRunner["do"]>[1], fn: () => Promise<T>) =>
      (step.do as unknown as (n: string, c: typeof config, f: () => Promise<T>) => Promise<T>)(name, config, fn),
  };
}

/**
 * Executes Queen Oracle commands (DECOMPOSE / TRIAGE). One instance per
 * command, id = commandId, params = the OracleCommand.
 */
export class OracleWorkflow extends WorkflowEntrypoint<Env, OracleCommand> {
  /** Seam for tests: override to inject fake ports. */
  protected createPorts(env: Env): OraclePorts {
    return createProdPorts(env);
  }

  override async run(event: Readonly<WorkflowEvent<OracleCommand>>, step: WorkflowStep): Promise<OracleRunResult> {
    return runOracle(event.payload, stepRunner(step), this.createPorts(this.env));
  }
}

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { SentinelCommand } from "@queenos/queen-types";
import { runSentinel, type SentinelRunResult, type StepRunner } from "./orchestrate";
import { createProdPorts, type SentinelPorts } from "./ports";

/** Adapt the Workflows step API to the minimal StepRunner used by runSentinel. */
export function stepRunner(step: WorkflowStep): StepRunner {
  return {
    do: <T>(name: string, config: Parameters<StepRunner["do"]>[1], fn: () => Promise<T>) =>
      (step.do as unknown as (n: string, c: typeof config, f: () => Promise<T>) => Promise<T>)(name, config, fn),
    sleep: (name, ms) => step.sleep(name, ms),
  };
}

/** Health verdicts. One instance per command, id = commandId, params = the SentinelCommand. */
export class SentinelWorkflow extends WorkflowEntrypoint<Env, SentinelCommand> {
  /** Seam for tests: override to inject a fake fetch / Queen. */
  protected createPorts(env: Env): SentinelPorts {
    return createProdPorts(env);
  }

  override async run(event: Readonly<WorkflowEvent<SentinelCommand>>, step: WorkflowStep): Promise<SentinelRunResult> {
    return runSentinel(event.payload, stepRunner(step), this.createPorts(this.env));
  }
}

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { readConfig, type GateConfig } from "./config";
import { GateTaskSchema } from "./event";
import { handlePush, runGate, type GateRunResult, type PushRunResult, type StepRunner } from "./orchestrate";
import { createProdPorts, type GatekeeperPorts } from "./ports";

/** Adapt the Workflows step API to the minimal StepRunner used by the orchestrator. */
export function stepRunner(step: WorkflowStep): StepRunner {
  return {
    do: <T>(name: string, config: Parameters<StepRunner["do"]>[1], fn: () => Promise<T>) =>
      (step.do as unknown as (n: string, c: typeof config, f: () => Promise<T>) => Promise<T>)(name, config, fn),
    sleep: (name, ms) => step.sleep(name, ms),
  };
}

/**
 * Target of the `cf.artifacts.repo.pushed` trigger (wrangler `triggers.events`).
 * The trigger starts an instance with the event as payload; that instance
 * filters and dispatches a deterministic per-(repo, after) instance of this
 * same class, whose payload is a GateTask.
 */
export class GatekeeperWorkflow extends WorkflowEntrypoint<Env, unknown> {
  /** Seam for tests: override to inject fake ports. */
  protected createPorts(env: Env, config: GateConfig): GatekeeperPorts {
    return createProdPorts(env, config);
  }

  override async run(event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<GateRunResult | PushRunResult> {
    const config = readConfig(this.env);
    const ports = this.createPorts(this.env, config);
    const gate = GateTaskSchema.safeParse(event.payload);
    if (gate.success) return runGate(gate.data, stepRunner(step), ports, config);
    return handlePush(event.payload, stepRunner(step), ports, config);
  }
}

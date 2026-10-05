/**
 * queenos-oracle (v2 design §3.3): hosts the OracleWorkflow. The Queen starts
 * one instance per OracleCommand (DECOMPOSE / TRIAGE; id = commandId) through
 * its cross-script Workflow binding, and receives the OracleResult over DO RPC
 * (QUEEN binding, script "queen", `reportOracleResult`).
 *
 * WP0 scaffold: WP1.5 implements runOracle (StepRunner + ports seam, like
 * apps/provisioner/src/orchestrate.ts).
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { OracleCommand, OracleResult } from "@queenos/queen-types";

export class OracleWorkflow extends WorkflowEntrypoint<Env, OracleCommand> {
  override async run(event: Readonly<WorkflowEvent<OracleCommand>>, step: WorkflowStep): Promise<OracleResult> {
    void event;
    void step;
    throw new Error("not implemented");
  }
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/health") return Response.json({ ok: true, service: "oracle" });
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

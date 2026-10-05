/**
 * queenos-oracle (v2 design §3.3): hosts the OracleWorkflow. The Queen starts
 * one instance per OracleCommand (DECOMPOSE / TRIAGE; id = commandId) through
 * its cross-script Workflow binding, and receives the OracleResult over DO RPC
 * (QUEEN binding, script "queen", `reportOracleResult`).
 */
export { OracleWorkflow } from "./workflow";

export default {
  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/health") return Response.json({ ok: true, service: "oracle" });
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

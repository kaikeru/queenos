/**
 * queenos-sentinel: hosts the SentinelWorkflow. The Queen starts instances
 * through its cross-script Workflow binding and receives verdicts over DO RPC
 * (QUEEN binding, script "queen").
 */
export { SentinelWorkflow } from "./workflow";

export default {
  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/health") return Response.json({ ok: true, service: "sentinel" });
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * queenos-herald: hosts the HeraldWorkflow. The Queen starts instances through
 * its cross-script Workflow binding and receives results over DO RPC (QUEEN
 * binding, script "queen").
 */
export { HeraldWorkflow } from "./workflow";

export default {
  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/health") return Response.json({ ok: true, service: "herald" });
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

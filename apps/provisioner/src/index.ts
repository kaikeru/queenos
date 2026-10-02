/**
 * queenos-provisioner: hosts the ProvisionerWorkflow. The Queen starts
 * instances through its cross-script Workflow binding and receives results over
 * DO RPC (QUEEN binding, script "queen").
 */
export { ProvisionerWorkflow } from "./workflow";

export default {
  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/health") return Response.json({ ok: true, service: "provisioner" });
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

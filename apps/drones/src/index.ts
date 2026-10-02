/**
 * queenos-drones: hosts the DroneWorkflow. The Queen starts instances through
 * its cross-script Workflow binding; drones report back over DO RPC to the
 * Queen's QueenNode (binding QUEEN, script "queen").
 */
import { readConfig } from "./config";

export { DroneWorkflow } from "./workflow";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      let mode: string;
      try {
        mode = readConfig(env).llmMode;
      } catch (e) {
        return Response.json({ ok: false, service: "drones", error: (e as Error).message }, { status: 500 });
      }
      return Response.json({ ok: true, service: "drones", llmMode: mode });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

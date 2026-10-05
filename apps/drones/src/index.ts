/**
 * queenos-drones: hosts the DroneWorkflow. The Queen starts instances through
 * its cross-script Workflow binding; drones report back over DO RPC to the
 * Queen's QueenNode (binding QUEEN, script "queen").
 */
import { readConfig } from "./config";

export { DroneWorkflow } from "./workflow";
export { BuilderAgent } from "./agent/builder-agent";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      let config: ReturnType<typeof readConfig>;
      try {
        config = readConfig(env);
      } catch (e) {
        return Response.json({ ok: false, service: "drones", error: (e as Error).message }, { status: 500 });
      }
      return Response.json({ ok: true, service: "drones", llmMode: config.llmMode, harness: config.harness });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

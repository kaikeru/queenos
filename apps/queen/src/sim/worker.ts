/**
 * Simulation entrypoint (`wrangler dev --env sim`). Same Worker and Durable
 * Object as production, but createPorts() returns a fake Provisioner, Herald
 * and drones that auto-advance the merge train. See sim-ports.ts.
 *
 * This file is only referenced by wrangler.jsonc env.sim.main; the default
 * bundle (src/index.ts) never imports it.
 */
import { QueenNode as ProdQueenNode, type QueenPorts } from "../queen-node";
import { SimExecutors } from "./sim-ports";

import app from "../index";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * env.sim shares the production Worker name (for the local dev registry) and disables
 * internal auth, so an accidental `wrangler deploy --env sim` must refuse real traffic.
 */
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (!LOCAL_HOSTS.has(new URL(request.url).hostname)) {
      return Response.json({ error: "sim mode is localhost-only" }, { status: 403 });
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

export class QueenNode extends ProdQueenNode {
  // `declare`: no field initializer. createPorts() runs inside the base constructor,
  // and an initialized field would be reset to undefined right after super() returns.
  private declare sim: SimExecutors | undefined;

  protected override createPorts(): QueenPorts {
    // Called from the base constructor: `this.ctx` is set, subclass fields are not.
    const sim = new SimExecutors(() => this, this.ctx.storage);
    this.sim = sim;
    return { provisioner: sim.provisioner, herald: sim.herald, dispatcher: sim.drones };
  }

  /** Simulated executors run off the DO alarm (hibernation-safe); then normal reconcile. */
  override async alarm(): Promise<void> {
    await this.sim?.runDue();
    await super.alarm();
  }
}

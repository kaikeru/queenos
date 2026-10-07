/**
 * Simulation entrypoint (`wrangler dev --env sim`). Same Worker and Durable
 * Objects as production, but createPorts() returns a fake Provisioner, Herald,
 * Sentinel, Oracle and drones (including the MERGE drone) that auto-advance
 * the work ledger, the merge queue and the release train. See sim-ports.ts.
 * The real SwarmGovernor DO runs with the sim ceilings (wrangler env.sim vars).
 *
 * This file is only referenced by wrangler.jsonc env.sim.main; the default
 * bundle (src/index.ts) never imports it.
 */
import { QueenNode as ProdQueenNode, type QueenPorts } from "../queen-node";
import { RACE_MARKER, SimExecutors } from "./sim-ports";

import app from "../index";

export { SwarmGovernor } from "../scale/governor";

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
    const sim = new SimExecutors(() => this, this.ctx.storage, undefined, undefined, (at) => this.alarmNoLaterThan(at));
    this.sim = sim;
    return { provisioner: sim.provisioner, herald: sim.herald, sentinel: sim.sentinel, oracle: sim.oracle, dispatcher: sim.drones };
  }

  protected override isSim(): boolean {
    return true;
  }

  /** `[race]` in a filed prompt or item makes it a best-of-3 race (§6). */
  protected override filingHints(text: string): { bestOf?: number } {
    return text.includes(RACE_MARKER) ? { bestOf: 3 } : {};
  }

  /** Simulated executors run off the DO alarm (hibernation-safe), inside alarm(); then normal reconcile. */
  protected override async beforeReconcile(): Promise<void> {
    await this.sim?.runDue();
  }
}

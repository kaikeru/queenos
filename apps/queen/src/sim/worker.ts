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
import { reworkDemo, type DemoQueen } from "./rework-demo";
import { SimExecutors } from "./sim-ports";
import { simFilingHints } from "./sim-v2";

import app from "../index";

export { SwarmGovernor } from "../scale/governor";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * env.sim shares the production Worker name (for the local dev registry) and disables
 * internal auth, so an accidental `wrangler deploy --env sim` must refuse real traffic.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (!LOCAL_HOSTS.has(url.hostname)) {
      return Response.json({ error: "sim mode is localhost-only" }, { status: 403 });
    }
    // Rework demo (rework-loop spec §11): POST /sim/rework-demo?hive=<slug> plays two agents to a conflict, a rework and a landing.
    if (url.pathname === "/sim/rework-demo" && request.method === "POST") {
      const hive = url.searchParams.get("hive") ?? "";
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(hive)) return Response.json({ error: "hive=<slug> required" }, { status: 400 });
      const q = env.QUEEN_NODE.get(env.QUEEN_NODE.idFromName(hive)) as unknown as DemoQueen;
      const log = await reworkDemo(q, hive, { tick: () => new Promise((r) => setTimeout(r, 1000)), maxTicks: 300 });
      return Response.json({ hive, log });
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
    return { provisioner: sim.provisioner, herald: sim.herald, sentinel: sim.sentinel, oracle: sim.oracle, gatekeeper: sim.gatekeeper, dispatcher: sim.drones };
  }

  protected override isSim(): boolean {
    return true;
  }

  /** `[race]` in a filed prompt or item makes it a best-of-3 race (§6); `[you-pick]` also makes a human pick it (§10.8). */
  protected override filingHints(text: string): ReturnType<typeof simFilingHints> {
    return simFilingHints(text);
  }

  /** Simulated executors run off the DO alarm (hibernation-safe), inside alarm(); then normal reconcile. */
  protected override async beforeReconcile(): Promise<void> {
    await this.sim?.runDue();
  }
}

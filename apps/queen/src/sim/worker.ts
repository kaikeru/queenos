/**
 * Simulation entrypoint (`wrangler dev --env sim`). Same Worker and Durable
 * Object as production, but createPorts() returns fake Artifacts and drone
 * ports that auto-advance the merge train. See sim-ports.ts.
 *
 * This file is only referenced by wrangler.jsonc env.sim.main; the default
 * bundle (src/index.ts) never imports it.
 */
import { QueenNode as ProdQueenNode, type QueenPorts } from "../queen-node";
import { SimDroneDispatcher, SimForkProvisioner } from "./sim-ports";

export { default } from "../index";

export class QueenNode extends ProdQueenNode {
  // `declare`: no field initializer. createPorts() runs inside the base constructor,
  // and an initialized field would be reset to undefined right after super() returns.
  private declare simDrones: SimDroneDispatcher | undefined;

  protected override createPorts(): QueenPorts {
    // Called from the base constructor: `this.ctx` is set, subclass fields are not.
    const dispatcher = new SimDroneDispatcher(() => this, this.ctx.storage);
    this.simDrones = dispatcher;
    return { provisioner: new SimForkProvisioner(), dispatcher };
  }

  /** Simulated drones run off the DO alarm (hibernation-safe); then normal reconcile. */
  override async alarm(): Promise<void> {
    await this.simDrones?.runDue();
    await super.alarm();
  }
}

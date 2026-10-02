/**
 * Test entrypoint (vitest.config.ts `main`). Same Worker, but GatekeeperWorkflow
 * gets fake Artifacts / git / Queen / Vectorize ports through the createPorts() seam.
 */
import { GatekeeperWorkflow as ProdGatekeeperWorkflow } from "../src/workflow";
import type { GatekeeperPorts } from "../src/ports";
import { currentWorld } from "./fakes";

export { default } from "../src/index";

export class GatekeeperWorkflow extends ProdGatekeeperWorkflow {
  protected override createPorts(): GatekeeperPorts {
    return currentWorld().ports();
  }
}

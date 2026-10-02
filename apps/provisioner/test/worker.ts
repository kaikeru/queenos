/**
 * Test entrypoint (vitest.config.ts `main`). Same Worker, but ProvisionerWorkflow
 * gets fake Artifacts / Queen ports through the createPorts() seam.
 */
import { ProvisionerWorkflow as ProdProvisionerWorkflow } from "../src/workflow";
import type { ProvisionerPorts } from "../src/ports";
import { currentWorld } from "./fakes";

export { default } from "../src/index";

export class ProvisionerWorkflow extends ProdProvisionerWorkflow {
  protected override createPorts(): ProvisionerPorts {
    return currentWorld().ports();
  }
}

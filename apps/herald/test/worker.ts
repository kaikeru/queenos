/**
 * Test entrypoint (vitest.config.ts `main`). Same Worker, but HeraldWorkflow
 * gets fake ports through the createPorts() seam.
 */
import { HeraldWorkflow as ProdHeraldWorkflow } from "../src/workflow";
import type { HeraldPorts } from "../src/ports";
import { currentWorld } from "./fakes";

export { default } from "../src/index";

export class HeraldWorkflow extends ProdHeraldWorkflow {
  protected override createPorts(): HeraldPorts {
    return currentWorld().ports();
  }
}

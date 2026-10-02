/**
 * Test entrypoint (vitest.config.ts `main`). Same Worker, but DroneWorkflow
 * gets fake Artifacts / git / Queen ports through the createPorts() seam.
 */
import { DroneWorkflow as ProdDroneWorkflow } from "../src/workflow";
import type { DronePorts } from "../src/ports";
import { currentWorld } from "./fakes";

export { default } from "../src/index";

export class DroneWorkflow extends ProdDroneWorkflow {
  protected override createPorts(): DronePorts {
    return currentWorld().ports();
  }
}

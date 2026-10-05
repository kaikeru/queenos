/**
 * Test entrypoint (vitest.config.ts `main`). Same Worker, but DroneWorkflow
 * gets fake Artifacts / git / Queen ports through the createPorts() seam.
 */
import { DroneWorkflow as ProdDroneWorkflow } from "../src/workflow";
import type { DronePorts } from "../src/ports";
import { currentWorld, FakeLoader, starterResponses } from "./fakes";
import { BuilderAgent as ProdBuilderAgent } from "../src/agent/builder-agent";
import type { LoaderLike } from "../src/agent/verify";
import { mockModel } from "./mock-model";

export { default } from "../src/index";

export class DroneWorkflow extends ProdDroneWorkflow {
  protected override createPorts(): DronePorts {
    return currentWorld().ports();
  }
}

/** The real BuilderAgent (Think DO) with a scripted mock model and a fake Worker Loader. */
export class BuilderAgent extends ProdBuilderAgent {
  readonly testLoader = new FakeLoader(starterResponses);
  override getModel() {
    return mockModel(String(super.getModel()));
  }
  protected override loader(): LoaderLike {
    return this.testLoader;
  }
}

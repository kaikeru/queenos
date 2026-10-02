/**
 * Test entrypoint (vitest.config.ts `main`). Same Worker, but QueenNode gets
 * fake Artifacts / drone ports through the createPorts() constructor seam.
 */
import { QueenNode as ProdQueenNode, type QueenPorts } from "../src/queen-node";
import { FakeForkProvisioner, RecordingDispatcher } from "./fakes";

export { default } from "../src/index";

export class QueenNode extends ProdQueenNode {
  protected override createPorts(): QueenPorts {
    return { provisioner: new FakeForkProvisioner(), dispatcher: new RecordingDispatcher() };
  }
}

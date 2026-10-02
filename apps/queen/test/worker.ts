/**
 * Test entrypoint (vitest.config.ts `main`). Same Worker, but QueenNode gets
 * recording executor / drone ports through the createPorts() constructor seam.
 */
import { QueenNode as ProdQueenNode, type QueenPorts } from "../src/queen-node";
import { RecordingDispatcher, RecordingHerald, RecordingProvisioner } from "./fakes";

export { default } from "../src/index";

export class QueenNode extends ProdQueenNode {
  protected override createPorts(): QueenPorts {
    return { provisioner: new RecordingProvisioner(), herald: new RecordingHerald(), dispatcher: new RecordingDispatcher() };
  }
}

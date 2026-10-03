/**
 * Test entrypoint (vitest.config.ts `main`). Same Worker, but GenesisNode gets
 * fake ports through the createPorts() seam. Install a world with setWorld()
 * BEFORE the first call to a hive's DO (ports are built in its constructor).
 */
import { GenesisNode as ProdGenesisNode } from "../src/node";
import type { GenesisConfig, GenesisPorts } from "../src/ports";
import { currentWorld } from "./fakes";

export { default } from "../src/index";

export class GenesisNode extends ProdGenesisNode {
  protected override createPorts(_env: Env, config: GenesisConfig): GenesisPorts {
    const w = currentWorld();
    Object.assign(config, w.config);
    return w.ports();
  }
}

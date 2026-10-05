/**
 * Test entrypoint (vitest.config.ts `main`). Same Worker, but OracleWorkflow
 * gets fake ports through the createPorts() seam.
 */
import { OracleWorkflow as ProdOracleWorkflow } from "../src/workflow";
import type { OraclePorts } from "../src/ports";
import { currentWorld } from "./fakes";

export { default } from "../src/index";

export class OracleWorkflow extends ProdOracleWorkflow {
  protected override createPorts(): OraclePorts {
    return currentWorld().ports();
  }
}

/** Test entrypoint (vitest.config.ts `main`): SentinelWorkflow gets fake ports via createPorts(). */
import { SentinelWorkflow as Prod } from "../src/workflow";
import type { SentinelPorts } from "../src/ports";
import { currentWorld } from "./fakes";

export { default } from "../src/index";

export class SentinelWorkflow extends Prod {
  protected override createPorts(): SentinelPorts {
    return currentWorld().ports();
  }
}

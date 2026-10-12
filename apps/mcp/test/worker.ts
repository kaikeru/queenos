/** Test entrypoint (vitest.config.ts `main`): the real Worker and DOs, with QueenMcp's ports from the fake world. */
import { QueenMcp as ProdQueenMcp } from "../src/mcp";
import type { McpPorts } from "../src/ports";
import { currentWorld } from "./fakes";

export { default } from "../src/index";
export { AgentIdentity } from "../src/identity";

export class QueenMcp extends ProdQueenMcp {
  protected override ports(): McpPorts {
    return currentWorld().ports();
  }
}

import { McpAgent } from "agents/mcp";
import type { Connection, ConnectionContext } from "agents";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpAgentIdentity } from "@queenos/queen-types";
import { createProdPorts, type McpPorts } from "./ports";
import { TOOLS, callTool, type SessionPort } from "./tools";

export const USER_HEADER = "x-queen-user";
export const TOKEN_ID_HEADER = "x-queen-token-id";

export interface McpProps extends Record<string, unknown> {
  owner: string;
  tokenId: string;
}

export interface SessionState {
  /** The edge-derived owner the session bound to on its first request. */
  owner: string | null;
  identity: McpAgentIdentity | null;
}

/**
 * One MCP session (Streamable HTTP; agents 0.26.0 McpAgent: one DO per `mcp-session-id`). The edge authenticated the
 * human's qgt_ token and forwarded `x-queen-user`; every POST / GET reaches `onConnect` with the original request's
 * headers. The session binds to the first owner it sees (persisted in state) and drops any request of another owner
 * before it reaches the transport, so a leaked session id is useless without the same human's token. `props` are
 * applied only when the DO starts (agents 0.26.0 Lifecycle.start), so they are not trusted per request.
 */
export class QueenMcp extends McpAgent<Env, SessionState, McpProps> {
  server = new McpServer({ name: "queenos", version: "1.0.0" });
  override initialState: SessionState = { owner: null, identity: null };

  /** Seam for tests (test/worker.ts). */
  protected ports(): McpPorts {
    return createProdPorts(this.env);
  }

  async init(): Promise<void> {
    // The SDK would validate arguments against each tool's schema before our handler and answer with a plain-text
    // "MCP error -32602 …" that echoes zod issues. callTool is the single validator (spec §11: {code, message}, never
    // input values), so skip the SDK's check; tools/list still advertises the real schemas. Pinned to
    // @modelcontextprotocol/sdk 1.30.0 (`validateToolInput`); the wire test in mcp.test.ts fails if it changes.
    (this.server as unknown as { validateToolInput: (tool: unknown, args: unknown) => Promise<unknown> }).validateToolInput = async (_tool, args) => args;
    for (const spec of TOOLS) {
      const handler = async (args: Record<string, unknown>) => {
        const out = await callTool(spec, { ports: this.ports(), session: this.session() }, args);
        // Never log `out`: start_attempt / refresh_attempt carry an attempt token.
        return out.ok ? { content: [{ type: "text" as const, text: JSON.stringify(out.value) }] } : { content: [{ type: "text" as const, text: JSON.stringify(out.error) }], isError: true };
      };
      this.server.registerTool(spec.name, { description: spec.description, inputSchema: spec.shape }, handler as never);
    }
  }

  override async onConnect(conn: Connection, ctx: ConnectionContext): Promise<void> {
    const owner = ctx.request.headers.get(USER_HEADER)?.trim().toLowerCase() ?? "";
    const bound = this.state.owner;
    if (!owner || (bound !== null && bound !== owner)) {
      conn.close(4403, "FORBIDDEN_OWNER");
      return;
    }
    if (bound === null) this.setState({ ...this.state, owner });
    return super.onConnect(conn, ctx);
  }

  /** RPC for the Worker's DELETE guard (index.ts): the owner this session bound to, or null before its first request. */
  async sessionOwner(): Promise<string | null> {
    return this.state.owner;
  }

  private session(): SessionPort {
    return {
      owner: () => this.state.owner ?? "",
      identity: () => this.state.identity,
      bind: async (identity) => {
        this.setState({ ...this.state, identity });
      },
    };
  }
}

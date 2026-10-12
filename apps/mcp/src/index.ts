/**
 * queenos-mcp (docs/superpowers/specs/2026-10-12-queenos-mcp-design.md §4.2): MCP over Streamable HTTP at /mcp, reached
 * only through the edge's `MCP` service binding. No `x-queen-user` → 403 (the edge always sets it after checking the
 * human's qgt_ token, and strips any client copy).
 */
import { QueenMcp, TOKEN_ID_HEADER, USER_HEADER, type McpProps } from "./mcp";

export { QueenMcp } from "./mcp";
export { AgentIdentity } from "./identity";

const handler = QueenMcp.serve("/mcp", { binding: "MCP_SESSION", transport: "streamable-http" });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === "/health") return Response.json({ ok: true, service: "mcp" });
    const owner = request.headers.get(USER_HEADER)?.trim().toLowerCase();
    if (!owner) return Response.json({ error: "forbidden" }, { status: 403 });
    const props: McpProps = { owner, tokenId: request.headers.get(TOKEN_ID_HEADER) ?? "unknown" };
    // serve() reads only `ctx.props` (and passes waitUntil through): a scoped context carries the owner.
    const scoped = { waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p), passThroughOnException: () => ctx.passThroughOnException(), props } as unknown as ExecutionContext;
    return handler.fetch(request, env, scoped);
  },
} satisfies ExportedHandler<Env>;

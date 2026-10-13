import { DurableObject } from "cloudflare:workers";
import type { McpAgentIdentity } from "@queenos/queen-types";
import type { AttemptRef, IdentityPort } from "./ports";

const MAX_REFS = 200;

/** One per agentId (`idFromName(agentId)`): the agent's identity and its attempts, so a new MCP session can resume it. */
export class AgentIdentity extends DurableObject<Env> implements IdentityPort {
  async create(identity: McpAgentIdentity): Promise<McpAgentIdentity> {
    const cur = await this.ctx.storage.get<McpAgentIdentity>("identity");
    if (cur) return cur;
    await this.ctx.storage.put("identity", identity);
    return identity;
  }

  async get(): Promise<McpAgentIdentity | null> {
    return (await this.ctx.storage.get<McpAgentIdentity>("identity")) ?? null;
  }

  async attempts(): Promise<AttemptRef[]> {
    return (await this.ctx.storage.get<AttemptRef[]>("attempts")) ?? [];
  }

  async addAttempt(ref: { hive: string; attemptId: string }): Promise<void> {
    const refs = (await this.attempts()).filter((r) => r.attemptId !== ref.attemptId);
    refs.push({ ...ref, open: true });
    // Keep every open ref (an old open attempt must stay its agent's), then the newest closed ones.
    const room = Math.max(0, MAX_REFS - refs.filter((r) => r.open).length);
    const closed = refs.filter((r) => !r.open);
    const keepClosed = new Set(closed.slice(closed.length - Math.min(room, closed.length)));
    await this.ctx.storage.put("attempts", refs.filter((r) => r.open || keepClosed.has(r)));
  }

  async closeAttempt(attemptId: string): Promise<void> {
    const refs = await this.attempts();
    await this.ctx.storage.put("attempts", refs.map((r) => (r.attemptId === attemptId ? { ...r, open: false } : r)));
  }
}

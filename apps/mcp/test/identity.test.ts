import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { IdentityPort } from "../src/ports";

const stub = (agentId: string) => (env as unknown as { AGENT_IDENTITY: DurableObjectNamespace }).AGENT_IDENTITY.get((env as unknown as { AGENT_IDENTITY: DurableObjectNamespace }).AGENT_IDENTITY.idFromName(agentId)) as unknown as IdentityPort;

describe("AgentIdentity DO", () => {
  it("create is idempotent; attempts are added, closed and listed", async () => {
    const agentId = `ag_${crypto.randomUUID().replace(/-/g, "")}`;
    const id = { agentId, name: "opus", model: "claude-opus-5-5", role: "worker" as const, owner: "ada@kaikeru.com" };
    const s = stub(agentId);
    expect(await s.get()).toBeNull();
    expect(await s.create(id)).toEqual(id);
    expect(await s.create({ ...id, name: "other" })).toEqual(id);
    await s.addAttempt({ hive: "demo", attemptId: "att_000000000001" });
    await s.addAttempt({ hive: "demo", attemptId: "att_000000000002" });
    await s.closeAttempt("att_000000000001");
    expect(await s.attempts()).toEqual([
      { hive: "demo", attemptId: "att_000000000001", open: false },
      { hive: "demo", attemptId: "att_000000000002", open: true },
    ]);
  });
});

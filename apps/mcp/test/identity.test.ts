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

  it("pruning keeps every open ref and the newest closed ones", async () => {
    const agentId = `ag_${crypto.randomUUID().replace(/-/g, "")}`;
    const s = stub(agentId);
    await s.addAttempt({ hive: "demo", attemptId: "att_open00000000" });
    for (let n = 0; n < 205; n++) {
      const attemptId = `att_${String(n).padStart(12, "0")}`;
      await s.addAttempt({ hive: "demo", attemptId });
      await s.closeAttempt(attemptId);
    }
    const refs = await s.attempts();
    expect(refs).toHaveLength(200);
    expect(refs.find((r) => r.attemptId === "att_open00000000")).toEqual({ hive: "demo", attemptId: "att_open00000000", open: true });
    expect(refs.at(-1)!.attemptId).toBe("att_000000000204");
    expect(refs.some((r) => r.attemptId === "att_000000000000")).toBe(false);
  });
});

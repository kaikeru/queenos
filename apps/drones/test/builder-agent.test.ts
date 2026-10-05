import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { builderAgentPort } from "../src/ports";
import type { AgentBuildInput } from "../src/agent/contract";
import { AGENT_MAX_STEPS } from "../src/agent/builder-agent";
import { STARTER_FILES } from "./fakes";

const port = () => builderAgentPort((env as unknown as { BUILDER: DurableObjectNamespace<never> }).BUILDER as never);

const input = (model: string, key: string): AgentBuildInput => ({
  base: STARTER_FILES,
  task: { promptId: "p1", trainId: "t1", action: "BUILD", promptText: "Change / from JSON to HTML; keep /health", ragContext: [] },
  model,
  idempotencyKey: key,
  timeoutMs: 30_000,
  skipCache: false,
});

describe("BuilderAgent (Think DO, mock model)", () => {
  it("reads, edits, verifies and finishes; the result is durable and a second build() re-attaches", async () => {
    const name = "t1-build|mock/html";
    const r = await port().build(name, input("mock/html", "t1-build:mock/html"));
    expect(r.status).toBe("completed");
    expect(r.reattached).toBe(false);
    expect(r.finish?.summary).toBe("Serve HTML at /");
    expect(r.lastVerify).toMatchObject({ ok: true });
    expect(r.files["src/index.js"]).toContain('new Response("<html>"');
    expect(r.files["src/features/index.js"]).toBe(STARTER_FILES["src/features/index.js"]);
    expect(r.trace).toEqual(["t1 read src/index.js", "t2 edit src/index.js", "t3 verify / 200 text/html; /health 200 json -> ok"]);
    // The turn stopped at finish: no extra model call afterwards.
    expect(r.usage).toEqual({ inputTokens: 4000, outputTokens: 200, steps: 4 });

    const again = await port().build(name, input("mock/html", "t1-build:mock/html"));
    expect(again.reattached).toBe(true);
    expect(again.usage).toEqual(r.usage);
    expect(again.files).toEqual(r.files);
  });

  it("an unverified finish is refused and the run ends without a finish", async () => {
    const r = await port().build("t2-build|mock/finish-unverified", input("mock/finish-unverified", "t2-build:mock/finish-unverified"));
    expect(r.status).toBe("completed");
    expect(r.finish).toBeNull();
    expect(r.trace.at(-1)).toMatch(/^t\d finish refused: .*call verify/);
  });

  it("a model that never finishes stops at maxSteps", async () => {
    const r = await port().build("t3-build|mock/wander", input("mock/wander", "t3-build:mock/wander"));
    expect(r.finish).toBeNull();
    expect(r.usage.steps).toBe(AGENT_MAX_STEPS);
  });
});

import { describe, expect, it } from "vitest";
import type { AiGatewayConfig } from "@queenos/queen-types";
import { AiGatewayClient, AiGatewayError, aiGatewayUrl, type FetchLike } from "./ai-gateway.js";

const anthropic: AiGatewayConfig = { accountId: "acct123", gatewayId: "queen-gw", provider: "anthropic", model: "claude-opus-5-5" };
const openai: AiGatewayConfig = { ...anthropic, provider: "openai", model: "gpt-x" };

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

describe("AI Gateway client", () => {
  it("builds the Anthropic BYOK request: URL, cf-aig-authorization, no provider key", async () => {
    const { fetch, calls } = fakeFetch(200, {
      model: "claude-opus-5-5",
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "" },
        { type: "text", text: '{"files":[]}' },
      ],
      usage: { input_tokens: 12, output_tokens: 34 },
    });
    const client = new AiGatewayClient({ config: anthropic, token: "aig-secret", fetch });
    const res = await client.complete({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 1000,
      metadata: { trainId: "t1" },
    });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://gateway.ai.cloudflare.com/v1/acct123/queen-gw/anthropic/v1/messages");
    expect(init.method).toBe("POST");
    const h = headersOf(init);
    expect(h["cf-aig-authorization"]).toBe("Bearer aig-secret");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(h["cf-aig-metadata"]).toBe('{"trainId":"t1"}');
    const lower = Object.keys(h).map((k) => k.toLowerCase());
    expect(lower).not.toContain("x-api-key");
    expect(lower).not.toContain("authorization");

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ model: "claude-opus-5-5", max_tokens: 1000, system: "sys", messages: [{ role: "user", content: "hi" }] });
    expect(body).not.toHaveProperty("temperature"); // Opus 5.5 rejects sampling params

    expect(res).toEqual({
      text: '{"files":[]}',
      usage: { inputTokens: 12, outputTokens: 34 },
      model: "claude-opus-5-5",
      provider: "anthropic",
      stopReason: "end_turn",
    });
  });

  it("sends temperature and effort only when set", async () => {
    const { fetch, calls } = fakeFetch(200, { content: [] });
    await new AiGatewayClient({ config: anthropic, token: "t", fetch }).complete({
      messages: [{ role: "user", content: "x" }],
      temperature: 0.2,
      effort: "low",
    });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.temperature).toBe(0.2);
    expect(body.output_config).toEqual({ effort: "low" });
  });

  it("builds the OpenAI chat-completions request", async () => {
    const { fetch, calls } = fakeFetch(200, {
      model: "gpt-x",
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });
    const res = await new AiGatewayClient({ config: openai, token: "t", fetch, byokAlias: "prod" }).complete({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    const { url, init } = calls[0]!;
    expect(url).toBe(aiGatewayUrl(openai));
    expect(url).toMatch(/\/openai\/chat\/completions$/);
    const h = headersOf(init);
    expect(h["cf-aig-byok-alias"]).toBe("prod");
    expect(h).not.toHaveProperty("anthropic-version");
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain("authorization");
    expect(JSON.parse(init.body as string).messages[0]).toEqual({ role: "system", content: "sys" });
    expect(res.text).toBe("ok");
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
  });

  it("classifies errors as retryable or not", async () => {
    const run = async (status: number, body: unknown = { error: "x" }) => {
      const { fetch } = fakeFetch(status, body);
      try {
        await new AiGatewayClient({ config: anthropic, token: "t", fetch }).complete({ messages: [{ role: "user", content: "x" }] });
        return null;
      } catch (e) {
        return e as AiGatewayError;
      }
    };
    expect((await run(401))?.retryable).toBe(false);
    expect((await run(400))?.status).toBe(400);
    expect((await run(429))?.retryable).toBe(true);
    expect((await run(503))?.retryable).toBe(true);
    const refusal = await run(200, { stop_reason: "refusal", content: [] });
    expect(refusal).toBeInstanceOf(AiGatewayError);
    expect(refusal?.retryable).toBe(false);
    expect((await run(200, "not json"))?.retryable).toBe(true);
  });

  it("requires a token", () => {
    expect(() => new AiGatewayClient({ config: anthropic, token: "" })).toThrow(AiGatewayError);
  });
});

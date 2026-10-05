import { describe, expect, it } from "vitest";
import { AiGatewayError, createAiClient, modelForRole, type AiRunner } from "./ai-gateway.js";

type Call = { model: string; input: Record<string, unknown>; options: unknown };

function fake(out: unknown | (() => unknown)) {
  const calls: Call[] = [];
  const ai: AiRunner = {
    async run(model, input, options) {
      calls.push({ model, input, options });
      return typeof out === "function" ? (out as () => unknown)() : out;
    },
  };
  return { ai, calls };
}

const thirdParty = {
  choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 7, completion_tokens: 3 },
};

describe("AiClient", () => {
  it("sends system as the first message through the gateway, with no auth", async () => {
    const { ai, calls } = fake(thirdParty);
    const res = await createAiClient({ ai, gatewayId: "queenos" }).complete({
      model: "anthropic/claude-haiku-4-5",
      system: "be brief",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 50,
      metadata: { trainId: "t1" },
    });
    expect(calls).toEqual([
      {
        model: "anthropic/claude-haiku-4-5",
        input: { messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }], max_tokens: 50 },
        options: { gateway: { id: "queenos", metadata: { trainId: "t1" } } },
      },
    ]);
    expect(res).toEqual({ text: "hello", model: "anthropic/claude-haiku-4-5", usage: { inputTokens: 7, outputTokens: 3 }, finishReason: "stop" });
  });

  it("sends temperature only when set, omits system when absent", async () => {
    const { ai, calls } = fake(thirdParty);
    const c = createAiClient({ ai, gatewayId: "g" });
    await c.complete({ model: "m", messages: [{ role: "user", content: "x" }] });
    await c.complete({ model: "m", messages: [{ role: "user", content: "x" }], temperature: 0.2 });
    expect(calls[0]!.input).toEqual({ messages: [{ role: "user", content: "x" }], max_tokens: 16_000 });
    expect(calls[1]!.input).toMatchObject({ temperature: 0.2 });
  });

  it("reads the Workers AI { response } shape", async () => {
    const { ai } = fake({ response: "from llama", usage: { prompt_tokens: 1, completion_tokens: 2 } });
    const res = await createAiClient({ ai, gatewayId: "g" }).complete({ model: "@cf/meta/llama-3.1-8b-instruct", messages: [{ role: "user", content: "x" }] });
    expect(res).toMatchObject({ text: "from llama", model: "@cf/meta/llama-3.1-8b-instruct", usage: { inputTokens: 1, outputTokens: 2 } });
  });

  it("classifies thrown errors and refusals", async () => {
    const run = async (e: unknown) => {
      const { ai } = fake(() => {
        throw e;
      });
      return createAiClient({ ai, gatewayId: "g" })
        .complete({ model: "m", messages: [{ role: "user", content: "x" }] })
        .catch((x: unknown) => x as AiGatewayError);
    };
    expect(await run(new Error("3040: Capacity temporarily exceeded, please try again."))).toMatchObject({ retryable: true });
    expect(await run(new Error("429 rate limited"))).toMatchObject({ status: 429, retryable: true });
    expect(await run(new Error("upstream 503"))).toMatchObject({ status: 503, retryable: true });
    expect(await run(new Error("401 Unauthorized"))).toMatchObject({ status: 401, retryable: false });
    expect(await run(Object.assign(new Error("bad"), { status: 400 }))).toMatchObject({ status: 400, retryable: false });
    expect(await run(new Error("socket hang up"))).toMatchObject({ status: 0, retryable: true });

    const { ai } = fake({ choices: [{ message: { content: null, refusal: "no" } }] });
    const refusal = await createAiClient({ ai, gatewayId: "g" })
      .complete({ model: "m", messages: [{ role: "user", content: "x" }] })
      .catch((x: unknown) => x as AiGatewayError);
    expect(refusal).toBeInstanceOf(AiGatewayError);
    expect(refusal).toMatchObject({ retryable: false });
  });
});

describe("modelForRole", () => {
  it("uses MODEL_<ROLE> or the role default", () => {
    expect(modelForRole("BUILDER", {})).toBe("@cf/zai-org/glm-5.3-flash");
    expect(modelForRole("SCRIBE", { MODEL_SCRIBE: "" })).toBe("@cf/zai-org/glm-4.7-flash");
    expect(modelForRole("SCRIBE", { MODEL_SCRIBE: " @cf/meta/llama-3.1-8b-instruct " })).toBe("@cf/meta/llama-3.1-8b-instruct");
  });
});

describe("output shapes and structured output", () => {
  const complete = async (out: unknown, extra: Record<string, unknown> = {}) => {
    const { ai, calls } = fake(out);
    const res = await createAiClient({ ai, gatewayId: "g" }).complete({ model: "@cf/zai-org/glm-5.3-flash", messages: [{ role: "user", content: "x" }], ...extra });
    return { res, calls };
  };

  it("ignores a separate reasoning_content field", async () => {
    const { res } = await complete({ choices: [{ message: { content: "answer", reasoning_content: "long thinking" }, finish_reason: "stop" }] });
    expect(res.text).toBe("answer");
  });

  it("returns empty text when the model only produced reasoning (ran out of tokens)", async () => {
    const { res } = await complete({ choices: [{ message: { content: null, reasoning_content: "thinking..." }, finish_reason: "length" }] });
    expect(res).toMatchObject({ text: "", finishReason: "length" });
  });

  it("strips inline <think> blocks, closed or truncated", async () => {
    expect((await complete({ response: "<think>hmm</think>\n{\"a\":1}" })).res.text).toBe('{"a":1}');
    expect((await complete({ response: "<think>never ends" })).res.text).toBe("");
  });

  it("accepts content parts and an already-parsed JSON-mode object", async () => {
    expect((await complete({ choices: [{ message: { content: [{ type: "text", text: "he" }, { type: "text", text: "llo" }] } }] })).res.text).toBe("hello");
    expect((await complete({ response: { files: [] } })).res.text).toBe('{"files":[]}');
  });

  it("sends response_format and extra params only when asked", async () => {
    const fmt = { type: "json_schema", json_schema: { name: "x", schema: { type: "object" } } } as const;
    const { calls } = await complete({ response: "{}" }, { responseFormat: fmt, extraParams: { reasoning_effort: "low" } });
    expect(calls[0]!.input).toMatchObject({ response_format: fmt, reasoning_effort: "low" });
    const plain = await complete({ response: "{}" });
    expect(plain.calls[0]!.input).not.toHaveProperty("response_format");
  });
});

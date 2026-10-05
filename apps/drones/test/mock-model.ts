/**
 * A scripted AI SDK model for the BuilderAgent smoke test. The script is picked by the model id the
 * drone asked for ("mock/<script>"); the step index is the number of tool results already in the prompt.
 */
import { MockLanguageModelV4 } from "ai/test";

type Call = { tool: string; input: unknown } | { text: string };

const INDEX_OLD = 'if (url.pathname === "/") return json(';
const INDEX_NEW = 'if (url.pathname === "/") return new Response("<html>", { headers: { "content-type": "text/html" } });\n    if (false) return json(';
const FINISH = { summary: "Serve HTML at /", reasoningSteps: ["The router owns /", "Edited the / branch"], discardedPaths: ["a /features/status page"] };

export const SCRIPTS: Record<string, (step: number) => Call> = {
  html: (step) =>
    [
      { tool: "read", input: { path: "/src/index.js" } },
      { tool: "edit", input: { path: "/src/index.js", old_string: INDEX_OLD, new_string: INDEX_NEW } },
      { tool: "verify", input: {} },
      { tool: "finish", input: FINISH },
    ][step] ?? { text: "done" },
  // Tries to finish before verifying; the refusal is the last thing it sees, then it stops talking.
  "finish-unverified": (step) =>
    [
      { tool: "edit", input: { path: "/src/index.js", old_string: INDEX_OLD, new_string: INDEX_NEW } },
      { tool: "finish", input: FINISH },
    ][step] ?? { text: "I am done." },
  // Never finishes: runs into maxSteps.
  wander: () => ({ tool: "list", input: { path: "/" } }),
};

const usage = { inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 50, text: 50, reasoning: 0 } };

export function mockModel(modelId: string): MockLanguageModelV4 {
  const script = SCRIPTS[modelId.replace(/^mock\//, "")];
  if (!script) throw new Error(`no mock script for ${modelId}`);
  return new MockLanguageModelV4({
    modelId,
    doStream: async (options) => {
      const step = options.prompt.filter((m) => m.role === "tool").length;
      const call = script(step);
      const parts: unknown[] = [{ type: "stream-start", warnings: [] }];
      if ("tool" in call) {
        parts.push({ type: "tool-call", toolCallId: `c${step}`, toolName: call.tool, input: JSON.stringify(call.input) });
        parts.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage });
      } else {
        parts.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: call.text }, { type: "text-end", id: "t" });
        parts.push({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
      }
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of parts) c.enqueue(p as never);
            c.close();
          },
        }),
      };
    },
  });
}

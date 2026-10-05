import { describe, expect, it } from "vitest";
import { MAX_MEMORY_TEXT, type MemoryRecord } from "@queenos/queen-types";
import { HiveMemory, MemoryError, composeMemoryText, memoryIdFor, type MemoryIndex } from "./memory.js";
import type { AiRunner } from "./ai-gateway.js";

/** Embeds each text as [length, 1]; the fake index returns whatever `matches` holds. */
function fakes(matches: Awaited<ReturnType<MemoryIndex["query"]>>["matches"] = []) {
  const upserts: Parameters<MemoryIndex["upsert"]>[0] = [];
  const queries: Parameters<MemoryIndex["query"]>[] = [];
  const ai: AiRunner = { run: async (_m, input) => ({ data: (input.text as string[]).map((t) => [t.length, 1]) }) };
  const index: MemoryIndex = {
    upsert: async (v) => void upserts.push(...v),
    query: async (...args) => (queries.push(args), { matches }),
  };
  return { ai, index, upserts, queries };
}

const record: MemoryRecord = {
  memoryId: memoryIdFor("t1", "abcdef0123456789"),
  namespace: "demo",
  trainId: "t1",
  promptId: "p1",
  commitSha: "abcdef0123456789",
  outcome: "PASSED",
  promptText: "Make / an HTML page",
  text: "Prompt: Make / an HTML page\nOutcome: passed the gate.",
  createdAt: 1,
};

describe("hive memory", () => {
  it("ids one memory per (train, commit)", () => {
    expect(memoryIdFor("t1", "abcdef0123456789")).toBe("t1:abcdef012345");
  });

  it("composes a bounded memory text", () => {
    const text = composeMemoryText({
      promptText: "Change / to HTML",
      outcome: "REJECTED_BY_REVIEW",
      verdict: "It added /features/x instead of changing /.",
      reasoning: ["edited src/features/x.js"],
      changedFiles: ["src/features/x.js"],
    });
    expect(text).toContain("Prompt: Change / to HTML");
    expect(text).toContain("Changed: src/features/x.js");
    expect(text).toContain("was rejected by the reviewer");
    expect(composeMemoryText({ promptText: "x".repeat(5_000), outcome: "PASSED", verdict: "y".repeat(5_000) }).length).toBeLessThanOrEqual(MAX_MEMORY_TEXT);
  });

  it("remembers with namespace metadata", async () => {
    const f = fakes();
    await new HiveMemory(f.ai, f.index).remember(record);
    expect(f.upserts).toHaveLength(1);
    expect(f.upserts[0]).toMatchObject({ id: "t1:abcdef012345", values: [record.text.length, 1], metadata: { namespace: "demo", outcome: "PASSED" } });
  });

  it("recalls filtered by namespace, drops low scores, self and junk", async () => {
    const md = (trainId: string) => ({ trainId, promptId: "p", outcome: "PASSED", promptText: "q", text: "memory", createdAt: 5 });
    const f = fakes([
      { id: "a", score: 0.9, metadata: md("t9") },
      { id: "self", score: 0.95, metadata: md("t1") },
      { id: "junk", score: 0.9, metadata: { trainId: "t8" } },
      { id: "low", score: 0.3, metadata: md("t7") },
    ]);
    const got = await new HiveMemory(f.ai, f.index).recall("demo", "html page", { excludeTrainId: "t1" });
    expect(got.map((m) => m.memoryId)).toEqual(["a"]);
    expect(got[0]).toMatchObject({ trainId: "t9", outcome: "PASSED", score: 0.9, createdAt: 5 });
    expect(f.queries[0]![1]).toMatchObject({ filter: { namespace: "demo" }, returnMetadata: "all" });
  });

  it("fails loudly without bindings (callers treat recall as best effort)", async () => {
    await expect(new HiveMemory(undefined, undefined).recall("demo", "q")).rejects.toBeInstanceOf(MemoryError);
  });
});

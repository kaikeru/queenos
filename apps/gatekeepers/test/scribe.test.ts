import { describe, expect, it } from "vitest";
import { AiGatewayError } from "@queenos/hive-kit";
import { MAX_LOG_CHARS, SCRIBE_PROMPT, enforceSummary, extractiveSummary, summarizeFailure, truncateLog } from "../src/scribe";
import { ScriptedTestRunner } from "../src/test-runner";
import { FakeLlm } from "./fakes";

async function failingLog() {
  return new ScriptedTestRunner().run({
    repo: "r",
    trainId: "t",
    after: "a".repeat(40),
    changedPaths: [],
    changedFiles: { "f.md": "[fail]" },
    commitMessages: [],
    fileCount: 1,
  });
}

describe("extractive scribe", () => {
  it("is <= 500 chars, names the failing check and the first error, and is deterministic", async () => {
    const run = await failingLog();
    const s = extractiveSummary(run.log);
    expect(s.length).toBeLessThanOrEqual(500);
    expect(s).toContain("preview smoke > serves the changed feature");
    expect(s).toContain("AssertionError: scripted failure: [fail] marker found in changed file f.md");
    expect(extractiveSummary(run.log)).toBe(s);
  });

  it("caps pathological error lines at 500 chars", () => {
    const s = extractiveSummary(`Error: ${"x".repeat(2_000)}`);
    expect(s.length).toBe(500);
    expect(s.endsWith("…")).toBe(true);
  });

  it("copes with logs that have no error line", () => {
    expect(extractiveSummary("")).toBe("The gate failed. First error: no output");
  });
});

describe("LLM scribe", () => {
  it("sends the two-sentence prompt, truncates to ~20k, and enforces two sentences / 500 chars", async () => {
    const llm = new FakeLlm(`The build broke. A marker was found. ${"Extra sentence. ".repeat(100)}`);
    const log = `Error: boom\n${"line of noise\n".repeat(5_000)}`;
    const r = await summarizeFailure({ log, llm, model: "m" });
    expect(r.method).toBe("llm");
    expect(r.summary).toBe("The build broke. A marker was found.");
    expect(llm.requests[0]!.model).toBe("m");
    expect(llm.requests[0]!.system).toBe(SCRIBE_PROMPT);
    expect(llm.requests[0]!.system).toBe("Summarize this failure in exactly two sentences.");
    expect(llm.requests[0]!.messages[0]!.content.length).toBeLessThanOrEqual(MAX_LOG_CHARS + 10);
  });

  it("enforceSummary caps at 500", () => {
    expect(enforceSummary(`${"a".repeat(900)}. Second.`).length).toBe(500);
  });

  it("falls back to extractive on non-retryable errors and rethrows retryable ones", async () => {
    const log = "Error: nope";
    const r = await summarizeFailure({ log, model: "m", llm: new FakeLlm(new AiGatewayError("bad request", 400, false)) });
    expect(r.method).toBe("extractive");
    await expect(summarizeFailure({ log, model: "m", llm: new FakeLlm(new AiGatewayError("busy", 429, true)) })).rejects.toThrow("busy");
  });

  it("uses the extractive path with no llm", async () => {
    expect((await summarizeFailure({ log: "Error: x", llm: null, model: "m" })).method).toBe("extractive");
  });

  it("truncateLog keeps head and tail", () => {
    const t = truncateLog(`HEAD${"x".repeat(50_000)}TAIL`);
    expect(t.length).toBeLessThanOrEqual(MAX_LOG_CHARS + 5);
    expect(t.startsWith("HEAD")).toBe(true);
    expect(t.endsWith("TAIL")).toBe(true);
  });
});

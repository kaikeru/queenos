import { describe, expect, it } from "vitest";
import { AiGatewayError, memoryIdFor, type CompletionRequest, type CompletionResult } from "@queenos/hive-kit";
import { runGate } from "../src/orchestrate";
import { MAX_REVIEW_INPUT_CHARS, parseReview, renderReviewInput, scriptedReview } from "../src/review";
import type { ScribeLlm } from "../src/scribe";
import { FakeLlm, FakeWorld, InlineSteps, REPO, config, gateTask } from "./fakes";

const PROMPT = "Change our status page from json to a nice html page";
const FILES = { "src/features/status.ts": "export const status = { ok: true } as const;\n", "features/status.md": `# ${PROMPT}\n\n## Request\n\n${PROMPT}\n` };
const APPROVE = JSON.stringify({ verdict: "APPROVE", satisfied: ["/ serves HTML"], missing: [], feedback: "Looks right." });
const REJECT = JSON.stringify({
  verdict: "REJECT",
  satisfied: ["an HTML page exists"],
  missing: ["/ still returns JSON"],
  feedback: "/ still returns JSON; the prompt asked to change the status page itself. Make GET / return HTML.",
});

const llmConfig = (vars: Record<string, string> = {}) => config({ REVIEW_MODE: "llm", REVIEW_TIMEOUT_MS: "50", ...vars });

async function setup(opts: { prompt?: string; action?: "build" | "rework"; files?: Record<string, string> } = {}) {
  const w = new FakeWorld();
  await w.git.seed(REPO);
  const p = opts.prompt ?? PROMPT;
  const after = await w.git.build(REPO, { prompt: p, ...(opts.action ? { action: opts.action } : {}), files: opts.files ?? FILES });
  w.queen.train.headSha = after;
  w.queen.train.previewUrl = "https://preview.example.dev";
  w.queen.promptText = p;
  w.smoke.result = { passed: true, status: 200, contentType: "application/json", body: '{"ok":true,"service":"status"}', log: "smoke: ok" };
  return { w, after };
}

class SeqLlm implements ScribeLlm {
  readonly requests: CompletionRequest[] = [];
  constructor(private readonly replies: (string | Error | "hang")[]) {}
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    const r = this.replies[Math.min(this.requests.length - 1, this.replies.length - 1)]!;
    if (r === "hang") return new Promise(() => undefined);
    if (r instanceof Error) throw r;
    return { text: r, model: req.model };
  }
}

describe("reviewer: llm mode", () => {
  it("approves: audits RUNNING then PASSED, sends prompt + diff + preview evidence, gate passes", async () => {
    const { w, after } = await setup();
    const llm = new FakeLlm(APPROVE);
    w.reviewLlm = llm;
    const steps = new InlineSteps();
    const out = await runGate(gateTask(after), steps, w.ports(), llmConfig());

    expect(out).toMatchObject({ status: "gated", passed: true, review: "approved" });
    expect(w.queen.auditSeq()).toEqual(["POLICY:RUNNING", "SECURITY:RUNNING", "POLICY:PASSED", "SECURITY:PASSED", "REVIEWER:RUNNING", "REVIEWER:PASSED"]);
    const ledger = w.queen.audits()[5]!.gitNotesPayload!;
    expect(ledger).toMatchObject({ model: "@cf/deepseek-ai/deepseek-v4-flash-0731", result: "success" });
    expect(ledger.reasoningSteps).toEqual(["verdict: APPROVE", "satisfied: / serves HTML", "feedback: Looks right."]);
    expect(steps.names()).toContain("review: llm");
    expect(w.memory.records.map((r) => r.outcome)).toEqual(["PASSED"]);
    expect(w.memory.records[0]!.text).toContain("The reviewer approved the change.");

    expect(llm.requests).toHaveLength(1);
    const req = llm.requests[0]!;
    expect(req.model).toBe("@cf/deepseek-ai/deepseek-v4-flash-0731");
    expect(req.responseFormat).toMatchObject({ type: "json_schema" });
    expect(req.system).toContain("Judge intent, not style");
    const text = req.messages[0]!.content;
    expect(text.length).toBeLessThanOrEqual(MAX_REVIEW_INPUT_CHARS);
    expect(text).toContain(`## Prompt\n${PROMPT}`);
    expect(text).toContain("## Changed file: src/features/status.ts");
    // Preview evidence: what GET / actually serves.
    expect(text).toContain("status: 200");
    expect(text).toContain("content-type: application/json");
    expect(text).toContain('{"ok":true,"service":"status"}');
    expect(text).toContain("## Tree");
  });

  it("rejects: gate fails, feedback becomes the Scribe summary, audits RUNNING then REJECTED, vectorized", async () => {
    const { w, after } = await setup();
    w.reviewLlm = new FakeLlm(REJECT);
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), llmConfig());

    const feedback = "/ still returns JSON; the prompt asked to change the status page itself. Make GET / return HTML.";
    expect(out).toMatchObject({ status: "gated", passed: false, summary: feedback, review: "rejected", vectorized: expect.any(Number) });
    expect(w.queen.auditSeq()).toEqual(["POLICY:RUNNING", "SECURITY:RUNNING", "POLICY:PASSED", "SECURITY:PASSED", "REVIEWER:RUNNING", "REVIEWER:REJECTED"]);
    expect(w.queen.audits()[5]!.gitNotesPayload).toMatchObject({ result: "failure" });
    expect(w.queen.audits()[5]!.gitNotesPayload!.reasoningSteps).toContain("missing: / still returns JSON");
    expect(w.queen.scribes()).toEqual([{ promptId: "prompt-1", trainId: "train-1", summary: feedback }]);
    expect(w.queen.reports()).toEqual([{ trainId: "train-1", passed: false, summary: feedback, commitSha: after }]);
    expect(w.failures.stored[0]![0]!.text).toContain("/ still returns JSON");

    // Hive memory: one REJECTED_BY_REVIEW record with feedback + missing items.
    expect(w.memory.records).toHaveLength(1);
    expect(w.memory.records[0]!).toMatchObject({ outcome: "REJECTED_BY_REVIEW", memoryId: memoryIdFor("train-1", after), namespace: "hive" });
    expect(w.memory.records[0]!.text).toContain("was rejected by the reviewer");
    expect(w.memory.records[0]!.text).toContain("Make GET / return HTML.");
    expect(w.memory.records[0]!.text).toContain("Missing: / still returns JSON");
  });

  it("clips feedback to 400 chars and tolerates fences and a lower-case verdict", async () => {
    const { w, after } = await setup();
    w.reviewLlm = new FakeLlm("Here you go:\n```json\n" + JSON.stringify({ verdict: "reject", feedback: "x".repeat(900) }) + "\n```");
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), llmConfig());
    expect(out).toMatchObject({ passed: false, review: "rejected" });
    if (out.status === "gated") expect(out.summary.length).toBeLessThanOrEqual(400);
  });

  it("does not review code the smoke test rejected", async () => {
    const { w, after } = await setup();
    w.smoke.result = { passed: false, status: 500, log: "smoke failed", firstError: "boom" };
    const llm = new FakeLlm(APPROVE);
    w.reviewLlm = llm;
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), llmConfig());
    expect(out).toMatchObject({ passed: false });
    expect(llm.requests).toEqual([]);
    expect(w.queen.auditSeq().some((a) => a.startsWith("REVIEWER"))).toBe(false);
  });

  it("does not review when REVIEW_MODE is off", async () => {
    const { w, after } = await setup();
    const llm = new FakeLlm(REJECT);
    w.reviewLlm = llm;
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), config({ REVIEW_MODE: "off" }));
    expect(out).toMatchObject({ passed: true });
    expect(llm.requests).toEqual([]);
  });
});

describe("reviewer: fail-open", () => {
  const warned = (w: FakeWorld) => {
    expect(w.queen.auditSeq()).toEqual(["POLICY:RUNNING", "SECURITY:RUNNING", "POLICY:PASSED", "SECURITY:PASSED", "REVIEWER:RUNNING", "REVIEWER:PASSED"]);
    return w.queen.audits()[5]!.gitNotesPayload!.reasoningSteps[0]!;
  };

  it("continues on a model error (after one retry) with a warning audit", async () => {
    const { w, after } = await setup();
    const llm = new SeqLlm([new AiGatewayError("overloaded", 529, true)]);
    w.reviewLlm = llm;
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), llmConfig());
    expect(out).toMatchObject({ passed: true, review: "skipped" });
    expect(llm.requests).toHaveLength(2);
    expect(warned(w)).toMatch(/^warning: reviewer unavailable, failing open: .*overloaded/);
  });

  it("does not retry a non-retryable gateway error", async () => {
    const { w, after } = await setup();
    const llm = new SeqLlm([new AiGatewayError("no such model", 404, false)]);
    w.reviewLlm = llm;
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), llmConfig());
    expect(out).toMatchObject({ passed: true, review: "skipped" });
    expect(llm.requests).toHaveLength(1);
  });

  it("continues when the call times out", async () => {
    const { w, after } = await setup();
    w.reviewLlm = new SeqLlm(["hang"]);
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), llmConfig({ REVIEW_TIMEOUT_MS: "20" }));
    expect(out).toMatchObject({ passed: true, review: "skipped" });
    expect(warned(w)).toContain("timed out");
  });

  it("continues on garbage output twice", async () => {
    const { w, after } = await setup();
    const llm = new SeqLlm(["I think it is fine!", '{"verdict":"MAYBE"}']);
    w.reviewLlm = llm;
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), llmConfig());
    expect(out).toMatchObject({ passed: true, review: "skipped" });
    expect(llm.requests).toHaveLength(2);
    expect(warned(w)).toContain("unparseable");
  });

  it("recovers when the second attempt is valid", async () => {
    const { w, after } = await setup();
    w.reviewLlm = new SeqLlm(["garbage", REJECT]);
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), llmConfig());
    expect(out).toMatchObject({ passed: false, review: "rejected" });
  });

  it("continues when there is no AI binding", async () => {
    const { w, after } = await setup();
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), llmConfig());
    expect(out).toMatchObject({ passed: true, review: "skipped" });
    expect(warned(w)).toContain("no AI binding");
  });
});

describe("reviewer: input caps", () => {
  it("never exceeds 24 KB however large the change, and truncates big files", () => {
    const big = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`src/f${i}.ts`, "x".repeat(50_000)]));
    const text = renderReviewInput({
      prompt: "p".repeat(20_000),
      commitMessages: ["m".repeat(5_000)],
      changedFiles: big,
      tree: Array.from({ length: 2_000 }, (_, i) => `src/dir/file-${i}.ts`),
      rework: true,
      preview: { status: 200, contentType: "text/html", body: "b".repeat(10_000) },
    });
    expect(text.length).toBeLessThanOrEqual(MAX_REVIEW_INPUT_CHARS);
    expect(text).toContain("chars truncated");
    expect(text).toContain("more changed file(s) omitted");
    expect(text).toContain("REWORK");
    expect(text.split("b".repeat(1_025)).length).toBe(1); // preview body capped at 1 KB
    expect(text).toMatch(/## Tree \(\d+\/2000 paths\)/);
  });

  it("flows through the gate: a huge changed file is truncated in the request", async () => {
    const { w, after } = await setup({ files: { ...FILES, "src/big.ts": `export const big = "${"y".repeat(100_000)}";\n` } });
    const llm = new FakeLlm(APPROVE);
    w.reviewLlm = llm;
    await runGate(gateTask(after), new InlineSteps(), w.ports(), llmConfig());
    const text = llm.requests[0]!.messages[0]!.content;
    expect(text.length).toBeLessThanOrEqual(MAX_REVIEW_INPUT_CHARS);
    expect(text).toContain("chars truncated");
  });

  it("tells the reviewer when no preview exists", () => {
    const text = renderReviewInput({ prompt: "p", commitMessages: [], changedFiles: {}, tree: [], rework: false, preview: null });
    expect(text).toContain("not available");
  });
});

describe("reviewer: scripted mode", () => {
  const scripted = () => config({ REVIEW_MODE: "scripted" });

  it("rejects the first attempt with the [review-fail] marker", async () => {
    const p = "Change the status page [review-fail]";
    const { w, after } = await setup({ prompt: p, files: { "src/a.ts": "export const a = 1;\n", "features/a.md": `## Request\n\n${p}\n` } });
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), scripted());
    expect(out).toMatchObject({ passed: false, review: "rejected", summary: expect.stringContaining("Scripted reviewer") });
    expect(w.queen.auditSeq().slice(-2)).toEqual(["REVIEWER:RUNNING", "REVIEWER:REJECTED"]);
    expect(w.queen.scribes()).toHaveLength(1);
  });

  it("approves the REWORK of the same prompt", async () => {
    const p = "Change the status page [review-fail]";
    const { w, after } = await setup({
      prompt: p,
      action: "rework",
      files: { "src/a.ts": "export const a = 1;\n", "features/a.md": `## Request\n\n${p}\n\n## Rework\n\nPrevious attempt failed.\n` },
    });
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), scripted());
    expect(out).toMatchObject({ passed: true, review: "approved" });
    expect(w.queen.auditSeq().slice(-2)).toEqual(["REVIEWER:RUNNING", "REVIEWER:PASSED"]);
  });

  it("approves prompts without the marker, and does not confuse it with [fail]", async () => {
    const { w, after } = await setup();
    const out = await runGate(gateTask(after), new InlineSteps(), w.ports(), scripted());
    expect(out).toMatchObject({ passed: true, review: "approved" });
    expect(scriptedReview("Fix it [fail]", false).verdict).toBe("APPROVE");
  });
});

describe("parseReview", () => {
  it("rejects output without a verdict and synthesizes REJECT feedback", () => {
    expect(parseReview("nope")).toBeNull();
    expect(parseReview('{"verdict":"APPROVE"')).toBeNull();
    expect(parseReview('{"verdict":"REJECT","missing":["a","b"]}')).toMatchObject({ verdict: "REJECT", feedback: expect.stringContaining("a; b") });
  });
});

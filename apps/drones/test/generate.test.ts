import { describe, expect, it } from "vitest";
import { AiGatewayError } from "@queenos/hive-kit";
import { DroneTaskSchema, type DroneTaskInput } from "@queenos/queen-types";
import { generateChangeSet, withMergedRegistry } from "../src/build";
import { escapeControlCharsInStrings, parseChangeSet, templateFitProblems, validateChangeSet } from "../src/change-set";
import { readConfig } from "../src/config";
import { AllModelsFailedError, generateLive, modelsFor } from "../src/generate";
import { CHANGE_SET_RESPONSE_FORMAT, BUILDER_SYSTEM_PROMPT, buildBuilderMessages } from "../src/prompt";
import { SCRIPTED_MODEL, registryModules, renderRegistry } from "../src/scripted";
import { FakeLlm, FakeWorld, InlineSteps, task } from "./fakes";
import { runDrone } from "../src/orchestrate";

const live = readConfig({ DRONE_LLM_MODE: "live", DRONE_HARNESS: "single-shot", MODEL_BUILDER: "@cf/default/model" });
const parsed = (o: Partial<DroneTaskInput> = {}) => DroneTaskSchema.parse(task(o));
const choice = (model: string, fallbacks: string[] = []) => ({ model, tier: "fast" as const, role: "builder" as const, reason: "test", fallbacks });

const good = JSON.stringify({
  files: [
    { path: "src/features/status.js", content: 'export const slug = "status";\nexport async function handle() { return Response.json({ ok: true }); }\n' },
    { path: "src/features/index.js", content: 'import * as f0 from "./status.js";\nexport const features = [f0];\n' },
  ],
  reasoningSteps: ["added status"],
  discardedPaths: [],
});

describe("model selection", () => {
  it("uses modelChoice.model then fallbacks in order, de-duplicated", () => {
    expect(modelsFor(parsed({ modelChoice: choice("@cf/a", ["@cf/b", "@cf/a", "@cf/c"]) }), live)).toEqual(["@cf/a", "@cf/b", "@cf/c"]);
  });
  it("falls back to MODEL_BUILDER when modelChoice is absent", () => {
    expect(modelsFor(parsed(), live)).toEqual(["@cf/default/model"]);
  });

  it("tries fallbacks in order and reports the model that produced the change set plus failedModels", async () => {
    const llm = new FakeLlm((req) => (req.model === "@cf/c" ? good : "nope"));
    const out = await generateLive({ llm, task: parsed({ modelChoice: choice("@cf/a", ["@cf/b", "@cf/c", "@cf/d"]) }), config: live, context: null });
    expect(out).toMatchObject({ model: "@cf/c", failedModels: ["@cf/a", "@cf/b"], repaired: false });
    // a, a(repair), b, b(repair), c
    expect(llm.requests.map((r) => r.model)).toEqual(["@cf/a", "@cf/a", "@cf/b", "@cf/b", "@cf/c"]);
  });

  it("counts a model that cannot even be called (404) as failed and moves on", async () => {
    const llm = new FakeLlm((req) => (req.model === "@cf/gone" ? new AiGatewayError("AI run failed: 404 model not found", 404, false) : good));
    const out = await generateLive({ llm, task: parsed({ modelChoice: choice("@cf/gone", ["@cf/ok"]) }), config: live, context: null });
    expect(out).toMatchObject({ model: "@cf/ok", failedModels: ["@cf/gone"] });
  });

  it("throws an AllModelsFailedError (not retried) when every model fails", async () => {
    const llm = new FakeLlm(() => "garbage");
    const p = generateLive({ llm, task: parsed({ modelChoice: choice("@cf/a", ["@cf/b"]) }), config: live, context: null });
    await expect(p).rejects.toBeInstanceOf(AllModelsFailedError);
    await expect(p).rejects.toMatchObject({ failedModels: ["@cf/a", "@cf/b"] });
  });

  it("rethrows a retryable gateway error when every model only failed transiently", async () => {
    const llm = new FakeLlm(() => new AiGatewayError("AI run failed: 503", 503, true));
    await expect(generateLive({ llm, task: parsed({ modelChoice: choice("@cf/a", ["@cf/b"]) }), config: live, context: null })).rejects.toMatchObject({ status: 503 });
  });

  it("stops starting new models once the time budget is spent", async () => {
    let t = 0;
    const llm = new FakeLlm(() => "garbage");
    const p = generateLive({ llm, task: parsed({ modelChoice: choice("@cf/a", ["@cf/b"]) }), config: live, context: null, now: () => (t += 150_000), budgetMs: 200_000 });
    await expect(p).rejects.toBeInstanceOf(AllModelsFailedError);
    expect(llm.requests.every((r) => r.model === "@cf/a")).toBe(true);
  });
});

describe("repair turn", () => {
  it("sends the validation error back once and accepts the corrected JSON", async () => {
    const llm = new FakeLlm((_req, n) => (n === 1 ? '{"files":[{"path":".git/config","content":"x"}]}' : good));
    const out = await generateLive({ llm, task: parsed(), config: live, context: null });
    expect(out).toMatchObject({ model: "@cf/default/model", failedModels: [], repaired: true });
    expect(llm.requests).toHaveLength(2);
    const msgs = llm.requests[1]!.messages;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[1]!.content).toContain(".git/config");
    expect(msgs[2]!.content).toMatch(/rejected: .*unsafe path|reserved/);
    expect(msgs[2]!.content).toMatch(/ONLY the corrected JSON/);
  });

  it("template misfits (bare imports, TypeScript) trigger the repair turn too", async () => {
    const bad = JSON.stringify({ files: [{ path: "src/features/x.js", content: 'import { Hono } from "hono";\nexport const slug = "x";\nexport function handle() {}\n' }] });
    const llm = new FakeLlm((_r, n) => (n === 1 ? bad : good));
    const out = await generateLive({ llm, task: parsed(), config: live, context: null });
    expect(out.repaired).toBe(true);
    expect(llm.requests[1]!.messages[2]!.content).toContain('import "hono" is not allowed');
  });

  it("repairs a reply truncated at the token limit", async () => {
    const llm = new FakeLlm(() => good);
    const orig = llm.complete.bind(llm);
    let n = 0;
    llm.complete = async (req) => ({ ...(await orig(req)), finishReason: ++n === 1 ? "length" : "stop" });
    const out = await generateLive({ llm, task: parsed(), config: live, context: null });
    expect(out.repaired).toBe(true);
    expect(llm.requests[1]!.messages[2]!.content).toContain("truncated");
  });

  it("retries without response_format when the model rejects it", async () => {
    const llm = new FakeLlm((req) => (req.responseFormat ? new AiGatewayError("AI run failed: 400 response_format not supported", 400, false) : good));
    const out = await generateLive({ llm, task: parsed(), config: live, context: null });
    expect(out.repaired).toBe(false);
    expect(llm.requests.map((r) => Boolean(r.responseFormat))).toEqual([true, false]);
  });

  it("asks for JSON schema output by default and adds no temperature", async () => {
    const llm = new FakeLlm(() => good);
    await generateLive({ llm, task: parsed(), config: live, context: null });
    expect(llm.requests[0]!.responseFormat).toEqual(CHANGE_SET_RESPONSE_FORMAT);
    expect(llm.requests[0]).not.toHaveProperty("temperature");
  });
});

describe("tolerant extraction", () => {
  const cs = (o: unknown) => parseChangeSet(typeof o === "string" ? o : JSON.stringify(o)).files;
  it("handles fences, leading prose and trailing prose containing braces", () => {
    expect(cs("```json\n" + good + "\n```")).toHaveLength(2);
    expect(cs("Sure! Here is the change:\n" + good + "\nHope {this} helps }")).toHaveLength(2);
    expect(cs("I will first think.\n```\nnot json\n```\nFinal:\n```json\n" + good + "\n```")).toHaveLength(2);
  });
  it("accepts raw newlines in strings and a files map", () => {
    const raw = '{"files":[{"path":"a.md","content":"line1\nline2"}]}';
    expect(cs(raw)[0]!.content).toBe("line1\nline2");
    expect(escapeControlCharsInStrings('{"a":"x\ny"}')).toBe('{"a":"x\\ny"}');
    expect(cs({ files: { "a.md": "hi" } })).toEqual([{ path: "a.md", content: "hi" }]);
    expect(cs({ files: [{ filename: "a.md", contents: "hi" }] })).toEqual([{ path: "a.md", content: "hi" }]);
  });
  it("still enforces caps and path safety", () => {
    expect(() => cs({ files: [{ path: "../x", content: "" }] })).toThrow(/unsafe path/);
    expect(() => parseChangeSet("   ")).toThrow(/empty model output/);
  });
});

describe("reasoning-field handling (through the real client)", () => {
  it("ignores reasoning_content and parses the answer", async () => {
    const { createAiClient } = await import("@queenos/hive-kit");
    const ai = { run: async () => ({ choices: [{ message: { content: "```json\n" + good + "\n```", reasoning_content: "I should write {bad json" }, finish_reason: "stop" }] }) };
    const llm = createAiClient({ ai, gatewayId: "g" });
    const out = await generateLive({ llm, task: parsed(), config: live, context: null });
    expect(out.repaired).toBe(false);
    expect(out.changeSet.files).toHaveLength(2);
  });
  it("a reasoning-only reply (empty content) is unusable and triggers repair", async () => {
    const { createAiClient } = await import("@queenos/hive-kit");
    let n = 0;
    const ai = { run: async () => (++n === 1 ? { choices: [{ message: { content: null, reasoning_content: good }, finish_reason: "stop" }] } : { response: good }) };
    const out = await generateLive({ llm: createAiClient({ ai, gatewayId: "g" }), task: parsed(), config: live, context: null });
    expect(out.repaired).toBe(true);
  });
});

describe("template fit + registry merge for live output", () => {
  it("flags bad imports, TypeScript, missing exports and a broken router", () => {
    const files = (o: Record<string, string>) => validateChangeSet({ files: Object.entries(o).map(([path, content]) => ({ path, content })) });
    expect(templateFitProblems(files({ "src/a.ts": "export {}" }))).toEqual([expect.stringContaining("no TypeScript")]);
    expect(templateFitProblems(files({ "src/features/a.js": 'import x from "./nope.js";\nexport const slug="a";export function handle(){}' }))).toEqual([expect.stringContaining("does not exist")]);
    expect(templateFitProblems(files({ "src/features/a.js": "const x = require('y');" })).length).toBeGreaterThanOrEqual(2);
    expect(templateFitProblems(files({ "src/index.js": "export default {};" }))).toEqual([expect.stringContaining("/health")]);
    expect(templateFitProblems(files({ "src/features/a.js": 'import { u } from "../lib/util.js";\nexport const slug = "a";\nexport const handle = () => u;', "src/lib/util.js": "export const u = 1;" }))).toEqual([]);
    expect(templateFitProblems(files({ "src/features/a.js": 'import { u } from "../util.js";\nexport { slug, handle };' }), ["src/util.js"])).toEqual([]);
  });

  const existing = renderRegistry(["old.js"]);
  const repo = { readFiles: async () => ({ "src/features/index.js": existing }) };

  it("keeps earlier features when the model's registry only lists its own", async () => {
    const cs = validateChangeSet(JSON.parse(good));
    const merged = await withMergedRegistry(repo, cs.files);
    const reg = merged.find((f) => f.path === "src/features/index.js")!.content;
    expect(registryModules(reg)).toEqual(["old.js", "status.js"]);
  });
  it("registers a new module even if the model forgot (or botched) the registry", async () => {
    const noReg = validateChangeSet({ files: [JSON.parse(good).files[0]] });
    const merged = await withMergedRegistry(repo, noReg.files);
    expect(registryModules(merged.find((f) => f.path === "src/features/index.js")!.content)).toEqual(["old.js", "status.js"]);
    const quoted = validateChangeSet({ files: [JSON.parse(good).files[0], { path: "src/features/index.js", content: "import * as s from './status.js'\nexport const features = [s]" }] });
    const m2 = await withMergedRegistry(repo, quoted.files);
    expect(registryModules(m2.find((f) => f.path === "src/features/index.js")!.content)).toEqual(["old.js", "status.js"]);
  });
});

describe("prompt", () => {
  it("is concrete about the no-build template", () => {
    for (const s of ["relative imports", "src/features/index.js", "export const features", "export const slug", "export async function handle", "/health", "No npm"]) {
      expect(BUILDER_SYSTEM_PROMPT.toLowerCase()).toContain(s.toLowerCase());
    }
  });
  it("includes the file list and key files, capped", () => {
    const [m] = buildBuilderMessages(task() as never, { files: ["a.js", "b.js"], key: { "src/index.js": "x".repeat(50_000) } });
    expect(m!.content).toContain("<repo_files>\na.js\nb.js");
    expect(m!.content).toContain('<file path="src/index.js">');
    expect(m!.content.length).toBeLessThan(10_000);
  });
});

describe("through the workflow body", () => {
  it("reports model, failedModels and buildMs to the Queen and records the real model in the ledger", async () => {
    const w = new FakeWorld();
    await w.git.seed("hive-train-aaaaaaaaaaaa", { "src/features/index.js": renderRegistry([]), "src/index.js": "export default {};", ".queen/deploy.json": "{}" });
    w.llm = new FakeLlm((req) => (req.model === "@cf/second" ? good : "bad"));
    const out = await runDrone(task({ modelChoice: choice("@cf/first", ["@cf/second"]) }), new InlineSteps(), w.ports(), live);
    expect(out.status).toBe("built");
    const q = w.queen("hive");
    expect(q.calls.find((c) => c.method === "reportBuildResult")?.input).toMatchObject({ model: "@cf/second", failedModels: ["@cf/first"], buildMs: expect.any(Number) });
    expect(q.audits()[1]!.gitNotesPayload).toMatchObject({ model: "@cf/second", result: "success" });
  });
});

describe("scripted mode is unchanged and the test default", () => {
  it("makes no LLM call and records the scripted model", async () => {
    const llm = new FakeLlm(() => "should not be called");
    const w = new FakeWorld();
    const gen = await generateChangeSet(parsed(), { llm, artifacts: w.artifacts, git: w.git }, readConfig({}));
    expect(gen).toMatchObject({ model: SCRIPTED_MODEL, failedModels: [] });
    expect(llm.requests).toHaveLength(0);
    expect(w.artifacts.calls).toEqual([]);
  });
});

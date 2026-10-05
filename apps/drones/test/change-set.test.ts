import { describe, expect, it } from "vitest";
import { ChangeSetError, MAX_FILE_BYTES, MAX_FILES, parseChangeSet, validateChangeSet } from "../src/change-set";
import { readConfig, ConfigError } from "../src/config";
import { SCRIPTED_MODEL, fnv1a, mergeRegistry, registryModules, renderRegistry, scriptedChangeSet, slugify } from "../src/scripted";
import { buildBuilderMessages } from "../src/prompt";

const ok = { files: [{ path: "src/a.ts", content: "export {};\n" }], reasoningSteps: ["r"], discardedPaths: [] };

describe("change set validation", () => {
  it("accepts a valid set and defaults the optional arrays", () => {
    expect(validateChangeSet({ files: ok.files })).toEqual({ files: ok.files, reasoningSteps: [], discardedPaths: [] });
  });

  it("normalizes ./ paths", () => {
    expect(validateChangeSet({ files: [{ path: "./x/y.md", content: "" }] }).files[0]!.path).toBe("x/y.md");
  });

  it.each([
    ["absolute path", { files: [{ path: "/etc/passwd", content: "" }] }],
    ["traversal", { files: [{ path: "a/../../b", content: "" }] }],
    ["git dir", { files: [{ path: ".git/config", content: "" }] }],
    ["reserved ledger dir", { files: [{ path: ".queen/ledger/x.json", content: "" }] }],
    ["no files", { files: [] }],
    ["too many files", { files: Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ path: `f${i}`, content: "" })) }],
    ["file too large", { files: [{ path: "big", content: "x".repeat(MAX_FILE_BYTES + 1) }] }],
    ["duplicate paths", { files: [{ path: "a", content: "1" }, { path: "./a", content: "2" }] }],
    ["wrong types", { files: [{ path: "a", content: 1 }] }],
    ["total too large", { files: Array.from({ length: 9 }, (_, i) => ({ path: `f${i}`, content: "x".repeat(MAX_FILE_BYTES) })) }],
  ])("rejects %s", (_name, raw) => {
    expect(() => validateChangeSet(raw)).toThrow(ChangeSetError);
  });

  it("parses fenced or prose-wrapped JSON from the model", () => {
    expect(parseChangeSet("```json\n" + JSON.stringify(ok) + "\n```").files).toHaveLength(1);
    expect(parseChangeSet("Here you go:\n" + JSON.stringify(ok) + "\nDone.").files).toHaveLength(1);
    expect(() => parseChangeSet("no json here")).toThrow(ChangeSetError);
    expect(() => parseChangeSet("{not: json}")).toThrow(/not valid JSON/);
  });
});

describe("scripted generator", () => {
  const t = { promptId: "p-1", promptText: "Add a Dark Mode toggle!", action: "BUILD" as const, ragContext: [] };

  it("is deterministic and valid", () => {
    const a = scriptedChangeSet(t);
    expect(scriptedChangeSet(t)).toEqual(a);
    expect(validateChangeSet(a)).toEqual(a);
    const id = fnv1a("p-1:Add a Dark Mode toggle!");
    expect(a.files.map((f) => f.path)).toEqual([
      `features/add-a-dark-mode-toggle-${id}.md`,
      `src/features/add-a-dark-mode-toggle-${id}.js`,
      "src/features/index.js",
    ]);
    expect(a.files[0]!.content).toContain("Add a Dark Mode toggle!");
    expect(a.reasoningSteps.length).toBeGreaterThanOrEqual(3);
    expect(a.discardedPaths.length).toBe(1);
  });

  it("differs per prompt id so identical prompts never produce a no-op commit", () => {
    const b = scriptedChangeSet({ ...t, promptId: "p-2" });
    expect(b.files[0]!.path).not.toBe(scriptedChangeSet(t).files[0]!.path);
  });

  it("uses the Scribe summary and RAG memory on rework", () => {
    const r = scriptedChangeSet({ ...t, action: "REWORK", scribeSummary: "tests failed on null theme", ragContext: ["theme.ts uses tokens"] });
    expect(r.files[0]!.content).toContain("tests failed on null theme");
    expect(r.files[0]!.content).toContain("theme.ts uses tokens");
    expect(r.files[1]!.content).toContain("revision = 2");
    expect(r.reasoningSteps.join(" ")).toMatch(/Rework/);
  });

  /** Evaluate a generated ES module: strip `export` and collect the named exports. */
  const load = (code: string) =>
    new Function(`${code.replace(/^export /gm, "")}; return { slug, revision, handle, guard: typeof guard === "function" ? guard : undefined };`)() as {
      slug: string;
      revision: number;
      handle(): Response;
      guard?: () => void;
    };

  it("emits a deployable JS module that serves /features/<slug> and a matching registry", async () => {
    const a = scriptedChangeSet(t);
    const mod = load(a.files[1]!.content);
    expect(mod.slug).toBe("add-a-dark-mode-toggle");
    expect(mod.guard).toBeUndefined();
    expect(await mod.handle().json()).toEqual({ feature: "add-a-dark-mode-toggle", promptId: "p-1", revision: 1, enabled: true });
    const file = a.files[1]!.path.replace("src/features/", "");
    expect(a.files[2]!.content).toBe(renderRegistry([file]));
    expect(a.files[2]!.content).toContain(`import * as f0 from "./${file}";`);
    expect(a.files[2]!.content).toContain("export const features = [f0];");
  });

  it("[fail] on the first BUILD ships a guard that throws; the REWORK fixes it", () => {
    const bad = scriptedChangeSet({ ...t, promptText: "Add retries [fail]" });
    expect(() => load(bad.files[1]!.content).guard!()).toThrow(TypeError);
    const fixed = scriptedChangeSet({ ...t, promptText: "Add retries [fail]", action: "REWORK", scribeSummary: "GET / returned 500" });
    expect(load(fixed.files[1]!.content).guard).toBeUndefined();
    expect(load(fixed.files[1]!.content).revision).toBe(2);
    // Same module path, so the rework overwrites the buggy file.
    expect(fixed.files[1]!.path).toBe(bad.files[1]!.path);
    expect(fixed.files[0]!.content).toMatch(/^## Rework\s*$/m);
    // Prompts without the marker never ship the bug.
    expect(load(scriptedChangeSet(t).files[1]!.content).guard).toBeUndefined();
  });

  it("merges the registry with features already on the train", () => {
    const first = renderRegistry(["b-1.js"]);
    const merged = mergeRegistry(first, ["a-2.js", "b-1.js"]);
    expect(registryModules(merged)).toEqual(["a-2.js", "b-1.js"]);
    expect(merged).toContain("export const features = [f0, f1];");
    expect(mergeRegistry(null, ["x.js"])).toBe(renderRegistry(["x.js"]));
    expect(renderRegistry([])).toContain("export const features = [];");
  });

  it("slugifies safely", () => {
    expect(slugify("  ¡Héllo, World!  ")).toBe("hello-world");
    expect(slugify("!!!")).toBe("feature");
    expect(slugify("a".repeat(100)).length).toBe(40);
  });
});

describe("builder prompt", () => {
  it("includes RAG memory, the rework summary and the request", () => {
    const [m] = buildBuilderMessages({ promptText: "do x", action: "REWORK", ragContext: ["mem1"], scribeSummary: "it broke" });
    expect(m!.role).toBe("user");
    expect(m!.content).toContain("<hive_memory>");
    expect(m!.content).toContain("mem1");
    expect(m!.content).toContain("it broke");
    expect(m!.content).toMatch(/<request>\ndo x\n<\/request>/);
  });
  it("omits the failure block for BUILD", () => {
    const [m] = buildBuilderMessages({ promptText: "do x", action: "BUILD", ragContext: [], scribeSummary: "ignored" });
    expect(m!.content).not.toContain("previous_failure");
  });
});

describe("config", () => {
  it("defaults to scripted mode", () => {
    const c = readConfig({});
    expect(c.llmMode).toBe("scripted");
    expect(c.aiGateway.model).toBe("@cf/zai-org/glm-5.3-flash");
    expect(c.sendTemperature).toBe(false);
    expect(SCRIPTED_MODEL).toMatch(/scripted/);
  });
  it("resolves the Builder model and gateway id from vars", () => {
    expect(readConfig({ DRONE_LLM_MODE: "live" }).aiGateway).toEqual({ gatewayId: "queenos", model: "@cf/zai-org/glm-5.3-flash" });
    const c = readConfig({ DRONE_LLM_MODE: "live", AI_GATEWAY_ID: "g", MODEL_BUILDER: "@cf/meta/llama-3.1-8b-instruct", AI_TEMPERATURE: "0.3" });
    expect(c.aiGateway).toEqual({ gatewayId: "g", model: "@cf/meta/llama-3.1-8b-instruct" });
    expect(c).toMatchObject({ temperature: 0.3, sendTemperature: true });
  });
  it("rejects unknown modes and caps the scripted delay", () => {
    expect(() => readConfig({ DRONE_LLM_MODE: "yolo" })).toThrow(ConfigError);
    expect(readConfig({ DRONE_SCRIPTED_DELAY_MS: "999999" }).scriptedDelayMs).toBe(60_000);
  });
});

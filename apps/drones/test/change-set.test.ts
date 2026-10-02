import { describe, expect, it } from "vitest";
import { ChangeSetError, MAX_FILE_BYTES, MAX_FILES, parseChangeSet, validateChangeSet } from "../src/change-set";
import { DEFAULT_MODEL, readConfig, ConfigError } from "../src/config";
import { SCRIPTED_MODEL, fnv1a, scriptedChangeSet, slugify } from "../src/scripted";
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
    expect(a.files.map((f) => f.path)).toEqual([`features/add-a-dark-mode-toggle-${id}.md`, `src/features/add-a-dark-mode-toggle-${id}.ts`]);
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
    expect(r.files[1]!.content).toContain("revision: 2");
    expect(r.reasoningSteps.join(" ")).toMatch(/Rework/);
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
    expect(m!.content).toMatch(/<request>\ndo x\n<\/request>$/);
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
    expect(c.aiGateway.model).toBe(DEFAULT_MODEL);
    expect(c.sendTemperature).toBe(false);
    expect(SCRIPTED_MODEL).toMatch(/scripted/);
  });
  it("live mode requires gateway ids and the CF_AIG_TOKEN secret", () => {
    expect(() => readConfig({ DRONE_LLM_MODE: "live", AI_GATEWAY_ACCOUNT_ID: "a", AI_GATEWAY_ID: "g" })).toThrow(/CF_AIG_TOKEN/);
    expect(() => readConfig({ DRONE_LLM_MODE: "live", CF_AIG_TOKEN: "t" })).toThrow(ConfigError);
    const c = readConfig({ DRONE_LLM_MODE: "live", AI_GATEWAY_ACCOUNT_ID: "a", AI_GATEWAY_ID: "g", CF_AIG_TOKEN: "t", AI_TEMPERATURE: "0.3" });
    expect(c.aiGateway).toEqual({ accountId: "a", gatewayId: "g", provider: "anthropic", model: DEFAULT_MODEL });
    expect(c).toMatchObject({ temperature: 0.3, sendTemperature: true });
  });
  it("rejects unknown modes and caps the scripted delay", () => {
    expect(() => readConfig({ DRONE_LLM_MODE: "yolo" })).toThrow(ConfigError);
    expect(readConfig({ DRONE_SCRIPTED_DELAY_MS: "999999" }).scriptedDelayMs).toBe(60_000);
  });
});

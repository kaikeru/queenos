import { describe, expect, it } from "vitest";
import { decomposeSchema, parseDecomposition, systemPrompt, userPrompt } from "../src/prompt";

describe("prompt", () => {
  it("states the same-file dependency rule, the fewer-items rule and new-files rule", () => {
    const s = systemPrompt(5);
    expect(s).toMatch(/same existing file MUST depend on each other/);
    expect(s).toMatch(/Prefer fewer, independent items/);
    expect(s).toMatch(/New features go in new files/);
    expect(s).toContain("Never return more than 5");
  });

  it("schema requires paths and caps children", () => {
    const schema = decomposeSchema(3) as { properties: { children: { maxItems: number; items: { required: string[] } } } };
    expect(schema.properties.children.maxItems).toBe(3);
    expect(schema.properties.children.items.required).toContain("paths");
  });

  it("user prompt lists files and open items, and survives an empty listing", () => {
    const u = userPrompt({ promptText: "goal", files: ["a.js"], openItems: [{ itemId: "i", title: "T", status: "READY", paths: ["x.js"] }] });
    expect(u).toContain("a.js");
    expect(u).toContain("T [READY] paths: x.js");
    expect(userPrompt({ promptText: "g", files: [], openItems: [] })).toContain("listing unavailable");
  });
});

describe("parseDecomposition", () => {
  const child = (o: object) => ({ key: "c1", kind: "feature", title: "T", body: "b", acceptance: ["a"], priority: 1, difficulty: "normal", dependsOn: [], paths: ["src/a.js"], ...o });

  it("parses fenced JSON wrapped in prose", () => {
    const out = parseDecomposition("Sure!\n```json\n" + JSON.stringify({ children: [child({})] }) + "\n```", 4);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: "c1", title: "T", paths: ["src/a.js"], priority: 1 });
  });

  it("accepts a bare array, repairs keys and enums, drops bad paths and deps", () => {
    const out = parseDecomposition(
      JSON.stringify([
        child({ key: "x", kind: "weird", paths: ["/etc/passwd", "../up", "src/ok.js", "src/ok.js", "dir/"], priority: 9, dependsOn: ["c2", "c9", "c1"] }),
        child({ key: "c1", title: "Second", dependsOn: ["c1"] }),
      ]),
      4,
    );
    expect(out.map((c) => c.key)).toEqual(["c1", "c2"]);
    expect(out[0]).toMatchObject({ kind: "feature", paths: ["src/ok.js", "dir/"], priority: 3 });
    // original "x" became c1; the duplicate "c1" was re-keyed c2
    expect(out[0]!.dependsOn).toEqual(["c2"]);
    expect(out[1]!.dependsOn).toEqual(["c1"]); // re-keyed c2 depends on c1
  });

  it("caps to maxChildren and drops edges to dropped children", () => {
    const out = parseDecomposition(JSON.stringify({ children: [child({ key: "c1", dependsOn: ["c3"] }), child({ key: "c2", title: "B" }), child({ key: "c3", title: "C" })] }), 2);
    expect(out).toHaveLength(2);
    expect(out[0]!.dependsOn).toEqual([]);
  });

  it("returns [] for garbage and skips untitled children", () => {
    expect(parseDecomposition("I cannot do that", 4)).toEqual([]);
    expect(parseDecomposition(JSON.stringify({ children: [child({ title: "" })] }), 4)).toEqual([]);
  });
});

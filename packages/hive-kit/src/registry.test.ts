import { describe, expect, it } from "vitest";
import { FEATURE_REGISTRY_PATH, REGISTRY_HEADER, featureModuleName, mergeRegistry, registryModules, renderRegistry } from "./registry.js";

describe("feature registry", () => {
  it("is the generated path", () => {
    expect(FEATURE_REGISTRY_PATH).toBe("src/features/index.js");
  });

  it("the header invites editing in the exact shape (it no longer says GENERATED / do not edit)", () => {
    expect(REGISTRY_HEADER.startsWith("// Feature registry. Keep this exact shape")).toBe(true);
    expect(REGISTRY_HEADER).toContain("QueenOS merges it line by line");
    expect(REGISTRY_HEADER).not.toMatch(/GENERATED|Do not edit/i);
    expect(REGISTRY_HEADER).not.toContain("\n");
  });

  it("renders sorted, deduplicated imports", () => {
    expect(renderRegistry(["b.js", "a.js", "b.js"])).toBe(
      [REGISTRY_HEADER, 'import * as f0 from "./a.js";', 'import * as f1 from "./b.js";', "export const features = [f0, f1];", ""].join("\n"),
    );
    expect(renderRegistry([])).toContain("export const features = [];");
  });

  it("reads modules back (any import style), ignoring itself", () => {
    const src = `import * as a from "./a.js";\nimport b from './b.js';\nimport { c } from "./c.js";\nimport x from "./index.js";`;
    expect(registryModules(src)).toEqual(["a.js", "b.js", "c.js"]);
    expect(registryModules(renderRegistry(["z.js", "y.js"]))).toEqual(["y.js", "z.js"]);
  });

  it("maps feature module paths", () => {
    expect(featureModuleName("src/features/dark-1.js")).toBe("dark-1.js");
    expect(featureModuleName("src/features/index.js")).toBeNull();
    expect(featureModuleName("src/lib/x.js")).toBeNull();
    expect(featureModuleName("src/features/a/b.js")).toBeNull();
  });

  it("merges new modules into an existing registry", () => {
    expect(mergeRegistry(null, ["a.js"])).toBe(renderRegistry(["a.js"]));
    expect(mergeRegistry(renderRegistry(["b.js"]), ["a.js", "b.js"])).toBe(renderRegistry(["a.js", "b.js"]));
  });
});

import { describe, expect, it } from "vitest";
import { scanPolicy, scanTokens, checkSpecifier } from "../src/policy";
import { tokenize } from "../src/lex";

const allowedDeps = ["hono", "zod", "@queenos/*"];
const scan = (files: Record<string, string>) => scanPolicy(files, { allowedDeps });
const rules = (r: ReturnType<typeof scan>) => r.findings.map((f) => `${f.severity}:${f.rule}`);

describe("policy: package.json", () => {
  it("rejects a dependency that is not on the allowlist", () => {
    const r = scan({ "package.json": JSON.stringify({ dependencies: { hono: "^4", "left-pad": "^1" }, devDependencies: { "evil-dev": "1.0.0", "@queenos/queen-types": "workspace:*" } }) });
    expect(r.passed).toBe(false);
    expect(r.findings.map((f) => f.message)).toEqual([
      'dependencies: "left-pad" is not on the dependency allowlist',
      'devDependencies: "evil-dev" is not on the dependency allowlist',
    ]);
  });

  it("rejects git/url specs even for allowed names", () => {
    const r = scan({ "package.json": JSON.stringify({ dependencies: { zod: "github:attacker/zod" } }) });
    expect(rules(r)).toEqual(["error:remote-dependency"]);
  });

  it("accepts allowlisted deps and ignores node_modules", () => {
    const r = scan({
      "package.json": JSON.stringify({ dependencies: { hono: "^4" } }),
      "node_modules/x/package.json": JSON.stringify({ dependencies: { bad: "1" } }),
    });
    expect(r.passed).toBe(true);
    expect(r.filesScanned).toBe(1);
  });
});

describe("policy: imports (JS via acorn)", () => {
  it("flags Node built-ins in every import form", () => {
    const r = scan({
      "a.js": [
        'import fs from "fs";',
        'import { createHash } from "node:crypto";',
        'export * from "child_process";',
        'const p = require("path");',
        'const cp = await import("os");',
        'import { Hono } from "hono";',
      ].join("\n"),
    });
    expect(r.passed).toBe(false);
    expect(r.findings.filter((f) => f.rule === "node-builtin").map((f) => f.line)).toEqual([1, 2, 3, 4, 5]);
  });

  it("flags unapproved external modules, allows relative / cloudflare: / allowlisted", () => {
    const r = scan({ "a.mjs": 'import a from "lodash"; import b from "./b.js"; import c from "cloudflare:workers"; import d from "@queenos/hive-kit/sub"; import e from "zod";' });
    expect(r.findings.map((f) => f.message)).toEqual(['import of "lodash": package "lodash" is not on the allowlist']);
  });

  it("flags globalThis / self mutation and prototype pollution", () => {
    const r = scan({
      "g.js": [
        "globalThis.counter = 1;",
        'self["x"] = 2;',
        "Array.prototype.last = function () {};",
        'Object.defineProperty(globalThis, "k", { value: 1 });',
        'Object.assign(Object.prototype, { a: 1 });',
        "delete globalThis.fetch;",
        "const ok = globalThis.fetch; ok === 1;",
      ].join("\n"),
    });
    expect(r.findings.map((f) => `${f.line}:${f.rule}`)).toEqual([
      "1:global-mutation",
      "2:global-mutation",
      "3:prototype-mutation",
      "4:global-mutation",
      "5:prototype-mutation",
      "6:global-mutation",
    ]);
  });

  it("warns (not fails) on top-level mutable state", () => {
    const r = scan({ "s.js": "let hits = 0;\nexport var cache = {};\nconst fine = 1;\nfunction f() { let local = 1; return local; }" });
    expect(r.passed).toBe(true);
    expect(rules(r)).toEqual(["warning:top-level-mutable-state", "warning:top-level-mutable-state"]);
  });

  it("passes clean code, including text that merely looks like violations", () => {
    const r = scan({
      "ok.js": [
        'import { Hono } from "hono";',
        '// import fs from "fs"; globalThis.x = 1',
        'const s = "globalThis.x = 1; require(\\"fs\\")";',
        "export const app = new Hono();",
      ].join("\n"),
    });
    expect(r.passed).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it("falls back to the token scanner (with a warning) when acorn cannot parse", () => {
    const r = scan({ "jsx.js": 'import fs from "fs";\nconst x = <div/>;' });
    expect(rules(r)).toEqual(["warning:parse-fallback", "error:node-builtin"]);
  });
});

describe("policy: TypeScript (token scanner)", () => {
  const ts = `
import type { Foo } from "fs";
import { Hono, type Context } from "hono";
import crypto from "node:crypto";
interface Env { A: string; B: Map<string, Array<number>> }
export function handler<T extends Record<string, unknown>>(c: Context, x: T): Promise<Response> {
  const n = x as unknown as number;
  return fetch("/relative").then((r) => r) as Promise<Response>;
}
globalThis.__state = { n: 1 } as const;
String.prototype.shout = function (this: string): string { return this.toUpperCase(); };
let cache: Map<string, string> = new Map();
`;
  const r = scanTokens("src/x.ts", ts, allowedDeps);

  it("finds imports through type annotations and generics, ignoring type-only imports", () => {
    expect(r.filter((f) => f.rule === "node-builtin").map((f) => [f.line, f.message])).toEqual([[4, 'import of Node built-in "node:crypto" (Workers V8 isolates have no Node built-ins)']]);
  });

  it("finds global and prototype mutation", () => {
    expect(r.filter((f) => f.rule.endsWith("-mutation")).map((f) => `${f.line}:${f.rule}`)).toEqual(["10:global-mutation", "11:prototype-mutation"]);
  });

  it("warns on module-level let", () => {
    expect(r.filter((f) => f.rule === "top-level-mutable-state").map((f) => f.line)).toEqual([12]);
  });

  it("is routed for .ts/.tsx files by scanPolicy", () => {
    const res = scan({ "src/x.ts": ts, "src/y.tsx": 'import { useState } from "react";\nexport const Y = () => <div>don\'t</div>;' });
    expect(res.passed).toBe(false);
    expect(res.findings.some((f) => f.file === "src/y.tsx" && f.rule === "unapproved-module")).toBe(true);
  });

  it("passes a clean TS file with heavy type syntax", () => {
    const clean = `
import { Hono } from "hono";
import type { Env } from "./env";
export type Handler<E extends Env = Env> = (c: { env: E }) => Promise<Response>;
export const app = new Hono<{ Bindings: Env }>();
app.get("/", (c) => c.text("hi"));
const re = /globalThis\\.x = 1/;
`;
    expect(scan({ "src/clean.ts": clean }).findings).toEqual([]);
  });
});

describe("policy helpers", () => {
  it("checkSpecifier", () => {
    expect(checkSpecifier("fs/promises", [])?.rule).toBe("node-builtin");
    expect(checkSpecifier("./a", [])).toBeNull();
    expect(checkSpecifier("https://evil.example/x.js", [])?.rule).toBe("unapproved-module");
  });
  it("tokenize tracks depth and skips comments/strings", () => {
    const t = tokenize('const a = { b: "x // y" }; /* let z */ let q;');
    expect(t.find((x) => x.v === "let")?.depth).toBe(0);
    expect(t.some((x) => x.v === "z")).toBe(false);
  });
});

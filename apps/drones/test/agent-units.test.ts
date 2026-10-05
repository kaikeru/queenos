import { describe, expect, it } from "vitest";
import { diffTrees, overlayProblems, snapshotHash } from "../src/agent/overlay";
import { EMPTY_TOOL_STATE, MAX_VERIFY_CALLS, runFinish, runVerify, type DroneToolDeps, type ToolState } from "../src/agent/tools";
import { ledgerDiscarded, ledgerReasoning, traceFromParts, MAX_TRACE_LINES } from "../src/agent/trace";
import { verifyWorker, describeVerify } from "../src/agent/verify";
import { agentUserMessage, AGENT_SYSTEM_PROMPT } from "../src/agent/prompt";
import { templateFitProblems } from "../src/change-set";
import { FakeLoader, STARTER_FILES, starterResponses } from "./fakes";

const html = (files: Record<string, string>) => ({ ...files, "src/index.js": files["src/index.js"]!.replace('if (url.pathname === "/")', 'if (url.pathname === "/") return new Response("<html>"); if (false)') });
const changedOf = (files: Record<string, string>) => diffTrees(STARTER_FILES, files);

describe("verifyWorker (fake Worker Loader)", () => {
  it("loads every src/**/*.js as a module, entry from deploy.json, no network, and probes / and /health", async () => {
    const loader = new FakeLoader(starterResponses);
    const files = html(STARTER_FILES);
    const r = await verifyWorker(loader, { files, changed: changedOf(files), paths: ["/status"] });
    expect(r.ok).toBe(true);
    expect(r.probes.map((p) => [p.path, p.status])).toEqual([["/", 200], ["/health", 200], ["/status", 404]]);
    expect(r.probes[0]!.contentType).toMatch(/text\/html/);
    const load = loader.loads[0]!;
    expect(load.mainModule).toBe("src/index.js");
    expect(Object.keys(load.modules).sort()).toEqual(["src/features/index.js", "src/index.js"]);
    expect(load.globalOutbound).toBeNull();
    expect(load.compatibilityDate).toBe("2026-10-02");
    expect(load.limits?.cpuMs).toBe(100);
    expect(describeVerify(r)).toBe("verify / 200 text/html; /health 200 json; /status 404 json -> ok");
  });

  it("fails on a 5xx, on a non-JSON /health, and when the module throws on load", async () => {
    const loader = new FakeLoader(starterResponses);
    const five = await verifyWorker(loader, { files: STARTER_FILES, changed: { files: [], deletes: [] }, paths: ["/boom"] });
    expect(five).toMatchObject({ ok: false, error: "/boom returned 500" });
    const broken = { ...STARTER_FILES, "src/index.js": STARTER_FILES["src/index.js"] + "// BREAK_HEALTH\n" };
    expect((await verifyWorker(loader, { files: broken, changed: changedOf(broken) })).error).toMatch(/\/health must return 200 JSON/);
    const thrown = { ...STARTER_FILES, "src/index.js": "THROW_ON_LOAD" };
    expect(await verifyWorker(loader, { files: thrown, changed: changedOf(thrown) })).toMatchObject({ ok: false, error: expect.stringMatching(/SyntaxError/) });
  });

  it("reports template-fit problems and a missing entry module", async () => {
    const loader = new FakeLoader(starterResponses);
    const bad = { ...STARTER_FILES, "src/lib/x.js": 'import fs from "node:fs";\nexport const x = 1;\n' };
    const r = await verifyWorker(loader, { files: bad, changed: changedOf(bad) });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/node:fs/);
    const noEntry = { ...STARTER_FILES, ".queen/deploy.json": '{"main":"src/main.js"}' };
    expect(await verifyWorker(loader, { files: noEntry, changed: changedOf(noEntry) })).toMatchObject({ ok: false, error: "entry module src/main.js is missing" });
  });

  it("degrades to skipped (not failed) without a loader binding", async () => {
    expect(await verifyWorker(undefined, { files: STARTER_FILES, changed: { files: [], deletes: [] } })).toEqual({ ok: true, skipped: true, probes: [], problems: [] });
  });
});

describe("template routing (path exports)", () => {
  const mod = (extra: string) => ({ path: "src/features/status.js", content: `export const slug = "status";\n${extra}export async function handle() { return new Response("ok"); }\n` });
  it("accepts a literal top-level path and rejects router-owned or non-literal ones", () => {
    expect(templateFitProblems({ files: [mod('export const path = "/status";\n')] })).toEqual([]);
    for (const p of ["/health", "/", "/features/x", "status"]) {
      expect(templateFitProblems({ files: [mod(`export const path = "${p}";\n`)] })[0]).toMatch(/is not allowed/);
    }
    expect(templateFitProblems({ files: [mod("export const path = base + 1;\n")] })[0]).toMatch(/string literal/);
  });
  it("treats deleted files as gone for import resolution", () => {
    const files = [{ path: "src/a.js", content: 'import { b } from "./b.js";\nexport const a = b;\n' }];
    expect(templateFitProblems({ files }, ["src/b.js"])).toEqual([]);
    expect(templateFitProblems({ files, deletes: ["src/b.js"] }, ["src/b.js"])[0]).toMatch(/does not exist/);
  });
});

describe("overlay", () => {
  it("diffs adds, edits and deletes against the base", () => {
    const final: Record<string, string> = { ...STARTER_FILES, "src/index.js": "x", "src/lib/a.js": "a" };
    delete final["src/features/index.js"];
    expect(diffTrees(STARTER_FILES, final)).toEqual({
      files: [{ path: "src/index.js", content: "x" }, { path: "src/lib/a.js", content: "a" }],
      deletes: ["src/features/index.js"],
    });
  });
  it("rejects empty and platform-owned changes and oversized ones", () => {
    expect(overlayProblems({ files: [], deletes: [] })).toEqual(["no files were changed"]);
    expect(overlayProblems({ files: [{ path: ".queen/deploy.json", content: "{}" }, { path: "wrangler.jsonc", content: "" }], deletes: ["package.json"] })[0]).toMatch(
      /platform-owned.*\.queen\/deploy\.json, wrangler\.jsonc, package\.json/,
    );
    expect(overlayProblems({ files: [{ path: "src/big.js", content: "x".repeat(70_000) }], deletes: [] })[0]).toMatch(/exceeds 65536/);
  });
  it("hashes snapshots order-independently and content-sensitively", () => {
    expect(snapshotHash({ a: "1", b: "2" })).toBe(snapshotHash({ b: "2", a: "1" }));
    expect(snapshotHash({ a: "1" })).not.toBe(snapshotHash({ a: "2" }));
  });
});

describe("verify + finish tools", () => {
  function deps(loader = new FakeLoader(starterResponses)) {
    let files = { ...STARTER_FILES };
    let state: ToolState = EMPTY_TOOL_STATE;
    const d: DroneToolDeps = {
      snapshot: async () => ({ ...files }),
      base: () => STARTER_FILES,
      loader,
      state: { get: () => state, put: (s) => void (state = s) },
    };
    return { d, edit: (f: Record<string, string>) => void (files = f), state: () => state };
  }
  const finishArgs = { summary: "done", reasoningSteps: ["a"], discardedPaths: [] };

  it("refuses finish with no change, then without a passing verify of the final edit; accepts after", async () => {
    const t = deps();
    expect(await runFinish(t.d, finishArgs)).toEqual({ ok: false, error: expect.stringMatching(/no files were changed/) });
    t.edit(html(STARTER_FILES));
    expect(await runFinish(t.d, finishArgs)).toEqual({ ok: false, error: expect.stringMatching(/call verify/) });
    expect(await runVerify(t.d, undefined)).toMatchObject({ ok: true });
    t.edit({ ...html(STARTER_FILES), "src/lib/x.js": "export const x = 1;\n" }); // edit after verify
    expect(await runFinish(t.d, finishArgs)).toMatchObject({ ok: false });
    await runVerify(t.d, undefined);
    expect(await runFinish(t.d, finishArgs)).toEqual({ ok: true });
    expect(t.state().finish).toEqual(finishArgs);
  });

  it("refuses finish when a platform-owned file changed, even if verified", async () => {
    const t = deps();
    t.edit({ ...html(STARTER_FILES), "package.json": "{}" });
    await runVerify(t.d, undefined);
    expect(await runFinish(t.d, finishArgs)).toEqual({ ok: false, error: expect.stringMatching(/platform-owned.*package\.json/) });
  });

  it("a failing verify does not unlock finish, and verify is capped", async () => {
    const t = deps();
    t.edit({ ...STARTER_FILES, "src/index.js": STARTER_FILES["src/index.js"] + "// BREAK_HEALTH\n" });
    expect(await runVerify(t.d, undefined)).toMatchObject({ ok: false });
    expect(await runFinish(t.d, finishArgs)).toMatchObject({ ok: false });
    for (let i = 1; i < MAX_VERIFY_CALLS; i++) await runVerify(t.d, undefined);
    expect(await runVerify(t.d, undefined)).toEqual({ ok: false, error: expect.stringMatching(/budget exhausted/) });
  });
});

describe("trace + ledger mapping", () => {
  it("turns persisted tool parts into compact numbered lines", () => {
    const parts = [
      { type: "text" },
      { type: "tool-list", state: "output-available", input: { path: "/" }, output: [] },
      { type: "tool-read", state: "output-available", input: { path: "/src/index.js" }, output: "..." },
      { type: "tool-read", state: "output-available", input: { path: "/src/index.js" }, output: "..." },
      { type: "tool-edit", state: "output-error", input: { path: "/src/index.js" }, errorText: "old_string not found" },
      { type: "tool-grep", state: "output-available", input: { pattern: "health" }, output: "" },
      { type: "tool-verify", state: "output-available", input: {}, output: { ok: true, probes: [{ path: "/", status: 200, contentType: "text/html", bodyStart: "" }], problems: [] } },
      { type: "tool-finish", state: "output-available", input: {}, output: { ok: false, error: "finish refused: x" } },
      { type: "tool-finish", state: "output-available", input: {}, output: { ok: true } },
      { type: "tool-write", state: "input-streaming", input: {} },
    ];
    expect(traceFromParts(parts)).toEqual([
      "t1 list",
      "t2 read src/index.js",
      "t3 edit src/index.js -> error: old_string not found",
      't4 grep "health"',
      "t5 verify / 200 text/html -> ok",
      "t6 finish refused: finish refused: x",
    ]);
  });

  it("caps long traces, keeping the tail", () => {
    const parts = Array.from({ length: 30 }, (_, i) => ({ type: "tool-read", state: "output-available", input: { path: `/f${i}.js` } }));
    const t = traceFromParts(parts);
    expect(t).toHaveLength(MAX_TRACE_LINES);
    expect(t[0]).toBe("… 17 earlier tool call(s)");
    expect(t.at(-1)).toBe("t30 read f29.js");
  });

  it("maps finish + trace + failed models onto ledger fields within caps", () => {
    const finish = { summary: "Serve HTML", reasoningSteps: ["a", "b"], discardedPaths: ["feature page"] };
    const r = ledgerReasoning(finish, Array.from({ length: 30 }, (_, i) => `t${i}`));
    expect(r.slice(0, 3)).toEqual(["Summary: Serve HTML", "a", "b"]);
    expect(r).toHaveLength(20);
    expect(ledgerDiscarded(finish, [{ model: "m1", reason: "timeout" }])).toEqual(["feature page", "model m1: timeout"]);
    expect(ledgerReasoning(null, [])).toEqual([]);
  });
});

describe("agent prompt", () => {
  it("puts REWORK feedback first and frames hive memory as lessons", () => {
    const msg = agentUserMessage({
      action: "REWORK",
      promptText: "Change / to HTML",
      scribeSummary: "Made /features/status instead of changing /",
      ragContext: ["[REJECTED_BY_REVIEW] added a feature page", "[PASSED] edited the router"],
    });
    expect(msg.indexOf("<rework_feedback>")).toBe(0);
    expect(msg).toMatch(/Avoid what was REJECTED_BY_REVIEW or FAILED; reuse what PASSED/);
    expect(msg.indexOf("<hive_memory>")).toBeLessThan(msg.indexOf("<request>"));
    expect(agentUserMessage({ action: "BUILD", promptText: "x", ragContext: [] })).not.toMatch(/hive_memory|rework_feedback/);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/edit the code that implements it/);
  });
});

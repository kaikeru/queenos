import { describe, expect, it } from "vitest";
import { AiGatewayError, type CompletionRequest, type CompletionResult } from "@queenos/hive-kit";
import type { GateTarget, SubmissionOrigin } from "@queenos/queen-types";
import { changedBetween } from "../src/inspect";
import { scanProtectedPaths } from "../src/policy";
import { runGate } from "../src/orchestrate";
import type { ScribeLlm } from "../src/scribe";
import { FakeWorld, InlineSteps, REPO, config, gateTask } from "./fakes";

const HUMAN: SubmissionOrigin = { kind: "human", id: "kyle@example.com" };
const AGENT: SubmissionOrigin = { kind: "agent", id: "claude-code" };
const BASE_FILES = { "src/x.js": "export const x = 1;\n", "src/y.js": "export const y = 2;\n", "README.md": "# hive\n" };

function target(baseSha: string | null, origin?: SubmissionOrigin): GateTarget {
  return { trainId: "train-1", lane: "BUILD", promptId: "prompt-1", promptText: "Fix x", previewUrl: null, phase: "TESTING", traceId: null, baseSha, ...(origin ? { origin } : {}) };
}

/** A fork seeded with BASE_FILES; `edit` is a pushed commit with a plain message (no drone path list). */
async function pushed(changes: Record<string, string | null>, origin?: SubmissionOrigin, opts: { baseSha?: string | null } = {}) {
  const w = new FakeWorld();
  const base = await w.git.seed(REPO, BASE_FILES);
  const r = w.git.repo(REPO);
  await r.writeFiles(Object.entries(changes).map(([path, content]) => (content === null ? { path, delete: true as const } : { path, content })));
  const after = await r.commitAll({ message: "fix things", timestamp: 1_790_000_100 });
  w.queen.train.headSha = after;
  w.queen.serveTarget(target(opts.baseSha === undefined ? base : opts.baseSha, origin));
  return { w, base, after };
}

const gate = (w: FakeWorld, after: string, vars: Record<string, string> = {}) => runGate(gateTask(after), new InlineSteps(), w.ports(), config(vars));

describe("changedBetween: tree comparison for BUILD gates", () => {
  it("a human commit that only MODIFIES a file with eval( fails the gate on an in-diff security error", async () => {
    const { w, after } = await pushed({ "src/x.js": "export const x = eval('1');\n" }, HUMAN);
    const out = await gate(w, after);
    expect(out).toMatchObject({ status: "gated", passed: false });
    expect(w.queen.auditSeq()).toContain("SECURITY:REJECTED");
    const report = w.queen.reports()[0]!;
    expect(report.passed).toBe(false);
    expect(report.followUps).toBeUndefined();
    expect(report.changedPaths).toEqual(["src/x.js"]);
  });

  it("counts a deleted file and reports every changed path (added, modified, deleted)", async () => {
    const { w, after } = await pushed({ "src/x.js": "export const x = 10;\n", "src/y.js": null, "src/new.js": "export const n = 1;\n" }, HUMAN);
    const out = await gate(w, after);
    expect(out).toMatchObject({ passed: true });
    expect(w.queen.reports()[0]!.changedPaths).toEqual(["src/new.js", "src/x.js", "src/y.js"]);
    expect(w.queen.reports()[0]!.score).toMatchObject({ changedFiles: 3 });
  });

  it("changedBetween returns added, modified and deleted paths, and null for an unknown base", async () => {
    const { w, base, after } = await pushed({ "src/x.js": "export const x = 333;\n", "src/y.js": null, "z.txt": "z\n" });
    const repo = await w.git.clone({ remote: `https://acct.artifacts.cloudflare.net/git/queenos/${REPO}.git`, token: "t", ref: "main", depth: 100 });
    expect([...(await changedBetween(repo, base, after))!].sort()).toEqual(["src/x.js", "src/y.js", "z.txt"]);
    expect(await changedBetween(repo, "f".repeat(40), after)).toBeNull();
  });

  it("a drone flow is unchanged: message-listed paths, no protected-path rule, same pass", async () => {
    const w = new FakeWorld();
    const base = await w.git.seed(REPO, BASE_FILES);
    const after = await w.git.build(REPO, { prompt: "Add a dark mode toggle", files: { "src/features/dark.ts": "export const dark = true as const;\n", "package.json": JSON.stringify({ name: "x" }) } });
    w.queen.train.headSha = after;
    w.queen.serveTarget(target(base)); // origin absent = drone
    const out = await gate(w, after);
    expect(out).toMatchObject({ passed: true });
    expect(w.queen.reports()[0]!.changedPaths).toEqual(["package.json", "src/features/dark.ts"]);
    expect(w.queen.auditSeq()).not.toContain("POLICY:REJECTED");
  });

  it("a missing base falls back to the commit walk (an added file is still seen)", async () => {
    const { w, after } = await pushed({ "src/added.js": "export const a = eval('1');\n" }, HUMAN, { baseSha: null });
    const out = await gate(w, after);
    expect(out).toMatchObject({ passed: false });
    expect(w.git.clones[0]!.depth).toBe(4);
    expect(w.logs.some((l) => l["diffSource"] === "fallback")).toBe(true);
  });

  it("an unreadable base (not in the clone) falls back too, and still sees a modification via the parent diff", async () => {
    const { w, after } = await pushed({ "src/x.js": "export const x = eval('1');\n" }, HUMAN, { baseSha: "f".repeat(40) });
    const out = await gate(w, after);
    expect(out).toMatchObject({ passed: false });
    expect(w.logs.some((l) => l["diffSource"] === "fallback")).toBe(true);
  });

  it("uses the tree diff (diffSource tree) when the base is known", async () => {
    const { w, after } = await pushed({ "src/x.js": "export const x = 555;\n" }, HUMAN);
    await gate(w, after);
    expect(w.logs.some((l) => l["diffSource"] === "tree" && l["origin"] === "human")).toBe(true);
  });
});

describe("protected paths", () => {
  it("scanProtectedPaths matches .queen/**, wrangler.* and package.json at any depth", () => {
    expect(scanProtectedPaths([".queen/policy.json", "wrangler.toml", "apps/a/wrangler.jsonc", "apps/a/package.json", "src/package.json.ts", "src/wrangler/x.ts", "docs/queen.md"]).map((f) => f.file)).toEqual([
      ".queen/policy.json",
      "apps/a/package.json",
      "apps/a/wrangler.jsonc",
      "wrangler.toml",
    ]);
  });

  it("a human change to wrangler.toml is a policy error with a clear finding", async () => {
    const { w, after } = await pushed({ "wrangler.toml": 'name = "evil"\n' }, HUMAN);
    const out = await gate(w, after);
    expect(out).toMatchObject({ passed: false });
    expect(w.queen.auditSeq()).toContain("POLICY:REJECTED");
    expect(w.queen.audits().find((a) => a.droneRole === "POLICY" && a.status === "REJECTED")!.gitNotesPayload!.reasoningSteps.join("\n")).toContain("protected-path");
  });

  it("an agent deleting .queen/x.json is also rejected (deletions count)", async () => {
    const w = new FakeWorld();
    const base = await w.git.seed(REPO, { ...BASE_FILES, ".queen/x.json": "{}\n" });
    const r = w.git.repo(REPO);
    await r.writeFiles([{ path: ".queen/x.json", delete: true }]);
    const after = await r.commitAll({ message: "rm", timestamp: 1_790_000_100 });
    w.queen.train.headSha = after;
    w.queen.serveTarget(target(base, AGENT));
    expect(await gate(w, after)).toMatchObject({ passed: false });
    expect(w.queen.auditSeq()).toContain("POLICY:REJECTED");
  });

  it("the same package.json edit from a drone is allowed", async () => {
    const w = new FakeWorld();
    const base = await w.git.seed(REPO, { ...BASE_FILES, "package.json": JSON.stringify({ name: "x" }) });
    const after = await w.git.build(REPO, { prompt: "bump", files: { "package.json": JSON.stringify({ name: "x", version: "2.0.0" }) } });
    w.queen.train.headSha = after;
    w.queen.serveTarget(target(base, { kind: "drone", id: "t-build" }));
    expect(await gate(w, after)).toMatchObject({ passed: true });
  });
});

class ErrLlm implements ScribeLlm {
  calls = 0;
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls++;
    throw new AiGatewayError("overloaded", 529, true);
    void req;
  }
}

describe("reviewer fails closed for non-drone origin", () => {
  const llm = { REVIEW_MODE: "llm", REVIEW_TIMEOUT_MS: "50" };

  it("human origin, reviewer errors: the gate does not pass; reported as infra", async () => {
    const { w, after } = await pushed({ "src/x.js": "export const x = 999;\n" }, HUMAN);
    w.reviewLlm = new ErrLlm();
    const out = await gate(w, after, { ...llm, GATE_INFRA_ROUNDS: "1" });
    expect(out).toMatchObject({ status: "gated", passed: false, infra: true });
    const r = w.queen.reports();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ passed: false, cause: "infra" });
    expect(w.queen.auditSeq()).toContain("REVIEWER:REJECTED");
    expect(w.queen.auditSeq()).not.toContain("REVIEWER:PASSED");
  });

  it("human origin, no AI binding: same", async () => {
    const { w, after } = await pushed({ "src/x.js": "export const x = 999;\n" }, AGENT);
    w.reviewLlm = null;
    const out = await gate(w, after, { ...llm, GATE_INFRA_ROUNDS: "1" });
    expect(out).toMatchObject({ passed: false, infra: true });
    expect(w.queen.reports()[0]).toMatchObject({ cause: "infra" });
  });

  it("drone origin keeps failing open", async () => {
    const { w, after } = await pushed({ "src/x.js": "export const x = 999;\n" }, { kind: "drone", id: "t-build" });
    w.reviewLlm = new ErrLlm();
    const out = await gate(w, after, llm);
    expect(out).toMatchObject({ passed: true, review: "skipped" });
    expect(w.queen.auditSeq()).toContain("REVIEWER:PASSED");
  });
});

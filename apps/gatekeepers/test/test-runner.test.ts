import { describe, expect, it } from "vitest";
import { NonRetryableError } from "cloudflare:workflows";
import { SandboxTestRunner, ScriptedTestRunner, createTestRunner, isRework, type TestInput } from "../src/test-runner";
import { firstErrorLine } from "../src/scribe";

const input = (o: Partial<TestInput> = {}): TestInput => ({
  repo: "hive-train-aaaaaaaaaaaa",
  trainId: "t1",
  after: "a".repeat(40),
  changedPaths: ["features/x.md"],
  changedFiles: { "features/x.md": "# x\n\n## Request\n\nAdd dark mode\n" },
  commitMessages: ["queen(build): Add dark mode\n\n- features/x.md\n"],
  fileCount: 12,
  ...o,
});
const runner = new ScriptedTestRunner();

describe("scripted test runner", () => {
  it("passes deterministically with a realistic multi-line log", async () => {
    const a = await runner.run(input());
    const b = await runner.run(input());
    expect(a.passed).toBe(true);
    expect(a.checks).toBe(19);
    expect(a.log.split("\n").length).toBeGreaterThan(10);
    expect(a.log).toContain("Tests  19 passed (19)");
    expect(a).toEqual(b);
  });

  it("fails when a changed file carries [fail], with a long stack trace", async () => {
    const r = await runner.run(input({ changedFiles: { "features/x.md": "## Request\n\nFix retries [fail]\n" } }));
    expect(r.passed).toBe(false);
    expect(r.firstError).toBe("AssertionError: scripted failure: [fail] marker found in changed file features/x.md");
    expect(r.failingCheck).toContain("preview smoke");
    expect(r.log.length).toBeGreaterThan(3_000);
    expect(r.log.split("\n").filter((l) => l.trim().startsWith("at ")).length).toBeGreaterThan(40);
    expect(firstErrorLine(r.log)).toBe(r.firstError);
  });

  it("fails when only the commit message carries [fail]", async () => {
    const r = await runner.run(input({ commitMessages: ["queen(build): Fix it [fail]\n\n- a.ts\n"] }));
    expect(r.passed).toBe(false);
    expect(r.firstError).toContain("the commit message");
  });

  it("passes a REWORK even though the prompt text (and so the marker) is still present", async () => {
    const rework = input({
      commitMessages: ["queen(rework): Fix it [fail]\n\n- features/x.md\n"],
      changedFiles: { "features/x.md": "## Request\n\nFix it [fail]\n\n## Rework\n\nPrevious attempt failed: ... [fail] marker ...\n" },
    });
    expect(isRework(rework)).toBe(true);
    expect((await runner.run(rework)).passed).toBe(true);
    // The doc section alone is enough too (e.g. a squashed commit message).
    expect(isRework(input({ changedFiles: { "x.md": "## Rework\n\nPrevious attempt failed: z\n" } }))).toBe(true);
  });

  it("sandbox mode is a non-retryable stub", async () => {
    const s = createTestRunner("sandbox");
    expect(s).toBeInstanceOf(SandboxTestRunner);
    const err = await s.run(input()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect((err as Error).message).toMatch(/not implemented/);
  });
});

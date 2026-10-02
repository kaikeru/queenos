/**
 * Test execution port.
 *
 * - `scripted` (default, demo): deterministic. Fails when a changed file or a
 *   commit message carries the `[fail]` marker, unless the change is a REWORK
 *   (see isRework): the drones' scripted builder copies the prompt text, and so
 *   the marker, into every attempt, and the contract is "fail once, pass on
 *   REWORK".
 * - `sandbox`: stub. A real Workers Preview deploy + test run needs a
 *   container; not feasible for the hackathon deadline.
 */
import { NonRetryableError } from "cloudflare:workflows";

export const FAIL_MARKER = "[fail]";

export interface TestInput {
  repo: string;
  trainId: string;
  after: string;
  /** Paths touched by the pushed commits (added files + files listed in drone commit messages). */
  changedPaths: string[];
  /** Contents of changed paths that exist at `after` (UTF-8). */
  changedFiles: Record<string, string>;
  /** Messages of the pushed commits, newest first. */
  commitMessages: string[];
  /** Total tracked files (for the log). */
  fileCount: number;
}

export interface TestRun {
  passed: boolean;
  /** Number of checks executed. */
  checks: number;
  /** Raw runner output. Long on failure; the Scribe compacts it. */
  log: string;
  failingCheck?: string;
  firstError?: string;
}

export interface TestRunner {
  readonly mode: "scripted" | "sandbox";
  run(input: TestInput): Promise<TestRun>;
}

/** Thrown by the sandbox stub; never retried. */
export class NotImplementedError extends NonRetryableError {
  override readonly name = "NotImplementedError";
}

export class SandboxTestRunner implements TestRunner {
  readonly mode = "sandbox" as const;
  async run(): Promise<TestRun> {
    // TODO: @cloudflare/sandbox (Containers). Clone `repo@after` into a sandbox,
    // `pnpm install && pnpm test`, deploy a Workers Preview and probe it, then map
    // the exit code + stdout/stderr onto TestRun.
    throw new NotImplementedError("GATE_TEST_MODE=sandbox is not implemented (TODO: run the train in @cloudflare/sandbox)");
  }
}

/**
 * The drones' REWORK commits are `queen(rework): ...` and their feature doc
 * carries a `## Rework` section (apps/drones build.ts + scripted.ts).
 */
export function isRework(input: Pick<TestInput, "commitMessages" | "changedFiles">): boolean {
  return (
    input.commitMessages.some((m) => /^queen\(rework\)/i.test(m.trimStart())) ||
    Object.values(input.changedFiles).some((c) => /^## Rework\s*$/m.test(c))
  );
}

/** FNV-1a, for stable fake numbers. */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const SUITES: [string, number][] = [
  ["test/health.test.ts", 3],
  ["test/routes.test.ts", 7],
  ["test/events.test.ts", 5],
  ["test/preview.smoke.test.ts", 4],
];

function frames(seed: number, count: number): string[] {
  const fns = ["Object.invoke", "Module.run", "async Promise.all (index 0)", "dispatch", "handleRequest", "Router.match", "Worker.fetch", "processTicksAndRejections", "runTest", "callSuiteHook"];
  const files = ["/preview/src/index.ts", "/preview/src/router.ts", "/preview/node_modules/.pnpm/vitest@4.1.11/node_modules/@vitest/runner/dist/index.js", "/preview/node_modules/.pnpm/vitest@4.1.11/node_modules/vitest/dist/chunks/execute.js"];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const h = fnv(`${seed}:${i}`);
    out.push(`    at ${fns[h % fns.length]} (${files[(h >>> 4) % files.length]}:${(h >>> 8) % 400 + 1}:${(h >>> 20) % 80 + 1})`);
  }
  return out;
}

export class ScriptedTestRunner implements TestRunner {
  readonly mode = "scripted" as const;

  async run(input: TestInput): Promise<TestRun> {
    const sha = input.after.slice(0, 12);
    const seed = fnv(`${input.repo}@${input.after}`);
    const subjectMarker = input.commitMessages.some((m) => m.includes(FAIL_MARKER));
    const markerPath = Object.entries(input.changedFiles).find(([, c]) => c.includes(FAIL_MARKER))?.[0];
    const marked = subjectMarker || markerPath !== undefined;
    const rework = isRework(input);

    const lines: string[] = [
      `> queenos-preview@0.0.0 test (scripted runner)`,
      `> deploying ${input.repo}@${sha} to Workers Preview (simulated)`,
      `preview: bundled ${input.fileCount} files, uploading worker version`,
      `preview: https://${sha}-${input.repo.slice(0, 20)}.preview.invalid ready`,
      "",
      " RUN  v4.1.11 /preview",
      "",
    ];
    let checks = 0;
    for (const [file, n] of SUITES) {
      checks += n;
      lines.push(` ✓ ${file} (${n} tests) ${5 + (fnv(file + sha) % 40)}ms`);
    }

    if (marked && !rework) {
      const where = markerPath ? `changed file ${markerPath}` : "the commit message";
      const failing = `test/preview.smoke.test.ts > preview smoke > serves the changed feature`;
      checks += 1;
      lines.push(` ❯ test/preview.smoke.test.ts (1 test | 1 failed) 31ms`, `   × preview smoke > serves the changed feature 19ms`, "");
      lines.push("⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯", "", ` FAIL  ${failing}`);
      const firstError = `AssertionError: scripted failure: ${FAIL_MARKER} marker found in ${where}`;
      lines.push(firstError, "  - Expected", "  + Received", "", '  - "status": 200', '  + "status": 500', "", " ❯ test/preview.smoke.test.ts:42:18");
      lines.push(...frames(seed, 38));
      lines.push("", "Caused by: Error: preview worker responded 500 Internal Server Error", ...frames(seed + 1, 14), "");
      lines.push(" Test Files  1 failed | 3 passed (4)", `      Tests  1 failed | ${checks - 1} passed (${checks})`, " Duration  1.84s");
      return { passed: false, checks, log: lines.join("\n"), failingCheck: failing, firstError };
    }

    lines.push("", ` Test Files  ${SUITES.length} passed (${SUITES.length})`, `      Tests  ${checks} passed (${checks})`, " Duration  1.62s");
    return { passed: true, checks, log: lines.join("\n") };
  }
}

export function createTestRunner(mode: "scripted" | "sandbox"): TestRunner {
  return mode === "sandbox" ? new SandboxTestRunner() : new ScriptedTestRunner();
}

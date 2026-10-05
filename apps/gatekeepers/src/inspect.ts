/**
 * The "inspect" step body: clone the fork at `after`, run the POLICY and
 * SECURITY scans, then the tests. All of it runs inside ONE `step.do`: the
 * in-memory clone cannot cross steps, and only a small summary comes back out
 * (step results are capped at 1 MiB; the repo token never leaves the step).
 */
import type { GateConfig } from "./config";
import type { GateTask } from "./event";
import { formatFinding, isCodePath, isSkippedPath, toReport, type Finding, type ScanReport } from "./findings";
import type { GatekeeperPorts, GitSession } from "./ports";
import { scanPolicy } from "./policy";
import { scanSecurity, MAX_SCAN_BYTES } from "./security";
import { renderReviewInput, type ReviewPacket } from "./review";
import { SMOKE_CHECK } from "./smoke";
import { isRework, type TestRun } from "./test-runner";

export const MAX_FILES = 3_000;
export const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
export const MAX_LOG_IN_STEP = 60_000;
/** Clone depth: the pushed commit, a possible ledger-file commit, and parents to diff against. */
export const CLONE_DEPTH = 4;

export interface TestSummary {
  passed: boolean;
  checks: number;
  /** Raw log, only kept on failure (capped). */
  log: string | null;
  failingCheck?: string;
  firstError?: string;
}

export type Inspection =
  | { status: "stale"; headSha: string | null }
  | {
      status: "done";
      startedAtMs: number;
      endedAtMs: number;
      policy: ScanReport;
      security: ScanReport;
      /** Null when static checks already failed (fail fast) . */
      tests: TestSummary | null;
      /** Changed paths (sorted, capped at 30), for every outcome: hive memory and the review packet. */
      changedPaths: string[];
      /** Evidence for the REVIEWER; null when review is off or the code did not get as far as a working preview. */
      review: ReviewPacket | null;
      /** Raw failure log for the Scribe; null when everything passed. */
      failureLog: string | null;
      failingCheck: string | null;
    };

const BIN_RE = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|wasm|woff2?|ttf|otf|mp[34])$/i;

/** Paths listed as `- path` lines in a drone commit message (apps/drones commitMessage). */
export function pathsFromMessage(message: string): string[] {
  return message
    .split("\n")
    .map((l) => /^- (\S+)$/.exec(l)?.[1])
    .filter((p): p is string => !!p && !p.startsWith("/") && !p.includes(".."));
}

/**
 * Commits in `before..after` (newest first, bounded by the shallow clone) and
 * the paths they changed: files added relative to the parent, plus files named
 * in a drone-style commit message. UNVERIFIED limit: a pure modification by a
 * non-drone commit is invisible here (no tree diff in hive-kit's GitRepo).
 */
export async function collectChange(repo: GitSession, after: string, before: string | undefined): Promise<{ messages: string[]; changed: Set<string> }> {
  const messages: string[] = [];
  const changed = new Set<string>();
  let oid: string | undefined = after;
  for (let i = 0; i < CLONE_DEPTH - 1 && oid && oid !== before; i++) {
    const c = await repo.readCommit(oid);
    if (!c) break;
    messages.push(c.message);
    for (const p of pathsFromMessage(c.message)) changed.add(p);
    const parent: string | undefined = c.parents[0];
    if (parent && (await repo.readCommit(parent))) {
      try {
        const [now, prev] = await Promise.all([repo.listFiles(oid), repo.listFiles(parent)]);
        const had = new Set(prev);
        for (const p of now) if (!had.has(p)) changed.add(p);
      } catch {
        /* parent tree unavailable: rely on message paths */
      }
    }
    oid = parent;
  }
  return { messages, changed };
}

async function readTree(repo: GitSession): Promise<{ files: Record<string, string>; total: number }> {
  const all = (await repo.listFiles()).filter((p) => !isSkippedPath(p) && !BIN_RE.test(p));
  const wanted = all.slice(0, MAX_FILES);
  const files = await repo.readFiles(wanted);
  let bytes = 0;
  const kept: Record<string, string> = {};
  for (const [p, text] of Object.entries(files)) {
    if (text.length > MAX_SCAN_BYTES && !isCodePath(p)) continue;
    bytes += text.length;
    if (bytes > MAX_TOTAL_BYTES) break;
    kept[p] = text;
  }
  return { files: kept, total: all.length };
}

export function renderFindings(label: string, r: ScanReport): string {
  const errors = r.findings.filter((f) => f.severity === "error");
  return [`${label} scan failed: ${errors.length} error finding(s) in ${r.filesScanned} file(s)`, ...errors.map(formatFinding)].join("\n");
}

export const SMOKE_SKIPPED_RULE = "preview-smoke-skipped";

export async function inspectPush(
  ports: GatekeeperPorts,
  task: GateTask,
  config: GateConfig,
  trainId: string,
  /** The train's Worker Preview URL. Absent (sim mode, old trains): the smoke test is skipped with a warning. */
  previewUrl: string | null = null,
  /** The train's prompt, for the reviewer's evidence document. */
  prompt = "",
): Promise<Inspection> {
  const startedAtMs = Date.now();
  const access = await ports.artifacts.access(task.repo, "read");
  const repo = await ports.git.clone({ remote: access.remote, token: access.token, ref: task.branch, depth: CLONE_DEPTH });

  const head = await repo.head();
  if (!head || head.oid !== task.after) return { status: "stale", headSha: head?.oid ?? null };

  const { messages, changed } = await collectChange(repo, task.after, task.before);
  const { files, total } = await readTree(repo);

  const policy = scanPolicy(files, { allowedDeps: config.allowedDeps });
  let security = scanSecurity(files, { allowedHosts: config.allowedHosts });
  if (!previewUrl) {
    const skipped: Finding = {
      rule: SMOKE_SKIPPED_RULE,
      severity: "warning",
      file: "(preview)",
      message: "train has no previewUrl: the preview smoke test was skipped",
    };
    security = toReport([...security.findings, skipped], security.filesScanned);
  }

  let tests: TestSummary | null = null;
  let failureLog: string | null = null;
  let failingCheck: string | null = null;
  let review: ReviewPacket | null = null;

  if (policy.passed && security.passed) {
    // 1. The real check: the deployed preview must answer GET / with 2xx.
    const smoke = previewUrl ? await ports.smoke.check(previewUrl) : null;
    const changedFiles: Record<string, string> = {};
    for (const p of changed) if (files[p] !== undefined) changedFiles[p] = files[p];
    // 1b. Review evidence: only for code that works (policy, security and smoke passed).
    if (config.reviewMode !== "off" && (!smoke || smoke.passed)) {
      const rework = isRework({ commitMessages: messages, changedFiles });
      review = {
        rework,
        text: renderReviewInput({
          prompt,
          commitMessages: messages,
          changedFiles,
          tree: Object.keys(files).sort(),
          rework,
          preview: smoke ? { ...(smoke.status !== undefined ? { status: smoke.status } : {}), ...(smoke.contentType ? { contentType: smoke.contentType } : {}), ...(smoke.body !== undefined ? { body: smoke.body } : {}) } : null,
        }),
      };
    }
    // 2. The scripted/sandbox runner, only when the smoke test did not already fail the train.
    const run: TestRun =
      smoke && !smoke.passed
        ? {
            passed: false,
            checks: 1,
            log: smoke.log,
            failingCheck: SMOKE_CHECK,
            ...(smoke.firstError ? { firstError: smoke.firstError } : {}),
          }
        : await ports.tests.run({
            repo: task.repo,
            trainId,
            after: task.after,
            changedPaths: [...changed].sort(),
            changedFiles,
            commitMessages: messages,
            fileCount: total,
          });
    tests = {
      passed: run.passed,
      checks: run.checks + (smoke?.passed ? 1 : 0),
      log: run.passed ? null : run.log.slice(0, MAX_LOG_IN_STEP),
      ...(run.failingCheck ? { failingCheck: run.failingCheck } : {}),
      ...(run.firstError ? { firstError: run.firstError } : {}),
    };
    if (!run.passed) {
      failureLog = tests.log;
      failingCheck = run.failingCheck ?? null;
    }
  } else {
    const parts: string[] = [];
    if (!policy.passed) parts.push(renderFindings("policy", policy));
    if (!security.passed) parts.push(renderFindings("security", security));
    failureLog = parts.join("\n\n").slice(0, MAX_LOG_IN_STEP);
    failingCheck = !policy.passed ? "policy scan" : "security scan";
  }

  return {
    status: "done",
    startedAtMs,
    endedAtMs: Date.now(),
    policy,
    security,
    tests,
    changedPaths: [...changed].sort().slice(0, 30),
    review,
    failureLog,
    failingCheck,
  };
}

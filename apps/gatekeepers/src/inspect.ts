/**
 * The "inspect" step body: clone the fork at `after`, run the POLICY and
 * SECURITY scans, then the tests. All of it runs inside ONE `step.do`: the
 * in-memory clone cannot cross steps, and only a small summary comes back out
 * (step results are capped at 1 MiB; the repo token never leaves the step).
 */
import { LAND_DEPTH, type FollowUp } from "@queenos/queen-types";
import type { GateConfig } from "./config";
import type { GateTask } from "./event";
import { formatFinding, isCodePath, isSkippedPath, toReport, type Finding, type ScanReport } from "./findings";
import type { GatekeeperPorts, GitSession } from "./ports";
import { scanPolicy } from "./policy";
import { scanSecurity, MAX_SCAN_BYTES } from "./security";
import { renderReviewInput, type ReviewPacket } from "./review";
import { followUpsFrom, isOutOfDiff, PRE_EXISTING_PREFIX } from "./followups";
import { SMOKE_CHECK, smokeCheckName, type SmokeResult } from "./smoke";
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
      /** v2: error findings outside the diff, filed as bugs (they did not fail the gate). At most 3. */
      followUps: FollowUp[];
      /** v2: the gate score's size inputs (all changed paths, not just the 30 listed above). */
      changedFiles: number;
      changedBytes: number;
      /** Integration gate: the route whose smoke failed, and the member that declared it (when it did). */
      failedRoute?: { path: string; trainId?: string; title?: string };
    };

/** One route the preview must answer; `member` is set for a route a car member declared (`smokePaths`). */
export interface SmokeRoute {
  path: string;
  member?: { trainId: string; title: string };
}

/** The integration gate (lane QUEUE): scan `baseSha..head`, smoke every route, no reviewer. */
export interface IntegrationSpec {
  baseSha: string | null;
  routes: SmokeRoute[];
}

export const INTEGRATION_BASE_ROUTES = ["/", "/health"];
export const MAX_SMOKE_ROUTES = 24;

/** `/`, `/health` and every member's smokePaths, de-duplicated (first declarer wins), capped. */
export function integrationRoutes(members: { trainId: string; title: string; smokePaths: string[] }[]): SmokeRoute[] {
  const out: SmokeRoute[] = INTEGRATION_BASE_ROUTES.map((path) => ({ path }));
  const seen = new Set(out.map((r) => r.path));
  for (const m of members) {
    for (const path of m.smokePaths) {
      if (!path.startsWith("/") || path.includes("..") || /\s/.test(path) || seen.has(path)) continue;
      seen.add(path);
      out.push({ path, member: { trainId: m.trainId, title: m.title } });
    }
  }
  return out.slice(0, MAX_SMOKE_ROUTES);
}

const MAX_WALK = 300;

/**
 * Paths changed in `base..head`. Uses hive-kit's `changedPaths` (WP1.12) when present; otherwise
 * files added since `base` plus the paths drone commit messages list, over the commits reachable
 * from `head` but not from `base` (merge commits included). Null when `base` is unknown to the clone.
 */
export async function changedBetween(repo: GitSession, base: string, head: string): Promise<Set<string> | null> {
  if (typeof repo.changedPaths === "function") {
    try {
      return new Set(await repo.changedPaths(base, head));
    } catch {
      /* fall through to the walk */
    }
  }
  if (!(await repo.readCommit(base))) return null;
  const known = new Set<string>();
  const queue = [base];
  while (queue.length && known.size < MAX_WALK) {
    const oid = queue.pop()!;
    if (known.has(oid)) continue;
    known.add(oid);
    queue.push(...((await repo.readCommit(oid))?.parents ?? []));
  }
  const changed = new Set<string>();
  const seen = new Set<string>();
  const todo = [head];
  while (todo.length && seen.size < MAX_WALK) {
    const oid = todo.pop()!;
    if (seen.has(oid) || known.has(oid)) continue;
    seen.add(oid);
    const c = await repo.readCommit(oid);
    if (!c) continue;
    for (const p of pathsFromMessage(c.message)) changed.add(p);
    todo.push(...c.parents);
  }
  try {
    const [now, prev] = await Promise.all([repo.listFiles(head), repo.listFiles(base)]);
    const had = new Set(prev);
    for (const p of now) if (!had.has(p)) changed.add(p);
  } catch {
    /* trees unavailable: rely on message paths */
  }
  return changed;
}

/** Probe every route; the first failing route names the failing check. */
async function smokeRoutes(ports: GatekeeperPorts, previewUrl: string, routes: SmokeRoute[]): Promise<{ passed: boolean; checks: number; log: string; failingCheck?: string; firstError?: string; failed?: SmokeRoute }> {
  const logs: string[] = [];
  let failed: { route: SmokeRoute; result: SmokeResult } | undefined;
  let ok = 0;
  for (const route of routes) {
    const r = await ports.smoke.check(previewUrl, route.path, route.member ? "feature" : "base");
    if (r.passed) {
      ok++;
      continue;
    }
    const who = route.member ? ` (declared by member ${route.member.trainId} "${route.member.title}")` : "";
    logs.push(`> integration smoke: GET ${route.path} failed${who}`, r.log);
    failed ??= { route, result: r };
  }
  if (!failed) return { passed: true, checks: ok, log: "" };
  const { route, result } = failed;
  const who = route.member ? ` (member ${route.member.trainId} "${route.member.title}")` : "";
  return {
    passed: false,
    checks: ok + 1,
    log: logs.join("\n"),
    failingCheck: `integration ${smokeCheckName(route.path, route.member ? "feature" : "base")}${who}`,
    ...(result.firstError ? { firstError: result.firstError } : {}),
    failed: route,
  };
}

const utf8 = new TextEncoder();

/** Re-classify error findings outside the diff as warnings (they become follow-ups instead of failures). */
function splitOutOfDiff(report: ScanReport, changed: ReadonlySet<string> | null, files: Record<string, string>): { report: ScanReport; outOfDiff: Finding[] } {
  const outOfDiff: Finding[] = [];
  const findings = report.findings.map((f) => {
    if (!isOutOfDiff(f, changed, files)) return f;
    outOfDiff.push(f);
    return { ...f, severity: "warning" as const, message: `${PRE_EXISTING_PREFIX}${f.message}` };
  });
  return { report: toReport(findings, report.filesScanned), outOfDiff };
}

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
  integration?: IntegrationSpec,
): Promise<Inspection> {
  const startedAtMs = Date.now();
  const access = await ports.artifacts.access(task.repo, "read");
  const repo = await ports.git.clone({ remote: access.remote, token: access.token, ref: task.branch, depth: integration ? LAND_DEPTH : CLONE_DEPTH });

  const head = await repo.head();
  if (!head || head.oid !== task.after) return { status: "stale", headSha: head?.oid ?? null };

  let messages: string[];
  let changed: Set<string>;
  let scope: Set<string> | null;
  if (integration) {
    // A car's change is `baseSha..head` (merge commits included). An unreadable base scans everything as in-diff.
    const diff = integration.baseSha ? await changedBetween(repo, integration.baseSha, task.after) : null;
    changed = diff ?? new Set();
    scope = diff;
    // Member [fail] markers were already gated on the members: the car's runner sees no commit messages.
    messages = [];
  } else {
    ({ messages, changed } = await collectChange(repo, task.after, task.before));
    scope = changed;
  }
  const { files, total } = await readTree(repo);

  const policySplit = splitOutOfDiff(scanPolicy(files, { allowedDeps: config.allowedDeps }), scope, files);
  const securitySplit = splitOutOfDiff(scanSecurity(files, { allowedHosts: config.allowedHosts }), scope, files);
  const policy = policySplit.report;
  let security = securitySplit.report;
  const followUps = followUpsFrom(securitySplit.outOfDiff, policySplit.outOfDiff);
  let changedBytes = 0;
  for (const p of changed) if (files[p] !== undefined) changedBytes += utf8.encode(files[p]).length;
  let failedRoute: { path: string; trainId?: string; title?: string } | undefined;
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
    let routes: Awaited<ReturnType<typeof smokeRoutes>> | null = null;
    let smoke: SmokeResult | null = null;
    if (integration) routes = previewUrl ? await smokeRoutes(ports, previewUrl, integration.routes) : null;
    else smoke = previewUrl ? await ports.smoke.check(previewUrl) : null;
    const changedFiles: Record<string, string> = {};
    for (const p of changed) if (files[p] !== undefined) changedFiles[p] = files[p];
    // 1b. Review evidence: only for code that works (policy, security and smoke passed).
    if (!integration && config.reviewMode !== "off" && (!smoke || smoke.passed)) {
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
      routes && !routes.passed
        ? {
            passed: false,
            checks: routes.checks,
            log: routes.log,
            failingCheck: routes.failingCheck!,
            ...(routes.firstError ? { firstError: routes.firstError } : {}),
          }
        : smoke && !smoke.passed
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
      checks: run.checks + (smoke?.passed ? 1 : 0) + (routes?.passed ? routes.checks : 0),
      log: run.passed ? null : run.log.slice(0, MAX_LOG_IN_STEP),
      ...(run.failingCheck ? { failingCheck: run.failingCheck } : {}),
      ...(run.firstError ? { firstError: run.firstError } : {}),
    };
    if (!run.passed) {
      failureLog = tests.log;
      failingCheck = run.failingCheck ?? null;
      if (routes?.failed) failedRoute = { path: routes.failed.path, ...(routes.failed.member ? { trainId: routes.failed.member.trainId, title: routes.failed.member.title } : {}) };
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
    followUps,
    changedFiles: changed.size,
    changedBytes,
    ...(failedRoute ? { failedRoute } : {}),
  };
}

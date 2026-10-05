/**
 * In-browser stand-in for the Queen's War Room socket (VITE_MOCK_API=1 only).
 * Scripts two releases so the release UI can be seen without a backend:
 *   release 1: STAGING -> VALIDATING -> AWAITING_TAP -> (tap) -> canary 1/10/50/100 -> SHIPPED
 *   release 2: same up to canary 50, where Sentinel says ROLLBACK -> ROLLED_BACK
 * Never imported in production builds (see useRoomSocket).
 */
import type { Dispatch } from "react";
import type { MergeTrain, RecalledMemory, ModelStats, RouterFloor, PromptRun, QueenServerMessage, Release, SentinelVerdict } from "@queenos/queen-types";
import type { Action } from "./reducer";

const STEP_MS = 2500;
const USER = "kyle@kaikeru.com";

const prompts = ["Add rate limiting middleware to the public API", "Add a dark mode toggle to the settings page", "Write a migration that indexes audit_trail by prompt", "Fix the flaky retry logic in the webhook sender"];

const GLM_FLASH = "@cf/zai-org/glm-5.3-flash";
const DEEPSEEK_FLASH = "@cf/deepseek-ai/deepseek-v4-flash-0731";
const QWEN = "@cf/qwen/qwen3.8-27b";
const KIMI = "@cf/moonshotai/kimi-k2.7-code";
const GLM = "@cf/zai-org/glm-5.3";
const GRANITE = "@cf/ibm-granite/granite-4.0-h-micro";

const stat = (model: string, role: ModelStats["role"], attempts: number, passes: number, avgBuildMs: number | null): ModelStats => ({
  model,
  role,
  attempts,
  passes,
  failures: attempts - passes,
  avgBuildMs,
  updatedAt: Date.now(),
});

/** Track record the mock Queen "has learned" before the scripted run starts. */
const baseStats = (): ModelStats[] => [
  stat(GLM_FLASH, "builder", 9, 6, 21_400),
  stat(DEEPSEEK_FLASH, "builder", 5, 4, 26_800),
  stat(QWEN, "builder", 3, 1, 33_100),
  stat(KIMI, "rework", 4, 4, 58_900),
  stat(GLM, "builder", 2, 1, 71_200),
  stat(GRANITE, "scribe", 12, 11, 2_300),
];

const memory = (n: number, outcome: RecalledMemory["outcome"], promptText: string, text: string, score: number, ageMs: number): RecalledMemory => ({
  memoryId: `t-old${n}:${n.toString(16).repeat(12)}`,
  trainId: `t-old${n}`,
  promptId: `p-old${n}`,
  outcome,
  promptText,
  text,
  score,
  createdAt: Date.now() - ageMs,
});

/** What the Provisioner "recalled" for the CSV export build: one reviewer rejection, one pass, one failure. */
const CSV_MEMORIES: RecalledMemory[] = [
  memory(1, "REJECTED_BY_REVIEW", "Add a JSON export to the audit log view", "Builder added a new /features/status route and a button on it.\nReviewer: the prompt asked to change the audit log view at /, not to add a new route. Rejected.\nLesson: edit the existing view in place; do not add routes.", 0.91, 86_400_000),
  memory(2, "PASSED", "Add CSV download to the settings page", "Builder read the loader, added exportCsv() beside the table and wired one button in the existing header.\nGate: build, typecheck and preview smoke test passed.", 0.84, 172_800_000),
  memory(3, "FAILED", "Export audit rows as a spreadsheet", "Builder returned a change set with malformed JSON (unterminated string in a template literal).\nGate: change set rejected before apply.", 0.72, 259_200_000),
];

export class MockQueen {
  private stats: ModelStats[] = baseStats();
  private floor: RouterFloor = { tier: "fast", streak: 1, backoffAfter: 3, probeIn: 4 };
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private releases: Record<string, Release> = {};
  private stopped = false;
  constructor(
    private readonly hive: string,
    private readonly dispatch: Dispatch<Action>,
  ) {}

  private emit(message: QueenServerMessage) {
    if (!this.stopped) this.dispatch({ type: "server", message, at: Date.now() });
  }
  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.stopped) fn();
    }, ms);
    this.timers.add(t);
  }

  start() {
    const t0 = Date.now() - 600_000;
    const promptRuns: PromptRun[] = prompts.map((promptText, i) => ({ promptId: `p${i + 1}`, namespace: this.hive, promptText, status: "MERGED", createdAt: t0 + i * 1000 }) as PromptRun);
    const trains: MergeTrain[] = promptRuns.map(
      (p, i) =>
        ({
          trainId: `t${i + 1}`,
          baseSha: "base",
          includedPrompts: promptRuns.slice(0, i + 1).map((x) => x.promptId),
          artifactRepo: `${this.hive}-train-${i + 1}`,
          status: "MERGED",
          phase: "MERGED",
          headSha: `${(i + 1).toString(16).repeat(40)}`.slice(0, 40),
          landedSha: `${(i + 1).toString(16).repeat(40)}`.slice(0, 40),
          createdAt: p.createdAt,
          model: [GLM_FLASH, DEEPSEEK_FLASH, GLM_FLASH, KIMI][i],
          modelReason: ["best pass rate in fast tier", "fast tier: GLM-5.3 Flash cooling down", "best pass rate in fast tier", "rework → escalated to frontier"][i],
        }) as MergeTrain,
    );
    this.emit({ type: "snapshot", promptRuns, trains, recentAudit: [], releases: [], modelStats: this.stats, routerFloor: this.floor } as QueenServerMessage);
    this.scriptBuild();
    this.later(1200, () => this.cut("rel-1", ["t1", "t2"], "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", "ver-aaaa1111", "ver-0000stbl", false));
  }

  private bump(model: string, role: ModelStats["role"], passed: boolean, ms: number) {
    const cur = this.stats.find((x) => x.model === model && x.role === role) ?? stat(model, role, 0, 0, null);
    const attempts = cur.attempts + 1;
    const next: ModelStats = {
      ...cur,
      attempts,
      passes: cur.passes + (passed ? 1 : 0),
      failures: cur.failures + (passed ? 0 : 1),
      avgBuildMs: Math.round(((cur.avgBuildMs ?? ms) * cur.attempts + ms) / attempts),
      updatedAt: Date.now(),
    };
    this.stats = [...this.stats.filter((x) => x !== cur), next];
    this.emit({ type: "models.updated", stats: this.stats, floor: this.floor });
  }

  private setFloor(patch: Partial<RouterFloor>) {
    this.floor = { ...this.floor, ...patch };
    this.emit({ type: "models.updated", stats: this.stats, floor: this.floor });
  }

  /** A build that falls back, fails, is rebuilt on a frontier model and lands; stats evolve along the way. */
  private scriptBuild() {
    const now = Date.now();
    const prompt = (status: PromptRun["status"]) =>
      this.emit({ type: "prompt.updated", promptRun: { promptId: "p5", namespace: this.hive, promptText: "Add CSV export to the audit log view", status, createdAt: now } });
    const train = (patch: Partial<MergeTrain> & Pick<MergeTrain, "trainId" | "status">) =>
      this.emit({
        type: "train.updated",
        train: { baseSha: "base", includedPrompts: ["p1", "p2", "p3", "p4", "p5"], artifactRepo: `${this.hive}-${patch.trainId}`, createdAt: now, ...patch } as MergeTrain,
      });
    const audit = (id: string, status: "RUNNING" | "PASSED" | "REJECTED", model: string, result: "success" | "failure", ms: number) =>
      this.emit({
        type: "audit.appended",
        event: {
          eventId: id,
          promptId: "p5",
          droneRole: "BUILDER",
          status,
          createdAt: Date.now(),
          gitNotesPayload:
            status === "RUNNING"
              ? null
              : {
                  taskPrompt: "Add CSV export to the audit log view",
                  model,
                  temperature: 0.2,
                  reasoningSteps: ["Read the audit view and its data loader", result === "success" ? "Added exportCsv() and a button" : "Model returned malformed JSON change set"],
                  result,
                  executionTimeMs: ms,
                  discardedPaths: [],
                },
        },
      });
    this.later(2500, () => {
      prompt("BUILDING");
      train({ trainId: "t5", status: "BUILDING", phase: "BUILDING", model: GLM_FLASH, modelReason: "best pass rate in fast tier", memories: CSV_MEMORIES });
      audit("m-e1", "RUNNING", GLM_FLASH, "success", 0);
    });
    this.later(6500, () => {
      this.bump(GLM_FLASH, "builder", false, 9_000);
      train({ trainId: "t5", status: "BUILDING", phase: "BUILDING", model: DEEPSEEK_FLASH, modelReason: "GLM-5.3 Flash failed JSON → fell back to DeepSeek V4 Flash", memories: CSV_MEMORIES });
    });
    this.later(11_000, () => {
      this.bump(DEEPSEEK_FLASH, "builder", false, 24_000);
      this.setFloor({ tier: "frontier", streak: 0, probeIn: 3 });
      audit("m-e2", "REJECTED", DEEPSEEK_FLASH, "failure", 24_000);
      train({ trainId: "t5", status: "EJECTED", phase: "TESTING", reason: "failed: preview smoke test", model: DEEPSEEK_FLASH, modelReason: "fallback after JSON failure", memories: CSV_MEMORIES });
      prompt("EJECTED");
    });
    this.later(12_500, () => {
      prompt("BUILDING");
      train({ trainId: "t6", status: "BUILDING", phase: "BUILDING", createdAt: now + 10_000, model: KIMI, modelReason: "rework → escalated to frontier", memories: CSV_MEMORIES });
      audit("m-e3", "RUNNING", KIMI, "success", 0);
    });
    this.later(18_000, () => {
      this.bump(KIMI, "rework", true, 52_000);
      this.setFloor({ streak: 1, probeIn: 2 });
      audit("m-e4", "PASSED", KIMI, "success", 52_000);
      train({ trainId: "t6", status: "TESTING", phase: "TESTING", createdAt: now + 10_000, model: KIMI, modelReason: "rework → escalated to frontier", memories: CSV_MEMORIES });
      prompt("IN_TRAIN");
    });
    this.later(21_500, () => {
      train({ trainId: "t6", status: "MERGED", phase: "MERGED", createdAt: now + 10_000, landedSha: "c0ffee1234567890c0ffee1234567890c0ffee12", model: KIMI, modelReason: "rework → escalated to frontier", memories: CSV_MEMORIES });
      prompt("MERGED");
      this.setFloor({ streak: 2, probeIn: 1 });
    });
    this.later(26_000, () => {
      this.bump(KIMI, "builder", true, 49_000);
      this.setFloor({ tier: "fast", streak: 0, probeIn: null });
    });
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private set(id: string, patch: Partial<Release>) {
    const next = { ...this.releases[id]!, ...patch, updatedAt: Date.now() } as Release;
    this.releases[id] = next;
    this.emit({ type: "release.updated", release: next });
  }

  private verdict(id: string, environment: "staging" | "canary", ok: boolean, summary: string) {
    const v: SentinelVerdict = {
      commandId: `${id}-${environment}-${Date.now()}`,
      releaseId: id,
      environment,
      verdict: ok ? "PROMOTE" : "ROLLBACK",
      metrics: { requests: 112, errorRate: ok ? 0 : 0.125, p99Ms: ok ? 84 : 2410, baselineErrorRate: environment === "canary" ? 0 : null },
      summary,
    };
    this.emit({ type: "sentinel.verdict", verdict: v });
  }

  private cut(id: string, trainIds: string[], headSha: string, candidate: string, stable: string, willFail: boolean) {
    const now = Date.now();
    this.releases[id] = {
      releaseId: id,
      hive: this.hive,
      headSha,
      trainIds,
      phase: "STAGING",
      canaryPercent: null,
      stagingUrl: null,
      prodUrl: null,
      candidateVersionId: null,
      stableVersionId: null,
      tappedBy: null,
      tappedAt: null,
      summary: null,
      createdAt: now,
      updatedAt: now,
    };
    this.emit({ type: "release.updated", release: this.releases[id]! });
    this.later(STEP_MS, () => {
      this.set(id, { phase: "VALIDATING", stagingUrl: `https://${this.hive}-staging.kaikeru.workers.dev`, candidateVersionId: candidate });
      this.later(STEP_MS * 1.4, () => {
        this.verdict(id, "staging", true, "Staging: 0/60 errors; p99 71ms → promote");
        this.set(id, { phase: "AWAITING_TAP", summary: "Staging is healthy. Tap to ship." });
      });
    });
    this.willFail = { ...this.willFail, [id]: willFail };
    this.stable = { ...this.stable, [id]: stable };
  }
  private willFail: Record<string, boolean> = {};
  private stable: Record<string, string> = {};

  /** POST .../tap. Throws like the Queen: 404 unknown, 409 not awaiting a tap. */
  tap(releaseId: string): { status: number; body: unknown } {
    const r = this.releases[releaseId];
    if (!r) return { status: 404, body: { error: `NOT_FOUND: release ${releaseId}` } };
    if (r.phase !== "AWAITING_TAP") return { status: 409, body: { error: `CONFLICT: release is ${r.phase}, not AWAITING_TAP` } };
    this.set(releaseId, { phase: "CANARY", canaryPercent: 1, tappedBy: USER, tappedAt: Date.now(), stableVersionId: this.stable[releaseId] ?? null, summary: null });
    this.step(releaseId, [1, 10, 50, 100]);
    return { status: 200, body: { ok: true } };
  }

  private step(id: string, steps: number[]) {
    const [pct, ...rest] = steps;
    this.later(STEP_MS * 1.6, () => {
      const fail = this.willFail[id] && pct === 50;
      if (fail) {
        this.verdict(id, "canary", false, "Canary 50%: 14/112 errors vs baseline 0/108; p99 2410ms vs 80ms (error rate 12.5% > 1%) → rollback");
        this.set(id, { phase: "ROLLED_BACK", summary: "Sentinel rolled back at 50%: error rate 12.5%." });
        return;
      }
      this.verdict(id, "canary", true, `Canary ${pct}%: 0/${100 + (pct ?? 0)} errors vs baseline 0/108; p99 84ms vs 80ms → promote`);
      if (rest.length === 0) {
        this.set(id, { phase: "SHIPPED", canaryPercent: 100, prodUrl: `https://${this.hive}.kaikeru.workers.dev`, summary: null });
        if (id === "rel-1") this.later(5000, () => this.cut("rel-2", ["t1", "t2", "t3", "t4"], "f00dbabef00dbabef00dbabef00dbabef00dbabe", "ver-bbbb2222", "ver-aaaa1111", true));
        return;
      }
      this.set(id, { canaryPercent: rest[0]! });
      this.step(id, rest);
    });
  }
}

let active: MockQueen | null = null;
export const setActiveMockQueen = (q: MockQueen | null) => void (active = q);
export const activeMockQueen = () => active;

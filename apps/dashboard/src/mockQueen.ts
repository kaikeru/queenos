/**
 * In-browser stand-in for the Queen's War Room socket (VITE_MOCK_API=1 only).
 * Scripts two releases so the release UI can be seen without a backend:
 *   release 1: STAGING -> VALIDATING -> AWAITING_TAP -> (tap) -> canary 1/10/50/100 -> SHIPPED
 *   release 2: same up to canary 50, where Sentinel says ROLLBACK -> ROLLED_BACK
 * Never imported in production builds (see useRoomSocket).
 */
import type { Dispatch } from "react";
import type { MergeTrain, PromptRun, QueenServerMessage, Release, SentinelVerdict } from "@queenos/queen-types";
import type { Action } from "./reducer";

const STEP_MS = 2500;
const USER = "kyle@kaikeru.com";

const prompts = ["Add rate limiting middleware to the public API", "Add a dark mode toggle to the settings page", "Write a migration that indexes audit_trail by prompt", "Fix the flaky retry logic in the webhook sender"];

export class MockQueen {
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
        }) as MergeTrain,
    );
    this.emit({ type: "snapshot", promptRuns, trains, recentAudit: [], releases: [] } as QueenServerMessage);
    this.later(1200, () => this.cut("rel-1", ["t1", "t2"], "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", "ver-aaaa1111", "ver-0000stbl", false));
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

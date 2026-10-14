import { expect, test } from "vitest";
import { initialState, reducer, releaseLetters, type Action, type State } from "../src/reducer";
import { currentRelease, phaseHeadline, phaseHint, releaseSummary, siteReleaseView, tapButtonState, tapErrorMessage, timelineSteps } from "../src/releases";

const release = (over: Record<string, unknown> = {}) => ({
  releaseId: "r1",
  hive: "demo",
  headSha: "abcdef1234567890",
  trainIds: ["t1", "t2"],
  phase: "STAGING",
  canaryPercent: null,
  stagingUrl: null,
  prodUrl: null,
  candidateVersionId: null,
  stableVersionId: null,
  tappedBy: null,
  tappedAt: null,
  summary: null,
  createdAt: 100,
  updatedAt: 100,
  ...over,
});
const verdict = (over: Record<string, unknown> = {}) => ({
  commandId: "c1",
  releaseId: "r1",
  environment: "staging",
  verdict: "PROMOTE",
  metrics: { requests: 60, errorRate: 0, p99Ms: 70, baselineErrorRate: null },
  summary: "Staging: 0/60 errors; p99 70ms → promote",
  ...over,
});
const server = (message: unknown, at = 100) => ({ type: "server", message, at }) as unknown as Action;
const run = (...actions: Action[]): State => actions.reduce(reducer, initialState);
const states = (r: ReturnType<typeof release>, peak = 0) => timelineSteps(r as never, peak).map((s) => s.state);

const base = server({
  type: "snapshot",
  promptRuns: [
    { promptId: "p1", namespace: "demo", promptText: "one", status: "MERGED", createdAt: 1 },
    { promptId: "p2", namespace: "demo", promptText: "two", status: "MERGED", createdAt: 2 },
  ],
  trains: [
    { trainId: "t1", baseSha: "b", includedPrompts: ["p1"], artifactRepo: "x", status: "MERGED", createdAt: 1 },
    { trainId: "t2", baseSha: "b", includedPrompts: ["p1", "p2"], artifactRepo: "x", status: "MERGED", createdAt: 2 },
  ],
  recentAudit: [],
});

test("snapshot without releases leaves the release state empty", () => {
  const s = run(base);
  expect(s.releases).toEqual({});
  expect(currentRelease(s)).toBeNull();
});

test("snapshot.releases replaces releases, newest first", () => {
  const s = run(base, server({ type: "snapshot", promptRuns: [], trains: [], recentAudit: [], releases: [release({ releaseId: "old", createdAt: 5 }), release({ releaseId: "new", createdAt: 9 })] }));
  expect(s.releaseOrder).toEqual(["new", "old"]);
  expect(currentRelease(s)?.releaseId).toBe("new");
});

test("release.updated upserts, ignores stale frames and writes ticker lines for phase changes", () => {
  let s = run(base, server({ type: "release.updated", release: release() }));
  expect(releaseLetters(s, s.releases.r1!)).toBe("A+B");
  expect(s.ticker[0]!.text).toBe("Release abcdef1 created (A+B)");
  s = reducer(s, server({ type: "release.updated", release: release({ phase: "CANARY", canaryPercent: 10, updatedAt: 200 }) }));
  expect(s.ticker[0]!.text).toBe("Release abcdef1 CANARY at 10%");
  expect(s.canaryPeak.r1).toBe(10);
  // a stale frame is dropped
  const before = s;
  s = reducer(s, server({ type: "release.updated", release: release({ phase: "VALIDATING", updatedAt: 150 }) }));
  expect(s).toBe(before);
  // same phase again: no new ticker line
  const n = s.ticker.length;
  s = reducer(s, server({ type: "release.updated", release: release({ phase: "CANARY", canaryPercent: 10, updatedAt: 300 }) }));
  expect(s.ticker.length).toBe(n);
  s = reducer(s, server({ type: "release.updated", release: release({ phase: "ROLLED_BACK", canaryPercent: 0, updatedAt: 400, summary: "bad" }) }));
  expect(s.ticker[0]).toMatchObject({ kind: "error", text: "Release abcdef1 ROLLED BACK: bad" });
  expect(s.canaryPeak.r1).toBe(10);
});

test("a newer release becomes current and ordering is by createdAt", () => {
  const s = run(base, server({ type: "release.updated", release: release() }), server({ type: "release.updated", release: release({ releaseId: "r2", createdAt: 500, updatedAt: 500 }) }));
  expect(s.releaseOrder).toEqual(["r2", "r1"]);
});

test("sentinel.verdict is stored per release/environment and shown in the ticker", () => {
  let s = run(base, server({ type: "sentinel.verdict", verdict: verdict() }));
  expect(s.verdicts.r1!.staging!.verdict).toBe("PROMOTE");
  expect(s.ticker[0]).toMatchObject({ kind: "sentinel", tone: "ok" });
  expect(s.ticker[0]!.text).toContain("Sentinel PROMOTE: Staging: 0/60");
  s = reducer(s, server({ type: "sentinel.verdict", verdict: verdict({ commandId: "c2", environment: "canary", verdict: "ROLLBACK", summary: "Canary 50%: bad → rollback" }) }));
  expect(s.verdicts.r1!.canary!.verdict).toBe("ROLLBACK");
  expect(s.verdicts.r1!.staging!.verdict).toBe("PROMOTE");
  expect(s.ticker[0]).toMatchObject({ kind: "sentinel", tone: "bad" });
  // replaying the identical frame is a no-op
  const before = s;
  expect(reducer(s, server({ type: "sentinel.verdict", verdict: verdict({ commandId: "c2", environment: "canary", verdict: "ROLLBACK", summary: "Canary 50%: bad → rollback" }) }))).toBe(before);
});

test("timeline: normal progress", () => {
  expect(states(release({ phase: "STAGING" }))).toEqual(["now", "todo", "todo", "todo", "todo", "todo", "todo", "todo"]);
  expect(states(release({ phase: "AWAITING_TAP" }))).toEqual(["done", "done", "now", "todo", "todo", "todo", "todo", "todo"]);
  expect(states(release({ phase: "CANARY", canaryPercent: 10 }))).toEqual(["done", "done", "done", "done", "now", "todo", "todo", "todo"]);
  expect(states(release({ phase: "SHIPPED", canaryPercent: 100 }))).toEqual(Array(8).fill("done"));
});

test("timeline: rollback fails at the peak canary step; failure and supersede states", () => {
  expect(states(release({ phase: "ROLLED_BACK", canaryPercent: 0 }), 50)).toEqual(["done", "done", "done", "done", "done", "bad", "todo", "todo"]);
  expect(states(release({ phase: "FAILED" }))[0]).toBe("bad");
  expect(states(release({ phase: "FAILED", stagingUrl: "https://s" }))).toEqual(["done", "bad", "todo", "todo", "todo", "todo", "todo", "todo"]);
  expect(states(release({ phase: "SUPERSEDED" }))).toEqual(Array(8).fill("muted"));
});

test("timeline: a FAILED release that was tapped failed in CANARY, not at VALIDATING (live b2c25c89 / main c89aa02)", () => {
  const r = release({ phase: "FAILED", stagingUrl: "https://s", tappedAt: 5, tappedBy: "queen:autonomous", canaryPercent: null });
  expect(states(r)).toEqual(["done", "done", "done", "bad", "todo", "todo", "todo", "todo"]);
  expect(phaseHeadline(r as never)).toBe("Canary failed");
  expect(phaseHeadline(release({ phase: "FAILED", stagingUrl: "https://s" }) as never)).toBe("Failed before shipping");
});

test("tap button: visible only in AWAITING_TAP, locked while pending or after a tap was sent", () => {
  expect(tapButtonState(null).visible).toBe(false);
  for (const phase of ["STAGING", "VALIDATING", "CANARY", "SHIPPED", "FAILED", "ROLLED_BACK", "SUPERSEDED"]) {
    expect(tapButtonState(release({ phase }) as never).visible).toBe(false);
  }
  const r = release({ phase: "AWAITING_TAP" }) as never;
  expect(tapButtonState(r)).toEqual({ visible: true, enabled: true, label: "TAP TO SHIP" });
  expect(tapButtonState(r, { pending: true })).toMatchObject({ visible: true, enabled: false });
  expect(tapButtonState(r, { sentFor: "r1" })).toMatchObject({ visible: true, enabled: false });
  // a tap sent for a previous release does not lock a new one
  expect(tapButtonState(r, { sentFor: "other" }).enabled).toBe(true);
});

test("tap errors: 401 hints re-sign-in, 409 says stale", () => {
  expect(tapErrorMessage(401, "x")).toMatch(/sign in again/);
  expect(tapErrorMessage(403, "x")).toMatch(/sign in again/);
  expect(tapErrorMessage(409, "x")).toMatch(/stale/);
  expect(tapErrorMessage(500, "boom")).toBe("boom");
});

test("sites view: staging, canary and prod rows come from releases and verdicts", () => {
  const rels = [
    release({ releaseId: "r2", phase: "CANARY", canaryPercent: 50, stagingUrl: "https://stg", candidateVersionId: "cand2222-xxxx", stableVersionId: "stab1111-xxxx", createdAt: 200 }),
    release({ releaseId: "r1", phase: "SHIPPED", canaryPercent: 100, stagingUrl: "https://stg", prodUrl: "https://prod", candidateVersionId: "stab1111-xxxx", stableVersionId: "old00000-xxxx", tappedBy: "kyle@example.com", createdAt: 100 }),
  ];
  let s = run(base, server({ type: "snapshot", promptRuns: [], trains: [], recentAudit: [], releases: rels }));
  s = reducer(s, server({ type: "sentinel.verdict", verdict: verdict({ releaseId: "r2", environment: "canary", summary: "ok" }) }));
  const v = siteReleaseView(s);
  expect(v.staging).toMatchObject({ url: "https://stg", phase: "CANARY", verdict: null });
  expect(v.canary).toMatchObject({ percent: 50, candidate: "cand2222", stable: "stab1111", live: true });
  expect(v.canary!.verdict!.summary).toBe("ok");
  expect(v.prod).toEqual({ url: "https://prod", stable: "stab1111", tappedBy: "kyle@example.com", releaseId: "r1" });
});

test("sites view is empty before any release", () => {
  expect(siteReleaseView(run(base))).toEqual({ staging: null, canary: null, prod: null });
});

test("snapshot.verdicts hydrates the per-release verdicts; a snapshot without them keeps live ones", () => {
  const snap = (extra: Record<string, unknown>) => server({ type: "snapshot", promptRuns: [], trains: [], recentAudit: [], releases: [release()], ...extra });
  let s = run(base, snap({ verdicts: [verdict(), verdict({ commandId: "c2", environment: "canary", verdict: "ROLLBACK" })] }));
  expect(s.verdicts.r1!.staging!.verdict).toBe("PROMOTE");
  expect(s.verdicts.r1!.canary!.verdict).toBe("ROLLBACK");
  expect(s.ticker.every((t) => t.kind !== "sentinel")).toBe(true);
  // older Queen: no verdicts field leaves the held ones alone
  s = reducer(s, snap({}));
  expect(s.verdicts.r1!.staging!.verdict).toBe("PROMOTE");
  // a snapshot that carries verdicts replaces them
  s = reducer(s, snap({ verdicts: [] }));
  expect(s.verdicts).toEqual({});
});

test("mid-canary hides the stale step summary and says nothing needs doing; awaiting tap says what to do", () => {
  const canary = release({ phase: "CANARY", canaryPercent: 50, summary: "Canary 10%: 0/100 errors; ready after 4s → promote" }) as never;
  expect(releaseSummary(canary)).toBeNull();
  expect(phaseHint(canary)).toMatch(/Nothing to do/);
  const tap = release({ phase: "AWAITING_TAP", summary: "Staging is healthy." }) as never;
  expect(releaseSummary(tap)).toBe("Staging is healthy.");
  expect(phaseHint(tap)).toMatch(/TAP TO SHIP/);
});

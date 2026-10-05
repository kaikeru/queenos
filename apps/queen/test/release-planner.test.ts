import { describe, expect, it } from "vitest";
import type { DeployCommand, DeployResult, Deployment, SentinelCommand, SentinelVerdict } from "@queenos/queen-types";
import {
  ReleasePlanner,
  SENTINEL_GRACE_MS,
  releaseCommandId,
  releaseWatchdogDeadline,
  sentinelTimeoutMs,
  type ReleaseEffect,
  type ReleasePlanResult,
  type ReleaseRecord,
  type SentinelSettings,
} from "../src/release/planner";
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_ATTEMPTS } from "../src/train/planner";

type Deploy = Extract<DeployCommand, { op: "DEPLOY" }>;
type Rollback = Extract<DeployCommand, { op: "ROLLBACK" }>;

const T = DEFAULT_COMMAND_TIMEOUT_MS;
const STAGING_URL = "https://hive-staging.example.workers.dev";
const PROD_URL = "https://hive-app.example.workers.dev";

/** In-memory hive that persists ReleasePlanResults the way the DO does. */
class RSim {
  releases = new Map<string, ReleaseRecord>();
  deployments = new Map<string, Deployment>();
  effects: ReleaseEffect[] = [];
  now = 1000;
  sentinel: SentinelSettings = { windowSeconds: 60, minRequests: 100 };
  private ids = 0;
  private maxSeq = 0;

  run(fn: (p: ReleasePlanner) => ReleasePlanResult): ReleasePlanResult {
    const planner = new ReleasePlanner(
      { releases: [...this.releases.values()], deployments: [...this.deployments.values()], maxSeq: this.maxSeq },
      { namespace: "hive", now: this.now, newId: () => `r${++this.ids}`, sentinel: this.sentinel },
    );
    const r = fn(planner);
    for (const rel of r.releases) {
      this.releases.set(rel.releaseId, rel);
      this.maxSeq = Math.max(this.maxSeq, rel.seq);
    }
    for (const d of r.deployments) this.deployments.set(d.deploymentId, d);
    this.effects.push(...r.effects);
    return r;
  }

  rel(id: string): ReleaseRecord {
    const r = this.releases.get(id);
    if (!r) throw new Error(`no release ${id}`);
    return r;
  }

  land(trainId: string, headSha = `sha-${trainId}`): ReleasePlanResult {
    return this.run((p) => p.landed({ trainId, headSha }));
  }

  /** Take pending Herald commands. */
  herald(): DeployCommand[] {
    const out = this.effects.flatMap((e) => (e.type === "deploy" ? [e.command] : []));
    this.effects = this.effects.filter((e) => e.type !== "deploy");
    return out;
  }

  deploys(): Deploy[] {
    return this.herald().filter((c): c is Deploy => c.op === "DEPLOY");
  }

  sentinels(): SentinelCommand[] {
    const out = this.effects.flatMap((e) => (e.type === "sentinel" ? [e.command] : []));
    this.effects = this.effects.filter((e) => e.type !== "sentinel");
    return out;
  }

  broadcasts(): string[] {
    const out = this.effects.flatMap((e) => (e.type === "broadcast" ? [e.message.type] : []));
    this.effects = this.effects.filter((e) => e.type !== "broadcast");
    return out;
  }

  deployResult(c: { commandId: string; op?: "DEPLOY" | "ROLLBACK"; environment?: Deploy["environment"] }, extra: Partial<DeployResult> = {}): ReleasePlanResult {
    return this.run((p) => p.deployResult({ commandId: c.commandId, op: c.op ?? "DEPLOY", environment: c.environment ?? "staging", ok: true, ...extra }));
  }

  verdict(c: SentinelCommand, verdict: "PROMOTE" | "ROLLBACK", summary = verdict === "PROMOTE" ? "healthy" : "5xx spike"): ReleasePlanResult {
    const v: SentinelVerdict = {
      commandId: c.commandId,
      releaseId: c.releaseId,
      environment: c.environment,
      verdict,
      metrics: { requests: 300, errorRate: verdict === "PROMOTE" ? 0 : 0.2, p99Ms: 80, baselineErrorRate: null },
      summary,
    };
    return this.run((p) => p.sentinelVerdict(v));
  }

  /** Land t1 and drive the release to AWAITING_TAP. */
  static awaitingTap(): RSim {
    const s = new RSim();
    s.land("t1");
    const [d] = s.deploys();
    s.deployResult(d!, { url: STAGING_URL, releaseId: "r1" });
    s.verdict(s.sentinels()[0]!, "PROMOTE");
    s.effects = [];
    return s;
  }

  /** ...then tap and bring the 1% canary up (candidate v-cand, stable v-stable unless `stable` is null). */
  static canary1(stable: string | null = "v-stable"): RSim {
    const s = RSim.awaitingTap();
    s.run((p) => p.tap("r1", "kyle@kaikeru.com"));
    const [d] = s.deploys();
    s.deployResult(d!, { environment: "canary", url: PROD_URL, versionId: "v-cand", ...(stable ? { stableVersionId: stable } : {}) });
    return s;
  }

  /** Promote the current canary step's verdict, then bring up the next step's deploy. */
  promoteStep(): void {
    this.verdict(this.sentinels().at(-1)!, "PROMOTE");
    const d = this.deploys().at(-1);
    if (d) this.deployResult(d, { environment: "canary", url: PROD_URL, versionId: "v-cand", stableVersionId: "v-stable" });
  }
}

describe("release planner: creation and staging", () => {
  it("a merged train cuts a release in STAGING and dispatches the Herald staging deploy", () => {
    const s = new RSim();
    const r = s.land("t1", "main-1");
    expect(r.outcome).toBe("applied");
    expect(s.rel("r1")).toMatchObject({ phase: "STAGING", headSha: "main-1", trainIds: ["t1"], hive: "hive", pending: "DEPLOY", deployIssuedAt: 1000, seq: 1 });
    expect(s.deploys()).toEqual([
      { op: "DEPLOY", commandId: "r1-staging-1", hive: "hive", environment: "staging", releaseId: "r1", artifactRepo: "hive", commitSha: "main-1" },
    ]);
    expect(s.deployments.get("staging")).toMatchObject({ environment: "staging", status: "PENDING", commitSha: "main-1", trainId: null });
    expect(s.broadcasts()).toEqual(["release.updated", "deployment.updated"]);
  });

  it("staging ok -> VALIDATING with the staging URL; Sentinel validates staging; PROMOTE -> AWAITING_TAP", () => {
    const s = new RSim();
    s.land("t1");
    const [d] = s.deploys();
    s.deployResult(d!, { url: STAGING_URL, versionId: "v-s1" });
    expect(s.rel("r1")).toMatchObject({ phase: "VALIDATING", stagingUrl: STAGING_URL, pending: "SENTINEL" });
    expect(s.deployments.get("staging")).toMatchObject({ status: "LIVE", url: STAGING_URL, versionId: "v-s1", percent: 100 });
    const [cmd] = s.sentinels();
    expect(cmd).toEqual({
      commandId: "r1-validate-1",
      hive: "hive",
      releaseId: "r1",
      environment: "staging",
      scriptName: "hive-staging",
      url: STAGING_URL,
      paths: ["/", "/health"],
      windowSeconds: 60,
      minRequests: 100,
    });
    s.broadcasts();
    s.verdict(cmd!, "PROMOTE", "staging healthy");
    expect(s.rel("r1")).toMatchObject({ phase: "AWAITING_TAP", pending: null, summary: "staging healthy" });
    expect(s.broadcasts()).toEqual(["sentinel.verdict", "release.updated"]);
    expect(s.herald()).toEqual([]);
  });

  it("a failed staging deploy (or an ok one without a URL) -> FAILED with the summary", () => {
    const s = new RSim();
    s.land("t1");
    s.deployResult(s.deploys()[0]!, { ok: false, summary: "bundle too large" });
    expect(s.rel("r1")).toMatchObject({ phase: "FAILED", pending: null, summary: "Staging deploy failed: bundle too large" });
    expect(s.deployments.get("staging")).toMatchObject({ status: "FAILED", summary: "bundle too large" });
    expect(s.sentinels()).toEqual([]);

    const w = new RSim();
    w.land("t1");
    w.deployResult(w.deploys()[0]!, {});
    expect(w.rel("r1").summary).toBe("Staging deploy failed: Herald reported a staging deploy without a URL.");
  });

  it("a failed staging validation -> FAILED (P5 bisect hook); the next merge re-cuts with every unshipped train", () => {
    const s = new RSim();
    s.land("t1");
    s.deployResult(s.deploys()[0]!, { url: STAGING_URL });
    s.verdict(s.sentinels()[0]!, "ROLLBACK", "5xx on /health");
    expect(s.rel("r1")).toMatchObject({ phase: "FAILED", summary: "Staging validation failed: 5xx on /health" });
    s.land("t2");
    expect(s.rel("r2")).toMatchObject({ phase: "STAGING", trainIds: ["t1", "t2"] });
  });
});

describe("release planner: superseding and queueing", () => {
  for (const phase of ["STAGING", "VALIDATING", "AWAITING_TAP"] as const) {
    it(`a merge during ${phase} supersedes the release; its late results are stale`, () => {
      const s = new RSim();
      s.land("t1");
      const staging = s.deploys()[0]!;
      let validate: SentinelCommand | undefined;
      if (phase !== "STAGING") {
        s.deployResult(staging, { url: STAGING_URL });
        validate = s.sentinels()[0]!;
        if (phase === "AWAITING_TAP") s.verdict(validate, "PROMOTE");
      }
      expect(s.rel("r1").phase).toBe(phase);
      s.effects = [];
      s.land("t2", "main-2");
      expect(s.rel("r1")).toMatchObject({ phase: "SUPERSEDED", pending: null, summary: "Superseded by release r2 (main main-2)." });
      expect(s.rel("r2")).toMatchObject({ phase: "STAGING", headSha: "main-2", trainIds: ["t1", "t2"], seq: 2 });
      expect(s.deploys().map((c) => c.commandId)).toEqual(["r2-staging-1"]);
      // Cancelled logically: whatever r1's executors report now is stale.
      expect(s.deployResult(staging, { url: STAGING_URL }).outcome).toBe("ignored:stale");
      if (validate) expect(s.verdict(validate, "PROMOTE").outcome).toBe("ignored:stale");
      expect(s.run((p) => p.tap("r1", "kyle@kaikeru.com")).outcome).toBe("conflict");
      expect(s.rel("r2").phase).toBe("STAGING");
    });
  }

  it("a merge during CANARY is queued and cut once the canary SHIPS (trains since the last shipped release)", () => {
    const s = RSim.canary1();
    s.land("t2", "main-2");
    s.land("t3", "main-3");
    expect([...s.releases.keys()]).toEqual(["r1"]);
    expect(s.rel("r1")).toMatchObject({ phase: "CANARY", nextHeadSha: "main-3", nextTrainIds: ["t2", "t3"] });
    for (let i = 0; i < 3; i++) s.promoteStep();
    s.effects = s.effects.filter((e) => e.type !== "deploy");
    s.verdict(s.sentinels().at(-1)!, "PROMOTE");
    expect(s.rel("r1")).toMatchObject({ phase: "SHIPPED", nextHeadSha: null, nextTrainIds: [] });
    expect(s.rel("r2")).toMatchObject({ phase: "STAGING", headSha: "main-3", trainIds: ["t2", "t3"] });
    expect(s.deploys().map((c) => c.commandId)).toEqual(["r2-staging-1"]);
  });

  it("a head queued during a canary that rolls back carries the rolled-back trains too", () => {
    const s = RSim.canary1();
    s.land("t2", "main-2");
    s.verdict(s.sentinels().at(-1)!, "ROLLBACK");
    const [rb] = s.herald();
    s.deployResult({ commandId: rb!.commandId, op: "ROLLBACK", environment: "canary" });
    expect(s.rel("r1").phase).toBe("ROLLED_BACK");
    expect(s.rel("r2")).toMatchObject({ phase: "STAGING", headSha: "main-2", trainIds: ["t1", "t2"] });
  });

  it("a repeated land for an included train is a duplicate", () => {
    const s = new RSim();
    s.land("t1");
    expect(s.land("t1").outcome).toBe("ignored:duplicate");
    expect([...s.releases.keys()]).toEqual(["r1"]);
  });
});

describe("release planner: tap to ship", () => {
  it("only AWAITING_TAP can be tapped; the tap records who/when and starts the 1% canary", () => {
    const s = new RSim();
    s.land("t1");
    expect(s.run((p) => p.tap("r1", "kyle@kaikeru.com")).outcome).toBe("conflict");
    expect(s.run((p) => p.tap("nope", "kyle@kaikeru.com")).outcome).toBe("ignored:unknown");

    const t = RSim.awaitingTap();
    t.now = 5000;
    expect(t.run((p) => p.tap("r1", "kyle@kaikeru.com")).outcome).toBe("applied");
    expect(t.rel("r1")).toMatchObject({ phase: "CANARY", tappedBy: "kyle@kaikeru.com", tappedAt: 5000, step: 0, pending: "DEPLOY" });
    expect(t.deploys()).toEqual([
      { op: "DEPLOY", commandId: "r1-canary1-1", hive: "hive", environment: "canary", releaseId: "r1", artifactRepo: "hive", commitSha: "sha-t1", percent: 1 },
    ]);
    expect(t.deployments.get("canary")).toMatchObject({ status: "PENDING", percent: 1 });
    expect(t.run((p) => p.tap("r1", "someone@kaikeru.com")).outcome).toBe("conflict");
    expect(t.rel("r1").tappedBy).toBe("kyle@kaikeru.com");
  });
});

describe("release planner: canary", () => {
  it("walks 1 -> 10 -> 50 -> 100 -> SHIPPED; each step deploys, then Sentinel verifies it", () => {
    const s = RSim.canary1();
    expect(s.rel("r1")).toMatchObject({ canaryPercent: 1, candidateVersionId: "v-cand", stableVersionId: "v-stable", prodUrl: PROD_URL, pending: "SENTINEL" });
    expect(s.deployments.get("canary")).toMatchObject({ status: "LIVE", versionId: "v-cand", percent: 1, url: PROD_URL });
    expect(s.deployments.get("prod")).toMatchObject({ status: "LIVE", versionId: "v-stable", percent: 99, url: PROD_URL });
    expect(s.sentinels()).toEqual([
      {
        commandId: "r1-verify1-1",
        hive: "hive",
        releaseId: "r1",
        environment: "canary",
        scriptName: "hive-app",
        url: PROD_URL,
        candidateVersionId: "v-cand",
        stableVersionId: "v-stable",
        canaryPercent: 1,
        paths: ["/", "/health"],
        windowSeconds: 60,
        minRequests: 100,
      },
    ]);
    const seen: { deploy: Deploy; verify: SentinelCommand }[] = [];
    for (const percent of [10, 50, 100]) {
      s.verdict({ commandId: `r1-verify${s.rel("r1").canaryPercent}-1`, releaseId: "r1", environment: "canary" } as SentinelCommand, "PROMOTE");
      const [deploy] = s.deploys();
      expect(deploy).toEqual({
        op: "DEPLOY",
        commandId: `r1-canary${percent}-1`,
        hive: "hive",
        environment: "canary",
        releaseId: "r1",
        artifactRepo: "hive",
        commitSha: "sha-t1",
        percent,
        versionId: "v-cand",
        stableVersionId: "v-stable",
      });
      s.deployResult(deploy!, { environment: "canary", url: PROD_URL, versionId: "v-cand", stableVersionId: "v-stable", percent });
      const [verify] = s.sentinels();
      expect(verify).toMatchObject({ commandId: `r1-verify${percent}-1`, canaryPercent: percent, candidateVersionId: "v-cand", stableVersionId: "v-stable" });
      expect(s.deployments.get("prod")).toMatchObject({ versionId: "v-stable", percent: 100 - percent });
      seen.push({ deploy: deploy!, verify: verify! });
    }
    s.verdict(seen.at(-1)!.verify, "PROMOTE", "100% healthy");
    expect(s.rel("r1")).toMatchObject({ phase: "SHIPPED", canaryPercent: 100, pending: null, summary: "100% healthy" });
    expect(s.deployments.get("prod")).toMatchObject({ status: "LIVE", versionId: "v-cand", percent: 100, commitSha: "sha-t1" });
    expect(s.deployments.get("canary")).toMatchObject({ status: "TORN_DOWN", percent: null });
    expect(s.herald()).toEqual([]);
  });

  for (const failAt of [1, 10, 50, 100]) {
    it(`a ROLLBACK verdict at ${failAt}% restores the stable version -> ROLLED_BACK`, () => {
      const s = RSim.canary1();
      while (s.rel("r1").canaryPercent !== failAt) s.promoteStep();
      s.effects = s.effects.filter((e) => e.type !== "broadcast");
      s.verdict(s.sentinels().at(-1)!, "ROLLBACK", "errors up 10x");
      expect(s.rel("r1")).toMatchObject({ phase: "CANARY", pending: "ROLLBACK", summary: `Canary at ${failAt}% failed: errors up 10x` });
      const [rb] = s.herald() as Rollback[];
      expect(rb).toEqual({ op: "ROLLBACK", commandId: "r1-rollback-1", hive: "hive", environment: "canary", toVersionId: "v-stable" });
      s.deployResult({ commandId: rb!.commandId, op: "ROLLBACK", environment: "canary" }, { versionId: "v-stable" });
      expect(s.rel("r1")).toMatchObject({ phase: "ROLLED_BACK", pending: null, canaryPercent: 0 });
      expect(s.deployments.get("prod")).toMatchObject({ status: "LIVE", versionId: "v-stable", percent: 100 });
      expect(s.deployments.get("canary")).toMatchObject({ status: "TORN_DOWN" });
      // Duplicate rollback report is a no-op.
      expect(s.deployResult({ commandId: rb!.commandId, op: "ROLLBACK", environment: "canary" }).outcome).toBe("ignored:duplicate");
    });
  }

  it("a failed canary deploy step rolls back too", () => {
    const s = RSim.canary1();
    s.verdict(s.sentinels()[0]!, "PROMOTE");
    const [d10] = s.deploys();
    s.deployResult(d10!, { environment: "canary", ok: false, summary: "deployment API 500" });
    expect(s.rel("r1").summary).toBe("Canary deploy at 10% failed: deployment API 500");
    expect(s.deployments.get("canary")).toMatchObject({ status: "FAILED" });
    expect(s.herald()).toEqual([{ op: "ROLLBACK", commandId: "r1-rollback-1", hive: "hive", environment: "canary", toVersionId: "v-stable" }]);
  });

  it("a failed ROLLBACK is retried, then the release is FAILED (manual intervention)", () => {
    const s = RSim.canary1();
    s.verdict(s.sentinels()[0]!, "ROLLBACK");
    for (let n = 1; n <= MAX_COMMAND_ATTEMPTS; n++) {
      const [rb] = s.herald();
      expect(rb!.commandId).toBe(`r1-rollback-${n}`);
      s.deployResult({ commandId: rb!.commandId, op: "ROLLBACK", environment: "canary" }, { ok: false, summary: "403" });
    }
    expect(s.rel("r1").phase).toBe("FAILED");
    expect(s.rel("r1").summary).toMatch(/Herald ROLLBACK failed: 403; prod may still split traffic, roll back manually\.$/);
    expect(s.deployments.get("prod")).toMatchObject({ status: "FAILED" });
  });

  it("first prod deploy (no stable version): a single step at 100%, then SHIPPED", () => {
    const s = RSim.canary1(null);
    expect(s.rel("r1")).toMatchObject({ phase: "CANARY", canaryPercent: 100, step: 3, stableVersionId: null, candidateVersionId: "v-cand" });
    const [verify] = s.sentinels();
    expect(verify).toMatchObject({ commandId: "r1-verify100-1", canaryPercent: 100, candidateVersionId: "v-cand" });
    expect(verify).not.toHaveProperty("stableVersionId");
    expect(s.deployments.get("prod")).toMatchObject({ versionId: "v-cand", percent: 100 });
    s.verdict(verify!, "PROMOTE");
    expect(s.rel("r1").phase).toBe("SHIPPED");
    expect(s.herald()).toEqual([]);
  });

  it("first prod deploy that turns unhealthy: nothing to roll back to -> FAILED, said in the summary", () => {
    const s = RSim.canary1(null);
    s.verdict(s.sentinels()[0]!, "ROLLBACK", "500s");
    expect(s.rel("r1")).toMatchObject({ phase: "FAILED", pending: null });
    expect(s.rel("r1").summary).toBe(
      "Canary at 100% failed: 500s Candidate v-cand is still serving 100% of prod because there was no prior version to roll back to; it becomes the stable version for the next release.",
    );
    expect(s.herald()).toEqual([]);
    // the prod row reflects what is actually live
    expect(s.deployments.get("prod")).toMatchObject({ status: "LIVE", versionId: "v-cand", percent: 100, commitSha: "sha-t1" });
    expect(s.deployments.get("canary")).toMatchObject({ status: "TORN_DOWN" });
  });

  it("first prod deploy whose upload failed: nothing is live, so the summary says nothing was rolled back", () => {
    const s = RSim.awaitingTap();
    s.run((p) => p.tap("r1", "kyle@kaikeru.com"));
    s.deployResult(s.deploys()[0]!, { environment: "canary", ok: false, summary: "upload 500" });
    expect(s.rel("r1")).toMatchObject({ phase: "FAILED" });
    expect(s.rel("r1").summary).toMatch(/No stable version to roll back to \(first prod deploy\), so nothing was rolled back\.$/);
    expect(s.deployments.get("prod")).toBeUndefined();
  });

  it("a canary step-1 deploy without a version id fails into a rollback when Herald named the stable version", () => {
    const s = RSim.awaitingTap();
    s.run((p) => p.tap("r1", "kyle@kaikeru.com"));
    s.deployResult(s.deploys()[0]!, { environment: "canary", url: PROD_URL, stableVersionId: "v-stable" });
    expect(s.rel("r1").summary).toBe("Canary deploy at 1% failed: Herald reported a canary deploy without a version id.");
    expect(s.herald()).toEqual([expect.objectContaining({ op: "ROLLBACK", toVersionId: "v-stable" })]);
  });
});

describe("release planner: idempotency", () => {
  it("duplicate, stale, unknown and wrong-environment results", () => {
    const s = new RSim();
    s.land("t1");
    const [d] = s.deploys();
    expect(s.deployResult(d!, { url: STAGING_URL }).outcome).toBe("applied");
    expect(s.deployResult(d!, { url: STAGING_URL }).outcome).toBe("ignored:duplicate");
    expect(s.deployResult({ commandId: "r1-staging-0" }, { url: STAGING_URL }).outcome).toBe("ignored:stale");
    expect(s.deployResult({ commandId: "zzz-staging-1" }, { url: STAGING_URL }).outcome).toBe("ignored:unknown");
    expect(s.run((p) => p.deployResult({ commandId: "r1-staging-1", op: "DEPLOY", environment: "staging", ok: true, releaseId: "nope" })).outcome).toBe("ignored:unknown");
    const [cmd] = s.sentinels();
    expect(s.verdict({ ...cmd!, environment: "canary" }, "PROMOTE").outcome).toBe("ignored:stale");
    expect(s.verdict({ ...cmd!, commandId: "r1-validate-0" }, "PROMOTE").outcome).toBe("ignored:stale");
    expect(s.verdict(cmd!, "PROMOTE").outcome).toBe("applied");
    expect(s.verdict(cmd!, "PROMOTE").outcome).toBe("ignored:duplicate");
    expect(s.verdict(cmd!, "ROLLBACK").outcome).toBe("ignored:duplicate");
    expect(s.rel("r1").phase).toBe("AWAITING_TAP");
  });

  it("finds the release from the command id when Herald omits releaseId", () => {
    const s = new RSim();
    s.land("t1");
    s.land("t2");
    // r1 was superseded by r2; each result resolves to its own release by command-id prefix.
    expect(s.deployResult({ commandId: "r1-staging-1" }, { url: STAGING_URL }).outcome).toBe("ignored:stale");
    expect(s.deployResult({ commandId: "r2-staging-1" }, { url: STAGING_URL }).outcome).toBe("applied");
  });

  it("updatedAt strictly increases on every update, even within one millisecond", () => {
    const s = new RSim();
    s.land("t1");
    const t0 = s.rel("r1").updatedAt;
    s.deployResult(s.deploys()[0]!, { url: STAGING_URL });
    const t1 = s.rel("r1").updatedAt;
    s.verdict(s.sentinels()[0]!, "PROMOTE");
    expect(t1).toBeGreaterThan(t0);
    expect(s.rel("r1").updatedAt).toBeGreaterThan(t1);
  });

  it("releaseCommandId restarts numbering for a new op", () => {
    expect(releaseCommandId("r1", "canary10", "r1-canary1-3")).toBe("r1-canary10-1");
    expect(releaseCommandId("r1", "canary10", "r1-canary10-1")).toBe("r1-canary10-2");
    expect(releaseCommandId("r1", "staging", null)).toBe("r1-staging-1");
  });
});

describe("release planner: watchdog and reconcile", () => {
  it("reconcile re-sends the outstanding command under the same id", () => {
    const s = new RSim();
    s.land("t1");
    s.herald();
    s.now += T - 1;
    s.run((p) => p.reconcile());
    expect(s.herald().map((c) => c.commandId)).toEqual(["r1-staging-1"]);
    expect(s.rel("r1").deployIssuedAt).toBe(1000);
  });

  it("a stuck staging deploy is re-issued under new ids (old ids stale), then FAILED", () => {
    const s = new RSim();
    s.land("t1");
    s.herald();
    for (let n = 2; n <= MAX_COMMAND_ATTEMPTS; n++) {
      s.now += T;
      s.run((p) => p.reconcile());
      expect(s.herald().map((c) => c.commandId)).toEqual([`r1-staging-${n}`]);
    }
    expect(s.deployResult({ commandId: "r1-staging-1" }, { url: STAGING_URL }).outcome).toBe("ignored:stale");
    s.now += T;
    s.run((p) => p.reconcile());
    expect(s.rel("r1")).toMatchObject({ phase: "FAILED", pending: null });
    expect(s.rel("r1").summary).toMatch(/^Herald DEPLOY r1-staging-3 did not report within 10 min/);
  });

  it("Sentinel gets max(COMMAND_TIMEOUT_MS, window + 5 min) before it is re-issued", () => {
    const s = new RSim();
    s.sentinel = { windowSeconds: 900, minRequests: 300 };
    s.land("t1");
    s.deployResult(s.deploys()[0]!, { url: STAGING_URL });
    expect(s.sentinels()[0]).toMatchObject({ windowSeconds: 900, minRequests: 300 });
    const limit = sentinelTimeoutMs(T, 900);
    expect(limit).toBe(900_000 + SENTINEL_GRACE_MS);
    s.now += T; // command timeout alone is not enough
    s.run((p) => p.reconcile());
    expect(s.sentinels().map((c) => c.commandId)).toEqual(["r1-validate-1"]);
    s.now = 1000 + limit;
    s.run((p) => p.reconcile());
    expect(s.sentinels().map((c) => c.commandId)).toEqual(["r1-validate-2"]);
    expect(sentinelTimeoutMs(T, 60)).toBe(T);
  });

  it("a canary verdict that never arrives (after the cap) is treated as unhealthy: rollback", () => {
    const s = RSim.canary1();
    s.sentinels();
    for (let n = 2; n <= MAX_COMMAND_ATTEMPTS + 1; n++) {
      s.now += T;
      s.run((p) => p.reconcile());
    }
    expect(s.rel("r1")).toMatchObject({ phase: "CANARY", pending: "ROLLBACK" });
    expect(s.rel("r1").summary).toMatch(/^Sentinel r1-verify1-3 did not report/);
    expect(s.herald()).toEqual([expect.objectContaining({ op: "ROLLBACK", commandId: "r1-rollback-1" })]);
  });

  it("a stuck ROLLBACK is re-issued, then FAILED", () => {
    const s = RSim.canary1();
    s.verdict(s.sentinels()[0]!, "ROLLBACK");
    s.herald();
    for (let n = 2; n <= MAX_COMMAND_ATTEMPTS; n++) {
      s.now += T;
      s.run((p) => p.reconcile());
      expect(s.herald().map((c) => c.commandId)).toEqual([`r1-rollback-${n}`]);
    }
    s.now += T;
    s.run((p) => p.reconcile());
    expect(s.rel("r1").phase).toBe("FAILED");
  });

  it("releaseWatchdogDeadline: issue time + timeout of the outstanding command; null when idle", () => {
    const s = new RSim();
    expect(releaseWatchdogDeadline([], T, 60, 0)).toBeNull();
    s.land("t1");
    expect(releaseWatchdogDeadline([...s.releases.values()], T, 60, 0)).toBe(1000 + T);
    s.now = 2000;
    s.deployResult(s.deploys()[0]!, { url: STAGING_URL });
    expect(releaseWatchdogDeadline([...s.releases.values()], T, 3600, 0)).toBe(2000 + 3600_000 + SENTINEL_GRACE_MS);
    s.verdict(s.sentinels()[0]!, "PROMOTE");
    expect(releaseWatchdogDeadline([...s.releases.values()], T, 60, 0)).toBeNull(); // AWAITING_TAP waits on a human
  });
});

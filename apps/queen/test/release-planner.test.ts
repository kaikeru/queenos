import { describe, expect, it } from "vitest";
import { AUTO_SHIP_ACTOR, type DeployCommand, type DeployResult, type Deployment, type Escalation, type EventDraft, type SentinelCommand, type SentinelVerdict } from "@queenos/queen-types";
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
import { isReleaseFailure } from "../src/autonomy/policy";

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
  /** v2 autonomy inputs, persisted the way the Queen would. */
  autoShip = false;
  paused = false;
  streak = 0;
  escalations = new Map<string, Escalation>();
  events: EventDraft[] = [];
  private ids = 0;
  private maxSeq = 0;

  run(fn: (p: ReleasePlanner) => ReleasePlanResult): ReleasePlanResult {
    const planner = new ReleasePlanner(
      { releases: [...this.releases.values()], deployments: [...this.deployments.values()], maxSeq: this.maxSeq },
      {
        namespace: "hive",
        now: this.now,
        newId: () => `r${++this.ids}`,
        sentinel: this.sentinel,
        autoShip: this.autoShip,
        paused: this.paused,
        rollbackStreak: this.streak,
        escalations: [...this.escalations.values()],
      },
    );
    const r = fn(planner);
    for (const e of r.escalations) this.escalations.set(e.escalationId, e);
    this.streak = r.rollbackStreak;
    this.events.push(...r.events);
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

  /** Open escalations (reason:subject id). */
  open(): string[] {
    return [...this.escalations.values()].filter((e) => e.status === "OPEN").map((e) => `${e.reason}:${e.subject.id}`);
  }

  verdict(c: SentinelCommand, verdict: "PROMOTE" | "ROLLBACK", summary = verdict === "PROMOTE" ? "healthy" : "5xx spike", inconclusive = false): ReleasePlanResult {
    const v: SentinelVerdict = {
      commandId: c.commandId,
      releaseId: c.releaseId,
      environment: c.environment,
      verdict,
      metrics: { requests: 300, errorRate: verdict === "PROMOTE" ? 0 : 0.2, p99Ms: 80, baselineErrorRate: null },
      summary,
      ...(inconclusive ? { inconclusive: true } : {}),
    };
    return this.run((p) => p.sentinelVerdict(v));
  }

  /** Land t1 and drive the release to AWAITING_TAP (or CANARY when `opts.autoShip`). */
  static awaitingTap(opts: { autoShip?: boolean; paused?: boolean } = {}): RSim {
    const s = new RSim();
    s.autoShip = opts.autoShip ?? false;
    s.paused = opts.paused ?? false;
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
    s.run((p) => p.tap("r1", "kyle@example.com"));
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
      expect(s.run((p) => p.tap("r1", "kyle@example.com")).outcome).toBe("conflict");
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
    expect(s.run((p) => p.tap("r1", "kyle@example.com")).outcome).toBe("conflict");
    expect(s.run((p) => p.tap("nope", "kyle@example.com")).outcome).toBe("ignored:unknown");

    const t = RSim.awaitingTap();
    t.now = 5000;
    expect(t.run((p) => p.tap("r1", "kyle@example.com")).outcome).toBe("applied");
    expect(t.rel("r1")).toMatchObject({ phase: "CANARY", tappedBy: "kyle@example.com", tappedAt: 5000, step: 0, pending: "DEPLOY" });
    expect(t.deploys()).toEqual([
      { op: "DEPLOY", commandId: "r1-canary1-1", hive: "hive", environment: "canary", releaseId: "r1", artifactRepo: "hive", commitSha: "sha-t1", percent: 1 },
    ]);
    expect(t.deployments.get("canary")).toMatchObject({ status: "PENDING", percent: 1 });
    expect(t.run((p) => p.tap("r1", "someone@example.org")).outcome).toBe("conflict");
    expect(t.rel("r1").tappedBy).toBe("kyle@example.com");
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
    s.run((p) => p.tap("r1", "kyle@example.com"));
    s.deployResult(s.deploys()[0]!, { environment: "canary", ok: false, summary: "upload 500" });
    expect(s.rel("r1")).toMatchObject({ phase: "FAILED" });
    expect(s.rel("r1").summary).toMatch(/No stable version to roll back to \(first prod deploy\), so nothing was rolled back\.$/);
    expect(s.deployments.get("prod")).toBeUndefined();
  });

  it("a canary step-1 deploy without a version id fails into a rollback when Herald named the stable version", () => {
    const s = RSim.awaitingTap();
    s.run((p) => p.tap("r1", "kyle@example.com"));
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

  it("a stuck staging deploy is re-issued under new ids (old ids stale), then parked on infrastructure (EXECUTOR_LOST, not FAILED)", () => {
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
    expect(s.rel("r1")).toMatchObject({ phase: "STAGING", pending: null });
    expect(s.rel("r1").summary).toMatch(/^Infrastructure: staging deploy did not complete after 3 attempts: Herald DEPLOY r1-staging-3 did not report within 10 min/);
    expect(s.open()).toEqual(["EXECUTOR_LOST:r1"]);
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

  it("a canary verdict that never arrives (after the cap) is infrastructure: traffic rolled back, then parked (not ROLLED_BACK, not counted)", () => {
    const s = RSim.canary1();
    s.sentinels();
    for (let n = 2; n <= MAX_COMMAND_ATTEMPTS + 1; n++) {
      s.now += T;
      s.run((p) => p.reconcile());
    }
    expect(s.rel("r1")).toMatchObject({ phase: "CANARY", pending: "ROLLBACK" });
    expect(s.rel("r1").summary).toMatch(/^Infrastructure: Sentinel r1-verify1-3 did not report/);
    expect(s.herald()).toEqual([expect.objectContaining({ op: "ROLLBACK", commandId: "r1-rollback-1" })]);
    s.deployResult({ commandId: "r1-rollback-1", op: "ROLLBACK", environment: "canary" });
    expect(s.rel("r1")).toMatchObject({ phase: "AWAITING_TAP", tappedAt: null, candidateVersionId: null, canaryPercent: null });
    expect(s.streak).toBe(0);
    expect(s.open()).toEqual(["EXECUTOR_LOST:r1"]);
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

// ── v2 autonomy (§2.4, §2.5) ─────────────────────────────────────────────

/** Land `train` and bring its release to the staging verdict (Sentinel validate command pending). */
function toValidating(s: RSim, train: string): SentinelCommand {
  s.land(train);
  s.deployResult(s.deploys().at(-1)!, { url: STAGING_URL });
  return s.sentinels().at(-1)!;
}

/** Drive the in-flight canary release to its end: ship, rollback, or a rollback that fails after the cap. */
function endCanary(s: RSim, how: "ship" | "rollback" | "rollback-failed"): void {
  if (how === "ship") {
    for (let i = 0; i < 4; i++) s.promoteStep();
    return;
  }
  s.verdict(s.sentinels().at(-1)!, "ROLLBACK");
  if (how === "rollback") {
    s.deployResult({ ...s.herald().at(-1)!, op: "ROLLBACK", environment: "canary" });
    return;
  }
  for (let n = 1; n <= MAX_COMMAND_ATTEMPTS; n++) {
    s.deployResult({ ...s.herald().at(-1)!, op: "ROLLBACK", environment: "canary" }, { ok: false, summary: "API 500" });
  }
}

/** A full cycle from landing `train`: staging PROMOTE, tap (unless auto-shipped), canary 1%, then `how`. */
function cycle(s: RSim, train: string, how: "ship" | "rollback" | "rollback-failed"): string {
  const v = toValidating(s, train);
  s.verdict(v, "PROMOTE");
  const id = v.releaseId;
  if (s.rel(id).phase === "AWAITING_TAP") s.run((p) => p.tap(id, "kyle@example.com"));
  s.deployResult(s.deploys().at(-1)!, { environment: "canary", url: PROD_URL, versionId: "v-cand", stableVersionId: "v-stable" });
  endCanary(s, how);
  return id;
}

describe("release planner: autonomy levels × staging verdicts", () => {
  const table = [
    // level, verdict, inconclusive → phase, tappedBy, open escalations
    { level: "autonomous", verdict: "PROMOTE", inconclusive: false, phase: "CANARY", tappedBy: AUTO_SHIP_ACTOR, open: [] },
    { level: "supervised", verdict: "PROMOTE", inconclusive: false, phase: "AWAITING_TAP", tappedBy: null, open: ["APPROVAL_REQUIRED:r1"] },
    { level: "paused", verdict: "PROMOTE", inconclusive: false, phase: "AWAITING_TAP", tappedBy: null, open: [] },
    { level: "autonomous", verdict: "ROLLBACK", inconclusive: true, phase: "AWAITING_TAP", tappedBy: null, open: ["SENTINEL_INCONCLUSIVE:r1"] },
    { level: "supervised", verdict: "ROLLBACK", inconclusive: true, phase: "AWAITING_TAP", tappedBy: null, open: ["SENTINEL_INCONCLUSIVE:r1"] },
    { level: "paused", verdict: "ROLLBACK", inconclusive: true, phase: "AWAITING_TAP", tappedBy: null, open: ["SENTINEL_INCONCLUSIVE:r1"] },
    { level: "autonomous", verdict: "PROMOTE", inconclusive: true, phase: "AWAITING_TAP", tappedBy: null, open: ["SENTINEL_INCONCLUSIVE:r1"] },
    { level: "autonomous", verdict: "ROLLBACK", inconclusive: false, phase: "FAILED", tappedBy: null, open: [] },
    { level: "supervised", verdict: "ROLLBACK", inconclusive: false, phase: "FAILED", tappedBy: null, open: [] },
    { level: "paused", verdict: "ROLLBACK", inconclusive: false, phase: "FAILED", tappedBy: null, open: [] },
  ] as const;
  for (const row of table) {
    it(`${row.level} + ${row.verdict}${row.inconclusive ? " (inconclusive)" : ""} → ${row.phase}`, () => {
      const s = new RSim();
      s.autoShip = row.level === "autonomous";
      s.paused = row.level === "paused";
      const v = toValidating(s, "t1");
      expect(s.verdict(v, row.verdict, "summary", row.inconclusive).outcome).toBe("applied");
      expect(s.rel("r1")).toMatchObject({ phase: row.phase, tappedBy: row.tappedBy });
      expect(s.open()).toEqual(row.open);
      const canary = s.deploys().filter((d) => d.environment === "canary");
      expect(canary.length).toBe(row.phase === "CANARY" ? 1 : 0);
      expect(s.streak).toBe(0); // staging failures never count against the streak
    });
  }

  it("auto-ship records release.autoshipped and the phase events, and starts the 1% canary", () => {
    const s = RSim.awaitingTap({ autoShip: true });
    expect(s.rel("r1")).toMatchObject({ phase: "CANARY", tappedBy: AUTO_SHIP_ACTOR, tappedAt: 1000, step: 0, summary: `Tapped to ship by ${AUTO_SHIP_ACTOR}.` });
    expect(s.events.map((e) => e.type)).toEqual(["release.phase", "release.phase", "release.phase", "release.autoshipped"]);
    expect(s.events.find((e) => e.type === "release.autoshipped")).toMatchObject({ actor: AUTO_SHIP_ACTOR, releaseId: "r1" });
  });

  it("supervised: APPROVAL_REQUIRED offers ship/hold; a human tap resolves it as ship", () => {
    const s = RSim.awaitingTap();
    const [e] = [...s.escalations.values()];
    expect(e).toMatchObject({ reason: "APPROVAL_REQUIRED", status: "OPEN", subject: { type: "release", id: "r1" }, actions: ["ship", "hold"], hive: "hive" });
    expect(s.run((p) => p.tap("r1", "kyle@example.com")).outcome).toBe("applied");
    expect(s.escalations.get(e!.escalationId)).toMatchObject({ status: "RESOLVED", resolvedBy: "kyle@example.com", resolution: "ship", resolvedAt: 1000 });
  });

  it("paused: a tap is refused (no new canary) and works once unpaused", () => {
    const s = RSim.awaitingTap({ paused: true });
    expect(s.run((p) => p.tap("r1", "kyle@example.com")).outcome).toBe("conflict");
    expect(s.rel("r1").phase).toBe("AWAITING_TAP");
    s.paused = false;
    expect(s.run((p) => p.tap("r1", "kyle@example.com")).outcome).toBe("applied");
    expect(s.rel("r1").phase).toBe("CANARY");
  });

  it("paused: an in-flight canary still finishes", () => {
    const s = RSim.canary1();
    s.paused = true;
    endCanary(s, "ship");
    expect(s.rel("r1").phase).toBe("SHIPPED");
  });

  it("superseding a parked release resolves its APPROVAL_REQUIRED as superseded and asks about the new one", () => {
    const s = RSim.awaitingTap();
    s.land("t2");
    expect(s.rel("r1").phase).toBe("SUPERSEDED");
    expect([...s.escalations.values()].find((e) => e.subject.id === "r1")).toMatchObject({ status: "RESOLVED", resolution: "superseded", resolvedBy: "queen" });
    s.deployResult(s.deploys().at(-1)!, { url: STAGING_URL });
    s.verdict(s.sentinels().at(-1)!, "PROMOTE");
    expect(s.open()).toEqual(["APPROVAL_REQUIRED:r2"]);
  });
});

describe("release planner: reconcile auto-tap", () => {
  it("a parked release auto-taps when autoShip turns true; its APPROVAL_REQUIRED resolves as auto-shipped", () => {
    const s = RSim.awaitingTap();
    s.run((p) => p.reconcile());
    expect(s.rel("r1").phase).toBe("AWAITING_TAP");
    s.autoShip = true;
    s.run((p) => p.reconcile());
    expect(s.rel("r1")).toMatchObject({ phase: "CANARY", tappedBy: AUTO_SHIP_ACTOR });
    expect(s.deploys()).toEqual([expect.objectContaining({ environment: "canary", percent: 1, commandId: "r1-canary1-1" })]);
    expect(s.open()).toEqual([]);
    expect([...s.escalations.values()][0]).toMatchObject({ resolution: "auto-shipped", resolvedBy: AUTO_SHIP_ACTOR });
  });

  it("no auto-tap while an open SENTINEL_INCONCLUSIVE stands, nor after a human chose hold", () => {
    const s = new RSim();
    s.autoShip = true;
    s.verdict(toValidating(s, "t1"), "ROLLBACK", "readiness timeout", true);
    s.run((p) => p.reconcile());
    expect(s.rel("r1").phase).toBe("AWAITING_TAP");
    // A human holds it: still parked.
    const [e] = [...s.escalations.values()];
    s.escalations.set(e!.escalationId, { ...e!, status: "RESOLVED", resolution: "hold", resolvedBy: "kyle@example.com", resolvedAt: 1000 });
    s.run((p) => p.reconcile());
    expect(s.rel("r1").phase).toBe("AWAITING_TAP");
    // ...but a human can still ship it.
    expect(s.run((p) => p.tap("r1", "kyle@example.com")).outcome).toBe("applied");
  });

  it("no auto-tap while paused", () => {
    const s = RSim.awaitingTap({ paused: true });
    s.autoShip = true;
    s.run((p) => p.reconcile());
    expect(s.rel("r1").phase).toBe("AWAITING_TAP");
  });

  it("supervised: reconcile asks once for a parked release that never had an escalation (the migrated demo hive)", () => {
    const s = RSim.awaitingTap({ paused: true }); // parked with no escalation
    s.paused = false;
    s.run((p) => p.reconcile());
    expect(s.open()).toEqual(["APPROVAL_REQUIRED:r1"]);
    s.run((p) => p.reconcile());
    expect(s.escalations.size).toBe(1);
    // Held: never re-asked.
    const [e] = [...s.escalations.values()];
    s.escalations.set(e!.escalationId, { ...e!, status: "RESOLVED", resolution: "hold" });
    expect(s.run((p) => p.reconcile()).escalations).toEqual([]);
  });
});

describe("release planner: rollback streak and escalations", () => {
  it("each rollback bumps the streak; the 2nd opens ROLLBACK_STREAK; a ship resets it and resolves the escalation", () => {
    const s = new RSim();
    cycle(s, "t1", "rollback");
    expect(s.streak).toBe(1);
    expect(s.open()).toEqual([]);
    cycle(s, "t2", "rollback");
    expect(s.streak).toBe(2);
    expect(s.open()).toEqual(["ROLLBACK_STREAK:hive"]);
    const streakEsc = [...s.escalations.values()].find((e) => e.reason === "ROLLBACK_STREAK")!;
    expect(streakEsc.actions).toEqual(["resume_autonomy", "ack"]);
    cycle(s, "t3", "rollback");
    expect(s.streak).toBe(3);
    expect([...s.escalations.values()].filter((e) => e.reason === "ROLLBACK_STREAK")).toHaveLength(1); // still the one open
    cycle(s, "t4", "ship");
    expect(s.streak).toBe(0);
    expect(s.escalations.get(streakEsc.escalationId)).toMatchObject({ status: "RESOLVED", resolution: expect.stringMatching(/^cleared: release r\d+ shipped$/) });
  });

  it("a canary FAILED with no stable version counts toward the streak; a staging failure does not", () => {
    const s = RSim.awaitingTap();
    s.run((p) => p.tap("r1", "kyle@example.com"));
    s.deployResult(s.deploys()[0]!, { environment: "canary", ok: false, summary: "upload 500" });
    expect(s.rel("r1").phase).toBe("FAILED");
    expect(s.streak).toBe(1);
    s.verdict(toValidating(s, "t2"), "ROLLBACK");
    expect(s.streak).toBe(1);
  });

  it("a failed Herald rollback opens ROLLBACK_FAILED (ack only) and counts toward the streak", () => {
    const s = new RSim();
    const id = cycle(s, "t1", "rollback-failed");
    expect(s.rel(id).phase).toBe("FAILED");
    expect(s.streak).toBe(1);
    const e = [...s.escalations.values()].find((x) => x.reason === "ROLLBACK_FAILED")!;
    expect(e).toMatchObject({ status: "OPEN", subject: { type: "release", id }, actions: ["ack"] });
    expect(s.events.find((x) => x.type === "escalation.opened" && x.summary.startsWith("ROLLBACK_FAILED"))).toMatchObject({ severity: "error", releaseId: id });
  });

  it("an inconclusive canary verdict rolls traffic back, opens an informational SENTINEL_INCONCLUSIVE and parks (never counted)", () => {
    const s = RSim.canary1();
    s.verdict(s.sentinels().at(-1)!, "ROLLBACK", "too few requests", true);
    expect(s.rel("r1").summary).toBe("Infrastructure: Canary at 1% inconclusive: too few requests");
    const [rb] = s.herald();
    expect(rb).toEqual(expect.objectContaining({ op: "ROLLBACK" }));
    expect(s.open()).toEqual(["SENTINEL_INCONCLUSIVE:r1"]);
    expect([...s.escalations.values()].find((e) => e.reason === "SENTINEL_INCONCLUSIVE")).toMatchObject({ actions: ["ack"] });
    s.deployResult({ commandId: rb!.commandId, op: "ROLLBACK", environment: "canary" });
    expect(s.rel("r1")).toMatchObject({ phase: "AWAITING_TAP", tappedAt: null });
    expect(s.streak).toBe(0);
  });

  it("the streak passes through untouched when nothing ends", () => {
    const s = new RSim();
    s.streak = 5;
    expect(s.land("t1").rollbackStreak).toBe(5);
  });
});

describe("release planner: infrastructure failures are never the change's fault", () => {
  const HTTP503 = "Canary deploy failed: HttpError: HTTP Error: 503 Service Unavailable";

  it("live 2026-10-06 (b2c25c89): a 1% canary deploy that keeps hitting Artifacts 503 is re-issued, then parked with EXECUTOR_LOST: no rollback, no FAILED, no streak", () => {
    const s = RSim.awaitingTap({ autoShip: true });
    expect(s.rel("r1").phase).toBe("CANARY");
    for (let n = 1; n <= MAX_COMMAND_ATTEMPTS; n++) {
      const id = s.rel("r1").deployCommandId!;
      expect(id).toBe(`r1-canary1-${n}`);
      s.deploys();
      s.deployResult({ commandId: id }, { environment: "canary", ok: false, retryable: true, summary: HTTP503 });
    }
    expect(s.deploys()).toEqual([]); // nothing more, no ROLLBACK either (nothing was uploaded)
    const r = s.rel("r1");
    expect(r).toMatchObject({ phase: "AWAITING_TAP", pending: null, tappedAt: null, tappedBy: null, candidateVersionId: null });
    expect(r.summary).toMatch(/^Infrastructure: Canary deploy at 1% did not complete after 3 attempts: .*503/);
    expect(s.streak).toBe(0);
    expect(s.open()).toEqual(["EXECUTOR_LOST:r1"]);
    expect(isReleaseFailure(r)).toBe(false);
    // Parked: the autonomous reconcile does not re-ship it on its own.
    s.run((p) => p.reconcile());
    expect(s.rel("r1").phase).toBe("AWAITING_TAP");
    expect(s.deploys()).toEqual([]);
    // retry (the EXECUTOR_LOST action) restarts the canary at 1%.
    expect(s.run((p) => p.retry("r1", "kyle@example.com")).outcome).toBe("applied");
    expect(s.rel("r1")).toMatchObject({ phase: "CANARY", tappedBy: "kyle@example.com" });
    expect(s.deploys().map((c) => c.commandId)).toEqual(["r1-canary1-4"]);
  });

  it("a non-retryable canary deploy failure still takes the rollback path (and counts)", () => {
    const s = RSim.canary1();
    s.verdict(s.sentinels()[0]!, "PROMOTE");
    const [d] = s.deploys();
    s.deployResult(d!, { environment: "canary", ok: false, summary: "Script validation failed: 10021" });
    expect(s.herald()).toEqual([expect.objectContaining({ op: "ROLLBACK" })]);
  });

  it("a later-step infra stop rolls the split back to stable first, then parks", () => {
    const s = RSim.canary1();
    s.verdict(s.sentinels()[0]!, "PROMOTE"); // → 10%
    for (let n = 1; n <= MAX_COMMAND_ATTEMPTS; n++) {
      const [d] = s.deploys();
      s.deployResult(d!, { environment: "canary", ok: false, retryable: true, summary: HTTP503 });
    }
    const [rb] = s.herald();
    expect(rb).toMatchObject({ op: "ROLLBACK", toVersionId: "v-stable" });
    s.deployResult({ commandId: rb!.commandId, op: "ROLLBACK", environment: "canary" });
    expect(s.rel("r1")).toMatchObject({ phase: "AWAITING_TAP", canaryPercent: null });
    expect(s.deployments.get("prod")).toMatchObject({ versionId: "v-stable", percent: 100 });
    expect(s.streak).toBe(0);
  });

  it("a retryable staging deploy failure is re-issued, then parked in STAGING; a newer head supersedes it and clears EXECUTOR_LOST's subject", () => {
    const s = new RSim();
    s.land("t1");
    for (let n = 1; n <= MAX_COMMAND_ATTEMPTS; n++) {
      const [d] = s.deploys();
      expect(d!.commandId).toBe(`r1-staging-${n}`);
      s.deployResult(d!, { ok: false, retryable: true, summary: "Staging deploy failed: HTTP Error: 503 Service Unavailable" });
    }
    expect(s.rel("r1")).toMatchObject({ phase: "STAGING", pending: null });
    expect(s.open()).toEqual(["EXECUTOR_LOST:r1"]);
    // retry re-deploys staging.
    s.run((p) => p.retry("r1", "kyle@example.com"));
    expect(s.deploys().map((c) => c.commandId)).toEqual(["r1-staging-4"]);
    // A newer head supersedes it as any STAGING release.
    s.land("t2");
    expect(s.rel("r1").phase).toBe("SUPERSEDED");
  });

  it("a non-retryable staging deploy failure is still FAILED (the change: bad module)", () => {
    const s = new RSim();
    s.land("t1");
    s.deployResult(s.deploys()[0]!, { ok: false, summary: "Uncaught SyntaxError" });
    expect(s.rel("r1").phase).toBe("FAILED");
  });

  it("a staging Sentinel that never reports is inconclusive (parked for a human), not FAILED", () => {
    const s = new RSim();
    s.land("t1");
    s.deployResult(s.deploys()[0]!, { url: STAGING_URL });
    s.sentinels();
    for (let n = 2; n <= MAX_COMMAND_ATTEMPTS + 1; n++) {
      s.now += sentinelTimeoutMs(T, 60);
      s.run((p) => p.reconcile());
    }
    expect(s.rel("r1").phase).toBe("AWAITING_TAP");
    expect(s.open()).toEqual(["SENTINEL_INCONCLUSIVE:r1"]);
  });
});

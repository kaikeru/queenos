import { describe, expect, it } from "vitest";
import { DeployResultSchema } from "@queenos/queen-types";
import { HeraldFailedError, NOT_IMPLEMENTED, runHerald } from "../src/orchestrate";
import { FakeWorld, InlineSteps, PREVIEW, SHA, TEMPLATE_FILES, TOKEN, TRAIN, apiError, deploy, teardown } from "./fakes";

const WORKER = "my-hive-app";

describe("preview DEPLOY", () => {
  it("clones at the commit, uploads src/**/*.js as modules, creates the Preview and reports its URL", async () => {
    const w = new FakeWorld();
    const steps = new InlineSteps();
    const out = await runHerald(deploy(), steps, w.ports());

    expect(w.artifacts.calls).toEqual([{ repo: "hive-train-aaaaaaaaaaaa", scope: "read" }]);
    expect(w.cloudflare.calls).toEqual([
      `ensureWorker:${WORKER}`,
      `getPreview:${WORKER}/${PREVIEW}`,
      `createPreview:${WORKER}/${PREVIEW}`,
      `deployPreview:${WORKER}/id-${PREVIEW}`,
    ]);
    const dep = w.cloudflare.deployments[0]!.input;
    expect(dep.mainModule).toBe("src/index.js");
    expect(dep.compatibilityDate).toBe("2026-10-02");
    expect(dep.modules.map((m) => [m.name, m.contentType])).toEqual([
      ["src/features/index.js", "application/javascript+module"],
      ["src/index.js", "application/javascript+module"],
    ]);
    expect(dep.modules[1]!.content).toBe(TEMPLATE_FILES["src/index.js"]);
    expect(dep.annotations).toMatchObject({ "workers/commit_sha": SHA });

    expect(w.queenHives).toEqual(["My Hive"]);
    const r = DeployResultSchema.parse(w.queen.results[0]);
    expect(r).toMatchObject({
      commandId: "cmd-1",
      op: "DEPLOY",
      environment: "preview",
      trainId: TRAIN,
      ok: true,
      // the Preview alias, not the deployment-pinned URL: only the alias dies on TEARDOWN
      url: `https://${PREVIEW}-${WORKER}.sub.workers.dev`,
      versionId: "dep-1",
      commitSha: SHA,
    });
    expect(r.summary!.length).toBeLessThanOrEqual(500);
    expect(out).toMatchObject({ ok: true, queenOutcome: "applied" });
    expect(steps.log.map((l) => l.name)).toEqual(["ensure parent worker", "read source, deploy preview", "report: deploy result"]);
  });

  it("never lets the token into step results or the reported result", async () => {
    const w = new FakeWorld();
    const steps = new InlineSteps();
    await runHerald(deploy(), steps, w.ports());
    expect(steps.results.join("\n")).not.toContain(TOKEN);
    expect(steps.results.join("\n")).not.toContain("art_v1_secret");
    expect(JSON.stringify(w.queen.results)).not.toContain(TOKEN);
  });

  it("a second deploy for the same train updates the existing Preview", async () => {
    const w = new FakeWorld();
    await runHerald(deploy(), new InlineSteps(), w.ports());
    w.cloudflare.calls.length = 0;
    await runHerald(deploy({ commandId: "cmd-3" }), new InlineSteps(), w.ports());
    expect(w.cloudflare.calls).toEqual([`ensureWorker:${WORKER}`, `getPreview:${WORKER}/${PREVIEW}`, `deployPreview:${WORKER}/id-${PREVIEW}`]);
    expect(w.queen.results[1]).toMatchObject({ ok: true, summary: expect.stringMatching(/^Updated/) });
  });

  it("reports the Preview alias URL, never the deployment-pinned one (which outlives TEARDOWN)", async () => {
    const w = new FakeWorld();
    w.cloudflare.previews.set(PREVIEW, { id: "pid", name: PREVIEW, urls: ["https://alias.example.dev"] });
    await runHerald(deploy(), new InlineSteps(), w.ports());
    expect(w.queen.results[0]).toMatchObject({ ok: true, url: "https://alias.example.dev" });
    expect(w.queen.results[0]!.url).not.toMatch(/dep1-/);
  });

  it("falls back to the deployment URL when the Preview has no alias", async () => {
    const w = new FakeWorld();
    w.cloudflare.previews.set(PREVIEW, { id: "pid", name: PREVIEW, urls: [] });
    await runHerald(deploy(), new InlineSteps(), w.ports());
    expect(w.queen.results[0]).toMatchObject({ ok: true, url: `https://dep1-${WORKER}.sub.workers.dev` });
  });

  it("reports ok:false when Cloudflare returns no URL at all", async () => {
    const w = new FakeWorld();
    w.cloudflare.noUrls = true;
    const out = await runHerald(deploy(), new InlineSteps(), w.ports());
    expect(out.ok).toBe(false);
    expect(w.queen.results[0]).toMatchObject({ ok: false, summary: expect.stringMatching(/no URL/) });
    expect(w.queen.results[0]!.url).toBeUndefined();
  });

  it("a REST failure becomes ok:false with a summary; permanent 4xx is not retried", async () => {
    const w = new FakeWorld();
    w.cloudflare.failWith = { method: "deployPreview", error: apiError(400, 10021, false, "bad module") };
    const steps = new InlineSteps();
    const out = await runHerald(deploy(), steps, w.ports());
    expect(out.ok).toBe(false);
    expect(steps.log.find((l) => l.name === "read source, deploy preview")).toEqual({ name: "read source, deploy preview", attempts: 1, ok: false });
    expect(w.queen.results[0]).toMatchObject({ ok: false, op: "DEPLOY", trainId: TRAIN });
    expect(w.queen.results[0]!.summary).toMatch(/Preview deploy failed: .*HTTP 400.*bad module/);
    expect(w.queen.results[0]!.versionId).toBeUndefined();
  });

  it("a retryable REST failure (5xx) is retried by the step", async () => {
    const w = new FakeWorld();
    let n = 0;
    const real = w.cloudflare.createPreview.bind(w.cloudflare);
    w.cloudflare.createPreview = async (worker, name) => {
      if (++n < 3) throw apiError(503, 0, true);
      return real(worker, name);
    };
    const steps = new InlineSteps();
    const out = await runHerald(deploy(), steps, w.ports());
    expect(out.ok).toBe(true);
    expect(steps.log.find((l) => l.name === "read source, deploy preview")!.attempts).toBe(3);
  });

  it("exhausted retries report ok:false, with the summary clipped to 500 chars", async () => {
    const w = new FakeWorld();
    w.cloudflare.failWith = { method: "ensureWorker", error: apiError(500, 0, true, "x".repeat(900)) };
    const out = await runHerald(deploy(), new InlineSteps(), w.ports());
    expect(out.ok).toBe(false);
    expect(w.queen.results[0]!.summary!.length).toBe(500);
    expect(DeployResultSchema.safeParse(w.queen.results[0]).success).toBe(true);
  });

  it("source problems are permanent: missing deploy.json, bad main, oversized module, stale head", async () => {
    const cases: [Record<string, string>, RegExp, string?][] = [
      [{ "src/index.js": "x" }, /\.queen\/deploy\.json not found/],
      [{ ...TEMPLATE_FILES, ".queen/deploy.json": '{"main":"src/nope.js","compatibility_date":"2026-10-02"}' }, /main "src\/nope\.js"/],
      [{ ...TEMPLATE_FILES, ".queen/deploy.json": "{" }, /invalid \.queen\/deploy\.json/],
      [{ ...TEMPLATE_FILES, "src/big.js": "a".repeat(300 * 1024) }, /src\/big\.js is \d+ bytes/],
    ];
    for (const [files, re] of cases) {
      const w = new FakeWorld();
      w.git.files = files;
      const steps = new InlineSteps();
      const out = await runHerald(deploy(), steps, w.ports());
      expect(out.ok).toBe(false);
      expect(w.queen.results[0]!.summary).toMatch(re);
      expect(steps.log.find((l) => l.name === "read source, deploy preview")!.attempts).toBe(1);
      expect(w.cloudflare.deployments).toHaveLength(0);
    }

    const stale = new FakeWorld();
    stale.git.headOid = "d".repeat(40);
    const steps = new InlineSteps();
    const out = await runHerald(deploy(), steps, stale.ports());
    expect(out.ok).toBe(false);
    expect(stale.queen.results[0]!.summary).toMatch(/is not the requested commit/);
    expect(steps.log.find((l) => l.name === "read source, deploy preview")!.attempts).toBeGreaterThan(1);
  });

  it("a preview deploy needs a trainId", async () => {
    const w = new FakeWorld();
    const out = await runHerald(deploy({ trainId: undefined }), new InlineSteps(), w.ports());
    expect(out).toMatchObject({ ok: false, summary: "a preview deploy needs a trainId" });
    expect(w.cloudflare.calls).toEqual([]);
  });
});

describe("preview TEARDOWN", () => {
  it("deletes the train's Preview and reports", async () => {
    const w = new FakeWorld();
    await runHerald(deploy(), new InlineSteps(), w.ports());
    const out = await runHerald(teardown(), new InlineSteps(), w.ports());
    expect(w.cloudflare.calls.at(-1)).toBe(`deletePreview:${WORKER}/${PREVIEW}`);
    expect(out).toMatchObject({ op: "TEARDOWN", ok: true });
    expect(w.queen.results.at(-1)).toMatchObject({ commandId: "cmd-2", op: "TEARDOWN", environment: "preview", trainId: TRAIN, ok: true, summary: expect.stringMatching(/^Deleted/) });
    expect(w.artifacts.calls).toHaveLength(1); // teardown reads no source
  });

  it("a missing Preview is still ok; a REST failure is ok:false", async () => {
    const w = new FakeWorld();
    await runHerald(teardown(), new InlineSteps(), w.ports());
    expect(w.queen.results[0]).toMatchObject({ ok: true, summary: expect.stringMatching(/already gone/) });

    const f = new FakeWorld();
    f.cloudflare.failWith = { method: "deletePreview", error: apiError(403, 10000, false, "Authentication error") };
    const out = await runHerald(teardown(), new InlineSteps(), f.ports());
    expect(out.ok).toBe(false);
    expect(f.queen.results[0]!.summary).toMatch(/teardown failed: .*403/);
  });
});

const APP = "my-hive-app";
const STAGING = "my-hive-staging";
const canary = (o: Parameters<typeof deploy>[0] = {}) => deploy({ environment: "canary", trainId: undefined, releaseId: "rel-1", percent: 10, ...o });

describe("staging DEPLOY", () => {
  it("ensures <hive>-staging with workers.dev, uploads a version and deploys it at 100%", async () => {
    const w = new FakeWorld();
    const steps = new InlineSteps();
    const out = await runHerald(deploy({ environment: "staging", trainId: undefined, releaseId: "rel-1" }), steps, w.ports());

    expect(w.cloudflare.calls).toEqual([
      `ensureWorker:${STAGING}`,
      `enableSubdomain:${STAGING}`,
      `uploadVersion:${STAGING}`,
      `createDeployment:${STAGING}`,
      `workerUrl:${STAGING}`,
    ]);
    expect(w.artifacts.calls).toEqual([{ repo: "hive-train-aaaaaaaaaaaa", scope: "read" }]);
    const up = w.cloudflare.uploads[0]!;
    expect(up.input.mainModule).toBe("src/index.js");
    expect(up.input.modules.map((m) => m.name)).toEqual(["src/features/index.js", "src/index.js"]);
    expect(up.input.annotations).toMatchObject({ "workers/commit_sha": SHA });
    expect(w.cloudflare.created).toEqual([{ script: STAGING, versions: [{ versionId: "ver-1", percentage: 100 }], force: false }]);

    const r = DeployResultSchema.parse(w.queen.results[0]);
    expect(r).toMatchObject({ op: "DEPLOY", environment: "staging", ok: true, url: `https://${STAGING}.sub.workers.dev`, versionId: "ver-1", releaseId: "rel-1", percent: 100, commitSha: SHA });
    expect(r.trainId).toBeUndefined();
    expect(r.summary!.length).toBeLessThanOrEqual(500);
    expect(out).toMatchObject({ ok: true });
  });

  it("a REST failure becomes ok:false with a summary; the token never appears", async () => {
    const w = new FakeWorld();
    w.cloudflare.failWith = { method: "createDeployment", error: apiError(400, 10021, false, "bad version") };
    const steps = new InlineSteps();
    const out = await runHerald(deploy({ environment: "staging", releaseId: "rel-1" }), steps, w.ports());
    expect(out.ok).toBe(false);
    expect(w.queen.results[0]).toMatchObject({ ok: false, environment: "staging", releaseId: "rel-1" });
    expect(w.queen.results[0]!.summary).toMatch(/^Staging deploy failed: .*HTTP 400.*bad version/);
    expect(w.queen.results[0]!.url).toBeUndefined();
    expect(steps.results.join("\n") + JSON.stringify(w.queen.results)).not.toContain(TOKEN);
  });

  it("a commit that is no longer the repo head is reported as superseded and never uploaded", async () => {
    const w = new FakeWorld();
    w.git.headOid = "d".repeat(40);
    const out = await runHerald(deploy({ environment: "staging", releaseId: "rel-1" }), new InlineSteps(), w.ports());
    expect(out).toMatchObject({ ok: false, summary: "superseded" });
    expect(w.queen.results[0]).toMatchObject({ ok: false, summary: "superseded", releaseId: "rel-1" });
    expect(w.cloudflare.uploads).toHaveLength(0);
    expect(w.cloudflare.created).toHaveLength(0);
  });

  it("source problems are permanent (not retried)", async () => {
    const w = new FakeWorld();
    w.git.files = { "src/index.js": "x" };
    const steps = new InlineSteps();
    const out = await runHerald(deploy({ environment: "staging" }), steps, w.ports());
    expect(out.ok).toBe(false);
    expect(steps.log.find((l) => l.name === "read source, upload, deploy staging")!.attempts).toBe(1);
    expect(w.cloudflare.uploads).toHaveLength(0);
  });
});

describe("canary DEPLOY", () => {
  it("first step with a stable version: uploads the candidate and splits candidate / stable", async () => {
    const w = new FakeWorld();
    w.cloudflare.scriptDeployments.set(APP, [{ id: "d0", createdOn: "", versions: [{ versionId: "stable-1", percentage: 100 }] }]);
    const out = await runHerald(canary({ percent: 10 }), new InlineSteps(), w.ports());

    expect(w.cloudflare.calls).toEqual([
      `ensureWorker:${APP}`,
      `enableSubdomain:${APP}`,
      `uploadVersion:${APP}`,
      `getCurrentDeployment:${APP}`,
      `createDeployment:${APP}`,
      `workerUrl:${APP}`,
    ]);
    expect(w.cloudflare.created[0]!.versions).toEqual([
      { versionId: "ver-1", percentage: 10 },
      { versionId: "stable-1", percentage: 90 },
    ]);
    const r = DeployResultSchema.parse(w.queen.results[0]);
    expect(r).toMatchObject({ ok: true, environment: "canary", versionId: "ver-1", stableVersionId: "stable-1", percent: 10, releaseId: "rel-1", url: `https://${APP}.sub.workers.dev` });
    expect(out.ok).toBe(true);
  });

  it("first step without a stable version (first prod deploy): candidate at 100%, no stableVersionId", async () => {
    const w = new FakeWorld();
    await runHerald(canary({ percent: 10 }), new InlineSteps(), w.ports());
    expect(w.cloudflare.created[0]!.versions).toEqual([{ versionId: "ver-1", percentage: 100 }]);
    const r = DeployResultSchema.parse(w.queen.results[0]);
    expect(r).toMatchObject({ ok: true, versionId: "ver-1", percent: 100 });
    expect(r.stableVersionId).toBeUndefined();
    expect(r.summary).toMatch(/first prod deploy/);
  });

  it("a later step reuses versionId: no source read, no upload, only a new split", async () => {
    const w = new FakeWorld();
    await runHerald(canary({ percent: 50, versionId: "cand-9", stableVersionId: "stable-1" }), new InlineSteps(), w.ports());
    expect(w.artifacts.calls).toEqual([]);
    expect(w.cloudflare.uploads).toEqual([]);
    expect(w.cloudflare.created[0]!.versions).toEqual([
      { versionId: "cand-9", percentage: 50 },
      { versionId: "stable-1", percentage: 50 },
    ]);
    expect(w.queen.results[0]).toMatchObject({ ok: true, versionId: "cand-9", stableVersionId: "stable-1", percent: 50, releaseId: "rel-1" });
  });

  it("100% deploys the candidate alone", async () => {
    const w = new FakeWorld();
    await runHerald(canary({ percent: 100, versionId: "cand-9", stableVersionId: "stable-1" }), new InlineSteps(), w.ports());
    expect(w.cloudflare.created[0]!.versions).toEqual([{ versionId: "cand-9", percentage: 100 }]);
    expect(w.queen.results[0]).toMatchObject({ ok: true, percent: 100, versionId: "cand-9" });
  });

  it("the stable version is read from the live deployment even when it is a split (largest share)", async () => {
    const w = new FakeWorld();
    w.cloudflare.scriptDeployments.set(APP, [{ id: "d0", createdOn: "", versions: [{ versionId: "old-cand", percentage: 10 }, { versionId: "stable-1", percentage: 90 }] }]);
    await runHerald(canary({ percent: 1 }), new InlineSteps(), w.ports());
    expect(w.queen.results[0]).toMatchObject({ stableVersionId: "stable-1", percent: 1 });
  });

  it("REST failures become ok:false with a summary (upload and deploy)", async () => {
    for (const method of ["uploadVersion", "createDeployment"]) {
      const w = new FakeWorld();
      w.cloudflare.failWith = { method, error: apiError(400, 10021, false, "rejected") };
      const out = await runHerald(canary(), new InlineSteps(), w.ports());
      expect(out.ok).toBe(false);
      expect(w.queen.results[0]).toMatchObject({ ok: false, environment: "canary", releaseId: "rel-1" });
      expect(w.queen.results[0]!.summary).toMatch(/^Canary deploy failed: .*rejected/);
      expect(w.queen.results[0]!.versionId).toBeUndefined();
    }
  });

  it("a retryable deployment failure is retried by its step without re-uploading", async () => {
    const w = new FakeWorld();
    w.cloudflare.deploymentErrors = [apiError(503, 0, true)];
    const steps = new InlineSteps();
    const out = await runHerald(canary(), steps, w.ports());
    expect(out.ok).toBe(true);
    expect(w.cloudflare.uploads).toHaveLength(1);
    expect(steps.log.find((l) => l.name === "deploy canary split")!.attempts).toBe(2);
  });

  it("never lets the token into step results or reports", async () => {
    const w = new FakeWorld();
    const steps = new InlineSteps();
    await runHerald(canary(), steps, w.ports());
    expect(steps.results.join("\n")).not.toContain(TOKEN);
    expect(JSON.stringify(w.queen.results)).not.toContain(TOKEN);
  });
});

describe("canary ROLLBACK", () => {
  const rollback = { op: "ROLLBACK" as const, commandId: "cmd-9", hive: "My Hive", environment: "canary" as const, toVersionId: "stable-1" };

  it("deploys the target version alone at 100%", async () => {
    const w = new FakeWorld();
    const out = await runHerald(rollback, new InlineSteps(), w.ports());
    expect(w.cloudflare.created).toEqual([{ script: APP, versions: [{ versionId: "stable-1", percentage: 100 }], force: false }]);
    expect(w.queen.results[0]).toMatchObject({ op: "ROLLBACK", environment: "canary", ok: true, versionId: "stable-1", percent: 100 });
    expect(out.ok).toBe(true);
  });

  it("retries with force=true on a secrets-mismatch refusal", async () => {
    const w = new FakeWorld();
    w.cloudflare.deploymentErrors = [apiError(400, 10215, false, "secrets differ between versions")];
    const out = await runHerald(rollback, new InlineSteps(), w.ports());
    expect(w.cloudflare.calls.filter((c) => c.startsWith("createDeployment"))).toEqual([`createDeployment:${APP}`, `createDeployment:${APP}:force`]);
    expect(w.cloudflare.created).toEqual([{ script: APP, versions: [{ versionId: "stable-1", percentage: 100 }], force: true }]);
    expect(out.ok).toBe(true);
    expect(w.queen.results[0]!.summary).toMatch(/forced/);
  });

  it("does not force on other refusals, and reports ok:false", async () => {
    const w = new FakeWorld();
    w.cloudflare.deploymentErrors = [apiError(400, 10021, false, "version not found")];
    const out = await runHerald(rollback, new InlineSteps(), w.ports());
    expect(out.ok).toBe(false);
    expect(w.cloudflare.created).toEqual([]);
    expect(w.queen.results[0]!.summary).toMatch(/^Rollback failed: .*version not found/);
  });
});

describe("other environments and ops", () => {
  it.each([
    [deploy({ environment: "prod" })],
    [teardown({ environment: "staging" })],
    [teardown({ environment: "canary" })],
    [{ op: "ROLLBACK" as const, commandId: "cmd-9", hive: "h", environment: "prod" as const, toVersionId: "v1" }],
    [{ op: "ROLLBACK" as const, commandId: "cmd-9", hive: "h", environment: "preview" as const, toVersionId: "v1" }],
  ])("reports not implemented without touching Cloudflare: %#", async (cmd) => {
    const w = new FakeWorld();
    const out = await runHerald(cmd, new InlineSteps(), w.ports());
    expect(out).toMatchObject({ ok: false, summary: NOT_IMPLEMENTED });
    expect(w.queen.results).toEqual([expect.objectContaining({ commandId: cmd.commandId, ok: false, summary: "not implemented (P3)" })]);
    expect(w.cloudflare.calls).toEqual([]);
    expect(w.credentials.calls).toBe(0);
  });
});

describe("reporting", () => {
  it("swallows a permanent Queen rejection but retries transient ones", async () => {
    const w = new FakeWorld();
    w.queen.error = new Error("NOT_FOUND: unknown command");
    expect((await runHerald(teardown(), new InlineSteps(), w.ports())).queenOutcome).toMatch(/^rejected: NOT_FOUND/);

    const w2 = new FakeWorld();
    w2.queen.error = new Error("network down");
    await expect(runHerald(teardown(), new InlineSteps(), w2.ports())).rejects.toThrow("network down");
  });

  it("rejects an invalid command outside any step", async () => {
    const steps = new InlineSteps();
    await expect(runHerald({ op: "DEPLOY" }, steps, new FakeWorld().ports())).rejects.toBeInstanceOf(HeraldFailedError);
    expect(steps.log).toEqual([]);
  });
});

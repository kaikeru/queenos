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
      url: `https://dep1-${WORKER}.sub.workers.dev`,
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

  it("falls back to the Preview's own URL when the deployment has none", async () => {
    const w = new FakeWorld();
    w.cloudflare.previews.set(PREVIEW, { id: "pid", name: PREVIEW, urls: ["https://stable.example.dev"] });
    w.cloudflare.deployPreview = async () => ({ id: "dep-x", urls: [] });
    await runHerald(deploy(), new InlineSteps(), w.ports());
    expect(w.queen.results[0]).toMatchObject({ ok: true, url: "https://stable.example.dev" });
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

describe("other environments and ops", () => {
  it.each([
    [deploy({ environment: "staging" })],
    [deploy({ environment: "canary", percent: 10 })],
    [deploy({ environment: "prod" })],
    [teardown({ environment: "staging" })],
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

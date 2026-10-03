import { describe, expect, it } from "vitest";
import { runProvision } from "../src/orchestrate";
import { TEMPLATES } from "../src/templates.generated";
import { createHive, FakeWorld, InlineSteps } from "./fakes";

describe("CREATE_HIVE", () => {
  it("creates the repo, seeds template + charter on main and reports mainSha to Genesis", async () => {
    const w = new FakeWorld();
    const steps = new InlineSteps();
    const r = await runProvision(createHive(), steps, w.ports());
    expect(r).toMatchObject({ commandId: "cmd-3", op: "CREATE_HIVE", ok: true, queenOutcome: "applied" });
    expect(w.queen.results).toEqual([]);
    expect(w.genesis.results).toHaveLength(1);
    const res = w.genesis.results[0]!;
    expect(res).toMatchObject({ commandId: "cmd-3", hive: "my-hive", ok: true });
    expect(res.mainSha).toMatch(/^[0-9a-f]{40}$/);
    expect(w.git.pushes).toEqual([{ url: "https://fake.artifacts/git/my-hive.git", oid: res.mainSha }]);

    const files = w.git.files[0]!;
    for (const [path, content] of Object.entries(TEMPLATES["worker-starter"]!)) expect(files[path]).toBe(content);
    expect(files[".queen/charter.json"]).toBe(`${JSON.stringify({ version: 1, hive: "my-hive", name: "My Hive" }, null, 2)}\n`);
    expect(w.artifacts.mains.get("my-hive")![0]!.message).toContain("Queen-Genesis: cmd-3");
  });

  it("treats an existing repo as success and retries transient failures", async () => {
    const w = new FakeWorld();
    w.artifacts.existing.add("my-hive");
    w.artifacts.ensureFailures = 1;
    w.git.pushFailures = 2;
    const steps = new InlineSteps();
    const r = await runProvision(createHive(), steps, w.ports());
    expect(r.ok).toBe(true);
    expect(steps.log.find((l) => l.name === "seed main")?.attempts).toBe(3);
    expect(w.git.pushes).toHaveLength(1);
  });

  it("a retried command finds the seed commit and reports the existing SHA without pushing again", async () => {
    const w = new FakeWorld();
    await runProvision(createHive(), new InlineSteps(), w.ports());
    const first = w.genesis.results[0]!.mainSha;
    // Same command replayed, and a re-launch under a new commandId.
    await runProvision(createHive(), new InlineSteps(), w.ports());
    await runProvision(createHive({ commandId: "cmd-4" }), new InlineSteps(), w.ports());
    expect(w.genesis.results.map((x) => x.mainSha)).toEqual([first, first, first]);
    expect(w.git.pushes).toHaveLength(1);
    expect(w.genesis.results[2]).toMatchObject({ commandId: "cmd-4", ok: true });
  });

  it("reports ok:false for invalid charter JSON and permanent Artifacts errors", async () => {
    const w = new FakeWorld();
    await runProvision(createHive({ charterJson: "{not json" }), new InlineSteps(), w.ports());
    expect(w.genesis.results[0]).toMatchObject({ ok: false });
    expect(w.genesis.results[0]!.summary).toMatch(/not valid JSON/);
    expect(w.git.pushes).toHaveLength(0);

    const w2 = new FakeWorld();
    w2.artifacts.ensureRepo = async () => {
      throw Object.assign(new Error("INVALID_NAME"), { code: "INVALID_NAME" });
    };
    const steps = new InlineSteps();
    await runProvision(createHive(), steps, w2.ports());
    expect(w2.genesis.results[0]).toMatchObject({ ok: false });
    expect(steps.log.find((l) => l.name === "create repo")?.attempts).toBe(1);
  });

  it("does not retry when Genesis rejects the report permanently", async () => {
    const w = new FakeWorld();
    w.genesis.error = new Error("CONFLICT: not launching");
    const r = await runProvision(createHive(), new InlineSteps(), w.ports());
    expect(r.queenOutcome).toMatch(/^rejected: /);
  });
});

import { describe, expect, it } from "vitest";
import { ProvisionResultSchema } from "@queenos/queen-types";
import { ProvisionFailedError, runProvision } from "../src/orchestrate";
import { FakeWorld, InlineSteps, artifactsError, del, fork } from "./fakes";

describe("runProvision FORK", () => {
  it("forks and reports the repo + base SHA to the hive's Queen", async () => {
    const w = new FakeWorld();
    const steps = new InlineSteps();
    const out = await runProvision(fork(), steps, w.ports());

    expect(w.artifacts.calls).toEqual(["fork:hive->hive-train-aaaaaaaaaaaa"]);
    expect(w.queenHives).toEqual(["hive"]);
    expect(w.queen.results).toHaveLength(1);
    const r = ProvisionResultSchema.parse(w.queen.results[0]);
    expect(r).toMatchObject({ commandId: "cmd-1", op: "FORK", trainId: "train-1", ok: true, artifactRepo: "hive-train-aaaaaaaaaaaa", baseSha: "a".repeat(40) });
    expect(r.summary!.length).toBeLessThanOrEqual(500);
    expect(out).toMatchObject({ ok: true, queenOutcome: "applied" });
    expect(steps.log.map((l) => l.name)).toEqual(["fork", "report: provision result"]);
  });

  it("retries a transient failure inside the step", async () => {
    const w = new FakeWorld();
    w.artifacts.transientFailures = 2;
    const steps = new InlineSteps();
    await runProvision(fork(), steps, w.ports());
    expect(steps.log[0]).toEqual({ name: "fork", attempts: 3, ok: true });
    expect(w.queen.results[0]!.ok).toBe(true);
  });

  it("a permanent Artifacts error is not retried and is reported ok:false", async () => {
    const w = new FakeWorld();
    w.artifacts.forkError = artifactsError("NOT_FOUND");
    const steps = new InlineSteps();
    const out = await runProvision(fork(), steps, w.ports());
    expect(steps.log[0]).toEqual({ name: "fork", attempts: 1, ok: false });
    expect(out.ok).toBe(false);
    expect(w.queen.results[0]).toMatchObject({ ok: false, op: "FORK", trainId: "train-1" });
    expect(w.queen.results[0]!.artifactRepo).toBeUndefined();
    expect(w.queen.results[0]!.summary).toMatch(/Fork failed: NOT_FOUND/);
  });

  it("exhausted retries still report, with the summary clipped to 500 chars", async () => {
    const w = new FakeWorld();
    w.artifacts.forkError = new Error("boom ".repeat(400));
    const out = await runProvision(fork(), new InlineSteps(), w.ports());
    expect(out.ok).toBe(false);
    expect(w.queen.results[0]!.summary!.length).toBe(500);
    expect(ProvisionResultSchema.safeParse(w.queen.results[0]).success).toBe(true);
  });

  it("forks from a car's fork repo (any source repo name, not only the hive repo) with no special-casing", async () => {
    const w = new FakeWorld();
    // A car is a merge train that forked from another train (or main).
    // The sourceRepo here is a car fork repo name, not the hive repo.
    const carForkSourceRepo = "hive-car-k23-xyz-abcdef";
    const steps = new InlineSteps();
    const out = await runProvision(
      fork({ sourceRepo: carForkSourceRepo, forkName: "hive-train-bbbbbbbbbbbb" }),
      steps,
      w.ports()
    );

    // Verify that Artifacts was called with the car fork repo as the source.
    expect(w.artifacts.calls).toEqual(["fork:hive-car-k23-xyz-abcdef->hive-train-bbbbbbbbbbbb"]);
    expect(out).toMatchObject({ ok: true });
    const r = ProvisionResultSchema.parse(w.queen.results[0]);
    expect(r).toMatchObject({
      commandId: "cmd-1",
      op: "FORK",
      trainId: "train-1",
      ok: true,
      artifactRepo: "hive-train-bbbbbbbbbbbb",
      baseSha: "a".repeat(40),
    });
  });
});

describe("runProvision NOTE", () => {
  it("never deletes: reports a non-destructive failure", async () => {
    const w = new FakeWorld();
    const steps = new InlineSteps();
    const out = await runProvision(
      { op: "NOTE", commandId: "cmd-9", hive: "hive", trainId: "train-1", repo: "hive-train-aaaaaaaaaaaa", sha: "a".repeat(40), text: "hello" },
      steps,
      w.ports(),
    );
    expect(w.artifacts.calls.filter((c) => c.startsWith("delete"))).toEqual([]);
    expect(w.artifacts.calls).toEqual([]);
    expect(out).toMatchObject({ op: "NOTE", ok: false });
    expect(w.queen.results[0]).toMatchObject({ commandId: "cmd-9", op: "NOTE", ok: false, summary: "NOTE not supported by this provisioner yet" });
  });
});

describe("runProvision DELETE", () => {
  it("deletes and reports", async () => {
    const w = new FakeWorld();
    w.artifacts.existing.add("hive-train-aaaaaaaaaaaa");
    const out = await runProvision(del(), new InlineSteps(), w.ports());
    expect(w.artifacts.calls).toEqual(["delete:hive-train-aaaaaaaaaaaa"]);
    expect(out).toMatchObject({ op: "DELETE", ok: true });
    expect(w.queen.results[0]).toMatchObject({ commandId: "cmd-2", op: "DELETE", ok: true, summary: "Deleted hive-train-aaaaaaaaaaaa." });
  });

  it("a repo that is already gone is still ok", async () => {
    const w = new FakeWorld();
    await runProvision(del(), new InlineSteps(), w.ports());
    expect(w.queen.results[0]).toMatchObject({ ok: true, summary: expect.stringMatching(/already gone/) });
  });
});

describe("reporting", () => {
  it("swallows a permanent Queen rejection but retries transient ones", async () => {
    const w = new FakeWorld();
    w.queen.error = new Error("NOT_FOUND: unknown command");
    const out = await runProvision(fork(), new InlineSteps(), w.ports());
    expect(out.queenOutcome).toMatch(/^rejected: NOT_FOUND/);

    const w2 = new FakeWorld();
    w2.queen.error = new Error("network down");
    await expect(runProvision(fork(), new InlineSteps(), w2.ports())).rejects.toThrow("network down");
  });

  it("rejects an invalid command outside any step", async () => {
    const w = new FakeWorld();
    const steps = new InlineSteps();
    await expect(runProvision({ op: "FORK" }, steps, w.ports())).rejects.toBeInstanceOf(ProvisionFailedError);
    expect(steps.log).toEqual([]);
  });
});

describe("runProvision hive memory recall", () => {
  const mem = { memoryId: "t0:abc", trainId: "t0", promptId: "p0", outcome: "PASSED" as const, promptText: "add x", text: "Prompt: add x", createdAt: 1, score: 0.9 };

  it("recalls after the fork and puts memories on the result", async () => {
    const w = new FakeWorld();
    w.recall.memories = [mem];
    const steps = new InlineSteps();
    await runProvision(fork({ recallQuery: "add a health route" }), steps, w.ports());
    expect(w.recall.calls).toEqual([{ namespace: "hive", query: "add a health route", excludeTrainId: "train-1" }]);
    expect(steps.log.map((l) => l.name)).toEqual(["fork", "memory: recall", "report: provision result"]);
    const r = ProvisionResultSchema.parse(w.queen.results[0]);
    expect(r.ok).toBe(true);
    expect(r.memories).toEqual([mem]);
  });

  it("a recall error still gives an ok fork with memories: []", async () => {
    const w = new FakeWorld();
    w.recall.error = new Error("vectorize down");
    const out = await runProvision(fork({ recallQuery: "q" }), new InlineSteps(), w.ports());
    expect(out.ok).toBe(true);
    expect(w.queen.results[0]).toMatchObject({ ok: true, artifactRepo: "hive-train-aaaaaaaaaaaa", memories: [] });
  });

  it("does not recall without a recallQuery", async () => {
    const w = new FakeWorld();
    const steps = new InlineSteps();
    await runProvision(fork(), steps, w.ports());
    await runProvision(fork({ recallQuery: "  " }), steps, w.ports());
    expect(w.recall.calls).toEqual([]);
    expect(steps.log.map((l) => l.name)).not.toContain("memory: recall");
    expect(w.queen.results[0]!.memories).toBeUndefined();
  });

  it("does not recall on DELETE or a failed fork", async () => {
    const w = new FakeWorld();
    await runProvision({ ...del(), recallQuery: "q" }, new InlineSteps(), w.ports());
    w.artifacts.forkError = artifactsError("NOT_FOUND");
    await runProvision(fork({ recallQuery: "q" }), new InlineSteps(), w.ports());
    expect(w.recall.calls).toEqual([]);
    expect(w.queen.results[1]).toMatchObject({ ok: false });
    expect(w.queen.results[1]!.memories).toBeUndefined();
  });
});

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

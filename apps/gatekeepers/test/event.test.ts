import { describe, expect, it } from "vitest";
import { classifyPush, gateInstanceId, parsePushEvent, ZERO_SHA } from "../src/event";
import { handlePush } from "../src/orchestrate";
import { FakeWorld, InlineSteps, REPO, config, pushedEnvelope } from "./fakes";

const opts = { artifactsNamespace: "queenos" };
const classify = (o: Parameters<typeof pushedEnvelope>[0]) => {
  const p = parsePushEvent(pushedEnvelope(o));
  if (!p.ok) throw new Error(p.error);
  return classifyPush(p.event, opts);
};

describe("push event parsing", () => {
  it("parses the documented envelope and tolerates unknown fields", () => {
    const p = parsePushEvent(pushedEnvelope());
    expect(p).toMatchObject({ ok: true, event: { namespace: "queenos", repoName: REPO, ref: "refs/heads/main", commitMessages: ["queen(build): x"] } });
  });

  it("also accepts the flat inner-payload shape", () => {
    const p = parsePushEvent({ repoName: REPO, ref: "refs/heads/main", after: "a".repeat(40), commits: [] });
    expect(p.ok).toBe(true);
  });

  it("rejects garbage", () => {
    expect(parsePushEvent({ nope: 1 }).ok).toBe(false);
    expect(parsePushEvent(null).ok).toBe(false);
  });
});

describe("push filter", () => {
  it("gates a push to a train fork", () => {
    expect(classify({})).toEqual({
      action: "gate",
      task: { kind: "gate", repo: REPO, hive: "hive", branch: "main", before: "b".repeat(40), after: "a".repeat(40) },
    });
  });

  it("derives the hive from a dashed namespace", () => {
    expect(classify({ repoName: "my-hive-train-0123456789ab" })).toMatchObject({ task: { hive: "my-hive" } });
  });

  it("gates a provisioner fork-retry name (-r2, -r10) with the right hive", () => {
    expect(classify({ repoName: "my-hive-train-0123456789ab-r2" })).toMatchObject({ action: "gate", task: { hive: "my-hive", repo: "my-hive-train-0123456789ab-r2" } });
    expect(classify({ repoName: "demo-train-0123456789ab-r10" })).toMatchObject({ action: "gate", task: { hive: "demo" } });
  });

  it.each([
    ["a bad-hex train name", { repoName: "demo-train-abc" }, "not-a-train-fork"],
    ["a non-numeric retry suffix", { repoName: "demo-train-0123456789ab-rx" }, "not-a-train-fork"],
    ["the lander's push to the hive repo", { repoName: "hive" }, "not-a-train-fork"],
    ["a notes ref", { ref: "refs/notes/queen" }, "notes-ref"],
    ["a branch deletion", { after: ZERO_SHA }, "deletion"],
    ["a tag", { ref: "refs/tags/v1" }, "not-a-branch"],
    ["another namespace", { namespace: "other" }, "foreign-namespace"],
    ["a malformed train repo name", { repoName: "hive-train-xyz" }, "not-a-train-fork"],
  ])("ignores %s", (_n, o, reason) => {
    expect(classify(o)).toEqual({ action: "ignore", reason });
  });

  it("instance ids are deterministic per (repo, after) and valid Workflow ids", () => {
    const t = { repo: REPO, after: "a".repeat(40) };
    expect(gateInstanceId(t)).toBe(gateInstanceId({ ...t }));
    expect(gateInstanceId(t)).not.toBe(gateInstanceId({ ...t, after: "b".repeat(40) }));
    expect(gateInstanceId(t)).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/);
  });
});

describe("handlePush (trigger instance)", () => {
  const cfg = config();

  it("dispatches once per (repo, after): duplicates collapse", async () => {
    const w = new FakeWorld();
    const steps = new InlineSteps();
    const a = await handlePush(pushedEnvelope(), steps, w.ports(), cfg);
    const b = await handlePush(pushedEnvelope(), steps, w.ports(), cfg);
    const c = await handlePush(pushedEnvelope({ after: "c".repeat(40) }), steps, w.ports(), cfg);
    expect([a.status, b.status, c.status]).toEqual(["dispatched", "duplicate", "dispatched"]);
    expect(w.dispatcher.started.map((s) => s.task.after)).toEqual(["a".repeat(40), "c".repeat(40)]);
    expect(w.dispatcher.started[0]!.id).toBe(gateInstanceId({ repo: REPO, after: "a".repeat(40) }));
  });

  it("ignores non-train repos, notes refs, deletions and invalid events without dispatching", async () => {
    const w = new FakeWorld();
    const steps = new InlineSteps();
    const results = await Promise.all([
      handlePush(pushedEnvelope({ repoName: "hive" }), steps, w.ports(), cfg),
      handlePush(pushedEnvelope({ ref: "refs/notes/queen" }), steps, w.ports(), cfg),
      handlePush(pushedEnvelope({ after: ZERO_SHA }), steps, w.ports(), cfg),
      handlePush({ garbage: true }, steps, w.ports(), cfg),
    ]);
    expect(results).toEqual([
      { status: "ignored", reason: "not-a-train-fork" },
      { status: "ignored", reason: "notes-ref" },
      { status: "ignored", reason: "deletion" },
      { status: "ignored", reason: "invalid-event" },
    ]);
    expect(w.dispatcher.started).toEqual([]);
    expect(steps.log).toEqual([]);
  });
});

const ATT_REPO = "my-hive-att-0123456789ab";
const AFTER = "a".repeat(40);

describe("push filter: attempt forks and race bases", () => {
  it("an attempt fork's main routes to the Queen (hive, att_ id, before, after, commits), with the -rN suffix", () => {
    expect(classify({ repoName: ATT_REPO })).toEqual({
      action: "attempt",
      task: { hive: "my-hive", attemptId: "att_0123456789ab", repo: ATT_REPO, before: "b".repeat(40), after: AFTER, commits: [{ id: AFTER, message: "queen(build): x", parents: [], extra: "ignored" }] },
    });
    expect(classify({ repoName: `${ATT_REPO}-r2` })).toMatchObject({ action: "attempt", task: { hive: "my-hive", attemptId: "att_0123456789ab", repo: `${ATT_REPO}-r2` } });
  });

  it.each([
    ["another branch of an attempt fork", { repoName: ATT_REPO, ref: "refs/heads/feature" }, "attempt-non-main"],
    ["a race base repo", { repoName: "demo-base-0123456789ab" }, "base-repo"],
    ["a race base re-fork", { repoName: "demo-base-0123456789ab-r3" }, "base-repo"],
    ["a race base, other branch", { repoName: "demo-base-0123456789ab", ref: "refs/heads/x" }, "base-repo"],
    ["a notes ref of an attempt fork", { repoName: ATT_REPO, ref: "refs/notes/verdict" }, "notes-ref"],
    ["an attempt fork's main deleted", { repoName: ATT_REPO, after: ZERO_SHA }, "deletion"],
  ])("ignores %s", (_n, o, reason) => {
    expect(classify(o)).toEqual({ action: "ignore", reason });
  });

  it("train forks still gate", () => {
    expect(classify({})).toMatchObject({ action: "gate" });
  });
});

describe("handlePush (attempt route)", () => {
  const cfg = config();

  it("reports the push to Queen attemptPushed with the event's head message; no gate is dispatched", async () => {
    const w = new FakeWorld();
    w.queen.serveAttempts();
    w.artifacts.heads.set(ATT_REPO, { sha: AFTER, message: "ignored when the event has it" });
    const out = await handlePush(pushedEnvelope({ repoName: ATT_REPO, message: "Add a tip jar\n\nAcceptance:\n- shows a jar" }), new InlineSteps(), w.ports(), cfg);
    expect(out).toEqual({ status: "attempt", attemptId: "att_0123456789ab", repo: ATT_REPO, after: AFTER, outcome: "applied" });
    expect(w.queen.attemptPushes()).toEqual([
      { hive: "my-hive", attemptId: "att_0123456789ab", repo: ATT_REPO, before: "b".repeat(40), after: AFTER, title: "Add a tip jar", message: "Add a tip jar\n\nAcceptance:\n- shows a jar" },
    ]);
    expect(w.dispatcher.started).toEqual([]);
  });

  it("a truncated or missing head commit uses the fork head's full message", async () => {
    const w = new FakeWorld();
    w.queen.serveAttempts();
    w.artifacts.heads.set(ATT_REPO, { sha: AFTER, message: "Full title\n\nfull body" });
    await handlePush(pushedEnvelope({ repoName: ATT_REPO, commits: [{ id: AFTER, message: "Full ti", messageTruncated: true }] }), new InlineSteps(), w.ports(), cfg);
    await handlePush(pushedEnvelope({ repoName: ATT_REPO, commits: [] }), new InlineSteps(), w.ports(), cfg);
    expect(w.queen.attemptPushes().map((p) => [p.title, p.message])).toEqual([
      ["Full title", "Full title\n\nfull body"],
      ["Full title", "Full title\n\nfull body"],
    ]);
  });

  it("an older push processed after a newer one is not reported (not the fork's head); a deleted fork is ignored", async () => {
    const w = new FakeWorld();
    w.queen.serveAttempts();
    w.artifacts.heads.set(ATT_REPO, { sha: "c".repeat(40), message: "newer" });
    expect(await handlePush(pushedEnvelope({ repoName: ATT_REPO }), new InlineSteps(), w.ports(), cfg)).toEqual({ status: "ignored", reason: "not-fork-head" });
    expect(await handlePush(pushedEnvelope({ repoName: "demo-att-ffffffffffff" }), new InlineSteps(), w.ports(), cfg)).toEqual({ status: "ignored", reason: "fork-gone" });
    expect(w.queen.attemptPushes()).toEqual([]);
  });

  it("a Queen without attemptPushed (older deploy) leaves it ignored", async () => {
    const w = new FakeWorld();
    w.artifacts.heads.set(ATT_REPO, { sha: AFTER, message: "x" });
    expect(await handlePush(pushedEnvelope({ repoName: ATT_REPO }), new InlineSteps(), w.ports(), cfg)).toEqual({ status: "ignored", reason: "queen-without-attempts" });
  });

  it("a zero `before` (first push to a new ref) is not forwarded", async () => {
    const w = new FakeWorld();
    w.queen.serveAttempts();
    w.artifacts.heads.set(ATT_REPO, { sha: AFTER, message: "x" });
    await handlePush(pushedEnvelope({ repoName: ATT_REPO, before: ZERO_SHA }), new InlineSteps(), w.ports(), cfg);
    expect(w.queen.attemptPushes()[0]).not.toHaveProperty("before");
  });
});

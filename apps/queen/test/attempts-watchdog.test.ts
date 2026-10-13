/** MCP attempts: the watchdog (expiry, stale INTENT, stale pending base) and base cleanup (resolution, cancel). Spec §7. */
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { QueenNode } from "../src/queen-node";
import { env } from "cloudflare:workers";
import { commandTimeoutMs } from "../src/queen-node";
import { BASE_SHA, OWNER, accepted, agent, deletesOf, distinctDeletes, externalHive, fileItem, gateFail, gatePass, landCarOf, later, look, readyAttempt, sha, stubFor, trainOf } from "./attempt-helpers";

const HOUR = 3_600_000;
const push = (ns: string, att: { attemptId: string; repo: string }, after = sha()) =>
  stubFor(ns).attemptPushed({ hive: ns, attemptId: att.attemptId, repo: att.repo, after, title: "Add a tip jar", message: "Add a tip jar" });
const row = async (ns: string, attemptId: string) => (await look(ns)).attempts.find((a) => a.attempt_id === attemptId)!;
const itemRow = async (ns: string, itemId: string) => (await look(ns)).items.find((i) => i.item_id === itemId)!;

describe("attempt watchdog", () => {
  it("a READY attempt past its expiry is EXPIRED and its fork deleted (a repo DELETE keyed by the attempt); a pushed one is not", async () => {
    const { ns } = await externalHive();
    const r1 = await readyAttempt(ns, await fileItem(ns, "One"));
    const r2 = await readyAttempt(ns, await fileItem(ns, "Two"));
    await push(ns, r2);
    await gatePass(ns, r2.trainId);
    await later(ns, 2 * HOUR + 60_000);
    const s = await look(ns);
    expect(s.attempts.find((a) => a.attempt_id === r1.attemptId)).toMatchObject({ state: "EXPIRED" });
    expect(deletesOf(s.provisions, r1.repo)).toEqual([expect.objectContaining({ trainId: r1.attemptId })]);
    expect(s.attempts.find((a) => a.attempt_id === r2.attemptId)!.state).not.toBe("EXPIRED");
    expect(deletesOf(s.provisions, r2.repo)).toEqual([]);
  });

  it("a REJECTED attempt past its expiry is EXPIRED, its fork deleted once through its train, then the item's base once", async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 } });
    const itemId = await fileItem(ns);
    const r = await readyAttempt(ns, itemId);
    const baseRepo = String((await itemRow(ns, itemId)).base_repo);
    await push(ns, r);
    await gateFail(ns, r.trainId);
    expect(await row(ns, r.attemptId)).toMatchObject({ state: "REJECTED" });
    await later(ns, 2 * HOUR + 60_000);
    let s = await look(ns);
    expect(s.attempts.find((a) => a.attempt_id === r.attemptId)).toMatchObject({ state: "EXPIRED" });
    expect(deletesOf(s.provisions, r.repo)).toEqual([expect.objectContaining({ trainId: r.trainId })]);
    expect(deletesOf(s.provisions, baseRepo)).toEqual([expect.objectContaining({ trainId: `base-${itemId}`, commandId: `base-${itemId}-delete-1` })]);
    expect(s.items.find((i) => i.item_id === itemId)).toMatchObject({ base_repo: null, base_sha: BASE_SHA });
    await later(ns, 60_000);
    s = await look(ns);
    // The alarm's train reconcile re-sends the train's in-flight DELETE under the same id (at-least-once): one distinct id.
    expect(distinctDeletes(s, r.repo)).toBe(1);
    expect(deletesOf(s.provisions, baseRepo)).toHaveLength(1);
    expect(await stub.reportProvisionResult({ commandId: `base-${itemId}-delete-1`, op: "DELETE", trainId: `base-${itemId}`, ok: true })).toMatchObject({ outcome: "applied", train: null });
  });

  it("a stale INTENT is ABORTED and a base pending for 5 minutes is cleared (both names deleted); the next intent creates a base again", async () => {
    const { ns, stub } = await externalHive();
    const itemId = await fileItem(ns);
    const d = accepted(await stub.attemptIntent({ hive: ns, owner: OWNER, agent: agent(), target: { itemId } }));
    expect(await runInDurableObject(stub, (_q: QueenNode, state) => state.storage.getAlarm())).not.toBeNull();
    await later(ns, 5 * 60_000 + 1_000);
    const s = await look(ns);
    expect(s.attempts[0]).toMatchObject({ attempt_id: d.attemptId, state: "ABORTED" });
    expect(s.items.find((i) => i.item_id === itemId)).toMatchObject({ base_repo: null, base_sha: null, base_pending_at: null });
    expect(deletesOf(s.provisions, d.repo)).toEqual([expect.objectContaining({ trainId: d.attemptId })]);
    expect(deletesOf(s.provisions, d.base.baseRepo)).toEqual([expect.objectContaining({ trainId: `base-${itemId}` })]);
    expect(accepted(await stub.attemptIntent({ hive: ns, owner: OWNER, agent: agent(), target: { itemId } })).base.kind).toBe("create");
  });
});

describe("base cleanup", () => {
  it("the base is deleted exactly once when the last open attempt ends and no race is open", async () => {
    // No rework slots: the rejection abandons the race at once (the fallback), and the fallback releases the base then
    // (rework loop R6, spec §5.6.3: a REJECTED attempt with no slot never forks from it again). end_attempt ending a
    // slot is Task 6's.
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 }, guardrails: { maxReworksPerAttempt: 0 } });
    const itemId = await fileItem(ns);
    const r = await readyAttempt(ns, itemId);
    const baseRepo = String((await itemRow(ns, itemId)).base_repo);
    await push(ns, r);
    expect(deletesOf((await look(ns)).provisions, baseRepo)).toEqual([]);
    await gateFail(ns, r.trainId);
    expect((await look(ns)).races[0]).toMatchObject({ state: "ABANDONED" });
    expect(deletesOf((await look(ns)).provisions, baseRepo)).toHaveLength(1);
    const own = { hive: ns, attemptId: r.attemptId, owner: OWNER, agentId: r.agent.agentId };
    await stub.attemptEnd(own);
    expect(deletesOf((await look(ns)).provisions, baseRepo)).toHaveLength(1);
    expect(await stub.attemptEnd(own)).toMatchObject({ ok: true, changed: false, attempt: { state: "ABANDONED" } });
    expect(deletesOf((await look(ns)).provisions, baseRepo)).toHaveLength(1);
  });

  it("the base stays while another attempt of the item is open", async () => {
    const { ns, stub } = await externalHive();
    const itemId = await fileItem(ns);
    const a = await readyAttempt(ns, itemId, agent());
    await readyAttempt(ns, itemId, agent({ name: "haiku" }));
    const baseRepo = String((await itemRow(ns, itemId)).base_repo);
    await stub.attemptEnd({ hive: ns, attemptId: a.attemptId, owner: OWNER, agentId: a.agent.agentId });
    expect(deletesOf((await look(ns)).provisions, baseRepo)).toEqual([]);
    expect(await itemRow(ns, itemId)).toMatchObject({ base_repo: baseRepo });
  });

  it("cancelling an item abandons its open attempts, deletes their forks and its base", async () => {
    const { ns, stub } = await externalHive();
    const itemId = await fileItem(ns);
    const r = await readyAttempt(ns, itemId);
    const baseRepo = String((await itemRow(ns, itemId)).base_repo);
    await stub.workAction({ hive: ns, itemId, user: OWNER, action: { action: "cancel" } });
    const s = await look(ns);
    expect(s.attempts[0]).toMatchObject({ attempt_id: r.attemptId, state: "ABANDONED" });
    expect(deletesOf(s.provisions, r.repo)).toHaveLength(1);
    expect(deletesOf(s.provisions, baseRepo)).toHaveLength(1);
    expect(s.items.find((i) => i.item_id === itemId)).toMatchObject({ status: "CANCELLED", base_repo: null });
  });

  it("a late push moves the attempt to a follow-up item without a base; the original item keeps its base while its race decides", async () => {
    const { ns, stub } = await externalHive();
    const itemId = await fileItem(ns);
    const a = await readyAttempt(ns, itemId, agent());
    const b = await readyAttempt(ns, itemId, agent({ name: "haiku" }));
    const baseRepo = String((await itemRow(ns, itemId)).base_repo);
    await push(ns, a);
    await push(ns, b);
    await gatePass(ns, a.trainId);
    await stub.closeRaceEntries({ hive: ns, raceId: String((await look(ns)).races[0]!.race_id), user: OWNER });
    const late = await push(ns, a);
    expect(late.disposition).toBe("late-new-item");
    expect(await itemRow(ns, late.itemId!)).toMatchObject({ base_repo: null, base_sha: null });
    expect(await itemRow(ns, itemId)).toMatchObject({ base_repo: baseRepo });
    expect(deletesOf((await look(ns)).provisions, baseRepo)).toEqual([]);
  });
});

describe("fork delete when a single attempt lands (Task 3 follow-up)", () => {
  it("a single attempt wins and lands on its own → LANDED → exactly one distinct DELETE command id for its fork", async () => {
    const { ns } = await externalHive({ race: { entryWindowMs: 0 } });
    const r = await readyAttempt(ns, await fileItem(ns));
    await push(ns, r);
    await gatePass(ns, r.trainId);
    expect(await trainOf(ns, r.trainId)).toMatchObject({ race_outcome: "WON" });
    await landCarOf(ns, r.trainId);
    await later(ns, 60_000);
    const s = await look(ns);
    expect(s.attempts.find((a) => a.attempt_id === r.attemptId)).toMatchObject({ state: "LANDED" });
    expect(distinctDeletes(s, r.repo)).toBe(1);
    expect(deletesOf(s.provisions, r.repo)[0]).toMatchObject({ trainId: r.trainId });
  });
});

describe("repo DELETE redrive (deletes no train holds: attempt forks before a push, race bases)", () => {
  const TIMEOUT = commandTimeoutMs(env as never);
  const ended = async () => {
    const { ns, stub } = await externalHive();
    const itemId = await fileItem(ns);
    const r = await readyAttempt(ns, itemId);
    const baseRepo = String((await (await look(ns)).items.find((i) => i.item_id === itemId))!.base_repo);
    await stub.attemptEnd({ hive: ns, attemptId: r.attemptId, owner: OWNER, agentId: r.agent.agentId });
    const s = await look(ns);
    expect(deletesOf(s.provisions, r.repo)).toEqual([expect.objectContaining({ trainId: r.attemptId, commandId: `${r.attemptId}-delete-1` })]);
    expect(deletesOf(s.provisions, baseRepo)).toEqual([expect.objectContaining({ trainId: `base-${itemId}`, commandId: `base-${itemId}-delete-1` })]);
    return { ns, stub, itemId, r, baseRepo };
  };

  it("a lost dispatch is re-sent under the same command id; a reported delete is never re-sent", async () => {
    const { ns, stub, itemId, r, baseRepo } = await ended();
    await later(ns, TIMEOUT + 1_000);
    let s = await look(ns);
    expect(deletesOf(s.provisions, r.repo).map((c) => c.commandId)).toEqual([`${r.attemptId}-delete-1`, `${r.attemptId}-delete-1`]);
    expect(deletesOf(s.provisions, baseRepo).map((c) => c.commandId)).toEqual([`base-${itemId}-delete-1`, `base-${itemId}-delete-1`]);
    await stub.reportProvisionResult({ commandId: `${r.attemptId}-delete-1`, op: "DELETE", trainId: r.attemptId, ok: true });
    await stub.reportProvisionResult({ commandId: `base-${itemId}-delete-1`, op: "DELETE", trainId: `base-${itemId}`, ok: true });
    await later(ns, TIMEOUT + 1_000);
    await later(ns, TIMEOUT + 1_000);
    s = await look(ns);
    expect(deletesOf(s.provisions, r.repo)).toHaveLength(2);
    expect(deletesOf(s.provisions, baseRepo)).toHaveLength(2);
  });

  it("an ok:false report is retried under the next command id; once deleted, nothing more", async () => {
    const { ns, stub, r } = await ended();
    await stub.reportProvisionResult({ commandId: `${r.attemptId}-delete-1`, op: "DELETE", trainId: r.attemptId, ok: false, summary: "artifacts 503" });
    await later(ns, TIMEOUT + 1_000);
    let s = await look(ns);
    expect(deletesOf(s.provisions, r.repo).map((c) => c.commandId)).toEqual([`${r.attemptId}-delete-1`, `${r.attemptId}-delete-2`]);
    await stub.reportProvisionResult({ commandId: `${r.attemptId}-delete-2`, op: "DELETE", trainId: r.attemptId, ok: true });
    await later(ns, TIMEOUT + 1_000);
    s = await look(ns);
    expect(deletesOf(s.provisions, r.repo)).toHaveLength(2);
  });

  it("gives up after three sends with a warning; nothing is sent after that", async () => {
    const { ns, r } = await ended();
    for (let i = 0; i < 5; i++) await later(ns, TIMEOUT + 1_000);
    const s = await look(ns);
    expect(deletesOf(s.provisions, r.repo)).toHaveLength(3);
    expect(s.events.some((e) => e.type === "attempt.state" && JSON.parse(e.data).outcome === "delete-gave-up")).toBe(true);
  });

  it("a second base of the same item is deleted under its own command id", async () => {
    const { ns, stub } = await externalHive();
    const itemId = await fileItem(ns);
    const d = accepted(await stub.attemptIntent({ hive: ns, owner: OWNER, agent: agent(), target: { itemId } }));
    await later(ns, 5 * 60_000 + 1_000); // the pending base is cleared: base-<itemId>-delete-1
    const r = await readyAttempt(ns, itemId);
    const baseRepo = String((await itemRow(ns, itemId)).base_repo);
    expect(baseRepo).not.toBe(d.base.baseRepo);
    await stub.attemptEnd({ hive: ns, attemptId: r.attemptId, owner: OWNER, agentId: r.agent.agentId });
    const s = await look(ns);
    expect(deletesOf(s.provisions, d.base.baseRepo).map((c) => c.commandId)).toEqual([`base-${itemId}-delete-1`]);
    expect(deletesOf(s.provisions, baseRepo).map((c) => c.commandId)).toEqual([`base-${itemId}-delete-2`]);
  });
});

describe("base cleanup when the race resolves after the last attempt ended (fix round 1)", () => {
  const WINDOW = 15 * 60_000;
  const pushEnd = async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: WINDOW } });
    const itemId = await fileItem(ns);
    const r = await readyAttempt(ns, itemId);
    const baseRepo = String((await itemRow(ns, itemId)).base_repo);
    await push(ns, r);
    await stub.attemptEnd({ hive: ns, attemptId: r.attemptId, owner: OWNER, agentId: r.agent.agentId });
    const s = await look(ns);
    expect(s.races[0]).toMatchObject({ state: "RACING" });
    expect(deletesOf(s.provisions, baseRepo)).toEqual([]); // the race is still open: the base stays
    expect(await itemRow(ns, itemId)).toMatchObject({ base_repo: baseRepo });
    return { ns, stub, itemId, baseRepo };
  };

  it("the entry window closes on the alarm: the race resolves and the base is deleted once", async () => {
    const { ns, itemId, baseRepo } = await pushEnd();
    await later(ns, WINDOW + 60_000);
    let s = await look(ns);
    expect(s.races[0]!.state === "DECIDED" || s.races[0]!.state === "ABANDONED").toBe(true);
    expect(deletesOf(s.provisions, baseRepo)).toEqual([expect.objectContaining({ trainId: `base-${itemId}`, commandId: `base-${itemId}-delete-1` })]);
    expect(await itemRow(ns, itemId)).toMatchObject({ base_repo: null, base_sha: BASE_SHA });
    await later(ns, 60_000);
    s = await look(ns);
    expect(deletesOf(s.provisions, baseRepo)).toHaveLength(1);
  });

  it("a human closes entries early: the race resolves and the base is deleted once", async () => {
    const { ns, stub, baseRepo } = await pushEnd();
    await stub.closeRaceEntries({ hive: ns, raceId: String((await look(ns)).races[0]!.race_id), user: OWNER });
    const s = await look(ns);
    expect(s.races[0]!.state === "DECIDED" || s.races[0]!.state === "ABANDONED").toBe(true);
    expect(deletesOf(s.provisions, baseRepo)).toHaveLength(1);
  });

  it("a resolving race never deletes the base while another attempt of the item is open", async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: WINDOW } });
    const itemId = await fileItem(ns);
    const a = await readyAttempt(ns, itemId, agent());
    const b = await readyAttempt(ns, itemId, agent({ name: "haiku" })); // READY, never pushes: still open
    const c = await readyAttempt(ns, itemId, agent({ name: "glm" }));
    const baseRepo = String((await itemRow(ns, itemId)).base_repo);
    await push(ns, a);
    await push(ns, c);
    await stub.attemptEnd({ hive: ns, attemptId: a.attemptId, owner: OWNER, agentId: a.agent.agentId });
    await gatePass(ns, c.trainId);
    await later(ns, WINDOW + 60_000);
    const s = await look(ns);
    expect(s.races[0]!.state).toBe("DECIDED");
    expect(deletesOf(s.provisions, baseRepo)).toEqual([]);
    expect(await itemRow(ns, itemId)).toMatchObject({ base_repo: baseRepo });
    expect((await stubFor(ns).getAttempt(b.attemptId))!.state).toBe("READY");
  });

  it("rework loop F3 (spec §5.6.3): a race ABANDONED (the fallback) releases the base although a READY attempt is open", async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: WINDOW } });
    const itemId = await fileItem(ns);
    const a = await readyAttempt(ns, itemId, agent());
    const b = await readyAttempt(ns, itemId, agent({ name: "haiku" })); // READY, never pushes: forked from the old base
    const baseRepo = String((await itemRow(ns, itemId)).base_repo);
    await push(ns, a);
    await stub.attemptEnd({ hive: ns, attemptId: a.attemptId, owner: OWNER, agentId: a.agent.agentId });
    await later(ns, WINDOW + 60_000);
    const s = await look(ns);
    expect(s.races[0]!.state).toBe("ABANDONED");
    expect(deletesOf(s.provisions, baseRepo)).toHaveLength(1);
    expect(await itemRow(ns, itemId)).toMatchObject({ base_repo: null });
    expect((await stubFor(ns).getAttempt(b.attemptId))!.state).toBe("READY");
  });
});

describe("cancel with a pending base (fix round 1)", () => {
  it("cancelling an item abandons its INTENT even while the base is still being created", async () => {
    const { ns, stub } = await externalHive();
    const itemId = await fileItem(ns);
    const d = accepted(await stub.attemptIntent({ hive: ns, owner: OWNER, agent: agent(), target: { itemId } }));
    await stub.workAction({ hive: ns, itemId, user: OWNER, action: { action: "cancel" } });
    const s = await look(ns);
    expect(s.attempts[0]).toMatchObject({ attempt_id: d.attemptId, state: "ABANDONED" });
    expect(deletesOf(s.provisions, d.base.baseRepo)).toEqual([]); // pending: nothing to delete yet
    // queenos-mcp finishes the base fork after the cancel: the pinned base has no user and is deleted once.
    await stub.attemptBaseReady({ hive: ns, itemId, baseRepo: d.base.baseRepo, baseSha: BASE_SHA });
    expect(deletesOf((await look(ns)).provisions, d.base.baseRepo)).toEqual([expect.objectContaining({ trainId: `base-${itemId}` })]);
    expect(await itemRow(ns, itemId)).toMatchObject({ base_repo: null });
  });

  it("a base pinned after its only INTENT ended is deleted once (no attempt needs it)", async () => {
    const { ns, stub } = await externalHive();
    const itemId = await fileItem(ns);
    const a = agent();
    const d = accepted(await stub.attemptIntent({ hive: ns, owner: OWNER, agent: a, target: { itemId } }));
    await stub.attemptEnd({ hive: ns, attemptId: d.attemptId, owner: OWNER, agentId: a.agentId });
    await stub.attemptBaseReady({ hive: ns, itemId, baseRepo: d.base.baseRepo, baseSha: BASE_SHA });
    expect(deletesOf((await look(ns)).provisions, d.base.baseRepo)).toHaveLength(1);
    expect(accepted(await stub.attemptIntent({ hive: ns, owner: OWNER, agent: agent(), target: { itemId } })).base.kind).toBe("create");
  });
});

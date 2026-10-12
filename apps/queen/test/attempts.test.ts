/**
 * MCP attempts, ledger half (spec §7, §8): intent (caps, entry acceptance, the item's race base and its
 * base-pending lock), base ready / failed, ready, aborted, views; `entryWindowMs` on goals.
 */
import { describe, expect, it } from "vitest";
import { BASE_SHA, MODEL, OTHER, OWNER, accepted, agent, externalHive, fileItem, gateFail, gitPush, look, newHive, readyAttempt, rpcError, stubFor } from "./attempt-helpers";

const intent = (ns: string, a: ReturnType<typeof agent>, target: { itemId: string } | { goalId: string }) =>
  stubFor(ns).attemptIntent({ hive: ns, owner: a.owner, agent: a, target });

describe("attemptIntent", () => {
  it("a swarm hive refuses with HIVE_NOT_EXTERNAL", async () => {
    const ns = newHive();
    const stub = stubFor(ns);
    await stub.updateSettings({ hive: ns, user: OWNER, patch: { autonomy: "paused" } });
    const itemId = await fileItem(ns);
    expect(await intent(ns, agent(), { itemId })).toMatchObject({ verdict: "refuse", code: "HIVE_NOT_EXTERNAL" });
  });

  it("concurrent first intents create one base: one caller gets create, the other BASE_PENDING; baseReady pins it for every later attempt", async () => {
    const { ns, stub } = await externalHive();
    const itemId = await fileItem(ns);
    const [a, b] = [agent(), agent({ name: "haiku" })];
    const both = await Promise.all([intent(ns, a, { itemId }), intent(ns, b, { itemId })]);
    const creator = accepted(both.find((d) => d.verdict === "accept")!);
    expect(both.find((d) => d.verdict === "refuse")).toMatchObject({ verdict: "refuse", code: "BASE_PENDING" });
    expect(creator).toMatchObject({ itemId, raceId: null, base: { kind: "create" } });
    expect(creator.attemptId).toMatch(/^att_[0-9a-f]{12}$/);
    expect(creator.repo).toBe(`${ns}-att-${creator.attemptId.slice(4)}`);
    const baseRepo = creator.base.baseRepo;
    expect(baseRepo).toMatch(new RegExp(`^${ns}-base-[0-9a-f]{12}$`));
    let s = await look(ns);
    expect(s.items.find((i) => i.item_id === itemId)).toMatchObject({ base_repo: baseRepo, base_sha: null });
    expect(s.attempts).toHaveLength(1);
    expect(s.attempts[0]).toMatchObject({ attempt_id: creator.attemptId, state: "INTENT", base_sha: null, owner: OWNER, model: MODEL, agent_name: "opus" });
    expect(s.trains).toEqual([]); // nothing is held for a push that may never come
    expect(s.events.some((e) => e.type === "attempt.intent")).toBe(true);

    expect(await stub.attemptBaseReady({ hive: ns, itemId, baseRepo: `${baseRepo}-r2`, baseSha: BASE_SHA })).toEqual({ outcome: "applied" });
    s = await look(ns);
    expect(s.items.find((i) => i.item_id === itemId)).toMatchObject({ base_repo: `${baseRepo}-r2`, base_sha: BASE_SHA, base_pending_at: null });
    expect(s.attempts[0]).toMatchObject({ base_sha: BASE_SHA });
    const later = accepted(await intent(ns, b, { itemId }));
    expect(later.base).toEqual({ kind: "existing", baseRepo: `${baseRepo}-r2`, baseSha: BASE_SHA });
    expect(await stub.attemptBaseReady({ hive: ns, itemId, baseRepo: `${baseRepo}-r2`, baseSha: BASE_SHA })).toEqual({ outcome: "ignored:duplicate" });
    expect(await rpcError(stub.attemptBaseReady({ hive: ns, itemId, baseRepo: `${ns}-base-ffffffffffff`, baseSha: BASE_SHA }))).toMatch(/^CONFLICT: /);
  });

  it("baseFailed frees the slot and aborts the caller's INTENT; the next intent creates a new base name", async () => {
    const { ns, stub } = await externalHive();
    const itemId = await fileItem(ns);
    const first = accepted(await intent(ns, agent(), { itemId }));
    if (first.base.kind !== "create") throw new Error("expected create");
    expect(await stub.attemptBaseFailed({ hive: ns, itemId, baseRepo: first.base.baseRepo, reason: "fork 503", attemptId: first.attemptId })).toEqual({ outcome: "applied" });
    let s = await look(ns);
    expect(s.items.find((i) => i.item_id === itemId)).toMatchObject({ base_repo: null, base_sha: null, base_pending_at: null });
    expect(s.attempts.find((a) => a.attempt_id === first.attemptId)).toMatchObject({ state: "ABORTED" });
    const second = accepted(await intent(ns, agent(), { itemId }));
    expect(second.base.kind).toBe("create");
    expect(second.base.baseRepo).not.toBe(first.base.baseRepo);
    s = await look(ns);
    expect(s.events.filter((e) => e.type === "attempt.base").map((e) => JSON.parse(e.data).outcome)).toEqual(["failed"]);
  });

  it("baseFailed never aborts an INTENT of another item (a wrong attemptId)", async () => {
    const { ns, stub } = await externalHive();
    const itemA = await fileItem(ns, "Tip jar A");
    const itemB = await fileItem(ns, "Tip jar B");
    const a = accepted(await intent(ns, agent(), { itemId: itemA }));
    const b = accepted(await intent(ns, agent(), { itemId: itemB }));
    if (a.base.kind !== "create") throw new Error("expected create");
    // A's base is pending: the slot is freed, but B's INTENT is untouched.
    expect(await stub.attemptBaseFailed({ hive: ns, itemId: itemA, baseRepo: a.base.baseRepo, reason: "fork 503", attemptId: b.attemptId })).toEqual({ outcome: "applied" });
    let s = await look(ns);
    expect(s.items.find((i) => i.item_id === itemA)).toMatchObject({ base_repo: null, base_pending_at: null });
    expect(s.attempts.find((x) => x.attempt_id === b.attemptId)).toMatchObject({ state: "INTENT" });
    expect(s.attempts.find((x) => x.attempt_id === a.attemptId)).toMatchObject({ state: "INTENT" });
    // A's base is no longer pending: a report naming B's attempt on item A is stale.
    expect(await stub.attemptBaseFailed({ hive: ns, itemId: itemA, baseRepo: a.base.baseRepo, reason: "fork 503", attemptId: b.attemptId })).toEqual({ outcome: "ignored:stale" });
    s = await look(ns);
    expect(s.attempts.find((x) => x.attempt_id === b.attemptId)).toMatchObject({ state: "INTENT" });
  });

  it("ready: INTENT → READY with the actual -rN repo; a foreign repo is INVALID_INPUT; a head other than the base is BASE_MOVED; a repeat is a no-op", async () => {
    const { ns, stub } = await externalHive();
    const itemId = await fileItem(ns);
    const d = accepted(await intent(ns, agent(), { itemId }));
    await stub.attemptBaseReady({ hive: ns, itemId, baseRepo: d.base.baseRepo, baseSha: BASE_SHA });
    const exp = Date.now() + 7_200_000;
    expect(await rpcError(stub.attemptReady({ hive: ns, attemptId: d.attemptId, repo: `${ns}-att-ffffffffffff`, baseSha: BASE_SHA, expiresAt: exp }))).toMatch(/^INVALID_INPUT: /);
    expect(await stub.attemptReady({ hive: ns, attemptId: d.attemptId, repo: `${d.repo}-r2`, baseSha: "e".repeat(40), expiresAt: exp })).toMatchObject({ ok: false, code: "BASE_MOVED" });
    const r = await stub.attemptReady({ hive: ns, attemptId: d.attemptId, repo: `${d.repo}-r2`, baseSha: BASE_SHA, expiresAt: exp });
    expect(r).toMatchObject({ ok: true, changed: true, attempt: { state: "READY", repo: `${d.repo}-r2`, baseSha: BASE_SHA, expiresAt: exp, train: null, race: null, verdict: "none" } });
    expect(await stub.attemptReady({ hive: ns, attemptId: d.attemptId, repo: `${d.repo}-r2`, baseSha: BASE_SHA, expiresAt: exp })).toMatchObject({ ok: true, changed: false });
    expect(await stub.attemptReady({ hive: ns, attemptId: "att_ffffffffffff", repo: "x", baseSha: BASE_SHA, expiresAt: exp })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("aborted: INTENT → ABORTED; a READY attempt is never aborted", async () => {
    const { ns, stub } = await externalHive();
    const i1 = await fileItem(ns, "One");
    const d = accepted(await intent(ns, agent(), { itemId: i1 }));
    expect(await stub.attemptAborted({ hive: ns, attemptId: d.attemptId, reason: "fork 503" })).toEqual({ outcome: "applied" });
    expect((await look(ns)).attempts[0]).toMatchObject({ state: "ABORTED" });
    const i2 = await fileItem(ns, "Two");
    const r = await readyAttempt(ns, i2);
    expect(await stub.attemptAborted({ hive: ns, attemptId: r.attemptId, reason: "late" })).toEqual({ outcome: "ignored:stale" });
  });

  it("an agent of another owner is FORBIDDEN_OWNER; an unknown item NOT_FOUND", async () => {
    const { ns, stub } = await externalHive();
    const itemId = await fileItem(ns);
    expect(await stub.attemptIntent({ hive: ns, owner: OWNER, agent: agent({ owner: OTHER }), target: { itemId } })).toMatchObject({ verdict: "refuse", code: "FORBIDDEN_OWNER" });
    expect(await intent(ns, agent(), { itemId: "nope" })).toMatchObject({ verdict: "refuse", code: "NOT_FOUND" });
  });

  it("a goal resolves to its single open child; two open children are GOAL_AMBIGUOUS with the list", async () => {
    const { ns, stub } = await externalHive();
    const { item: goal } = await stub.submitWork({ namespace: ns, promptText: "Dark mode\n\nadd a toggle", decompose: true, user: OWNER });
    const one = accepted(await intent(ns, agent(), { goalId: goal.itemId }));
    expect(one.itemId).toBe(`${goal.itemId}-c1`);
    await fileItem(ns, "Second child", goal.itemId);
    const amb = await intent(ns, agent(), { goalId: goal.itemId });
    expect(amb).toMatchObject({ verdict: "refuse", code: "GOAL_AMBIGUOUS" });
    if (amb.verdict !== "refuse") throw new Error("unreachable");
    expect(amb.items?.map((i) => i.title).sort()).toEqual(["Dark mode", "Second child"]);
    expect(await intent(ns, agent(), { goalId: "nope" })).toMatchObject({ verdict: "refuse", code: "NOT_FOUND" });
  });

  it("a CANCELLED item is ITEM_NOT_ACCEPTING; a FAILED item (awaiting contributor) accepts a new attempt", async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 } });
    const cancelled = await fileItem(ns, "Cancelled");
    await stub.workAction({ hive: ns, itemId: cancelled, user: OWNER, action: { action: "cancel" } });
    expect(await intent(ns, agent(), { itemId: cancelled })).toMatchObject({ verdict: "refuse", code: "ITEM_NOT_ACCEPTING" });

    const failed = await fileItem(ns, "Failed");
    const p = await gitPush(ns, `refs/heads/item/${failed}`, "by ada");
    await gateFail(ns, p.decision.trainId);
    expect((await look(ns)).items.find((i) => i.item_id === failed)).toMatchObject({ status: "FAILED" });
    expect(await intent(ns, agent(), { itemId: failed })).toMatchObject({ verdict: "accept", itemId: failed });
  });

  it("caps: 3 open attempts per agent, maxInboxOpenPerContributor (distinct items), maxInboxPushesPerHour", async () => {
    const perAgent = await externalHive({ guardrails: { maxInboxOpenPerContributor: 10 } });
    const a = agent();
    for (const t of ["A", "B", "C"]) accepted(await intent(perAgent.ns, a, { itemId: await fileItem(perAgent.ns, t) }));
    const fourth = await intent(perAgent.ns, a, { itemId: await fileItem(perAgent.ns, "D") });
    expect(fourth).toMatchObject({ verdict: "refuse", code: "CAP_EXCEEDED" });
    if (fourth.verdict === "refuse") expect(fourth.message).toContain("3");

    const perOwner = await externalHive({ guardrails: { maxInboxOpenPerContributor: 1 } });
    const i1 = await fileItem(perOwner.ns, "One");
    accepted(await intent(perOwner.ns, agent(), { itemId: i1 }));
    const other = await intent(perOwner.ns, agent(), { itemId: await fileItem(perOwner.ns, "Two") });
    expect(other).toMatchObject({ verdict: "refuse", code: "CAP_EXCEEDED" });
    if (other.verdict === "refuse") expect(other.message).toContain("maxInboxOpenPerContributor");
    // The same item is not a new open item: the cap passes (the base is still pending).
    expect(await intent(perOwner.ns, agent(), { itemId: i1 })).toMatchObject({ verdict: "refuse", code: "BASE_PENDING" });

    const hourly = await externalHive({ guardrails: { maxInboxPushesPerHour: 1 } });
    accepted(await intent(hourly.ns, agent(), { itemId: await fileItem(hourly.ns, "One") }));
    const again = await intent(hourly.ns, agent(), { itemId: await fileItem(hourly.ns, "Two") });
    expect(again).toMatchObject({ verdict: "refuse", code: "CAP_EXCEEDED" });
    if (again.verdict === "refuse") expect(again.message).toContain("maxInboxPushesPerHour");
  });
});

describe("views", () => {
  it("getAttempt and attemptsForItem", async () => {
    const { ns, stub } = await externalHive();
    const itemId = await fileItem(ns);
    const r = await readyAttempt(ns, itemId);
    const view = await stub.getAttempt(r.attemptId);
    expect(view).toMatchObject({ attemptId: r.attemptId, itemId, state: "READY", baseSha: BASE_SHA, train: null, race: null, verdict: "none", agentName: "opus", model: MODEL });
    expect(await stub.attemptsForItem(itemId)).toEqual({ itemId, baseSha: BASE_SHA, basePending: false, attempts: [view] });
    expect(await stub.getAttempt("att_ffffffffffff")).toBeNull();
  });
});

describe("entryWindowMs on a goal", () => {
  it("is stored on the goal and its child, and the race the child's first push opens closes after it", async () => {
    const { ns, stub } = await externalHive(); // hive default window: 15 min
    const { item: goal } = await stub.submitWork({ namespace: ns, promptText: "Haiku endpoint\n\nwrite one", decompose: true, entryWindowMs: 120_000, user: OWNER });
    const child = `${goal.itemId}-c1`;
    const s = await look(ns);
    expect(s.items.find((i) => i.item_id === goal.itemId)).toMatchObject({ entry_window_ms: 120_000 });
    expect(s.items.find((i) => i.item_id === child)).toMatchObject({ entry_window_ms: 120_000 });
    const before = Date.now();
    await gitPush(ns, `refs/heads/item/${child}`, "by ada");
    const race = (await look(ns)).races.find((r) => r.item_id === child)!;
    expect(Number(race.entry_closes_at)).toBeGreaterThanOrEqual(before + 120_000);
    expect(Number(race.entry_closes_at)).toBeLessThanOrEqual(Date.now() + 120_000);
  });
});

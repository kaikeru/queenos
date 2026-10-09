/**
 * Git intake decisions (human-push design rev 2 §2, §4.3, §4.4, §6.2; T1): the pure work/inbox.ts module.
 * The DO wiring (gitIntent / gitPushed / gitAborted / notesFor) is covered in v2-flow.test.ts.
 */
import { describe, expect, it } from "vitest";
import { GUARDRAIL_DEFAULTS } from "@queenos/queen-types";
import type { SubmissionRecord } from "../src/db";
import {
  decideIntake,
  decideIntent,
  entryWindowLine,
  handleFor,
  itemFromMessage,
  lateReason,
  NOTES_HINT,
  originOf,
  pushedMessages,
  raceClosedToEntries,
  remoteLines,
  resolveTarget,
  slugify,
  trailersOf,
  type IntakeInput,
  type IntakeItem,
  type IntakeLookup,
  type IntentContext,
  type PriorSubmission,
} from "../src/work/inbox";

const SHA = "a".repeat(40);
const USER = "ada@example.com";

function item(itemId: string, extra: Partial<IntakeItem> = {}): IntakeItem {
  return { itemId, kind: "feature", status: "READY", title: `Item ${itemId}`, parentId: null, racing: null, decided: false, activeNonRace: false, ...extra };
}

function lookup(items: IntakeItem[]): IntakeLookup {
  const byId = new Map(items.map((i) => [i.itemId, i]));
  return {
    item: (id) => byId.get(id) ?? null,
    goal: (slug) => {
      const goal = items.find((i) => i.kind === "goal" && (i.itemId === slug || slugify(i.title) === slug));
      return goal ? { goal, children: items.filter((i) => i.parentId === goal.itemId && i.kind !== "goal") } : null;
    },
  };
}

function sub(extra: Partial<SubmissionRecord> = {}): SubmissionRecord {
  return {
    repo: "hive-train-old",
    headSha: "b".repeat(40),
    ref: "refs/heads/tip-jar",
    originKind: "human",
    originId: USER,
    itemId: "I1",
    trainId: "old",
    outcome: "applied",
    disposition: "filed",
    target: null,
    agent: null,
    createdAt: 0,
    ...extra,
  };
}

function prior(extra: Partial<SubmissionRecord> = {}, train: Partial<Omit<PriorSubmission, "submission">> = {}): PriorSubmission {
  return { submission: sub(extra), trainActive: true, trainBoarded: false, ...train };
}

function intentCtx(extra: Partial<IntentContext> = {}): IntentContext {
  return {
    now: 1000,
    guardrails: { ...GUARDRAIL_DEFAULTS },
    paused: false,
    budgetExhausted: false,
    sameHead: [],
    previousOnRef: null,
    lookup: lookup([]),
    openItems: 0,
    pushesLastHour: 0,
    hiveOpenItems: 0,
    ...extra,
  };
}

const intent = (ref: string, agent: string | null = null) => ({ ref, newSha: SHA, user: USER, agent });

function pushed(ref: string, extra: Partial<IntakeInput> = {}): IntakeInput {
  const message = extra.message ?? "Add a tip jar\n\nA jar.\n\nAcceptance:\n- shows a jar\n- takes tips\n\nQueen-Origin: agent:claude";
  return { ref, headSha: SHA, title: "Add a tip jar", message, trailers: trailersOf(message), newItemId: "NEW", ...extra };
}

describe("decideIntent (pre-receive state rules, §4.3)", () => {
  it("refuses main, a duplicate head and an unknown item or goal before anything is forked", () => {
    expect(decideIntent(intent("refs/heads/main"), intentCtx())).toMatchObject({ verdict: "refuse", outcome: "refused:rule", reason: "pushes to main are refused (the lander owns main)" });
    const dup = decideIntent(intent("refs/heads/x"), intentCtx({ sameHead: [sub({ headSha: SHA, itemId: "I7", trainId: "T7" })] }));
    expect(dup).toMatchObject({ verdict: "refuse", outcome: "refused:duplicate", reason: "already submitted as item I7 (train T7)" });
    expect(dup.messages[0]).toBe("push refused: already submitted as item I7 (train T7)");
    expect(decideIntent(intent("refs/heads/item/nope"), intentCtx())).toMatchObject({ outcome: "refused:unknown-item", reason: "no item nope in this hive" });
    expect(decideIntent(intent("refs/heads/goal/dark-mode"), intentCtx())).toMatchObject({ outcome: "refused:unknown-item", reason: "no goal dark-mode in this hive" });
  });

  it("a pending intent of the same head: a retry of the same branch replaces it; anyone else's is a duplicate", () => {
    const pending = sub({ headSha: SHA, outcome: "pending", trainId: "stale", ref: "refs/heads/x" });
    expect(decideIntent(intent("refs/heads/x"), intentCtx({ sameHead: [pending] }))).toMatchObject({ verdict: "accept", supersedeIntents: ["stale"] });
    expect(decideIntent(intent("refs/heads/y"), intentCtx({ sameHead: [pending] }))).toMatchObject({ verdict: "refuse", outcome: "refused:duplicate" });
    // The same owner's other agent pushing the same head to the same branch is not a retry: a duplicate.
    expect(decideIntent(intent("refs/heads/x", "b"), intentCtx({ sameHead: [{ ...pending, agent: "a" }] }))).toMatchObject({ verdict: "refuse", outcome: "refused:duplicate" });
    expect(decideIntent(intent("refs/heads/x", "b"), intentCtx({ sameHead: [pending] }))).toMatchObject({ verdict: "refuse", outcome: "refused:duplicate" });
    expect(decideIntent(intent("refs/heads/x"), intentCtx({ sameHead: [{ ...pending, agent: "a" }] }))).toMatchObject({ verdict: "refuse", outcome: "refused:duplicate" });
    expect(decideIntent(intent("refs/heads/x", "a"), intentCtx({ sameHead: [{ ...pending, agent: "a" }] }))).toMatchObject({ verdict: "accept", supersedeIntents: ["stale"] });
    // A pending intent of another head on the same branch is replaced too.
    const other = prior({ outcome: "pending", trainId: "older", ref: "refs/heads/x" });
    expect(decideIntent(intent("refs/heads/x"), intentCtx({ previousOnRef: other }))).toMatchObject({ verdict: "accept", supersedeIntents: ["older"] });
  });

  it("caps: pushes per hour always; open items only when the push would file a new item", () => {
    const g = GUARDRAIL_DEFAULTS;
    expect(decideIntent(intent("refs/heads/x"), intentCtx({ pushesLastHour: g.maxInboxPushesPerHour }))).toMatchObject({ outcome: "refused:over-cap" });
    expect(decideIntent(intent("refs/heads/x"), intentCtx({ openItems: 3 }))).toMatchObject({ outcome: "refused:over-cap", reason: "over cap: 3 open items; wait for a verdict" });
    expect(decideIntent(intent("refs/heads/x"), intentCtx({ hiveOpenItems: g.maxOpenItems }))).toMatchObject({ outcome: "refused:over-cap" });
    // Joining an existing item files nothing new.
    const ctx = intentCtx({ openItems: 3, lookup: lookup([item("I1")]) });
    expect(decideIntent(intent("refs/heads/item/I1"), ctx)).toMatchObject({ verdict: "accept", itemId: "I1" });
    // A re-push of an in-flight submission replaces it (same item): no new item either.
    expect(decideIntent(intent("refs/heads/tip-jar"), intentCtx({ openItems: 3, lookup: lookup([item("I1", { status: "ACTIVE" })]), previousOnRef: prior() }))).toMatchObject({
      verdict: "accept",
      itemId: "I1",
    });
    // A late correlated push files a follow-up: capped.
    expect(decideIntent(intent("refs/heads/item/I1"), intentCtx({ openItems: 3, lookup: lookup([item("I1", { status: "LANDED" })]) }))).toMatchObject({ outcome: "refused:over-cap" });
  });

  it("a paused hive or a spent budget never refuses: accepted with a queued line", () => {
    const d = decideIntent(intent("refs/heads/x"), intentCtx({ paused: true, budgetExhausted: true }));
    expect(d).toMatchObject({ verdict: "accept", itemId: null, supersedeIntents: [] });
    expect(d.messages).toEqual(["queued: hive paused (your submission waits until it resumes)", "queued: today's budget is spent"]);
  });
});

describe("decideIntake (what a landed push becomes, §6.2)", () => {
  it("uncorrelated: a new feature (filed), no race; title = subject, acceptance from the message, trailers stripped", () => {
    const plan = decideIntake(pushed("refs/heads/tip-jar"), { now: 0, lookup: lookup([]), previousOnRef: null });
    expect(plan).toMatchObject({
      disposition: "filed",
      itemId: "NEW",
      reopen: false,
      race: null,
      file: { itemId: "NEW", title: "Add a tip jar", parentId: null, acceptance: ["shows a jar", "takes tips"] },
    });
    expect(plan.file!.body).not.toMatch(/Queen-Origin/);
    expect(plan.messages[0]).toBe('submission received → item NEW "Add a tip jar" (new item, fully gated)');
  });

  it("correlated: joins the item's RACING race, or opens a width-1 race as its next attempt (a FAILED item reopens)", () => {
    const racing = item("I1", { status: "ACTIVE", racing: { raceId: "R1", entryClosesAt: null } });
    expect(decideIntake(pushed("refs/heads/item/I1"), { now: 0, lookup: lookup([racing]), previousOnRef: null })).toMatchObject({
      disposition: "joined-race",
      itemId: "I1",
      race: { join: "R1" },
      reopen: false,
    });
    expect(decideIntake(pushed("refs/heads/item/I2"), { now: 0, lookup: lookup([item("I2")]), previousOnRef: null })).toMatchObject({ disposition: "joined-race", race: { create: true } });
    expect(decideIntake(pushed("refs/heads/item/I3"), { now: 0, lookup: lookup([item("I3", { status: "FAILED" })]), previousOnRef: null })).toMatchObject({
      disposition: "joined-race",
      reopen: true,
      race: { create: true },
    });
  });

  it("late entry: decided, in a car, landed, or a non-race build → a follow-up item (late-new-item), never a rejection", () => {
    for (const late of [
      item("I1", { status: "LANDED" }),
      item("I1", { status: "ACTIVE", decided: true, racing: { raceId: "R", entryClosesAt: null } }),
      item("I1", { status: "ACTIVE", activeNonRace: true }),
      item("I1", { status: "ACTIVE", racing: { raceId: "R", entryClosesAt: 5 } }),
    ]) {
      const plan = decideIntake(pushed("refs/heads/item/I1"), { now: 10, lookup: lookup([late]), previousOnRef: null });
      expect(plan).toMatchObject({ disposition: "late-new-item", itemId: "NEW", race: null, file: { title: "Item I1 (follow-up)" } });
      expect(plan.messages[0]).toMatch(/filed follow-up item NEW$/);
    }
    expect(lateReason(item("I1", { status: "READY" }), 0)).toBeNull();
  });

  it("per-agent branches item/<id>/<agent>: each correlates to the item and races; re-pushing one's own branch supersedes only that train; late after the close → follow-up", () => {
    const racing = lookup([item("I1", { status: "ACTIVE", racing: { raceId: "R1", entryClosesAt: 5_000 } })]);
    for (const ref of ["refs/heads/item/I1/haiku", "refs/heads/item/I1/claude-opus_4.1"]) {
      expect(decideIntake(pushed(ref), { now: 1000, lookup: racing, previousOnRef: null })).toMatchObject({ disposition: "joined-race", itemId: "I1", race: { join: "R1" } });
    }
    // The supersede key is (user, ref): haiku's re-push replaces haiku's train (the caller looks up the prior on that exact ref).
    const sup = decideIntake(pushed("refs/heads/item/I1/haiku"), {
      now: 1000,
      lookup: racing,
      previousOnRef: prior({ ref: "refs/heads/item/I1/haiku", target: { kind: "item", itemId: "I1" }, trainId: "haiku-train" }),
    });
    expect(sup).toMatchObject({ disposition: "superseded", supersedeTrainId: "haiku-train", race: { join: "R1" } });
    // After the close the same push files a follow-up (the existing late-entry behaviour).
    expect(decideIntake(pushed("refs/heads/item/I1/opus"), { now: 5_000, lookup: racing, previousOnRef: null })).toMatchObject({ disposition: "late-new-item", itemId: "NEW" });
    const goal = item("G", { kind: "goal", title: "Dark mode", status: "ACTIVE" });
    expect(decideIntake(pushed("refs/heads/goal/dark-mode/haiku"), { now: 0, lookup: lookup([goal, item("C1", { parentId: "G" })]), previousOnRef: null })).toMatchObject({ itemId: "C1", disposition: "joined-race" });
  });

  it("a re-push after the race's entries closed (still RACING) files a follow-up and does NOT supersede the earlier candidate; before the close it supersedes", () => {
    const ref = "refs/heads/item/I1/haiku";
    const mine = prior({ ref, target: { kind: "item", itemId: "I1" }, trainId: "haiku-train" });
    const closed = lookup([item("I1", { status: "ACTIVE", racing: { raceId: "R1", entryClosesAt: 5_000 } })]);
    const plan = decideIntake(pushed(ref), { now: 5_000, lookup: closed, previousOnRef: mine });
    expect(plan).toMatchObject({ disposition: "late-new-item", itemId: "NEW", race: null });
    expect(plan.supersedeTrainId).toBeUndefined();
    expect(plan.messages[0]).toBe("item I1's race is closed to entries; filed follow-up item NEW");
    expect(decideIntake(pushed(ref), { now: 4_999, lookup: closed, previousOnRef: mine })).toMatchObject({ disposition: "superseded", supersedeTrainId: "haiku-train", race: { join: "R1" } });
    // No window (null): the existing behaviour.
    const noWindow = lookup([item("I1", { status: "ACTIVE", racing: { raceId: "R1", entryClosesAt: null } })]);
    expect(decideIntake(pushed(ref), { now: 9e12, lookup: noWindow, previousOnRef: mine })).toMatchObject({ disposition: "superseded" });
    expect(raceClosedToEntries(item("I1"), 0)).toBe(false);
    expect(raceClosedToEntries(item("I1", { racing: { raceId: "R", entryClosesAt: 5 } }), 5)).toBe(true);
  });

  it("a candidate that failed while the window is open: the contributor's re-push joins the same race as a new candidate", () => {
    const ref = "refs/heads/item/I1/haiku";
    const open = lookup([item("I1", { status: "ACTIVE", racing: { raceId: "R1", entryClosesAt: 5_000 } })]);
    const failed = prior({ ref, target: { kind: "item", itemId: "I1" }, trainId: "haiku-train" }, { trainActive: false });
    expect(decideIntake(pushed(ref), { now: 1000, lookup: open, previousOnRef: failed })).toMatchObject({ disposition: "joined-race", itemId: "I1", race: { join: "R1" } });
    // After the close it is a follow-up instead.
    expect(decideIntake(pushed(ref), { now: 5_000, lookup: open, previousOnRef: failed })).toMatchObject({ disposition: "late-new-item" });
  });

  it("decideIntent: a re-push into a closed race counts as filing a new item for the open-item caps", () => {
    const ref = "refs/heads/item/I1/haiku";
    const mine = prior({ ref, target: { kind: "item", itemId: "I1" } });
    const capped = { openItems: GUARDRAIL_DEFAULTS.maxInboxOpenPerContributor, previousOnRef: mine };
    const racing = (entryClosesAt: number | null) => lookup([item("I1", { status: "ACTIVE", racing: { raceId: "R1", entryClosesAt } })]);
    expect(decideIntent(intent(ref), intentCtx({ ...capped, lookup: racing(null) }))).toMatchObject({ verdict: "accept" });
    expect(decideIntent(intent(ref), intentCtx({ ...capped, lookup: racing(500) }))).toMatchObject({ verdict: "refuse", outcome: "refused:over-cap" });
  });

  it("pushedMessages: the notes hint is always kept and last; the entry-window line is dropped first", () => {
    const base = { plan: ["replaces your earlier push bbbbbbb (train old)", 'submission received → item I1 "Item I1"'], entries: "race open to entries until 14:05 UTC (2 candidates)", status: "train T · verdict in ~2 min", rework: null };
    // 2 + entries + status + hint = 5: fits.
    expect(pushedMessages(base)).toEqual([...base.plan, base.entries, base.status, NOTES_HINT]);
    // With a rework line it would be 6: the entry line goes, the hint stays.
    const withRework = pushedMessages({ ...base, rework: "Queen: rework — the swarm takes over if the gate rejects it" });
    expect(withRework).toHaveLength(5);
    expect(withRework.at(-1)).toBe(NOTES_HINT);
    expect(withRework).not.toContain(base.entries);
    expect(withRework).toContain("Queen: rework — the swarm takes over if the gate rejects it");
    // Even without an entry line and too many lines, the hint survives.
    const flood = pushedMessages({ plan: ["a", "b", "c", "d"], entries: null, status: "s", rework: "r" });
    expect(flood).toHaveLength(5);
    expect(flood.at(-1)).toBe(NOTES_HINT);
    expect(pushedMessages({ plan: ["a"], entries: null, status: "s", rework: null })).toEqual(["a", "s", NOTES_HINT]);
  });

  it("decideIntent resolves the suffix branch's target (unknown item refused, known item accepted)", () => {
    expect(decideIntent(intent("refs/heads/item/nope/haiku"), intentCtx())).toMatchObject({ outcome: "refused:unknown-item", reason: "no item nope in this hive" });
    expect(decideIntent(intent("refs/heads/item/I1/haiku"), intentCtx({ lookup: lookup([item("I1")]) }))).toMatchObject({ verdict: "accept", itemId: "I1" });
  });

  it("entryWindowLine: names the close (UTC) and the candidates while open; nothing once closed or without a window", () => {
    const at = Date.UTC(2026, 9, 9, 14, 5, 30);
    expect(entryWindowLine({ entryClosesAt: at, trainIds: ["a"] }, at - 1)).toBe("race open to entries until 14:05 UTC (1 candidate)");
    expect(entryWindowLine({ entryClosesAt: at, trainIds: ["a", "b", "c"] }, 0)).toBe("race open to entries until 14:05 UTC (3 candidates)");
    expect(entryWindowLine({ entryClosesAt: at, trainIds: ["a"] }, at)).toBeNull();
    expect(entryWindowLine({ entryClosesAt: null, trainIds: ["a"] }, 0)).toBeNull();
    expect(entryWindowLine({ trainIds: ["a"] }, 0)).toBeNull();
  });

  it("goal/<slug>: its single child, else a new item under the goal; Queen-Item addresses an item from any branch", () => {
    const goal = item("G", { kind: "goal", title: "Dark mode", status: "ACTIVE" });
    const one = lookup([goal, item("C1", { parentId: "G" })]);
    expect(decideIntake(pushed("refs/heads/goal/dark-mode"), { now: 0, lookup: one, previousOnRef: null })).toMatchObject({ itemId: "C1", disposition: "joined-race" });
    const two = lookup([goal, item("C1", { parentId: "G" }), item("C2", { parentId: "G" })]);
    expect(decideIntake(pushed("refs/heads/goal/G"), { now: 0, lookup: two, previousOnRef: null })).toMatchObject({ disposition: "filed", file: { parentId: "G" } });
    expect(resolveTarget({ kind: "item", itemId: "G" }, one)).toEqual({ itemId: "C1" });
    const msg = "Fix it\n\nQueen-Item: C1";
    expect(decideIntake(pushed("refs/heads/fix", { message: msg, trailers: trailersOf(msg) }), { now: 0, lookup: one, previousOnRef: null })).toMatchObject({ itemId: "C1", race: { create: true } });
    const bad = "Fix it\n\nQueen-Item: nope";
    const plan = decideIntake(pushed("refs/heads/fix", { message: bad, trailers: trailersOf(bad) }), { now: 0, lookup: one, previousOnRef: null });
    expect(plan).toMatchObject({ disposition: "filed", itemId: "NEW" });
    expect(plan.messages[0]).toBe("Queen-Item nope not found; filed a new item");
  });

  it("a re-push of the same branch: supersedes before boarding, files a follow-up after, reopens a FAILED item", () => {
    const active = lookup([item("I1", { status: "ACTIVE", activeNonRace: true, decided: true })]);
    const sup = decideIntake(pushed("refs/heads/tip-jar"), { now: 0, lookup: active, previousOnRef: prior() });
    expect(sup).toMatchObject({ disposition: "superseded", itemId: "I1", supersedeTrainId: "old", race: null });
    expect(sup.messages[0]).toBe("replaces your earlier push bbbbbbb (train old)");
    const racing = lookup([item("I1", { status: "ACTIVE", racing: { raceId: "R1", entryClosesAt: null } })]);
    expect(decideIntake(pushed("refs/heads/item/I1"), { now: 0, lookup: racing, previousOnRef: prior({ target: { kind: "item", itemId: "I1" } }) })).toMatchObject({
      disposition: "superseded",
      race: { join: "R1" },
    });
    const boarded = decideIntake(pushed("refs/heads/tip-jar"), { now: 0, lookup: active, previousOnRef: prior({}, { trainBoarded: true }) });
    expect(boarded).toMatchObject({ disposition: "late-new-item", file: { title: "Item I1 (follow-up)" } });
    const failed = lookup([item("I1", { status: "FAILED" })]);
    expect(decideIntake(pushed("refs/heads/tip-jar"), { now: 0, lookup: failed, previousOnRef: prior({}, { trainActive: false }) })).toMatchObject({
      disposition: "reopened",
      itemId: "I1",
      reopen: true,
      race: null,
    });
  });
});

describe("intake helpers", () => {
  it("itemFromMessage: subject, body without trailers, acceptance bullets", () => {
    expect(itemFromMessage(undefined, "Subject line\n\nbody\nQueen: rework\n\nAcceptance criteria:\n* a\n- b\n\nmore")).toEqual({
      title: "Subject line",
      body: "body\n\nAcceptance criteria:\n* a\n- b\n\nmore",
      acceptance: ["a", "b"],
    });
    expect(itemFromMessage("", "").title).toBe("untitled push");
  });

  it("trailersOf: multi-segment keys, the proxy's parsed trailers overlay the message; origin from Queen-Origin", () => {
    const t = trailersOf("x\n\nQueen: rework\nQueen-Replies-To: " + SHA, { "Queen-Origin": "agent:codex" });
    expect(t).toMatchObject({ rework: true, agent: "codex" });
    expect(t.raw["queen-replies-to"]).toBe(SHA);
    expect(originOf(USER, t)).toEqual({ kind: "agent", id: `codex@${USER}` });
    expect(originOf(USER, trailersOf("x"))).toEqual({ kind: "human", id: USER });
  });

  it("handleFor and remoteLines", () => {
    expect(handleFor("Ada.Lovelace+git@example.com")).toBe("adalovelacegit");
    expect(handleFor("ada@x.com", (h) => h === "ada")).toMatch(/^ada[0-9a-f]{4}$/);
    expect(remoteLines(["a", null, "", "b\nc", "x".repeat(300), "d", "e", "f"])).toEqual(["a", "b c", `${"x".repeat(199)}…`, "d", "e"]);
  });
});

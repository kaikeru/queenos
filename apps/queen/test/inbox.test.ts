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
  handleFor,
  itemFromMessage,
  lateReason,
  originOf,
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

const intent = (ref: string) => ({ ref, newSha: SHA, user: USER });

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

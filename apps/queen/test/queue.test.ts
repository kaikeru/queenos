import { describe, expect, it } from "vitest";
import type { MergeResult } from "@queenos/queen-types";
import type { TrainRecord } from "../src/train/planner";
import {
  CAR_INFRA_FAILURES_BEFORE_LOST,
  activeCars,
  carFailed,
  carLanded,
  conflictSummary,
  formCars,
  mergeResult,
  pinKey,
  rewriteMembers,
  waitingToBoard,
  type QueueContext,
  type QueueDecision,
} from "../src/train/queue";

const SHA = (c: string) => c.repeat(40).slice(0, 40);

function train(trainId: string, over: Partial<TrainRecord> = {}): TrainRecord {
  return {
    trainId,
    baseSha: SHA("b"),
    includedPrompts: [over.promptId ?? `p-${trainId}`],
    artifactRepo: `hive-train-${trainId}`,
    status: "TESTING",
    createdAt: 0,
    seq: 1,
    promptId: `p-${trainId}`,
    phase: "PASSED",
    forkState: "READY",
    forkSource: "hive",
    headSha: SHA("a"),
    landedSha: null,
    summary: null,
    reason: null,
    action: "BUILD",
    dispatched: false,
    forkCommandId: `${trainId}-fork-1`,
    deleteCommandId: null,
    deployState: "LIVE",
    deployCommandId: `${trainId}-deploy-1`,
    teardownCommandId: null,
    previewUrl: `https://${trainId}.preview`,
    forkIssuedAt: null,
    deleteIssuedAt: null,
    deployIssuedAt: null,
    teardownIssuedAt: null,
    droneIssuedAt: null,
    droneAttempt: 1,
    model: null,
    modelReason: null,
    modelChoice: null,
    modelChoiceAttempt: null,
    modelOutcome: null,
    modelProbe: false,
    memories: [],
    lane: "BUILD",
    carId: null,
    passedSeq: null,
    ...over,
  };
}

/** A passed BUILD train waiting to board. */
function passed(trainId: string, passedSeq: number, over: Partial<TrainRecord> = {}): TrainRecord {
  return train(trainId, { passedSeq, seq: passedSeq, ...over });
}

/** An active QUEUE car carrying `members` (BUILD trains in `pool`, whose carId it sets). */
function car(carId: string, seq: number, members: TrainRecord[], ahead: string[] = [], over: Partial<TrainRecord> = {}): TrainRecord {
  for (const m of members) m.carId = carId;
  return train(carId, {
    lane: "QUEUE",
    seq,
    promptId: members[0]?.promptId ?? `p-${carId}`,
    members: members.map((m) => m.trainId),
    includedPrompts: [...ahead, ...members.map((m) => m.promptId)],
    phase: "WAITING_PARENT",
    status: "BUILDING",
    forkState: "NONE",
    forkCommandId: null,
    deployState: "NONE",
    deployCommandId: null,
    previewUrl: null,
    headSha: null,
    passedSeq: null,
    ...over,
  });
}

function ctx(over: Partial<QueueContext> = {}, priorities: Record<string, number> = {}): QueueContext {
  let n = 0;
  return {
    namespace: "hive",
    now: 1000,
    newId: () => `K${++n}`,
    settings: { maxQueueBatch: 4, maxQueueDepth: 3 },
    priorityOf: (p) => priorities[p] ?? 2,
    carInfraFailures: 0,
    paused: false,
    ...over,
  };
}

function merge(carId: string, over: Partial<MergeResult> = {}): MergeResult {
  return { trainId: carId, ok: true, headSha: SHA("c"), baseSha: SHA("d"), merged: [], conflicts: [], fastForward: false, summary: "", ...over };
}

function patchOf(d: QueueDecision, trainId: string): Partial<TrainRecord> | undefined {
  return d.patches.find((p) => p.trainId === trainId)?.patch;
}

/**
 * Apply a decision the way the planner does: patches via setTrain, cars
 * materialised as WAITING_PARENT QUEUE trains (seq after the highest), and
 * failures fail()ed (EJECTED; the rework is the planner's).
 */
function apply(trains: TrainRecord[], d: QueueDecision): TrainRecord[] {
  const out = trains.map((t) => {
    const p = d.patches.find((x) => x.trainId === t.trainId)?.patch;
    return p ? { ...t, ...p } : { ...t };
  });
  let seq = Math.max(0, ...out.map((t) => t.seq));
  for (const c of d.cars) {
    out.push(
      train(c.carId, {
        lane: "QUEUE",
        seq: ++seq,
        promptId: c.includedPrompts.at(-1)!,
        members: c.members,
        includedPrompts: c.includedPrompts,
        bisectOf: c.bisectOf,
        phase: "WAITING_PARENT",
        status: "BUILDING",
        forkState: "NONE",
        forkCommandId: null,
        deployState: "NONE",
        deployCommandId: null,
        headSha: null,
      }),
    );
  }
  for (const f of d.failures) {
    const t = out.find((x) => x.trainId === f.trainId)!;
    Object.assign(t, { phase: "EJECTED", reason: `failed: ${f.summary}` });
  }
  return out;
}

const ids = (ts: readonly TrainRecord[]) => ts.map((t) => t.trainId);

describe("formCars", () => {
  it("boards by item priority, then passedSeq, and stamps carId", () => {
    const a = passed("A", 1);
    const b = passed("B", 2);
    const c = passed("C", 3, { promptId: "urgent" });
    const d = formCars([a, b, c], ctx({}, { urgent: 0 }));
    expect(d.cars).toHaveLength(1);
    expect(d.cars[0]).toEqual({ carId: "K1", members: ["C", "A", "B"], includedPrompts: ["urgent", "p-A", "p-B"], predecessorCarId: null, bisectOf: null });
    for (const id of ["A", "B", "C"]) expect(patchOf(d, id)).toEqual({ carId: "K1" });
    expect(d.events.map((e) => e.type)).toEqual(["queue.car"]);
  });

  it("caps members per car at maxQueueBatch and stacks each car on the previous one", () => {
    const pool = [1, 2, 3, 4, 5, 6].map((i) => passed(`T${i}`, i));
    const d = formCars(pool, ctx());
    expect(d.cars.map((c) => c.members)).toEqual([["T1", "T2", "T3", "T4"], ["T5", "T6"]]);
    expect(d.cars[1]!.predecessorCarId).toBe("K1");
    expect(d.cars[1]!.includedPrompts).toEqual(["p-T1", "p-T2", "p-T3", "p-T4", "p-T5", "p-T6"]);
  });

  it("stops at maxQueueDepth active cars; the rest wait to board", () => {
    const x = passed("X", 1);
    const y = passed("Y", 2);
    const k0 = car("K0", 10, [x]);
    const pool = [3, 4, 5, 6].map((i) => passed(`T${i}`, i));
    const d = formCars([x, y, k0, ...pool], ctx({ settings: { maxQueueBatch: 1, maxQueueDepth: 3 } }));
    expect(d.cars.map((c) => c.members)).toEqual([["Y"], ["T3"]]);
    // Stacked on the existing car, cumulatively.
    expect(d.cars[0]!.predecessorCarId).toBe("K0");
    expect(d.cars[0]!.includedPrompts).toEqual(["p-X", "p-Y"]);
    expect(d.cars[1]!.includedPrompts).toEqual(["p-X", "p-Y", "p-T3"]);
    expect(patchOf(d, "T4")).toBeUndefined();
  });

  it("forms nothing at full depth, when paused, or with an empty pool", () => {
    const ms = [1, 2, 3].map((i) => passed(`M${i}`, i));
    const full = [car("K1", 10, [ms[0]!]), car("K2", 11, [ms[1]!]), car("K3", 12, [ms[2]!])];
    expect(formCars([...ms, ...full, passed("W", 9)], ctx()).cars).toEqual([]);
    expect(formCars([passed("W", 9)], ctx({ paused: true })).cars).toEqual([]);
    expect(formCars([train("B1", { phase: "TESTING" })], ctx()).cars).toEqual([]);
  });

  it("ignores trains that are not PASSED, already boarded, or cars", () => {
    const boarded = passed("B", 1, { carId: "K9" });
    const testing = passed("T", 2, { phase: "TESTING" });
    const ejected = passed("E", 3, { phase: "EJECTED" });
    const ok = passed("O", 4);
    expect(formCars([boarded, testing, ejected, ok], ctx()).cars.map((c) => c.members)).toEqual([["O"]]);
  });

  it("boards pinned bisect halves first, each as its own car, half 0 before half 1, and clears the pin", () => {
    const urgent = passed("U", 1, { promptId: "urgent" });
    const r = passed("R", 7, { bisectOf: pinKey("K5", 1) });
    const s = passed("S", 8, { bisectOf: pinKey("K5", 1) });
    const p = passed("P", 5, { bisectOf: pinKey("K5", 0) });
    const q = passed("Q", 6, { bisectOf: pinKey("K5", 0) });
    const d = formCars([urgent, r, s, p, q], ctx({}, { urgent: 0 }));
    expect(d.cars.map((c) => [c.members, c.bisectOf])).toEqual([
      [["P", "Q"], "K5"],
      [["R", "S"], "K5"],
      [["U"], null],
    ]);
    expect(d.cars[1]!.predecessorCarId).toBe(d.cars[0]!.carId);
    expect(patchOf(d, "P")).toEqual({ carId: "K1", bisectOf: null });
    expect(patchOf(d, "U")).toEqual({ carId: "K3" });
  });

  it("keeps a pinned half pinned when the depth cap leaves no room", () => {
    const m = passed("M", 1);
    const k0 = car("K0", 10, [m]);
    const p = passed("P", 5, { bisectOf: pinKey("K5", 0) });
    const r = passed("R", 7, { bisectOf: pinKey("K5", 1) });
    const d = formCars([m, k0, p, r], ctx({ settings: { maxQueueBatch: 4, maxQueueDepth: 2 } }));
    expect(d.cars.map((c) => c.members)).toEqual([["P"]]);
    expect(patchOf(d, "R")).toBeUndefined();
  });
});

describe("rewriteMembers", () => {
  it("removes members and their prompts from the car and every later car, and clears their carId", () => {
    const [a, b, c, d] = ["A", "B", "C", "D"].map((id, i) => passed(id, i + 1));
    const k0 = car("K0", 9, [passed("Z", 0)]);
    const k1 = car("K1", 10, [a!, b!], ["p-Z"]);
    const k2 = car("K2", 11, [c!, d!], ["p-Z", "p-A", "p-B"]);
    const patches = rewriteMembers([a!, b!, c!, d!, k0, k1, k2], 10, ["B"]);
    expect(patches).toEqual([
      { trainId: "K1", patch: { members: ["A"], includedPrompts: ["p-Z", "p-A"] } },
      { trainId: "K2", patch: { members: ["C", "D"], includedPrompts: ["p-Z", "p-A", "p-C", "p-D"] } },
      { trainId: "B", patch: { carId: null } },
    ]);
    expect(rewriteMembers([a!, k1], 10, [])).toEqual([]);
  });
});

describe("mergeResult", () => {
  function scene() {
    const [e, f, g] = ["E", "F", "G"].map((id, i) => passed(id, i + 1));
    const [h, i] = ["H", "I"].map((id, n) => passed(id, n + 4));
    const k3 = car("K3", 10, [e!, f!, g!], [], { phase: "BUILDING", forkState: "READY", forkCommandId: "K3-fork-1", dispatched: true });
    const k4 = car("K4", 11, [h!, i!], ["p-E", "p-F", "p-G"]);
    return { e: e!, f: f!, g: g!, h: h!, i: i!, k3, k4, trains: [e!, f!, g!, h!, i!, k3, k4] };
  }

  it("a conflict in the middle member: it leaves this car and later cars and is failed with a conflict summary", () => {
    const s = scene();
    const conflict = { trainId: "F", kind: "content" as const, paths: ["src/theme.js"], summary: "" };
    const d = mergeResult(s.k3, merge("K3", { merged: ["E", "G"], conflicts: [conflict] }), s.trains, ctx());
    expect(patchOf(d, "K3")).toMatchObject({ phase: "DEPLOYING", members: ["E", "G"], includedPrompts: ["p-E", "p-G"], headSha: SHA("c"), baseSha: SHA("d") });
    expect(patchOf(d, "K4")).toEqual({ members: ["H", "I"], includedPrompts: ["p-E", "p-G", "p-H", "p-I"] });
    expect(patchOf(d, "F")).toEqual({ carId: null, conflict });
    expect(d.failures).toEqual([
      {
        trainId: "F",
        cause: "conflict",
        waitForCarSeq: 10,
        conflict,
        claimPaths: ["src/theme.js"],
        summary:
          "Merge conflict: your change and work that landed ahead of you both edit src/theme.js (content). Re-apply your change on top of the current main and keep both behaviours.",
      },
    ]);
    expect(d.events.map((e) => e.type)).toEqual(["queue.conflict", "queue.merged"]);
    expect(d.effects).toEqual([]);
    expect(d.cars).toEqual([]);
  });

  it("all members conflict: the empty car is EJECTED (no blame) with its fork deleted, and later cars rewritten", () => {
    const s = scene();
    const conflicts = ["E", "F", "G"].map((t) => ({ trainId: t, kind: "unsupported" as const, paths: [], summary: "add/add" }));
    const d = mergeResult(s.k3, merge("K3", { merged: [], conflicts, headSha: undefined }), s.trains, ctx());
    expect(patchOf(d, "K3")).toMatchObject({ phase: "EJECTED", reason: "no members merged", members: [], forkState: "DELETING", deleteCommandId: "K3-delete-1" });
    expect(d.effects).toEqual([{ type: "provision", trainId: "K3", command: { op: "DELETE", commandId: "K3-delete-1", hive: "hive", trainId: "K3", repo: "hive-train-K3", trace: { traceparent: expect.stringMatching(/^00-/) } } }]);
    expect(patchOf(d, "K4")).toEqual({ members: ["H", "I"], includedPrompts: ["p-H", "p-I"] });
    expect(d.failures.map((f) => [f.trainId, f.cause, f.waitForCarSeq])).toEqual([
      ["E", "conflict", 10],
      ["F", "conflict", 10],
      ["G", "conflict", 10],
    ]);
    expect(d.failures[0]!.summary).toContain("both edit the same files (unsupported)");
  });

  it("a member neither merged nor conflicting returns to the pool with no blame", () => {
    const s = scene();
    const d = mergeResult(s.k3, merge("K3", { merged: ["E", "F"] }), s.trains, ctx());
    expect(patchOf(d, "G")).toEqual({ carId: null });
    expect(d.failures).toEqual([]);
  });

  it("fast path: one member fast-forwarded goes straight to PASSED", () => {
    const m = passed("M", 1);
    const k = car("K1", 10, [m], [], { phase: "BUILDING" });
    const d = mergeResult(k, merge("K1", { merged: ["M"], fastForward: true }), [m, k], ctx());
    expect(patchOf(d, "K1")).toMatchObject({ phase: "PASSED", headSha: SHA("c") });
    expect(d.events[0]!.summary).toContain("fast path");
  });

  it("ok:false is an infra failure: the car is ejected and its members return to the pool", () => {
    const s = scene();
    const d = mergeResult(s.k3, merge("K3", { ok: false, summary: "clone failed" }), s.trains, ctx());
    expect(patchOf(d, "K3")).toMatchObject({ phase: "EJECTED", reason: "failed: clone failed" });
    expect(patchOf(d, "K4")).toMatchObject({ phase: "EJECTED" });
    for (const id of ["E", "F", "G", "H", "I"]) expect(patchOf(d, id)).toEqual({ carId: null, bisectOf: null });
    expect(d.carInfraFailures).toBe(1);
    expect(d.failures).toEqual([]);
  });

  it("a clean merge resets the consecutive infra-failure count", () => {
    const s = scene();
    expect(mergeResult(s.k3, merge("K3", { merged: ["E", "F", "G"] }), s.trains, ctx({ carInfraFailures: 2 })).carInfraFailures).toBe(0);
    expect(mergeResult(s.k3, merge("K3", { merged: ["E", "F", "G"] }), s.trains, ctx()).carInfraFailures).toBeUndefined();
  });

  it("writes a missing-head summary for kind missing", () => {
    expect(conflictSummary({ trainId: "X", kind: "missing", paths: [], summary: "head not fetchable" })).toMatch(/^Merge conflict: your pushed head could not be fetched/);
  });
});

describe("carFailed", () => {
  function gated() {
    const [p, q, r, s] = ["P", "Q", "R", "S"].map((id, i) => passed(id, i + 1));
    const [u, v] = ["U", "V"].map((id, i) => passed(id, i + 5));
    const k5 = car("K5", 10, [p!, q!, r!, s!], [], { phase: "TESTING", forkState: "READY", forkCommandId: "K5-fork-1", deployState: "LIVE", deployCommandId: "K5-deploy-1", headSha: SHA("5") });
    const k6 = car("K6", 11, [u!, v!], ["p-P", "p-Q", "p-R", "p-S"], { phase: "BUILDING", forkState: "PENDING", forkCommandId: "K6-fork-1" });
    return { members: [p!, q!, r!, s!], k5, k6, u: u!, v: v!, trains: [p!, q!, r!, s!, u!, v!, k5, k6] };
  }

  it("bisects a 4-member gate failure into 2+2 pinned halves, and formCars boards them first", () => {
    const s = gated();
    const d = carFailed(s.k5, "smoke: /features/q 500 after merge", "gate", s.trains, ctx());
    expect(patchOf(d, "K5")).toMatchObject({ phase: "EJECTED", reason: "failed: smoke: /features/q 500 after merge", forkState: "DELETING", deployState: "TEARING_DOWN" });
    expect(d.effects.map((e) => (e.type === "provision" || e.type === "deploy" ? `${e.trainId}:${e.command.op}` : e.type))).toEqual([
      "K5:DELETE",
      "K5:TEARDOWN",
      "K6:DELETE",
    ]);
    expect(patchOf(d, "P")).toEqual({ carId: null, bisectOf: "K5#0" });
    expect(patchOf(d, "Q")).toEqual({ carId: null, bisectOf: "K5#0" });
    expect(patchOf(d, "R")).toEqual({ carId: null, bisectOf: "K5#1" });
    expect(patchOf(d, "S")).toEqual({ carId: null, bisectOf: "K5#1" });
    expect(d.failures).toEqual([]);
    expect(d.events.map((e) => e.type)).toEqual(["queue.bisect"]);

    const next = apply(s.trains, d);
    let n = 6;
    const f = formCars(next, ctx({ newId: () => `K${++n}` }));
    expect(f.cars.map((c) => [c.carId, c.members, c.predecessorCarId, c.bisectOf])).toEqual([
      ["K7", ["P", "Q"], null, "K5"],
      ["K8", ["R", "S"], "K7", "K5"],
      ["K9", ["U", "V"], "K8", null],
    ]);
  });

  it("a stacked successor is superseded: its members go back to the pool with no attempt charged", () => {
    const s = gated();
    const d = carFailed(s.k5, "gate red", "gate", s.trains, ctx());
    expect(patchOf(d, "K6")).toMatchObject({ phase: "EJECTED", reason: "superseded: car K5 failed", forkState: "DELETING" });
    expect(patchOf(d, "U")).toEqual({ carId: null, bisectOf: null });
    expect(patchOf(d, "V")).toEqual({ carId: null, bisectOf: null });
    expect(d.failures.map((f) => f.trainId)).not.toContain("U");
    const after = apply(s.trains, d);
    expect(ids(waitingToBoard(after))).toEqual(["P", "Q", "R", "S", "U", "V"]);
    expect(activeCars(after)).toEqual([]);
  });

  it("leaves cars ahead of the failed car alone", () => {
    const z = passed("Z", 0);
    const k4 = car("K4", 9, [z], [], { phase: "PASSED" });
    const s = gated();
    s.k5.includedPrompts = ["p-Z", ...s.k5.includedPrompts];
    s.k6.includedPrompts = ["p-Z", ...s.k6.includedPrompts];
    const d = carFailed(s.k5, "red", "gate", [z, k4, ...s.trains], ctx());
    expect(patchOf(d, "K4")).toBeUndefined();
    expect(patchOf(d, "Z")).toBeUndefined();
    expect(patchOf(d, "K6")).toMatchObject({ phase: "EJECTED" });
  });

  it("splits an odd car 3 → 2+1", () => {
    const [a, b, c] = ["A", "B", "C"].map((id, i) => passed(id, i + 1));
    const k = car("K1", 10, [a!, b!, c!], [], { phase: "TESTING" });
    const d = carFailed(k, "red", "gate", [a!, b!, c!, k], ctx());
    expect([patchOf(d, "A")?.bisectOf, patchOf(d, "B")?.bisectOf, patchOf(d, "C")?.bisectOf]).toEqual(["K1#0", "K1#0", "K1#1"]);
  });

  it("a singleton gate failure fails its member with the integration summary, waiting for the car", () => {
    const q = passed("Q", 2);
    const k10 = car("K10", 14, [q], [], { phase: "TESTING", baseSha: "abc1234deadbeef" });
    const d = carFailed(k10, "smoke: /features/q 500", "gate", [q, k10], ctx({ carInfraFailures: 1 }));
    expect(d.failures).toEqual([
      { trainId: "Q", summary: "Passed alone, fails integrated on main@abc1234: smoke: /features/q 500", cause: "integration", waitForCarSeq: 14, conflict: null, claimPaths: [] },
    ]);
    expect(patchOf(d, "Q")).toBeUndefined();
    expect(d.events).toEqual([]);
    expect(d.carInfraFailures).toBe(0);
  });

  it("an infra failure never bisects: members return to the pool and the infra count rises", () => {
    const s = gated();
    const d = carFailed(s.k5, "Herald DEPLOY did not report", "infra", s.trains, ctx());
    for (const m of ["P", "Q", "R", "S", "U", "V"]) expect(patchOf(d, m)).toEqual({ carId: null, bisectOf: null });
    expect(d.events.map((e) => e.type)).not.toContain("queue.bisect");
    expect(d.failures).toEqual([]);
    expect(d.carInfraFailures).toBe(1);
    expect(d.executorLost).toBeUndefined();
  });

  it("3 consecutive infra-failed cars open EXECUTOR_LOST, and formation then pauses", () => {
    expect(CAR_INFRA_FAILURES_BEFORE_LOST).toBe(3);
    let infra = 0;
    let lost = false;
    for (let i = 0; i < 3; i++) {
      const m = passed(`M${i}`, i + 1);
      const k = car(`K${i}`, 10 + i, [m], [], { phase: "LANDING" });
      const d = carFailed(k, "NOT_FAST_FORWARD", "infra", [m, k], ctx({ carInfraFailures: infra }));
      infra = d.carInfraFailures!;
      lost = d.executorLost ?? false;
      expect(lost).toBe(i === 2);
    }
    expect(infra).toBe(3);
    // The planner records the open EXECUTOR_LOST; formCars sees paused.
    expect(formCars([passed("W", 1)], ctx({ paused: true, carInfraFailures: 3 })).cars).toEqual([]);
    // Already paused: no second escalation.
    const m = passed("M9", 9);
    const k = car("K9", 20, [m], [], { phase: "LANDING" });
    expect(carFailed(k, "lost", "infra", [m, k], ctx({ carInfraFailures: 3, paused: true })).executorLost).toBeUndefined();
  });
});

describe("carLanded", () => {
  it("merges the car and every member with one landedSha, deleting member forks and tearing down previews", () => {
    const ms = ["A", "B", "C", "D"].map((id, i) => passed(id, i + 1));
    const k = car("K1", 10, ms, [], { phase: "LANDING", forkState: "READY", deployState: "LIVE", deployCommandId: "K1-deploy-1" });
    const d = carLanded(k, SHA("e"), [...ms, k], ctx({ carInfraFailures: 2 }));
    expect(patchOf(d, "K1")).toEqual({ phase: "MERGED", status: "MERGED", landedSha: SHA("e") });
    for (const m of ms) {
      expect(patchOf(d, m.trainId)).toEqual({
        phase: "MERGED",
        status: "MERGED",
        landedSha: SHA("e"),
        forkState: "DELETING",
        deleteCommandId: `${m.trainId}-delete-1`,
        deployState: "TEARING_DOWN",
        teardownCommandId: `${m.trainId}-teardown-1`,
      });
    }
    expect(d.effects).toHaveLength(8);
    expect(d.effects.filter((e) => "trainId" in e && e.trainId === "K1")).toEqual([]);
    expect(d.carInfraFailures).toBe(0);
    expect(d.events.map((e) => e.type)).toEqual(["queue.landed"]);
  });
});

describe("§3.2b batch failure → bisect, end to end (pure)", () => {
  it("K5 [P,Q,R,S] ✗ → K7 [P,Q] + K8 [R,S]; K7 ✗ → K9 [P] + K10 [Q], K8 superseded; K10 ✗ → Q reworks; R,S board behind", () => {
    let n = 0;
    const c = (over: Partial<QueueContext> = {}) => ctx({ newId: () => `C${++n}`, ...over });
    let trains: TrainRecord[] = ["P", "Q", "R", "S", "X"].map((id, i) => passed(id, i + 1));
    // Depth 1 to start, so P..S form one car and X waits behind it.
    trains = apply(trains, formCars(trains, c({ settings: { maxQueueBatch: 4, maxQueueDepth: 1 } })));
    const k5 = activeCars(trains)[0]!;
    expect(k5.members).toEqual(["P", "Q", "R", "S"]);

    trains = apply(trains, carFailed(k5, "smoke red", "gate", trains, c()));
    trains = apply(trains, formCars(trains, c()));
    const [k7, k8, kx] = activeCars(trains);
    expect([k7!.members, k8!.members, kx!.members]).toEqual([["P", "Q"], ["R", "S"], ["X"]]);

    trains = apply(trains, carFailed(k7!, "smoke red", "gate", trains, c()));
    expect(activeCars(trains)).toEqual([]);
    trains = apply(trains, formCars(trains, c()));
    const [k9, k10, k11] = activeCars(trains);
    expect([k9!.members, k10!.members, k11!.members]).toEqual([["P"], ["Q"], ["R", "S", "X"]]);

    // K9 lands; K10 fails alone → Q's integration rework; K11 is superseded only if it contains Q.
    trains = apply(trains, carLanded(k9!, SHA("9"), trains, c()));
    const fail = carFailed(k10!, "smoke red", "gate", trains, c());
    expect(fail.failures.map((f) => [f.trainId, f.cause, f.waitForCarSeq])).toEqual([["Q", "integration", k10!.seq]]);
    trains = apply(trains, fail);
    expect(ids(waitingToBoard(trains))).toEqual(["R", "S", "X"]);
    trains = apply(trains, formCars(trains, c()));
    expect(activeCars(trains).map((k) => k.members)).toEqual([["R", "S", "X"]]);
    expect(activeCars(trains)[0]!.includedPrompts).toEqual(["p-R", "p-S", "p-X"]);
  });
});

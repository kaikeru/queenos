/**
 * WP1.11 planner integration: the merge queue driven through TrainPlanner.
 *
 * SKIPPED until WP1.2 lands the QUEUE hooks in apps/queen/src/train/planner.ts.
 * Hooks this file expects (un-skip and adjust names once they exist):
 * - `TrainPlanner.mergeResult(r: MergeResult): PlanResult`, with buildResult's
 *   guards (unknown → ignored:unknown, terminal car → ignored:stale, car not
 *   BUILDING → ignored:duplicate), delegating to `queue.mergeResult`;
 * - `TrainPlanner.landResult(r)` on a QUEUE car delegating to `queue.carLanded`
 *   (members MERGED with one landedSha, forks deleted, previews torn down);
 * - `PlanResult.landed?: { sha: string; trainIds: string[] }`: the members the
 *   DO hands to the release planner (`rp.landed`);
 * - `fail()` on a QUEUE car → `queue.carFailed`; `maybeLand()` → `queue.formCars`;
 * - `PlannerContext.queue?: QueueSettings` and `PlannerContext.priorityOf?`.
 */
import { describe, expect, it } from "vitest";
import type { MergeResult } from "@queenos/queen-types";
import { TrainPlanner, type Effect, type PlanResult, type PromptRecord, type TrainRecord } from "../src/train/planner";

/** The hooks WP1.2 adds (cast until they exist, so this file typechecks today). */
interface QueueHooks {
  mergeResult(r: MergeResult): PlanResult;
}
type WithLanded = PlanResult & { landed?: { sha: string; trainIds: string[] } };

const SHA = (c: string) => c.repeat(40);

function base(trainId: string, over: Partial<TrainRecord>): TrainRecord {
  return {
    trainId,
    baseSha: SHA("b"),
    includedPrompts: [`p-${trainId}`],
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

function prompt(id: string, seq: number): PromptRecord {
  return { promptId: id, namespace: "hive", promptText: `do ${id}`, status: "IN_TRAIN", createdAt: 0, seq, summary: null, attempts: 0 };
}

/** Four passed members on car K1, in `carPhase`. */
function hive(carPhase: TrainRecord["phase"]) {
  const members = ["A", "B", "C", "D"].map((id, i) => base(id, { seq: i + 1, passedSeq: i + 1, carId: "K1" }));
  const car = base("K1", {
    lane: "QUEUE",
    seq: 10,
    promptId: "p-D",
    members: members.map((m) => m.trainId),
    includedPrompts: members.map((m) => m.promptId),
    phase: carPhase,
    status: carPhase === "BUILDING" ? "BUILDING" : "TESTING",
    dispatched: true,
    headSha: carPhase === "BUILDING" ? null : SHA("c"),
  });
  return {
    planner: () =>
      new TrainPlanner(
        { prompts: members.map((m, i) => prompt(m.promptId, i + 1)), trains: [...members, car], maxTrainSeq: 10, maxPromptSeq: 4 },
        { namespace: "hive", now: 1000, newId: (() => { let n = 0; return () => `n${++n}`; })() },
      ),
  };
}

const ops = (effects: Effect[], op: string) =>
  effects
    .filter((e): e is Extract<Effect, { type: "provision" | "deploy" }> => (e.type === "provision" || e.type === "deploy") && e.command.op === op)
    .map((e) => e.trainId);

describe.skip("planner ↔ merge queue (needs WP1.2's QUEUE hooks)", () => {
  it("a 4-member car lands: 4 BUILD trains MERGED with one landedSha, forks deleted, previews torn down, rp.landed gets the members", () => {
    const r = hive("LANDING").planner().landResult({ trainId: "K1", landed: true, mainSha: SHA("e"), summary: "" }) as WithLanded;
    expect(r.outcome).toBe("applied");
    const byId = new Map(r.trains.map((t) => [t.trainId, t]));
    expect(byId.get("K1")).toMatchObject({ phase: "MERGED", landedSha: SHA("e") });
    for (const id of ["A", "B", "C", "D"]) expect(byId.get(id)).toMatchObject({ phase: "MERGED", landedSha: SHA("e"), forkState: "DELETING", deployState: "TEARING_DOWN" });
    expect(ops(r.effects, "DELETE").sort()).toEqual(["A", "B", "C", "D", "K1"]);
    expect(ops(r.effects, "TEARDOWN").sort()).toEqual(expect.arrayContaining(["A", "B", "C", "D"]));
    expect(r.prompts.filter((p) => p.status === "MERGED").map((p) => p.promptId).sort()).toEqual(["p-A", "p-B", "p-C", "p-D"]);
    expect(r.landed).toEqual({ sha: SHA("e"), trainIds: ["A", "B", "C", "D"] });
  });

  it("a duplicate MergeResult is ignored:duplicate, and one for an ejected car is ignored:stale", () => {
    const h = hive("BUILDING");
    const result: MergeResult = { trainId: "K1", ok: true, headSha: SHA("c"), baseSha: SHA("b"), merged: ["A", "B", "C", "D"], conflicts: [], fastForward: false, summary: "" };
    const first = (h.planner() as unknown as QueueHooks).mergeResult(result);
    expect(first.outcome).toBe("applied");
    expect(first.trains.find((t) => t.trainId === "K1")).toMatchObject({ phase: "DEPLOYING", headSha: SHA("c") });

    // Re-run against the persisted state: the car is no longer BUILDING.
    const after = new TrainPlanner(
      {
        prompts: ["A", "B", "C", "D"].map((id, i) => prompt(`p-${id}`, i + 1)),
        trains: first.trains,
        maxTrainSeq: 10,
        maxPromptSeq: 4,
      },
      { namespace: "hive", now: 2000, newId: () => "x" },
    );
    expect((after as unknown as QueueHooks).mergeResult(result).outcome).toBe("ignored:duplicate");

    const ejected = first.trains.map((t) => (t.trainId === "K1" ? { ...t, phase: "EJECTED" as const } : t));
    const stale = new TrainPlanner({ prompts: [], trains: ejected, maxTrainSeq: 10, maxPromptSeq: 4 }, { namespace: "hive", now: 3000, newId: () => "y" });
    expect((stale as unknown as QueueHooks).mergeResult(result).outcome).toBe("ignored:stale");
    expect((stale as unknown as QueueHooks).mergeResult({ ...result, trainId: "nope" }).outcome).toBe("ignored:unknown");
  });
});

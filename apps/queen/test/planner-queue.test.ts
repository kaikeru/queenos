/**
 * WP1.11 planner integration: the merge queue driven through TrainPlanner.
 *
 * The planner's QUEUE hooks (WP1.2):
 * - `TrainPlanner.mergeResult(r: MergeResult): PlanResult`, with buildResult's
 *   guards (unknown → ignored:unknown, terminal car → ignored:stale, car not
 *   BUILDING → ignored:duplicate), delegating to `queue.mergeResult`;
 * - `TrainPlanner.landResult(r)` on a QUEUE car delegating to `queue.carLanded`
 *   (members MERGED with one landedSha, forks deleted, previews torn down);
 * - `PlanResult.landed?: { sha: string; trainIds: string[] }`: the members the
 *   DO hands to the release planner (`rp.landed`);
 * - `fail()` on a QUEUE car → `queue.carFailed`; `maybeLand()` → `queue.formCars`;
 * - `PlannerContext.queue?: QueueOptions` (settings + injectable hooks) and `PlannerContext.priorityOf?`.
 */
import { describe, expect, it } from "vitest";
import type { MergeResult } from "@queenos/queen-types";
import { TrainPlanner, type Effect, type PromptRecord, type TrainRecord } from "../src/train/planner";

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
function hive(carPhase: TrainRecord["phase"], carOver: Partial<TrainRecord> = {}) {
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
    ...carOver,
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

describe("planner ↔ merge queue", () => {
  it("a 4-member car lands: 4 BUILD trains MERGED with one landedSha, forks deleted, previews torn down, rp.landed gets the members", () => {
    const r = hive("LANDING").planner().landResult({ trainId: "K1", landed: true, mainSha: SHA("e"), summary: "" });
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
    const first = h.planner().mergeResult(result);
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
    expect(after.mergeResult(result).outcome).toBe("ignored:duplicate");

    const ejected = first.trains.map((t) => (t.trainId === "K1" ? { ...t, phase: "EJECTED" as const } : t));
    const stale = new TrainPlanner({ prompts: [], trains: ejected, maxTrainSeq: 10, maxPromptSeq: 4 }, { namespace: "hive", now: 3000, newId: () => "y" });
    expect(stale.mergeResult(result).outcome).toBe("ignored:stale");
    expect(stale.mergeResult({ ...result, trainId: "nope" }).outcome).toBe("ignored:unknown");
  });
});

describe("planner ↔ merge queue: infrastructure", () => {
  it("a car whose integration gate could not run (cause infra) is re-deployed and re-gated, not bisected; members stay aboard", () => {
    const r = hive("TESTING").planner().trainResult({ trainId: "K1", passed: false, summary: "Gatekeeper could not inspect the push: HTTP Error: 503 Service Unavailable", cause: "infra" });
    expect(r.outcome).toBe("applied");
    const byId = new Map(r.trains.map((t) => [t.trainId, t]));
    expect(byId.get("K1")).toMatchObject({ phase: "DEPLOYING", deployState: "FAILED", deployIssuedAt: 1000 });
    for (const id of ["A", "B", "C", "D"]) expect(byId.get(id)?.phase ?? "PASSED").toBe("PASSED");
    expect(r.executorLost).toBeUndefined();
    expect(r.prompts.every((p) => p.attempts === 0)).toBe(true);
  });

  it("a car gate VERDICT (no cause) still bisects", () => {
    const r = hive("TESTING").planner().trainResult({ trainId: "K1", passed: false, summary: "smoke failed on /health" });
    expect(r.trains.find((t) => t.trainId === "K1")).toMatchObject({ phase: "EJECTED" });
  });

  const infraMerge = (over: Partial<MergeResult> = {}): MergeResult => ({
    trainId: "K1", ok: false, cause: "infra", merged: [], conflicts: [], fastForward: false,
    summary: "Merge drone failed: HttpError: HTTP Error: 503 Service Unavailable", ...over,
  });
  const dispatches = (effects: Effect[]) => effects.filter((e): e is Extract<Effect, { type: "dispatchDrone" }> => e.type === "dispatchDrone");

  it("a MERGE drone that hit transient infra re-dispatches the SAME car: no eject, no supersede, members stay aboard, nothing charged", () => {
    const r = hive("BUILDING").planner().mergeResult(infraMerge());
    expect(r.outcome).toBe("applied");
    const byId = new Map(r.trains.map((t) => [t.trainId, t]));
    expect(byId.get("K1")).toMatchObject({ phase: "BUILDING", droneAttempt: 2 });
    for (const id of ["A", "B", "C", "D"]) expect(byId.get(id)?.carId ?? "K1").toBe("K1"); // untouched (or unchanged)
    for (const id of ["A", "B", "C", "D"]) expect(byId.get(id)?.phase ?? "PASSED").toBe("PASSED");
    expect(dispatches(r.effects).map((e) => [e.trainId, e.task.action, e.attempt])).toEqual([["K1", "MERGE", 2]]);
    const [merge] = dispatches(r.effects);
    expect(merge!.task).toMatchObject({ trainId: "K1", action: "MERGE", role: "LANDER", baseRef: "main" });
    expect(merge!.task.members?.map((m) => m.trainId)).toEqual(["A", "B", "C", "D"]);
    // Not confirmed dispatched until the DO's create succeeds: reconcile re-sends it otherwise.
    expect(r.trains.find((t) => t.trainId === "K1")).toMatchObject({ dispatched: false });
    expect(r.executorLost).toBeUndefined();
    expect(r.prompts.every((p) => p.attempts === 0 && p.status === "IN_TRAIN")).toBe(true);
  });

  it("an infra MERGE report from an older attempt is stale; a plain ok:false still takes the old path (eject + pool)", () => {
    const stale = hive("BUILDING").planner().mergeResult(infraMerge({ commandId: "K1-merge-1-nope" }));
    expect(stale.outcome).toBe("ignored:stale");
    const plain = hive("BUILDING").planner().mergeResult(infraMerge({ cause: undefined }));
    expect(plain.trains.find((t) => t.trainId === "K1")).toMatchObject({ phase: "EJECTED" });
  });

  it("infra MERGE retries are bounded: past MAX_COMMAND_ATTEMPTS the car takes the infra-exhausted path (EJECTED, members back to the pool)", () => {
    const first = hive("BUILDING").planner().mergeResult(infraMerge());
    expect(first.trains.find((t) => t.trainId === "K1")).toMatchObject({ phase: "BUILDING", droneAttempt: 2 });
    const r = hive("BUILDING", { droneAttempt: 3 }).planner().mergeResult(infraMerge());
    expect(r.trains.find((t) => t.trainId === "K1")).toMatchObject({ phase: "EJECTED" });
    for (const id of ["A", "B", "C", "D"]) expect(r.trains.find((t) => t.trainId === id)).toMatchObject({ carId: null });
    expect(r.prompts.every((p) => p.attempts === 0)).toBe(true);
  });

  it("a LANDER that hit transient infra re-dispatches the same car's lander (no eject); NOT_FAST_FORWARD (no cause) still fails the car", () => {
    const retried = hive("LANDING").planner().landResult({ trainId: "K1", landed: false, cause: "infra", summary: "Lander failed: HttpError: HTTP Error: 503 Service Unavailable" });
    expect(retried.outcome).toBe("applied");
    expect(retried.trains.find((t) => t.trainId === "K1")).toMatchObject({ phase: "LANDING", droneAttempt: 2 });
    expect(dispatches(retried.effects).map((e) => [e.trainId, e.task.action, e.attempt])).toEqual([["K1", "LAND", 2]]);
    for (const id of ["A", "B", "C", "D"]) expect(retried.trains.find((t) => t.trainId === id)?.carId ?? "K1").toBe("K1");

    const nff = hive("LANDING").planner().landResult({ trainId: "K1", landed: false, summary: "hive/main moved: not a fast-forward." });
    expect(nff.trains.find((t) => t.trainId === "K1")).toMatchObject({ phase: "EJECTED" });
  });
});

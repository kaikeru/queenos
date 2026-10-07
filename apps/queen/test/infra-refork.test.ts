/**
 * Cars retire after ONE infra round and re-board a fresh fork (sick Artifacts repos).
 *
 * An Artifacts repo can answer smart-HTTP with 503s for 40 s to 7+ min right after a push, and forks of
 * it inherit that; a fresh fork of the same content works at once. So a merge-queue car whose preview
 * deploy, integration gate or MERGE drone reports infra is not retried against the same repo: it is
 * retired, its members re-board a fresh car, and that car does not stack on a suspect car ahead.
 * BUILD trains (and race candidates) keep MAX_INFRA_ATTEMPTS.
 */
import { describe, expect, it } from "vitest";
import type { MergeResult } from "@queenos/queen-types";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_INFRA_ATTEMPTS,
  TrainPlanner,
  UNDISPATCHED_RETRY_MS,
  forkOverdue,
  watchdogDeadline,
  type Effect,
  type PlanResult,
  type PromptRecord,
  type TrainRecord,
} from "../src/train/planner";
import { CAR_INFRA_FAILURES_BEFORE_LOST, CAR_INFRA_RETIREMENTS_BEFORE_LOST, carFailed, type QueueContext } from "../src/train/queue";

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
    deployIssuedAt: 0,
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

function car(trainId: string, seq: number, members: TrainRecord[], over: Partial<TrainRecord> = {}, ahead: string[] = []): TrainRecord {
  return base(trainId, {
    lane: "QUEUE",
    seq,
    promptId: members[0]!.promptId,
    members: members.map((m) => m.trainId),
    includedPrompts: [...ahead, ...members.map((m) => m.promptId)],
    phase: "TESTING",
    headSha: SHA("c"),
    ...over,
  });
}

/** A hive with the merge queue on; state persists across runs (each run is a fresh planner, as in the DO). */
class Hive {
  readonly trains = new Map<string, TrainRecord>();
  readonly prompts = new Map<string, PromptRecord>();
  now = 1000;
  carInfraFailures = 0;
  paused = false;
  private n = 0;
  last!: PlanResult;

  constructor(trains: TrainRecord[]) {
    for (const t of trains) this.trains.set(t.trainId, t);
    let seq = 0;
    for (const t of trains) if (t.lane !== "QUEUE") this.prompts.set(t.promptId, prompt(t.promptId, ++seq));
  }

  run(fn: (p: TrainPlanner) => PlanResult): PlanResult {
    const p = new TrainPlanner(
      { prompts: [...this.prompts.values()], trains: [...this.trains.values()], maxTrainSeq: Math.max(...[...this.trains.values()].map((t) => t.seq)), maxPromptSeq: this.prompts.size },
      {
        namespace: "hive",
        now: this.now,
        newId: () => `N${++this.n}`,
        queue: { settings: { maxQueueBatch: 4, maxQueueDepth: 3 }, carInfraFailures: this.carInfraFailures, paused: this.paused },
      },
    );
    const r = fn(p);
    for (const t of r.trains) this.trains.set(t.trainId, t);
    for (const pr of r.prompts) this.prompts.set(pr.promptId, pr);
    if (r.carInfraFailures !== undefined) this.carInfraFailures = r.carInfraFailures;
    if (r.executorLost) this.paused = true;
    this.last = r;
    return r;
  }

  get(id: string): TrainRecord {
    return this.trains.get(id)!;
  }

  /** Active cars other than `except`. */
  cars(except: string[] = []): TrainRecord[] {
    return [...this.trains.values()].filter((t) => t.lane === "QUEUE" && t.phase !== "EJECTED" && t.phase !== "MERGED" && !except.includes(t.trainId));
  }
}

const forks = (effects: Effect[]) =>
  effects.flatMap((e) => (e.type === "provision" && e.command.op === "FORK" ? [{ trainId: e.trainId, source: e.command.sourceRepo }] : []));
const gateInfra = (trainId: string) => ({ trainId, passed: false, summary: "Gatekeeper could not inspect the push: HTTP Error: 503 Service Unavailable", cause: "infra" as const });
const mergeInfra = (trainId: string): MergeResult => ({
  trainId, ok: false, cause: "infra", merged: [], conflicts: [], fastForward: false, summary: "Merge drone failed: HttpError: HTTP Error: 503 Service Unavailable",
});

/** Two passed members aboard car K1 (seq 10, forked from main). */
function oneCar(carOver: Partial<TrainRecord> = {}) {
  const a = base("A", { seq: 1, passedSeq: 1, carId: "K1" });
  const b = base("B", { seq: 2, passedSeq: 2, carId: "K1" });
  return new Hive([a, b, car("K1", 10, [a, b], carOver)]);
}

describe("(a) a car retires after one infra round; its members re-board a fresh car", () => {
  it("gate infra: K1 retired (not re-deployed / re-gated), A and B board a new car forked from main", () => {
    const h = oneCar();
    const r = h.run((p) => p.trainResult(gateInfra("K1")));
    expect(r.outcome).toBe("applied");
    expect(h.get("K1")).toMatchObject({ phase: "EJECTED" });
    expect(h.get("K1").reason).toMatch(/^retired on infra after 1 round; 2 members re-board a fresh car: gate could not run: .*503/);
    // No re-deploy of K1's preview; its preview is torn down and fork deleted.
    expect(r.effects.some((e) => e.type === "deploy" && e.command.op === "DEPLOY")).toBe(false);
    const [fresh] = h.cars();
    expect(fresh).toMatchObject({ members: ["A", "B"], lane: "QUEUE", forkState: "PENDING", forkSource: "hive" });
    expect(h.get("A").carId).toBe(fresh!.trainId);
    expect(h.get("B").carId).toBe(fresh!.trainId);
    expect(forks(r.effects)).toEqual([{ trainId: fresh!.trainId, source: "hive" }]);
    expect([...h.prompts.values()].every((p) => p.attempts === 0)).toBe(true);
    expect(r.carInfraFailures).toBe(1);
    expect(r.executorLost).toBeUndefined();
    const summaries = r.events.map((e) => e.summary);
    expect(summaries).toContain(
      "car K1 retired on infra after 1 round; 2 members re-board a fresh car (infra streak 1/9): gate could not run: Gatekeeper could not inspect the push: HTTP Error: 503 Service Unavailable",
    );
  });

  it("MERGE infra: the drone is not re-dispatched against the same repo; the car retires and the members re-board", () => {
    const h = oneCar({ phase: "BUILDING", headSha: null, deployState: "NONE", deployCommandId: null, previewUrl: null, dispatched: true });
    const r = h.run((p) => p.mergeResult(mergeInfra("K1")));
    expect(h.get("K1")).toMatchObject({ phase: "EJECTED", droneAttempt: 1 });
    expect(r.effects.some((e) => e.type === "dispatchDrone")).toBe(false);
    expect(h.cars()).toHaveLength(1);
    expect(h.cars()[0]).toMatchObject({ members: ["A", "B"], forkSource: "hive" });
  });

  it("a retryable preview deploy failure on a car also retires it (no parked backoff)", () => {
    const h = oneCar({ phase: "DEPLOYING", deployState: "PENDING" });
    h.run((p) => p.deployResult({ commandId: "K1-deploy-1", op: "DEPLOY", environment: "preview", trainId: "K1", ok: false, retryable: true, summary: "503" }));
    expect(h.get("K1").phase).toBe("EJECTED");
    expect(h.cars()[0]).toMatchObject({ members: ["A", "B"] });
  });

  it("a LANDER infra failure still re-dispatches the same car (it already passed its gate)", () => {
    const h = oneCar({ phase: "LANDING", dispatched: true });
    h.run((p) => p.landResult({ trainId: "K1", landed: false, cause: "infra", summary: "Lander failed: 503" }));
    expect(h.get("K1")).toMatchObject({ phase: "LANDING", droneAttempt: 2 });
  });

  it("the watchdog bounds a car's gate: no verdict within COMMAND_TIMEOUT_MS of the preview deploy retires the car", () => {
    const h = oneCar({ deployIssuedAt: 1000 });
    // The alarm is armed for it.
    expect(watchdogDeadline([...h.trains.values()], DEFAULT_COMMAND_TIMEOUT_MS, h.now)).toBe(1000 + DEFAULT_COMMAND_TIMEOUT_MS);
    h.now = 1000 + DEFAULT_COMMAND_TIMEOUT_MS - 1;
    h.run((p) => p.reconcile());
    expect(h.get("K1").phase).toBe("TESTING");
    h.now += 1;
    h.run((p) => p.reconcile());
    expect(h.get("K1").phase).toBe("EJECTED");
    expect(h.get("K1").reason).toMatch(/^retired on infra after 1 round; .*integration gate did not report within 10 min/);
    expect(h.cars()[0]).toMatchObject({ members: ["A", "B"] });
  });
});

describe("(e) late reports for a retired car are stale and cannot touch its replacement", () => {
  it("a late gate PASS / FAIL / infra and a late MERGE report for K1 are ignored; the replacement car is unchanged", () => {
    const h = oneCar();
    h.run((p) => p.trainResult(gateInfra("K1")));
    const fresh = h.cars()[0]!;
    const before = structuredClone(fresh);
    expect(h.run((p) => p.trainResult({ trainId: "K1", passed: true, summary: "ok", commitSha: SHA("c") })).outcome).toBe("ignored:stale");
    expect(h.run((p) => p.trainResult({ trainId: "K1", passed: false, summary: "smoke red" })).outcome).toBe("ignored:stale");
    expect(h.run((p) => p.trainResult(gateInfra("K1"))).outcome).toBe("ignored:stale");
    expect(h.run((p) => p.mergeResult({ ...mergeInfra("K1"), ok: true, cause: undefined, merged: ["A", "B"], headSha: SHA("d") })).outcome).toBe("ignored:stale");
    expect(h.get(fresh.trainId)).toEqual(before);
    expect(h.get("A").carId).toBe(fresh.trainId);
    expect(h.carInfraFailures).toBe(1);
    // A verdict for the replacement before it was even deployed is premature, never a pass.
    expect(h.run((p) => p.trainResult({ trainId: fresh.trainId, passed: true, summary: "ok" })).outcome).toBe("ignored:premature");
  });
});

describe("(b) build trains keep MAX_INFRA_ATTEMPTS", () => {
  it("a BUILD train's gate infra parks it for a re-deploy until attempt MAX_INFRA_ATTEMPTS, then EXECUTOR_LOST on the item", () => {
    for (let n = 1; n <= MAX_INFRA_ATTEMPTS; n++) {
      const h = new Hive([base("T", { phase: "TESTING", deployCommandId: `T-deploy-${n}` })]);
      const r = h.run((p) => p.trainResult(gateInfra("T")));
      if (n < MAX_INFRA_ATTEMPTS) {
        expect(h.get("T")).toMatchObject({ phase: "DEPLOYING", deployState: "FAILED" });
        expect(r.events.some((e) => new RegExp(`train T infra retry ${n}/${MAX_INFRA_ATTEMPTS - 1}`).test(e.summary))).toBe(true);
      } else {
        expect(h.get("T").phase).toBe("EJECTED");
        expect(h.get("T").reason).toMatch(/^failed on infrastructure: gate could not run: .*\(after 3 attempts\)$/);
        expect(r.infraFailed).toEqual([{ promptId: "p-T", summary: expect.stringContaining("gate could not run") }]);
      }
    }
  });
});

describe("(c) EXECUTOR_LOST still means a sustained outage", () => {
  const ctx = (carInfraFailures: number, paused = false): QueueContext => ({
    namespace: "hive", now: 0, newId: () => "x", settings: { maxQueueBatch: 4, maxQueueDepth: 3 }, priorityOf: () => 2, carInfraFailures, paused,
  });
  const lone = (i: number) => {
    const m = base(`M${i}`, { seq: i, passedSeq: i, carId: `K${i}` });
    return { m, k: car(`K${i}`, 100 + i, [m]) };
  };

  it(`retired cars: ${CAR_INFRA_RETIREMENTS_BEFORE_LOST} in a row (= ${CAR_INFRA_FAILURES_BEFORE_LOST} cars × ${MAX_INFRA_ATTEMPTS} rounds) open it; one success resets the streak`, () => {
    expect(CAR_INFRA_RETIREMENTS_BEFORE_LOST).toBe(CAR_INFRA_FAILURES_BEFORE_LOST * MAX_INFRA_ATTEMPTS);
    let streak = 0;
    for (let i = 1; i <= CAR_INFRA_RETIREMENTS_BEFORE_LOST; i++) {
      const { m, k } = lone(i);
      const d = carFailed(k, "503", "infra", [m, k], ctx(streak), { retired: true });
      streak = d.carInfraFailures!;
      expect(!!d.executorLost).toBe(i === CAR_INFRA_RETIREMENTS_BEFORE_LOST);
      if (i === CAR_INFRA_RETIREMENTS_BEFORE_LOST) expect(d.events.at(-1)!.summary).toMatch(/infra streak 9\/9: EXECUTOR_LOST, car formation paused/);
    }
  });

  it(`exhausted cars (lost executor, preview / LANDER spent) still open it at ${CAR_INFRA_FAILURES_BEFORE_LOST}, counting earlier retirements`, () => {
    const { m, k } = lone(1);
    expect(carFailed(k, "lost", "infra", [m, k], ctx(1)).executorLost).toBeUndefined();
    expect(carFailed(k, "lost", "infra", [m, k], ctx(2)).executorLost).toBe(true);
    expect(carFailed(k, "lost", "infra", [m, k], ctx(2), { retired: true }).executorLost).toBeUndefined();
    expect(carFailed(k, "lost", "infra", [m, k], ctx(9, true), { retired: true }).executorLost).toBeUndefined(); // already paused
  });

  it("through the planner: the 9th consecutive retirement pauses formation (no replacement car)", () => {
    const h = oneCar();
    h.carInfraFailures = CAR_INFRA_RETIREMENTS_BEFORE_LOST - 2;
    h.run((p) => p.trainResult(gateInfra("K1")));
    expect(h.last.executorLost).toBeUndefined();
    const fresh = h.cars()[0]!;
    expect(fresh.members).toEqual(["A", "B"]);
    // The fresh car's MERGE hits infra too: 9 in a row.
    h.run((p) => p.provisionResult({ commandId: fresh.forkCommandId!, op: "FORK", trainId: fresh.trainId, ok: true, artifactRepo: fresh.artifactRepo }));
    h.run((p) => p.dispatched(fresh.trainId, "BUILDING"));
    const r = h.run((p) => p.mergeResult(mergeInfra(fresh.trainId)));
    expect(r.executorLost).toBe(true);
    expect(h.carInfraFailures).toBe(CAR_INFRA_RETIREMENTS_BEFORE_LOST);
    expect(h.cars()).toEqual([]);
    expect(h.get("A")).toMatchObject({ phase: "PASSED", carId: null });
  });
});

describe("(d) the replacement car does not fork from a suspect car ahead", () => {
  /** K1 (pushed, TESTING) ahead; K2 stacked on it (forked from K1's repo) with members C, D. */
  function twoCars(k1Over: Partial<TrainRecord> = {}) {
    const a = base("A", { seq: 1, passedSeq: 1, carId: "K1" });
    const c = base("C", { seq: 2, passedSeq: 2, carId: "K2" });
    const d = base("D", { seq: 3, passedSeq: 3, carId: "K2" });
    const k1 = car("K1", 10, [a], k1Over);
    const k2 = car("K2", 11, [c, d], { forkSource: k1.artifactRepo }, k1.includedPrompts);
    return new Hive([a, c, d, k1, k2]);
  }

  it("K2 (forked from K1) retires on infra: its replacement waits for K1, then forks from main once K1 lands", () => {
    const h = twoCars();
    const r = h.run((p) => p.trainResult(gateInfra("K2")));
    expect(h.get("K2").phase).toBe("EJECTED");
    const [fresh] = h.cars(["K1"]);
    expect(fresh).toMatchObject({ members: ["C", "D"], phase: "WAITING_PARENT", forkSource: null, waitForCarSeq: 10 });
    expect(forks(r.effects)).toEqual([]);
    expect(r.events.map((e) => e.summary)).toContain(
      `car ${fresh!.trainId} will not fork from car K1 (a car forked from it failed on infra); it forks from main once K1 has landed`,
    );
    // Persisted: a later run (K2 no longer loaded) still does not stack on K1.
    h.trains.delete("K2");
    h.run((p) => p.reconcile());
    expect(h.get(fresh!.trainId)).toMatchObject({ phase: "WAITING_PARENT" });
    // K1 passes and lands: the replacement forks from hive main.
    h.run((p) => p.trainResult({ trainId: "K1", passed: true, summary: "ok" }));
    expect(h.get("K1").phase).toBe("LANDING");
    const landed = h.run((p) => p.landResult({ trainId: "K1", landed: true, mainSha: SHA("e"), summary: "" }));
    expect(h.get(fresh!.trainId)).toMatchObject({ phase: "BUILDING", forkState: "PENDING", forkSource: "hive" });
    expect(forks(landed.effects)).toEqual([{ trainId: fresh!.trainId, source: "hive" }]);
  });

  it("if K1 fails instead, the waiting replacement is superseded and its members re-board", () => {
    const h = twoCars();
    h.run((p) => p.trainResult(gateInfra("K2")));
    const [fresh] = h.cars(["K1"]);
    h.run((p) => p.trainResult({ trainId: "K1", passed: false, summary: "smoke red" }));
    expect(h.get(fresh!.trainId).phase).toBe("EJECTED");
    const next = h.cars().find((c) => (c.members ?? []).includes("C"));
    expect(next).toMatchObject({ forkSource: "hive", forkState: "PENDING" });
  });

  it("a healthy car ahead is still stacked on; one whose LANDER is on a retry attempt is not", () => {
    const waiting = () => base("P", { seq: 5, passedSeq: 5 });
    const healthy = new Hive([base("A", { seq: 1, passedSeq: 1, carId: "K1" }), car("K1", 10, [base("A", { seq: 1 })]), waiting()]);
    const r1 = healthy.run((p) => p.reconcile());
    expect(forks(r1.effects)).toEqual([{ trainId: "N1", source: "hive-train-K1" }]);

    const retrying = new Hive([
      base("A", { seq: 1, passedSeq: 1, carId: "K1" }),
      car("K1", 10, [base("A", { seq: 1 })], { phase: "LANDING", dispatched: true, droneAttempt: 2, droneIssuedAt: 1000 }),
      waiting(),
    ]);
    const r2 = retrying.run((p) => p.reconcile());
    expect(forks(r2.effects)).toEqual([]);
    expect(retrying.get("N1")).toMatchObject({ phase: "WAITING_PARENT", waitForCarSeq: 10 });
  });
});

describe("(f) prod K48/K49/K50: a retired car with a PASSED car stacked on it", () => {
  /** K48 (1 member A, forked from main) DEPLOYING its preview; K49 (1 member B) stacked on K48, PASSED. */
  function stacked() {
    const a = base("A", { seq: 1, passedSeq: 1, carId: "K48" });
    const b = base("B", { seq: 2, passedSeq: 2, carId: "K49" });
    const k48 = car("K48", 10, [a], { phase: "DEPLOYING", deployState: "PENDING", previewUrl: null, deployIssuedAt: 900 });
    const k49 = car("K49", 11, [b], { phase: "PASSED", forkSource: k48.artifactRepo }, k48.includedPrompts);
    return new Hive([a, b, k48, k49]);
  }

  it("K48's preview deploy fails on infra: K48 retired, K49 superseded, A and B re-board one car that forks from main in the same plan", () => {
    const h = stacked();
    const r = h.run((p) => p.deployResult({ commandId: "K48-deploy-1", op: "DEPLOY", environment: "preview", trainId: "K48", ok: false, retryable: true, summary: "Artifacts 503" }));
    expect(h.get("K48").phase).toBe("EJECTED");
    expect(h.get("K49")).toMatchObject({ phase: "EJECTED", reason: "superseded: car K48 failed" });
    const fresh = h.cars();
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ members: ["A", "B"], forkState: "PENDING", forkSource: "hive" });
    expect(forks(r.effects)).toEqual([{ trainId: fresh[0]!.trainId, source: "hive" }]);
  });
});

describe("(g) liveness: a WAITING_PARENT train whose wait is over is never stranded", () => {
  const waitingCar = (over: Partial<TrainRecord> = {}) =>
    car("K50", 20, [base("A", { seq: 1 })], { phase: "WAITING_PARENT", forkState: "NONE", forkSource: null, forkCommandId: null, deployState: "NONE", deployCommandId: null, previewUrl: null, headSha: null, ...over });

  it("forkOverdue / watchdogDeadline: a car with nothing ahead, or whose waitForCarSeq car is gone, is due within UNDISPATCHED_RETRY_MS", () => {
    const a = base("A", { seq: 1, passedSeq: 1, carId: "K50" });
    const lone = waitingCar();
    expect(forkOverdue(lone, [a, lone])).toBe(true);
    expect(watchdogDeadline([a, lone], DEFAULT_COMMAND_TIMEOUT_MS, 5000)).toBe(5000 + UNDISPATCHED_RETRY_MS);
    // Waiting for K49 (seq 11), which is superseded (EJECTED): over.
    const k49 = car("K49", 11, [base("B", { seq: 2 })], { phase: "EJECTED", reason: "superseded: car K48 failed" });
    const waits = waitingCar({ waitForCarSeq: 11 });
    expect(forkOverdue(waits, [a, k49, waits])).toBe(true);
    // Still waiting: K49 active, or a car ahead that has not pushed.
    expect(forkOverdue(waits, [a, { ...k49, phase: "TESTING" }, waits])).toBe(false);
    const ahead = car("K49", 11, [base("B", { seq: 2 })], { phase: "BUILDING", dispatched: true, droneIssuedAt: 0 });
    expect(forkOverdue(lone, [a, ahead, lone])).toBe(false);
    expect(watchdogDeadline([a, ahead, lone], DEFAULT_COMMAND_TIMEOUT_MS, 5000)).toBe(DEFAULT_COMMAND_TIMEOUT_MS); // K49's MERGE drone clock only
    // A BUILD rework waiting on a car that is gone is due as well.
    const rework = base("R", { seq: 3, phase: "WAITING_PARENT", forkState: "NONE", forkSource: null, waitForCarSeq: 11, deployState: "NONE", deployCommandId: null, previewUrl: null });
    expect(forkOverdue(rework, [rework, k49])).toBe(true);
    expect(forkOverdue(rework, [rework, { ...k49, phase: "PASSED" }])).toBe(false);
  });

  it("the alarm forks a stranded car from main (missed kick)", () => {
    const a = base("A", { seq: 1, passedSeq: 1, carId: "K50" });
    const h = new Hive([a, waitingCar()]);
    const r = h.run((p) => p.reconcile());
    expect(forks(r.effects)).toEqual([{ trainId: "K50", source: "hive" }]);
  });
});

describe("(h) a conflict / integration rework waiting on a car that is SUPERSEDED (not failed) forks in the same plan", () => {
  it("K0 fails its gate; K1 (stacked, carrying K0's prompts) is superseded; the rework that waited for K1 forks from main at once", () => {
    const a = base("A", { seq: 1, passedSeq: 1, carId: "K0" });
    const c = base("C", { seq: 2, passedSeq: 2, carId: "K1" });
    const k0 = car("K0", 10, [a]);
    const k1 = car("K1", 11, [c], { phase: "PASSED", forkSource: k0.artifactRepo }, k0.includedPrompts);
    // Item D's conflict rework waits for every car up to K1.
    const d = base("D", { seq: 3, phase: "WAITING_PARENT", forkState: "NONE", forkSource: null, forkCommandId: null, waitForCarSeq: 11, deployState: "NONE", deployCommandId: null, previewUrl: null, headSha: null, action: "REWORK" });
    for (const infra of [false, true]) {
      const h = new Hive([a, c, k0, k1, d]);
      const r = h.run((p) => (infra ? p.trainResult(gateInfra("K0")) : p.trainResult({ trainId: "K0", passed: false, summary: "smoke red" })));
      expect(h.get("K1")).toMatchObject({ phase: "EJECTED", reason: "superseded: car K0 failed" });
      expect(h.get("D")).toMatchObject({ phase: "BUILDING", forkState: "PENDING", forkSource: "hive" });
      expect(forks(r.effects)).toContainEqual({ trainId: "D", source: "hive" });
    }
  });
});


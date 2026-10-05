/**
 * Merge queue (v2 design §2.3.4): the QUEUE lane of the train planner.
 * Pure: no I/O, no clock, no randomness. WP0 seam; WP1.11 implements it and
 * WP1.2 calls it from TrainPlanner (wherever v1 called maybeLand(), and from
 * fail() / mergeResult() / landResult() for QUEUE-lane trains).
 *
 * Each function reads the hive's trains (BUILD and QUEUE lanes, as loaded by
 * the planner) and returns a QueueDecision: patches to existing trains, new
 * cars for the planner to materialise (it owns seq, fork names and commands),
 * BUILD members to fail(), effects and events. The planner applies them
 * through setTrain(), so its dirty tracking, watchdog clocks and broadcasts
 * are unchanged.
 */
import type { EventDraft, MergeConflict, MergeResult } from "@queenos/queen-types";
import type { Effect, TrainRecord } from "./planner";

export interface QueueSettings {
  /** Members per car (GUARDRAIL_DEFAULTS.maxQueueBatch = 4; cut line 6 sets 1). */
  maxQueueBatch: number;
  /** Active speculative cars (GUARDRAIL_DEFAULTS.maxQueueDepth = 3). */
  maxQueueDepth: number;
}

export interface QueueContext {
  namespace: string;
  now: number;
  newId: () => string;
  settings: QueueSettings;
  /** Item priority of a BUILD train's prompt (0..3; member order is priority, then passedSeq). */
  priorityOf: (promptId: string) => number;
  /** Consecutive infra-failed cars so far (hive_settings.car_infra_failures). */
  carInfraFailures: number;
  /** Car formation is paused (an open EXECUTOR_LOST on the hive). */
  paused: boolean;
}

/** A change to an existing train, applied by the planner with setTrain(). */
export interface TrainPatch {
  trainId: string;
  patch: Partial<TrainRecord>;
}

/** A car for the planner to create as a QUEUE-lane train. */
export interface CarDraft {
  carId: string;
  /** Member BUILD trainIds, in merge order. */
  members: string[];
  /** Every car ahead's prompts plus its members' prompts (v1 cumulative semantics). */
  includedPrompts: string[];
  /** The car it forks from once that car has pushed; null = hive main. */
  predecessorCarId: string | null;
  /** Set on a bisect half: the failed car it came from. */
  bisectOf: string | null;
}

/** A BUILD member to fail() (REWORK), with the Scribe summary the queue wrote for it. */
export interface MemberFailure {
  trainId: string;
  /** `"Merge conflict: …"` or `"Passed alone, fails integrated on main@<sha>: …"`. */
  summary: string;
  /** conflict → `conflicts + 1` (D7); integration → `attempts + 1`. */
  cause: "conflict" | "integration";
  /** The rework stays WAITING_PARENT until every car with seq ≤ this is terminal. */
  waitForCarSeq: number;
  conflict: MergeConflict | null;
  /** Paths to add to the item's claims (source "conflict"). */
  claimPaths: string[];
}

export interface QueueDecision {
  patches: TrainPatch[];
  cars: CarDraft[];
  failures: MemberFailure[];
  effects: Effect[];
  events: EventDraft[];
  /** New hive_settings.car_infra_failures, when it changed. */
  carInfraFailures?: number;
  /** Open EXECUTOR_LOST (subject hive) and pause car formation (3 consecutive infra failures). */
  executorLost?: boolean;
}

/** Why a car failed: a gate verdict (bisect / integration rework) or infrastructure (members back to the pool). */
export type CarFailureCause = "gate" | "infra";

/**
 * Board passed BUILD trains (`carId = null`) onto new cars while fewer than
 * `maxQueueDepth` cars are active: pinned bisect halves first, then by item
 * priority and `passedSeq`, up to `maxQueueBatch` members each.
 */
export function formCars(trains: readonly TrainRecord[], ctx: QueueContext): QueueDecision {
  void trains;
  void ctx;
  throw new Error("not implemented");
}

/**
 * The MERGE drone's report for `car`. Conflicting members leave this car and
 * every later car (rewriteMembers) and are failed with a conflict summary;
 * `merged = []` ejects the car; `fastForward` sends it straight to PASSED.
 * The planner has already applied its command-id, stale and duplicate guards.
 */
export function mergeResult(car: TrainRecord, r: MergeResult, trains: readonly TrainRecord[], ctx: QueueContext): QueueDecision {
  void car;
  void r;
  void trains;
  void ctx;
  throw new Error("not implemented");
}

/**
 * A car failed (gate, preview, MERGE or LANDER exhausted): eject it and every
 * later car whose includedPrompts overlap it, return their members to the
 * pool, then bisect (gate, > 1 member), fail the single member (gate, 1
 * member), or count an infra failure (no bisect).
 */
export function carFailed(
  car: TrainRecord,
  summary: string,
  cause: CarFailureCause,
  trains: readonly TrainRecord[],
  ctx: QueueContext,
): QueueDecision {
  void car;
  void summary;
  void cause;
  void trains;
  void ctx;
  throw new Error("not implemented");
}

/**
 * The LANDER pushed `car` to hive main: the car and each member BUILD train
 * become MERGED with `landedSha`; member forks are deleted and previews torn
 * down. The planner hands `members` to the release planner (`rp.landed`).
 */
export function carLanded(car: TrainRecord, landedSha: string, trains: readonly TrainRecord[], ctx: QueueContext): QueueDecision {
  void car;
  void landedSha;
  void trains;
  void ctx;
  throw new Error("not implemented");
}

/**
 * Remove `removed` member trainIds (and their prompts) from the car with
 * `fromCarSeq` and every later active car (all still WAITING_PARENT), and clear
 * the removed members' `carId`.
 */
export function rewriteMembers(trains: readonly TrainRecord[], fromCarSeq: number, removed: readonly string[]): TrainPatch[] {
  void trains;
  void fromCarSeq;
  void removed;
  throw new Error("not implemented");
}

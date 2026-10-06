/**
 * Merge queue (v2 design §2.3.4): the QUEUE lane of the train planner.
 * Pure: no I/O, no clock, no randomness. WP1.11 implements it and WP1.2 calls
 * it from TrainPlanner (wherever v1 called maybeLand(), and from fail() /
 * mergeResult() / landResult() for QUEUE-lane trains).
 *
 * Each function reads the hive's trains (BUILD and QUEUE lanes, as loaded by
 * the planner) and returns a QueueDecision: patches to existing trains, new
 * cars for the planner to materialise (it owns seq, fork names and commands),
 * BUILD members to fail(), effects and events. The planner applies them
 * through setTrain(), so its dirty tracking, watchdog clocks and broadcasts
 * are unchanged.
 *
 * Division of labour with the planner:
 * - The queue emits the commands it can fully specify: fork DELETEs and
 *   preview TEARDOWNs of the trains it ejects or merges (the patch carries the
 *   new `forkState` / `deleteCommandId` / `deployState` / `teardownCommandId`,
 *   and the effect carries the same command id). The planner must not eject or
 *   delete those trains again.
 * - The planner issues everything that needs its private state: a new car's
 *   FORK (materialise the CarDraft as a WAITING_PARENT QUEUE train, then
 *   scheduleFork), the preview DEPLOY of a car that `mergeResult` moved to
 *   DEPLOYING (`deployPreview`), successor forks once a car pushed
 *   (`scheduleSuccessor`), prompt statuses, and `fail()` of each MemberFailure.
 * - A car's own fork delete / preview teardown on landing stays with the
 *   planner's v1 landResult path; `carLanded` handles the members.
 *
 * Bisect pins. A pending bisect half is persisted on its BUILD members, which
 * wait in the pool (`carId = null`) with `bisectOf = "<failedCarId>#<half>"`
 * (the v11 `bisect_of` column; on a QUEUE car the same column holds the plain
 * failed car id). `formCars` boards pinned groups first, each as its own car,
 * and clears the pin.
 */
import type { EventDraft, MergeConflict, MergeResult } from "@queenos/queen-types";
import { nextCommandId, traceFor, type Effect, type TrainPhase, type TrainRecord } from "./planner";

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
  /** At most one patch per train (merged), in first-touched order. */
  patches: TrainPatch[];
  /** New cars, in seq order (each stacked on the previous one). */
  cars: CarDraft[];
  failures: MemberFailure[];
  /** Fork DELETEs and preview TEARDOWNs of trains this decision ejected or merged. */
  effects: Effect[];
  events: EventDraft[];
  /** New hive_settings.car_infra_failures, when it changed. */
  carInfraFailures?: number;
  /** Open EXECUTOR_LOST (subject hive) and pause car formation (3 consecutive infra failures). */
  executorLost?: boolean;
}

/** Why a car failed: a gate verdict (bisect / integration rework) or infrastructure (members back to the pool). */
export type CarFailureCause = "gate" | "infra";

/** Consecutive infra-failed cars that open EXECUTOR_LOST and pause car formation. */
export const CAR_INFRA_FAILURES_BEFORE_LOST = 3;

const ACTOR = "queen";
const MAX_SUMMARY = 500;
const TERMINAL: ReadonlySet<TrainPhase> = new Set(["MERGED", "EJECTED"]);

// ── helpers ─────────────────────────────────────────────────────────────

export function isCar(t: TrainRecord): boolean {
  return t.lane === "QUEUE";
}

function active(t: TrainRecord): boolean {
  return !TERMINAL.has(t.phase);
}

/** Active QUEUE cars in seq order. */
export function activeCars(trains: readonly TrainRecord[]): TrainRecord[] {
  return trains.filter((t) => isCar(t) && active(t)).sort((a, b) => a.seq - b.seq);
}

/** The bisect pin of a pooled BUILD train, or null. */
function pinOf(t: TrainRecord): { carId: string; half: number } | null {
  const m = t.bisectOf ? /^(.*)#(\d+)$/.exec(t.bisectOf) : null;
  return m ? { carId: m[1]!, half: Number(m[2]) } : null;
}

export function pinKey(failedCarId: string, half: number): string {
  return `${failedCarId}#${half}`;
}

/** Passed BUILD trains waiting to board (`carId = null`). */
export function waitingToBoard(trains: readonly TrainRecord[]): TrainRecord[] {
  return trains.filter((t) => !isCar(t) && t.phase === "PASSED" && !t.carId);
}

function clip(s: string): string {
  return s.length <= MAX_SUMMARY ? s : `${s.slice(0, MAX_SUMMARY - 1)}…`;
}

function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "unknown";
}

function uniq(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}

/** Accumulates one merged patch per train, and reads trains through the pending patches. */
class Builder {
  private readonly byId = new Map<string, TrainRecord>();
  private readonly patches = new Map<string, Partial<TrainRecord>>();
  readonly cars: CarDraft[] = [];
  readonly failures: MemberFailure[] = [];
  readonly effects: Effect[] = [];
  readonly events: EventDraft[] = [];
  carInfraFailures?: number;
  executorLost?: boolean;

  constructor(
    trains: readonly TrainRecord[],
    private readonly namespace: string,
  ) {
    for (const t of trains) this.byId.set(t.trainId, t);
  }

  /** The train as it will be once this decision is applied. */
  get(trainId: string): TrainRecord | undefined {
    const t = this.byId.get(trainId);
    if (!t) return undefined;
    const p = this.patches.get(trainId);
    return p ? { ...t, ...p } : t;
  }

  patch(trainId: string, patch: Partial<TrainRecord>): void {
    if (!this.byId.has(trainId)) return;
    this.patches.set(trainId, { ...(this.patches.get(trainId) ?? {}), ...patch });
  }

  /** Delete the fork and tear down the preview, when they may exist (the planner's eject rules). */
  cleanUp(trainId: string): void {
    const t = this.get(trainId);
    if (!t) return;
    if (t.forkState === "PENDING" || t.forkState === "READY") {
      const deleteCommandId = nextCommandId(t.trainId, "delete", t.deleteCommandId);
      this.patch(t.trainId, { forkState: "DELETING", deleteCommandId });
      this.effects.push({
        type: "provision",
        trainId: t.trainId,
        command: { op: "DELETE", commandId: deleteCommandId, hive: this.namespace, trainId: t.trainId, repo: t.artifactRepo, trace: traceFor(t, deleteCommandId) },
      });
    }
    if (t.deployCommandId !== null && (t.deployState === "PENDING" || t.deployState === "LIVE" || t.deployState === "FAILED")) {
      const teardownCommandId = nextCommandId(t.trainId, "teardown", t.teardownCommandId);
      this.patch(t.trainId, { deployState: "TEARING_DOWN", teardownCommandId });
      this.effects.push({
        type: "deploy",
        trainId: t.trainId,
        command: { op: "TEARDOWN", commandId: teardownCommandId, hive: this.namespace, environment: "preview", trainId: t.trainId, trace: traceFor(t, teardownCommandId) },
      });
    }
  }

  eject(trainId: string, reason: string): void {
    const t = this.get(trainId);
    if (!t || !active(t)) return;
    this.patch(trainId, { phase: "EJECTED", status: "EJECTED", reason });
    this.cleanUp(trainId);
  }

  event(e: Omit<EventDraft, "actor">): void {
    this.events.push({ actor: ACTOR, ...e, summary: clip(e.summary) });
  }

  build(): QueueDecision {
    return {
      patches: [...this.patches].map(([trainId, patch]) => ({ trainId, patch })),
      cars: this.cars,
      failures: this.failures,
      effects: this.effects,
      events: this.events,
      ...(this.carInfraFailures !== undefined ? { carInfraFailures: this.carInfraFailures } : {}),
      ...(this.executorLost ? { executorLost: true } : {}),
    };
  }
}

function resetInfra(b: Builder, ctx: QueueContext): void {
  if (ctx.carInfraFailures !== 0) b.carInfraFailures = 0;
}

/** Member prompts of a car (from its member trains, else its includedPrompts minus the cars ahead). */
function memberPrompts(car: TrainRecord, trains: readonly TrainRecord[]): string[] {
  const byId = new Map(trains.map((t) => [t.trainId, t]));
  const fromMembers = (car.members ?? []).map((id) => byId.get(id)?.promptId).filter((p): p is string => !!p);
  if (fromMembers.length === (car.members ?? []).length && fromMembers.length > 0) return fromMembers;
  const ahead = new Set(activeCars(trains).filter((c) => c.seq < car.seq).flatMap((c) => c.includedPrompts));
  return uniq([...fromMembers, ...car.includedPrompts.filter((p) => !ahead.has(p))]);
}

// ── formCars ────────────────────────────────────────────────────────────

/**
 * Board passed BUILD trains (`carId = null`) onto new cars while fewer than
 * `maxQueueDepth` cars are active: pinned bisect halves first, then by item
 * priority and `passedSeq`, up to `maxQueueBatch` members each. Each new car
 * stacks on the last active car (or the previous new car), or on main.
 */
export function formCars(trains: readonly TrainRecord[], ctx: QueueContext): QueueDecision {
  const b = new Builder(trains, ctx.namespace);
  if (ctx.paused) return b.build();
  const batch = Math.max(1, ctx.settings.maxQueueBatch);
  const cars = activeCars(trains);
  let depth = cars.length;
  let tail: { carId: string; includedPrompts: string[] } | null = cars.length
    ? { carId: cars.at(-1)!.trainId, includedPrompts: uniq(cars.flatMap((c) => c.includedPrompts)) }
    : null;

  const order = (a: TrainRecord, z: TrainRecord) =>
    ctx.priorityOf(a.promptId) - ctx.priorityOf(z.promptId) ||
    (a.passedSeq ?? Number.MAX_SAFE_INTEGER) - (z.passedSeq ?? Number.MAX_SAFE_INTEGER) ||
    a.seq - z.seq;
  const pool = waitingToBoard(trains).sort(order);

  // Pinned groups, in order of their best member (half 0 before half 1 of the same car).
  const groups = new Map<string, TrainRecord[]>();
  for (const t of pool) {
    const pin = pinOf(t);
    if (!pin) continue;
    const g = groups.get(t.bisectOf!) ?? [];
    g.push(t);
    groups.set(t.bisectOf!, g);
  }
  const pinned = [...groups.entries()].sort(([ka, a], [kz, z]) => {
    const pa = pinOf(a[0]!)!;
    const pz = pinOf(z[0]!)!;
    if (pa.carId === pz.carId) return pa.half - pz.half;
    return order(a[0]!, z[0]!) || (ka < kz ? -1 : 1);
  });
  const free = pool.filter((t) => !pinOf(t));

  const board = (members: TrainRecord[], bisectOf: string | null) => {
    const carId = ctx.newId();
    const prompts = members.map((m) => m.promptId);
    const includedPrompts = uniq([...(tail?.includedPrompts ?? []), ...prompts]);
    b.cars.push({ carId, members: members.map((m) => m.trainId), includedPrompts, predecessorCarId: tail?.carId ?? null, bisectOf });
    for (const m of members) b.patch(m.trainId, { carId, ...(m.bisectOf ? { bisectOf: null } : {}) });
    b.event({
      type: "queue.car",
      trainId: carId,
      summary: `car ${carId}: ${members.length} member${members.length === 1 ? "" : "s"}${bisectOf ? ` (bisect of ${bisectOf})` : ""}${tail ? ` stacked on ${tail.carId}` : " on main"}`,
      data: { carId, members: members.map((m) => m.trainId), prompts, predecessorCarId: tail?.carId ?? null, bisectOf },
    });
    tail = { carId, includedPrompts };
    depth += 1;
  };

  for (const [, group] of pinned) {
    let rest = group;
    while (rest.length && depth < ctx.settings.maxQueueDepth) {
      board(rest.slice(0, batch), pinOf(rest[0]!)!.carId);
      rest = rest.slice(batch);
    }
  }
  let rest = free;
  while (rest.length && depth < ctx.settings.maxQueueDepth) {
    board(rest.slice(0, batch), null);
    rest = rest.slice(batch);
  }
  return b.build();
}

// ── rewriteMembers ──────────────────────────────────────────────────────

/**
 * Remove `removed` member trainIds (and their prompts) from the car with
 * `fromCarSeq` and every later active car (all still WAITING_PARENT), and clear
 * the removed members' `carId`.
 */
export function rewriteMembers(trains: readonly TrainRecord[], fromCarSeq: number, removed: readonly string[]): TrainPatch[] {
  const b = new Builder(trains, "");
  rewriteInto(b, trains, fromCarSeq, removed);
  return b.build().patches;
}

function rewriteInto(b: Builder, trains: readonly TrainRecord[], fromCarSeq: number, removed: readonly string[]): void {
  if (removed.length === 0) return;
  const gone = new Set(removed);
  const byId = new Map(trains.map((t) => [t.trainId, t]));
  const goneMembers = removed.map((id) => byId.get(id)).filter((t): t is TrainRecord => !!t);
  const gonePrompts = new Set(goneMembers.map((t) => t.promptId));
  for (const c of activeCars(trains)) {
    if (c.seq < fromCarSeq) continue;
    const cur = b.get(c.trainId)!;
    const members = (cur.members ?? []).filter((m) => !gone.has(m));
    const includedPrompts = cur.includedPrompts.filter((p) => !gonePrompts.has(p));
    if (members.length !== (cur.members ?? []).length || includedPrompts.length !== cur.includedPrompts.length) {
      b.patch(c.trainId, { members, includedPrompts });
    }
  }
  for (const m of goneMembers) if (m.carId) b.patch(m.trainId, { carId: null });
}

// ── mergeResult ─────────────────────────────────────────────────────────

/** The deterministic Scribe summary of a merge conflict (the rework's instructions). */
export function conflictSummary(c: MergeConflict): string {
  if (c.kind === "missing") {
    return clip(`Merge conflict: your pushed head could not be fetched by the merge queue (missing)${c.summary ? `: ${c.summary}` : ""}. Rebuild your change on top of the current main.`);
  }
  const where = c.paths.length ? c.paths.join(", ") : "the same files";
  return clip(
    `Merge conflict: your change and work that landed ahead of you both edit ${where} (${c.kind}). Re-apply your change on top of the current main and keep both behaviours.`,
  );
}

/**
 * The MERGE drone's report for `car`. Conflicting members leave this car and
 * every later car (rewriteMembers) and are failed with a conflict summary;
 * members neither merged nor conflicting return to the pool with no blame;
 * `merged = []` ejects the car; `fastForward` (exactly one member merged)
 * sends it straight to PASSED, otherwise it goes to DEPLOYING with `headSha`
 * and `baseSha`. `ok: false` is an infra failure (`carFailed(…, "infra")`).
 * The planner has already applied its command-id, stale and duplicate guards.
 *
 * After applying: for a car now DEPLOYING the planner calls deployPreview(car);
 * for a car now DEPLOYING or PASSED it calls scheduleSuccessor(car) (and, for
 * PASSED, maybeLand); then it fail()s each MemberFailure.
 */
export function mergeResult(car: TrainRecord, r: MergeResult, trains: readonly TrainRecord[], ctx: QueueContext): QueueDecision {
  if (!r.ok) return carFailed(car, r.summary || "MERGE drone failed (nothing pushed)", "infra", trains, ctx);
  const b = new Builder(trains, ctx.namespace);
  resetInfra(b, ctx);
  const members = car.members ?? [];
  const isMember = new Set(members);
  const merged = members.filter((m) => r.merged.includes(m));
  const conflicts = r.conflicts.filter((c) => isMember.has(c.trainId) && !merged.includes(c.trainId));
  const removed = members.filter((m) => !merged.includes(m));

  rewriteInto(b, trains, car.seq, removed);
  for (const c of conflicts) {
    const m = b.get(c.trainId);
    if (!m || !active(m)) continue;
    const summary = conflictSummary(c);
    b.failures.push({ trainId: c.trainId, summary, cause: "conflict", waitForCarSeq: car.seq, conflict: c, claimPaths: [...c.paths] });
    b.patch(c.trainId, { conflict: c });
    b.event({
      type: "queue.conflict",
      severity: "warn",
      trainId: c.trainId,
      itemId: m.promptId,
      traceId: m.traceId ?? null,
      summary: `${c.trainId} conflicts in car ${car.trainId}: ${c.paths.join(", ") || c.kind}`,
      data: { carId: car.trainId, kind: c.kind, paths: c.paths },
    });
  }

  if (merged.length === 0) {
    b.eject(car.trainId, "no members merged");
    b.event({ type: "queue.merged", severity: "warn", trainId: car.trainId, summary: `car ${car.trainId}: no members merged; ejected`, data: { merged: [], conflicts: conflicts.length } });
    return b.build();
  }
  const fastForward = r.fastForward && merged.length === 1;
  b.patch(car.trainId, {
    phase: fastForward ? "PASSED" : "DEPLOYING",
    status: "TESTING",
    headSha: r.headSha ?? car.headSha,
    baseSha: r.baseSha ?? car.baseSha,
    dispatched: false,
  });
  b.event({
    type: "queue.merged",
    trainId: car.trainId,
    summary: `car ${car.trainId}: merged ${merged.length}/${members.length}${conflicts.length ? `, ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}` : ""}${fastForward ? " (fast path)" : ""}`,
    data: { merged, conflicts: conflicts.map((c) => c.trainId), fastForward, headSha: r.headSha ?? null, mergeMs: r.mergeMs ?? null },
  });
  return b.build();
}

// ── carFailed ───────────────────────────────────────────────────────────

/**
 * A car failed (gate, preview, MERGE or LANDER exhausted): eject it and every
 * later car whose includedPrompts overlap its member prompts (v1 supersede),
 * return their members to the pool (no attempt charged), then bisect (gate,
 * > 1 member: two pinned halves, boarded first by formCars), fail the single
 * member (gate, 1 member: integration rework waiting for this car's seq), or
 * count an infra failure (no bisect; 3 in a row → executorLost).
 */
export function carFailed(
  car: TrainRecord,
  summary: string,
  cause: CarFailureCause,
  trains: readonly TrainRecord[],
  ctx: QueueContext,
): QueueDecision {
  const b = new Builder(trains, ctx.namespace);
  const own = new Set(memberPrompts(car, trains));
  const superseded = activeCars(trains).filter((c) => c.seq > car.seq && c.includedPrompts.some((p) => own.has(p)));

  b.eject(car.trainId, `failed: ${summary}`);
  for (const s of superseded) {
    b.eject(s.trainId, `superseded: car ${car.trainId} failed`);
    for (const m of s.members ?? []) {
      const t = b.get(m);
      if (t && active(t)) b.patch(m, { carId: null, bisectOf: null });
    }
  }

  const members = (car.members ?? []).filter((m) => {
    const t = b.get(m);
    return !!t && active(t);
  });
  if (cause === "infra") {
    for (const m of members) b.patch(m, { carId: null, bisectOf: null });
    const next = ctx.carInfraFailures + 1;
    b.carInfraFailures = next;
    if (next >= CAR_INFRA_FAILURES_BEFORE_LOST && !ctx.paused) b.executorLost = true;
    return b.build();
  }

  resetInfra(b, ctx);
  if (members.length > 1) {
    const cut = Math.ceil(members.length / 2);
    const halves = [members.slice(0, cut), members.slice(cut)];
    halves.forEach((half, i) => {
      for (const m of half) b.patch(m, { carId: null, bisectOf: pinKey(car.trainId, i) });
    });
    b.event({
      type: "queue.bisect",
      severity: "warn",
      trainId: car.trainId,
      summary: clip(`car ${car.trainId} failed its integration gate; bisecting ${members.length} → ${halves[0]!.length}+${halves[1]!.length}: ${summary}`),
      data: { carId: car.trainId, halves },
    });
  } else if (members.length === 1) {
    const m = b.get(members[0]!)!;
    b.failures.push({
      trainId: m.trainId,
      summary: clip(`Passed alone, fails integrated on main@${short(car.baseSha)}: ${summary}`),
      cause: "integration",
      waitForCarSeq: car.seq,
      conflict: null,
      claimPaths: [],
    });
  }
  return b.build();
}

// ── carLanded ───────────────────────────────────────────────────────────

/**
 * The LANDER pushed `car` to hive main: the car and each member BUILD train
 * become MERGED with `landedSha`; member forks are deleted and previews torn
 * down. The planner hands `members` to the release planner (`rp.landed`),
 * sets the member prompts MERGED, and deletes the car's own fork / tears down
 * its preview (v1 landResult).
 */
export function carLanded(car: TrainRecord, landedSha: string, trains: readonly TrainRecord[], ctx: QueueContext): QueueDecision {
  const b = new Builder(trains, ctx.namespace);
  resetInfra(b, ctx);
  b.patch(car.trainId, { phase: "MERGED", status: "MERGED", landedSha });
  const members = car.members ?? [];
  for (const id of members) {
    const m = b.get(id);
    if (!m || !active(m)) continue;
    b.patch(id, { phase: "MERGED", status: "MERGED", landedSha });
    b.cleanUp(id);
  }
  // Queue wait per member: gate pass (planner stamps droneIssuedAt then) to landing. `waitMs` is the mean
  // (what metrics/rollup reads); `waits` is per member, aligned with `members` (null = no stamp).
  const waits = members.map((id) => {
    const at = b.get(id)?.droneIssuedAt;
    return typeof at === "number" ? Math.max(0, ctx.now - at) : null;
  });
  const known = waits.filter((w): w is number => w !== null);
  const waitMs = known.length ? Math.round(known.reduce((a, w) => a + w, 0) / known.length) : undefined;
  b.event({
    type: "queue.landed",
    trainId: car.trainId,
    summary: `car ${car.trainId} landed ${members.length} member${members.length === 1 ? "" : "s"} at main@${short(landedSha)}`,
    data: { carId: car.trainId, members, landedSha, waits, ...(waitMs !== undefined ? { waitMs } : {}) },
  });
  return b.build();
}

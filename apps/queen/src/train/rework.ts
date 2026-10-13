/**
 * The rework loop (docs/superpowers/specs/2026-10-13-queenos-rework-loop-design.md): an attempt whose head was rejected
 * while its item is open gets a rework slot (a deadline) to fix and push again as the same candidate. Pure: no I/O, no
 * clock (callers pass `now`). The train planner applies these rules; the Queen stores slots on `attempts` rows (v19).
 */
import type { AttemptRework, Race, ReworkReason, WorkStatus } from "@queenos/queen-types";

/** Per-hive rework guardrails (§5.5), from `Guardrails`. Passed to the planner only for external hives. */
export interface ReworkSettings {
  windowMs: number;
  holdMs: number;
  maxPerAttempt: number;
  maxRaceReopens: number;
}

/** An attempt's slot bookkeeping as the planner sees it (attempts.reworks / rework_reason / rework_due_at). */
export interface AttemptSlot {
  attemptId: string;
  /** Slots given so far (the open one included). */
  reworks: number;
  /** The open slot, or null. */
  rework: AttemptRework | null;
}

const CLOSED_ITEM: ReadonlySet<WorkStatus> = new Set(["LANDED", "SHIPPED", "CANCELLED", "DUPLICATE"]);

export const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * The next slot of an attempt, or null when it has none to give (§5.5 "a slot to give": `reworks < maxReworksPerAttempt`
 * and the item open). Findings, conflicts and human rejects share the count.
 */
export function nextSlot(slot: AttemptSlot | undefined, attemptId: string, reason: ReworkReason, s: ReworkSettings, now: number, itemStatus?: WorkStatus): AttemptSlot | null {
  const cur = slot ?? { attemptId, reworks: 0, rework: null };
  if (itemStatus && CLOSED_ITEM.has(itemStatus)) return null;
  if (cur.reworks >= s.maxPerAttempt) return null;
  const round = cur.reworks + 1;
  return { attemptId, reworks: round, rework: { reason, dueAt: now + s.windowMs, round } };
}

/** When the race's grace clock started (the first pass, or entry close if later): `deadlineAt - raceGraceMs` (plan ruling R2). */
export function graceStartOf(race: Pick<Race, "deadlineAt">, graceMs: number): number | null {
  return race.deadlineAt === null ? null : race.deadlineAt - graceMs;
}

/**
 * Until when a REWORK candidate holds its RACING race (§5.2): its `dueAt`; once another candidate passed and the slot
 * came from gate findings, at most `graceStart + reworkHoldMs`. A human reject-one holds until `dueAt` (the judge chose
 * to wait), whatever the grace clock says.
 */
export function holdEnd(rework: AttemptRework, race: Pick<Race, "deadlineAt">, anyPassed: boolean, s: { holdMs: number; graceMs: number }): number {
  if (rework.reason === "human" || !anyPassed) return rework.dueAt;
  const start = graceStartOf(race, s.graceMs);
  return start === null ? rework.dueAt : Math.min(rework.dueAt, start + s.holdMs);
}

/** What `reworkDeadlines` reads of a train. */
export interface DeadlineTrain {
  trainId: string;
  phase: string;
  attemptId?: string | null;
  raceOutcome?: string | null;
}

/**
 * The rework deadlines the DO alarm must wake for (§12 review focus): every open slot's `dueAt`, and each REWORK
 * candidate's hold end in a RACING race. Only future times (a past one would re-arm the alarm at once, forever).
 */
export function reworkDeadlines(input: {
  races: readonly Pick<Race, "state" | "trainIds" | "deadlineAt">[];
  trains: readonly DeadlineTrain[];
  slots: readonly AttemptSlot[];
  holdMs: number;
  graceMs: number;
  now: number;
}): number[] {
  const open = new Map<string, AttemptRework>();
  for (const s of input.slots) if (s.rework) open.set(s.attemptId, s.rework);
  const out: number[] = [];
  for (const r of open.values()) if (r.dueAt > input.now) out.push(r.dueAt);
  for (const race of input.races) {
    if (race.state !== "RACING") continue;
    const cands = input.trains.filter((t) => race.trainIds.includes(t.trainId));
    const anyPassed = cands.some((t) => t.raceOutcome === "PASSED" && t.phase !== "EJECTED" && t.phase !== "MERGED");
    for (const t of cands) {
      const rw = t.raceOutcome === "REWORK" && t.attemptId ? open.get(t.attemptId) : undefined;
      if (!rw) continue;
      const end = holdEnd(rw, race, anyPassed, input);
      if (end > input.now) out.push(end);
    }
  }
  return out;
}

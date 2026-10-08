/**
 * Human-judged races, "you pick" (human-push design §10.1–10.3). Pure: no I/O, no clock, no randomness.
 *
 * A race whose judge is `human` (the item's `judge`, else the hive's `settings.race.judge`) does not
 * auto-decide once its candidates reported (or at its grace deadline): when at least 2 candidates passed
 * every gate it enters PICKING. The passed candidates stay alive (TESTING, previews LIVE, forks kept), the
 * race records the Queen's recommendation (the `rankCandidates` winner and why) and a pick deadline
 * (`now + pickWindowMs`, default 15 min, max 2 h). Then:
 * - a human picks (`POST /hives/:hive/races/:raceId/pick`): `by: human:<email>`;
 * - at `pickDeadlineAt` the Queen picks its recommendation: `by: queen:deadline` (the swarm never stalls);
 * - exactly 1 passed: no real choice, `queen:single`; 0 passed: the usual ABANDONED → REWORK, no human;
 * - over `maxPickingRaces` held races: auto-decide at once, `queen:cap`.
 *
 * Losers are EJECTED (LOST) and their previews torn down, but their forks are kept (`deleteIssuedAt` =
 * now + LOSER_FORK_KEEP_MS) until the winner is terminal or the window ends, so a "pick B instead" before
 * the winner boards a car can swap the winner back (`checkPick` mode `repick`).
 *
 * This module holds the rules; planner.ts applies them to its rows.
 */
import {
  GUARDRAIL_DEFAULTS,
  GUARDRAIL_MAX,
  PICK_WINDOW_DEFAULT_MS,
  PICK_WINDOW_MAX_MS,
  type Race,
  type RaceJudge,
  type TrainPhase,
} from "@queenos/queen-types";
import { rankCandidates, type RaceCandidate } from "./race";

/** The shortest pick window a hive may configure (RaceSettingsSchema min). */
export const PICK_WINDOW_MIN_MS = 60_000;
/** A picked race's losers keep their forks this long (or until the winner is terminal), for a re-pick (§10.3). */
export const LOSER_FORK_KEEP_MS = 30 * 60_000;
/** `decidedBy` / `race.decided` `data.by` is at most this long (RaceDecidedBySchema). */
const MAX_BY = 340;

/** The judge of a race: the item's, else the hive's, else `auto`. */
export function judgeOf(itemJudge: RaceJudge | null | undefined, hiveJudge: RaceJudge | null | undefined): RaceJudge {
  return itemJudge ?? hiveJudge ?? "auto";
}

/** The pick window: default 15 min, clamped to [1 min, 2 h]. */
export function pickWindowMs(ms: number | null | undefined): number {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return PICK_WINDOW_DEFAULT_MS;
  return Math.min(PICK_WINDOW_MAX_MS, Math.max(PICK_WINDOW_MIN_MS, Math.trunc(ms)));
}

/** Guardrails.maxPickingRaces as the planner applies it: default 2, clamped to [1, 5] (the schema allows 0; 0 would never let a race be picked). */
export function maxPickingRaces(n: number | null | undefined): number {
  if (n === null || n === undefined || !Number.isFinite(n)) return GUARDRAIL_DEFAULTS.maxPickingRaces;
  return Math.min(GUARDRAIL_MAX.maxPickingRaces, Math.max(1, Math.trunc(n)));
}

/** The Queen's ways of deciding a race (`queen:<mode>`); `pick` = hold it in PICKING for a human. */
export type DecideMode = "auto" | "single" | "cap" | "pick";

/**
 * How a race with `passed` passing candidates is decided once it is due (all reported, or its grace deadline):
 * - judge `auto` → `auto` (rankCandidates, as always);
 * - judge `human`, 1 passed → `single` (no real choice); ≥ 2 passed and fewer than `maxPicking` races already
 *   PICKING → `pick`; at the cap → `cap` (auto-decide now).
 * (0 passed never reaches here: the race is ABANDONED and reworked, with no human.)
 */
export function decideMode(input: { judge: RaceJudge; passed: number; picking: number; maxPicking: number }): DecideMode {
  if (input.judge !== "human") return "auto";
  if (input.passed < 2) return "single";
  if (input.picking >= maxPickingRaces(input.maxPicking)) return "cap";
  return "pick";
}

/** The Queen's recommendation among the passed candidates: the rankCandidates winner, and why (≤ 300). */
export function recommend(passed: readonly RaceCandidate[], predictedPaths: readonly string[] = []): { trainId: string; reason: string } | null {
  const ranking = rankCandidates(passed, { predictedPaths });
  if (!ranking.winner) return null;
  return { trainId: ranking.winner.trainId, reason: clip(ranking.reason.replace(/^won: /, "recommended: "), 300) };
}

/** When a race entering PICKING now auto-picks its recommendation. */
export function pickDeadline(now: number, windowMs: number | null | undefined): number {
  return now + pickWindowMs(windowMs);
}

/** A PICKING race whose pick window ran out. */
export function pickDue(race: Pick<Race, "state" | "pickDeadlineAt">, now: number): boolean {
  return race.state === "PICKING" && race.pickDeadlineAt !== null && race.pickDeadlineAt !== undefined && now >= race.pickDeadlineAt;
}

/** `human:<email>` (clipped to RaceDecidedBySchema's 340). */
export function humanBy(user: string): string {
  return clip(`human:${user.trim() || "unknown"}`, MAX_BY);
}

export function isHumanBy(by: string | null | undefined): boolean {
  return !!by && by.startsWith("human:");
}

/** What `checkPick` needs to know about each candidate train. */
export interface PickCandidate {
  trainId: string;
  phase: TrainPhase;
  raceOutcome?: string | null;
  carId?: string | null;
  forkState: string;
  headSha: string | null;
}

export type PickCheck =
  | { ok: true; mode: "pick" }
  /** A DECIDED race whose winner has not boarded a car: the winner steps back, `trainId` is restored. */
  | { ok: true; mode: "repick"; winnerTrainId: string }
  | { ok: false; status: 404 | 409; message: string };

const terminal = (phase: TrainPhase) => phase === "MERGED" || phase === "EJECTED";

/**
 * Whether `trainId` may be picked in `race` (the pick route's 409 rules, §10.2 / §10.3):
 * - PICKING: `trainId` must be a live (active) candidate that passed (raceOutcome PASSED);
 * - DECIDED out of PICKING (it has a recommendation and was decided by a human or the deadline): a re-pick
 *   is allowed only while the winner waits to board (PASSED, no car) and `trainId` is a loser whose fork is
 *   still kept (EJECTED, LOST, fork READY, a head);
 * - anything else: 409.
 */
export function checkPick(race: Pick<Race, "raceId" | "state" | "trainIds" | "winnerTrainId" | "recommendedTrainId" | "decidedBy">, trainId: string, candidates: readonly PickCandidate[]): PickCheck {
  if (!race.trainIds.includes(trainId)) return { ok: false, status: 409, message: `train ${trainId} is not a candidate of race ${race.raceId}` };
  const c = candidates.find((x) => x.trainId === trainId);
  if (race.state === "PICKING") {
    if (!c || terminal(c.phase) || c.raceOutcome !== "PASSED") {
      return { ok: false, status: 409, message: `train ${trainId} is not a live passed candidate of race ${race.raceId}` };
    }
    return { ok: true, mode: "pick" };
  }
  const picked = race.state === "DECIDED" && !!race.recommendedTrainId && (isHumanBy(race.decidedBy) || race.decidedBy === "queen:deadline");
  if (!picked) return { ok: false, status: 409, message: `race ${race.raceId} is ${race.state}, not PICKING` };
  if (race.winnerTrainId === trainId) return { ok: false, status: 409, message: `train ${trainId} already won race ${race.raceId}` };
  const winner = candidates.find((x) => x.trainId === race.winnerTrainId);
  if (!winner || winner.phase !== "PASSED" || winner.carId) {
    return { ok: false, status: 409, message: `race ${race.raceId} is DECIDED and its winner already boarded a merge car` };
  }
  if (!c || c.phase !== "EJECTED" || c.raceOutcome !== "LOST" || c.forkState !== "READY" || !c.headSha) {
    return { ok: false, status: 409, message: `train ${trainId} can no longer be picked (its fork is gone)` };
  }
  return { ok: true, mode: "repick", winnerTrainId: winner.trainId };
}

/** A picked race's loser whose fork is kept for a re-pick (`deleteIssuedAt` is its delete-after deadline). */
export function keptLoser(t: { phase: TrainPhase; raceOutcome?: string | null; forkState: string; lane?: string | null }): boolean {
  return terminal(t.phase) && t.raceOutcome === "LOST" && t.forkState === "READY" && t.lane !== "QUEUE";
}

/**
 * Delete a kept loser's fork now: its window ran out, or the race's winner is terminal (MERGED, or ejected
 * from its car) or no longer known to the planner (terminal and unloaded).
 */
export function releaseLoser(t: { deleteIssuedAt: number | null }, winner: { phase: TrainPhase } | undefined, now: number): boolean {
  if (t.deleteIssuedAt === null || now >= t.deleteIssuedAt) return true;
  return !winner || terminal(winner.phase);
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

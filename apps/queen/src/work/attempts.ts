/**
 * MCP attempt rules (docs/superpowers/specs/2026-10-12-queenos-mcp-design.md §7, §8.3, §10). Pure: no SQL, no clock.
 */
import { ATTEMPT_TOKEN_TTL_S, isInfraStopped, type AttemptState, type AttemptVerdict, type AttemptVerdictKind, type AttemptView, type RaceState } from "@queenos/queen-types";
import { MAX_GATE_INFRA_ROUNDS, gateOutstanding, type TrainRecord } from "../train/planner";

export const OPEN_ATTEMPT_STATES: readonly AttemptState[] = ["INTENT", "READY", "PUSHED", "PASSED", "REJECTED", "WON"];
export const OPEN_ATTEMPTS_SQL = OPEN_ATTEMPT_STATES.map((s) => `'${s}'`).join(", ");
/** States in which a push to the attempt's fork is a submission. */
export const PUSHABLE_STATES: ReadonlySet<AttemptState> = new Set(["READY", "PUSHED", "PASSED", "REJECTED", "WON"]);
export const ATTEMPT_TTL_MS = ATTEMPT_TOKEN_TTL_S * 1000;
/** A base still being created after this long is cleared by the watchdog (Task 4). */
export const BASE_PENDING_TTL_MS = 5 * 60_000;
/** An INTENT (start_attempt died before ready / aborted) is aborted by the watchdog after this long (Task 4). */
export const INTENT_TTL_MS = 5 * 60_000;

export interface EntryItem {
  kind: string;
  status: string;
  waitReason: string | null;
}

export interface EntryRace {
  state: RaceState;
  entryClosesAt?: number | null;
}

/**
 * Whether an item takes a new attempt: its RACING race's entry window is open (or unset); else READY waiting for a
 * submission; else FAILED awaiting its contributor (a push reopens it; deviation from spec §8.3, see the plan).
 */
export function acceptsEntries(item: EntryItem, race: EntryRace | null, now: number): boolean {
  if (item.kind === "goal") return false;
  if (race && race.state === "RACING") return race.entryClosesAt === null || race.entryClosesAt === undefined || now < race.entryClosesAt;
  if (item.status === "READY") return item.waitReason === "awaiting submissions" || item.waitReason === "awaiting push" || item.waitReason === null;
  return item.status === "FAILED";
}

export interface CapInput {
  itemId: string;
  /** The agent's non-terminal attempts in this hive. */
  agentOpen: number;
  /** Distinct open items the owner has an open attempt or an applied push on. */
  ownerOpenItems: ReadonlySet<string>;
  /** The owner's attempt starts plus applied / pending pushes in the last hour. */
  ownerStartsLastHour: number;
  /** When the oldest of those counted starts / pushes happened (null: none); with `now`, when the hourly cap frees up. */
  oldestCountedAt?: number | null;
  now?: number;
  maxPerAgent: number;
  maxOpenPerContributor: number;
  maxPushesPerHour: number;
}

const HOUR_MS = 3_600_000;

/** `retryAfterMs`: only the hourly cap frees up at a known time (its oldest counted start ages out of the hour). */
export function checkAttemptCaps(c: CapInput): { ok: true } | { ok: false; message: string; retryAfterMs?: number } {
  if (c.agentOpen >= c.maxPerAgent) return { ok: false, message: `open attempts per agent: ${c.maxPerAgent} reached; end_attempt one or wait for one to resolve` };
  if (!c.ownerOpenItems.has(c.itemId) && c.ownerOpenItems.size >= c.maxOpenPerContributor) {
    return { ok: false, message: `maxInboxOpenPerContributor ${c.maxOpenPerContributor} reached; frees up when one of your items resolves` };
  }
  if (c.ownerStartsLastHour >= c.maxPushesPerHour) {
    const at = c.oldestCountedAt !== null && c.oldestCountedAt !== undefined && c.now !== undefined ? Math.min(HOUR_MS, Math.max(0, c.oldestCountedAt + HOUR_MS - c.now)) : undefined;
    return { ok: false, message: `maxInboxPushesPerHour ${c.maxPushesPerHour} reached; frees up within the hour`, ...(at !== undefined ? { retryAfterMs: at } : {}) };
  }
  return { ok: true };
}

/** The gate's word on a train: none (no train yet), pending, passed (incl. a race loser that passed) or rejected. */
export function attemptVerdict(t: Pick<TrainRecord, "phase" | "raceOutcome"> | null): AttemptVerdict {
  if (!t) return "none";
  if (t.raceOutcome === "FAILED") return "rejected";
  if (t.raceOutcome === "PASSED" || t.raceOutcome === "WON" || t.raceOutcome === "LOST") return "passed";
  if (t.phase === "PASSED" || t.phase === "LANDING" || t.phase === "MERGED") return "passed";
  if (t.phase === "EJECTED") return "rejected";
  return "pending";
}

/**
 * Why a rejected train was rejected: `infra` when it stopped on infrastructure (its summary carries
 * INFRA_SUMMARY_PREFIX: the gate could not run after its re-gates), else `findings`. Null unless rejected.
 */
export function attemptVerdictKind(t: Pick<TrainRecord, "phase" | "raceOutcome" | "summary"> | null): AttemptVerdictKind | null {
  if (attemptVerdict(t) !== "rejected") return null;
  return isInfraStopped({ summary: t!.summary }) ? "infra" : "findings";
}

/**
 * An automatic same-head gate-infra re-gate in flight on the train (TESTING, the re-gate's gate outstanding, the
 * verdict still pending). Null = no automatic same-head re-gate pending; that includes a re-gated train sent back to
 * DEPLOYING by the watchdog's infra path (its verdict is still pending, but it is re-deploying, not re-gating).
 */
export function attemptRegating(t: TrainRecord | null): NonNullable<AttemptView["regating"]> | null {
  if (!t || !(t.gateInfraRounds ?? 0) || !gateOutstanding(t) || attemptVerdict(t) !== "pending") return null;
  return { round: t.gateInfraRounds!, of: MAX_GATE_INFRA_ROUNDS, notBefore: t.gateNotBefore ?? null };
}

/** `bytes` random bytes as lowercase hex (`crypto.getRandomValues`). */
export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * An attempt follows its current train: PUSHED while it builds / deploys / is gated, PASSED once its gate passed, WON
 * when its race picked it (or it boarded a car / is landing), LANDED when merged; EJECTED is LOST (its race picked
 * another) or REJECTED (the gate, the integration gate or a car ejected it; the agent may push again).
 */
export function attemptStateOf(t: Pick<TrainRecord, "phase" | "raceOutcome" | "carId">): AttemptState {
  if (t.phase === "MERGED") return "LANDED";
  if (t.phase === "EJECTED") return t.raceOutcome === "LOST" ? "LOST" : "REJECTED";
  if (t.raceOutcome === "WON" || t.carId || t.phase === "LANDING") return "WON";
  if (t.phase === "PASSED" || t.raceOutcome === "PASSED") return "PASSED";
  return "PUSHED";
}

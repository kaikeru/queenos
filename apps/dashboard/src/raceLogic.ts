/** Pure helpers for the Pick view (docs/human-push-design.md §10): countdown, candidate cards, 409 handling, composer judge. */
import { parseReworkReason, type Race } from "@queenos/queen-types";

import { ApiError } from "./api";
import { originBadge, type OriginBadge } from "./origin";
import type { RaceCandidate, RaceView } from "./swarm";

export const PICK_REASON_MAX = 300;

/** mm:ss (h:mm:ss past an hour) for a remaining duration; never negative. */
export function countdownText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Ms until the Queen auto-picks; null when the race is not PICKING or has no deadline (older Queens). */
export function pickRemainingMs(race: Pick<Race, "state" | "pickDeadlineAt">, now: number): number | null {
  if (race.state !== "PICKING" || race.pickDeadlineAt == null) return null;
  return Math.max(0, race.pickDeadlineAt - now);
}

export type EntryState =
  | { kind: "open"; remainingMs: number }
  /** The window has passed but the Queen has not decided yet. */
  | { kind: "closed" };

/** The entry window of a RACING race (external hives); null when the race is not RACING or has no window (swarm hives, older Queens). */
export function entryState(race: Pick<Race, "state" | "entryClosesAt">, now: number): EntryState | null {
  if (race.state !== "RACING" || race.entryClosesAt == null) return null;
  return race.entryClosesAt > now ? { kind: "open", remainingMs: race.entryClosesAt - now } : { kind: "closed" };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "Entries open · closes in 12:03 (2 candidates)" / "Entries closed · deciding…"; null when there is no window. */
export function entriesLine(race: Pick<Race, "state" | "entryClosesAt">, candidates: number, now: number): string | null {
  const e = entryState(race, now);
  if (!e) return null;
  return e.kind === "open" ? `Entries open · closes in ${countdownText(e.remainingMs)} (${plural(candidates, "candidate")})` : "Entries closed · deciding…";
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * While a human-judged race is still RACING there are no pick buttons yet: say when they appear. Null for any other race.
 * The closing time is local `HH:MM` and only shown while the window is still in the future.
 */
export function pickHint(view: Pick<RaceView, "race" | "item">, now: number): string | null {
  const { race, item } = view;
  if (race.state !== "RACING" || item?.judge !== "human") return null;
  const at = race.entryClosesAt != null && race.entryClosesAt > now ? new Date(race.entryClosesAt) : null;
  const when = at ? ` at ${pad2(at.getHours())}:${pad2(at.getMinutes())}` : "";
  return `You pick the winner once entries close${when} and two or more candidates pass. With one pass, the Queen takes it.`;
}

/** 409 means the race is no longer RACING or its entries already closed: refetch rather than retry. */
export function closeEntriesFailure(e: unknown): PickFailure {
  if (e instanceof ApiError && e.status === 409) {
    return { message: "Entries are already closed for this race (it was decided, or the window ended). Refreshing…", refresh: true };
  }
  return { message: e instanceof Error ? e.message : String(e), refresh: false };
}

export interface PickCard {
  trainId: string;
  /** "c2" */
  tag: string;
  model: string | null;
  origin: OriginBadge;
  previewUrl: string | null;
  /** All null when the Queen did not report a gate score (rendered "n/a"). */
  changedFiles: number | null;
  changedBytes: number | null;
  checks: number | null;
  satisfied: number | null;
  missing: number | null;
  review: string | null;
  /** The Scribe / reviewer verdict text. */
  notes: string | null;
  recommended: boolean;
  /** A live passed candidate: can be picked. */
  pickable: boolean;
  rejectedReason: string | null;
  winner: boolean;
}

const httpUrl = (u: string | null | undefined): string | null => (u && /^https?:\/\//i.test(u) ? u : null);

export function pickCard(c: RaceCandidate, race: Race): PickCard {
  const t = c.train;
  const rej = race.rejections?.find((r) => r.trainId === t.trainId) ?? null;
  const live = t.status !== "EJECTED" && (t.raceOutcome === "PASSED" || t.raceOutcome === "WON");
  return {
    trainId: t.trainId,
    tag: `c${c.candidate + 1}`,
    model: c.model,
    origin: originBadge(t.origin, t.attemptId),
    previewUrl: httpUrl(t.previewUrl),
    changedFiles: c.score?.changedFiles ?? null,
    changedBytes: c.score?.changedBytes ?? null,
    checks: c.score?.checks ?? null,
    satisfied: c.score?.satisfied ?? null,
    missing: c.score?.missing ?? null,
    review: c.score?.review ?? null,
    notes: t.summary ?? null,
    recommended: race.recommendedTrainId === t.trainId,
    pickable: race.state === "PICKING" && live && !rej,
    rejectedReason: rej ? rej.reason : null,
    winner: race.winnerTrainId === t.trainId,
  };
}

/** Candidates worth showing: while PICKING, everything that passed (plus rejected ones, dimmed); afterwards, all of them. */
export function pickCards(view: RaceView): PickCard[] {
  const cards = view.candidates.map((c) => pickCard(c, view.race));
  if (view.race.state !== "PICKING") return cards;
  return cards.filter((c) => c.pickable || c.rejectedReason);
}

const pretty = (c: PickCard | undefined, id: string | null | undefined): string => (c ? c.model ?? c.tag : id ?? "the recommendation");

/** "auto-picks kimi in 12:03", or null when there is nothing to count down. */
export function countdownLine(view: RaceView, now: number): string | null {
  const left = pickRemainingMs(view.race, now);
  if (left == null) return null;
  const rec = pickCards(view).find((c) => c.recommended);
  const who = pretty(rec, view.race.recommendedTrainId);
  return left === 0 ? `auto-picking ${who} now` : `auto-picks ${who} in ${countdownText(left)}`;
}

export interface DecidedSummary {
  /** "human:kyle@kaikeru.com" | "queen:deadline" | null (older Queens). */
  by: string | null;
  human: boolean;
  /** Whether the winner was the recommendation; null when unknown. */
  agreed: boolean | null;
  text: string;
}

export const decidedByText = (by: string): string =>
  by.startsWith("human:") ? `picked by ${by.slice(6)}` : ({ "queen:deadline": "auto-picked at the pick deadline", "queen:single": "auto-decided (only one candidate passed)", "queen:cap": "auto-decided (too many races waiting for a pick)", "queen:auto": "decided by ranking" } as Record<string, string>)[by] ?? `decided by ${by}`;

export function decidedSummary(race: Race): DecidedSummary | null {
  if (race.state !== "DECIDED") return null;
  const by = race.decidedBy ?? null;
  const agreed = race.recommendedTrainId && race.winnerTrainId ? race.winnerTrainId === race.recommendedTrainId : null;
  const text = by ? decidedByText(by) : "decided";
  return { by, human: Boolean(by?.startsWith("human:")), agreed, text };
}

export interface PickFailure {
  message: string;
  /** The race moved on (decided, or the candidate is gone): refetch instead of retrying. */
  refresh: boolean;
}

/** 409 means the race is no longer PICKING (decided, deadline fired) or the candidate was rejected. */
export function pickFailure(e: unknown): PickFailure {
  if (e instanceof ApiError && e.status === 409) {
    return { message: "This race is no longer open for picking (it was decided, or that candidate is gone). Refreshing…", refresh: true };
  }
  return { message: e instanceof Error ? e.message : String(e), refresh: false };
}

// ── composer ────────────────────────────────────────────────────────────

export type BestOfChoice = "auto" | "1" | "2" | "3" | "4" | "5" | "pick";
export const YOU_PICK_WIDTH = 3;

/** The composer's best-of control: "you pick" is a width-3 race judged by a human (design §10.8 sim: `bestOf 3, judge human`). */
export function composerRace(choice: BestOfChoice): { bestOf?: number; judge?: "human" } {
  if (choice === "auto") return {};
  if (choice === "pick") return { bestOf: YOU_PICK_WIDTH, judge: "human" };
  return { bestOf: Number(choice) };
}

export const REJECT_REASON_MAX = 300;

/** Send is enabled only with a reason the agent can act on: 1..300 characters after trimming. */
export function canSendReject(reason: string): boolean {
  const r = reason.trim();
  return r.length > 0 && r.length <= REJECT_REASON_MAX;
}

/** 409: the race no longer waits for a pick (a reject already sent it back, or it was decided): refetch to show its state. */
export function rejectFailure(e: unknown): PickFailure {
  if (e instanceof ApiError && e.status === 409) {
    return { message: "This race is no longer waiting for a pick (a reject already sent it back, or it was decided). Refreshing…", refresh: true };
  }
  return { message: e instanceof Error ? e.message : String(e), refresh: false };
}

/**
 * Rework loop: "model-b in rework (human) · due in 12:03" for each REWORK candidate of a RACING race, or
 * "Reworking · model-a fixing a conflict rejection · due in 12:03" for a REWORKING race. The due time comes from the
 * train's rework reason text. Unknown or older trains are skipped.
 */
export function reworkLines(view: RaceView, now: number): string[] {
  const out: string[] = [];
  for (const c of view.candidates) {
    if (c.train.raceOutcome !== "REWORK") continue;
    const r = parseReworkReason(c.train.reason);
    if (!r) continue;
    const who = c.model ?? `c${c.candidate + 1}`;
    const left = countdownText(r.dueAt - now);
    out.push(view.race.state === "REWORKING" ? `Reworking · ${who} fixing a ${r.reason} rejection · due in ${left}` : `${who} in rework (${r.reason}) · due in ${left}`);
  }
  return out;
}

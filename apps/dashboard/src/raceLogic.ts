/** Pure helpers for the Pick view (docs/human-push-design.md §10): countdown, candidate cards, 409 handling, composer judge. */
import type { Race } from "@queenos/queen-types";

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
    origin: originBadge(t.origin),
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

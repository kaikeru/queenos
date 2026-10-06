/** Pure helpers for the status home and item page (no React; unit-tested). */
import type { Escalation, EscalationAction, EscalationReason, HiveStatus, MergeTrain, Race, WorkItem } from "@queenos/queen-types";
import { itemIdOf, isBuildTrain } from "./swarm";

export const ACTION_LABEL: Record<EscalationAction, string> = {
  ship: "Ship anyway",
  hold: "Hold",
  retry: "Retry",
  cancel: "Cancel",
  resume_autonomy: "Resume autonomy",
  raise_budget: "Raise budget +50%",
  ack: "Acknowledge",
};

/** The first listed action is the primary one; destructive ones are flagged. */
export function escalationButtons(e: Pick<Escalation, "actions">): { action: EscalationAction; label: string; primary: boolean; danger: boolean }[] {
  return e.actions.map((action, i) => ({ action, label: ACTION_LABEL[action], primary: i === 0, danger: action === "cancel" }));
}

const REASON_TEXT: Record<EscalationReason, string> = {
  APPROVAL_REQUIRED: "approval required",
  SENTINEL_INCONCLUSIVE: "sentinel inconclusive",
  REWORK_EXHAUSTED: "rework exhausted",
  ROLLBACK_STREAK: "rollback streak",
  ROLLBACK_FAILED: "rollback failed",
  ERROR_BUDGET_EXHAUSTED: "error budget",
  BUDGET_EXHAUSTED: "daily budget",
  GUARDRAIL_TRIPPED: "guardrail",
  EXECUTOR_LOST: "executor lost",
};
export const reasonText = (r: EscalationReason): string => REASON_TEXT[r];

/** "autonomous" or "autonomous → supervised (error budget, rollback streak)". */
export function autonomyLabel(h: Pick<HiveStatus, "effectiveAutonomy" | "degradedBy"> & { settings: Pick<HiveStatus["settings"], "autonomy"> }): string {
  const configured = h.settings.autonomy;
  if (h.effectiveAutonomy === configured) return configured;
  const why = h.degradedBy.map(reasonText).join(", ");
  return `${configured} → ${h.effectiveAutonomy}${why ? ` (${why})` : ""}`;
}

/** Fill fraction 0..1 for a meter; safe for zero totals. */
export function meterFill(used: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.min(1, Math.max(0, used / total));
}

export function compactNumber(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(n));
}

export function durationText(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "–";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

/** Item actions that are valid for the item's status (§5.3: "only where valid"). */
export function validItemActions(item: Pick<WorkItem, "status">): ("retry" | "cancel" | "not_duplicate")[] {
  switch (item.status) {
    case "FAILED":
      return ["retry", "cancel"];
    case "DUPLICATE":
      return ["not_duplicate"];
    case "SHIPPED":
    case "CANCELLED":
    case "LANDED":
      return [];
    default:
      return ["cancel"];
  }
}

export interface Attempt {
  n: number;
  train: MergeTrain;
  /** BUILD for the first attempt, REWORK after it, RACE for race candidates. */
  kind: "BUILD" | "REWORK" | "RACE";
  race: Race | null;
  winner: boolean;
}

/** An item's attempts: its BUILD trains in creation order. */
export function attemptsOf(trains: MergeTrain[], races: Race[]): Attempt[] {
  const sorted = trains.filter(isBuildTrain).sort((a, b) => a.createdAt - b.createdAt || (a.candidate ?? 0) - (b.candidate ?? 0));
  let firstSeen = false;
  return sorted.map((train, i) => {
    const race = train.raceId ? (races.find((r) => r.raceId === train.raceId) ?? null) : null;
    const kind: Attempt["kind"] = race ? "RACE" : firstSeen ? "REWORK" : "BUILD";
    firstSeen = true;
    return { n: i + 1, train, kind, race, winner: !!race && race.winnerTrainId === train.trainId };
  });
}

/** Attempts for one item out of live state (fallback while the REST detail loads). */
export function liveTrainsOf(trains: Record<string, MergeTrain>, order: string[], itemId: string): MergeTrain[] {
  return order.map((id) => trains[id]!).filter((t) => isBuildTrain(t) && itemIdOf(t) === itemId);
}

/** One-line gate summary: "gate 3/0 · 2.4 KB". */
export function gateText(t: MergeTrain): string | null {
  const s = t.score;
  if (!s) return null;
  const kb = s.changedBytes >= 1024 ? `${(s.changedBytes / 1024).toFixed(1)} KB` : `${s.changedBytes} B`;
  return `gate ${s.satisfied}/${s.missing} · ${s.checks} checks · ${s.changedFiles} files · ${kb}`;
}

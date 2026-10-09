/** Pure helpers for the status home and item page (no React; unit-tested). */
import type { Escalation, EscalationAction, EscalationReason, ExecutorsMode, HiveStatus, MergeTrain, Race, WorkItem } from "@queenos/queen-types";
import { GUARDRAIL_MAX, TERMINAL_WORK_STATUSES } from "@queenos/queen-types";
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

const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * A short id that tells items apart. Oracle children are `<goal uuid>-<key>`,
 * so their first 8 chars are the GOAL's: keep the key ("8e7b9165…-ip").
 */
export function shortItemId(id: string): string {
  const m = UUID_PREFIX.exec(id);
  if (m && id.length > m[0].length) return `${id.slice(0, 8)}…${id.slice(m[0].length)}`;
  return id.slice(0, 8);
}

/** The escalation card's subject: an item's title when known (else a distinguishing short id), or "<type> <id>". */
export function escalationSubjectLabel(e: Pick<Escalation, "subject">, items: Readonly<Record<string, Pick<WorkItem, "title">>>): string {
  if (e.subject.type !== "item") return `${e.subject.type} ${e.subject.id.slice(0, 8)}`;
  const title = items[e.subject.id]?.title;
  if (title) return `item “${title.length > 48 ? `${title.slice(0, 47)}…` : title}”`;
  return `item ${shortItemId(e.subject.id)}`;
}

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

// ── SIM badge ─────────────────────────────────────────────────────────────

export const SIM_BADGE_TEXT = "SIMULATION · scripted executors";

/** True when the hive runs scripted executors (`mode === "sim"`) or the dashboard uses the mock API. Read defensively: `mode` may predate the types. */
export function isSimulation(hive: unknown, mock: boolean = import.meta.env.VITE_MOCK_API === "1"): boolean {
  if (mock) return true;
  return (hive as { mode?: string } | null | undefined)?.mode === "sim";
}

// ── guardrails form ───────────────────────────────────────────────────────

export const GUARDRAIL_FIELDS = [
  { key: "maxChildrenPerItem", label: "Max children per item", hint: "How many sub-items a goal may split into" },
  { key: "maxActiveTrains", label: "Max active trains", hint: "Concurrent builds (the WIP limit)" },
] as const;
export type GuardrailKey = (typeof GUARDRAIL_FIELDS)[number]["key"];

/** Parse a guardrail input; returns the integer or an error message. Range is 1..GUARDRAIL_MAX[key]. */
export function parseGuardrail(key: GuardrailKey, raw: string): { value: number } | { error: string } {
  const max = GUARDRAIL_MAX[key];
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return { error: `Enter a whole number from 1 to ${max}` };
  const value = Number(t);
  if (value < 1 || value > max) return { error: `Must be between 1 and ${max}` };
  return { value };
}

/** The PATCH body for the fields that changed (null when nothing changed or an input is invalid). */
export function guardrailPatch(current: Record<GuardrailKey, number>, draft: Record<GuardrailKey, string>): { guardrails: Partial<Record<GuardrailKey, number>> } | null {
  const guardrails: Partial<Record<GuardrailKey, number>> = {};
  for (const f of GUARDRAIL_FIELDS) {
    const p = parseGuardrail(f.key, draft[f.key]);
    if ("error" in p) return null;
    if (p.value !== current[f.key]) guardrails[f.key] = p.value;
  }
  return Object.keys(guardrails).length ? { guardrails } : null;
}

// ── executors mode (swarm | external agents) ──────────────────────────────

/** The hive's executors mode; `swarm` when the hive is unknown or its Queen predates the setting. */
export function executorsMode(hive: { settings?: { executors?: ExecutorsMode } } | null | undefined): ExecutorsMode {
  return hive?.settings?.executors ?? "swarm";
}

/** True when external coding agents (not the Queen's swarm) do the building. */
export const isExternal = (hive: Parameters<typeof executorsMode>[0]): boolean => executorsMode(hive) === "external";

export type ExternalJudgeChoice = "auto" | "pick";

/** The prompt an external-mode composer sends: always one decomposed goal; "you pick" asks a human to judge, never a numeric best-of. */
export function externalPrompt(hive: string, promptText: string, judge: ExternalJudgeChoice): { namespace: string; promptText: string; decompose: true; judge?: "human" } {
  return { namespace: hive, promptText, decompose: true, ...(judge === "pick" ? { judge: "human" as const } : {}) };
}

/** The branch an external agent pushes to for a given item. */
export const itemPushCommand = (itemId: string): string => `git push origin HEAD:item/${itemId}`;

/** Show the push hint on non-goal items that still wait for code (not landed or finished) in an external hive. */
export function showPushHint(hive: Parameters<typeof executorsMode>[0], item: Pick<WorkItem, "kind" | "status">): boolean {
  if (!isExternal(hive) || item.kind === "goal") return false;
  return item.status !== "LANDED" && !(TERMINAL_WORK_STATUSES as readonly string[]).includes(item.status);
}

/**
 * Status-home selectors (v2 design §5.1): headline, pipeline counts, needs-you,
 * goal trees, blocked/failed rows and throughput. Pure functions over the
 * reducer `State`.
 */
import type { Escalation, HiveStatus, WorkItem, WorkStatus } from "@queenos/queen-types";

import type { State } from "./reducer";
import { itemSubState, queueRail, raceViewForItem, swarmFloor, type RaceView, type SubState } from "./swarm";

type Slice = Pick<State, "trains" | "trainOrder" | "items" | "itemOrder" | "races" | "events" | "landed" | "escalations" | "escalationOrder" | "hive" | "releases">;

export type HeadlineKind = HiveStatus["headline"];

export interface Headline {
  kind: HeadlineKind;
  building: number;
  carsInQueue: number;
  needsYou: number;
  landedToday: number;
  /** "SHIPPING · 23 building · 5 in the merge queue · 1 needs you · landed 31 today" */
  text: string;
}

const RELEASE_DONE = new Set(["SHIPPED", "ROLLED_BACK", "FAILED"]);

export function openEscalations(state: Pick<State, "escalations" | "escalationOrder">): Escalation[] {
  return state.escalationOrder.map((id) => state.escalations[id]!).filter((e) => e.status === "OPEN");
}

function deriveHeadline(state: Slice): HeadlineKind {
  const items = Object.values(state.items);
  if (openEscalations(state).length) return "NEEDS_YOU";
  const active = items.some((i) => i.status === "ACTIVE" || i.status === "LANDED" || i.status === "DECOMPOSING");
  const queued = items.some((i) => i.status === "READY" || i.status === "BLOCKED");
  if (state.hive && (state.hive.effectiveAutonomy === "paused" || state.hive.budget.creditsUsed >= state.hive.budget.creditsLimit)) return "BLOCKED";
  if (queued && !active) return "BLOCKED";
  const releasing = Object.values(state.releases).some((r) => !RELEASE_DONE.has(r.phase));
  const cars = Object.values(state.trains).some((t) => t.lane === "QUEUE" && t.status !== "EJECTED" && t.status !== "MERGED");
  return active || cars || releasing ? "SHIPPING" : "IDLE";
}

/**
 * Distinct work items that landed. `state.landed` has one entry per MERGED train, and a landed
 * batched car (lane QUEUE) lands together with each of its member build trains, so its length
 * is cars + members. A car counts as its members; a build train counts as itself.
 */
export function landedCount(state: Pick<State, "landed" | "trains">): number {
  const ids = new Set<string>();
  for (const l of state.landed) {
    const t = state.trains[l.trainId];
    if (t?.lane === "QUEUE") {
      if (t.members?.length) for (const m of t.members) ids.add(m);
      else ids.add(l.trainId);
    } else ids.add(l.trainId);
  }
  return ids.size;
}

/** The headline strip. Uses the Queen's `hive.headline` when present; otherwise derives it by the same rules. */
export function headline(state: Slice): Headline {
  const kind = state.hive?.headline ?? deriveHeadline(state);
  const floor = swarmFloor(state);
  const cars = queueRail(state).cars.length;
  const needsYou = openEscalations(state).length;
  const landedToday = state.hive?.throughput.landed24h ?? landedCount(state);
  const building = state.hive?.concurrency?.activeBuilds ?? floor.total;
  const carsInQueue = state.hive?.concurrency?.queueDepth ?? cars;
  const label = kind === "NEEDS_YOU" ? "NEEDS YOU" : kind;
  const parts = [label];
  if (building) parts.push(`${building} building`);
  if (carsInQueue) parts.push(`${carsInQueue} in the merge queue`);
  if (needsYou) parts.push(`${needsYou} needs you`);
  parts.push(`landed ${landedToday} today`);
  return { kind, building, carsInQueue, needsYou, landedToday, text: parts.join(" · ") };
}

export const WORK_STATUSES: readonly WorkStatus[] = ["TRIAGE", "DECOMPOSING", "BLOCKED", "READY", "ACTIVE", "LANDED", "SHIPPED", "FAILED", "DUPLICATE", "CANCELLED"];

/** Items per status. Prefers the Queen's authoritative `hive.counts`; otherwise counts the items it has. */
export function pipelineCounts(state: Pick<State, "items" | "hive">): Record<WorkStatus, number> {
  const out = Object.fromEntries(WORK_STATUSES.map((s) => [s, 0])) as Record<WorkStatus, number>;
  if (state.hive?.counts) {
    for (const s of WORK_STATUSES) out[s] = state.hive.counts[s] ?? 0;
    return out;
  }
  for (const i of Object.values(state.items)) out[i.status]++;
  return out;
}

// ── goal trees ────────────────────────────────────────────────────────────

export interface ItemRow {
  item: WorkItem;
  /** ACTIVE sub-state. */
  subState: SubState | null;
  /** Why the item is held: its `waitReason`, `blockedReason`, or the unmet dependencies. */
  note: string | null;
  /** Titles of dependencies that are not LANDED or SHIPPED yet. */
  blockedBy: string[];
  race: RaceView | null;
}

export interface GoalNode extends ItemRow {
  children: GoalNode[];
  /** Descendant counts (the node itself excluded). */
  total: number;
  landed: number;
  shipped: number;
}

const DEPS_DONE = new Set<WorkStatus>(["LANDED", "SHIPPED"]);

export function itemRow(state: Slice, item: WorkItem, now = Date.now()): ItemRow {
  const blockedBy = item.dependsOn
    .filter((id) => {
      const dep = state.items[id];
      return !dep || !DEPS_DONE.has(dep.status);
    })
    .map((id) => state.items[id]?.title ?? id);
  const note = item.waitReason ?? item.blockedReason ?? (item.status === "BLOCKED" && blockedBy.length ? `needs: ${blockedBy.join(", ")}` : null);
  return { item, subState: itemSubState(state, item), note, blockedBy, race: raceViewForItem(state, item.itemId, now) };
}

function build(state: Slice, item: WorkItem, kids: Map<string, WorkItem[]>, now: number): GoalNode {
  const children = (kids.get(item.itemId) ?? []).map((c) => build(state, c, kids, now));
  const sum = (f: (n: GoalNode) => number) => children.reduce((a, c) => a + f(c), 0);
  return {
    ...itemRow(state, item, now),
    children,
    total: sum((c) => 1 + c.total),
    landed: sum((c) => (c.item.status === "LANDED" ? 1 : 0) + c.landed),
    shipped: sum((c) => (c.item.status === "SHIPPED" ? 1 : 0) + c.shipped),
  };
}

export interface GoalTrees {
  /** Root `goal` items (and any root that has children), newest first, with children in creation order. */
  goals: GoalNode[];
  /** Root items with no children and no goal kind: lone features, bugs and chores, newest first. */
  loose: GoalNode[];
}

export function goalTrees(state: Slice, now = Date.now()): GoalTrees {
  const kids = new Map<string, WorkItem[]>();
  for (const id of state.itemOrder) {
    const i = state.items[id]!;
    if (i.parentId && state.items[i.parentId]) kids.set(i.parentId, [...(kids.get(i.parentId) ?? []), i]);
  }
  const roots = state.itemOrder.map((id) => state.items[id]!).filter((i) => !i.parentId || !state.items[i.parentId]);
  const nodes = roots.map((r) => build(state, r, kids, now)).reverse();
  return {
    goals: nodes.filter((n) => n.item.kind === "goal" || n.children.length > 0),
    loose: nodes.filter((n) => n.item.kind !== "goal" && n.children.length === 0),
  };
}

/** Items that need a look: FAILED or BLOCKED, newest first. */
export function blockedOrFailed(state: Slice, now = Date.now()): ItemRow[] {
  return state.itemOrder
    .map((id) => state.items[id]!)
    .filter((i) => i.status === "FAILED" || i.status === "BLOCKED")
    .reverse()
    .map((i) => itemRow(state, i, now));
}

// ── budget and throughput tiles ───────────────────────────────────────────

export interface StatusTiles {
  slots: { used: number; total: number; leased: number } | null;
  /** Failures the SLO still tolerates. */
  errorBudget: { remaining: number; total: number; exhausted: boolean } | null;
  credits: { used: number; limit: number } | null;
  throughput: HiveStatus["throughput"] | null;
  concurrency: NonNullable<HiveStatus["concurrency"]> | null;
  autonomy: { effective: HiveStatus["effectiveAutonomy"]; configured: HiveStatus["settings"]["autonomy"]; degradedBy: HiveStatus["degradedBy"] } | null;
}

export function statusTiles(state: Pick<State, "hive">): StatusTiles {
  const h = state.hive;
  if (!h) return { slots: null, errorBudget: null, credits: null, throughput: null, concurrency: null, autonomy: null };
  return {
    slots: h.concurrency ? { used: h.concurrency.activeBuilds, total: h.concurrency.slots, leased: h.concurrency.leasedSlots } : null,
    errorBudget: { remaining: h.slo.errorBudgetRemaining, total: h.slo.errorBudgetRemaining + h.slo.failed, exhausted: h.slo.exhausted },
    credits: { used: h.budget.creditsUsed, limit: h.budget.creditsLimit },
    throughput: h.throughput,
    concurrency: h.concurrency ?? null,
    autonomy: { effective: h.effectiveAutonomy, configured: h.settings.autonomy, degradedBy: h.degradedBy },
  };
}

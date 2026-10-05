/** War Room lane ordering and collapsing. Pure; no React. */
import type { Lane } from "./reducer";

/** How many of the newest lanes always stay expanded, finished or not. */
export const RECENT_LANES = 3;

const FINISHED_PROMPT = new Set(["MERGED", "EJECTED", "FAILED"]);
const FINISHED_TRAIN = new Set(["MERGED", "EJECTED"]);

/** Done for good: the prompt is terminal and every train it rode on has merged or been ejected. */
export function isFinishedLane(lane: Lane): boolean {
  return FINISHED_PROMPT.has(lane.prompt.status) && lane.trains.every((lt) => FINISHED_TRAIN.has(lt.train.status));
}

/** Newest prompt first (by queue time). Letters are assigned before this, so they stay stable. */
export function newestFirst(lanes: Lane[]): Lane[] {
  return lanes
    .map((lane, i) => ({ lane, i }))
    .sort((a, b) => b.lane.prompt.createdAt - a.lane.prompt.createdAt || b.i - a.i)
    .map((x) => x.lane);
}

export interface LaneGroups {
  /** Newest-first lanes that stay on screen. */
  visible: Lane[];
  /** Newest-first finished lanes behind the "N earlier runs" group. */
  earlier: Lane[];
}

/** Everything past the newest `keep` lanes that is finished collapses; unfinished lanes never hide. */
export function groupLanes(lanes: Lane[], keep = RECENT_LANES): LaneGroups {
  const sorted = newestFirst(lanes);
  const visible: Lane[] = [];
  const earlier: Lane[] = [];
  sorted.forEach((lane, i) => (i >= keep && isFinishedLane(lane) ? earlier : visible).push(lane));
  return { visible, earlier };
}

/** "3 merged · 1 failed" for the collapsed group. */
export function earlierSummary(lanes: Lane[]): string {
  const merged = lanes.filter((l) => l.prompt.status === "MERGED").length;
  const failed = lanes.length - merged;
  return [merged ? `${merged} merged` : "", failed ? `${failed} failed` : ""].filter(Boolean).join(" · ");
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function relativeTime(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

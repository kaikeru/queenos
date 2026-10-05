/** Hive memory presentation helpers for the War Room (pure, unit-tested). */
import type { MemoryOutcome, RecalledMemory } from "@queenos/queen-types";
import type { LaneTrain } from "./reducer";

export const OUTCOME_META: Record<MemoryOutcome, { label: string; cls: string }> = {
  PASSED: { label: "passed", cls: "passed" },
  FAILED: { label: "failed", cls: "failed" },
  REJECTED_BY_REVIEW: { label: "rejected by review", cls: "rejected" },
};

/** Cosine score (0..1) as a whole-number percentage, clamped. */
export const scorePercent = (score: number): number => Math.max(0, Math.min(100, Math.round(score * 100)));

export const memoryChipLabel = (count: number): string => `${count} ${count === 1 ? "memory" : "memories"} recalled`;

/** Memories to show for a lane: the newest train that has any (current train first), or [] when none. */
export function laneMemories(trains: LaneTrain[]): RecalledMemory[] {
  const ordered = [...trains].reverse();
  const hit = ordered.find((lt) => lt.current && lt.train.memories?.length) ?? ordered.find((lt) => lt.train.memories?.length);
  return hit?.train.memories ?? [];
}

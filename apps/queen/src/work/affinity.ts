/**
 * Path affinity (v2 design §2.3.5): an ACTIVE item temporarily owns the paths
 * it is predicted to touch, widened by the paths its build actually changed and
 * by merge-conflict paths. A READY item that overlaps another ACTIVE item's
 * claim waits. Pure. WP0 seam; WP1.1 implements it on top of queen-types
 * `pathsOverlap` (already implemented: equal paths or a "dir/" prefix;
 * GENERATED_PATHS and empty lists never overlap).
 */
import type { PathClaim, PathClaimSource, WorkItemRecord } from "../records";

export type { PathClaim, PathClaimSource } from "../records";

/** Who blocks a READY item: the first overlapping path and the ACTIVE item holding it. */
export interface BlockingClaim {
  path: string;
  holder: string;
}

/** The claims an item takes when it is dispatched: its `paths`, source "predicted" (generated paths excluded). */
export function claimsFor(item: Pick<WorkItemRecord, "itemId" | "paths">, now: number): PathClaim[] {
  void item;
  void now;
  throw new Error("not implemented");
}

/**
 * The claim that blocks `item` from dispatch, or null: the first of its paths
 * that overlaps a claim held by another item in `activeItemIds`.
 * Feeds `waitReason = "affinity: <path> held by <holder>"`.
 */
export function blockingClaim(
  item: Pick<WorkItemRecord, "itemId" | "paths">,
  claims: readonly PathClaim[],
  activeItemIds: ReadonlySet<string>,
): BlockingClaim | null {
  void item;
  void claims;
  void activeItemIds;
  throw new Error("not implemented");
}

/**
 * New or upgraded claims for `itemId` from actual changed paths
 * (`BuildResult.changedPaths`, source "actual") or conflict paths (source
 * "conflict"); paths it already holds with that source are skipped.
 */
export function widen(
  itemId: string,
  paths: readonly string[],
  source: Exclude<PathClaimSource, "predicted">,
  existing: readonly PathClaim[],
  now: number,
): PathClaim[] {
  void itemId;
  void paths;
  void source;
  void existing;
  void now;
  throw new Error("not implemented");
}

/** The claims to delete when `itemId` is LANDED, FAILED or CANCELLED. */
export function release(itemId: string, claims: readonly PathClaim[]): PathClaim[] {
  void itemId;
  void claims;
  throw new Error("not implemented");
}

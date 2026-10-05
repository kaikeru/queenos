/**
 * Path affinity (v2 design §2.3.5): an ACTIVE item temporarily owns the paths
 * it is predicted to touch, widened by the paths its build actually changed and
 * by merge-conflict paths. A READY item that overlaps another ACTIVE item's
 * claim waits. Pure: no I/O, no clock, no randomness.
 *
 * Built on queen-types `pathsOverlap` (equal paths or a "dir/" prefix;
 * GENERATED_PATHS and empty lists never overlap). Generated paths are never
 * claimed either, so they can neither block nor be blocked.
 *
 * Claim rows mirror `path_claims (PRIMARY KEY (path, item_id))`: an item holds
 * a path at most once, and a later source replaces an earlier one
 * (predicted → actual → conflict; see `widen`).
 */
import { isGeneratedPath, pathsOverlap } from "@queenos/queen-types";
import type { PathClaim, PathClaimSource, WorkItemRecord } from "../records";

export type { PathClaim, PathClaimSource } from "../records";

/** Who blocks a READY item: the first overlapping path and the ACTIVE item holding it. */
export interface BlockingClaim {
  path: string;
  holder: string;
}

/** Strength of a claim source: a stronger source replaces a weaker one on the same (path, item). */
const RANK: Readonly<Record<PathClaimSource, number>> = { predicted: 0, actual: 1, conflict: 2 };

function uniqueClaimable(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (p.length === 0 || isGeneratedPath(p) || out.includes(p)) continue;
    out.push(p);
  }
  return out;
}

/** The claims an item takes when it is dispatched: its `paths`, source "predicted" (generated paths excluded). */
export function claimsFor(item: Pick<WorkItemRecord, "itemId" | "paths">, now: number): PathClaim[] {
  return uniqueClaimable(item.paths).map((path) => ({ path, itemId: item.itemId, source: "predicted", createdAt: now }));
}

/**
 * The claim that blocks `item` from dispatch, or null: the first of its paths
 * (in the item's order) that overlaps a claim held by another item in
 * `activeItemIds`. Claims of items not in `activeItemIds` (stale rows of
 * terminal items) never block. Feeds `waitReason = "affinity: <path> held by <holder>"`.
 */
export function blockingClaim(
  item: Pick<WorkItemRecord, "itemId" | "paths">,
  claims: readonly PathClaim[],
  activeItemIds: ReadonlySet<string>,
): BlockingClaim | null {
  const mine = uniqueClaimable(item.paths);
  if (mine.length === 0) return null;
  const held = claims.filter((c) => c.itemId !== item.itemId && activeItemIds.has(c.itemId) && !isGeneratedPath(c.path));
  if (held.length === 0) return null;
  for (const path of mine) {
    const holder = held.find((c) => pathsOverlap([path], [c.path]).length > 0);
    if (holder) return { path, holder: holder.itemId };
  }
  return null;
}

/** `waitReason` text for a blocking claim (≤200 chars, the WorkItem limit). */
export function affinityWaitReason(b: BlockingClaim): string {
  return `affinity: ${b.path} held by ${b.holder}`.slice(0, 200);
}

/**
 * New or upgraded claims for `itemId` from actual changed paths
 * (`BuildResult.changedPaths`, source "actual") or conflict paths (source
 * "conflict"). A path the item already holds with an equal or stronger source
 * is skipped; a weaker one is upgraded (the row keeps its `createdAt`).
 * Generated paths are never claimed.
 */
export function widen(
  itemId: string,
  paths: readonly string[],
  source: Exclude<PathClaimSource, "predicted">,
  existing: readonly PathClaim[],
  now: number,
): PathClaim[] {
  const out: PathClaim[] = [];
  for (const path of uniqueClaimable(paths)) {
    const held = existing.find((c) => c.itemId === itemId && c.path === path);
    if (held && RANK[held.source] >= RANK[source]) continue;
    out.push({ path, itemId, source, createdAt: held?.createdAt ?? now });
  }
  return out;
}

/** The claims to delete when `itemId` is LANDED, FAILED or CANCELLED. */
export function release(itemId: string, claims: readonly PathClaim[]): PathClaim[] {
  return claims.filter((c) => c.itemId === itemId);
}

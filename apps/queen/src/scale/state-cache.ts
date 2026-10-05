/**
 * Warm state cache (v2 design §4.3, item 1). The QueenNode keeps its active
 * state in memory between calls: the DO is single-threaded and the only
 * writer, so after each apply() the cache equals the database. Cold start and
 * any apply error reload from SQLite. decide() becomes O(rows touched + READY
 * scan) instead of O(all rows).
 *
 * WP0 seam; WP1.13 implements it, WP2.1 wires it into decide().
 */
import type { ReleaseRecord } from "../release/planner";
import type { EscalationRecord, HiveSettingsRecord, PathClaim, RaceRecord, WorkItemRecord } from "../records";
import type { PromptRecord, TrainRecord } from "../train/planner";

/** Everything decide() needs that is not terminal. */
export interface ActiveState {
  /** Non-terminal trains (both lanes). */
  trains: TrainRecord[];
  /** Prompts of those trains, plus QUEUED ones. */
  prompts: PromptRecord[];
  /** Non-terminal work items (FAILED included: a human may retry it). */
  items: WorkItemRecord[];
  /** Claims of ACTIVE items. */
  claims: PathClaim[];
  /** RACING races. */
  races: RaceRecord[];
  /** In-flight releases plus the newest one. */
  releases: ReleaseRecord[];
  /** OPEN escalations. */
  escalations: EscalationRecord[];
  settings: HiveSettingsRecord | null;
  maxTrainSeq: number;
  maxPromptSeq: number;
  maxItemSeq: number;
}

/** The rows one apply() persisted (upserts; terminal rows are evicted from the cache). */
export interface AppliedRows {
  trains?: readonly TrainRecord[];
  prompts?: readonly PromptRecord[];
  items?: readonly WorkItemRecord[];
  claimsAdded?: readonly PathClaim[];
  claimsReleased?: readonly PathClaim[];
  races?: readonly RaceRecord[];
  releases?: readonly ReleaseRecord[];
  escalations?: readonly EscalationRecord[];
  settings?: HiveSettingsRecord;
}

export class StateCache {
  /**
   * Test hook (§4.3 acceptance): `sql.exec` calls made by load(). With 500
   * active trains, a warm reportBuildResult must add zero.
   */
  sqlReads = 0;

  /** The warm state, or null when cold or invalidated. */
  get(): ActiveState | null {
    throw new Error("not implemented");
  }

  /** Load the active state from SQLite (cold start) and keep it. */
  load(sql: SqlStorage): ActiveState {
    void sql;
    throw new Error("not implemented");
  }

  /** Fold the rows of a committed apply() into the cache. */
  apply(rows: AppliedRows): void {
    void rows;
    throw new Error("not implemented");
  }

  /** Drop the cache (after an apply error): the next get() returns null and the caller reloads. */
  invalidate(): void {
    throw new Error("not implemented");
  }
}

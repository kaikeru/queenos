/**
 * Warm state cache (v2 design §4.3, item 1). The QueenNode keeps its active
 * state in memory between calls: the DO is single-threaded and the only
 * writer, so after each apply() the cache equals the database. Cold start and
 * any apply error reload from SQLite. decide() becomes O(rows touched + READY
 * scan) instead of O(all rows).
 *
 * WP0 seam; WP1.13 implements it, WP2.1 wires it into decide().
 */
import { TERMINAL_WORK_STATUSES } from "@queenos/queen-types";
import {
  loadHiveSettings,
  rowToClaim,
  rowToEscalation,
  rowToPrompt,
  rowToRace,
  rowToRelease,
  rowToTrain,
  rowToWorkItem,
  ESCALATION_SELECT,
} from "../db";
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
  /** Open races: RACING, and PICKING (held for a human pick, T9a). */
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

const IN_FLIGHT_RELEASE = new Set(["STAGING", "VALIDATING", "AWAITING_TAP", "CANARY"]);
const TERMINAL_ITEM: ReadonlySet<string> = new Set(TERMINAL_WORK_STATUSES);
const TERMINAL_TRAIN = new Set(["MERGED", "EJECTED"]);

const bySeq = <T extends { seq: number }>(a: T, b: T): number => a.seq - b.seq;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const claimKey = (c: { path: string; itemId: string }): string => `${c.path}\u0000${c.itemId}`;

export class StateCache {
  /**
   * Test hook (§4.3 acceptance): `sql.exec` calls made by load(). With 500
   * active trains, a warm reportBuildResult must add zero.
   */
  sqlReads = 0;

  private warm = false;
  private trains = new Map<string, TrainRecord>();
  private prompts = new Map<string, PromptRecord>();
  private items = new Map<string, WorkItemRecord>();
  private claims = new Map<string, PathClaim>();
  private races = new Map<string, RaceRecord>();
  private releases = new Map<string, ReleaseRecord>();
  private escalations = new Map<string, EscalationRecord>();
  private settings: HiveSettingsRecord | null = null;
  private maxTrainSeq = 0;
  private maxPromptSeq = 0;
  private maxItemSeq = 0;
  /** Memoised view; rebuilt after an apply (sorted, so it equals a fresh load). */
  private view: ActiveState | null = null;

  /** The warm state, or null when cold or invalidated. */
  get(): ActiveState | null {
    if (!this.warm) return null;
    this.view ??= {
      trains: [...this.trains.values()].sort(bySeq),
      prompts: [...this.prompts.values()].sort(bySeq),
      items: [...this.items.values()].sort(bySeq),
      claims: [...this.claims.values()].sort((a, b) => cmp(a.path, b.path) || cmp(a.itemId, b.itemId)),
      races: [...this.races.values()].sort((a, b) => cmp(a.raceId, b.raceId)),
      releases: [...this.releases.values()].sort(bySeq),
      escalations: [...this.escalations.values()].sort((a, b) => a.createdAt - b.createdAt || cmp(a.escalationId, b.escalationId)),
      settings: this.settings,
      maxTrainSeq: this.maxTrainSeq,
      maxPromptSeq: this.maxPromptSeq,
      maxItemSeq: this.maxItemSeq,
    };
    return this.view;
  }

  /** Load the active state from SQLite (cold start) and keep it. */
  load(sql: SqlStorage): ActiveState {
    const q = (query: string, ...bindings: SqlStorageValue[]) => {
      this.sqlReads++;
      return sql.exec(query, ...bindings).toArray();
    };
    const max = (table: string) => Number(q(`SELECT COALESCE(MAX(seq), 0) AS m FROM ${table}`)[0]!.m);
    const activeTrain = "phase NOT IN ('MERGED', 'EJECTED')";
    const terminalItems = TERMINAL_WORK_STATUSES.map((s) => `'${s}'`).join(", ");

    this.reset();
    for (const r of q(`SELECT * FROM merge_trains WHERE ${activeTrain}`)) this.trains.set(String(r.train_id), rowToTrain(r));
    for (const r of q(
      `SELECT * FROM prompt_runs WHERE status = 'QUEUED' OR prompt_id IN (SELECT prompt_id FROM merge_trains WHERE ${activeTrain})`,
    )) {
      const p = rowToPrompt(r);
      this.prompts.set(p.promptId, p);
    }
    for (const r of q(`SELECT * FROM work_items WHERE status NOT IN (${terminalItems})`)) {
      const w = rowToWorkItem(r);
      this.items.set(w.itemId, w);
    }
    for (const r of q(
      "SELECT c.* FROM path_claims c JOIN work_items w ON w.item_id = c.item_id WHERE w.status = 'ACTIVE'",
    )) {
      const c = rowToClaim(r);
      this.claims.set(claimKey(c), c);
    }
    for (const r of q("SELECT * FROM races WHERE state IN ('RACING', 'PICKING')")) {
      const race = rowToRace(r);
      this.races.set(race.raceId, race);
    }
    for (const r of q(
      "SELECT * FROM releases WHERE phase IN ('STAGING', 'VALIDATING', 'AWAITING_TAP', 'CANARY') OR seq = (SELECT MAX(seq) FROM releases)",
    )) {
      const rel = rowToRelease(r);
      this.releases.set(rel.releaseId, rel);
    }
    for (const r of q(`${ESCALATION_SELECT} WHERE status = 'OPEN'`)) {
      const e = rowToEscalation(r);
      this.escalations.set(e.escalationId, e);
    }
    this.sqlReads++;
    this.settings = loadHiveSettings(sql);
    this.maxTrainSeq = max("merge_trains");
    this.maxPromptSeq = max("prompt_runs");
    this.maxItemSeq = max("work_items");
    this.warm = true;
    return this.get()!;
  }

  /** Fold the rows of a committed apply() into the cache. A cold cache ignores it (the next load reads the database). */
  apply(rows: AppliedRows): void {
    if (!this.warm) return;
    this.view = null;

    const touchedPrompts = new Set<string>();
    for (const t of rows.trains ?? []) {
      touchedPrompts.add(t.promptId);
      if (TERMINAL_TRAIN.has(t.phase)) this.trains.delete(t.trainId);
      else this.trains.set(t.trainId, t);
      this.maxTrainSeq = Math.max(this.maxTrainSeq, t.seq);
    }
    for (const p of rows.prompts ?? []) {
      touchedPrompts.add(p.promptId);
      this.prompts.set(p.promptId, p);
      this.maxPromptSeq = Math.max(this.maxPromptSeq, p.seq);
    }
    if (touchedPrompts.size > 0) {
      const referenced = new Set<string>();
      for (const t of this.trains.values()) referenced.add(t.promptId);
      for (const id of touchedPrompts) {
        const p = this.prompts.get(id);
        if (p && p.status !== "QUEUED" && !referenced.has(id)) this.prompts.delete(id);
      }
    }

    for (const w of rows.items ?? []) {
      if (TERMINAL_ITEM.has(w.status)) this.items.delete(w.itemId);
      else this.items.set(w.itemId, w);
      this.maxItemSeq = Math.max(this.maxItemSeq, w.seq);
    }
    for (const c of rows.claimsAdded ?? []) this.claims.set(claimKey(c), c);
    for (const c of rows.claimsReleased ?? []) this.claims.delete(claimKey(c));
    // A claim lives only while its item is ACTIVE (what load() reads).
    if (rows.items?.length || rows.claimsAdded?.length) {
      for (const [k, c] of this.claims) {
        if (this.items.get(c.itemId)?.status !== "ACTIVE") this.claims.delete(k);
      }
    }

    for (const r of rows.races ?? []) {
      if (r.state === "RACING" || r.state === "PICKING") this.races.set(r.raceId, r);
      else this.races.delete(r.raceId);
    }
    if (rows.releases?.length) {
      for (const r of rows.releases) this.releases.set(r.releaseId, r);
      const newest = Math.max(...[...this.releases.values()].map((r) => r.seq));
      for (const [id, r] of this.releases) {
        if (!IN_FLIGHT_RELEASE.has(r.phase) && r.seq !== newest) this.releases.delete(id);
      }
    }
    for (const e of rows.escalations ?? []) {
      if (e.status === "OPEN") this.escalations.set(e.escalationId, e);
      else this.escalations.delete(e.escalationId);
    }
    if (rows.settings) this.settings = rows.settings;
  }

  /** Drop the cache (after an apply error): the next get() returns null and the caller reloads. */
  invalidate(): void {
    this.reset();
  }

  private reset(): void {
    this.warm = false;
    this.view = null;
    this.trains.clear();
    this.prompts.clear();
    this.items.clear();
    this.claims.clear();
    this.races.clear();
    this.releases.clear();
    this.escalations.clear();
    this.settings = null;
    this.maxTrainSeq = this.maxPromptSeq = this.maxItemSeq = 0;
  }
}

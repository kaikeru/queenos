/**
 * QueenNode SQLite schema, migrations and validated row mapping.
 * Rows leaving SQLite are parsed with the queen-types row schemas.
 */
import {
  AuditEventSchema,
  BudgetBoostSchema,
  type BudgetBoost,
  AutonomyLevelSchema,
  DeploymentSchema,
  EscalationReasonSchema,
  EscalationSchema,
  GateScoreSchema,
  HiveSettingsOverridesSchema,
  HourlyMetricSchema,
  MergeConflictSchema,
  MergeTrainSchema,
  ModelChoiceSchema,
  ModelRoleSchema,
  ModelTierSchema,
  PromptRunSchema,
  QueenEventSchema,
  RaceSchema,
  RecalledMemorySchema,
  ReleaseSchema,
  SentinelVerdictSchema,
  WorkItemSchema,
  spanIdFor,
  traceIdFromUuid,
  type AuditEvent,
  type Deployment,
  type EscalationReason,
  type GateScore,
  type HiveSettingsOverrides,
  type HourlyMetric,
  type MergeConflict,
  type ModelChoice,
  type ModelStats,
  type QueenEvent,
  type RecalledMemory,
  type SentinelVerdict,
} from "@queenos/queen-types";
import { INITIAL_FLOOR, type FloorState, type RouterStats } from "./models/router";
import type { EscalationRecord, HiveSettingsRecord, MetricDelta, PathClaim, PathClaimSource, RaceRecord, WorkItemRecord } from "./records";
import type { ReleasePending, ReleaseRecord } from "./release/planner";
import type { DeployState, ForkState, ModelOutcome, ModelStatDelta, PromptRecord, TrainAction, TrainPhase, TrainRecord } from "./train/planner";

/**
 * One migration: a SQL script, or a function for a data step SQL cannot express
 * (deterministic ids from queen-types). Either runs inside the version's transaction.
 */
type Migration = string | ((sql: SqlStorage) => void);

/**
 * Append-only migration list. Version N is `MIGRATIONS[N - 1]`.
 * Applied versions are recorded in `_migrations` (PRAGMA user_version is not
 * relied on: Durable Object SQLite restricts PRAGMAs).
 */
const MIGRATIONS: readonly Migration[] = [
  `
  -- v1: replace the prototype events table with the Queen state machine.
  DROP TABLE IF EXISTS events;

  CREATE TABLE prompt_runs (
    prompt_id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    prompt_text TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    -- Added: submission order. created_at can tie within one millisecond.
    seq INTEGER NOT NULL,
    -- Added: latest Scribe summary (<= 500 chars, validated on input). Feeds REWORK drones.
    summary TEXT,
    -- Added: failed attempts so far; caps the rework loop (then status FAILED).
    attempts INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE merge_trains (
    train_id TEXT PRIMARY KEY,
    base_sha TEXT NOT NULL,
    included_prompts TEXT NOT NULL /* JSON array */,
    artifact_repo TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    -- Added: queue position. Active trains ordered by seq ARE the queue.
    seq INTEGER NOT NULL,
    -- Added: the prompt this train was provisioned for (its tail).
    prompt_id TEXT NOT NULL REFERENCES prompt_runs(prompt_id),
    -- Added: planner-internal lifecycle (WAITING_PARENT/BUILDING/TESTING/PASSED/LANDING/MERGED/EJECTED).
    -- status keeps TrainStateSchema's four values and is derived from phase.
    phase TEXT NOT NULL,
    -- Added: fork intent (NONE/PENDING/READY/DELETING/DELETED). Persisted before the
    -- Artifacts call so a crash mid-fork/delete is reconciled by the alarm.
    fork_state TEXT NOT NULL,
    -- Added: repo the fork is created from (hive repo or predecessor train fork).
    fork_source TEXT,
    -- Added: train head SHA pushed by the builder (lander pushes it to main).
    head_sha TEXT,
    -- Added: hive main SHA confirmed by the lander.
    landed_sha TEXT,
    -- Added: Scribe summary of the train verdict (<= 500 chars).
    summary TEXT,
    -- Added: why the train was EJECTED (failed / superseded).
    reason TEXT,
    -- Added: BUILD or REWORK; the builder drone action for this train.
    action TEXT NOT NULL,
    -- Added: whether the drone for the current phase was dispatched (alarm re-dispatches otherwise).
    dispatched INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX merge_trains_phase ON merge_trains(phase, seq);

  CREATE TABLE audit_trail (
    event_id TEXT PRIMARY KEY,
    prompt_id TEXT NOT NULL,
    drone_role TEXT NOT NULL,
    status TEXT NOT NULL,
    git_notes_payload TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(prompt_id) REFERENCES prompt_runs(prompt_id)
  );
  CREATE INDEX audit_trail_created ON audit_trail(created_at);
  `,
  `
  -- v2: the Queen orchestrates only. Forks/deletes go to the Provisioner
  -- Workflow and preview deploys/teardowns to the Herald Workflow. Each
  -- command id (= Workflow instance id) is persisted here before dispatch;
  -- results are matched against it (idempotent by command id).
  ALTER TABLE merge_trains ADD COLUMN fork_command_id TEXT;
  ALTER TABLE merge_trains ADD COLUMN delete_command_id TEXT;
  -- NONE/PENDING/LIVE/FAILED/TEARING_DOWN/TORN_DOWN/TEARDOWN_FAILED
  ALTER TABLE merge_trains ADD COLUMN deploy_state TEXT NOT NULL DEFAULT 'NONE';
  ALTER TABLE merge_trains ADD COLUMN deploy_command_id TEXT;
  ALTER TABLE merge_trains ADD COLUMN teardown_command_id TEXT;
  ALTER TABLE merge_trains ADD COLUMN preview_url TEXT;
  CREATE INDEX merge_trains_deploy_cmd ON merge_trains(deploy_command_id);
  CREATE INDEX merge_trains_teardown_cmd ON merge_trains(teardown_command_id);

  -- DeploymentSchema rows: one per environment (staging/canary/prod, from P3)
  -- plus one per train preview (deployment_id = 'preview-<train_id>').
  CREATE TABLE deployments (
    deployment_id TEXT PRIMARY KEY,
    hive TEXT NOT NULL,
    environment TEXT NOT NULL CHECK (environment IN ('preview', 'staging', 'canary', 'prod')),
    train_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'LIVE', 'FAILED', 'TORN_DOWN')),
    url TEXT,
    version_id TEXT,
    commit_sha TEXT,
    percent INTEGER,
    summary TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX deployments_train ON deployments(train_id);
  CREATE INDEX deployments_updated ON deployments(updated_at);
  `,
  `
  -- v3: command watchdog. When each kind's current command was issued (its id
  -- assigned) or the current drone dispatched; the alarm re-issues anything
  -- unreported after COMMAND_TIMEOUT_MS under a new id. NULL = no clock.
  ALTER TABLE merge_trains ADD COLUMN fork_issued_at INTEGER;
  ALTER TABLE merge_trains ADD COLUMN delete_issued_at INTEGER;
  ALTER TABLE merge_trains ADD COLUMN deploy_issued_at INTEGER;
  ALTER TABLE merge_trains ADD COLUMN teardown_issued_at INTEGER;
  ALTER TABLE merge_trains ADD COLUMN drone_issued_at INTEGER;
  -- Attempt of the current phase's drone (Workflow instance id suffix when > 1).
  ALTER TABLE merge_trains ADD COLUMN drone_attempt INTEGER NOT NULL DEFAULT 1;
  `,
  `
  -- v4: release train (P3). ReleaseSchema columns plus planner-internal ones.
  -- Environment state (staging / canary / prod) lives in deployments rows.
  CREATE TABLE releases (
    release_id TEXT PRIMARY KEY,
    hive TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    train_ids TEXT NOT NULL /* JSON array, landing order */,
    phase TEXT NOT NULL,
    canary_percent INTEGER,
    staging_url TEXT,
    prod_url TEXT,
    candidate_version_id TEXT,
    stable_version_id TEXT,
    tapped_by TEXT,
    tapped_at INTEGER,
    summary TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    -- Internal: creation order, canary step index, what is outstanding (DEPLOY/SENTINEL/ROLLBACK).
    seq INTEGER NOT NULL,
    step INTEGER,
    pending TEXT,
    -- Internal: current command ids (= executor Workflow instance ids) and watchdog clocks.
    deploy_command_id TEXT,
    deploy_issued_at INTEGER,
    sentinel_command_id TEXT,
    sentinel_issued_at INTEGER,
    rollback_command_id TEXT,
    rollback_issued_at INTEGER,
    -- Internal (CANARY only): a main head that landed during the canary, cut next.
    next_head_sha TEXT,
    next_train_ids TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX releases_phase ON releases(phase, seq);
  CREATE INDEX releases_seq ON releases(seq);
  `,
  `
  -- v5: latest Sentinel verdict per (release, environment), so a reloaded War Room can show it.
  CREATE TABLE sentinel_verdicts (
    release_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    verdict TEXT NOT NULL /* JSON SentinelVerdict */,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (release_id, environment)
  );
  `,
  `
  -- v6: model router. The builder model chosen per train (and why), and the
  -- hive's track record per (model, role) that the router learns from.
  ALTER TABLE merge_trains ADD COLUMN model TEXT;
  ALTER TABLE merge_trains ADD COLUMN model_reason TEXT;
  -- Internal: the full ModelChoice JSON, the drone attempt it was made for, and
  -- stats bookkeeping (NULL / BUILT / PASSED / FAILED) so results count once.
  ALTER TABLE merge_trains ADD COLUMN model_choice TEXT;
  ALTER TABLE merge_trains ADD COLUMN model_choice_attempt INTEGER;
  ALTER TABLE merge_trains ADD COLUMN model_outcome TEXT;
  ALTER TABLE merge_trains ADD COLUMN model_probe INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE model_stats (
    model TEXT NOT NULL,
    role TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    passes INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    -- Consecutive failures since the last pass (router penalty).
    fail_streak INTEGER NOT NULL DEFAULT 0,
    -- avgBuildMs = build_ms_total / timed_builds.
    build_ms_total INTEGER NOT NULL DEFAULT 0,
    timed_builds INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (model, role)
  );

  -- Router state, single row: decisions so far (exploration cadence) and the
  -- builder tier floor (AIMD): tier, passes at the floor, floor dispatches
  -- since the last probe, and the note shown on the next floor-routed choice.
  CREATE TABLE model_router (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    dispatches INTEGER NOT NULL DEFAULT 0,
    floor_tier TEXT NOT NULL DEFAULT 'fast',
    pass_streak INTEGER NOT NULL DEFAULT 0,
    above_streak INTEGER NOT NULL DEFAULT 0,
    floor_note TEXT
  );
  `,
  `
  -- v7: hive memory. The memories the Provisioner recalled for the train's
  -- prompt when it forked (JSON array of RecalledMemory, best first); they
  -- become the builder's ragContext. NULL on trains forked before v7.
  ALTER TABLE merge_trains ADD COLUMN memories TEXT;
  `,
  (sql) => {
    sql.exec(`
    -- v8: work ledger (v2 design §2.1, §2.11). prompt_runs.prompt_id = work_items.item_id for dispatched items.
    CREATE TABLE work_items (
      item_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, hive TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('goal','feature','bug','chore')),
      title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', acceptance TEXT NOT NULL DEFAULT '[]',
      priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
      status TEXT NOT NULL,
      parent_id TEXT, root_id TEXT NOT NULL, depth INTEGER NOT NULL DEFAULT 0,
      depends_on TEXT NOT NULL DEFAULT '[]',
      source_kind TEXT NOT NULL, source_actor TEXT NOT NULL, source_ref TEXT /* JSON */,
      trace_id TEXT NOT NULL, span_id TEXT NOT NULL,
      difficulty TEXT NOT NULL DEFAULT 'normal', best_of INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      duplicate_of TEXT, blocked_reason TEXT, release_id TEXT, escalation_id TEXT,
      -- current Oracle command (DECOMPOSE/TRIAGE) + watchdog clock
      command_id TEXT, command_issued_at INTEGER,
      normalized_title TEXT NOT NULL DEFAULT '',  -- exact dedupe key
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      landed_at INTEGER, shipped_at INTEGER         -- lead/cycle time
    );
    CREATE INDEX work_items_status ON work_items(status, priority, seq);
    CREATE INDEX work_items_parent ON work_items(parent_id);
    CREATE INDEX work_items_trace ON work_items(trace_id);
    CREATE INDEX work_items_command ON work_items(command_id);
    -- Backfill: every v1 prompt is a user feature item with the same id.
    INSERT INTO work_items (item_id, seq, hive, kind, title, body, priority, status, root_id, depth,
      source_kind, source_actor, trace_id, span_id, attempts, created_at, updated_at, normalized_title)
    SELECT prompt_id, seq, namespace, 'feature', substr(prompt_text, 1, 120), substr(prompt_text, 1, 4000), 2,
      CASE status WHEN 'MERGED' THEN 'LANDED' WHEN 'FAILED' THEN 'FAILED' ELSE 'ACTIVE' END,
      prompt_id, 0, 'user', 'legacy', lower(replace(prompt_id, '-', '')), lower(substr(replace(prompt_id, '-', ''), 1, 16)),
      attempts, created_at, created_at, lower(substr(prompt_text, 1, 120))
    FROM prompt_runs;
    ALTER TABLE prompt_runs ADD COLUMN race_width INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE prompt_runs ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'normal';
    `);
    // Data step: the ids and titles the v2 code computes (traceIdFromUuid, spanIdFor, the
    // first-line title of §2.2), so a backfilled item looks like one filed by the WorkPlanner.
    for (const r of sql.exec("SELECT item_id, title, body FROM work_items").toArray()) {
      const id = String(r.item_id);
      const title = titleFrom(String(r.body));
      sql.exec(
        "UPDATE work_items SET trace_id = ?, span_id = ?, title = ?, normalized_title = ? WHERE item_id = ?",
        traceIdFromUuid(id),
        spanIdFor(id),
        title,
        normalizeTitle(title),
        id,
      );
    }
  },
  (sql) => {
    sql.exec(`
    -- v9: races (best-of-N) + trace on trains and releases.
    ALTER TABLE merge_trains ADD COLUMN trace_id TEXT;
    ALTER TABLE merge_trains ADD COLUMN race_id TEXT;
    ALTER TABLE merge_trains ADD COLUMN candidate INTEGER;
    ALTER TABLE merge_trains ADD COLUMN race_outcome TEXT;  -- RACING/PASSED/FAILED/WON/LOST
    ALTER TABLE merge_trains ADD COLUMN gate_score TEXT;    -- JSON GateScore
    ALTER TABLE merge_trains ADD COLUMN credits REAL;       -- build credits (budget + ranking)
    CREATE INDEX merge_trains_race ON merge_trains(race_id);
    UPDATE merge_trains SET trace_id = (SELECT trace_id FROM work_items w WHERE w.item_id = merge_trains.prompt_id);
    CREATE TABLE races (
      race_id TEXT PRIMARY KEY, item_id TEXT NOT NULL, width INTEGER NOT NULL,
      state TEXT NOT NULL, train_ids TEXT NOT NULL DEFAULT '[]', winner_train_id TEXT, reason TEXT,
      deadline_at INTEGER, created_at INTEGER NOT NULL, decided_at INTEGER
    );
    CREATE INDEX races_state ON races(state);
    ALTER TABLE releases ADD COLUMN trace_id TEXT;
    `);
    // Each release gets its own trace, minted from releaseId (§2.6).
    for (const r of sql.exec("SELECT release_id FROM releases").toArray()) {
      sql.exec("UPDATE releases SET trace_id = ? WHERE release_id = ?", traceIdFromUuid(String(r.release_id)), r.release_id);
    }
  },
  `
  -- v10: autonomy, escalations, event log (supersedes audit_trail), metrics rollups.
  CREATE TABLE hive_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1), hive TEXT NOT NULL,
    autonomy TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}' /* JSON overrides of HiveSettings */,
    budget_day TEXT, credits_used REAL NOT NULL DEFAULT 0, dispatches INTEGER NOT NULL DEFAULT 0,
    auto_filed_hour INTEGER, auto_filed_count INTEGER NOT NULL DEFAULT 0,
    rollback_streak INTEGER NOT NULL DEFAULT 0, degraded_by TEXT NOT NULL DEFAULT '[]',
    updated_by TEXT, updated_at INTEGER NOT NULL
  );
  -- Existing hives (they have prompts) migrate SUPERVISED (decision D2); new hives get a row at first filing, AUTONOMOUS.
  INSERT INTO hive_settings (id, hive, autonomy, updated_by, updated_at)
  SELECT 1, namespace, 'supervised', 'migration-v10', created_at FROM prompt_runs ORDER BY seq LIMIT 1;
  CREATE TABLE escalations (
    escalation_id TEXT PRIMARY KEY, reason TEXT NOT NULL, status TEXT NOT NULL,
    subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, trace_id TEXT,
    summary TEXT NOT NULL, actions TEXT NOT NULL /* JSON */,
    created_at INTEGER NOT NULL, resolved_at INTEGER, resolved_by TEXT, resolution TEXT
  );
  CREATE INDEX escalations_status ON escalations(status, created_at);
  CREATE INDEX escalations_subject ON escalations(subject_type, subject_id);
  CREATE TABLE event_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, ts INTEGER NOT NULL, hive TEXT NOT NULL,
    type TEXT NOT NULL, severity TEXT NOT NULL, actor TEXT NOT NULL,
    trace_id TEXT, span_id TEXT, parent_span_id TEXT,
    item_id TEXT, train_id TEXT, release_id TEXT, command_id TEXT,
    summary TEXT NOT NULL DEFAULT '', data TEXT,
    drone_role TEXT, audit_status TEXT, git_notes_payload TEXT
  );
  CREATE INDEX event_log_trace ON event_log(trace_id, seq);
  CREATE INDEX event_log_item ON event_log(item_id, seq);
  CREATE INDEX event_log_release ON event_log(release_id, seq);
  CREATE INDEX event_log_type ON event_log(type, seq);
  CREATE INDEX event_log_ts ON event_log(ts);
  -- audit_trail rows become drone.audit events (same event ids, same order). The trace is the item's (v8).
  INSERT INTO event_log (event_id, ts, hive, type, severity, actor, trace_id, item_id, summary, drone_role, audit_status, git_notes_payload)
  SELECT a.event_id, a.created_at, p.namespace, 'drone.audit', 'info', 'drone:' || a.drone_role,
    (SELECT w.trace_id FROM work_items w WHERE w.item_id = a.prompt_id), a.prompt_id, a.drone_role || ' ' || a.status,
    a.drone_role, a.status, a.git_notes_payload
  FROM audit_trail a JOIN prompt_runs p ON p.prompt_id = a.prompt_id ORDER BY a.created_at, a.rowid;
  CREATE TABLE metrics_hourly (
    bucket INTEGER NOT NULL, name TEXT NOT NULL, labels TEXT NOT NULL /* canonical JSON */,
    count REAL NOT NULL DEFAULT 0, sum REAL NOT NULL DEFAULT 0, min REAL, max REAL,
    PRIMARY KEY (bucket, name, labels)
  );
  `,
  `
  -- v11: parallel builds, merge queue, path affinity, swarm lease.
  ALTER TABLE merge_trains ADD COLUMN lane TEXT NOT NULL DEFAULT 'BUILD';  -- BUILD | QUEUE
  ALTER TABLE merge_trains ADD COLUMN members TEXT;                         -- QUEUE: JSON trainIds, merge order
  ALTER TABLE merge_trains ADD COLUMN car_id TEXT;                          -- BUILD: the car carrying it
  ALTER TABLE merge_trains ADD COLUMN passed_seq INTEGER;                   -- BUILD: queue ticket when PASSED (race winner: when decided)
  ALTER TABLE merge_trains ADD COLUMN conflict TEXT;                        -- BUILD: JSON MergeConflict that ejected it
  ALTER TABLE merge_trains ADD COLUMN changed_paths TEXT;                   -- BUILD: JSON, from BuildResult
  ALTER TABLE merge_trains ADD COLUMN wait_for_car_seq INTEGER;             -- BUILD: conflict/integration rework waits for this car seq
  ALTER TABLE merge_trains ADD COLUMN bisect_of TEXT;                       -- pool BUILD train: "<failedCarId>#<half>" pin; QUEUE car: the failed car id
  CREATE INDEX merge_trains_lane ON merge_trains(lane, phase, seq);
  CREATE INDEX merge_trains_car ON merge_trains(car_id);
  CREATE INDEX merge_trains_board ON merge_trains(lane, phase, car_id, passed_seq);
  -- Existing rows keep lane BUILD. Deploy v11 with no active v1 trains (R16; deploy.sh checks the snapshot).
  ALTER TABLE work_items ADD COLUMN paths TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE work_items ADD COLUMN wait_reason TEXT;
  ALTER TABLE work_items ADD COLUMN conflicts INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE path_claims (
    path TEXT NOT NULL, item_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('predicted','actual','conflict')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (path, item_id)
  );
  CREATE INDEX path_claims_item ON path_claims(item_id);
  ALTER TABLE hive_settings ADD COLUMN leased_slots INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE hive_settings ADD COLUMN lease_expires_at INTEGER;
  ALTER TABLE hive_settings ADD COLUMN car_infra_failures INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- v12: Sentinel verified flag, today-only budget boost.
  ALTER TABLE merge_trains ADD COLUMN verified INTEGER;        -- NULL = not checked; 1 / 0 = Sentinel verdict
  -- budget_boost: JSON BudgetBoost (day, dailyCredits, dailyDispatches); in effect only on that UTC day.
  ALTER TABLE hive_settings ADD COLUMN budget_boost TEXT;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Idempotent and cheap: one indexed read on every wake once up to date.
 * Must be called synchronously from the constructor (sql.exec is synchronous).
 * `target` (tests only) stops at that version, e.g. to build a v7 fixture.
 * Returns the version the database is at.
 */
export function migrate(storage: DurableObjectStorage, target: number = MIGRATIONS.length): number {
  const sql = storage.sql;
  sql.exec("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const current = Number(sql.exec("SELECT COALESCE(MAX(version), 0) AS v FROM _migrations").one().v);
  const upTo = Math.min(target, MIGRATIONS.length);
  for (let v = current + 1; v <= upTo; v++) {
    const m = MIGRATIONS[v - 1]!;
    storage.transactionSync(() => {
      if (typeof m === "string") sql.exec(m);
      else m(sql);
      sql.exec("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)", v, Date.now());
    });
  }
  return Math.max(current, upTo);
}

/** First non-empty line, at most 120 chars (§2.2: a `decompose: false` item's title). */
export function titleFrom(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? text;
  return (line.trim() || text).slice(0, 120) || "untitled";
}

/** Exact-dedupe key (§2.9): lowercased, whitespace collapsed. */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

type Row = Record<string, SqlStorageValue>;

const str = (v: SqlStorageValue): string | null => (v === null ? null : String(v));
const num = (v: SqlStorageValue | undefined): number | null => (v === null || v === undefined ? null : Number(v));

export function rowToPrompt(r: Row): PromptRecord {
  const base = PromptRunSchema.parse({
    promptId: r.prompt_id,
    namespace: r.namespace,
    promptText: r.prompt_text,
    status: r.status,
    createdAt: r.created_at,
  });
  return {
    ...base,
    seq: Number(r.seq),
    summary: str(r.summary),
    attempts: Number(r.attempts),
    // v8 columns (absent only before migrate()).
    ...(r.race_width !== undefined && r.race_width !== null ? { raceWidth: Number(r.race_width) } : {}),
    ...(r.difficulty !== undefined && r.difficulty !== null ? { difficulty: String(r.difficulty) } : {}),
  };
}

export function rowToTrain(r: Row): TrainRecord {
  const base = MergeTrainSchema.parse({
    trainId: r.train_id,
    baseSha: r.base_sha,
    includedPrompts: JSON.parse(String(r.included_prompts)),
    artifactRepo: r.artifact_repo,
    status: r.status,
    createdAt: r.created_at,
    phase: r.phase,
    reason: str(r.reason),
    summary: str(r.summary),
    headSha: str(r.head_sha),
    landedSha: str(r.landed_sha),
    previewUrl: str(r.preview_url),
    model: str(r.model ?? null),
    modelReason: str(r.model_reason ?? null),
  });
  return {
    ...base,
    seq: Number(r.seq),
    promptId: String(r.prompt_id),
    phase: String(r.phase) as TrainPhase,
    forkState: String(r.fork_state) as ForkState,
    forkSource: str(r.fork_source),
    headSha: str(r.head_sha),
    landedSha: str(r.landed_sha),
    summary: str(r.summary),
    reason: str(r.reason),
    action: String(r.action) as TrainAction,
    dispatched: Number(r.dispatched) === 1,
    forkCommandId: str(r.fork_command_id),
    deleteCommandId: str(r.delete_command_id),
    deployState: String(r.deploy_state ?? "NONE") as DeployState,
    deployCommandId: str(r.deploy_command_id),
    teardownCommandId: str(r.teardown_command_id),
    previewUrl: str(r.preview_url),
    forkIssuedAt: num(r.fork_issued_at),
    deleteIssuedAt: num(r.delete_issued_at),
    deployIssuedAt: num(r.deploy_issued_at),
    teardownIssuedAt: num(r.teardown_issued_at),
    droneIssuedAt: num(r.drone_issued_at),
    droneAttempt: num(r.drone_attempt) ?? 1,
    model: str(r.model ?? null),
    modelReason: str(r.model_reason ?? null),
    modelChoice: parseChoice(r.model_choice ?? null),
    modelChoiceAttempt: num(r.model_choice_attempt),
    modelOutcome: str(r.model_outcome ?? null) as ModelOutcome | null,
    modelProbe: Number(r.model_probe ?? 0) === 1,
    memories: parseMemories(r.memories ?? null),
    // v9 / v11 (absent columns read as null: rows are only mapped after migrate()).
    traceId: str(r.trace_id ?? null),
    raceId: str(r.race_id ?? null),
    candidate: num(r.candidate),
    raceOutcome: (str(r.race_outcome ?? null) as TrainRecord["raceOutcome"]) ?? null,
    score: parseJson(r.gate_score ?? null, schemaCheck<GateScore>(GateScoreSchema)),
    credits: num(r.credits),
    lane: r.lane === "QUEUE" ? "QUEUE" : "BUILD",
    ...(r.members !== null && r.members !== undefined ? { members: parseJson(r.members, stringArray) ?? [] } : {}),
    carId: str(r.car_id ?? null),
    passedSeq: num(r.passed_seq),
    conflict: parseJson(r.conflict ?? null, schemaCheck<MergeConflict>(MergeConflictSchema)),
    ...(r.changed_paths !== null && r.changed_paths !== undefined ? { changedPaths: parseJson(r.changed_paths, stringArray) ?? [] } : {}),
    waitForCarSeq: num(r.wait_for_car_seq),
    bisectOf: str(r.bisect_of ?? null),
    ...(r.verified !== null && r.verified !== undefined ? { verified: Number(r.verified) === 1 } : {}),
  };
}

/** Validates a parsed JSON value: the value, or null when it does not fit. */
type JsonCheck<T> = (v: unknown) => T | null;

/** A queen-types schema as a JsonCheck. */
function schemaCheck<T>(schema: { safeParse(v: unknown): { success: boolean; data?: T } }): JsonCheck<T> {
  return (v) => {
    const parsed = schema.safeParse(v);
    return parsed.success ? (parsed.data as T) : null;
  };
}

const stringArray: JsonCheck<string[]> = (v) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null);
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const stringRecord: JsonCheck<Record<string, string>> = (v) =>
  isPlainObject(v) && Object.values(v).every((x) => typeof x === "string") ? (v as Record<string, string>) : null;
const unknownRecord: JsonCheck<Record<string, unknown>> = (v) => (isPlainObject(v) ? v : null);

/** A JSON column checked by `check`; null when absent, unparsable or invalid (a bad row never breaks a load). */
function parseJson<T>(v: SqlStorageValue | undefined, check: JsonCheck<T>): T | null {
  if (v === null || v === undefined) return null;
  try {
    return check(JSON.parse(String(v)));
  } catch {
    return null;
  }
}

const json = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));

/** Stored memories, defensively: bad JSON or a non-array is [], and entries that no longer validate are dropped. */
export function parseMemories(v: SqlStorageValue): RecalledMemory[] {
  if (v === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(String(v));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((m) => {
    const parsed = RecalledMemorySchema.safeParse(m);
    return parsed.success ? [parsed.data] : [];
  });
}

function parseChoice(v: SqlStorageValue): ModelChoice | null {
  if (v === null) return null;
  try {
    const parsed = ModelChoiceSchema.safeParse(JSON.parse(String(v)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function rowToDeployment(r: Row): Deployment {
  return DeploymentSchema.parse({
    deploymentId: r.deployment_id,
    hive: r.hive,
    environment: r.environment,
    trainId: str(r.train_id),
    status: r.status,
    url: str(r.url),
    versionId: str(r.version_id),
    commitSha: str(r.commit_sha),
    percent: r.percent === null ? null : Number(r.percent),
    summary: str(r.summary),
    updatedAt: r.updated_at,
  });
}

export function upsertDeployment(sql: SqlStorage, d: Deployment): void {
  sql.exec(
    `INSERT INTO deployments (deployment_id, hive, environment, train_id, status, url, version_id, commit_sha, percent, summary, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(deployment_id) DO UPDATE SET status = excluded.status, url = excluded.url, version_id = excluded.version_id,
       commit_sha = excluded.commit_sha, percent = excluded.percent, summary = excluded.summary, updated_at = excluded.updated_at`,
    d.deploymentId,
    d.hive,
    d.environment,
    d.trainId,
    d.status,
    d.url,
    d.versionId,
    d.commitSha,
    d.percent,
    d.summary,
    d.updatedAt,
  );
}

/**
 * An AuditEvent from a `drone.audit` row of `event_log` (v10+, the source of
 * truth) or, for a Queen rolled back to v1 code, from an `audit_trail` row.
 */
export function rowToAudit(r: Row): AuditEvent {
  const fromLog = "audit_status" in r;
  return AuditEventSchema.parse({
    eventId: r.event_id,
    promptId: fromLog ? r.item_id : r.prompt_id,
    droneRole: r.drone_role,
    status: fromLog ? r.audit_status : r.status,
    gitNotesPayload: r.git_notes_payload === null ? null : JSON.parse(String(r.git_notes_payload)),
    createdAt: fromLog ? r.ts : r.created_at,
  });
}

/** The newest `limit` ledger entries, oldest first (snapshot `recentAudit`). */
export function listRecentAudit(sql: SqlStorage, limit: number): AuditEvent[] {
  return sql
    .exec("SELECT * FROM event_log WHERE type = 'drone.audit' ORDER BY seq DESC LIMIT ?", limit)
    .toArray()
    .map(rowToAudit)
    .reverse();
}

/**
 * Append a Cognitive Ledger entry: a `drone.audit` event (its trace is the item's,
 * else minted from the prompt id) plus, until `audit_trail` is dropped, the v1 row,
 * so a Queen rolled back to v1 code still sees every entry (§2.7).
 */
export function appendAuditRow(sql: SqlStorage, e: AuditEvent, hive: string): void {
  const notes = e.gitNotesPayload === null ? null : JSON.stringify(e.gitNotesPayload);
  sql.exec(
    "INSERT INTO audit_trail (event_id, prompt_id, drone_role, status, git_notes_payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    e.eventId,
    e.promptId,
    e.droneRole,
    e.status,
    notes,
    e.createdAt,
  );
  sql.exec(
    `INSERT INTO event_log (event_id, ts, hive, type, severity, actor, trace_id, item_id, summary, drone_role, audit_status, git_notes_payload)
     VALUES (?, ?, ?, 'drone.audit', 'info', ?, COALESCE((SELECT trace_id FROM work_items WHERE item_id = ?), ?), ?, ?, ?, ?, ?)`,
    e.eventId,
    e.createdAt,
    hive,
    `drone:${e.droneRole}`,
    e.promptId,
    traceIdFromUuid(e.promptId),
    e.promptId,
    `${e.droneRole} ${e.status}`,
    e.droneRole,
    e.status,
    notes,
  );
}

export function upsertPrompt(sql: SqlStorage, p: PromptRecord): void {
  sql.exec(
    `INSERT INTO prompt_runs (prompt_id, namespace, prompt_text, status, created_at, seq, summary, attempts, race_width, difficulty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(prompt_id) DO UPDATE SET status = excluded.status, summary = excluded.summary, attempts = excluded.attempts,
       race_width = excluded.race_width, difficulty = excluded.difficulty`,
    p.promptId,
    p.namespace,
    p.promptText,
    p.status,
    p.createdAt,
    p.seq,
    p.summary,
    p.attempts,
    p.raceWidth ?? 1,
    p.difficulty ?? "normal",
  );
}

export function upsertTrain(sql: SqlStorage, t: TrainRecord): void {
  sql.exec(
    `INSERT INTO merge_trains (train_id, base_sha, included_prompts, artifact_repo, status, created_at, seq, prompt_id,
       phase, fork_state, fork_source, head_sha, landed_sha, summary, reason, action, dispatched,
       fork_command_id, delete_command_id, deploy_state, deploy_command_id, teardown_command_id, preview_url,
       fork_issued_at, delete_issued_at, deploy_issued_at, teardown_issued_at, drone_issued_at, drone_attempt,
       model, model_reason, model_choice, model_choice_attempt, model_outcome, model_probe, memories,
       trace_id, race_id, candidate, race_outcome, gate_score, credits,
       lane, members, car_id, passed_seq, conflict, changed_paths, wait_for_car_seq, bisect_of, verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(train_id) DO UPDATE SET base_sha = excluded.base_sha, artifact_repo = excluded.artifact_repo,
       status = excluded.status, phase = excluded.phase,
       fork_state = excluded.fork_state, fork_source = excluded.fork_source, head_sha = excluded.head_sha,
       landed_sha = excluded.landed_sha, summary = excluded.summary, reason = excluded.reason,
       dispatched = excluded.dispatched, fork_command_id = excluded.fork_command_id,
       delete_command_id = excluded.delete_command_id, deploy_state = excluded.deploy_state,
       deploy_command_id = excluded.deploy_command_id, teardown_command_id = excluded.teardown_command_id,
       preview_url = excluded.preview_url, fork_issued_at = excluded.fork_issued_at,
       delete_issued_at = excluded.delete_issued_at, deploy_issued_at = excluded.deploy_issued_at,
       teardown_issued_at = excluded.teardown_issued_at, drone_issued_at = excluded.drone_issued_at,
       drone_attempt = excluded.drone_attempt, model = excluded.model, model_reason = excluded.model_reason,
       model_choice = excluded.model_choice, model_choice_attempt = excluded.model_choice_attempt,
       model_outcome = excluded.model_outcome, model_probe = excluded.model_probe, memories = excluded.memories,
       trace_id = excluded.trace_id, race_id = excluded.race_id, candidate = excluded.candidate,
       race_outcome = excluded.race_outcome, gate_score = excluded.gate_score, credits = excluded.credits,
       lane = excluded.lane, members = excluded.members, car_id = excluded.car_id, passed_seq = excluded.passed_seq,
       conflict = excluded.conflict, changed_paths = excluded.changed_paths,
       wait_for_car_seq = excluded.wait_for_car_seq, bisect_of = excluded.bisect_of, verified = excluded.verified`,
    t.trainId,
    t.baseSha,
    JSON.stringify(t.includedPrompts),
    t.artifactRepo,
    t.status,
    t.createdAt,
    t.seq,
    t.promptId,
    t.phase,
    t.forkState,
    t.forkSource,
    t.headSha,
    t.landedSha,
    t.summary,
    t.reason,
    t.action,
    t.dispatched ? 1 : 0,
    t.forkCommandId,
    t.deleteCommandId,
    t.deployState,
    t.deployCommandId,
    t.teardownCommandId,
    t.previewUrl,
    t.forkIssuedAt,
    t.deleteIssuedAt,
    t.deployIssuedAt,
    t.teardownIssuedAt,
    t.droneIssuedAt,
    t.droneAttempt,
    t.model,
    t.modelReason,
    t.modelChoice ? JSON.stringify(t.modelChoice) : null,
    t.modelChoiceAttempt,
    t.modelOutcome,
    t.modelProbe ? 1 : 0,
    JSON.stringify(t.memories ?? []),
    t.traceId ?? null,
    t.raceId ?? null,
    t.candidate ?? null,
    t.raceOutcome ?? null,
    json(t.score),
    t.credits ?? null,
    t.lane ?? "BUILD",
    json(t.members),
    t.carId ?? null,
    t.passedSeq ?? null,
    json(t.conflict),
    json(t.changedPaths),
    t.waitForCarSeq ?? null,
    t.bisectOf ?? null,
    t.verified === null || t.verified === undefined ? null : t.verified ? 1 : 0,
  );
}

// ── model router ────────────────────────────────────────────────────────

/** The hive's track record, with the internal failure streak (router input). */
export function listRouterStats(sql: SqlStorage): RouterStats[] {
  return sql
    .exec("SELECT * FROM model_stats ORDER BY role, model")
    .toArray()
    .flatMap((r) => {
      const role = ModelRoleSchema.safeParse(r.role);
      if (!role.success) return [];
      const timed = Number(r.timed_builds);
      return [
        {
          model: String(r.model),
          role: role.data,
          attempts: Number(r.attempts),
          passes: Number(r.passes),
          failures: Number(r.failures),
          avgBuildMs: timed > 0 ? Math.round(Number(r.build_ms_total) / timed) : null,
          updatedAt: Number(r.updated_at),
          failStreak: Number(r.fail_streak),
        },
      ];
    });
}

/** ModelStats rows for the War Room (snapshot / models.updated). */
export function listModelStats(sql: SqlStorage): ModelStats[] {
  return listRouterStats(sql).map((s) => ({
    model: s.model,
    role: s.role,
    attempts: s.attempts,
    passes: s.passes,
    failures: s.failures,
    avgBuildMs: s.avgBuildMs,
    updatedAt: s.updatedAt,
  }));
}

export function applyModelStatDelta(sql: SqlStorage, d: ModelStatDelta, now: number): void {
  const timed = d.buildMs !== undefined ? 1 : 0;
  const ms = d.buildMs ?? 0;
  const streak = d.streak === "fail" ? 1 : 0;
  sql.exec(
    `INSERT INTO model_stats (model, role, attempts, passes, failures, fail_streak, build_ms_total, timed_builds, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(model, role) DO UPDATE SET attempts = attempts + excluded.attempts, passes = passes + excluded.passes,
       failures = failures + excluded.failures,
       fail_streak = CASE ? WHEN 'pass' THEN 0 WHEN 'fail' THEN fail_streak + 1 ELSE fail_streak END,
       build_ms_total = build_ms_total + excluded.build_ms_total, timed_builds = timed_builds + excluded.timed_builds,
       updated_at = excluded.updated_at`,
    d.model,
    d.role,
    d.attempts,
    d.passes,
    d.failures,
    streak,
    ms,
    timed,
    now,
    d.streak ?? "",
  );
}

export interface RouterRow {
  dispatches: number;
  floor: FloorState;
}

export function loadRouter(sql: SqlStorage): RouterRow {
  const r = sql.exec("SELECT * FROM model_router WHERE id = 1").toArray()[0];
  if (!r) return { dispatches: 0, floor: { ...INITIAL_FLOOR } };
  const tier = ModelTierSchema.safeParse(r.floor_tier);
  return {
    dispatches: Number(r.dispatches),
    floor: {
      tier: tier.success ? tier.data : INITIAL_FLOOR.tier,
      passStreak: Number(r.pass_streak),
      aboveStreak: Number(r.above_streak),
      note: str(r.floor_note),
    },
  };
}

export function saveRouter(sql: SqlStorage, patch: { dispatches?: number; floor?: FloorState }): void {
  const cur = loadRouter(sql);
  const next = { dispatches: patch.dispatches ?? cur.dispatches, floor: patch.floor ?? cur.floor };
  sql.exec(
    `INSERT INTO model_router (id, dispatches, floor_tier, pass_streak, above_streak, floor_note) VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET dispatches = excluded.dispatches, floor_tier = excluded.floor_tier,
       pass_streak = excluded.pass_streak, above_streak = excluded.above_streak, floor_note = excluded.floor_note`,
    next.dispatches,
    next.floor.tier,
    next.floor.passStreak,
    next.floor.aboveStreak,
    next.floor.note,
  );
}

export function rowToRelease(r: Row): ReleaseRecord {
  const base = ReleaseSchema.parse({
    releaseId: r.release_id,
    hive: r.hive,
    headSha: r.head_sha,
    trainIds: JSON.parse(String(r.train_ids)),
    phase: r.phase,
    canaryPercent: num(r.canary_percent),
    stagingUrl: str(r.staging_url),
    prodUrl: str(r.prod_url),
    candidateVersionId: str(r.candidate_version_id),
    stableVersionId: str(r.stable_version_id),
    tappedBy: str(r.tapped_by),
    tappedAt: num(r.tapped_at),
    summary: str(r.summary),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
  return {
    ...base,
    seq: Number(r.seq),
    step: num(r.step),
    pending: str(r.pending) as ReleasePending | null,
    deployCommandId: str(r.deploy_command_id),
    deployIssuedAt: num(r.deploy_issued_at),
    sentinelCommandId: str(r.sentinel_command_id),
    sentinelIssuedAt: num(r.sentinel_issued_at),
    rollbackCommandId: str(r.rollback_command_id),
    rollbackIssuedAt: num(r.rollback_issued_at),
    nextHeadSha: str(r.next_head_sha),
    nextTrainIds: JSON.parse(String(r.next_train_ids ?? "[]")) as string[],
    traceId: str(r.trace_id ?? null),
  };
}

const RELEASE_COLUMNS = [
  "release_id", "hive", "head_sha", "train_ids", "phase", "canary_percent", "staging_url", "prod_url",
  "candidate_version_id", "stable_version_id", "tapped_by", "tapped_at", "summary", "created_at", "updated_at",
  "seq", "step", "pending", "deploy_command_id", "deploy_issued_at", "sentinel_command_id", "sentinel_issued_at",
  "rollback_command_id", "rollback_issued_at", "next_head_sha", "next_train_ids", "trace_id",
] as const;

export function upsertRelease(sql: SqlStorage, r: ReleaseRecord): void {
  const updates = RELEASE_COLUMNS.filter((c) => c !== "release_id" && c !== "hive" && c !== "created_at" && c !== "seq")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  sql.exec(
    `INSERT INTO releases (${RELEASE_COLUMNS.join(", ")}) VALUES (${RELEASE_COLUMNS.map(() => "?").join(", ")})
     ON CONFLICT(release_id) DO UPDATE SET ${updates}`,
    r.releaseId,
    r.hive,
    r.headSha,
    JSON.stringify(r.trainIds),
    r.phase,
    r.canaryPercent,
    r.stagingUrl,
    r.prodUrl,
    r.candidateVersionId,
    r.stableVersionId,
    r.tappedBy,
    r.tappedAt,
    r.summary,
    r.createdAt,
    r.updatedAt,
    r.seq,
    r.step,
    r.pending,
    r.deployCommandId,
    r.deployIssuedAt,
    r.sentinelCommandId,
    r.sentinelIssuedAt,
    r.rollbackCommandId,
    r.rollbackIssuedAt,
    r.nextHeadSha,
    JSON.stringify(r.nextTrainIds),
    // A release's own trace is minted from its id (§2.6).
    r.traceId ?? traceIdFromUuid(r.releaseId),
  );
}

export function upsertVerdict(sql: SqlStorage, v: SentinelVerdict, now: number): void {
  sql.exec(
    `INSERT INTO sentinel_verdicts (release_id, environment, verdict, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(release_id, environment) DO UPDATE SET verdict = excluded.verdict, updated_at = excluded.updated_at`,
    v.releaseId,
    v.environment,
    JSON.stringify(v),
    now,
  );
}

/** Latest verdicts for the given releases (rows that no longer validate are skipped). */
export function listVerdicts(sql: SqlStorage, releaseIds: string[]): SentinelVerdict[] {
  if (releaseIds.length === 0) return [];
  const rows = sql
    .exec(`SELECT verdict FROM sentinel_verdicts WHERE release_id IN (${releaseIds.map(() => "?").join(",")}) ORDER BY updated_at`, ...releaseIds)
    .toArray();
  return rows.flatMap((r) => {
    const parsed = SentinelVerdictSchema.safeParse(JSON.parse(String(r.verdict)));
    return parsed.success ? [parsed.data] : [];
  });
}

// ── v2: work ledger, races, autonomy, escalations, event log, metrics, path claims ──

export function rowToWorkItem(r: Row): WorkItemRecord {
  const ref = parseJson(r.source_ref ?? null, stringRecord) ?? {};
  const base = WorkItemSchema.parse({
    itemId: r.item_id,
    hive: r.hive,
    kind: r.kind,
    title: r.title,
    body: r.body,
    acceptance: parseJson(r.acceptance, stringArray) ?? [],
    priority: Number(r.priority),
    status: r.status,
    parentId: str(r.parent_id),
    rootId: r.root_id,
    depth: Number(r.depth),
    dependsOn: parseJson(r.depends_on, stringArray) ?? [],
    source: {
      kind: r.source_kind,
      actor: r.source_actor,
      ...(ref.itemId ? { itemId: ref.itemId } : {}),
      ...(ref.trainId ? { trainId: ref.trainId } : {}),
      ...(ref.releaseId ? { releaseId: ref.releaseId } : {}),
      ...(ref.commandId ? { commandId: ref.commandId } : {}),
    },
    traceId: r.trace_id,
    spanId: r.span_id,
    difficulty: r.difficulty,
    bestOf: num(r.best_of),
    attempts: Number(r.attempts),
    conflicts: Number(r.conflicts ?? 0),
    paths: parseJson(r.paths ?? null, stringArray) ?? [],
    waitReason: str(r.wait_reason ?? null),
    duplicateOf: str(r.duplicate_of),
    blockedReason: str(r.blocked_reason),
    releaseId: str(r.release_id),
    escalationId: str(r.escalation_id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
  return {
    ...base,
    seq: Number(r.seq),
    commandId: str(r.command_id),
    commandIssuedAt: num(r.command_issued_at),
    normalizedTitle: String(r.normalized_title ?? ""),
    landedAt: num(r.landed_at),
    shippedAt: num(r.shipped_at),
  };
}

const WORK_ITEM_COLUMNS = [
  "item_id", "seq", "hive", "kind", "title", "body", "acceptance", "priority", "status", "parent_id", "root_id", "depth",
  "depends_on", "source_kind", "source_actor", "source_ref", "trace_id", "span_id", "difficulty", "best_of", "attempts",
  "duplicate_of", "blocked_reason", "release_id", "escalation_id", "command_id", "command_issued_at", "normalized_title",
  "created_at", "updated_at", "landed_at", "shipped_at", "paths", "wait_reason", "conflicts",
] as const;
/** Identity columns an upsert never rewrites. */
const WORK_ITEM_FIXED = new Set<string>(["item_id", "seq", "hive", "root_id", "trace_id", "span_id", "source_kind", "source_actor", "source_ref", "created_at"]);

export function upsertWorkItem(sql: SqlStorage, w: WorkItemRecord): void {
  const ref = Object.fromEntries(
    (["itemId", "trainId", "releaseId", "commandId"] as const).flatMap((k) => (w.source[k] ? [[k, w.source[k]]] : [])),
  );
  const updates = WORK_ITEM_COLUMNS.filter((c) => !WORK_ITEM_FIXED.has(c)).map((c) => `${c} = excluded.${c}`).join(", ");
  sql.exec(
    `INSERT INTO work_items (${WORK_ITEM_COLUMNS.join(", ")}) VALUES (${WORK_ITEM_COLUMNS.map(() => "?").join(", ")})
     ON CONFLICT(item_id) DO UPDATE SET ${updates}`,
    w.itemId,
    w.seq,
    w.hive,
    w.kind,
    w.title,
    w.body,
    JSON.stringify(w.acceptance),
    w.priority,
    w.status,
    w.parentId,
    w.rootId,
    w.depth,
    JSON.stringify(w.dependsOn),
    w.source.kind,
    w.source.actor,
    Object.keys(ref).length ? JSON.stringify(ref) : null,
    w.traceId,
    w.spanId,
    w.difficulty,
    w.bestOf,
    w.attempts,
    w.duplicateOf,
    w.blockedReason,
    w.releaseId,
    w.escalationId,
    w.commandId,
    w.commandIssuedAt,
    w.normalizedTitle,
    w.createdAt,
    w.updatedAt,
    w.landedAt,
    w.shippedAt,
    JSON.stringify(w.paths),
    w.waitReason,
    w.conflicts,
  );
}

export function rowToRace(r: Row): RaceRecord {
  return RaceSchema.parse({
    raceId: r.race_id,
    itemId: r.item_id,
    width: Number(r.width),
    state: r.state,
    trainIds: parseJson(r.train_ids, stringArray) ?? [],
    winnerTrainId: str(r.winner_train_id),
    reason: str(r.reason),
    deadlineAt: num(r.deadline_at),
    createdAt: r.created_at,
    decidedAt: num(r.decided_at),
  });
}

export function upsertRace(sql: SqlStorage, r: RaceRecord): void {
  sql.exec(
    `INSERT INTO races (race_id, item_id, width, state, train_ids, winner_train_id, reason, deadline_at, created_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(race_id) DO UPDATE SET state = excluded.state, train_ids = excluded.train_ids, winner_train_id = excluded.winner_train_id,
       reason = excluded.reason, deadline_at = excluded.deadline_at, decided_at = excluded.decided_at`,
    r.raceId,
    r.itemId,
    r.width,
    r.state,
    JSON.stringify(r.trainIds),
    r.winnerTrainId,
    r.reason,
    r.deadlineAt,
    r.createdAt,
    r.decidedAt,
  );
}

export function rowToHiveSettings(r: Row): HiveSettingsRecord {
  const autonomy = AutonomyLevelSchema.safeParse(r.autonomy);
  const boost = parseJson(r.budget_boost ?? null, schemaCheck<BudgetBoost>(BudgetBoostSchema));
  return {
    hive: String(r.hive),
    // An unknown level is treated as the safe one.
    autonomy: autonomy.success ? autonomy.data : "supervised",
    overrides: parseJson(r.settings, schemaCheck<HiveSettingsOverrides>(HiveSettingsOverridesSchema)) ?? {},
    budgetDay: str(r.budget_day),
    creditsUsed: Number(r.credits_used ?? 0),
    dispatches: Number(r.dispatches ?? 0),
    autoFiledHour: num(r.auto_filed_hour),
    autoFiledCount: Number(r.auto_filed_count ?? 0),
    rollbackStreak: Number(r.rollback_streak ?? 0),
    degradedBy: (parseJson(r.degraded_by, stringArray) ?? []).flatMap((x) => {
      const reason = EscalationReasonSchema.safeParse(x);
      return reason.success ? [reason.data as EscalationReason] : [];
    }),
    updatedBy: str(r.updated_by),
    updatedAt: Number(r.updated_at),
    leasedSlots: Number(r.leased_slots ?? 0),
    leaseExpiresAt: num(r.lease_expires_at),
    carInfraFailures: Number(r.car_infra_failures ?? 0),
    ...(boost ? { budgetBoost: boost } : {}),
  };
}

/** The hive's settings row, or null before the first v2 filing of a new hive. */
export function loadHiveSettings(sql: SqlStorage): HiveSettingsRecord | null {
  const r = sql.exec("SELECT * FROM hive_settings WHERE id = 1").toArray()[0];
  return r ? rowToHiveSettings(r) : null;
}

export function upsertHiveSettings(sql: SqlStorage, h: HiveSettingsRecord): void {
  sql.exec(
    `INSERT INTO hive_settings (id, hive, autonomy, settings, budget_day, credits_used, dispatches, auto_filed_hour, auto_filed_count,
       rollback_streak, degraded_by, updated_by, updated_at, leased_slots, lease_expires_at, car_infra_failures, budget_boost)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET autonomy = excluded.autonomy, settings = excluded.settings, budget_day = excluded.budget_day,
       credits_used = excluded.credits_used, dispatches = excluded.dispatches, auto_filed_hour = excluded.auto_filed_hour,
       auto_filed_count = excluded.auto_filed_count, rollback_streak = excluded.rollback_streak, degraded_by = excluded.degraded_by,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at, leased_slots = excluded.leased_slots,
       lease_expires_at = excluded.lease_expires_at, car_infra_failures = excluded.car_infra_failures,
       budget_boost = excluded.budget_boost`,
    h.hive,
    h.autonomy,
    JSON.stringify(h.overrides),
    h.budgetDay,
    h.creditsUsed,
    h.dispatches,
    h.autoFiledHour,
    h.autoFiledCount,
    h.rollbackStreak,
    JSON.stringify(h.degradedBy),
    h.updatedBy,
    h.updatedAt,
    h.leasedSlots,
    h.leaseExpiresAt,
    h.carInfraFailures,
    h.budgetBoost ? JSON.stringify(h.budgetBoost) : null,
  );
}

export function rowToEscalation(r: Row): EscalationRecord {
  return EscalationSchema.parse({
    escalationId: r.escalation_id,
    hive: r.hive,
    reason: r.reason,
    status: r.status,
    subject: { type: r.subject_type, id: r.subject_id },
    traceId: str(r.trace_id),
    summary: r.summary,
    actions: parseJson(r.actions, stringArray) ?? [],
    createdAt: r.created_at,
    resolvedAt: num(r.resolved_at),
    resolvedBy: str(r.resolved_by),
    resolution: str(r.resolution),
  });
}

/**
 * `escalations` has no hive column (one DO = one hive): `rowToEscalation` reads
 * it from the row, so callers select `?, *` or join hive_settings, e.g.
 * `SELECT (SELECT hive FROM hive_settings WHERE id = 1) AS hive, * FROM escalations`.
 */
export const ESCALATION_SELECT = "SELECT (SELECT hive FROM hive_settings WHERE id = 1) AS hive, * FROM escalations";

export function upsertEscalation(sql: SqlStorage, e: EscalationRecord): void {
  sql.exec(
    `INSERT INTO escalations (escalation_id, reason, status, subject_type, subject_id, trace_id, summary, actions,
       created_at, resolved_at, resolved_by, resolution)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(escalation_id) DO UPDATE SET status = excluded.status, summary = excluded.summary, actions = excluded.actions,
       resolved_at = excluded.resolved_at, resolved_by = excluded.resolved_by, resolution = excluded.resolution`,
    e.escalationId,
    e.reason,
    e.status,
    e.subject.type,
    e.subject.id,
    e.traceId,
    e.summary,
    JSON.stringify(e.actions),
    e.createdAt,
    e.resolvedAt,
    e.resolvedBy,
    e.resolution,
  );
}

export function rowToEvent(r: Row): QueenEvent {
  return QueenEventSchema.parse({
    seq: Number(r.seq),
    eventId: r.event_id,
    ts: r.ts,
    hive: r.hive,
    type: r.type,
    severity: r.severity,
    actor: r.actor,
    traceId: str(r.trace_id),
    spanId: str(r.span_id),
    parentSpanId: str(r.parent_span_id),
    itemId: str(r.item_id),
    trainId: str(r.train_id),
    releaseId: str(r.release_id),
    commandId: str(r.command_id),
    summary: r.summary,
    data: parseJson(r.data, unknownRecord),
    ...(r.drone_role !== null ? { droneRole: r.drone_role } : {}),
    ...(r.audit_status !== null ? { auditStatus: r.audit_status } : {}),
    ...(r.git_notes_payload !== null ? { gitNotesPayload: JSON.parse(String(r.git_notes_payload)) } : {}),
  });
}

/** Append one event (idempotent by eventId). Returns its seq, or null when the eventId already exists. */
export function insertEvent(sql: SqlStorage, e: Omit<QueenEvent, "seq">): number | null {
  const row = sql
    .exec(
      `INSERT INTO event_log (event_id, ts, hive, type, severity, actor, trace_id, span_id, parent_span_id,
         item_id, train_id, release_id, command_id, summary, data, drone_role, audit_status, git_notes_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO NOTHING RETURNING seq`,
      e.eventId,
      e.ts,
      e.hive,
      e.type,
      e.severity,
      e.actor,
      e.traceId,
      e.spanId,
      e.parentSpanId,
      e.itemId,
      e.trainId,
      e.releaseId,
      e.commandId,
      e.summary,
      json(e.data),
      e.droneRole ?? null,
      e.auditStatus ?? null,
      json(e.gitNotesPayload),
    )
    .toArray()[0];
  return row ? Number(row.seq) : null;
}

/** Canonical JSON of metric labels (sorted keys): the `metrics_hourly.labels` key. */
export function canonicalLabels(labels: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

export function rowToMetric(r: Row): HourlyMetric {
  return HourlyMetricSchema.parse({
    bucket: Number(r.bucket),
    name: r.name,
    labels: parseJson(r.labels, stringRecord) ?? {},
    count: Number(r.count),
    sum: Number(r.sum),
    min: Number(r.min ?? 0),
    max: Number(r.max ?? 0),
  });
}

/** Accumulate a delta into its hourly row: count and sum add; min and max fold. */
export function upsertMetric(sql: SqlStorage, m: MetricDelta): void {
  sql.exec(
    `INSERT INTO metrics_hourly (bucket, name, labels, count, sum, min, max) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(bucket, name, labels) DO UPDATE SET count = count + excluded.count, sum = sum + excluded.sum,
       min = CASE WHEN min IS NULL OR excluded.min < min THEN excluded.min ELSE min END,
       max = CASE WHEN max IS NULL OR excluded.max > max THEN excluded.max ELSE max END`,
    m.bucket,
    m.name,
    canonicalLabels(m.labels),
    m.count,
    m.sum,
    m.min,
    m.max,
  );
}

export function rowToClaim(r: Row): PathClaim {
  return { path: String(r.path), itemId: String(r.item_id), source: String(r.source) as PathClaimSource, createdAt: Number(r.created_at) };
}

/** Claim a path for an item. A later source replaces an earlier one (predicted → actual / conflict). */
export function upsertClaim(sql: SqlStorage, c: PathClaim): void {
  sql.exec(
    `INSERT INTO path_claims (path, item_id, source, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(path, item_id) DO UPDATE SET source = excluded.source`,
    c.path,
    c.itemId,
    c.source,
    c.createdAt,
  );
}

/** Release every claim of an item (LANDED, FAILED or CANCELLED). */
export function deleteClaims(sql: SqlStorage, itemId: string): void {
  sql.exec("DELETE FROM path_claims WHERE item_id = ?", itemId);
}

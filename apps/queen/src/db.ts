/**
 * QueenNode SQLite schema, migrations and validated row mapping.
 * Rows leaving SQLite are parsed with the queen-types row schemas.
 */
import {
  AuditEventSchema,
  DeploymentSchema,
  MergeTrainSchema,
  ModelChoiceSchema,
  ModelRoleSchema,
  ModelTierSchema,
  PromptRunSchema,
  ReleaseSchema,
  SentinelVerdictSchema,
  type AuditEvent,
  type Deployment,
  type ModelChoice,
  type ModelStats,
  type SentinelVerdict,
} from "@queenos/queen-types";
import { INITIAL_FLOOR, type FloorState, type RouterStats } from "./models/router";
import type { ReleasePending, ReleaseRecord } from "./release/planner";
import type { DeployState, ForkState, ModelOutcome, ModelStatDelta, PromptRecord, TrainAction, TrainPhase, TrainRecord } from "./train/planner";

/**
 * Append-only migration list. Version N is `MIGRATIONS[N - 1]`.
 * Applied versions are recorded in `_migrations` (PRAGMA user_version is not
 * relied on: Durable Object SQLite restricts PRAGMAs).
 */
const MIGRATIONS: readonly string[] = [
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
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Idempotent and cheap: one indexed read on every wake once up to date.
 * Must be called synchronously from the constructor (sql.exec is synchronous).
 */
export function migrate(storage: DurableObjectStorage): number {
  const sql = storage.sql;
  sql.exec("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const current = Number(sql.exec("SELECT COALESCE(MAX(version), 0) AS v FROM _migrations").one().v);
  for (let v = current + 1; v <= MIGRATIONS.length; v++) {
    storage.transactionSync(() => {
      sql.exec(MIGRATIONS[v - 1]!);
      sql.exec("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)", v, Date.now());
    });
  }
  return MIGRATIONS.length;
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
  return { ...base, seq: Number(r.seq), summary: str(r.summary), attempts: Number(r.attempts) };
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
  };
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

export function rowToAudit(r: Row): AuditEvent {
  return AuditEventSchema.parse({
    eventId: r.event_id,
    promptId: r.prompt_id,
    droneRole: r.drone_role,
    status: r.status,
    gitNotesPayload: r.git_notes_payload === null ? null : JSON.parse(String(r.git_notes_payload)),
    createdAt: r.created_at,
  });
}

export function upsertPrompt(sql: SqlStorage, p: PromptRecord): void {
  sql.exec(
    `INSERT INTO prompt_runs (prompt_id, namespace, prompt_text, status, created_at, seq, summary, attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(prompt_id) DO UPDATE SET status = excluded.status, summary = excluded.summary, attempts = excluded.attempts`,
    p.promptId,
    p.namespace,
    p.promptText,
    p.status,
    p.createdAt,
    p.seq,
    p.summary,
    p.attempts,
  );
}

export function upsertTrain(sql: SqlStorage, t: TrainRecord): void {
  sql.exec(
    `INSERT INTO merge_trains (train_id, base_sha, included_prompts, artifact_repo, status, created_at, seq, prompt_id,
       phase, fork_state, fork_source, head_sha, landed_sha, summary, reason, action, dispatched,
       fork_command_id, delete_command_id, deploy_state, deploy_command_id, teardown_command_id, preview_url,
       fork_issued_at, delete_issued_at, deploy_issued_at, teardown_issued_at, drone_issued_at, drone_attempt,
       model, model_reason, model_choice, model_choice_attempt, model_outcome, model_probe)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       model_outcome = excluded.model_outcome, model_probe = excluded.model_probe`,
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
  };
}

const RELEASE_COLUMNS = [
  "release_id", "hive", "head_sha", "train_ids", "phase", "canary_percent", "staging_url", "prod_url",
  "candidate_version_id", "stable_version_id", "tapped_by", "tapped_at", "summary", "created_at", "updated_at",
  "seq", "step", "pending", "deploy_command_id", "deploy_issued_at", "sentinel_command_id", "sentinel_issued_at",
  "rollback_command_id", "rollback_issued_at", "next_head_sha", "next_train_ids",
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

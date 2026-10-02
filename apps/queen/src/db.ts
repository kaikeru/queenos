/**
 * QueenNode SQLite schema, migrations and validated row mapping.
 * Rows leaving SQLite are parsed with the queen-types row schemas.
 */
import {
  AuditEventSchema,
  MergeTrainSchema,
  PromptRunSchema,
  type AuditEvent,
} from "@queenos/queen-types";
import type { ForkState, PromptRecord, TrainAction, TrainPhase, TrainRecord } from "./train/planner";

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
  };
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
       phase, fork_state, fork_source, head_sha, landed_sha, summary, reason, action, dispatched)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(train_id) DO UPDATE SET base_sha = excluded.base_sha, status = excluded.status, phase = excluded.phase,
       fork_state = excluded.fork_state, fork_source = excluded.fork_source, head_sha = excluded.head_sha,
       landed_sha = excluded.landed_sha, summary = excluded.summary, reason = excluded.reason,
       dispatched = excluded.dispatched`,
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
  );
}

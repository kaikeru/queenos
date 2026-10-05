/**
 * Event log helpers (v2 design §2.7): EventDraft → row, append, query, prune.
 * The Queen assigns seq, eventId, ts and hive when it writes a draft, in the
 * same transaction as the planner's rows.
 */
import {
  EVENT_RETENTION_MS,
  EVENT_RETENTION_ROWS,
  MAX_EVENT_DATA_BYTES,
  MAX_EVENT_SUMMARY,
  type EventDraft,
  type EventQueryInput,
  EventQuerySchema,
  type QueenEvent,
} from "@queenos/queen-types";
import { insertEvent, rowToEvent } from "../db";

const utf8 = new TextEncoder();

export interface EventContext {
  hive: string;
  ts: number;
  /** Mints event ids (tests); default `crypto.randomUUID()`. */
  newId?: () => string;
}

/** Data over the cap is replaced by a marker that keeps the key names, so a row never fails to fit. */
function fitData(data: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!data) return null;
  let bytes: number;
  try {
    bytes = utf8.encode(JSON.stringify(data)).length;
  } catch {
    return { truncated: true, reason: "unserializable" };
  }
  if (bytes <= MAX_EVENT_DATA_BYTES) return data;
  return { truncated: true, bytes, keys: Object.keys(data).slice(0, 20) };
}

/** An EventDraft as a row without its seq (the cursor is assigned by SQLite). */
export function draftToEvent(d: EventDraft, ctx: EventContext): Omit<QueenEvent, "seq"> {
  const summary = d.summary.length > MAX_EVENT_SUMMARY ? `${d.summary.slice(0, MAX_EVENT_SUMMARY - 1)}…` : d.summary;
  return {
    eventId: (ctx.newId ?? (() => crypto.randomUUID()))(),
    ts: ctx.ts,
    hive: ctx.hive,
    type: d.type,
    severity: d.severity ?? "info",
    actor: d.actor.slice(0, 340),
    traceId: d.traceId ?? null,
    spanId: d.spanId ?? null,
    parentSpanId: d.parentSpanId ?? null,
    itemId: d.itemId ?? null,
    trainId: d.trainId ?? null,
    releaseId: d.releaseId ?? null,
    commandId: d.commandId ?? null,
    summary,
    data: fitData(d.data),
    ...(d.droneRole !== undefined ? { droneRole: d.droneRole } : {}),
    ...(d.auditStatus !== undefined ? { auditStatus: d.auditStatus } : {}),
    ...(d.gitNotesPayload !== undefined ? { gitNotesPayload: d.gitNotesPayload } : {}),
  };
}

/**
 * Append drafts in order; returns the stored events (with seq) for broadcast.
 * Run inside the caller's transaction.
 */
export function appendEvents(sql: SqlStorage, drafts: readonly EventDraft[], ctx: EventContext): QueenEvent[] {
  const out: QueenEvent[] = [];
  for (const d of drafts) {
    const row = draftToEvent(d, ctx);
    const seq = insertEvent(sql, row);
    if (seq !== null) out.push({ ...row, seq });
  }
  return out;
}

/** `GET /hives/:hive/events`: newest first, `before` is an exclusive seq cursor. */
export function queryEvents(sql: SqlStorage, query: EventQueryInput): QueenEvent[] {
  const q = EventQuerySchema.parse(query);
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (q.traceId) {
    where.push("trace_id = ?");
    args.push(q.traceId);
  }
  if (q.itemId) {
    where.push("item_id = ?");
    args.push(q.itemId);
  }
  if (q.releaseId) {
    where.push("release_id = ?");
    args.push(q.releaseId);
  }
  if (q.typePrefix) {
    // Escape LIKE wildcards so the prefix is literal.
    const esc = q.typePrefix.replace(/[\\%_]/g, "\\$&");
    where.push("(type = ? OR type LIKE ? ESCAPE '\\')");
    args.push(q.typePrefix, `${esc}.%`);
  }
  if (q.before !== undefined) {
    where.push("seq < ?");
    args.push(q.before);
  }
  const rows = sql
    .exec(`SELECT * FROM event_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`, ...args, q.limit)
    .toArray();
  return rows.map(rowToEvent);
}

export interface PruneOptions {
  maxAgeMs?: number;
  maxRows?: number;
}

/**
 * Retention (alarm): drop rows older than 30 days, then keep only the newest
 * 100k, whichever is smaller. Returns the number of rows deleted.
 */
export function pruneEvents(sql: SqlStorage, now: number, opts: PruneOptions = {}): number {
  const maxAge = opts.maxAgeMs ?? EVENT_RETENTION_MS;
  const maxRows = opts.maxRows ?? EVENT_RETENTION_ROWS;
  const before = Number(sql.exec("SELECT COUNT(*) AS n FROM event_log").one().n);
  sql.exec("DELETE FROM event_log WHERE ts < ?", now - maxAge);
  const cutoff = sql.exec("SELECT seq FROM event_log ORDER BY seq DESC LIMIT 1 OFFSET ?", maxRows).toArray()[0];
  if (cutoff) sql.exec("DELETE FROM event_log WHERE seq <= ?", Number(cutoff.seq));
  const after = Number(sql.exec("SELECT COUNT(*) AS n FROM event_log").one().n);
  return before - after;
}

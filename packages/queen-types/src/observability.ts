import { z } from "zod";
import { GitNotesPayloadSchema, type GitNotesPayload } from "./ledger.js";
import { AuditStatusSchema, DroneRoleSchema, type AuditStatus, type DroneRole } from "./state.js";
import { SpanIdSchema, TraceIdSchema } from "./trace.js";

/**
 * Event log and metrics (v2 design §2.7, §2.8). `event_log` supersedes
 * `audit_trail`: it is both the audit trail (`drone.audit` rows carry the
 * Cognitive Ledger) and the source of the trace view and drill-downs.
 */

export const EventTypeSchema = z.enum([
  "item.filed",
  "item.status",
  "item.decomposed",
  "item.duplicate",
  "train.enqueued",
  "train.phase",
  "race.started",
  "race.decided",
  // Human-push design (§6, §7, §10): inbox intake, notes, human-judged races.
  "race.picking",
  "race.rejected",
  "race.entries-closed",
  "inbox.opened",
  "inbox.revoked",
  "submission.received",
  // MCP attempts (docs/superpowers/specs/2026-10-12-queenos-mcp-design.md §7).
  "attempt.intent",
  "attempt.state",
  "attempt.base",
  "note.failed",
  "queue.car",
  "queue.merged",
  "queue.conflict",
  "queue.bisect",
  "queue.landed",
  "affinity.claimed",
  "affinity.wait",
  "affinity.released",
  "command.issued",
  "command.result",
  "drone.audit",
  "gate.verdict",
  "release.phase",
  "release.autoshipped",
  "sentinel.verdict",
  "escalation.opened",
  "escalation.resolved",
  "autonomy.degraded",
  "autonomy.restored",
  "hive.settings",
  "budget.exhausted",
  "guardrail.tripped",
  "followup.filed",
  "followup.dropped",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const EventSeveritySchema = z.enum(["debug", "info", "warn", "error"]);
export type EventSeverity = z.infer<typeof EventSeveritySchema>;

/** Max chars of `QueenEvent.summary`, and max bytes of its JSON `data`. */
export const MAX_EVENT_SUMMARY = 500;
export const MAX_EVENT_DATA_BYTES = 4096;

/** One `event_log` row. */
export const QueenEventSchema = z.object({
  /** The cursor (INTEGER PRIMARY KEY AUTOINCREMENT). */
  seq: z.number().int(),
  eventId: z.string(),
  ts: z.number().int(),
  hive: z.string(),
  type: EventTypeSchema,
  severity: EventSeveritySchema,
  /** `queen`, `user:<email>`, `drone:BUILDER`, `gatekeeper:REVIEWER`, `oracle`, `herald`, `sentinel`, `provisioner`. */
  actor: z.string().max(340),
  traceId: TraceIdSchema.nullable(),
  spanId: SpanIdSchema.nullable(),
  parentSpanId: SpanIdSchema.nullable(),
  itemId: z.string().nullable(),
  trainId: z.string().nullable(),
  releaseId: z.string().nullable(),
  commandId: z.string().nullable(),
  summary: z.string().max(MAX_EVENT_SUMMARY),
  data: z.record(z.string(), z.unknown()).nullable(),
  // Ledger cards (`drone.audit`).
  droneRole: DroneRoleSchema.optional(),
  auditStatus: AuditStatusSchema.optional(),
  gitNotesPayload: GitNotesPayloadSchema.nullable().optional(),
});
export type QueenEvent = z.infer<typeof QueenEventSchema>;

/**
 * What a pure planner records when a phase or status changes (returned in
 * `PlanResult.events`). The Queen assigns seq, eventId, ts and hive when it
 * writes the row, in the same transaction as the planner's rows.
 */
export interface EventDraft {
  type: EventType;
  /** Default `info`. */
  severity?: EventSeverity;
  actor: string;
  traceId?: string | null;
  spanId?: string | null;
  parentSpanId?: string | null;
  itemId?: string | null;
  trainId?: string | null;
  releaseId?: string | null;
  commandId?: string | null;
  summary: string;
  data?: Record<string, unknown> | null;
  droneRole?: DroneRole;
  auditStatus?: AuditStatus;
  gitNotesPayload?: GitNotesPayload | null;
}

/** GET /hives/:hive/events?trace=&item=&release=&type=&before=&limit= */
export const EventQuerySchema = z.object({
  traceId: TraceIdSchema.optional(),
  itemId: z.string().optional(),
  releaseId: z.string().optional(),
  /** Matches `type = prefix` or `type LIKE prefix || '.%'`, e.g. `queue`. */
  typePrefix: z.string().max(40).optional(),
  /** Seq cursor (exclusive). */
  before: z.number().int().optional(),
  limit: z.number().int().min(1).max(500).default(100),
});
export type EventQuery = z.infer<typeof EventQuerySchema>;
export type EventQueryInput = z.input<typeof EventQuerySchema>;

export const SpanKindSchema = z.enum(["item", "train", "car", "command", "gate", "release"]);
export type SpanKind = z.infer<typeof SpanKindSchema>;

export const SpanSchema = z.object({
  spanId: SpanIdSchema,
  parentSpanId: SpanIdSchema.nullable(),
  name: z.string(),
  kind: SpanKindSchema,
  startTs: z.number().int(),
  endTs: z.number().int().nullable(),
  outcome: z.string().nullable(),
});
export type Span = z.infer<typeof SpanSchema>;

/** GET /hives/:hive/traces/:traceId */
export const TraceViewSchema = z.object({
  traceId: TraceIdSchema,
  spans: z.array(SpanSchema),
  events: z.array(QueenEventSchema),
  /** Linked traces (a release's items, an auto-filed bug's cause). */
  links: z.array(TraceIdSchema),
});
export type TraceView = z.infer<typeof TraceViewSchema>;

/** One `metrics_hourly` row (bucket = epoch ms of the hour start; labels = canonical JSON). */
export const HourlyMetricSchema = z.object({
  bucket: z.number().int(),
  name: z.string(),
  labels: z.record(z.string(), z.string()),
  count: z.number(),
  sum: z.number(),
  min: z.number(),
  max: z.number(),
});
export type HourlyMetric = z.infer<typeof HourlyMetricSchema>;

/** Analytics Engine dataset (binding `ANALYTICS`). */
export const AE_DATASET = "queenos_events";
/** Max AE data points per Worker invocation (the platform allows 250). */
export const AE_MAX_POINTS_PER_INVOCATION = 200;

/**
 * AE layout: indexes [hive]; blobs [type, hive, kindOrRole, model, outcome,
 * environment, traceId, itemId]; doubles [valueMs, tokensIn, tokensOut, credits, count, errorRate].
 */
export interface AnalyticsPoint {
  type: string;
  hive: string;
  kindOrRole?: string;
  model?: string;
  outcome?: string;
  environment?: string;
  traceId?: string;
  itemId?: string;
  valueMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  credits?: number;
  /** Default 1. */
  count?: number;
  /** 0..1 (the Sentinel window point). Optional trailing AE double. */
  errorRate?: number;
}

/** Event-log retention (pruned in the alarm): whichever is smaller. */
export const EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const EVENT_RETENTION_ROWS = 100_000;

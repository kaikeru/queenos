import { z } from "zod";
import { GitNotesPayloadSchema } from "./ledger.js";
import { RecalledMemorySchema } from "./memory.js";
import { MergeConflictSchema, TrainLaneSchema } from "./queue.js";
import { TraceIdSchema } from "./trace.js";
import { GateScoreSchema, TrainPhaseSchema, TrainStateSchema } from "./train.js";

export const PromptStatusSchema = z.enum([
  "QUEUED",
  "BUILDING",
  "IN_TRAIN",
  "MERGED",
  "EJECTED",
  "FAILED",
]);
export type PromptStatus = z.infer<typeof PromptStatusSchema>;

export const DroneRoleSchema = z.enum([
  "BUILDER",
  "REVIEWER",
  "GATEKEEPER",
  "SCRIBE",
  "POLICY",
  "SECURITY",
  "LANDER",
]);
export type DroneRole = z.infer<typeof DroneRoleSchema>;

/** Audit status; the War Room flashes yellow / green / red on it. */
export const AuditStatusSchema = z.enum(["RUNNING", "PASSED", "REJECTED"]);
export type AuditStatus = z.infer<typeof AuditStatusSchema>;

/** Row of `prompt_runs`. */
export const PromptRunSchema = z.object({
  promptId: z.string(), // prompt_id (PK)
  namespace: z.string(), // namespace
  promptText: z.string(), // prompt_text
  status: PromptStatusSchema, // status
  createdAt: z.number().int(), // created_at (epoch ms)
});
export type PromptRun = z.infer<typeof PromptRunSchema>;

/** A race candidate's standing (§2.3.6). */
export const RaceOutcomeSchema = z.enum(["RACING", "PASSED", "FAILED", "WON", "LOST"]);
export type RaceOutcome = z.infer<typeof RaceOutcomeSchema>;

/** Row of `merge_trains`. */
export const MergeTrainSchema = z.object({
  trainId: z.string(), // train_id (PK)
  baseSha: z.string(), // base_sha
  includedPrompts: z.array(z.string()), // included_prompts (JSON array of prompt ids)
  artifactRepo: z.string(), // artifact_repo
  status: TrainStateSchema, // status
  createdAt: z.number().int(), // created_at (epoch ms)
  // Optional, Queen-populated detail for the War Room (absent on older Queens).
  phase: TrainPhaseSchema.optional(), // phase (planner lifecycle)
  reason: z.string().nullable().optional(), // reason (why EJECTED: failed / superseded)
  summary: z.string().max(500).nullable().optional(), // summary (Scribe verdict, <= 500 chars)
  headSha: z.string().nullable().optional(), // head_sha (pushed by the builder)
  landedSha: z.string().nullable().optional(), // landed_sha (hive main after landing)
  previewUrl: z.string().nullable().optional(), // preview_url (Herald's Worker Preview URL; set when DEPLOYING -> TESTING)
  model: z.string().nullable().optional(), // model (router's choice for this train's builder, or the model actually used)
  modelReason: z.string().max(200).nullable().optional(), // model_reason (why the router chose it)
  memories: z.array(RecalledMemorySchema).optional(), // memories (JSON; hive memories the Provisioner recalled for this train)
  // v2 (all optional; absent on v1 Queens and in v1 snapshots).
  traceId: TraceIdSchema.nullable().optional(), // trace_id (the item's trace)
  raceId: z.string().nullable().optional(), // race_id (best-of-N candidate)
  candidate: z.number().int().min(0).nullable().optional(), // candidate (index within the race)
  raceOutcome: RaceOutcomeSchema.nullable().optional(), // race_outcome
  score: GateScoreSchema.nullable().optional(), // gate_score (JSON)
  lane: TrainLaneSchema.optional(), // lane (absent = BUILD)
  members: z.array(z.string()).optional(), // members (QUEUE: JSON trainIds, merge order)
  carId: z.string().nullable().optional(), // car_id (BUILD: the car carrying it)
  passedSeq: z.number().int().nullable().optional(), // passed_seq (BUILD: queue ticket)
  conflict: MergeConflictSchema.nullable().optional(), // conflict (BUILD: JSON MergeConflict that ejected it)
  changedPaths: z.array(z.string()).optional(), // changed_paths (BUILD: JSON, from BuildResult)
  waitForCarSeq: z.number().int().nullable().optional(), // wait_for_car_seq (BUILD: conflict/integration rework)
  carSeq: z.number().int().optional(), // QUEUE: the car's seq (queue rail ordering)
  fastForward: z.boolean().optional(), // QUEUE: a single member fast-forwarded (car gate skipped)
});
export type MergeTrain = z.infer<typeof MergeTrainSchema>;

/** Row of `audit_trail`. */
export const AuditEventSchema = z.object({
  eventId: z.string(), // event_id (PK)
  promptId: z.string(), // prompt_id (FK -> prompt_runs.prompt_id)
  droneRole: DroneRoleSchema, // drone_role
  status: AuditStatusSchema, // status
  gitNotesPayload: GitNotesPayloadSchema.nullable(), // git_notes_payload (JSON, nullable)
  createdAt: z.number().int(), // created_at (epoch ms)
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** Input: a drone appends a Cognitive Ledger entry to the audit trail. */
export const AppendAuditSchema = z.object({
  promptId: z.string().min(1),
  droneRole: DroneRoleSchema,
  status: AuditStatusSchema,
  gitNotesPayload: GitNotesPayloadSchema.nullable().default(null),
});
export type AppendAudit = z.infer<typeof AppendAuditSchema>;
export type AppendAuditInput = z.input<typeof AppendAuditSchema>;

/** Most audit entries one `appendAudits` call may carry. */
export const MAX_AUDIT_BATCH = 50;
/** Input: several Cognitive Ledger entries in one RPC (one transaction, one broadcast). */
export const AppendAuditsSchema = z.array(AppendAuditSchema).min(1).max(MAX_AUDIT_BATCH);
export type AppendAuditsInput = z.input<typeof AppendAuditsSchema>;

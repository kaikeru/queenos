import { z } from "zod";
import { GitNotesPayloadSchema } from "./ledger.js";
import { RecalledMemorySchema } from "./memory.js";
import { TrainPhaseSchema, TrainStateSchema } from "./train.js";

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

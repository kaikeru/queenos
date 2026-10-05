import { z } from "zod";
import { DroneRoleSchema } from "./state.js";
import { ModelChoiceSchema } from "./models.js";
import { MergeMemberSchema } from "./queue.js";
import { TraceContextSchema } from "./trace.js";

/** What a drone workflow instance must do with its train fork. */
/** v2: MERGE = the merge-queue drone that 3-way merges a car's members (deterministic, no LLM). */
export const DroneActionSchema = z.enum(["BUILD", "LAND", "REWORK", "MERGE"]);
export type DroneAction = z.infer<typeof DroneActionSchema>;

/** Workflow instance params for a Drone. */
export const DroneTaskSchema = z.object({
  promptId: z.string().min(1),
  trainId: z.string().min(1),
  namespace: z.string().min(1),
  artifactRepo: z.string().min(1),
  baseRef: z.string().min(1),
  promptText: z.string().min(1),
  role: DroneRoleSchema,
  action: DroneActionSchema.default("BUILD"),
  /** Vectorize RAG snippets for the prompt (empty until the RAG lookup lands). */
  ragContext: z.array(z.string()).default([]),
  /** For REWORK: Scribe's compaction of why the previous attempt failed. */
  scribeSummary: z.string().max(500).optional(),
  /** The Queen's model choice for this task (absent: the drone's env default). */
  modelChoice: ModelChoiceSchema.optional(),
  /** v2: W3C trace context for structured logs (absent from v1 Queens). */
  trace: TraceContextSchema.optional(),
  /** v2: MERGE and LAND of a car: its members, in merge order. `promptText` is "queue car <carId>: <n> members". */
  members: z.array(MergeMemberSchema).max(16).optional(),
});
export type DroneTask = z.infer<typeof DroneTaskSchema>;
export type DroneTaskInput = z.input<typeof DroneTaskSchema>;

export const AiGatewayConfigSchema = z.object({
  gatewayId: z.string().min(1),
  /** Workers AI (`@cf/...`) or third-party (`anthropic/claude-opus-5-5`) model id. */
  model: z.string().min(1),
});
export type AiGatewayConfig = z.infer<typeof AiGatewayConfigSchema>;

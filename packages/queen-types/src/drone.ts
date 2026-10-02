import { z } from "zod";
import { DroneRoleSchema } from "./state.js";

/** What a drone workflow instance must do with its train fork. */
export const DroneActionSchema = z.enum(["BUILD", "LAND", "REWORK"]);
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
});
export type DroneTask = z.infer<typeof DroneTaskSchema>;
export type DroneTaskInput = z.input<typeof DroneTaskSchema>;

export const AiGatewayConfigSchema = z.object({
  accountId: z.string().min(1),
  gatewayId: z.string().min(1),
  provider: z.enum(["anthropic", "openai"]),
  model: z.string().min(1),
});
export type AiGatewayConfig = z.infer<typeof AiGatewayConfigSchema>;

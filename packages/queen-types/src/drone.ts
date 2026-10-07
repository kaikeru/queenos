import { z } from "zod";
import { DroneRoleSchema } from "./state.js";
import { ModelChoiceSchema } from "./models.js";
import { MergeMemberSchema } from "./queue.js";
import { TraceContextSchema } from "./trace.js";
import { MAX_NOTE_TOTAL } from "./executors.js";

/** What a drone workflow instance must do with its train fork. */
/** v2: MERGE = the merge-queue drone that 3-way merges a car's members (deterministic, no LLM). */
/** PIN = copy an inbox submission's head into the train fork's `main` (deterministic, no LLM; human-push design §2.3). */
export const DroneActionSchema = z.enum(["BUILD", "LAND", "REWORK", "MERGE", "PIN"]);
export type DroneAction = z.infer<typeof DroneActionSchema>;

/** Where a seeded drone's starting code is (an inbox branch, or a race loser's train fork). */
export const DroneSeedSchema = z.object({
  repo: z.string().min(1),
  ref: z.string().regex(/^refs\/heads\/.+/),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
});
export type DroneSeed = z.infer<typeof DroneSeedSchema>;

export const DroneWriteBackSchema = z.object({
  repo: z.string().min(1),
  ref: z.string().regex(/^refs\/heads\/.+/),
});
export type DroneWriteBack = z.infer<typeof DroneWriteBackSchema>;

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
  /**
   * PIN, and REWORK of inbox code: the submitted head to start from. The drone fetches `repo` `ref`,
   * checks the tip is `headSha` (else "head not found"), and force-pushes it to the train fork's `main`.
   */
  seed: DroneSeedSchema.optional(),
  /** REWORK of inbox code: push the new head back to the contributor's branch (fast-forward only, else `<ref>-queen`). */
  writeBack: DroneWriteBackSchema.optional(),
  /**
   * v2: the rendered v1 note text of the rejected commit (REWORK brief). Information for the drone,
   * never permission (human-push design §7.2-7.3).
   */
  brief: z.string().max(MAX_NOTE_TOTAL).optional(),
});
export type DroneTask = z.infer<typeof DroneTaskSchema>;
export type DroneTaskInput = z.input<typeof DroneTaskSchema>;

export const AiGatewayConfigSchema = z.object({
  gatewayId: z.string().min(1),
  /** Workers AI (`@cf/...`) or third-party (`anthropic/claude-opus-5-5`) model id. */
  model: z.string().min(1),
});
export type AiGatewayConfig = z.infer<typeof AiGatewayConfigSchema>;

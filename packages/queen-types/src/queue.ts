import { z } from "zod";
import { TraceIdSchema } from "./trace.js";
import { TrainPhaseSchema } from "./train.js";

/**
 * Parallel builds and the merge queue (v2 design §2.3). Trains run in two
 * lanes, both stored in `merge_trains`:
 * - BUILD: one train per build attempt of an item; always forks from hive main.
 * - QUEUE: one train per merge *car* (1..maxQueueBatch passed build trains),
 *   3-way merged by the MERGE drone onto the speculative tip, gated as a whole,
 *   and landed with one fast-forward push.
 */

export const TrainLaneSchema = z.enum(["BUILD", "QUEUE"]);
export type TrainLane = z.infer<typeof TrainLaneSchema>;

/** One member of a car, as the MERGE and LANDER drones see it (`DroneTask.members`). */
export const MergeMemberSchema = z.object({
  trainId: z.string().min(1),
  promptId: z.string().min(1),
  artifactRepo: z.string().min(1),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  title: z.string().max(120),
});
export type MergeMember = z.infer<typeof MergeMemberSchema>;

export const MergeConflictKindSchema = z.enum(["content", "unsupported", "missing"]);
export type MergeConflictKind = z.infer<typeof MergeConflictKindSchema>;

/**
 * A member that could not be merged into its car. `content` = isomorphic-git
 * MergeConflictError; `unsupported` = MergeNotSupportedError (add/add, mode or
 * type changes), criss-cross, or no merge base; `missing` = head not fetchable.
 */
export const MergeConflictSchema = z.object({
  trainId: z.string().min(1),
  kind: MergeConflictKindSchema,
  /** Conflicting paths (best effort for "unsupported"). */
  paths: z.array(z.string().max(200)).max(50),
  summary: z.string().max(500),
});
export type MergeConflict = z.infer<typeof MergeConflictSchema>;

/** The MERGE drone's report for a car (`trainId` = car id). */
export const MergeResultSchema = z.object({
  trainId: z.string().min(1),
  /** false = infra failure (nothing pushed). */
  ok: z.boolean(),
  headSha: z.string().optional(),
  baseSha: z.string().optional(),
  /** Member trainIds, in merge order. */
  merged: z.array(z.string()).max(16).default([]),
  conflicts: z.array(MergeConflictSchema).max(16).default([]),
  /** Exactly one member, fast-forwarded: its tree was already gated, so the car gate is skipped. */
  fastForward: z.boolean().default(false),
  mergeMs: z.number().int().min(0).optional(),
  summary: z.string().max(500).default(""),
});
export type MergeResult = z.infer<typeof MergeResultSchema>;
export type MergeResultInput = z.input<typeof MergeResultSchema>;

/** A car member as the gatekeepers see it (integration gate smoke paths + per-member trace). */
export const GateTargetMemberSchema = MergeMemberSchema.extend({
  traceId: TraceIdSchema.nullable(),
  smokePaths: z.array(z.string()).max(10),
});
export type GateTargetMember = z.infer<typeof GateTargetMemberSchema>;

/** The gatekeepers' RPC answer: what a pushed repo is (replaces the snapshot scan). */
export const GateTargetSchema = z.object({
  trainId: z.string(),
  lane: TrainLaneSchema,
  promptId: z.string(),
  promptText: z.string(),
  previewUrl: z.string().nullable(),
  phase: TrainPhaseSchema,
  traceId: TraceIdSchema.nullable(),
  /** The car's base (integration gate scans `baseSha..head`). */
  baseSha: z.string().nullable(),
  /** QUEUE lane only. */
  members: z.array(GateTargetMemberSchema).max(16).optional(),
});
export type GateTarget = z.infer<typeof GateTargetSchema>;

/** Clone/fetch depth shared by the MERGE and LANDER drones (apps/drones/src/land.ts imports this). */
export const LAND_DEPTH = 100;

/** Global concurrency lease request (SwarmGovernor DO, §4.3). */
export const SwarmLeaseRequestSchema = z.object({
  hive: z.string(),
  want: z.number().int().min(0).max(1000),
  ttlMs: z.number().int().min(10_000).max(600_000),
});
export type SwarmLeaseRequest = z.infer<typeof SwarmLeaseRequestSchema>;

export const SwarmLeaseSchema = z.object({
  hive: z.string(),
  granted: z.number().int().min(0),
  expiresAt: z.number().int(),
  globalActive: z.number().int(),
  globalCeiling: z.number().int(),
  aiRpmCeiling: z.number().int(),
});
export type SwarmLease = z.infer<typeof SwarmLeaseSchema>;

/** ~8 LLM steps per Think build over ~2 min. */
export const EST_RPM_PER_BUILD = 4;

/** Env defaults for the SwarmGovernor ceilings (§2.9): `SWARM_MAX_ACTIVE_BUILDS`, `SWARM_AI_RPM` (80% of 300 rpm). */
export const SWARM_DEFAULTS = { maxActiveBuilds: 64, simMaxActiveBuilds: 1000, aiRpm: 240 } as const;

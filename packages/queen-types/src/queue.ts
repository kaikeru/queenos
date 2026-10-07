import { z } from "zod";
import { SubmissionOriginSchema } from "./inbox.js";
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
  /** With `ok: false`: a transient infrastructure error (Artifacts 5xx / 429) outlasted the drone's retries; the Queen re-dispatches the SAME car (no supersede, no member charge). */
  cause: z.literal("infra").optional(),
  /** The reporting drone's Workflow instance id; with `cause`, a report from a superseded attempt is ignored. */
  commandId: z.string().min(1).optional(),
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
  /**
   * The diff base the gate scans (`baseSha..head`): a car's base, and (human-push design §2.4 row 7)
   * a BUILD train's fork base (the merge base with hive main for pinned inbox code).
   */
  baseSha: z.string().nullable(),
  /** Whose code a BUILD train carries (absent = drone). A non-drone origin fails closed when the reviewer is unavailable. */
  origin: SubmissionOriginSchema.optional(),
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

/**
 * Default Workers AI requests/min per active builder (`SWARM_RPM_PER_BUILD` overrides it). A Think tool-loop
 * build makes up to 16 model calls, mostly within its first few minutes, plus the AI SDK's own retries:
 * ~20 rpm while it runs (the old estimate of 4 let 12 builders burst past the per-minute limit, 2026-10-06).
 */
export const EST_RPM_PER_BUILD = 20;

/** Env defaults for the SwarmGovernor ceilings (§2.9): `SWARM_MAX_ACTIVE_BUILDS`, `SWARM_AI_RPM` (80% of 300 rpm). */
export const SWARM_DEFAULTS = { maxActiveBuilds: 64, simMaxActiveBuilds: 1000, aiRpm: 240 } as const;

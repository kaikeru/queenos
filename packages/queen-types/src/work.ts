import { z } from "zod";
import { SpanIdSchema, TraceIdSchema } from "./trace.js";

/**
 * Work ledger (v2 design §2.1, §2.2, §2.9). A prompt fans out into work items
 * (goal → features, bugs, chores) with dependencies; agents file their own
 * bugs behind hard caps. A dispatched item IS a prompt run:
 * `prompt_runs.prompt_id = work_items.item_id`.
 */

export const WorkKindSchema = z.enum(["goal", "feature", "bug", "chore"]);
export type WorkKind = z.infer<typeof WorkKindSchema>;

/** A repo-relative file, or a directory ending in "/". assertRepoPath rules; no globs. */
export const PathPatternSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/);
export type PathPattern = z.infer<typeof PathPatternSchema>;

/** Files resolved by a merge driver (hive-kit `registryMergeDriver`): never claimed, never a conflict. */
export const GENERATED_PATHS = ["src/features/index.js"] as const;
const GENERATED: ReadonlySet<string> = new Set(GENERATED_PATHS);

export function isGeneratedPath(path: string): boolean {
  return GENERATED.has(path);
}

/** `a` covers `b`: equal, or `a` is a directory ("dir/") and `b` lies under it. */
function covers(a: string, b: string): boolean {
  return a === b || (a.endsWith("/") && b.startsWith(a));
}

/**
 * Path affinity overlap (§2.3.5): the paths of `a` that overlap any path of `b`
 * (equal, or one is a directory prefix "dir/" of the other), in `a`'s order,
 * without duplicates. GENERATED_PATHS never overlap, on either side. Empty
 * lists never overlap (unknown is treated optimistically). Pure; shared by the
 * Queen, the sim and the dashboard.
 */
export function pathsOverlap(a: readonly string[], b: readonly string[]): string[] {
  const others = b.filter((q) => !GENERATED.has(q));
  if (others.length === 0) return [];
  const out: string[] = [];
  for (const p of a) {
    if (GENERATED.has(p) || out.includes(p)) continue;
    if (others.some((q) => covers(p, q) || covers(q, p))) out.push(p);
  }
  return out;
}

export const WorkStatusSchema = z.enum([
  "TRIAGE",
  "DECOMPOSING",
  "BLOCKED",
  "READY",
  "ACTIVE",
  "LANDED",
  "SHIPPED",
  "FAILED",
  "DUPLICATE",
  "CANCELLED",
]);
export type WorkStatus = z.infer<typeof WorkStatusSchema>;
/** FAILED is terminal until a human retries, so it is not listed. */
export const TERMINAL_WORK_STATUSES = ["SHIPPED", "DUPLICATE", "CANCELLED"] as const;

/** 0..3 = P0..P3. */
export const PrioritySchema = z.number().int().min(0).max(3);
export const DifficultySchema = z.enum(["normal", "hard"]);
export type Difficulty = z.infer<typeof DifficultySchema>;

export const WorkSourceKindSchema = z.enum(["user", "oracle", "drone", "gatekeeper", "sentinel", "queen"]);
export type WorkSourceKind = z.infer<typeof WorkSourceKindSchema>;

export const WorkSourceSchema = z.object({
  kind: WorkSourceKindSchema,
  actor: z.string().min(1).max(320),
  itemId: z.string().optional(),
  trainId: z.string().optional(),
  releaseId: z.string().optional(),
  commandId: z.string().optional(),
});
export type WorkSource = z.infer<typeof WorkSourceSchema>;

export const WorkItemSchema = z.object({
  /** UUID for root items; `<goalId>-c<n>` for decomposed children (idempotent re-delivery). */
  itemId: z.string().min(1).max(64),
  hive: z.string().min(1),
  kind: WorkKindSchema,
  title: z.string().min(1).max(120),
  body: z.string().max(4000),
  acceptance: z.array(z.string().max(200)).max(8),
  priority: PrioritySchema,
  status: WorkStatusSchema,
  parentId: z.string().nullable(),
  rootId: z.string(),
  depth: z.number().int().min(0).max(3),
  /** Item ids that must be LANDED or SHIPPED before dispatch. */
  dependsOn: z.array(z.string()).max(8),
  source: WorkSourceSchema,
  traceId: TraceIdSchema,
  spanId: SpanIdSchema,
  difficulty: DifficultySchema,
  /** Explicit race width from the user (1..5), or null to let the Queen decide. */
  bestOf: z.number().int().min(1).max(5).nullable(),
  /** Gate failures (mirrors prompt_runs.attempts) plus human retries. */
  attempts: z.number().int().min(0),
  /** Merge-conflict reworks, counted separately from attempts (D7). */
  conflicts: z.number().int().min(0).default(0),
  /** Predicted path patterns (≤10): they drive path affinity. Empty = unknown (optimistic). */
  paths: z.array(PathPatternSchema).max(10).default([]),
  /** Why a READY item is not dispatched yet. Display only. */
  waitReason: z.string().max(200).nullable().default(null),
  duplicateOf: z.string().nullable(),
  blockedReason: z.string().max(200).nullable(),
  releaseId: z.string().nullable(),
  escalationId: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;
export type WorkItemInput = z.input<typeof WorkItemSchema>;

/** A follow-up a drone (out-of-scope problem) or gatekeeper (finding outside the diff) files. */
export const FollowUpSchema = z.object({
  kind: z.enum(["bug", "chore"]),
  title: z.string().min(1).max(120),
  body: z.string().max(1000),
  paths: z.array(z.string().max(200)).max(10).default([]),
  priority: z.number().int().min(1).max(3).default(2),
});
export type FollowUp = z.infer<typeof FollowUpSchema>;
export type FollowUpInput = z.input<typeof FollowUpSchema>;

/** POST /hives/:hive/items (user). */
export const FileWorkItemSchema = z.object({
  kind: WorkKindSchema.exclude(["goal"]),
  title: z.string().min(1).max(120),
  body: z.string().max(4000).default(""),
  acceptance: z.array(z.string().max(200)).max(8).default([]),
  priority: PrioritySchema.default(2),
  parentId: z.string().optional(),
  dependsOn: z.array(z.string()).max(8).default([]),
  bestOf: z.number().int().min(1).max(5).optional(),
  difficulty: DifficultySchema.optional(),
  paths: z.array(PathPatternSchema).max(10).default([]),
});
export type FileWorkItem = z.infer<typeof FileWorkItemSchema>;
export type FileWorkItemInput = z.input<typeof FileWorkItemSchema>;

/** POST /hives/:hive/items/:id/actions. */
export const WorkActionSchema = z.object({
  action: z.enum(["retry", "cancel", "not_duplicate"]),
  note: z.string().max(500).optional(),
});
export type WorkAction = z.infer<typeof WorkActionSchema>;

/** Per-hive hard caps (§2.9). Defaults in GUARDRAIL_DEFAULTS; overrides clamped to GUARDRAIL_MAX. */
export const GuardrailsSchema = z.object({
  maxChildrenPerItem: z.number().int().min(1).max(24),
  maxDepth: z.number().int().min(1).max(3),
  maxOpenItems: z.number().int().min(1).max(1000),
  maxActiveTrains: z.number().int().min(1).max(256),
  maxRaceWidth: z.number().int().min(1).max(5),
  maxAutoFiledPerHour: z.number().int().min(0).max(30),
  maxFollowUpsPerBuild: z.number().int().min(0).max(5),
  maxQueueBatch: z.number().int().min(1).max(16),
  maxQueueDepth: z.number().int().min(1).max(8),
  maxConflictReworks: z.number().int().min(0).max(4),
});
export type Guardrails = z.infer<typeof GuardrailsSchema>;

export const GUARDRAIL_DEFAULTS = {
  maxChildrenPerItem: 8,
  maxDepth: 2,
  maxOpenItems: 40,
  maxActiveTrains: 24,
  maxRaceWidth: 3,
  maxAutoFiledPerHour: 10,
  maxFollowUpsPerBuild: 3,
  maxQueueBatch: 4,
  maxQueueDepth: 3,
  maxConflictReworks: 2,
} as const satisfies Guardrails;

/** The "max" column of §2.9: per-hive overrides are clamped to these (same as GuardrailsSchema's bounds). */
export const GUARDRAIL_MAX = {
  maxChildrenPerItem: 24,
  maxDepth: 3,
  maxOpenItems: 1000,
  maxActiveTrains: 256,
  maxRaceWidth: 5,
  maxAutoFiledPerHour: 30,
  maxFollowUpsPerBuild: 5,
  maxQueueBatch: 16,
  maxQueueDepth: 8,
  maxConflictReworks: 4,
} as const satisfies Guardrails;

/** TRIAGE: an auto-filed item scoring ≥ this against an open item is a DUPLICATE. */
export const DEDUPE_THRESHOLD = 0.9;
/** DECOMPOSE: a child scoring ≥ this against a live, non-terminal item is a DUPLICATE. */
export const CHILD_DEDUPE_THRESHOLD = 0.92;
/** After a race's first passing candidate, the others get this long to report. */
export const RACE_GRACE_MS = 90_000;

export const RaceStateSchema = z.enum(["RACING", "DECIDED", "ABANDONED"]);
export type RaceState = z.infer<typeof RaceStateSchema>;

/** Best-of-N (§2.3.6): w BUILD trains of one item on different models; the best passing one boards a car. */
export const RaceSchema = z.object({
  raceId: z.string(),
  itemId: z.string(),
  width: z.number().int().min(2).max(5),
  state: RaceStateSchema,
  trainIds: z.array(z.string()),
  winnerTrainId: z.string().nullable(),
  reason: z.string().max(300).nullable(),
  deadlineAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  decidedAt: z.number().int().nullable(),
});
export type Race = z.infer<typeof RaceSchema>;

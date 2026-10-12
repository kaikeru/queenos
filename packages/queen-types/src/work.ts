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

/** `agent`: code an external agent pushed to its person's inbox (`Queen-Origin: agent:<name>`); a human stays `user` (actor = email). */
export const WorkSourceKindSchema = z.enum(["user", "oracle", "drone", "gatekeeper", "sentinel", "queen", "agent"]);
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

/** Who decides a race (§10.2): the Queen's ranking (`auto`), or a human pick among the passed candidates. */
export const RaceJudgeSchema = z.enum(["auto", "human"]);
export type RaceJudge = z.infer<typeof RaceJudgeSchema>;

/**
 * An item whose code arrived through a person's inbox (human-push design §5): the branch it came from.
 * `handoff`: the contributor handed the item to the swarm (`Queen: rework` trailer or the `handoff` action).
 */
export const WorkItemInboxSchema = z.object({
  repo: z.string().min(1),
  ref: z.string().regex(/^refs\/heads\/.+/),
  handle: z.string().regex(/^[a-z0-9]{1,24}$/),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  handoff: z.boolean(),
});
export type WorkItemInbox = z.infer<typeof WorkItemInboxSchema>;

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
  /** Inbox origin (human or agent push): the branch and its latest head. Absent / null: Queen-solicited work. */
  inbox: WorkItemInboxSchema.nullable().optional(),
  /** Race judge for this item (§10.2); absent = the hive's `settings.race.judge`. Inert until T9a. */
  judge: RaceJudgeSchema.optional(),
  /** Entry window of this item's race (ms; MCP `create_goal`); absent = the hive's `settings.race.entryWindowMs`. Max = ENTRY_WINDOW_MAX_MS. */
  entryWindowMs: z.number().int().min(0).max(3_600_000).optional(),
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
  /** `human`: a race of this item waits for a pick (§10.2). Inert until T9a. */
  judge: RaceJudgeSchema.optional(),
});
export type FileWorkItem = z.infer<typeof FileWorkItemSchema>;
export type FileWorkItemInput = z.input<typeof FileWorkItemSchema>;

/** POST /hives/:hive/items/:id/actions. */
export const WorkActionSchema = z.object({
  /** `handoff`: an inbox item's contributor hands it to the swarm (a REWORK drone seeded with their head). */
  action: z.enum(["retry", "cancel", "not_duplicate", "handoff"]),
  note: z.string().max(500).optional(),
});
export type WorkAction = z.infer<typeof WorkActionSchema>;

/** Each guardrail's bounds (the "max" column of §2.9). */
const GUARDRAIL_FIELDS = {
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
  /** Human-push design §6.2: open inbox items per contributor; past it a push is `ignored:over-cap`. */
  maxInboxOpenPerContributor: z.number().int().min(1).max(10),
  /** Inbox pushes per contributor per hour. */
  maxInboxPushesPerHour: z.number().int().min(1).max(60),
  /** Races held in PICKING at once (§10.3); one more auto-decides (`queen:cap`). Inert until T9a. */
  maxPickingRaces: z.number().int().min(0).max(5),
};

/**
 * Per-hive hard caps (§2.9). Defaults in GUARDRAIL_DEFAULTS; overrides clamped to GUARDRAIL_MAX.
 * Caps added after v2 default on parse, so payloads from older Queens still parse.
 */
export const GuardrailsSchema = z.object({
  ...GUARDRAIL_FIELDS,
  maxInboxOpenPerContributor: GUARDRAIL_FIELDS.maxInboxOpenPerContributor.default(3),
  maxInboxPushesPerHour: GUARDRAIL_FIELDS.maxInboxPushesPerHour.default(20),
  maxPickingRaces: GUARDRAIL_FIELDS.maxPickingRaces.default(2),
});
export type Guardrails = z.infer<typeof GuardrailsSchema>;

/**
 * Guardrail overrides (stored settings, PATCH, env defaults): every key optional and, unlike
 * `GuardrailsSchema.partial()`, no defaults filled in, so an absent key stays absent.
 */
export const GuardrailOverridesSchema = z.object(GUARDRAIL_FIELDS).partial();
export type GuardrailOverrides = z.infer<typeof GuardrailOverridesSchema>;

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
  maxInboxOpenPerContributor: 3,
  maxInboxPushesPerHour: 20,
  maxPickingRaces: 2,
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
  maxInboxOpenPerContributor: 10,
  maxInboxPushesPerHour: 60,
  maxPickingRaces: 5,
} as const satisfies Guardrails;

/** TRIAGE: an auto-filed item scoring ≥ this against an open item is a DUPLICATE. */
export const DEDUPE_THRESHOLD = 0.9;
/** DECOMPOSE: a child scoring ≥ this against a live, non-terminal item is a DUPLICATE. */
export const CHILD_DEDUPE_THRESHOLD = 0.92;
/** After a race's first passing candidate, the others get this long to report. */
export const RACE_GRACE_MS = 90_000;

/** PICKING (§10.2): `judge = human` and ≥ 2 candidates passed; held for a human pick until `pickDeadlineAt`. */
export const RaceStateSchema = z.enum(["RACING", "PICKING", "DECIDED", "ABANDONED"]);
export type RaceState = z.infer<typeof RaceStateSchema>;

/** A PICKING race's default and longest pick window (§10.2). */
export const PICK_WINDOW_DEFAULT_MS = 15 * 60_000;
export const PICK_WINDOW_MAX_MS = 2 * 3_600_000;

/**
 * External hives: a race opened by a push stays open to new entries for this long from its creation (the first
 * push), and is not decided before it closes. Swarm hives never set an entry window (`entryClosesAt` stays null).
 */
export const ENTRY_WINDOW_DEFAULT_MS = 15 * 60_000;
export const ENTRY_WINDOW_MAX_MS = 3_600_000;

/**
 * Who decided a race (`Race.decidedBy`, `race.decided` event `data.by`): `human:<email>`, or the Queen:
 * `queen:auto` (ranking), `queen:single` (one passed), `queen:deadline` (pick window ran out),
 * `queen:cap` (over `maxPickingRaces`). Only `human:*` decisions move preference ratings (§10.5).
 */
export const RaceDecidedBySchema = z.string().regex(/^(human:.+|queen:(auto|single|deadline|cap))$/).max(340);
export type RaceDecidedBy = z.infer<typeof RaceDecidedBySchema>;

/** A candidate a human rejected while the race was PICKING (§10.4). */
export const RaceRejectionSchema = z.object({
  trainId: z.string().min(1),
  /** `human:<email>`. */
  by: z.string().min(1).max(340),
  reason: z.string().min(1).max(300),
});
export type RaceRejection = z.infer<typeof RaceRejectionSchema>;

/**
 * Best-of-N (§2.3.6): w BUILD trains of one item on different models; the best passing one boards a car.
 * Candidates are trains of any origin (`MergeTrain.origin`; a human or agent candidate has no model).
 * Width 1 is allowed (human-push design: every item can carry a race so a submission always has one to
 * enter); `width` counts the Queen-dispatched candidates, and `trainIds` grows as external entries join.
 */
export const RaceSchema = z.object({
  raceId: z.string(),
  itemId: z.string(),
  width: z.number().int().min(1).max(5),
  state: RaceStateSchema,
  trainIds: z.array(z.string()),
  winnerTrainId: z.string().nullable(),
  reason: z.string().max(300).nullable(),
  deadlineAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  decidedAt: z.number().int().nullable(),
  /**
   * Submissions targeting the item join as candidates until this time (null: until decided). Set in external
   * hives (`settings.race.entryWindowMs`, default ENTRY_WINDOW_DEFAULT_MS from the first push); the race is not
   * decided before it passes unless a human closes entries early (`race.entries-closed`).
   */
  entryClosesAt: z.number().int().nullable().optional(),
  // Human-judged races (§10.7; all optional, absent on older Queens; inert until T9a).
  /** PICKING: when the Queen auto-picks its recommendation (`queen:deadline`). */
  pickDeadlineAt: z.number().int().nullable().optional(),
  /** The `rankCandidates` winner at PICKING entry, and why. */
  recommendedTrainId: z.string().nullable().optional(),
  recommendReason: z.string().max(300).nullable().optional(),
  decidedBy: RaceDecidedBySchema.nullable().optional(),
  rejections: z.array(RaceRejectionSchema).max(16).optional(),
});
export type Race = z.infer<typeof RaceSchema>;

/** POST /hives/:hive/races/:raceId/pick (user route, §10.2). 409 unless the race is PICKING and `trainId` a live passed candidate. */
export const PickRaceSchema = z.object({
  trainId: z.string().min(1),
  reason: z.string().max(300).optional(),
});
export type PickRace = z.infer<typeof PickRaceSchema>;

/** POST /hives/:hive/races/:raceId/reject (user route, §10.4): one candidate, or `"all"` (none of these). */
export const RejectRaceSchema = z.object({
  trainId: z.union([z.literal("all"), z.string().min(1)]),
  reason: z.string().min(1).max(300),
});
export type RejectRace = z.infer<typeof RejectRaceSchema>;

import { z } from "zod";
import { HiveSlugSchema } from "./onboarding.js";
import { AgentHandleSchema, ClaimedModelSchema, SubmitDispositionSchema } from "./inbox.js";
import { RaceStateSchema } from "./work.js";
import { GateScoreSchema, TrainPhaseSchema } from "./train.js";
import { RaceOutcomeSchema } from "./state.js";

/**
 * MCP attempts (docs/superpowers/specs/2026-10-12-queenos-mcp-design.md §5-§8): one agent on one item gets its
 * own Artifacts repo, a fork of the item's frozen race base `<hive>-base-<12hex>`, plus a 2 h write token for that
 * fork only. `queenos-mcp` does the Artifacts I/O; the Queen decides and records over these DO RPC shapes.
 */

const Sha40 = z.string().regex(/^[0-9a-f]{40}$/);

/** Lifetime of an attempt fork's write token (and of the attempt without a refresh). */
export const ATTEMPT_TOKEN_TTL_S = 7200;
/** Non-terminal attempts one agent may hold across all hives. */
export const MAX_OPEN_ATTEMPTS_PER_AGENT = 3;
/** Longest single `wait` tool call. */
export const WAIT_MAX_MS = 50_000;
/** `queenos-mcp` re-asks `attemptIntent` this often while another first attempt creates the item's base... */
export const BASE_PENDING_POLL_MS = 2_000;
/** ...for at most this long, then the tool fails with retryable BASE_PENDING. */
export const BASE_PENDING_MAX_WAIT_MS = 30_000;

export const AttemptIdSchema = z.string().regex(/^att_[0-9a-f]{12}$/);
export const AgentIdSchema = z.string().regex(/^ag_[0-9a-f]{32}$/);
export const AgentRoleSchema = z.enum(["orchestrator", "worker"]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

/** The agent behind an MCP session. `model` is self-reported: display only, never routed or scored. */
export const McpAgentIdentitySchema = z.object({
  agentId: AgentIdSchema,
  name: AgentHandleSchema,
  model: ClaimedModelSchema,
  role: AgentRoleSchema,
  /** The token owner's email (edge-derived, never client-supplied). */
  owner: z.string().email(),
});
export type McpAgentIdentity = z.infer<typeof McpAgentIdentitySchema>;

export const AttemptStateSchema = z.enum(["INTENT", "READY", "PUSHED", "PASSED", "REJECTED", "WON", "LOST", "LANDED", "ABANDONED", "EXPIRED", "ABORTED"]);
export type AttemptState = z.infer<typeof AttemptStateSchema>;
export const TERMINAL_ATTEMPT_STATES = ["LOST", "LANDED", "ABANDONED", "EXPIRED", "ABORTED"] as const satisfies readonly AttemptState[];
export function isTerminalAttemptState(s: AttemptState): boolean {
  return (TERMINAL_ATTEMPT_STATES as readonly AttemptState[]).includes(s);
}

/** Every MCP tool error code (spec §11). */
export const McpErrorCodeSchema = z.enum([
  "NOT_INITIALIZED",
  "ALREADY_INITIALIZED",
  "FORBIDDEN_ROLE",
  "FORBIDDEN_OWNER",
  "HIVE_NOT_EXTERNAL",
  "NOT_FOUND",
  "INVALID_INPUT",
  "ITEM_NOT_ACCEPTING",
  "GOAL_AMBIGUOUS",
  "CAP_EXCEEDED",
  "BASE_PENDING",
  "BASE_MOVED",
  "ARTIFACTS_UNAVAILABLE",
  "ATTEMPT_EXPIRED",
  "CONFLICT",
]);
export type McpErrorCode = z.infer<typeof McpErrorCodeSchema>;

/** The codes a Queen attempt RPC answers with (a refusal is a value, not a thrown QueenError). */
export const AttemptRefusalCodeSchema = McpErrorCodeSchema.extract([
  "HIVE_NOT_EXTERNAL",
  "NOT_FOUND",
  "ITEM_NOT_ACCEPTING",
  "GOAL_AMBIGUOUS",
  "CAP_EXCEEDED",
  "BASE_PENDING",
  "BASE_MOVED",
  "FORBIDDEN_OWNER",
  "ATTEMPT_EXPIRED",
]);
export type AttemptRefusalCode = z.infer<typeof AttemptRefusalCodeSchema>;

/** The JSON body of an MCP tool error (`isError: true`). Safe to show: no tokens, no input values. */
export const McpToolErrorSchema = z.object({ code: McpErrorCodeSchema, message: z.string().max(200) });
export type McpToolError = z.infer<typeof McpToolErrorSchema>;

export const AttemptTargetSchema = z.union([z.object({ itemId: z.string().min(1).max(64) }).strict(), z.object({ goalId: z.string().min(1).max(64) }).strict()]);
export type AttemptTarget = z.infer<typeof AttemptTargetSchema>;

/** `attemptIntent`: `start_attempt` asks the Queen for an attempt id, a fork name and the item's base. */
export const AttemptIntentSchema = z.object({
  hive: HiveSlugSchema,
  owner: z.string().email(),
  agent: McpAgentIdentitySchema,
  target: AttemptTargetSchema,
});
export type AttemptIntent = z.infer<typeof AttemptIntentSchema>;

/** The item's race base: already pinned, or to be created by this caller (it alone got the base-pending lock). */
export const AttemptBaseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), baseRepo: z.string().min(1), baseSha: Sha40 }),
  z.object({ kind: z.literal("create"), baseRepo: z.string().min(1) }),
]);
export type AttemptBase = z.infer<typeof AttemptBaseSchema>;

export const GoalChildSchema = z.object({ itemId: z.string(), title: z.string(), status: z.string() });
export type GoalChild = z.infer<typeof GoalChildSchema>;

export const AttemptIntentDecisionSchema = z.discriminatedUnion("verdict", [
  z.object({
    verdict: z.literal("accept"),
    attemptId: AttemptIdSchema,
    /** The first train's id, reserved now; the train row is created by the first `attemptPushed`. */
    trainId: z.string().min(1),
    /** `<hive>-att-<12hex>`: the fork name `queenos-mcp` creates (it may end up `-rN`). */
    repo: z.string().min(1),
    itemId: z.string().min(1),
    raceId: z.string().nullable(),
    expiresAt: z.number().int(),
    base: AttemptBaseSchema,
  }),
  z.object({
    verdict: z.literal("refuse"),
    code: AttemptRefusalCodeSchema,
    message: z.string().max(200),
    /** GOAL_AMBIGUOUS: the goal's open children. */
    items: z.array(GoalChildSchema).max(24).optional(),
  }),
]);
export type AttemptIntentDecision = z.infer<typeof AttemptIntentDecisionSchema>;

export const AttemptBaseReadySchema = z.object({ hive: HiveSlugSchema, itemId: z.string().min(1), baseRepo: z.string().min(1), baseSha: Sha40 });
export type AttemptBaseReady = z.infer<typeof AttemptBaseReadySchema>;

/** The base fork failed after retries. `attemptId` (the caller's INTENT, aborted with it) is an addition to spec §8.1. */
export const AttemptBaseFailedSchema = z.object({
  hive: HiveSlugSchema,
  itemId: z.string().min(1),
  baseRepo: z.string().min(1),
  reason: z.string().max(200),
  attemptId: AttemptIdSchema.optional(),
});
export type AttemptBaseFailed = z.infer<typeof AttemptBaseFailedSchema>;

export const AttemptReadySchema = z.object({
  hive: HiveSlugSchema,
  attemptId: AttemptIdSchema,
  /** The actual fork name (may be `-rN`). */
  repo: z.string().min(1),
  /** The fork's `main` head; must equal the item's `base_sha`. */
  baseSha: Sha40,
  /** The minted token's expiry (epoch ms). */
  expiresAt: z.number().int(),
});
export type AttemptReady = z.infer<typeof AttemptReadySchema>;

export const AttemptAbortedSchema = z.object({ hive: HiveSlugSchema, attemptId: AttemptIdSchema, reason: z.string().max(200) });
export type AttemptAborted = z.infer<typeof AttemptAbortedSchema>;

/** Gatekeepers: a push landed on `main` of an attempt fork (and `after` is the fork's current head). */
export const AttemptPushedSchema = z.object({
  hive: HiveSlugSchema,
  attemptId: AttemptIdSchema,
  repo: z.string().min(1),
  before: Sha40.optional(),
  after: Sha40,
  title: z.string().max(120),
  message: z.string().max(4000),
});
export type AttemptPushed = z.infer<typeof AttemptPushedSchema>;

/** `attemptRefresh` / `attemptEnd`: only the attempt's own owner and agent may act on it. */
export const AttemptOwnerActionSchema = z.object({ hive: HiveSlugSchema, attemptId: AttemptIdSchema, owner: z.string().email(), agentId: AgentIdSchema });
export type AttemptOwnerAction = z.infer<typeof AttemptOwnerActionSchema>;
export const AttemptRefreshSchema = AttemptOwnerActionSchema;
export const AttemptEndSchema = AttemptOwnerActionSchema;

/** Row of the Queen's `attempts` table (migration v17). */
export const AttemptSchema = z.object({
  attemptId: AttemptIdSchema,
  hive: z.string().min(1),
  /** Moves to the follow-up item on a late push. */
  itemId: z.string().min(1),
  raceId: z.string().nullable(),
  /** The current train (the first one reserved at intent). */
  trainId: z.string().min(1),
  repo: z.string().min(1),
  /** Always the item's base_sha (null until the base is pinned). */
  baseSha: Sha40.nullable(),
  agentId: AgentIdSchema,
  agentName: AgentHandleSchema,
  model: ClaimedModelSchema,
  role: AgentRoleSchema,
  owner: z.string().email(),
  state: AttemptStateSchema,
  headSha: Sha40.nullable(),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

/** The gate's word on the attempt's current head: none (no push yet), pending, passed or rejected. */
export const AttemptVerdictSchema = z.enum(["none", "pending", "passed", "rejected"]);
export type AttemptVerdict = z.infer<typeof AttemptVerdictSchema>;

/** `getAttempt`: the row plus its current train and race. */
export const AttemptViewSchema = AttemptSchema.extend({
  train: z
    .object({
      trainId: z.string(),
      phase: TrainPhaseSchema,
      raceOutcome: RaceOutcomeSchema.nullable(),
      headSha: z.string().nullable(),
      previewUrl: z.string().nullable(),
      summary: z.string().max(500).nullable(),
      reason: z.string().nullable(),
      score: GateScoreSchema.nullable(),
    })
    .nullable(),
  race: z.object({ raceId: z.string(), state: RaceStateSchema, entryClosesAt: z.number().int().nullable(), winnerTrainId: z.string().nullable() }).nullable(),
  verdict: AttemptVerdictSchema,
});
export type AttemptView = z.infer<typeof AttemptViewSchema>;

/** `attemptsForItem`: the item's shared base and every attempt on it. */
export const ItemAttemptsSchema = z.object({
  itemId: z.string(),
  baseSha: Sha40.nullable(),
  basePending: z.boolean(),
  attempts: z.array(AttemptViewSchema),
});
export type ItemAttempts = z.infer<typeof ItemAttemptsSchema>;

/** `attemptReady` / `attemptRefresh` / `attemptEnd`. `changed: false`: a no-op (a repeat, or a boarded attempt on end). */
export const AttemptResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), attempt: AttemptViewSchema, changed: z.boolean() }),
  z.object({ ok: z.literal(false), code: AttemptRefusalCodeSchema, message: z.string().max(200) }),
]);
export type AttemptResult = z.infer<typeof AttemptResultSchema>;

export const AttemptPushedResultSchema = z.object({
  outcome: z.enum(["applied", "duplicate", "ignored:unknown", "ignored:base", "ignored:state"]),
  attemptId: z.string(),
  state: AttemptStateSchema.nullable(),
  itemId: z.string().nullable(),
  trainId: z.string().nullable(),
  disposition: SubmitDispositionSchema.nullable(),
});
export type AttemptPushedResult = z.infer<typeof AttemptPushedResultSchema>;

/** `<hive>-att-<12hex>` plus the re-fork suffix `-rN` (mirrors the train pattern in apps/gatekeepers/src/event.ts). */
export const ATTEMPT_REPO_RE = /^(.+)-att-([0-9a-f]{12})(?:-r\d+)?$/;
/** `<hive>-base-<12hex>` plus `-rN`. */
export const BASE_REPO_RE = /^(.+)-base-([0-9a-f]{12})(?:-r\d+)?$/;

export function attemptRepoName(hive: string, attemptId: string): string {
  return `${hive}-att-${attemptId.replace(/^att_/, "")}`;
}

export function baseRepoName(hive: string, baseId: string): string {
  return `${hive}-base-${baseId}`;
}

export function parseAttemptRepo(repo: string): { hive: string; attemptId: string } | null {
  const m = ATTEMPT_REPO_RE.exec(repo);
  return m ? { hive: m[1]!, attemptId: `att_${m[2]!}` } : null;
}

export function parseBaseRepo(repo: string): { hive: string; baseId: string } | null {
  const m = BASE_REPO_RE.exec(repo);
  return m ? { hive: m[1]!, baseId: m[2]! } : null;
}

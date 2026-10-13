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
  /** A transient Queen / DO / RPC failure (a deploy, an overload, an unrecognised error). Retryable. */
  "UNAVAILABLE",
]);
export type McpErrorCode = z.infer<typeof McpErrorCodeSchema>;

/**
 * Whether an agent should call the tool again (after `retryAfterMs`, default 2 s) on each code. A specific error may
 * override it: `CAP_EXCEEDED` with a `retryAfterMs` (a cap that frees up at a known time) is retryable.
 */
export const MCP_ERROR_RETRYABLE: Readonly<Record<McpErrorCode, boolean>> = {
  NOT_INITIALIZED: false,
  ALREADY_INITIALIZED: false,
  FORBIDDEN_ROLE: false,
  FORBIDDEN_OWNER: false,
  HIVE_NOT_EXTERNAL: false,
  NOT_FOUND: false,
  INVALID_INPUT: false,
  ITEM_NOT_ACCEPTING: false,
  GOAL_AMBIGUOUS: false,
  CAP_EXCEEDED: false,
  BASE_PENDING: true,
  BASE_MOVED: true,
  ARTIFACTS_UNAVAILABLE: true,
  ATTEMPT_EXPIRED: false,
  CONFLICT: false,
  UNAVAILABLE: true,
};

/** How long to wait before calling again (ms, at most 1 h). */
export const RetryAfterMsSchema = z.number().int().min(0).max(3_600_000);

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
  /** attemptRegate: nothing to re-gate (no push yet, the head passed, or the last verdict was findings). */
  "CONFLICT",
]);
export type AttemptRefusalCode = z.infer<typeof AttemptRefusalCodeSchema>;

export const GoalChildSchema = z.object({ itemId: z.string(), title: z.string(), status: z.string() });
export type GoalChild = z.infer<typeof GoalChildSchema>;

/** The JSON body of an MCP tool error (`isError: true`). Safe to show: no tokens, no input values. */
export const McpToolErrorSchema = z.object({
  code: McpErrorCodeSchema,
  message: z.string().max(200),
  /** Call again (after `retryAfterMs`, default 2 s)? Defaults to MCP_ERROR_RETRYABLE[code]. */
  retryable: z.boolean(),
  retryAfterMs: RetryAfterMsSchema.optional(),
  /** GOAL_AMBIGUOUS: the goal's open children. */
  items: z.array(GoalChildSchema).max(24).optional(),
});
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
    /** When the refusal is known to clear (CAP_EXCEEDED hourly cap: its oldest counted start ages out; BASE_PENDING: the poll). */
    retryAfterMs: RetryAfterMsSchema.optional(),
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
/** `attemptRegate` (MCP `retry_gates`): re-run the gates on the attempt's current head after an infra verdict. */
export const AttemptRegateSchema = AttemptOwnerActionSchema;
export type AttemptRegate = AttemptOwnerAction;
/** Manual re-gates (`attemptRegate`) one attempt may request... */
export const MAX_MANUAL_REGATES = 3;
/** ...at most one per this interval. */
export const REGATE_MIN_INTERVAL_MS = 60_000;

// ── rework loop (docs/superpowers/specs/2026-10-13-queenos-rework-loop-design.md) ──

/** Why an attempt got a rework slot: gate findings (or an integration failure in the train), a merge conflict, a human reject. */
export const ReworkReasonSchema = z.enum(["findings", "conflict", "human"]);
export type ReworkReason = z.infer<typeof ReworkReasonSchema>;

/** An open rework slot: fix and push again before `dueAt` (epoch ms), as the same candidate. `round` is 1-based. */
export const AttemptReworkSchema = z.object({ reason: ReworkReasonSchema, dueAt: z.number().int(), round: z.number().int().min(1) });
export type AttemptRework = z.infer<typeof AttemptReworkSchema>;

/** Opening a slot extends `expires_at` to at least `dueAt +` this, so the watchdog never expires an attempt mid-slot (§5.1). */
export const REWORK_EXPIRY_GRACE_MS = 10 * 60_000;
/** `sync_base`: the read token on the hive repo lives this long. */
export const SYNC_TOKEN_TTL_S = 1800;

const REWORK_REASON_RE = /^in rework \((findings|conflict|human)\) until (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z): /;

/**
 * A REWORK train's `reason`: `in rework (<reason>) until <ISO>: <why>` (≤ 500). It carries the slot's due time to the
 * dashboard and the notes; the attempt row stays the authority for the slot itself.
 */
export function reworkReasonText(reason: ReworkReason, dueAt: number, why: string): string {
  const s = `in rework (${reason}) until ${new Date(dueAt).toISOString()}: ${why}`;
  return s.length <= 500 ? s : `${s.slice(0, 499)}…`;
}

/** The slot reason and due time of a REWORK train's `reason`, or null for any other text. */
export function parseReworkReason(text: string | null | undefined): { reason: ReworkReason; dueAt: number } | null {
  const m = text ? REWORK_REASON_RE.exec(text) : null;
  return m ? { reason: m[1] as ReworkReason, dueAt: Date.parse(m[2]!) } : null;
}

/** `attemptSyncBase` (MCP `sync_base`): record hive `main`'s sha (read from Artifacts by queenos-mcp) as the attempt's base. */
export const AttemptSyncBaseSchema = AttemptOwnerActionSchema.extend({ baseSha: Sha40 });
export type AttemptSyncBase = z.infer<typeof AttemptSyncBaseSchema>;

/** `sync_base`'s answer. The read token appears only inside `syncCommand`. */
export const SyncBaseResultSchema = z.object({ baseSha: Sha40, syncCommand: z.string().min(1), next: z.string().min(1) });
export type SyncBaseResult = z.infer<typeof SyncBaseResultSchema>;

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
  /** The base the attempt's next push is gated against: the item's base_sha, or hive main recorded by `sync_base` (v19). */
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
  /** v18: manual re-gates requested (`attemptRegate`); absent = 0. */
  regates: z.number().int().min(0).optional(),
  /** v18: when the last manual re-gate was requested (epoch ms); absent = never. */
  lastRegateAt: z.number().int().optional(),
  /** v19: slots given so far (findings, conflicts and human rejects share it); absent = 0. */
  reworks: z.number().int().min(0).optional(),
  /** v19: the open rework slot; null / absent = none. */
  rework: AttemptReworkSchema.nullable().optional(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

/** The gate's word on the attempt's current head: none (no push yet), pending, passed or rejected. */
export const AttemptVerdictSchema = z.enum(["none", "pending", "passed", "rejected"]);
export type AttemptVerdict = z.infer<typeof AttemptVerdictSchema>;

/**
 * Why a `rejected` verdict: `findings` (the gate judged the change, or it failed integrated in the train: fix and push),
 * `infra` (the gate could not run: `retry_gates`), `conflict` (it conflicted with work that landed: `sync_base`, rebase,
 * push), `human` (a judge rejected it with a reason: address it and push).
 */
export const AttemptVerdictKindSchema = z.enum(["findings", "infra", "conflict", "human"]);
export type AttemptVerdictKind = z.infer<typeof AttemptVerdictKindSchema>;

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
      /** Automatic gate-infra re-gates of this train so far (v18). Optional: absent from an older Queen. */
      gateInfraRounds: z.number().int().min(0).optional(),
      /** The merge conflict that ejected it from its car (v19 views; absent from an older Queen). */
      conflict: z.object({ paths: z.array(z.string()), summary: z.string() }).nullable().optional(),
    })
    .nullable(),
  race: z
    .object({ raceId: z.string(), state: RaceStateSchema, entryClosesAt: z.number().int().nullable(), winnerTrainId: z.string().nullable(), reopens: z.number().int().min(0).optional() })
    .nullable(),
  verdict: AttemptVerdictSchema,
  /** Set when `verdict === "rejected"`, else null. Optional: absent from an older Queen (read absent as unknown). */
  verdictKind: AttemptVerdictKindSchema.nullable().optional(),
  /**
   * The gate could not run and the Queen re-gates the same head automatically: re-gate `round` of `of`, starting no
   * earlier than `notBefore` (epoch ms). The verdict stays `pending`. Null: no automatic re-gate pending.
   */
  regating: z.object({ round: z.number().int().min(1), of: z.number().int().min(1), notBefore: z.number().int().nullable() }).nullable().optional(),
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
  z.object({ ok: z.literal(false), code: AttemptRefusalCodeSchema, message: z.string().max(200), retryAfterMs: RetryAfterMsSchema.optional() }),
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

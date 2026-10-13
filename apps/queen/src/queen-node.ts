/**
 * QueenNode: one Durable Object per hive (namespace). The hive's single
 * source of truth: SQLite state, one decision pipeline, WebSocket broadcast.
 *
 * Orchestrator only: the Queen decides, records and dispatches. It performs no
 * external I/O itself; forks/deletes run in the Provisioner Workflow, preview
 * and release deploys in the Herald, health verdicts in the Sentinel,
 * decomposition and dedupe in the Oracle, builds/merges/landings in drones.
 * Each reports back over RPC (reportProvisionResult, reportMergeResult, ...).
 *
 * v2 decision pipeline (design §3.1). Every RPC runs `decide()`:
 *
 *   (async, before) the SwarmGovernor lease when due (D9; a soft global ceiling)
 *   decide(run):                       all synchronous: no await until commit()
 *     ctx   = settings, effective autonomy (policy.ts), budget, guardrails, lease
 *     state = StateCache (warm active rows; loaded from SQLite on a cold start)
 *     tp, rp, wp, ep = TrainPlanner, ReleasePlanner, WorkPlanner, EscalationPlanner
 *     run(tp, rp, wp, ep)              the triggering transition
 *       (a car landing feeds rp.landed with every member at once)
 *     wp.absorb(...)                   prompt → item status, claims, releases → SHIPPED / P0 bug, follow-ups
 *     ep.resolveStale(...)             superseded approvals, retried items
 *     wp.dispatchReady(...) → tp.submit(...) for each READY item (BUILD trains, all forked from main)
 *     autonomyTransition(...)          degraded_by, ERROR_BUDGET_EXHAUSTED
 *   commit(): rows + events + metric rollups in one transactionSync; then the
 *     cache update, the coalesced broadcast (one `batch` frame per ≤100 ms),
 *     Analytics Engine points (never awaited), and executor dispatch (Workflows
 *     `createBatch`, ≤100 per call). Command ids are durable before dispatch,
 *     so a crash is repaired by the reconcile alarm and a re-dispatch is a no-op.
 *
 * The alarm runs tp/rp/wp.reconcile (watchdogs, race deadlines, the queue,
 * the Oracle watchdog, stale claims), prunes the event log and renews the lease.
 *
 * Context compaction: the Queen never stores raw code, diffs or stack traces,
 * only Scribe summaries (<= 500 chars, enforced by the queen-types schemas).
 *
 * Git intake (human-push design rev 2, T1): the git proxy Worker (apps/git) is the intake executor. It asks
 * `gitIntent` before it forks (state rules, caps, target resolution; a pre-forked train), reports
 * `gitPushed` after the push landed in that fork (the Submission: file / join / reopen / supersede; the
 * train enters the pipeline like a drone's build) or `gitAborted`, and serves `notesFor` (the v1 notes
 * projection of this ledger). Every outcome is a `submissions` row.
 */
import { DurableObject } from "cloudflare:workers";
import {
  AppendAuditSchema,
  AppendAuditsSchema,
  AttemptAbortedSchema,
  AttemptBaseFailedSchema,
  AttemptBaseReadySchema,
  AttemptEndSchema,
  AttemptIntentSchema,
  AttemptPushedSchema,
  AttemptReadySchema,
  AttemptRefreshSchema,
  AttemptRegateSchema,
  BASE_PENDING_POLL_MS,
  MAX_MANUAL_REGATES,
  RACE_GRACE_MS,
  REGATE_MIN_INTERVAL_MS,
  REWORK_EXPIRY_GRACE_MS,
  isTerminalAttemptState,
  traceparent,
  MAX_OPEN_ATTEMPTS_PER_AGENT,
  attemptRepoName,
  baseRepoName,
  BuildResultSchema,
  DeployResultSchema,
  ENTRY_WINDOW_DEFAULT_MS,
  EventQuerySchema,
  FileWorkItemSchema,
  GitAbortedSchema,
  GitPushIntentSchema,
  GitPushedSchema,
  LandResultSchema,
  NotesRefSchema,
  MergeResultSchema,
  OracleResultSchema,
  PickRaceSchema,
  ProvisionResultSchema,
  QueenClientMessageSchema,
  ResolveEscalationSchema,
  ScribeSummarySchema,
  SentinelVerdictSchema,
  SubmitPromptSchema,
  TERMINAL_WORK_STATUSES,
  TrainResultSchema,
  UpdateHiveSettingsSchema,
  WorkActionSchema,
  GuardrailOverridesSchema,
  parseTraceparent,
  spanIdFor,
  targetFromRef,
  traceIdFromUuid,
  type AppendAuditInput,
  type Attempt,
  type AttemptAborted,
  type AttemptBase,
  type AttemptBaseFailed,
  type AttemptBaseReady,
  type AttemptIntent,
  type AttemptIntentDecision,
  type AttemptOwnerAction,
  type AttemptPushed,
  type AttemptPushedResult,
  type AttemptReady,
  type AttemptRefusalCode,
  type AttemptResult,
  type AttemptView,
  type GoalChild,
  type ItemAttempts,
  type AuditEvent,
  type BuildResult,
  type DeployResult,
  type Deployment,
  type Escalation,
  type EventDraft,
  type EventQueryInput,
  type FileWorkItemInput,
  type FollowUp,
  type GateTarget,
  type GitAborted,
  type GitIntakeDecision,
  type GitPushIntent,
  type GitPushed,
  type GitPushedResult,
  type HiveSettings,
  type HiveStatus,
  type ItemDetail,
  type LandResultInput,
  type MergeResultInput,
  type MergeTrain,
  type MetricsView,
  type NotesProjection,
  type OracleResultInput,
  type PickRace as PickRaceInput,
  type PromptRun,
  type ProvisionResult,
  type QueenEvent,
  type QueenServerMessage,
  type QueenServerUnitMessage,
  type QueueView,
  type Race,
  type ReworkReason,
  type RaceJudge,
  type Release,
  type ScribeSummary,
  type SentinelVerdict,
  type SubmitPrompt,
  type SubmissionOrigin,
  type SubmitDisposition,
  type TraceView,
  type TrainResult,
  type UpdateHiveSettings,
  type WorkAction,
  type WorkItem,
} from "@queenos/queen-types";
import {
  ESCALATION_SELECT,
  applyModelStatDelta,
  applyPickDelta,
  appendAuditRow,
  attemptsOfItem,
  deleteClaims,
  dueRepoDeletes,
  getAttemptRow,
  getRepoDelete,
  getItemBase,
  getSubmission,
  setItemBase,
  upsertAttempt,
  upsertRepoDelete,
  type ItemBase,
  type RepoDelete,
  listModelStats,
  listRecentAudit,
  listRouterStats,
  listVerdicts,
  loadHiveSettings,
  loadRouter,
  insertSubmission,
  migrate,
  pruneSubmissions,
  repoDeletesOfKey,
  rowToAttempt,
  rowToDeployment,
  rowToEscalation,
  rowToEvent,
  rowToPrompt,
  rowToRace,
  rowToRelease,
  rowToSubmission,
  rowToTrain,
  rowToWorkItem,
  saveRouter,
  upsertClaim,
  upsertDeployment,
  upsertEscalation,
  upsertHiveSettings,
  upsertPrompt,
  upsertRace,
  upsertRelease,
  upsertTrain,
  upsertVerdict,
  upsertWorkItem,
  updateSubmission,
  type SubmissionRecord,
} from "./db";
import { WorkflowDroneDispatcher, droneInstanceId, type DroneDispatcher } from "./drones";
import {
  WorkflowCommandDispatcher,
  type DeployDispatcher,
  type OracleDispatcher,
  type GatekeeperDispatcher,
  type ProvisionerDispatcher,
  type SentinelDispatcher,
} from "./executors";
import { QueenError, asQueenError, parseOrThrow, type QueenErrorCode } from "./errors";
import { DEFAULT_POLICY, toRouterFloor, type FloorState, type RouterPolicy } from "./models/router";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_ATTEMPTS,
  TrainPlanner,
  commandAttempt,
  awaitingPush,
  isActive,
  isCar,
  isContributed,
  MAX_GATE_INFRA_ROUNDS,
  isParked,
  keptFork,
  isForkOf,
  trainRepoName,
  toMergeTrainV2,
  toPromptRun,
  traceOfTrain,
  watchdogDeadline,
  type Effect,
  type HiveState,
  type ModelStatDelta,
  type Outcome,
  type PickDelta,
  type PlanResult,
  type PlannerItem,
  type PromptRecord,
  type TrainPhase,
  type TrainRecord,
} from "./train/planner";
import {
  DEFAULT_SENTINEL,
  ReleasePlanner,
  releaseWatchdogDeadline,
  toRelease,
  type ReleaseEffect,
  type ReleaseOutcome,
  type ReleasePlanResult,
  type ReleaseRecord,
  type SentinelSettings,
} from "./release/planner";
import { WorkPlanner, toWorkItem, workWatchdogDeadline, type AbsorbFollowUps, type WorkEffect, type WorkPlanResult } from "./work/ledger";
import { budgetExhausted, creditsFor, defaultSettingsRecord, effectiveSettings, rollBudgetDay, utcDay } from "./work/guardrails";
import { raceWidth } from "./train/race";
import { iso, reworkDeadlines, type AttemptSlot } from "./train/rework";
import { humanBy, keptLoser } from "./train/pick";
import { EscalationPlanner, type EscalationIntent, type EscalationPlanResult } from "./autonomy/escalation";
import { autonomyTransition, changeSuccessFromReleases, effectiveAutonomy, errorBudget, hiveHeadline, type EffectiveAutonomy, type SloStatus } from "./autonomy/policy";
import { appendEvents, pruneEvents, queryEvents } from "./obs/events";
import {
  entryWindowLine,
  pushedMessages,
  decideIntake,
  decideIntent,
  handleFor,
  originOf,
  remoteLines,
  short,
  slugify,
  trailersOf,
  lateReason,
  raceClosedToEntries,
  type IntakeItem,
  type IntakeLookup,
  type IntakePlan,
  type PriorSubmission,
} from "./work/inbox";
import { MAX_NOTES, projectNotes, type NotesInput, type NotesTrain } from "./work/notes";
import { composePrompt } from "./work/compose";
import {
  ATTEMPT_TTL_MS,
  BASE_PENDING_TTL_MS,
  INTENT_TTL_MS,
  OPEN_ATTEMPTS_SQL,
  PUSHABLE_STATES,
  acceptsEntries,
  attemptRegating,
  attemptStateOf,
  attemptVerdict,
  attemptVerdictKind,
  checkAttemptCaps,
  randomHex,
} from "./work/attempts";
import { queryMetrics, recordMetrics } from "./obs/rollup";
import { AnalyticsSink } from "./obs/metrics-sink";
import { logEvents } from "./obs/log";
import { buildTraceView } from "./obs/trace-view";
import { StateCache, type ActiveState } from "./scale/state-cache";
import { Coalescer } from "./scale/broadcast";
import type { EscalationRecord, HiveSettingsRecord, PathClaim, RaceRecord, WorkItemRecord } from "./records";

/** Header the Worker uses to tell the DO which hive a WebSocket belongs to. */
export const HIVE_HEADER = "x-queen-hive";
export const DEFAULT_HIVE = "queen";
/** Hive names become Artifacts repo names (`<hive>` and `<hive>-train-<id>`). */
export const NAMESPACE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
/** Well below the 32,768 hibernatable-socket limit. */
export const MAX_SOCKETS = 1000;
/** Client frames are small JSON commands; refuse anything bigger. */
export const MAX_FRAME_BYTES = 64 * 1024;
/** Prompts are instructions, not code dumps. */
export const MAX_PROMPT_CHARS = 16_000;
/** Ledger entries are compact reasoning, not logs. */
export const MAX_GIT_NOTES_BYTES = 16 * 1024;
export const RECONCILE_DELAY_MS = 15_000;
/**
 * Bound on one executor dispatch call (a Workflows create / createBatch). A call that hangs past it counts as
 * failed (ioFailed: reconcile re-sends the same command ids within RECONCILE_DELAY_MS) instead of stalling the
 * whole effect batch of a committed decision until some later alarm. Well under an executor's 30 s report step.
 */
export const DISPATCH_TIMEOUT_MS = 8_000;
/** Fire the watchdog alarm a little after the deadline so the command has surely expired. */
export const WATCHDOG_SLACK_MS = 1_000;
/** SwarmGovernor lease length; renewed when it expires within LEASE_RENEW_MS. */
export const LEASE_TTL_MS = 120_000;
export const LEASE_RENEW_MS = 30_000;
/** Header the edge sets to the Cloudflare Access-verified user email (user routes only). */
export const USER_HEADER = "x-queen-user";

const SNAPSHOT_LIMIT = 200;
const RELEASE_SNAPSHOT_LIMIT = 20;
const AUDIT_SNAPSHOT_LIMIT = 50;
const EVENTS_SNAPSHOT_LIMIT = 50;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const TERMINAL_ITEMS_SQL = TERMINAL_WORK_STATUSES.map((s) => `'${s}'`).join(", ");
/** Submission rows are pruned with the event log (30 days). */
export const SUBMISSION_RETENTION_MS = 30 * DAY_MS;
/** A contributor's open pushed items: not landed, shipped or closed. */
const OPEN_PUSHED_SQL = "('LANDED', 'SHIPPED', 'CANCELLED', 'DUPLICATE')";

/** COMMAND_TIMEOUT_MS (wrangler var, milliseconds); default 10 min. */
export function commandTimeoutMs(env: { COMMAND_TIMEOUT_MS?: string | number }): number {
  const v = Number(env.COMMAND_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_COMMAND_TIMEOUT_MS;
}
/** SENTINEL_WINDOW_SECONDS / SENTINEL_MIN_REQUESTS (wrangler vars); defaults 60 s / 100 requests. */
export function sentinelSettings(env: { SENTINEL_WINDOW_SECONDS?: string | number; SENTINEL_MIN_REQUESTS?: string | number }): SentinelSettings {
  const int = (v: unknown, min: number, fallback: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min ? n : fallback;
  };
  return {
    windowSeconds: int(env.SENTINEL_WINDOW_SECONDS, 5, DEFAULT_SENTINEL.windowSeconds),
    minRequests: int(env.SENTINEL_MIN_REQUESTS, 1, DEFAULT_SENTINEL.minRequests),
  };
}
/** MODEL_ROUTER_PIN_BUILDER (wrangler var): force one model for builder / rework drones; unset or blank = route. */
export function modelPin(env: { MODEL_ROUTER_PIN_BUILDER?: string }): string | null {
  const v = typeof env.MODEL_ROUTER_PIN_BUILDER === "string" ? env.MODEL_ROUTER_PIN_BUILDER.trim() : "";
  return v || null;
}
/** ROUTER_BACKOFF_STREAK (K, default 3) / ROUTER_PROBE_AFTER (N, default 4) wrangler vars. */
export function routerPolicy(env: { ROUTER_BACKOFF_STREAK?: string | number; ROUTER_PROBE_AFTER?: string | number }): RouterPolicy {
  const int = (v: unknown, fallback: number) => {
    const n = Number(v);
    return v !== undefined && v !== "" && Number.isInteger(n) && n >= 1 ? n : fallback;
  };
  return {
    backoffStreak: int(env.ROUTER_BACKOFF_STREAK, DEFAULT_POLICY.backoffStreak),
    probeAfter: int(env.ROUTER_PROBE_AFTER, DEFAULT_POLICY.probeAfter),
  };
}
/**
 * HIVE_DEFAULT_GUARDRAILS (wrangler var, JSON): guardrail overrides a NEW hive
 * starts with (the sim raises maxActiveTrains to 64 and maxChildrenPerItem to 24).
 */
export function defaultGuardrailOverrides(env: { HIVE_DEFAULT_GUARDRAILS?: string }): Partial<HiveSettings["guardrails"]> {
  if (!env.HIVE_DEFAULT_GUARDRAILS) return {};
  try {
    const parsed = GuardrailOverridesSchema.safeParse(JSON.parse(env.HIVE_DEFAULT_GUARDRAILS));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export interface QueenPorts {
  /** Provisioner Workflow (FORK / DELETE). */
  provisioner: ProvisionerDispatcher;
  /** Herald Workflow (DEPLOY / TEARDOWN / ROLLBACK). */
  herald: DeployDispatcher;
  /** Sentinel Workflow (release health verdicts). */
  sentinel: SentinelDispatcher;
  /** Drone Workflow (BUILD / REWORK / MERGE / LAND). */
  dispatcher: DroneDispatcher;
  /** Oracle Workflow (DECOMPOSE / TRIAGE). */
  oracle: OracleDispatcher;
  /** Gatekeepers Workflow: Queen-started gates (GATE) for trains that enter TESTING. */
  gatekeeper: GatekeeperDispatcher;
}

/** Per-socket state; survives hibernation (<= 16 KiB). */
export interface SocketAttachment {
  id: string;
  role: "dashboard" | "drone";
  hive: string;
  subscribed: boolean;
  connectedAt: number;
}

export interface TrainUpdate {
  outcome: Outcome;
  train: MergeTrain | null;
}

export interface ReleaseUpdate {
  outcome: ReleaseOutcome;
  release: Release | null;
}

export interface WorkUpdate {
  outcome: string;
  item: WorkItem | null;
}

type Snapshot = Extract<QueenServerMessage, { type: "snapshot" }>;
type AnyEffect = Effect | ReleaseEffect | WorkEffect;
type Dispatchable = Exclude<AnyEffect, { type: "broadcast" }>;

export function assertNamespace(namespace: string): void {
  if (!NAMESPACE_RE.test(namespace)) {
    throw new QueenError("INVALID_INPUT", `invalid hive namespace "${namespace}" (letters, digits, . _ -; max 63)`);
  }
}

const claimKey = (c: Pick<PathClaim, "itemId" | "path">) => `${c.itemId}\u0000${c.path}`;
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const httpCode = (status: number): QueenErrorCode => (status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "INVALID_INPUT");

/** Everything one decide() changed, persisted in one transaction. */
class Acc {
  prompts = new Map<string, PromptRecord>();
  trains = new Map<string, TrainRecord>();
  deployments = new Map<string, Deployment>();
  releases = new Map<string, ReleaseRecord>();
  races = new Map<string, RaceRecord>();
  items = new Map<string, WorkItemRecord>();
  claims = new Map<string, PathClaim>();
  released = new Set<string>();
  escalations = new Map<string, Escalation>();
  /** WorkPlanner's latest settings row (budget, hourly counters). */
  settings: HiveSettingsRecord | null = null;
  events: EventDraft[] = [];
  effects: AnyEffect[] = [];
  modelStats: ModelStatDelta[] = [];
  /** T9a: human picks to count (model_stats picks / picks_against_recommendation). */
  picks: PickDelta[] = [];
  routerDispatches?: number;
  routerFloor?: FloorState;
  itemConflicts = new Map<string, number>();
  conflictClaims: { itemId: string; paths: string[] }[] = [];
  carInfraFailures?: number;
  executorLost = false;
  /** Prompts FAILED on infrastructure (→ EXECUTOR_LOST on the item, not REWORK_EXHAUSTED). */
  infraFailed = new Map<string, string>();
  /** T1: prompts of contributed code FAILED at the gate (→ FAILED "awaiting contributor", no escalation). */
  awaiting = new Map<string, string>();
  /** T1: push intents ended without a push (→ their submission rows `aborted:transient`). */
  abortedIntents: string[] = [];
  /** T1: submission rows to insert / update in the decision's transaction. */
  submissions: SubmissionRecord[] = [];
  submissionUpdates: { key: { repo: string; headSha: string }; patch: Partial<Pick<SubmissionRecord, "itemId" | "trainId" | "outcome" | "disposition">> }[] = [];
  /** v17: MCP attempt rows to upsert in the decision's transaction (keyed by attemptId; the last write wins). */
  attempts = new Map<string, Attempt>();
  /** v17: race-base column changes (work_items.base_repo / base_sha / base_pending_at), keyed by itemId. */
  itemBases = new Map<string, ItemBase>();
  /** v17: repo DELETEs no train holds (repo_deletes rows), keyed by repo. */
  repoDeletes = new Map<string, RepoDelete>();
  /** Rework loop: attempt slots the planner changed (applied to attempt rows in syncAttempts). */
  slots = new Map<string, AttemptSlot>();
  /** Rework loop: REWORKING wait reasons per item (null clears). */
  reworkWaits = new Map<string, string | null>();
  rollbackStreak?: number;
  followUps: AbsorbFollowUps[] = [];
  credits = 0;
  /** Set by decide(): a landed car / build goes straight to the release planner. */
  onLanded: ((l: { sha: string; trainIds: string[] }) => void) | null = null;

  train(r: PlanResult): PlanResult {
    for (const p of r.prompts) this.prompts.set(p.promptId, p);
    for (const t of r.trains) this.trains.set(t.trainId, t);
    for (const d of r.deployments) this.deployments.set(d.deploymentId, d);
    for (const x of r.races) this.races.set(x.raceId, x);
    this.effects.push(...r.effects);
    this.events.push(...r.events);
    this.modelStats.push(...r.modelStats);
    this.picks.push(...(r.picks ?? []));
    if (r.routerDispatches !== undefined) this.routerDispatches = r.routerDispatches;
    if (r.routerFloor !== undefined) this.routerFloor = r.routerFloor;
    for (const c of r.itemConflicts) this.itemConflicts.set(c.itemId, c.conflicts);
    this.conflictClaims.push(...r.conflictClaims);
    if (r.carInfraFailures !== undefined) this.carInfraFailures = r.carInfraFailures;
    if (r.executorLost) this.executorLost = true;
    for (const f of r.infraFailed ?? []) this.infraFailed.set(f.promptId, f.summary);
    for (const f of r.awaitingContributor ?? []) this.awaiting.set(f.promptId, f.summary);
    this.abortedIntents.push(...(r.abortedIntents ?? []));
    for (const s of r.slots) this.slots.set(s.attemptId, s);
    for (const w of r.reworkWaits) this.reworkWaits.set(w.itemId, w.waitReason);
    if (r.landed && r.landed.trainIds.length) this.onLanded?.(r.landed);
    return r;
  }

  release(r: ReleasePlanResult): ReleasePlanResult {
    for (const x of r.releases) this.releases.set(x.releaseId, x);
    for (const d of r.deployments) this.deployments.set(d.deploymentId, d);
    for (const e of r.escalations) this.escalations.set(e.escalationId, e);
    this.effects.push(...r.effects);
    this.events.push(...r.events);
    this.rollbackStreak = r.rollbackStreak;
    return r;
  }

  work(r: WorkPlanResult): WorkPlanResult {
    for (const i of r.items) this.items.set(i.itemId, i);
    for (const id of r.releasedClaims) {
      this.released.add(id);
      for (const [k, c] of this.claims) if (c.itemId === id) this.claims.delete(k);
    }
    for (const c of r.claims) this.claims.set(claimKey(c), c);
    for (const e of r.escalations) this.escalations.set(e.escalationId, e);
    if (r.settings) this.settings = r.settings;
    this.events.push(...r.events);
    this.effects.push(...r.effects);
    return r;
  }

  esc(r: EscalationPlanResult): EscalationPlanResult {
    for (const e of r.escalations) this.escalations.set(e.escalationId, e);
    this.events.push(...r.events);
    return r;
  }
}

/** The planners and context of one decide(). */
export interface Decision {
  hive: string;
  now: number;
  tp: TrainPlanner;
  rp: ReleasePlanner;
  wp: WorkPlanner;
  ep: EscalationPlanner;
  hs: HiveSettings;
  eff: EffectiveAutonomy;
  state: ActiveState;
  /** Trains as the planners saw them at the start (for command.result spans). */
  trainsAtStart: Map<string, TrainRecord>;
  acc: Acc;
}

interface DecideOptions {
  /** Train / item ids the call names (loaded even when terminal). */
  trains?: string[];
  /** Race ids the call names (loaded even when DECIDED: a re-pick), with their candidates. */
  races?: string[];
  items?: string[];
  releases?: string[];
  /** Change the settings row before the planners are built (PATCH settings, escalation intents, the lease). */
  pre?: (settings: HiveSettingsRecord, ctx: { ep: EscalationPlanner; state: ActiveState; hs: HiveSettings }) => HiveSettingsRecord;
  /** Bookkeeping only (drone dispatch confirmations): no absorb / dispatch pipeline. */
  bookkeeping?: boolean;
}

export class QueenNode extends DurableObject<Env> {
  readonly sql: SqlStorage;
  readonly ports: QueenPorts;
  /** Warm active state (§4.3); exposed for the load test's read counter. */
  readonly cache = new StateCache();
  private readonly coalescer: Coalescer;
  private readonly sink: AnalyticsSink;
  /** Terminal trains whose fork delete / preview teardown is still outstanding (watchdog + reconcile). */
  private cleanup = new Map<string, TrainRecord>();
  private maxPassedSeq = 0;
  private extrasWarm = false;
  /** A lease obtained before decide(), written with that decision's settings row. */
  private pendingLease: { leasedSlots: number; leaseExpiresAt: number } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Runs on every wake: synchronous, idempotent and cheap.
    migrate(ctx.storage);
    // Heartbeats are answered by the runtime without waking the DO.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.ports = this.createPorts(env);
    this.coalescer = new Coalescer({
      send: (frame) => this.broadcastNow(frame),
      now: () => Date.now(),
      schedule: (ms, fn) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
    });
    this.sink = new AnalyticsSink(env.ANALYTICS);
  }

  /** Seam for tests: the clock used for planning and the watchdog. */
  protected now(): number {
    return Date.now();
  }

  /** DISPATCH_TIMEOUT_MS (a seam for tests). */
  protected dispatchTimeoutMs(): number {
    return DISPATCH_TIMEOUT_MS;
  }

  /** True only in the sim worker (simulated executors); surfaced as `HiveStatus.mode`. */
  protected isSim(): boolean {
    return false;
  }

  /** Seam for tests and sim: override to inject fake executor / drone ports. */
  protected createPorts(env: Env): QueenPorts {
    return {
      provisioner: new WorkflowCommandDispatcher(env.PROVISIONER, "PROVISIONER"),
      herald: new WorkflowCommandDispatcher(env.HERALD, "HERALD"),
      sentinel: new WorkflowCommandDispatcher(env.SENTINEL, "SENTINEL"),
      oracle: new WorkflowCommandDispatcher(env.ORACLE, "ORACLE"),
      gatekeeper: new WorkflowCommandDispatcher(env.GATEKEEPER, "GATEKEEPER"),
      dispatcher: new WorkflowDroneDispatcher(env.DRONES),
    };
  }

  /** Seam for sim: filing hints from a prompt's text (the sim's `[race]` marker sets bestOf 3, `[you-pick]` judge human). */
  protected filingHints(text: string): { bestOf?: number; judge?: RaceJudge } {
    void text;
    return {};
  }

  // ── RPC surface: filing ───────────────────────────────────────────────

  /** v1-compatible submit (Genesis, the War Room socket): the item's prompt run. */
  async submitPrompt(input: SubmitPrompt): Promise<PromptRun> {
    return (await this.submitWork(input)).promptRun;
  }

  /**
   * `POST /hives/:hive/prompts`: file a prompt as one `feature` item (or, with
   * `decompose`, a goal the Oracle splits) and dispatch what is READY.
   * `promptRun` is synthesized from the item (QUEUED until ACTIVE).
   */
  async submitWork(input: SubmitPrompt & { user?: string }): Promise<{ item: WorkItem; promptRun: PromptRun }> {
    const prompt = parseOrThrow(SubmitPromptSchema, input, "prompt");
    assertNamespace(prompt.namespace);
    if (prompt.promptText.length > MAX_PROMPT_CHARS) {
      throw new QueenError("INVALID_INPUT", `promptText exceeds ${MAX_PROMPT_CHARS} characters`);
    }
    const hive = this.hiveNamespace();
    if (hive !== null && hive !== prompt.namespace) {
      throw new QueenError("CONFLICT", `this hive is "${hive}", not "${prompt.namespace}"`);
    }
    // A decomposed goal's text names its children's markers; hints apply to the children (via difficulty), never the goal.
    const hints = prompt.decompose ? {} : this.filingHints(prompt.promptText);
    const actor = input.user ? `user:${input.user}` : "user";
    await this.maybeLease(prompt.namespace, true);
    const { value: res, acc } = this.decide(prompt.namespace, (d) =>
      d.acc.work(
        d.wp.filePrompt({
          promptText: prompt.promptText,
          decompose: prompt.decompose ?? false,
          ...(prompt.priority !== undefined ? { priority: prompt.priority } : {}),
          ...((prompt.bestOf ?? hints.bestOf) !== undefined ? { bestOf: prompt.bestOf ?? hints.bestOf } : {}),
          ...((prompt.judge ?? hints.judge) !== undefined ? { judge: prompt.judge ?? hints.judge } : {}),
          ...(prompt.entryWindowMs !== undefined ? { entryWindowMs: prompt.entryWindowMs } : {}),
          actor,
        }),
      ),
    );
    await this.commit(prompt.namespace, acc);
    this.throwWorkError(res);
    const item = this.loadItem(res.itemId!)!;
    return { item: toWorkItem(item), promptRun: this.promptRunOf(item) };
  }

  /** `POST /hives/:hive/items` (user): a feature, bug or chore; READY or BLOCKED on its dependencies. */
  async fileWorkItem(input: { hive: string; user: string; item: FileWorkItemInput }): Promise<{ item: WorkItem }> {
    assertNamespace(input.hive);
    const spec = parseOrThrow(FileWorkItemSchema, input.item, "work item");
    const hive = this.hiveFor(input.hive);
    const hints = this.filingHints(`${spec.title}\n${spec.body}`);
    await this.maybeLease(hive, true);
    const { value: res, acc } = this.decide(
      hive,
      (d) =>
        d.acc.work(
          d.wp.fileItem({
            ...spec,
            ...(spec.bestOf === undefined && hints.bestOf ? { bestOf: hints.bestOf } : {}),
            ...(spec.judge === undefined && hints.judge ? { judge: hints.judge } : {}),
            actor: `user:${input.user}`,
          }),
        ),
      { items: [...spec.dependsOn, ...(spec.parentId ? [spec.parentId] : [])] },
    );
    await this.commit(hive, acc);
    this.throwWorkError(res);
    return { item: toWorkItem(this.loadItem(res.itemId!)!) };
  }

  /** `POST /hives/:hive/items/:id/actions` (user): retry, cancel, not_duplicate. */
  async workAction(input: { hive: string; itemId: string; user: string; action: WorkAction }): Promise<WorkUpdate> {
    const action = parseOrThrow(WorkActionSchema, input.action, "work action");
    const hive = this.hiveFor(input.hive);
    if (!this.loadItem(input.itemId)) throw new QueenError("NOT_FOUND", `item ${input.itemId} not found`);
    await this.maybeLease(hive, true);
    const { value: res, acc } = this.decide(
      hive,
      (d) => {
        const r = d.acc.work(d.wp.action(input.itemId, action, `user:${input.user}`));
        // T1 handoff: the item is ACTIVE again; a REWORK (as for drones) forks from the rejected submission's kept fork.
        if (action.action === "handoff" && r.outcome === "applied") {
          const item = d.acc.items.get(input.itemId)!;
          const prompt = this.loadPrompt(input.itemId);
          d.acc.train(
            d.tp.handoff({
              promptId: item.itemId,
              promptText: prompt?.promptText ?? composePrompt(item),
              summary: prompt?.summary ?? null,
              attempts: item.attempts,
              item: plannerItem(item),
            }),
          );
        }
        return r;
      },
      { items: [input.itemId] },
    );
    await this.commit(hive, acc);
    this.throwWorkError(res);
    const item = this.loadItem(input.itemId);
    return { outcome: res.outcome, item: item ? toWorkItem(item) : null };
  }

  /**
   * `POST /hives/:hive/races/:raceId/pick` (user, T9a, human-push design §10.2): a human picks a PICKING race's
   * winner (`by: human:<email>`), or re-picks a just-decided one whose winner has not boarded a car (§10.3).
   * 404 for an unknown race; 409 unless the race is PICKING and `trainId` a live passed candidate (or a re-pick).
   */
  async pick(input: { hive: string; raceId: string; user: string; pick: PickRaceInput }): Promise<{ outcome: string; race: Race }> {
    const pick = parseOrThrow(PickRaceSchema, input.pick, "pick");
    const hive = this.hiveFor(input.hive);
    const row = this.sql.exec("SELECT * FROM races WHERE race_id = ?", input.raceId).toArray()[0];
    if (!row) throw new QueenError("NOT_FOUND", `race ${input.raceId} not found`);
    const race = rowToRace(row);
    const { value: res, acc } = this.decide(
      hive,
      (d) => d.acc.train(d.tp.pick({ raceId: race.raceId, trainId: pick.trainId, by: humanBy(input.user), reason: pick.reason ?? null })),
      { races: [race.raceId], trains: race.trainIds, items: [race.itemId] },
    );
    if (res.refused) throw new QueenError(res.refused.status === 404 ? "NOT_FOUND" : "CONFLICT", res.refused.message);
    await this.commit(hive, acc);
    const after = this.sql.exec("SELECT * FROM races WHERE race_id = ?", race.raceId).toArray()[0];
    return { outcome: res.outcome, race: after ? rowToRace(after) : race };
  }

  /**
   * `POST /hives/:hive/races/:raceId/close-entries` (user, external hives, human-push design §2.5): a human ends a
   * race's entry window now, so it can be decided. 404 for an unknown race; 409 unless the race is RACING and its
   * entries are still open.
   */
  async closeRaceEntries(input: { hive: string; raceId: string; user: string }): Promise<{ outcome: string; race: Race }> {
    const hive = this.hiveFor(input.hive);
    const row = this.sql.exec("SELECT * FROM races WHERE race_id = ?", input.raceId).toArray()[0];
    if (!row) throw new QueenError("NOT_FOUND", `race ${input.raceId} not found`);
    const race = rowToRace(row);
    const { value: res, acc } = this.decide(hive, (d) => d.acc.train(d.tp.closeEntries({ raceId: race.raceId, by: humanBy(input.user) })), {
      races: [race.raceId],
      trains: race.trainIds,
      items: [race.itemId],
    });
    if (res.refused) throw new QueenError(res.refused.status === 404 ? "NOT_FOUND" : "CONFLICT", res.refused.message);
    await this.commit(hive, acc);
    const after = this.sql.exec("SELECT * FROM races WHERE race_id = ?", race.raceId).toArray()[0];
    return { outcome: res.outcome, race: after ? rowToRace(after) : race };
  }

  /** Open work items (the sim Oracle's TRIAGE dedupe). */
  listOpenItems(): { itemId: string; title: string; status: string }[] {
    return this.sql
      .exec(`SELECT item_id, title, status FROM work_items WHERE status NOT IN (${TERMINAL_ITEMS_SQL}) AND kind != 'goal' ORDER BY seq`)
      .toArray()
      .map((r) => ({ itemId: String(r.item_id), title: String(r.title), status: String(r.status) }));
  }

  // ── RPC surface: git intake (human-push design rev 2, T1) ─────────────

  /**
   * The git proxy's pre-receive decision, before it forks (§4.2, §4.3). State rules only: duplicate head
   * (refused:duplicate), an unknown `item/<id>` or `goal/<slug>` (refused:unknown-item), the contributor's
   * hourly and open-item caps and the hive's maxOpenItems (refused:over-cap), `main` (refused:rule).
   * Accepted: a pre-forked BUILD train (BUILDING, forkState PENDING, origin human) whose `repo` the proxy
   * forks hive main into; a submission row `pending`. A pause or a spent budget never refuses.
   */
  async gitIntent(input: GitPushIntent): Promise<GitIntakeDecision> {
    const intent = parseOrThrow(GitPushIntentSchema, input, "push intent");
    const hive = this.hiveFor(intent.hive);
    const user = intent.user.toLowerCase();
    // A token bound to an agent: its identity is authoritative (edge-derived). `model` is the minter's claim,
    // display only: it rides on the origin, never into the router or model_stats.
    const agent = intent.agent?.name ?? null;
    const agentModel = intent.agent?.model;
    const intentActor = agent ? `agent:${clip(`${agent}@${user}`, 320)}` : `user:${user}`;
    const trainId = crypto.randomUUID();
    const repo = trainRepoName(hive, trainId);
    const placeholder = crypto.randomUUID();
    const target = targetFromRef(intent.ref);
    const { value: decision, acc } = this.decide(hive, (d): GitIntakeDecision => {
      const now = d.now;
      const prev = this.priorOnRef(user, intent.ref, null, undefined, agent);
      const settings = d.acc.settings ?? d.state.settings;
      const dec = decideIntent(
        { ref: intent.ref, newSha: intent.newSha, user, agent },
        {
          now,
          guardrails: d.hs.guardrails,
          paused: d.eff.paused,
          budgetExhausted: settings ? budgetExhausted(settings, d.hs.budget) : false,
          sameHead: this.sql
            .exec("SELECT * FROM submissions WHERE head_sha = ? AND outcome IN ('applied', 'pending') ORDER BY created_at", intent.newSha)
            .toArray()
            .map(rowToSubmission),
          previousOnRef: prev,
          lookup: this.intakeLookup(d),
          openItems: this.openPushedItems(user),
          pushesLastHour: Number(
            this.sql
              .exec("SELECT COUNT(*) AS n FROM submissions WHERE origin_id = ? AND created_at >= ? AND outcome IN ('applied', 'pending')", user, now - HOUR_MS)
              .one().n,
          ),
          hiveOpenItems: Number(this.sql.exec(`SELECT COUNT(*) AS n FROM work_items WHERE status NOT IN (${TERMINAL_ITEMS_SQL})`).one().n),
        },
      );
      if (dec.verdict === "refuse") {
        d.acc.submissions.push({
          repo: hive,
          headSha: intent.newSha,
          ref: intent.ref,
          originKind: agent ? "agent" : "human",
          originId: user,
          itemId: null,
          trainId: null,
          outcome: dec.outcome,
          disposition: null,
          target,
          agent,
          createdAt: now,
        });
        d.acc.events.push(
          this.submissionEvent(
            null,
            null,
            `push refused: ${dec.reason}`,
            { outcome: dec.outcome, ref: intent.ref, headSha: intent.newSha, user, ...(agent ? { agent, ...(agentModel ? { model: agentModel } : {}) } : {}) },
            intentActor,
            "warn",
          ),
        );
        return { verdict: "refuse", reason: dec.reason, messages: dec.messages };
      }
      for (const stale of dec.supersedeIntents) d.acc.train(d.tp.abort(stale, `replaced by a newer push of ${intent.ref}`));
      const promptId = dec.itemId ?? placeholder;
      const origin: SubmissionOrigin = agent
        ? { kind: "agent", id: clip(`${agent}@${user}`, 320), ...(agentModel ? { model: agentModel } : {}) }
        : { kind: "human", id: user };
      d.acc.train(
        d.tp.intent({
          trainId,
          promptId,
          origin,
          traceId: d.state.items.find((i) => i.itemId === promptId)?.traceId ?? null,
          ...(this.loadPrompt(promptId) ? {} : { promptText: `push ${intent.ref} ${short(intent.newSha)} (awaiting the push)` }),
        }),
      );
      d.acc.submissions.push({
        repo,
        headSha: intent.newSha,
        ref: intent.ref,
        originKind: agent ? "agent" : "human",
        originId: user,
        itemId: promptId,
        trainId,
        outcome: "pending",
        disposition: null,
        target,
        agent,
        createdAt: now,
      });
      d.acc.events.push(
        this.submissionEvent(
          dec.itemId,
          trainId,
          `push intent accepted: ${intent.ref} ${short(intent.newSha)} → train ${trainId} (${repo})`,
          { outcome: "pending", ref: intent.ref, headSha: intent.newSha, user, repo, ...(agent ? { agent, ...(agentModel ? { model: agentModel } : {}) } : {}) },
          intentActor,
        ),
      );
      return { verdict: "accept", trainId, repo, messages: dec.messages };
    });
    await this.commit(hive, acc);
    return decision;
  }

  /**
   * The push landed in the pre-forked train's fork (`main` = the contributor's head): the Submission.
   * Intake files a new item (uncorrelated: "already won", no race), enters the targeted item's race
   * (created lazily at width 1), reopens a FAILED item, supersedes the contributor's earlier train on the
   * same branch (not yet in a car), or files a follow-up item (late). The train then deploys its preview and
   * is gated like a drone's build, or waits parked while its item is not dispatched (paused, budget).
   * Idempotent: a repeat returns the recorded result.
   */
  async gitPushed(input: GitPushed): Promise<GitPushedResult> {
    const p = parseOrThrow(GitPushedSchema, input, "push");
    const hive = this.hiveFor(p.hive);
    const train = this.loadTrain(p.trainId);
    if (!train || !isContributed(train)) throw new QueenError("NOT_FOUND", `push train ${p.trainId} not found`);
    const row = this.sql.exec("SELECT * FROM submissions WHERE train_id = ? ORDER BY created_at DESC LIMIT 1", p.trainId).toArray()[0];
    const sub = row ? rowToSubmission(row) : null;
    if (!sub) throw new QueenError("NOT_FOUND", `no push intent for train ${p.trainId}`);
    // The intent's fork name, or the proxy's re-fork of it (`<repo>-rN`, a sick first fork; 1deb7ab), which
    // the train adopts like `forkResult` adopts the Provisioner's renamed fork. The intent's own row keys stay.
    if (!isForkOf(sub.repo, p.repo)) throw new QueenError("INVALID_INPUT", `repo ${p.repo} is not train ${p.trainId}'s fork`);
    if (sub.headSha !== p.headSha || sub.ref !== p.ref) throw new QueenError("INVALID_INPUT", `push ${p.ref} ${short(p.headSha)} does not match the intent (${sub.ref} ${short(sub.headSha)})`);
    if (sub.outcome === "applied") {
      return { disposition: sub.disposition ?? "filed", itemId: sub.itemId ?? train.promptId, messages: remoteLines([`already received → item ${sub.itemId ?? train.promptId} (train ${p.trainId})`]) };
    }
    if (sub.outcome !== "pending" || !awaitingPush(train)) {
      throw new QueenError("CONFLICT", `push intent ${p.trainId} is no longer open (${sub.outcome}); retry the push`);
    }
    const user = sub.originId;
    const trailers = trailersOf(p.message, p.trailers);
    // A token bound to an agent set the train's origin at intent: that identity is authoritative and the
    // `Queen-Origin` trailer is ignored. A human token's trailer is a claim within the owner's accountability.
    const origin: SubmissionOrigin = train.origin?.kind === "agent" ? { ...train.origin } : originOf(user, trailers);
    const now = this.now();
    const prev = this.priorOnRef(user, p.ref, p.trainId, "applied", sub.agent);
    const lookupState = this.activeState();
    const newItemId = this.loadItem(train.promptId) ? crypto.randomUUID() : train.promptId;
    const plan = decideIntake(
      { ref: p.ref, headSha: p.headSha, title: p.title, message: p.message, trailers, newItemId },
      { now, lookup: this.intakeLookup({ state: lookupState }), previousOnRef: prev },
    );
    // External hive: there is no swarm to hand off to, so a `Queen: rework` trailer is ignored.
    let rework = false;
    const actor = origin.kind === "agent" ? `agent:${origin.id}` : `user:${user}`;
    const source = origin.kind === "agent" ? { kind: "agent" as const, actor } : { kind: "user" as const, actor };
    const parent = plan.file?.parentId ?? null;
    const { acc } = this.decide(
      hive,
      (d) => {
        rework = trailers.rework && d.hs.executors !== "external";
        const inbox = { repo: p.repo, ref: p.ref, handle: handleFor(user), headSha: p.headSha, handoff: rework };
        if (plan.file) d.acc.work(d.wp.fileSubmission({ ...plan.file, source, inbox, disposition: plan.disposition }));
        else d.acc.work(d.wp.adoptSubmission(plan.itemId, { inbox, reopen: plan.reopen, actor }));
        const item = d.acc.items.get(plan.itemId) ?? d.state.items.find((i) => i.itemId === plan.itemId) ?? this.loadItem(plan.itemId);
        if (!item) throw new QueenError("NOT_FOUND", `item ${plan.itemId} not found`);
        d.acc.train(
          d.tp.pushed({
            trainId: p.trainId,
            repo: p.repo,
            headSha: p.headSha,
            baseSha: p.baseSha,
            origin,
            promptId: item.itemId,
            promptText: composePrompt(item),
            attempts: item.attempts,
            item: plannerItem(item),
            race: plan.race,
            resume: item.status === "ACTIVE",
          }),
        );
        if (plan.supersedeTrainId) d.acc.train(d.tp.supersede(plan.supersedeTrainId, p.headSha));
        d.acc.submissionUpdates.push({ key: { repo: sub.repo, headSha: p.headSha }, patch: { outcome: "applied", disposition: plan.disposition, itemId: item.itemId, trainId: p.trainId } });
        d.acc.events.push(
          this.submissionEvent(item.itemId, p.trainId, `submission received (${plan.disposition}) from ${origin.kind}:${origin.id}${origin.model ? ` (claims ${origin.model})` : ""}: ${p.title}`, {
            outcome: "applied",
            disposition: plan.disposition,
            ref: p.ref,
            headSha: p.headSha,
            repo: p.repo,
            origin,
            ...(plan.supersedeTrainId ? { superseded: plan.supersedeTrainId } : {}),
            ...(rework ? { handoff: true } : {}),
          }, actor),
        );
      },
      { trains: [p.trainId, ...(plan.supersedeTrainId ? [plan.supersedeTrainId] : [])], items: [plan.itemId, ...(parent ? [parent] : [])] },
    );
    await this.commit(hive, acc);
    const item = this.loadItem(plan.itemId);
    const waiting = item && item.status !== "ACTIVE" ? (item.waitReason ?? item.blockedReason ?? item.status.toLowerCase()) : null;
    // External hives: a race with an open entry window says so (a push after the close files a follow-up instead).
    const raceId = this.loadTrain(p.trainId)?.raceId;
    const raceRow = raceId ? this.sql.exec("SELECT * FROM races WHERE race_id = ?", raceId).toArray()[0] : undefined;
    const raceRec = raceRow ? rowToRace(raceRow) : null;
    const entries = raceRec && raceRec.state === "RACING" ? entryWindowLine(raceRec, now) : null;
    return {
      disposition: plan.disposition,
      itemId: plan.itemId,
      messages: pushedMessages({
        plan: plan.messages,
        entries,
        status: waiting ? `queued: ${waiting}` : `train ${p.trainId} · verdict in ~2 min`,
        rework: rework ? "Queen: rework — the swarm takes over if the gate rejects it" : null,
      }),
    };
  }

  /**
   * The push failed after `gitIntent` (fork, upstream receive-pack, size cap or readCommit): the pre-forked
   * train is EJECTED with no attempt charged and its fork deleted; the submission row becomes
   * `aborted:transient`. A train that was already pushed is never aborted (`ignored:stale`).
   */
  async gitAborted(input: GitAborted): Promise<{ outcome: string }> {
    const a = parseOrThrow(GitAbortedSchema, input, "push abort");
    const hive = this.hiveFor(a.hive);
    const train = this.loadTrain(a.trainId);
    if (!train || !isContributed(train)) throw new QueenError("NOT_FOUND", `push train ${a.trainId} not found`);
    const { value: res, acc } = this.decide(hive, (d) => d.acc.train(d.tp.abort(a.trainId, a.reason)), { trains: [a.trainId] });
    await this.commit(hive, acc);
    return { outcome: res.outcome };
  }

  // ── RPC surface: MCP attempts (docs/superpowers/specs/2026-10-12-queenos-mcp-design.md §7, §8.3) ───────

  /**
   * `start_attempt`: caps, entry acceptance and the item's race base, then an INTENT row. The base lock: with no
   * base and none pending, this caller alone gets `{base: create}` (the item is marked base-pending in the same
   * synchronous decide + commit); any other intent gets BASE_PENDING until `attemptBaseReady` / `attemptBaseFailed`.
   * No train row is created here: the first `attemptPushed` creates the reserved train and pushes it in one decide.
   */
  async attemptIntent(input: AttemptIntent): Promise<AttemptIntentDecision> {
    const i = parseOrThrow(AttemptIntentSchema, input, "attempt intent");
    const hive = this.hiveFor(i.hive);
    const owner = i.owner.toLowerCase();
    const refuse = (code: AttemptRefusalCode, message: string, items?: GoalChild[], retryAfterMs?: number): AttemptIntentDecision => ({
      verdict: "refuse",
      code,
      message: clip(message, 200),
      ...(items ? { items } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
    if (i.agent.owner.toLowerCase() !== owner) return refuse("FORBIDDEN_OWNER", "the agent belongs to another owner");
    const attemptId = `att_${randomHex(6)}`;
    const trainId = crypto.randomUUID();
    const baseId = randomHex(6);
    const actor = `agent:${clip(`${i.agent.name}@${owner}`, 320)}`;
    const { value, acc } = this.decide(hive, (d): AttemptIntentDecision => {
      if (d.hs.executors !== "external") return refuse("HIVE_NOT_EXTERNAL", `hive ${hive} runs its own swarm; attempts need an external hive`);
      let itemId: string;
      if ("goalId" in i.target) {
        const goal = this.loadItem(i.target.goalId);
        if (!goal || goal.kind !== "goal") return refuse("NOT_FOUND", `goal ${i.target.goalId} not found`);
        const open = this.sql
          .exec(`SELECT * FROM work_items WHERE parent_id = ? AND kind != 'goal' AND status NOT IN (${TERMINAL_ITEMS_SQL}) ORDER BY seq`, goal.itemId)
          .toArray()
          .map(rowToWorkItem);
        if (open.length !== 1) {
          return refuse("GOAL_AMBIGUOUS", `goal ${goal.itemId} has ${open.length} open items; call start_attempt with one itemId`, open.slice(0, 24).map((c) => ({ itemId: c.itemId, title: c.title, status: c.status })));
        }
        itemId = open[0]!.itemId;
      } else {
        itemId = i.target.itemId;
      }
      const item = d.state.items.find((x) => x.itemId === itemId) ?? this.loadItem(itemId);
      if (!item || item.kind === "goal") return refuse("NOT_FOUND", `item ${itemId} not found`);
      const race = d.state.races.find((r) => r.itemId === itemId && r.state === "RACING") ?? null;
      if (!acceptsEntries(item, race, d.now)) {
        return refuse("ITEM_NOT_ACCEPTING", `item ${itemId} is ${item.status}${item.waitReason ? ` (${item.waitReason})` : ""}; it takes no new attempts`);
      }
      const g = d.hs.guardrails;
      const caps = checkAttemptCaps({
        itemId,
        agentOpen: Number(this.sql.exec(`SELECT COUNT(*) AS n FROM attempts WHERE agent_id = ? AND state IN (${OPEN_ATTEMPTS_SQL})`, i.agent.agentId).one().n),
        ownerOpenItems: this.ownerOpenItems(owner),
        ownerStartsLastHour: this.ownerStartsSince(owner, d.now - HOUR_MS),
        oldestCountedAt: this.ownerOldestStartSince(owner, d.now - HOUR_MS),
        now: d.now,
        maxPerAgent: MAX_OPEN_ATTEMPTS_PER_AGENT,
        maxOpenPerContributor: g.maxInboxOpenPerContributor,
        maxPushesPerHour: g.maxInboxPushesPerHour,
      });
      if (!caps.ok) return refuse("CAP_EXCEEDED", caps.message, undefined, caps.retryAfterMs);
      const b = this.baseOf(itemId, d.acc) ?? { itemId, baseRepo: null, baseSha: null, pendingAt: null };
      let base: AttemptBase;
      if (b.baseRepo && b.baseSha) {
        base = { kind: "existing", baseRepo: b.baseRepo, baseSha: b.baseSha };
      } else if (b.baseRepo) {
        return refuse("BASE_PENDING", `item ${itemId}'s base repo is being created; retry in 2 s`, undefined, BASE_PENDING_POLL_MS);
      } else {
        base = { kind: "create", baseRepo: baseRepoName(hive, baseId) };
        d.acc.itemBases.set(itemId, { itemId, baseRepo: base.baseRepo, baseSha: null, pendingAt: d.now });
      }
      const repo = attemptRepoName(hive, attemptId);
      const expiresAt = d.now + ATTEMPT_TTL_MS;
      d.acc.attempts.set(attemptId, {
        attemptId,
        hive,
        itemId,
        raceId: race?.raceId ?? null,
        trainId,
        repo,
        baseSha: base.kind === "existing" ? base.baseSha : null,
        agentId: i.agent.agentId,
        agentName: i.agent.name,
        model: i.agent.model,
        role: i.agent.role,
        owner,
        state: "INTENT",
        headSha: null,
        createdAt: d.now,
        expiresAt,
      });
      d.acc.events.push(
        this.attemptEvent(
          "attempt.intent",
          itemId,
          attemptId,
          `attempt ${attemptId} by ${actor} (claims ${i.agent.model}) on item ${itemId}${base.kind === "create" ? `; creating base ${base.baseRepo}` : ""}`,
          { attemptId, repo, agentId: i.agent.agentId, role: i.agent.role, model: i.agent.model, base: base.kind },
          actor,
        ),
      );
      return { verdict: "accept", attemptId, trainId, repo, itemId, raceId: race?.raceId ?? null, expiresAt, base };
    });
    await this.commit(hive, acc);
    return value;
  }

  /** The base fork exists: pin `base_repo` (actual name, may be `-rN`) and `base_sha`; INTENTs of the item learn the sha. */
  async attemptBaseReady(input: AttemptBaseReady): Promise<{ outcome: string }> {
    const r = parseOrThrow(AttemptBaseReadySchema, input, "attempt base ready");
    const hive = this.hiveFor(r.hive);
    const b = getItemBase(this.sql, r.itemId);
    if (!b) throw new QueenError("NOT_FOUND", `item ${r.itemId} not found`);
    if (b.baseRepo && b.baseSha) {
      if (b.baseRepo === r.baseRepo && b.baseSha === r.baseSha) return { outcome: "ignored:duplicate" };
      throw new QueenError("CONFLICT", `item ${r.itemId} already has base ${b.baseRepo}`);
    }
    if (!b.baseRepo || !isForkOf(b.baseRepo, r.baseRepo)) throw new QueenError("CONFLICT", `item ${r.itemId} is not creating base ${r.baseRepo}`);
    const { acc } = this.decide(hive, (d) => {
      d.acc.itemBases.set(r.itemId, { itemId: r.itemId, baseRepo: r.baseRepo, baseSha: r.baseSha, pendingAt: null });
      for (const a of attemptsOfItem(this.sql, r.itemId)) if (a.state === "INTENT" && a.baseSha === null) d.acc.attempts.set(a.attemptId, { ...a, baseSha: r.baseSha });
      d.acc.events.push(this.attemptEvent("attempt.base", r.itemId, null, `base ${r.baseRepo} ready at ${short(r.baseSha)} for item ${r.itemId}`, { outcome: "ready", baseRepo: r.baseRepo, baseSha: r.baseSha }, "mcp"));
    });
    await this.commit(hive, acc);
    return { outcome: "applied" };
  }

  /** The base fork failed after retries: free the base slot (the next intent may try again) and abort the caller's INTENT. */
  async attemptBaseFailed(input: AttemptBaseFailed): Promise<{ outcome: string }> {
    const r = parseOrThrow(AttemptBaseFailedSchema, input, "attempt base failed");
    const hive = this.hiveFor(r.hive);
    const b = getItemBase(this.sql, r.itemId);
    if (!b) throw new QueenError("NOT_FOUND", `item ${r.itemId} not found`);
    const pending = !!b.baseRepo && !b.baseSha && isForkOf(b.baseRepo, r.baseRepo);
    // Only the caller's own INTENT on this item: a wrong attemptId never aborts an INTENT on another item.
    const found = r.attemptId ? getAttemptRow(this.sql, r.attemptId) : null;
    const caller = found && found.itemId === r.itemId ? found : null;
    if (!pending && caller?.state !== "INTENT") return { outcome: "ignored:stale" };
    const { acc } = this.decide(hive, (d) => {
      if (pending) d.acc.itemBases.set(r.itemId, { itemId: r.itemId, baseRepo: null, baseSha: null, pendingAt: null });
      if (caller?.state === "INTENT") d.acc.attempts.set(caller.attemptId, { ...caller, state: "ABORTED" });
      d.acc.events.push(this.attemptEvent("attempt.base", r.itemId, r.attemptId ?? null, `base ${r.baseRepo} failed: ${r.reason}`, { outcome: "failed", baseRepo: r.baseRepo, reason: r.reason }, "mcp", "warn"));
    });
    await this.commit(hive, acc);
    return { outcome: "applied" };
  }

  /** The attempt fork exists, is pushable and has a token: INTENT → READY. Its head must be the item's base. */
  async attemptReady(input: AttemptReady): Promise<AttemptResult> {
    const r = parseOrThrow(AttemptReadySchema, input, "attempt ready");
    const hive = this.hiveFor(r.hive);
    const a = getAttemptRow(this.sql, r.attemptId);
    if (!a) return { ok: false, code: "NOT_FOUND", message: `attempt ${r.attemptId} not found` };
    if (a.state === "READY" && a.repo === r.repo) return { ok: true, attempt: this.attemptView(a), changed: false };
    if (a.state !== "INTENT") return { ok: false, code: "ATTEMPT_EXPIRED", message: `attempt ${a.attemptId} is ${a.state}` };
    if (!isForkOf(a.repo, r.repo)) throw new QueenError("INVALID_INPUT", `repo ${r.repo} is not attempt ${a.attemptId}'s fork`);
    const b = getItemBase(this.sql, a.itemId);
    // The base was cleared and is being created again (watchdog, baseFailed): not moved, just not pinned yet (M11).
    if (b?.baseRepo && !b.baseSha) return { ok: false, code: "BASE_PENDING", message: `item ${a.itemId}'s base repo is being created; retry in 2 s`, retryAfterMs: BASE_PENDING_POLL_MS };
    if (!b?.baseSha || b.baseSha !== r.baseSha) {
      return { ok: false, code: "BASE_MOVED", message: `fork head ${short(r.baseSha)} is not item ${a.itemId}'s base ${short(b?.baseSha ?? null)}` };
    }
    const next: Attempt = { ...a, state: "READY", repo: r.repo, baseSha: r.baseSha, expiresAt: r.expiresAt };
    const { acc } = this.decide(hive, (d) => {
      d.acc.attempts.set(a.attemptId, next);
      d.acc.events.push(this.attemptEvent("attempt.state", a.itemId, a.attemptId, `attempt ${a.attemptId}: INTENT → READY (${r.repo})`, { from: "INTENT", to: "READY", repo: r.repo }, `agent:${a.agentName}@${a.owner}`));
    });
    await this.commit(hive, acc);
    return { ok: true, attempt: this.attemptView(next), changed: true };
  }

  /** The fork or token failed (`queenos-mcp` already deleted the fork): INTENT → ABORTED. Anything else: ignored:stale. */
  async attemptAborted(input: AttemptAborted): Promise<{ outcome: string }> {
    const r = parseOrThrow(AttemptAbortedSchema, input, "attempt aborted");
    const hive = this.hiveFor(r.hive);
    const a = getAttemptRow(this.sql, r.attemptId);
    if (!a) throw new QueenError("NOT_FOUND", `attempt ${r.attemptId} not found`);
    if (a.state !== "INTENT") return { outcome: "ignored:stale" };
    const { acc } = this.decide(hive, (d) => {
      d.acc.attempts.set(a.attemptId, { ...a, state: "ABORTED" });
      d.acc.events.push(this.attemptEvent("attempt.state", a.itemId, a.attemptId, `attempt ${a.attemptId}: INTENT → ABORTED (${r.reason})`, { from: "INTENT", to: "ABORTED", reason: r.reason }, "mcp", "warn"));
    });
    await this.commit(hive, acc);
    return { outcome: "applied" };
  }

  /**
   * Gatekeepers: a push landed on `main` of an attempt fork, and `after` is the fork's head (the gatekeeper checked).
   * Idempotent on (repo, after). The push is the attempt's submission through the same intake as `gitPushed` (race
   * entry, follow-up when late, a FAILED item reopened), keyed by the attempt instead of (owner, ref, agent): the
   * attempt's previous train is superseded while it has not boarded a car. The first push creates the train reserved
   * at intent (tp.intent + tp.pushed in one decide); later pushes allocate a new train. Every train's repo is the
   * attempt fork (no re-fork, no ref rewrite). The claimed model rides on the origin only, never into the router.
   */
  async attemptPushed(input: AttemptPushed): Promise<AttemptPushedResult> {
    const p = parseOrThrow(AttemptPushedSchema, input, "attempt push");
    const hive = this.hiveFor(p.hive);
    const a = getAttemptRow(this.sql, p.attemptId);
    const res = (outcome: AttemptPushedResult["outcome"], extra: Partial<AttemptPushedResult> = {}): AttemptPushedResult => ({
      outcome,
      attemptId: p.attemptId,
      state: a?.state ?? null,
      itemId: a?.itemId ?? null,
      trainId: null,
      disposition: null,
      ...extra,
    });
    if (!a || a.hive !== hive || a.repo !== p.repo) return res("ignored:unknown");
    const dup = getSubmission(this.sql, a.repo, p.after);
    if (dup) return res("duplicate", { itemId: dup.itemId, trainId: dup.trainId, disposition: dup.disposition });
    // Push events are at-least-once and unordered: an event whose `after` an applied push of this attempt was built
    // on (its `before`) is older than that push. It is answered like a replay (that push already carries it).
    const newerRow = this.sql
      .exec("SELECT * FROM submissions WHERE attempt_id = ? AND outcome = 'applied' AND before_sha = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", a.attemptId, p.after)
      .toArray()[0];
    if (newerRow) {
      const newer = rowToSubmission(newerRow);
      const { acc } = this.decide(hive, (d) => {
        d.acc.events.push(
          this.attemptEvent("attempt.state", a.itemId, a.attemptId, `attempt ${a.attemptId}: stale push ${short(p.after)} ignored (already built on by ${short(newer.headSha)})`, {
            outcome: "stale",
            headSha: p.after,
            newerHeadSha: newer.headSha,
            trainId: newer.trainId,
          }, `agent:${a.agentName}@${a.owner}`, "debug"),
        );
      });
      await this.commit(hive, acc);
      return res("duplicate", { itemId: newer.itemId, trainId: newer.trainId, disposition: newer.disposition });
    }
    if (!PUSHABLE_STATES.has(a.state)) return res("ignored:state");
    if (p.after === a.baseSha) return res("ignored:base");
    const entered = await this.enterAttemptHead(hive, a, { after: p.after, before: p.before ?? null, title: p.title, message: p.message }, "push", this.reworkRejoin(a, this.now()) ?? undefined);
    return { outcome: "applied", attemptId: a.attemptId, state: entered.attempt.state, itemId: entered.attempt.itemId, trainId: entered.trainId, disposition: entered.disposition };
  }

  /**
   * The attempt's head enters the item as a submission (the body of `attemptPushed`; `attemptRegate` re-submits the
   * current head the same way). `push`: a new submission row. `regate`: the head's existing submission row is
   * re-pointed at the new train (its PK is (repo, head_sha)), and the regate counters are bumped. Either way a new
   * train is allocated through the same intake (race entry, follow-up when late, a FAILED item reopened).
   */
  private async enterAttemptHead(
    hive: string,
    a: Attempt,
    head: { after: string; before: string | null; title: string; message: string },
    mode: "push" | "regate",
    /**
     * Re-enter this RACING / REWORKING race without intake: a re-gate (the previous train is its candidate), a rework slot's
     * fix, or (R4) a re-push of a pending fix, which `supersede`s that fix in place. The entry window may have closed: not
     * a new entry.
     */
    rejoin?: { raceId: string; supersede?: string },
  ): Promise<{ attempt: Attempt; trainId: string; disposition: SubmitDisposition }> {
    const ref = `refs/heads/item/${a.itemId}`;
    const prevRow = this.sql.exec("SELECT * FROM submissions WHERE attempt_id = ? AND outcome = 'applied' ORDER BY created_at DESC, rowid DESC LIMIT 1", a.attemptId).toArray()[0];
    const prevSub = prevRow ? rowToSubmission(prevRow) : null;
    const prevTrain = prevSub?.trainId ? this.loadTrain(prevSub.trainId) : null;
    const previous: PriorSubmission | null = prevSub
      ? { submission: prevSub, trainActive: !!prevTrain && isActive(prevTrain), trainBoarded: !!prevTrain && (!!prevTrain.carId || prevTrain.phase === "LANDING" || prevTrain.phase === "MERGED") }
      : null;
    const trainId = a.state === "READY" && !this.trainExists(a.trainId) ? a.trainId : crypto.randomUUID();
    const origin: SubmissionOrigin = { kind: "agent", id: clip(`${a.agentName}@${a.owner}`, 320), model: a.model };
    const actor = `agent:${origin.id}`;
    const now = this.now();
    const plan: IntakePlan = rejoin
      ? { disposition: "joined-race", itemId: a.itemId, reopen: false, race: { join: rejoin.raceId }, messages: [], ...(rejoin.supersede ? { supersedeTrainId: rejoin.supersede } : {}) }
      : decideIntake(
          { ref, headSha: head.after, title: head.title, message: head.message, trailers: trailersOf(head.message, {}), newItemId: crypto.randomUUID() },
          { now, lookup: this.intakeLookup({ state: this.activeState() }), previousOnRef: previous },
        );
    const parent = plan.file?.parentId ?? null;
    let entered: Attempt = a;
    const { acc } = this.decide(
      hive,
      (d) => {
        const inbox = { repo: a.repo, ref, handle: handleFor(a.owner), headSha: head.after, handoff: false };
        if (plan.file) d.acc.work(d.wp.fileSubmission({ ...plan.file, source: { kind: "agent" as const, actor }, inbox, disposition: plan.disposition }));
        else d.acc.work(d.wp.adoptSubmission(plan.itemId, { inbox, reopen: plan.reopen, actor }));
        const item = d.acc.items.get(plan.itemId) ?? d.state.items.find((i) => i.itemId === plan.itemId) ?? this.loadItem(plan.itemId);
        if (!item) throw new QueenError("NOT_FOUND", `item ${plan.itemId} not found`);
        d.acc.train(d.tp.intent({ trainId, promptId: item.itemId, origin, traceId: item.traceId, promptText: composePrompt(item), attemptId: a.attemptId }));
        d.acc.train(
          d.tp.pushed({
            trainId,
            repo: a.repo,
            headSha: head.after,
            baseSha: a.baseSha ?? head.before ?? head.after,
            origin,
            promptId: item.itemId,
            promptText: composePrompt(item),
            attempts: item.attempts,
            item: plannerItem(item),
            race: plan.race,
            resume: item.status === "ACTIVE",
            ...(rejoin ? { rejoin: true as const } : {}),
          }),
        );
        if (plan.supersedeTrainId) d.acc.train(d.tp.supersede(plan.supersedeTrainId, head.after));
        if (mode === "push") {
          d.acc.submissions.push({
            repo: a.repo,
            headSha: head.after,
            ref,
            originKind: "agent",
            originId: a.owner,
            itemId: item.itemId,
            trainId,
            outcome: "applied",
            disposition: plan.disposition,
            target: { kind: "item", itemId: a.itemId },
            agent: a.agentName,
            attemptId: a.attemptId,
            beforeSha: head.before,
            createdAt: now,
          });
        } else {
          d.acc.submissionUpdates.push({ key: { repo: a.repo, headSha: head.after }, patch: { itemId: item.itemId, trainId, disposition: plan.disposition } });
        }
        const regates = (a.regates ?? 0) + (mode === "regate" ? 1 : 0);
        entered = {
          ...a,
          state: "PUSHED",
          trainId,
          headSha: head.after,
          itemId: item.itemId,
          raceId: d.acc.trains.get(trainId)?.raceId ?? null,
          ...(mode === "regate" ? { regates, lastRegateAt: now } : {}),
        };
        d.acc.attempts.set(a.attemptId, entered);
        const what = mode === "regate" ? `re-gate requested (${regates}/${MAX_MANUAL_REGATES}): ` : "";
        d.acc.events.push(
          this.attemptEvent("attempt.state", item.itemId, a.attemptId, `attempt ${a.attemptId}: ${what}${a.state} → PUSHED ${short(head.after)} (${plan.disposition}; train ${trainId})`, {
            from: a.state,
            to: "PUSHED",
            headSha: head.after,
            trainId,
            disposition: plan.disposition,
            ...(plan.supersedeTrainId ? { superseded: plan.supersedeTrainId } : {}),
            ...(mode === "regate" ? { regate: regates, of: MAX_MANUAL_REGATES } : {}),
          }, actor),
        );
        d.acc.events.push(
          this.submissionEvent(item.itemId, trainId, `submission ${mode === "regate" ? "re-gated" : "received"} (${plan.disposition}) from ${actor} (claims ${a.model}): ${head.title}`, {
            outcome: "applied",
            disposition: plan.disposition,
            ref,
            headSha: head.after,
            repo: a.repo,
            origin,
            attemptId: a.attemptId,
            ...(mode === "regate" ? { regate: true } : {}),
          }, actor),
        );
      },
      { trains: [trainId, ...(plan.supersedeTrainId ? [plan.supersedeTrainId] : [])], items: [plan.itemId, ...(parent ? [parent] : [])] },
    );
    await this.commit(hive, acc);
    return { attempt: getAttemptRow(this.sql, a.attemptId) ?? entered, trainId, disposition: plan.disposition };
  }

  /**
   * `retry_gates`: re-run the gates on the attempt's current head after an INFRA verdict (the gate could not run after
   * its automatic re-gates). Idempotent: a head still being gated or re-gated answers `changed: false`. CONFLICT when
   * there is nothing to re-gate (no push yet, the head passed, or the last verdict found problems in the change).
   * At most MAX_MANUAL_REGATES per attempt, one per REGATE_MIN_INTERVAL_MS (CAP_EXCEEDED, with `retryAfterMs` for the
   * interval). The head is re-submitted as a new train exactly like a push of it (no new submission row).
   */
  async attemptRegate(input: AttemptOwnerAction): Promise<AttemptResult> {
    const r = parseOrThrow(AttemptRegateSchema, input, "attempt regate");
    const hive = this.hiveFor(r.hive);
    const a = getAttemptRow(this.sql, r.attemptId);
    const refused = this.ownerRefusal(a, r);
    if (refused) return refused;
    const att = a!;
    const t = this.trainExists(att.trainId) ? this.loadTrain(att.trainId) : null;
    const conflict = (message: string): AttemptResult => ({ ok: false, code: "CONFLICT", message: clip(message, 200) });
    if (!t || !att.headSha || att.state === "READY" || att.state === "INTENT") return conflict(`attempt ${att.attemptId} has no pushed head; push first`);
    const verdict = attemptVerdict(t);
    if (verdict === "pending") return { ok: true, attempt: this.attemptView(att), changed: false };
    if (verdict === "passed") return conflict(`attempt ${att.attemptId}'s head ${short(att.headSha)} passed; nothing to re-gate`);
    if (attemptVerdictKind(t) !== "infra") return conflict(`the last verdict found problems in the change (${short(att.headSha)}); push a fix`);
    const regates = att.regates ?? 0;
    if (regates >= MAX_MANUAL_REGATES) return { ok: false, code: "CAP_EXCEEDED", message: `re-gates per attempt: ${MAX_MANUAL_REGATES} reached; push again to start over` };
    const now = this.now();
    if (att.lastRegateAt !== undefined && now - att.lastRegateAt < REGATE_MIN_INTERVAL_MS) {
      const wait = Math.max(0, att.lastRegateAt + REGATE_MIN_INTERVAL_MS - now);
      return { ok: false, code: "CAP_EXCEEDED", message: `one re-gate per ${REGATE_MIN_INTERVAL_MS / 1000} s; retry in ${Math.ceil(wait / 1000)} s`, retryAfterMs: wait };
    }
    const sub = getSubmission(this.sql, att.repo, att.headSha);
    if (!sub || sub.outcome !== "applied") return conflict(`attempt ${att.attemptId}'s head ${short(att.headSha)} has no submission; push again`);
    // Where the head re-enters (decided before anything is committed): the RACING race its previous train is already a
    // candidate of (even with entries closed: not a new entry), else the push intake, unless the item is late
    // (decided, landed, closed to entries): then nothing to re-gate. A regate never files a follow-up item.
    const intakeItem = this.intakeLookup({ state: this.activeState() }).item(att.itemId);
    let rejoin: string | undefined;
    if (intakeItem?.racing) {
      const raceRow = this.sql.exec("SELECT * FROM races WHERE race_id = ?", intakeItem.racing.raceId).toArray()[0];
      if (raceRow && rowToRace(raceRow).trainIds.includes(att.trainId)) rejoin = intakeItem.racing.raceId;
    }
    // Rework loop (R7): an infra-stopped fix of a REWORKING race re-enters that race (no intake: the item is ACTIVE).
    if (!rejoin && att.raceId) {
      const row = this.sql.exec("SELECT * FROM races WHERE race_id = ?", att.raceId).toArray()[0];
      const r = row ? rowToRace(row) : null;
      // Only the winner's attempt (§5.3; check 2): a loser's infra-stopped candidate of that race is late (refused below).
      if (r && r.state === "REWORKING" && r.trainIds.includes(att.trainId) && this.isReworkingWinner(r, att.attemptId)) rejoin = r.raceId;
    }
    if (!rejoin && intakeItem && (lateReason(intakeItem, now) || raceClosedToEntries(intakeItem, now))) {
      return { ok: false, code: "ITEM_NOT_ACCEPTING", message: clip(`item ${att.itemId} was decided without this head; nothing to re-gate`, 200) };
    }
    const item = this.loadItem(att.itemId);
    // The submission row keeps no title / message: the re-submission uses the item's title for both, so the original
    // push's trailers are not carried (no effect on routing: the ref is item/<id>, and a regate never files new items).
    const title = clip(item?.title ?? `attempt ${att.attemptId}`, 120);
    const entered = await this.enterAttemptHead(hive, att, { after: att.headSha, before: sub.beforeSha ?? null, title, message: title }, "regate", rejoin ? { raceId: rejoin } : undefined);
    return { ok: true, attempt: this.attemptView(entered.attempt), changed: true };
  }

  /** `refresh_attempt`: the attempt's own owner and agent, a non-terminal attempt: expires_at = now + 2 h (queenos-mcp mints the token). */
  async attemptRefresh(input: AttemptOwnerAction): Promise<AttemptResult> {
    const r = parseOrThrow(AttemptRefreshSchema, input, "attempt refresh");
    const hive = this.hiveFor(r.hive);
    const a = getAttemptRow(this.sql, r.attemptId);
    const refused = this.ownerRefusal(a, r);
    if (refused) return refused;
    // A refresh never shortens an open slot's protection (§5.1): max(now + 2 h, dueAt + 10 min).
    const floor = a!.rework ? a!.rework.dueAt + REWORK_EXPIRY_GRACE_MS : 0;
    const next: Attempt = { ...a!, expiresAt: Math.max(this.now() + ATTEMPT_TTL_MS, floor) };
    const { acc } = this.decide(hive, (d) => {
      d.acc.attempts.set(next.attemptId, next);
      d.acc.events.push(this.attemptEvent("attempt.state", next.itemId, next.attemptId, `attempt ${next.attemptId}: token refreshed`, { refreshed: true, expiresAt: next.expiresAt }, `agent:${next.agentName}@${next.owner}`, "debug"));
    });
    await this.commit(hive, acc);
    return { ok: true, attempt: this.attemptView(next), changed: true };
  }

  /**
   * `end_attempt`: → ABANDONED. A pushed candidate not yet in a car is withdrawn; a winner already in a car (or
   * landing) cannot be abandoned and is returned unchanged. The fork is deleted once: through the current train, or
   * by a repo DELETE when the attempt never pushed. An INTENT is only marked (queenos-mcp is still creating its fork;
   * its attemptReady then fails ATTEMPT_EXPIRED and it deletes the fork itself).
   */
  async attemptEnd(input: AttemptOwnerAction): Promise<AttemptResult> {
    const r = parseOrThrow(AttemptEndSchema, input, "attempt end");
    const hive = this.hiveFor(r.hive);
    const a = getAttemptRow(this.sql, r.attemptId);
    // M1: ending an attempt that already ended (its own agent asking) is a no-op, not ATTEMPT_EXPIRED.
    if (a && this.ownsAttempt(a, r) && isTerminalAttemptState(a.state)) return { ok: true, attempt: this.attemptView(a), changed: false };
    const refused = this.ownerRefusal(a, r);
    if (refused) return refused;
    const att = a!;
    const t = this.trainExists(att.trainId) ? this.loadTrain(att.trainId) : null;
    if (t && isActive(t) && (t.carId || t.phase === "LANDING")) return { ok: true, attempt: this.attemptView(att), changed: false };
    const next: Attempt = { ...att, state: "ABANDONED" };
    const { acc } = this.decide(
      hive,
      (d) => {
        d.acc.attempts.set(att.attemptId, next);
        if (t) {
          if (isActive(t)) d.acc.train(d.tp.withdraw(t.trainId, `${att.agentName} ended attempt ${att.attemptId}`));
          // Rework loop (§5.6): an open slot closes; a REWORK candidate leaves its race; a REWORKING race falls back.
          d.acc.train(d.tp.attemptEnded(att.attemptId, "ended by the agent"));
          d.acc.train(d.tp.deleteAttemptFork(t.trainId));
        } else if (att.state !== "INTENT") {
          this.repoDelete(d, att.attemptId, att.repo, this.loadItem(att.itemId)?.traceId ?? null);
        }
        d.acc.events.push(this.attemptEvent("attempt.state", att.itemId, att.attemptId, `attempt ${att.attemptId}: ${att.state} → ABANDONED (end_attempt)`, { from: att.state, to: "ABANDONED" }, `agent:${att.agentName}@${att.owner}`));
      },
      { trains: t ? [t.trainId] : [], items: [att.itemId] },
    );
    await this.commit(hive, acc);
    // The committed row: the decision may have changed more than the state (e.g. closed the rework slot).
    return { ok: true, attempt: this.attemptView(getAttemptRow(this.sql, att.attemptId) ?? next), changed: true };
  }

  /** `get_attempt` / `wait` / `get_verdict`: the row, its current train and race. Null: unknown. */
  getAttempt(attemptId: string): AttemptView | null {
    const a = getAttemptRow(this.sql, attemptId);
    return a ? this.attemptView(a) : null;
  }

  /** `get_item`: the item's shared base and every attempt on it. */
  attemptsForItem(itemId: string): ItemAttempts {
    const b = getItemBase(this.sql, itemId);
    if (!b) throw new QueenError("NOT_FOUND", `item ${itemId} not found`);
    return { itemId, baseSha: b.baseSha, basePending: !!b.baseRepo && !b.baseSha, attempts: attemptsOfItem(this.sql, itemId).map((a) => this.attemptView(a)) };
  }

  // ── MCP attempts: reads and helpers ───────────────────────────────────

  /**
   * Rework loop: where an attempt's push re-enters without intake. Inside an open slot (dueAt still ahead), its own RACING
   * or REWORKING race: the same candidate, never a follow-up (§5.1, §5.2, §5.3). While its slot's fix is still pending
   * (R4: reworks > 0, its current train an active unboarded RACING candidate of that race), the same race, superseding
   * that fix in place. Otherwise null: normal intake (a late push after dueAt included, §5.1).
   */
  private reworkRejoin(a: Attempt, now: number): { raceId: string; supersede?: string } | null {
    if (!a.raceId) return null;
    const row = this.sql.exec("SELECT * FROM races WHERE race_id = ?", a.raceId).toArray()[0];
    const race = row ? rowToRace(row) : null;
    if (!race || (race.state !== "RACING" && race.state !== "REWORKING")) return null;
    // Only the winner's attempt pushes into a REWORKING race (§5.3); any other attempt takes intake ("already being built").
    if (race.state === "REWORKING" && !this.isReworkingWinner(race, a.attemptId)) return null;
    if (a.rework && a.rework.dueAt > now) return { raceId: race.raceId };
    const t = this.trainExists(a.trainId) ? this.loadTrain(a.trainId) : null;
    if ((a.reworks ?? 0) > 0 && t && isActive(t) && t.raceId === race.raceId && t.raceOutcome === "RACING" && !t.carId) return { raceId: race.raceId, supersede: t.trainId };
    return null;
  }

  /** A REWORKING race's winner (its `winnerTrainId`, kept until a fix wins) is `attemptId`'s train. */
  private isReworkingWinner(race: RaceRecord, attemptId: string): boolean {
    const w = race.winnerTrainId && this.trainExists(race.winnerTrainId) ? this.loadTrain(race.winnerTrainId) : null;
    return w?.attemptId === attemptId;
  }

  /** An attempt as this decision sees it: its pending row in `acc`, else SQLite. */
  private attemptOf(attemptId: string, acc?: Acc): Attempt | null {
    return acc?.attempts.get(attemptId) ?? getAttemptRow(this.sql, attemptId);
  }

  private ownsAttempt(a: Attempt, r: AttemptOwnerAction): boolean {
    return a.owner === r.owner.toLowerCase() && a.agentId === r.agentId;
  }

  /** refresh / end / regate: the attempt must exist, belong to this owner and agent, and not be terminal. */
  private ownerRefusal(a: Attempt | null, r: AttemptOwnerAction): AttemptResult | null {
    if (!a) return { ok: false, code: "NOT_FOUND", message: `attempt ${r.attemptId} not found` };
    if (!this.ownsAttempt(a, r)) return { ok: false, code: "FORBIDDEN_OWNER", message: `attempt ${a.attemptId} belongs to another agent` };
    if (isTerminalAttemptState(a.state)) return { ok: false, code: "ATTEMPT_EXPIRED", message: `attempt ${a.attemptId} is ${a.state}` };
    return null;
  }

  /**
   * v17: a Provisioner DELETE for a repo no train holds: an attempt fork before its first push (key = the attempt id)
   * or a race base (key = `base-<itemId>`). Recorded in repo_deletes (the attempt watchdog re-sends it until it is
   * reported deleted); `reportProvisionResult` acknowledges its report. Command id `<key>-delete-<n>`, n unique per key
   * (an item may delete a cleared pending base, then its real base).
   */
  private repoDelete(d: Decision, key: string, repo: string, traceId: string | null): void {
    const prior = this.repoDeleteRow(repo, d.acc);
    if (prior && prior.state !== "GAVE_UP") return; // already sent (or deleted): exactly once per repo
    this.sendRepoDelete(d, { repo, key, hive: d.hive, commandId: this.nextRepoDeleteId(key, d.acc), traceId, state: "PENDING", sends: 0, issuedAt: d.now });
  }

  /** Dispatch `r` (sends + 1, issued now) and record it. */
  private sendRepoDelete(d: Decision, r: RepoDelete): void {
    const next: RepoDelete = { ...r, state: "PENDING", sends: r.sends + 1, issuedAt: d.now };
    d.acc.repoDeletes.set(next.repo, next);
    d.acc.effects.push({
      type: "provision",
      trainId: next.key,
      command: { op: "DELETE", commandId: next.commandId, hive: next.hive, trainId: next.key, repo: next.repo, ...(next.traceId ? { trace: { traceparent: traceparent(next.traceId, spanIdFor(next.commandId)) } } : {}) },
    });
  }

  private repoDeleteRow(repo: string, acc: Acc): RepoDelete | null {
    return acc.repoDeletes.get(repo) ?? getRepoDelete(this.sql, repo);
  }

  /** `<key>-delete-<n>`: n one past every command id this key has used (rows in SQLite and in this decision). */
  private nextRepoDeleteId(key: string, acc: Acc): string {
    const ids = [...repoDeletesOfKey(this.sql, key), ...[...acc.repoDeletes.values()].filter((r) => r.key === key)].map((r) => commandAttempt(r.commandId));
    return `${key}-delete-${Math.max(0, ...ids) + 1}`;
  }

  /**
   * v17: after every decision, each attempt follows its current train (attemptStateOf). A terminal transition (LOST,
   * LANDED) deletes the attempt's fork once, through its current train. Trains of earlier pushes (superseded) are skipped:
   * the attempt no longer points at them.
   */
  private syncAttempts(d: Decision): void {
    // Rework loop: the planner's slot changes land on the attempt rows first. A new slot extends expires_at to at least
    // dueAt + REWORK_EXPIRY_GRACE_MS, so the watchdog never expires an attempt mid-slot (§5.1).
    for (const s of d.acc.slots.values()) {
      const a = this.attemptOf(s.attemptId, d.acc);
      if (!a) continue;
      const prev = a.rework ?? null;
      const opened = !!s.rework && (!prev || prev.round !== s.rework.round);
      const next: Attempt = { ...a, reworks: s.reworks, rework: s.rework, ...(opened ? { expiresAt: Math.max(a.expiresAt, s.rework!.dueAt + REWORK_EXPIRY_GRACE_MS) } : {}) };
      d.acc.attempts.set(a.attemptId, next);
      if (opened) {
        const r = s.rework!;
        d.acc.events.push(this.attemptEvent("attempt.state", a.itemId, a.attemptId, `attempt ${a.attemptId}: rework slot ${r.round}/${d.hs.guardrails.maxReworksPerAttempt} (${r.reason}) until ${iso(r.dueAt)}`, { rework: r, expiresAt: next.expiresAt }, "queen", "warn"));
      } else if (prev && !s.rework) {
        d.acc.events.push(this.attemptEvent("attempt.state", a.itemId, a.attemptId, `attempt ${a.attemptId}: rework slot ${prev.round} closed`, { reworkClosed: prev }, "queen"));
      }
    }
    for (const t of [...d.acc.trains.values()]) {
      if (!t.attemptId) continue;
      const a = this.attemptOf(t.attemptId, d.acc);
      if (!a || a.trainId !== t.trainId || a.state === "INTENT" || a.state === "READY" || isTerminalAttemptState(a.state)) continue;
      const next = attemptStateOf(t);
      const raceId = t.raceId ?? a.raceId;
      if (next !== a.state || raceId !== a.raceId) d.acc.attempts.set(a.attemptId, { ...a, state: next, raceId });
      if (next !== a.state) {
        d.acc.events.push(this.attemptEvent("attempt.state", a.itemId, a.attemptId, `attempt ${a.attemptId}: ${a.state} → ${next}`, { from: a.state, to: next, trainId: t.trainId }, "queen"));
      }
      if (isTerminalAttemptState(next)) d.acc.train(d.tp.deleteAttemptFork(t.trainId));
    }
  }

  /**
   * v17 watchdog (reconcile alarm): READY / REJECTED attempts past `expires_at` (no live candidate) → EXPIRED, fork
   * deleted; an INTENT older than INTENT_TTL_MS (start_attempt died) → ABORTED, its reserved fork name deleted (best
   * effort); a base pending longer than BASE_PENDING_TTL_MS → cleared, its name deleted (best effort); repo DELETEs no
   * train holds that went unreported (re-sent under the same id) or failed (re-sent under the next id), up to
   * MAX_COMMAND_ATTEMPTS sends.
   */
  private attemptWatchdog(d: Decision): void {
    for (const a of this.dueAttempts(d.now)) {
      const to = a.state === "INTENT" ? "ABORTED" : "EXPIRED";
      d.acc.attempts.set(a.attemptId, { ...a, state: to });
      if (a.state === "INTENT") this.repoDelete(d, a.attemptId, a.repo, null);
      else {
        // Rework loop (§5.6): as end_attempt: the slot closes, a REWORK candidate leaves its race, a REWORKING race falls back.
        d.acc.train(d.tp.attemptEnded(a.attemptId, "attempt expired"));
        this.deleteAttemptRepo(d, a);
      }
      d.acc.events.push(this.attemptEvent("attempt.state", a.itemId, a.attemptId, `attempt ${a.attemptId}: ${a.state} → ${to} (watchdog)`, { from: a.state, to, watchdog: true }, "queen", "warn"));
    }
    const stale = this.sql
      .exec("SELECT item_id, base_repo FROM work_items WHERE base_repo IS NOT NULL AND base_sha IS NULL AND base_pending_at <= ?", d.now - BASE_PENDING_TTL_MS)
      .toArray();
    for (const r of stale) {
      const itemId = String(r.item_id);
      const baseRepo = String(r.base_repo);
      d.acc.itemBases.set(itemId, { itemId, baseRepo: null, baseSha: null, pendingAt: null });
      this.repoDelete(d, `base-${itemId}`, baseRepo, null);
      d.acc.events.push(this.attemptEvent("attempt.base", itemId, null, `pending base ${baseRepo} cleared after ${BASE_PENDING_TTL_MS / 60_000} min (watchdog)`, { outcome: "pending-cleared", baseRepo }, "queen", "warn"));
    }
    for (const r of dueRepoDeletes(this.sql, d.now - commandTimeoutMs(this.env))) {
      if (d.acc.repoDeletes.has(r.repo)) continue;
      const base = r.key.startsWith("base-");
      const ev = (summary: string, data: Record<string, unknown>, severity: EventDraft["severity"]) =>
        d.acc.events.push(this.attemptEvent(base ? "attempt.base" : "attempt.state", base ? r.key.slice(5) : null, base ? null : r.key, summary, { ...data, repo: r.repo }, "queen", severity));
      if (r.sends >= MAX_COMMAND_ATTEMPTS) {
        d.acc.repoDeletes.set(r.repo, { ...r, state: "GAVE_UP" });
        ev(`repo delete of ${r.repo} gave up after ${r.sends} sends (${r.commandId})`, { outcome: "delete-gave-up", commandId: r.commandId }, "warn");
        continue;
      }
      // Lost dispatch: the same id (the Provisioner's instance id; an existing instance counts as sent). Failed: the next id.
      const commandId = r.state === "FAILED" ? this.nextRepoDeleteId(r.key, d.acc) : r.commandId;
      this.sendRepoDelete(d, { ...r, commandId });
      ev(`repo delete of ${r.repo} re-sent (${commandId})`, { outcome: "delete-resent", commandId, after: r.state }, "debug");
    }
  }

  /** Attempts the watchdog ends now: READY / REJECTED past expiry, INTENT older than INTENT_TTL_MS. */
  private dueAttempts(now: number): Attempt[] {
    return this.sql
      .exec("SELECT * FROM attempts WHERE (state IN ('READY', 'REJECTED') AND expires_at <= ?) OR (state = 'INTENT' AND created_at <= ?)", now, now - INTENT_TTL_MS)
      .toArray()
      .map(rowToAttempt);
  }

  /**
   * Delete a terminal attempt's fork once: through its current train when the planner holds it (the train's DELETE
   * path, watchdog-retried), else by a repo DELETE keyed by the attempt (no train yet, or the train is no longer loaded).
   */
  private deleteAttemptRepo(d: Decision, a: Attempt): void {
    const r = this.trainExists(a.trainId) ? d.acc.train(d.tp.deleteAttemptFork(a.trainId)) : null;
    if (!r || r.outcome === "ignored:unknown") this.repoDelete(d, a.attemptId, a.repo, null);
  }

  /** The item's attempts as this decision sees them: rows in `acc` override SQLite (an attempt that moved away no longer counts). */
  private attemptsOfItemNow(itemId: string, acc: Acc): Attempt[] {
    const byId = new Map(attemptsOfItem(this.sql, itemId).map((a) => [a.attemptId, a]));
    for (const a of acc.attempts.values()) {
      if (a.itemId === itemId) byId.set(a.attemptId, a);
      else byId.delete(a.attemptId);
    }
    return [...byId.values()];
  }

  /**
   * v17: an item's race base is deleted exactly once, when nothing needs it: the item was cancelled (its open attempts
   * are abandoned, their forks deleted), or none of its attempts holds it and it has no RACING / PICKING / REWORKING race.
   * After a fallback (R6, F3: the item's newest race ABANDONED) only an INTENT attempt holds it.
   * `base_repo` is cleared when the DELETE is issued (so it is never issued twice); `base_sha` stays for history.
   */
  private releaseBases(d: Decision): void {
    const items = new Set<string>();
    for (const a of d.acc.attempts.values()) {
      items.add(a.itemId);
      const stored = getAttemptRow(this.sql, a.attemptId);
      if (stored && stored.itemId !== a.itemId) items.add(stored.itemId);
    }
    for (const i of d.acc.items.values()) if (i.status === "CANCELLED") items.add(i.itemId);
    // A race resolved in this decision (window closed, entries closed, a pick) after the item's last attempt ended:
    // no attempt row changes then, so the race names the item. The open-attempt and open-race checks below still gate it.
    for (const r of d.acc.races.values()) if (r.state === "DECIDED" || r.state === "ABANDONED") items.add(r.itemId);
    // A base pinned in this decision (attemptBaseReady) after its INTENT ended or its item was cancelled: nobody uses it.
    for (const b of d.acc.itemBases.values()) if (b.baseRepo && b.baseSha) items.add(b.itemId);
    for (const itemId of items) {
      const b = this.baseOf(itemId, d.acc);
      const item = d.acc.items.get(itemId) ?? this.loadItem(itemId);
      const cancelled = item?.status === "CANCELLED";
      const nonTerminal = this.attemptsOfItemNow(itemId, d.acc).filter((a) => !isTerminalAttemptState(a.state));
      const races = new Map(this.sql.exec("SELECT * FROM races WHERE item_id = ?", itemId).toArray().map((r) => [String(r.race_id), rowToRace(r)] as const));
      for (const r of d.acc.races.values()) if (r.itemId === itemId) races.set(r.raceId, r);
      const itemRaces = [...races.values()].sort((x, y) => x.createdAt - y.createdAt);
      const openRace = itemRaces.some((r) => r.state === "RACING" || r.state === "PICKING" || r.state === "REWORKING");
      // R6 / F3 (§5.6.3): after a fallback (the newest race ABANDONED, none open) the attempts of the abandoned race's
      // time no longer hold the base (their forks are their own), only an INTENT does (it may be forking it now), so the
      // next start_attempt forks a fresh base from current main. An attempt started after the fallback is on that fresh
      // base and holds it as usual.
      const newest = itemRaces.at(-1);
      const fallbackAt = !openRace && newest?.state === "ABANDONED" ? (newest.decidedAt ?? newest.createdAt) : null;
      const holders = fallbackAt === null ? nonTerminal : nonTerminal.filter((a) => a.state === "INTENT" || a.createdAt >= fallbackAt);
      if (cancelled) {
        for (const a of nonTerminal) {
          d.acc.attempts.set(a.attemptId, { ...a, state: "ABANDONED" });
          if (a.state !== "INTENT") this.deleteAttemptRepo(d, a);
          d.acc.events.push(this.attemptEvent("attempt.state", itemId, a.attemptId, `attempt ${a.attemptId}: ${a.state} → ABANDONED (item cancelled)`, { from: a.state, to: "ABANDONED", cancelled: true }, "queen"));
        }
        // A pending base (no sha yet) is left to the stale-base watchdog.
        if (!b?.baseRepo || !b.baseSha) continue;
      } else {
        if (!b?.baseRepo || !b.baseSha) continue;
        if (holders.length || openRace) continue;
      }
      d.acc.itemBases.set(itemId, { itemId, baseRepo: null, baseSha: b.baseSha, pendingAt: null });
      this.repoDelete(d, `base-${itemId}`, b.baseRepo, item?.traceId ?? null);
      d.acc.events.push(this.attemptEvent("attempt.base", itemId, null, `base ${b.baseRepo} deleted (${cancelled ? "item cancelled" : "item resolved"})`, { outcome: "deleting", baseRepo: b.baseRepo }, "queen"));
    }
  }

  /** v19: the slots of the hive's open attempts (the planner's HiveState.slots). */
  private attemptSlots(): AttemptSlot[] {
    return this.sql
      .exec(`SELECT attempt_id, reworks, rework_reason, rework_due_at FROM attempts WHERE state IN (${OPEN_ATTEMPTS_SQL}) AND (reworks > 0 OR rework_due_at IS NOT NULL)`)
      .toArray()
      .map((r) => ({
        attemptId: String(r.attempt_id),
        reworks: Number(r.reworks ?? 0),
        rework:
          r.rework_due_at === null || r.rework_due_at === undefined
            ? null
            : { reason: String(r.rework_reason) as ReworkReason, dueAt: Number(r.rework_due_at), round: Number(r.reworks ?? 0) },
      }));
  }

  /** v17: the next attempt watchdog deadline (an expiry, an open rework slot's dueAt, a stale INTENT, a stale pending base, a repo DELETE re-send), or null. */
  private attemptDeadline(timeout: number): number | null {
    const t = this.sql
      .exec(
        `SELECT MIN(t) AS t FROM (
           SELECT MIN(expires_at) AS t FROM attempts WHERE state IN ('READY', 'REJECTED')
           UNION ALL SELECT MIN(rework_due_at) AS t FROM attempts WHERE rework_due_at IS NOT NULL AND state IN (${OPEN_ATTEMPTS_SQL})
           UNION ALL SELECT MIN(created_at) + ? AS t FROM attempts WHERE state = 'INTENT'
           UNION ALL SELECT MIN(base_pending_at) + ? AS t FROM work_items WHERE base_repo IS NOT NULL AND base_sha IS NULL
           UNION ALL SELECT MIN(issued_at) + ? AS t FROM repo_deletes WHERE state IN ('PENDING', 'FAILED'))`,
        INTENT_TTL_MS,
        BASE_PENDING_TTL_MS,
        timeout,
      )
      .one().t;
    return t === null || t === undefined ? null : Number(t);
  }

  /** An item's race base as this decision sees it. */
  private baseOf(itemId: string, acc?: Acc): ItemBase | null {
    return acc?.itemBases.get(itemId) ?? getItemBase(this.sql, itemId);
  }

  private attemptView(a: Attempt): AttemptView {
    const t = this.loadTrain(a.trainId);
    const raceId = t?.raceId ?? a.raceId;
    const row = raceId ? this.sql.exec("SELECT * FROM races WHERE race_id = ?", raceId).toArray()[0] : undefined;
    const race = row ? rowToRace(row) : null;
    return {
      ...a,
      rework: a.rework ?? null,
      train: t
        ? {
            trainId: t.trainId,
            phase: t.phase,
            raceOutcome: t.raceOutcome ?? null,
            headSha: t.headSha,
            previewUrl: t.previewUrl,
            summary: t.summary,
            reason: t.reason,
            score: t.score ?? null,
            gateInfraRounds: t.gateInfraRounds ?? 0,
            conflict: t.conflict ? { paths: [...t.conflict.paths], summary: t.conflict.summary } : null,
          }
        : null,
      race: race ? { raceId: race.raceId, state: race.state, entryClosesAt: race.entryClosesAt ?? null, winnerTrainId: race.winnerTrainId, reopens: race.reopens ?? 0 } : null,
      verdict: attemptVerdict(t),
      verdictKind: attemptVerdictKind(t, a.rework ?? null),
      regating: attemptRegating(t),
    };
  }

  /** Distinct open items the owner has an open attempt or an applied push on (maxInboxOpenPerContributor). */
  private ownerOpenItems(owner: string): Set<string> {
    const ids = new Set<string>();
    for (const r of this.sql.exec(`SELECT DISTINCT item_id FROM attempts WHERE owner = ? AND state IN (${OPEN_ATTEMPTS_SQL})`, owner).toArray()) ids.add(String(r.item_id));
    for (const r of this.sql
      .exec(`SELECT DISTINCT s.item_id FROM submissions s JOIN work_items w ON w.item_id = s.item_id WHERE s.origin_id = ? AND s.outcome = 'applied' AND w.status NOT IN ${OPEN_PUSHED_SQL}`, owner)
      .toArray()) {
      ids.add(String(r.item_id));
    }
    return ids;
  }

  /** The oldest attempt start or applied / pending push counted by ownerStartsSince (null: none). */
  private ownerOldestStartSince(owner: string, since: number): number | null {
    const v = this.sql
      .exec(
        `SELECT MIN(at) AS at FROM (SELECT MIN(created_at) AS at FROM submissions WHERE origin_id = ? AND created_at >= ? AND outcome IN ('applied', 'pending')
           UNION ALL SELECT MIN(created_at) AS at FROM attempts WHERE owner = ? AND created_at >= ?)`,
        owner,
        since,
        owner,
        since,
      )
      .one().at;
    return v === null || v === undefined ? null : Number(v);
  }

  /** maxInboxPushesPerHour: each attempt start and each applied / pending push counts one. */
  private ownerStartsSince(owner: string, since: number): number {
    const pushes = Number(this.sql.exec("SELECT COUNT(*) AS n FROM submissions WHERE origin_id = ? AND created_at >= ? AND outcome IN ('applied', 'pending')", owner, since).one().n);
    const starts = Number(this.sql.exec("SELECT COUNT(*) AS n FROM attempts WHERE owner = ? AND created_at >= ?", owner, since).one().n);
    return pushes + starts;
  }

  private attemptEvent(
    type: "attempt.intent" | "attempt.state" | "attempt.base",
    itemId: string | null,
    attemptId: string | null,
    summary: string,
    data: Record<string, unknown>,
    actor: string,
    severity: EventDraft["severity"] = "info",
  ): EventDraft {
    return {
      type,
      severity,
      actor: clip(actor, 340),
      traceId: itemId ? (this.loadItem(itemId)?.traceId ?? traceIdFromUuid(itemId)) : null,
      spanId: attemptId ? spanIdFor(attemptId) : null,
      parentSpanId: itemId ? spanIdFor(itemId) : null,
      itemId,
      trainId: null,
      summary: clip(summary, 500),
      data,
    };
  }

  /**
   * The v1 notes projection of one ref (§7.5): one note per submission head (drone or pushed), rendered
   * from the event log, audits, trains and releases by the T0b renderer. `version` is the ledger version
   * (the newest event seq): the proxy's cache key. Notes are information, never authority.
   */
  notesFor(hive: string, ref: string): NotesProjection {
    const r = parseOrThrow(NotesRefSchema, ref, "notes ref");
    const named = this.hiveNamespace();
    if (named !== null && named !== hive) throw new QueenError("CONFLICT", `this hive is "${named}", not "${hive}"`);
    const version = Number(this.sql.exec("SELECT COALESCE(MAX(seq), 0) AS v FROM event_log").one().v);
    return { ref: r, version, notes: projectNotes(this.notesInput(null), r) };
  }

  /** The rendered `refs/notes/verdict` note of one commit (a seeded REWORK's brief), or null. */
  verdictNote(sha: string): string | null {
    if (!/^[0-9a-f]{40}$/.test(sha)) return null;
    return projectNotes(this.notesInput(sha), "refs/notes/verdict").find((n) => n.sha === sha)?.text ?? null;
  }

  /** Rows of the notes projection: every BUILD train with a head (or only those of `sha`) and their ledger. */
  private notesInput(sha: string | null): NotesInput {
    const byHead = (h: string) => this.sql.exec("SELECT * FROM merge_trains WHERE lane = 'BUILD' AND head_sha = ? ORDER BY seq", h).toArray().map(rowToTrain);
    let all: TrainRecord[];
    if (sha) {
      // The commit's trains, plus the contributor's trains whose head a REWORK of it started from (Queen-Replies-To).
      all = byHead(sha);
      for (const b of new Set(all.map((t) => t.baseSha).filter((x) => /^[0-9a-f]{40}$/.test(x) && x !== sha))) all.push(...byHead(b));
    } else {
      all = this.sql.exec("SELECT * FROM merge_trains WHERE lane = 'BUILD' AND head_sha IS NOT NULL ORDER BY seq DESC LIMIT ?", MAX_NOTES).toArray().map(rowToTrain);
    }
    // Pushed code: the branch it came from (every applied submission row; pruned at 30 days).
    const refOf = new Map<string, string>();
    for (const r of this.sql.exec("SELECT train_id, ref FROM submissions WHERE outcome = 'applied' AND train_id IS NOT NULL").toArray()) refOf.set(String(r.train_id), String(r.ref));
    const trains: NotesTrain[] = all.map((t) => ({
      trainId: t.trainId,
      promptId: t.promptId,
      seq: t.seq,
      headSha: t.headSha,
      baseSha: t.baseSha,
      phase: t.phase,
      reason: t.reason,
      landedSha: t.landedSha,
      action: t.action,
      model: t.model,
      traceId: traceOfTrain(t),
      raceOutcome: t.raceOutcome ?? null,
      conflict: t.conflict ?? null,
      origin: t.origin ?? null,
      ref: refOf.get(t.trainId) ?? null,
      summary: t.summary,
    }));
    const releases = this.sql
      .exec("SELECT * FROM releases WHERE phase IN ('SHIPPED', 'ROLLED_BACK') ORDER BY seq DESC LIMIT 200")
      .toArray()
      .map(rowToRelease)
      .map((r) => ({ releaseId: r.releaseId, trainIds: [...r.trainIds] }));
    const ids = new Set(trains.map((t) => t.trainId));
    const items = new Set(trains.map((t) => t.promptId));
    const relIds = new Set(releases.filter((r) => r.trainIds.some((id) => ids.has(id))).map((r) => r.releaseId));
    const since = all.length ? Math.min(...all.map((t) => t.createdAt)) - HOUR_MS : 0;
    const events = this.sql
      .exec(
        // Audits are matched by item and seq window (their ts is the reporter's clock), so they are not ts-bounded.
        `SELECT * FROM event_log WHERE (type = 'drone.audit' AND audit_status = 'REJECTED') OR (ts >= ? AND (
           (type IN ('gate.verdict', 'train.enqueued') AND train_id IS NOT NULL)
           OR (type = 'train.phase' AND train_id IS NOT NULL AND json_extract(data, '$.to') IN ('MERGED', 'EJECTED'))
           OR type = 'release.phase'))
         ORDER BY seq`,
        sha ? 0 : since,
      )
      .toArray()
      .map(rowToEvent)
      .filter((e) => (e.trainId !== null && ids.has(e.trainId)) || (e.type === "drone.audit" && e.itemId !== null && items.has(e.itemId)) || (e.type === "release.phase" && e.releaseId !== null && relIds.has(e.releaseId)));
    return { trains, events, releases };
  }

  // ── git intake: reads ─────────────────────────────────────────────────

  /** The contributor's latest submission on `ref` (applied, or also pending), other than `exceptTrain`, with its train's state.
   *  Keyed on the owner AND the agent (NULL-safe `IS`): two agent tokens of one owner are separate chains, so their pushes race. */
  private priorOnRef(user: string, ref: string, exceptTrain: string | null, only: "applied" | undefined, agent: string | null): PriorSubmission | null {
    const row = this.sql
      .exec(
        `SELECT * FROM submissions WHERE origin_id = ? AND ref = ? AND outcome IN (${only ? "'applied'" : "'applied', 'pending'"})
         AND (train_id IS NULL OR train_id != ?) AND agent IS ? AND attempt_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        user,
        ref,
        exceptTrain ?? "",
        agent,
      )
      .toArray()[0];
    if (!row) return null;
    const submission = rowToSubmission(row);
    const t = submission.trainId ? (this.cache.get()?.trains.find((x) => x.trainId === submission.trainId) ?? this.loadTrain(submission.trainId)) : null;
    return {
      submission,
      trainActive: !!t && isActive(t),
      trainBoarded: !!t && (!!t.carId || t.phase === "LANDING" || t.phase === "MERGED"),
    };
  }

  /** The contributor's open pushed items (maxInboxOpenPerContributor). */
  private openPushedItems(user: string): number {
    return Number(
      this.sql
        .exec(
          `SELECT COUNT(DISTINCT s.item_id) AS n FROM submissions s JOIN work_items w ON w.item_id = s.item_id
           WHERE s.origin_id = ? AND s.outcome = 'applied' AND w.status NOT IN ${OPEN_PUSHED_SQL}`,
          user,
        )
        .one().n,
    );
  }

  /** Items and goals as intake sees them: rows from SQLite, races and active trains from the warm state. */
  private intakeLookup(d: { state: ActiveState }): IntakeLookup {
    const view = (i: WorkItemRecord): IntakeItem => {
      const racing = d.state.races.find((r) => r.itemId === i.itemId && r.state === "RACING") ?? null;
      const trains = d.state.trains.filter((t) => isActive(t) && !isCar(t) && t.promptId === i.itemId);
      return {
        itemId: i.itemId,
        kind: i.kind,
        status: i.status,
        title: i.title,
        parentId: i.parentId,
        racing: racing ? { raceId: racing.raceId, entryClosesAt: racing.entryClosesAt ?? null } : null,
        decided: trains.some((t) => t.phase === "PASSED" || t.phase === "LANDING" || !!t.carId || t.raceOutcome === "WON"),
        activeNonRace: trains.some((t) => !t.raceId && !awaitingPush(t)),
      };
    };
    return {
      item: (itemId) => {
        const i = this.loadItem(itemId);
        return i ? view(i) : null;
      },
      goal: (slug) => {
        let goal = this.loadItem(slug);
        if (!goal || goal.kind !== "goal") {
          goal =
            this.sql
              .exec("SELECT * FROM work_items WHERE kind = 'goal' ORDER BY seq DESC LIMIT 200")
              .toArray()
              .map(rowToWorkItem)
              .find((g) => slugify(g.title) === slug.toLowerCase()) ?? null;
        }
        if (!goal || goal.kind !== "goal") return null;
        const children = this.sql.exec("SELECT * FROM work_items WHERE parent_id = ? AND kind != 'goal' ORDER BY seq", goal.itemId).toArray().map(rowToWorkItem);
        return { goal: view(goal), children: children.map(view) };
      },
    };
  }

  private submissionEvent(itemId: string | null, trainId: string | null, summary: string, data: Record<string, unknown>, actor: string, severity: EventDraft["severity"] = "info"): EventDraft {
    return {
      type: "submission.received",
      severity,
      actor: clip(actor, 340),
      traceId: itemId ? (this.loadItem(itemId)?.traceId ?? traceIdFromUuid(itemId)) : null,
      spanId: trainId ? spanIdFor(trainId) : null,
      parentSpanId: itemId ? spanIdFor(itemId) : null,
      itemId,
      trainId,
      summary: clip(summary, 500),
      data,
    };
  }

  // ── RPC surface: executor reports ─────────────────────────────────────

  /** The Oracle's DECOMPOSE / TRIAGE answer (POST /internal/webhook/oracle-result). Idempotent by commandId. */
  async reportOracleResult(input: OracleResultInput): Promise<{ outcome: string }> {
    const r = parseOrThrow(OracleResultSchema, input, "oracle result");
    const hive = this.hiveNamespace();
    if (hive === null || !this.loadItem(r.itemId)) throw new QueenError("NOT_FOUND", `item ${r.itemId} not found`);
    const { value: res, acc } = this.decide(hive, (d) => d.acc.work(d.wp.oracleResult(r)), { items: [r.itemId] });
    await this.commit(hive, acc);
    if (res.outcome === "ignored:unknown") throw new QueenError("NOT_FOUND", `item ${r.itemId} not found`);
    return { outcome: res.outcome };
  }

  /** Gatekeeper verdict for a train or car (POST /internal/webhook/train-result). */
  async reportTrainResult(input: TrainResult): Promise<TrainUpdate> {
    const r = parseOrThrow(TrainResultSchema, input, "train result");
    return this.trainTransition(r.trainId, (d, t) => {
      const attempt = t.droneAttempt;
      // A gatekeeper that could not run the gate (Artifacts / Cloudflare 5xx): reported in TESTING, no drone commandId.
      const gateInfra = r.cause === "infra" && !r.passed && t.phase === "TESTING" && !r.commandId;
      const res = d.acc.train(d.tp.trainResult(r));
      if (r.cause === "infra" && !r.passed && !gateInfra) {
        // A builder that hit an infrastructure limit (AI rate limits): a drone result, not a gate verdict.
        const commandId = r.commandId ?? droneInstanceId({ trainId: t.trainId, action: t.action }, attempt);
        d.acc.events.push(
          this.commandResult(t, commandId, `build infra failure (${res.outcome === "applied" ? "re-dispatched" : res.outcome}): ${r.summary}`, {
            action: t.action,
            role: t.action === "REWORK" ? "rework" : "builder",
            outcome: "error",
            cause: "infra",
            applied: res.outcome,
          }),
        );
        return res;
      }
      const sha = r.commitSha ?? t.headSha ?? "";
      const prompt = d.state.prompts.find((p) => p.promptId === t.promptId);
      // gateInfra is not a verdict. The label follows what the planner did, not the input: still active = it re-gates
      // (a contributed train: the same head, re-gate k/N after a backoff; a drone train: re-deploy, then re-gate);
      // no longer active = the re-gates are spent (INFRA_EXHAUSTED); not applied (stale) = no claim at all.
      const post = d.acc.trains.get(t.trainId) ?? t;
      const applied = res.outcome === "applied";
      const regating = gateInfra && applied && isActive(post);
      const exhausted = gateInfra && applied && !isActive(post);
      const round = (post.gateInfraRounds ?? 0) > (t.gateInfraRounds ?? 0) ? (post.gateInfraRounds ?? 0) : 0;
      const delayS = round && post.gateNotBefore ? Math.max(0, Math.round((post.gateNotBefore - d.now) / 1000)) : null;
      // The planner's same-head re-gate path (TrainPlanner.trainResult): its tries are the gate rounds, else the deploys.
      const sameHead = !isCar(t) && isContributed(t) && t.deployState === "LIVE";
      const tries = sameHead ? (post.gateInfraRounds ?? 0) + 1 : Math.max(1, commandAttempt(post.deployCommandId));
      const infraText = regating
        ? round
          ? `could not run (infrastructure; re-gate ${round}/${MAX_GATE_INFRA_ROUNDS} in ${delayS ?? 0} s)`
          : "could not run (infrastructure; re-deploying, then re-gating)"
        : exhausted
          ? `could not run after ${tries} tries (infrastructure); not a verdict on the change`
          : "could not run (infrastructure)";
      d.acc.events.push({
        type: "gate.verdict",
        severity: r.passed ? "info" : "warn",
        actor: "gatekeeper",
        traceId: traceOfTrain(t),
        spanId: spanIdFor(`gate:${t.trainId}:${sha}`),
        parentSpanId: spanIdFor(t.trainId),
        itemId: isCar(t) ? null : t.promptId,
        trainId: t.trainId,
        summary: clip(`gate ${r.passed ? "passed" : gateInfra ? infraText : "failed"}: ${r.summary}`, 500),
        data: {
          outcome: r.passed ? "PASSED" : exhausted ? "INFRA_EXHAUSTED" : gateInfra ? "INFRA" : "FAILED",
          ...(gateInfra ? { cause: "infra" } : {}),
          ...(regating && round ? { gateInfraRound: round, of: MAX_GATE_INFRA_ROUNDS, notBefore: post.gateNotBefore ?? null } : {}),
          ...(exhausted ? { tries } : {}),
          attempt: (prompt?.attempts ?? 0) + 1,
          lane: t.lane ?? "BUILD",
          applied: res.outcome,
          ...(r.score ? { review: r.score.review, changedBytes: r.score.changedBytes } : {}),
        },
      });
      if (res.outcome === "applied" && r.followUps?.length) {
        d.acc.followUps.push({ source: "gatekeeper", actor: "gatekeeper:SECURITY", itemId: isCar(t) ? null : t.promptId, trainId: t.trainId, followUps: r.followUps as FollowUp[] });
      }
      return res;
    });
  }

  /** Builder pushed the train head (POST /internal/webhook/build-result). */
  async reportBuildResult(input: BuildResult): Promise<TrainUpdate> {
    const r = parseOrThrow(BuildResultSchema, input, "build result");
    return this.trainTransition(r.trainId, (d, t) => {
      const res = d.acc.train(d.tp.buildResult(r));
      const model = r.model ?? t.modelChoice?.model ?? t.model ?? null;
      const credits = creditsFor(model, r.usage);
      if (res.outcome === "applied") {
        d.acc.credits += credits;
        if (r.followUps?.length) {
          d.acc.followUps.push({ source: "drone", actor: "drone:BUILDER", itemId: t.promptId, trainId: t.trainId, followUps: r.followUps as FollowUp[] });
        }
      }
      const commandId = droneInstanceId({ trainId: t.trainId, action: t.action }, t.droneAttempt);
      d.acc.events.push(this.commandResult(t, commandId, `build ${res.outcome}: ${model ?? "unknown model"}`, {
        action: t.action,
        model,
        role: t.action === "REWORK" ? "rework" : "builder",
        outcome: res.outcome === "applied" ? "BUILT" : res.outcome,
        ...(r.buildMs !== undefined ? { ms: r.buildMs } : {}),
        ...(credits > 0 ? { credits } : {}),
        ...(r.usage ? { tokensIn: r.usage.inputTokens, tokensOut: r.usage.outputTokens } : {}),
      }));
      return res;
    });
  }

  /** The MERGE drone's report for a car (POST /internal/webhook/merge-result). */
  async reportMergeResult(input: MergeResultInput): Promise<TrainUpdate> {
    const r = parseOrThrow(MergeResultSchema, input, "merge result");
    return this.trainTransition(r.trainId, (d, t) => {
      const res = d.acc.train(d.tp.mergeResult(r));
      const commandId = droneInstanceId({ trainId: t.trainId, action: "MERGE" }, t.droneAttempt);
      d.acc.events.push(this.commandResult(t, commandId, `merge ${r.ok ? "ok" : "failed"}: ${r.summary}`, {
        action: "MERGE",
        outcome: !r.ok ? "error" : r.conflicts.length ? "conflicts" : "ok",
        merged: r.merged.length,
        conflicts: r.conflicts.length,
        fastForward: r.fastForward,
        applied: res.outcome,
        ...(r.mergeMs !== undefined ? { ms: r.mergeMs } : {}),
      }));
      return res;
    });
  }

  /**
   * Lander pushed (or failed to push) a head to main (POST /internal/webhook/land-result).
   * The landed members go to the release planner in the same transaction.
   */
  async reportLandResult(input: LandResultInput): Promise<TrainUpdate> {
    const r = parseOrThrow(LandResultSchema, input, "land result");
    return this.trainTransition(r.trainId, (d, t) => {
      const res = d.acc.train(d.tp.landResult(r));
      const commandId = droneInstanceId({ trainId: t.trainId, action: "LAND" }, t.droneAttempt);
      d.acc.events.push(this.commandResult(t, commandId, `land ${r.landed ? "ok" : "failed"}`, { action: "LAND", outcome: r.landed ? "ok" : "error", applied: res.outcome }));
      return res;
    });
  }

  /** Provisioner outcome for a FORK or DELETE command (POST /internal/webhook/provision-result). */
  async reportProvisionResult(input: ProvisionResult): Promise<TrainUpdate> {
    const r = parseOrThrow(ProvisionResultSchema, input, "provision result");
    // v17: a repo DELETE keyed by an attempt (`att_…`) or a race base (`base-<itemId>`) has no train: acknowledge it.
    if (r.op === "DELETE" && (r.trainId.startsWith("att_") || r.trainId.startsWith("base-")) && !this.trainExists(r.trainId)) {
      const hive = this.hiveNamespace();
      if (hive !== null) {
        const base = r.trainId.startsWith("base-");
        const { acc } = this.decide(hive, (d) => {
          // The row of this command (a stale id finds none): DELETED, or FAILED (the attempt watchdog retries it).
          const row = repoDeletesOfKey(this.sql, r.trainId).find((x) => x.commandId === r.commandId);
          if (row && (row.state === "PENDING" || (row.state === "FAILED" && r.ok))) d.acc.repoDeletes.set(row.repo, { ...row, state: r.ok ? "DELETED" : "FAILED" });
          d.acc.events.push(
            this.attemptEvent(base ? "attempt.base" : "attempt.state", base ? r.trainId.slice(5) : null, base ? null : r.trainId, `repo delete ${r.ok ? "done" : "failed"} (${r.commandId})`, {
              outcome: r.ok ? "deleted" : "delete-failed",
              commandId: r.commandId,
            }, "provisioner", r.ok ? "info" : "warn"),
          );
        });
        await this.commit(hive, acc);
      }
      return { outcome: "applied", train: null };
    }
    return this.trainTransition(r.trainId, (d, t) => {
      const res = d.acc.train(d.tp.provisionResult(r));
      d.acc.events.push(this.commandResult(t, r.commandId, `${r.op} ${r.ok ? "ok" : "failed"}`, { action: r.op, outcome: r.ok ? "ok" : "error", applied: res.outcome }, "provisioner"));
      return res;
    });
  }

  /**
   * Herald outcome (POST /internal/webhook/deploy-result). Idempotent by commandId.
   * Preview DEPLOY / TEARDOWN → the train; staging / canary DEPLOY and ROLLBACK → the release.
   */
  async reportDeployResult(input: DeployResult): Promise<TrainUpdate | ReleaseUpdate> {
    const r = parseOrThrow(DeployResultSchema, input, "deploy result");
    if (r.environment !== "preview") {
      const releaseId = r.releaseId ?? this.releaseIdForCommand(r.commandId);
      if (!releaseId) throw new QueenError("NOT_FOUND", `no release for command ${r.commandId}`);
      return this.releaseTransition(releaseId, (d, rel) => {
        const res = d.acc.release(d.rp.deployResult({ ...r, releaseId }));
        d.acc.events.push(this.releaseEvent(rel, "command.result", r.commandId, `${r.op} ${r.environment} ${r.ok ? "ok" : "failed"}`, { action: r.op, environment: r.environment, outcome: r.ok ? "ok" : "error", applied: res.outcome }, "herald"));
        return res;
      });
    }
    const trainId = r.trainId ?? this.trainIdForCommand(r.commandId);
    if (!trainId) throw new QueenError("NOT_FOUND", `no train for command ${r.commandId}`);
    return this.trainTransition(trainId, (d, t) => {
      const res = d.acc.train(d.tp.deployResult({ ...r, trainId }));
      d.acc.events.push(this.commandResult(t, r.commandId, `${r.op} preview ${r.ok ? "ok" : "failed"}`, { action: r.op, environment: "preview", outcome: r.ok ? "ok" : "error", applied: res.outcome }, "herald"));
      return res;
    });
  }

  /** Sentinel health verdict (POST /internal/webhook/sentinel-verdict). Idempotent by commandId. */
  async reportSentinelVerdict(input: SentinelVerdict): Promise<ReleaseUpdate> {
    const v = parseOrThrow(SentinelVerdictSchema, input, "sentinel verdict");
    return this.releaseTransition(v.releaseId, (d, rel) => {
      const res = d.acc.release(d.rp.sentinelVerdict(v));
      d.acc.events.push(
        this.releaseEvent(rel, "sentinel.verdict", v.commandId, `${v.environment}: ${v.verdict}${v.inconclusive ? " (inconclusive)" : ""}: ${v.summary}`, {
          verdict: v.verdict,
          outcome: v.verdict,
          environment: v.environment,
          inconclusive: v.inconclusive ?? false,
          requests: v.metrics.requests,
          errorRate: v.metrics.errorRate,
          p99Ms: v.metrics.p99Ms,
          applied: res.outcome,
        }, "sentinel", v.verdict === "PROMOTE" ? "info" : "warn"),
      );
      return res;
    });
  }

  /** Tap to ship (POST /hives/:hive/releases/:releaseId/tap). Only valid in AWAITING_TAP (CONFLICT otherwise). */
  async tapRelease(input: { releaseId: string; user: string }): Promise<ReleaseUpdate> {
    const releaseId = typeof input?.releaseId === "string" ? input.releaseId.trim() : "";
    const user = typeof input?.user === "string" ? input.user.trim() : "";
    if (!releaseId || releaseId.length > 128) throw new QueenError("INVALID_INPUT", "releaseId is required");
    if (!user || user.length > 320) throw new QueenError("INVALID_INPUT", "user is required");
    const res = await this.releaseTransition(releaseId, (d) => d.acc.release(d.rp.tap(releaseId, user)));
    if (res.outcome === "conflict") {
      throw new QueenError("CONFLICT", `release ${releaseId} is ${res.release?.phase ?? "unknown"}; only AWAITING_TAP can be tapped`);
    }
    return res;
  }

  // ── RPC surface: escalations and settings ─────────────────────────────

  /** `POST /hives/:hive/escalations/:id/resolve` (user). Each action maps to a planner transition (§2.5). */
  async resolveEscalation(input: { hive: string; escalationId: string; user: string; action: unknown }): Promise<{ outcome: string; escalation: Escalation | null }> {
    const body = parseOrThrow(ResolveEscalationSchema, input.action, "resolution");
    const hive = this.hiveFor(input.hive);
    const existing = this.loadEscalation(input.escalationId);
    if (!existing) throw new QueenError("NOT_FOUND", `escalation ${input.escalationId} not found`);
    if (existing.status === "RESOLVED") return { outcome: "ignored:duplicate", escalation: existing };
    let res: EscalationPlanResult | null = null;
    const { acc } = this.decide(
      hive,
      (d) => {
        d.acc.esc(res!);
        for (const intent of res!.effects) this.applyIntent(d, intent, body.note);
      },
      {
        items: existing.subject.type === "item" ? [existing.subject.id] : [],
        releases: existing.subject.type === "release" ? [existing.subject.id] : [],
        pre: (settings, { ep, state, hs }) => {
          const subject = existing.subject;
          const rel = subject.type === "release" ? (state.releases.find((r) => r.releaseId === subject.id) ?? this.loadRelease(subject.id)) : null;
          const item = subject.type === "item" ? (state.items.find((i) => i.itemId === subject.id) ?? this.loadItem(subject.id)) : null;
          res = ep.resolve(input.escalationId, body.action, input.user, body.note, {
            ...(rel ? { releasePhase: rel.phase } : {}),
            ...(item ? { itemStatus: item.status } : {}),
            budget: hs.budget,
          });
          let s = settings;
          for (const intent of res.effects) {
            if (intent.type === "queue.resume") s = { ...s, carInfraFailures: 0 };
            else if (intent.type === "autonomy.resume") s = { ...s, rollbackStreak: 0, degradedBy: [] };
            else if (intent.type === "budget.raise") {
              s = { ...s, budgetBoost: { day: utcDay(this.now()), dailyCredits: intent.dailyCredits, dailyDispatches: intent.dailyDispatches } };
            }
          }
          return s;
        },
      },
    );
    await this.commit(hive, acc);
    const outcome = res!.outcome;
    if (outcome === "conflict") throw new QueenError("CONFLICT", `escalation ${input.escalationId} (${existing.reason}) cannot take "${body.action}" now`);
    if (outcome === "ignored:unknown") throw new QueenError("NOT_FOUND", `escalation ${input.escalationId} not found`);
    return { outcome, escalation: this.loadEscalation(input.escalationId) };
  }

  private applyIntent(d: Decision, intent: EscalationIntent, note?: string): void {
    switch (intent.type) {
      case "release.tap":
        d.acc.release(d.rp.tap(intent.releaseId, intent.user));
        return;
      case "release.retry":
        d.acc.release(d.rp.retry(intent.releaseId, intent.user));
        return;
      case "work.retry":
        d.acc.work(d.wp.retry(intent.itemId, `user:${intent.user}`, note));
        return;
      case "work.cancel":
        d.acc.work(d.wp.cancel(intent.itemId, `user:${intent.user}`, note));
        return;
      case "queue.resume":
        // Car formation resumes (paused was derived from the now-resolved EXECUTOR_LOST).
        d.acc.train(d.tp.reconcile());
        return;
      case "autonomy.resume":
      case "budget.raise":
        // Settings changed in `pre`; a release parked by supervision may now ship.
        d.acc.release(d.rp.reconcile());
        return;
    }
  }

  /** `PATCH /hives/:hive/settings` (user): autonomy, guardrails, budget, race widths. Event `hive.settings`. */
  async updateSettings(input: { hive: string; user: string; patch: UpdateHiveSettings }): Promise<HiveStatus> {
    const patch = parseOrThrow(UpdateHiveSettingsSchema, input.patch, "settings");
    const hive = this.hiveFor(input.hive);
    let changedAutonomy = false;
    const { acc } = this.decide(
      hive,
      (d) => {
        d.acc.events.push({
          type: "hive.settings",
          actor: `user:${input.user}`,
          summary: clip(`settings changed by ${input.user}: ${JSON.stringify(patch)}`, 500),
          data: { ...patch },
        });
        if (changedAutonomy) d.acc.release(d.rp.reconcile());
      },
      {
        pre: (s) => {
          const o = s.overrides;
          changedAutonomy = patch.autonomy !== undefined && patch.autonomy !== s.autonomy;
          return {
            ...s,
            autonomy: patch.autonomy ?? s.autonomy,
            overrides: {
              ...o,
              ...(patch.guardrails ? { guardrails: { ...(o.guardrails ?? {}), ...patch.guardrails } } : {}),
              ...(patch.budget ? { budget: { ...(o.budget ?? {}), ...patch.budget } } : {}),
              ...(patch.race ? { race: { ...(o.race ?? {}), ...patch.race } } : {}),
              ...(patch.executors ? { executors: patch.executors } : {}),
            },
            updatedBy: `user:${input.user}`,
            updatedAt: this.now(),
          };
        },
      },
    );
    await this.commit(hive, acc);
    return this.hiveStatus()!;
  }

  // ── RPC surface: ledger, scribe ───────────────────────────────────────

  /** Validate one audit input and resolve its hive; no writes. */
  private prepareAudit(input: AppendAuditInput): { event: AuditEvent; hive: string } {
    const a = parseOrThrow(AppendAuditSchema, input, "audit event");
    const notes = a.gitNotesPayload === null ? null : JSON.stringify(a.gitNotesPayload);
    if (notes !== null && new TextEncoder().encode(notes).byteLength > MAX_GIT_NOTES_BYTES) {
      throw new QueenError("INVALID_INPUT", `gitNotesPayload exceeds ${MAX_GIT_NOTES_BYTES} bytes; send a Scribe compaction`);
    }
    const prompt = this.loadPrompt(a.promptId);
    const hive = prompt?.namespace ?? (this.loadItem(a.promptId) ? this.hiveNamespace() : null);
    if (!hive) throw new QueenError("NOT_FOUND", `prompt ${a.promptId} not found`);
    const event: AuditEvent = {
      eventId: crypto.randomUUID(),
      promptId: a.promptId,
      droneRole: a.droneRole,
      status: a.status,
      gitNotesPayload: a.gitNotesPayload,
      createdAt: Date.now(),
      ...(a.trainId ? { trainId: a.trainId } : {}),
      ...(a.commitSha ? { commitSha: a.commitSha } : {}),
    };
    return { event, hive };
  }

  /** Cognitive Ledger entry from a drone. */
  async appendAudit(input: AppendAuditInput): Promise<AuditEvent> {
    return (await this.appendAudits([input]))[0]!;
  }

  /**
   * Several Cognitive Ledger entries in one RPC: all validated first (one bad entry rejects the
   * batch with nothing written), then written in order in one transaction and broadcast together.
   */
  async appendAudits(inputs: AppendAuditInput[]): Promise<AuditEvent[]> {
    const list = parseOrThrow(AppendAuditsSchema, inputs, "audit events");
    const prepared = list.map((i) => this.prepareAudit(i));
    // event_log (drone.audit) is the source of truth since v10; audit_trail is still written for a v1 rollback.
    this.ctx.storage.transactionSync(() => {
      for (const { event, hive } of prepared) appendAuditRow(this.sql, event, hive);
    });
    const events = prepared.map((p) => p.event);
    this.coalescer.push(events.map((event) => ({ type: "audit.appended" as const, event })));
    this.coalescer.endApply();
    return events;
  }

  /** Attach a Scribe compaction (<= 500 chars) to a prompt and/or train. */
  async recordScribeSummary(input: ScribeSummary): Promise<{ promptRun: PromptRun | null; train: MergeTrain | null }> {
    const s = parseOrThrow(ScribeSummarySchema, input, "scribe summary");
    if (!s.promptId && !s.trainId) throw new QueenError("INVALID_INPUT", "promptId or trainId is required");
    const prompt = s.promptId ? this.loadPrompt(s.promptId) : null;
    if (s.promptId && !prompt) throw new QueenError("NOT_FOUND", `prompt ${s.promptId} not found`);
    const train = s.trainId ? this.loadTrain(s.trainId) : null;
    if (s.trainId && !train) throw new QueenError("NOT_FOUND", `train ${s.trainId} not found`);
    this.ctx.storage.transactionSync(() => {
      if (prompt) this.sql.exec("UPDATE prompt_runs SET summary = ? WHERE prompt_id = ?", s.summary, prompt.promptId);
      if (train) this.sql.exec("UPDATE merge_trains SET summary = ? WHERE train_id = ?", s.summary, train.trainId);
    });
    const p2 = prompt ? this.loadPrompt(prompt.promptId) : null;
    const t2 = train ? this.loadTrain(train.trainId) : null;
    // Written outside decide(): keep the warm cache equal to the database.
    this.cache.apply({ ...(p2 ? { prompts: [p2] } : {}), ...(t2 ? { trains: [t2] } : {}) });
    const promptRun = p2 ? toPromptRun(p2) : null;
    const mergeTrain = t2 ? toMergeTrainV2(t2) : null;
    const msgs: QueenServerUnitMessage[] = [];
    if (promptRun) msgs.push({ type: "prompt.updated", promptRun });
    if (mergeTrain) msgs.push({ type: "train.updated", train: mergeTrain });
    this.coalescer.push(msgs);
    this.coalescer.endApply();
    return { promptRun, train: mergeTrain };
  }

  // ── RPC surface: reads ────────────────────────────────────────────────

  getSnapshot(): Snapshot {
    const desc = <T>(rows: T[]) => rows.reverse();
    const releases = this.sql
      .exec("SELECT * FROM releases ORDER BY seq DESC LIMIT ?", RELEASE_SNAPSHOT_LIMIT)
      .toArray()
      .map((r) => toRelease(rowToRelease(r)));
    const items = desc(
      this.sql
        .exec(
          `SELECT * FROM work_items WHERE status NOT IN (${TERMINAL_ITEMS_SQL})
           UNION SELECT * FROM (SELECT * FROM work_items WHERE status IN (${TERMINAL_ITEMS_SQL}) ORDER BY updated_at DESC LIMIT 50)
           ORDER BY seq DESC LIMIT ?`,
          SNAPSHOT_LIMIT,
        )
        .toArray()
        .map(rowToWorkItem),
    ).map(toWorkItem);
    const escalations = this.sql
      .exec(`${ESCALATION_SELECT} WHERE status = 'OPEN' OR escalation_id IN (SELECT escalation_id FROM escalations WHERE status = 'RESOLVED' ORDER BY resolved_at DESC LIMIT 20) ORDER BY created_at`)
      .toArray()
      .map(rowToEscalation);
    const races = this.sql
      .exec("SELECT * FROM races WHERE state IN ('RACING', 'PICKING', 'REWORKING') OR race_id IN (SELECT race_id FROM races ORDER BY created_at DESC LIMIT 20) ORDER BY created_at")
      .toArray()
      .map(rowToRace);
    const recentEvents = this.sql
      .exec("SELECT * FROM event_log WHERE severity != 'debug' ORDER BY seq DESC LIMIT ?", EVENTS_SNAPSHOT_LIMIT)
      .toArray()
      .map(rowToEvent)
      .reverse();
    const hive = this.hiveStatus();
    return {
      type: "snapshot",
      promptRuns: desc(this.sql.exec("SELECT * FROM prompt_runs ORDER BY seq DESC LIMIT ?", SNAPSHOT_LIMIT).toArray().map(rowToPrompt)).map(toPromptRun),
      // The newest trains, plus every candidate of a PICKING race (the Pick view needs them all, however old).
      trains: desc(
        this.sql
          .exec(
            `SELECT * FROM merge_trains WHERE seq IN (SELECT seq FROM merge_trains ORDER BY seq DESC LIMIT ?)
             OR race_id IN (SELECT race_id FROM races WHERE state = 'PICKING') ORDER BY seq DESC`,
            SNAPSHOT_LIMIT,
          )
          .toArray()
          .map(rowToTrain),
      ).map(toMergeTrainV2),
      recentAudit: listRecentAudit(this.sql, AUDIT_SNAPSHOT_LIMIT),
      deployments: this.listDeployments(),
      releases,
      verdicts: listVerdicts(this.sql, releases.map((r) => r.releaseId)),
      modelStats: listModelStats(this.sql),
      routerFloor: this.routerFloorView(),
      items,
      escalations,
      races,
      ...(hive ? { hive } : {}),
      recentEvents,
    };
  }

  /** Environment rows plus the newest per-train preview rows, oldest first. */
  listDeployments(): Deployment[] {
    return this.sql
      .exec(
        `SELECT * FROM (SELECT rowid AS rid, * FROM deployments ORDER BY (environment = 'preview'), updated_at DESC, rowid DESC LIMIT ?)
         ORDER BY updated_at, rid`,
        SNAPSHOT_LIMIT,
      )
      .toArray()
      .map(rowToDeployment);
  }

  /** `GET /hives/:hive/items/:id`: the item, its children, trains, races, release and escalations. */
  getItemDetail(itemId: string): ItemDetail {
    const item = this.loadItem(itemId);
    if (!item) throw new QueenError("NOT_FOUND", `item ${itemId} not found`);
    const children = this.sql.exec("SELECT * FROM work_items WHERE parent_id = ? ORDER BY seq", itemId).toArray().map(rowToWorkItem).map(toWorkItem);
    const trains = this.sql.exec("SELECT * FROM merge_trains WHERE prompt_id = ? AND lane = 'BUILD' ORDER BY seq", itemId).toArray().map(rowToTrain);
    const cars = [...new Set(trains.map((t) => t.carId).filter((c): c is string => !!c))];
    const carRows = cars.length
      ? this.sql.exec(`SELECT * FROM merge_trains WHERE train_id IN (${cars.map(() => "?").join(",")}) ORDER BY seq`, ...cars).toArray().map(rowToTrain)
      : [];
    const races = this.sql.exec("SELECT * FROM races WHERE item_id = ? ORDER BY created_at", itemId).toArray().map(rowToRace);
    let release: Release | null = null;
    const relRow = item.releaseId ? this.sql.exec("SELECT * FROM releases WHERE release_id = ?", item.releaseId).toArray()[0] : undefined;
    if (relRow) {
      release = toRelease(rowToRelease(relRow));
    } else {
      const merged = trains.filter((t) => t.phase === "MERGED").map((t) => t.trainId);
      if (merged.length) {
        const rows = this.sql.exec("SELECT * FROM releases ORDER BY seq DESC LIMIT 50").toArray().map(rowToRelease);
        const hit = rows.find((r) => r.trainIds.some((id) => merged.includes(id)));
        release = hit ? toRelease(hit) : null;
      }
    }
    const escalations = this.sql
      .exec(`${ESCALATION_SELECT} WHERE subject_type = 'item' AND subject_id = ? ORDER BY created_at`, itemId)
      .toArray()
      .map(rowToEscalation);
    return { item: toWorkItem(item), children, trains: [...trains, ...carRows].map(toMergeTrainV2), races, release, escalations };
  }

  /** `GET /hives/:hive/events` (newest first). */
  queryEvents(query: EventQueryInput): QueenEvent[] {
    return queryEvents(this.sql, parseOrThrow(EventQuerySchema, query, "event query"));
  }

  /** `GET /hives/:hive/traces/:traceId`: the trace's events (oldest first) plus the derived span tree. */
  getTrace(traceId: string): TraceView {
    if (!/^[0-9a-f]{32}$/.test(traceId)) throw new QueenError("INVALID_INPUT", "traceId must be 32 lowercase hex characters");
    const events = this.sql.exec("SELECT * FROM event_log WHERE trace_id = ? ORDER BY seq LIMIT 2000", traceId).toArray().map(rowToEvent);
    return buildTraceView(events, traceId);
  }

  /** `GET /hives/:hive/metrics?window=24h|7d`: hourly rollups plus HiveStatus. */
  getMetrics(window: "24h" | "7d" = "24h"): MetricsView {
    const now = this.now();
    const span = window === "7d" ? 7 * DAY_MS : DAY_MS;
    return { rollups: queryMetrics(this.sql, now - span, now + HOUR_MS), hive: this.hiveStatus(), source: "queen-rollups" };
  }

  /** `GET /hives/:hive/queue`: active cars with members, passed builds waiting to board, recent conflicts and bisects. */
  getQueue(): QueueView {
    const cars = this.sql.exec("SELECT * FROM merge_trains WHERE lane = 'QUEUE' AND phase NOT IN ('MERGED', 'EJECTED') ORDER BY seq").toArray().map(rowToTrain);
    const waiting = this.sql
      .exec("SELECT * FROM merge_trains WHERE lane = 'BUILD' AND phase = 'PASSED' AND car_id IS NULL ORDER BY passed_seq")
      .toArray()
      .map(rowToTrain);
    const recent = (type: string) => this.sql.exec("SELECT * FROM event_log WHERE type = ? ORDER BY seq DESC LIMIT 20", type).toArray().map(rowToEvent);
    return { cars: cars.map(toMergeTrainV2), waiting: waiting.map(toMergeTrainV2), conflicts: recent("queue.conflict"), bisects: recent("queue.bisect") };
  }

  /**
   * What a pushed repo is, for the gatekeepers (replaces their snapshot scan).
   * BUILD trains get the full gate; QUEUE cars the integration gate over their members.
   */
  getGateTarget(repo: string): GateTarget | null {
    const row = this.sql.exec("SELECT * FROM merge_trains WHERE artifact_repo = ? ORDER BY seq DESC LIMIT 1", repo).toArray()[0];
    if (!row) return null;
    const t = rowToTrain(row);
    const prompt = this.loadPrompt(t.promptId);
    const base: GateTarget = {
      trainId: t.trainId,
      lane: isCar(t) ? "QUEUE" : "BUILD",
      promptId: t.promptId,
      promptText: isCar(t) ? `queue car ${t.trainId}: ${(t.members ?? []).length} members` : (prompt?.promptText ?? ""),
      previewUrl: t.previewUrl,
      phase: t.phase,
      traceId: traceOfTrain(t),
      baseSha: t.baseSha || null,
      // T1: whose code (a non-drone origin makes the reviewer fail closed); absent = drone.
      ...(!isCar(t) && t.origin ? { origin: { ...t.origin } } : {}),
      // The Queen-started gate that owns this TESTING round: any other gate instance for the train stands down.
      gateId: t.phase === "TESTING" ? (t.gateCommandId ?? null) : null,
    };
    if (!isCar(t)) return base;
    const members = (t.members ?? []).flatMap((id) => {
      const m = this.loadTrain(id);
      if (!m) return [];
      const text = this.loadPrompt(m.promptId)?.promptText ?? m.promptId;
      return [
        {
          trainId: m.trainId,
          promptId: m.promptId,
          artifactRepo: m.artifactRepo,
          headSha: m.headSha ?? "0".repeat(40),
          title: text.split("\n")[0]!.slice(0, 120),
          traceId: traceOfTrain(m),
          smokePaths: smokePathsOf(m.changedPaths ?? []),
        },
      ];
    });
    return { ...base, members };
  }

  // ── alarm ─────────────────────────────────────────────────────────────

  /**
   * The reconcile alarm: train, release and ledger reconcile (watchdogs, race
   * deadlines, the merge queue, the Oracle watchdog, stale claims), then the
   * event-log prune and the lease renewal. commit() re-arms the alarm.
   */
  override async alarm(): Promise<void> {
    this.inAlarm = true;
    this.alarmRearmAt = null;
    try {
      await this.beforeReconcile();
      await this.runAlarm();
    } finally {
      this.inAlarm = false;
      this.alarmRearmAt = null;
    }
  }

  /** True while alarm() runs: the stored alarm is then the one now firing, so it is not compared against. */
  private inAlarm = false;
  /** Earliest alarm requested so far during this alarm() run. */
  private alarmRearmAt: number | null = null;

  /** Hook run inside alarm() (inAlarm set) before the reconcile; the sim runs its due executor jobs here. */
  protected async beforeReconcile(): Promise<void> {}

  private async runAlarm(): Promise<void> {
    const hive = this.hiveNamespace();
    if (hive === null) return;
    await this.maybeLease(hive, false);
    let leaseDue = false;
    // The trains of attempts the watchdog ends (a REJECTED one's is no longer active): their forks go through them.
    const attemptTrains = this.dueAttempts(this.now()).map((a) => a.trainId);
    const { acc } = this.decide(
      hive,
      (d) => {
        d.acc.train(d.tp.reconcile());
        d.acc.release(d.rp.reconcile());
        leaseDue = d.acc.work(d.wp.reconcile()).leaseDue ?? false;
        this.attemptWatchdog(d);
      },
      { trains: attemptTrains },
    );
    await this.commit(hive, acc);
    try {
      this.ctx.storage.transactionSync(() => {
        pruneEvents(this.sql, this.now());
        pruneSubmissions(this.sql, this.now() - SUBMISSION_RETENTION_MS);
      });
    } catch (e) {
      console.error("queen: event prune failed", e);
    }
    if (leaseDue) await this.maybeLease(hive, false);
  }

  // ── WebSocket (hibernation API) ───────────────────────────────────────

  override fetch(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return new Response("Too many connections", { status: 503 });
    }
    const hive = request.headers.get(HIVE_HEADER) ?? DEFAULT_HIVE;
    const role = new URL(request.url).searchParams.get("role") === "drone" ? "drone" : "dashboard";
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [`role:${role}`, `hive:${hive}`]);
    const attachment: SocketAttachment = { id: crypto.randomUUID(), role, hive, subscribed: true, connectedAt: Date.now() };
    server.serializeAttachment(attachment);
    this.send(server, this.getSnapshot());
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const size = typeof message === "string" ? message.length : message.byteLength;
    if (size > MAX_FRAME_BYTES) {
      try {
        ws.close(1009, "message too big");
      } catch {
        /* already closing */
      }
      return;
    }
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (text === "ping") {
      // Normally answered by the auto-response without waking us.
      this.sendRaw(ws, "pong");
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.send(ws, { type: "error", code: "INVALID_INPUT", message: "invalid JSON" });
      return;
    }
    const parsed = QueenClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      const err = QueenError.invalid("message", parsed.error.issues);
      this.send(ws, { type: "error", code: err.code, message: err.detail });
      return;
    }
    const att = this.attachment(ws);
    const msg = parsed.data;
    switch (msg.type) {
      case "ping":
        this.send(ws, { type: "pong" });
        return;
      case "subscribe": {
        if (msg.namespace !== undefined && att && msg.namespace !== att.hive) {
          this.send(ws, { type: "error", code: "CONFLICT", message: `this socket is attached to hive "${att.hive}"` });
          return;
        }
        if (att) ws.serializeAttachment({ ...att, subscribed: true } satisfies SocketAttachment);
        this.send(ws, this.getSnapshot());
        return;
      }
      case "submit_prompt": {
        if (att && msg.prompt.namespace !== att.hive) {
          this.send(ws, { type: "error", code: "CONFLICT", message: `this socket is attached to hive "${att.hive}"` });
          return;
        }
        try {
          await this.submitWork(msg.prompt);
        } catch (e) {
          const q = asQueenError(e);
          if (!q) console.error("submit_prompt failed", e);
          this.send(ws, { type: "error", code: q?.code ?? "INTERNAL", message: q?.detail ?? "internal error" });
        }
        return;
      }
    }
  }

  override webSocketClose(): void {
    // Compat >= 2026-04-07 auto-replies to the close frame; echoing it back
    // (the old 1005 bug) is neither needed nor safe. Attachments die with the socket.
  }

  override webSocketError(ws: WebSocket, error: unknown): void {
    console.error("websocket error", error);
    try {
      ws.close(1011, "websocket error");
    } catch {
      /* socket already closed */
    }
  }

  // ── the decision pipeline ─────────────────────────────────────────────

  /** The warm active state (StateCache), loading it and the extras on a cold start. */
  private activeState(): ActiveState {
    const warm = this.cache.get();
    if (warm && this.extrasWarm) return warm;
    const state = warm ?? this.cache.load(this.sql);
    this.cleanup = new Map(
      this.sql
        .exec(
          `SELECT * FROM merge_trains WHERE phase IN ('MERGED', 'EJECTED')
           AND (fork_state = 'DELETING' OR deploy_state = 'TEARING_DOWN' OR (fork_state = 'READY' AND (origin_json IS NOT NULL OR (race_outcome = 'LOST' AND lane = 'BUILD'))))`,
        )
        .toArray()
        .map((r) => {
          const t = rowToTrain(r);
          return [t.trainId, t] as const;
        }),
    );
    this.maxPassedSeq = Number(this.sql.exec("SELECT COALESCE(MAX(passed_seq), 0) AS m FROM merge_trains").one().m);
    this.extrasWarm = true;
    return state;
  }

  private invalidate(): void {
    this.cache.invalidate();
    this.extrasWarm = false;
  }

  /** The settings row a decide() starts from (a new hive gets the defaults + HIVE_DEFAULT_GUARDRAILS). */
  private baseSettings(hive: string, state: ActiveState, now: number): HiveSettingsRecord {
    let s = state.settings;
    if (!s) {
      const g = defaultGuardrailOverrides(this.env);
      s = { ...defaultSettingsRecord(hive, now), ...(Object.keys(g).length ? { overrides: { guardrails: g } } : {}) };
    }
    s = rollBudgetDay(s, now);
    if (this.pendingLease) s = { ...s, ...this.pendingLease };
    return s;
  }

  /** Lease slots in force (null: no live lease, so no global cap). */
  private leasedSlots(s: HiveSettingsRecord, now: number): number | null {
    if (!this.env.SWARM_GOVERNOR || this.env.SWARM_LEASE === "off") return null;
    return s.leaseExpiresAt !== null && s.leaseExpiresAt > now ? s.leasedSlots : null;
  }

  /** Releases that count for the SLO window, overlaid with this decision's changes. */
  private autonomy(settings: HiveSettingsRecord, hs: HiveSettings, open: readonly Escalation[], extra: Iterable<ReleaseRecord> = [], streak?: number): { eff: EffectiveAutonomy; slo: SloStatus } {
    const rows = new Map(
      this.sql
        .exec("SELECT * FROM releases WHERE phase IN ('SHIPPED', 'ROLLED_BACK', 'FAILED') ORDER BY updated_at DESC LIMIT ?", hs.slo.window + 5)
        .toArray()
        .map((r) => {
          const rel = rowToRelease(r);
          return [rel.releaseId, rel] as const;
        }),
    );
    for (const r of extra) rows.set(r.releaseId, r);
    const slo = errorBudget(changeSuccessFromReleases([...rows.values()], hs.slo));
    const resumed = this.sql
      .exec(`${ESCALATION_SELECT} WHERE status = 'RESOLVED' AND reason IN ('ROLLBACK_STREAK', 'ERROR_BUDGET_EXHAUSTED') ORDER BY resolved_at DESC LIMIT 5`)
      .toArray()
      .map(rowToEscalation);
    const eff = effectiveAutonomy({ configured: settings.autonomy, slo, rollbackStreak: streak ?? settings.rollbackStreak, escalations: [...open, ...resumed] });
    return { eff, slo };
  }

  /**
   * One decision (§3.1). Synchronous from load to plan, so concurrent RPCs
   * never interleave mid-plan; the caller then awaits commit().
   */
  private decide<T>(hive: string, run: (d: Decision) => T, opts: DecideOptions = {}): { value: T; acc: Acc } {
    const now = this.now();
    let state = this.activeState();
    state = this.withExtras(state, opts);
    const acc = new Acc();

    let settings = this.baseSettings(hive, state, now);
    const ep = new EscalationPlanner(state.escalations, { hive, now });
    if (opts.pre) settings = opts.pre(settings, { ep, state, hs: effectiveSettings(settings, now) });
    const hs = effectiveSettings(settings, now);
    const external = hs.executors === "external";
    const open = ep.all().filter((e) => e.status === "OPEN");
    const { eff } = this.autonomy(settings, hs, open);
    const g = hs.guardrails;
    const leased = this.leasedSlots(settings, now);
    const activeBuilds = state.trains.filter((t) => isActive(t) && !isCar(t)).length;
    const slots = Math.min(g.maxActiveTrains, leased ?? Number.MAX_SAFE_INTEGER);
    const remainingCredits = Math.max(0, hs.budget.dailyCredits - settings.creditsUsed);
    const pin = modelPin(this.env);
    const queuePaused = open.some((e) => e.reason === "EXECUTOR_LOST" && e.subject.type === "hive");

    const trainsAtStart = new Map(state.trains.map((t) => [t.trainId, t]));
    const hiveState: HiveState = {
      prompts: state.prompts,
      trains: state.trains,
      deployments: this.previewDeployments(state.trains.filter((t) => opts.trains?.includes(t.trainId))),
      maxTrainSeq: state.maxTrainSeq,
      maxPromptSeq: state.maxPromptSeq,
      modelStats: listRouterStats(this.sql),
      routerDispatches: loadRouter(this.sql).dispatches,
      routerFloor: loadRouter(this.sql).floor,
      races: state.races,
      items: state.items.map(plannerItem),
      maxPassedSeq: this.maxPassedSeq,
      slots: this.attemptSlots(),
    };
    const tp = new TrainPlanner(hiveState, {
      namespace: hive,
      now,
      newId: () => crypto.randomUUID(),
      commandTimeoutMs: commandTimeoutMs(this.env),
      modelPin: pin,
      routerPolicy: routerPolicy(this.env),
      maxConflictReworks: g.maxConflictReworks,
      race: { reworkWidth: hs.race.reworkWidth, hardWidth: hs.race.hardWidth, maxRaceWidth: g.maxRaceWidth, slotsFree: Math.max(0, slots - activeBuilds), remainingCredits },
      queue: {
        settings: { maxQueueBatch: g.maxQueueBatch, maxQueueDepth: g.maxQueueDepth },
        carInfraFailures: settings.carInfraFailures,
        paused: queuePaused,
      },
      briefFor: (sha) => this.verdictNote(sha),
      pick: { judge: hs.race.judge ?? "auto", pickWindowMs: hs.race.pickWindowMs, maxPickingRaces: g.maxPickingRaces },
      external: hs.executors === "external",
      entryWindowMs: hs.executors === "external" ? (hs.race.entryWindowMs ?? ENTRY_WINDOW_DEFAULT_MS) : 0,
      // Rework loop (rework-loop spec §5.5): external hives only; swarm hives keep today's rejections.
      ...(external ? { rework: { windowMs: g.reworkWindowMs, holdMs: g.reworkHoldMs, maxPerAttempt: g.maxReworksPerAttempt, maxRaceReopens: g.maxRaceReopens } } : {}),
    });
    const releaseIds = state.releases.map((r) => r.releaseId);
    const releaseEscalations = releaseIds.length
      ? this.sql
          .exec(`${ESCALATION_SELECT} WHERE subject_type = 'release' AND subject_id IN (${releaseIds.map(() => "?").join(",")})`, ...releaseIds)
          .toArray()
          .map(rowToEscalation)
      : [];
    const epRows = new Map(ep.all().map((e) => [e.escalationId, e]));
    const rpEscalations = [...open, ...releaseEscalations.filter((e) => !epRows.has(e.escalationId))];
    const rp = new ReleasePlanner(
      {
        releases: state.releases,
        deployments: this.sql.exec("SELECT * FROM deployments WHERE environment != 'preview'").toArray().map(rowToDeployment),
        maxSeq: Math.max(0, ...state.releases.map((r) => r.seq)),
      },
      {
        namespace: hive,
        now,
        newId: () => crypto.randomUUID(),
        commandTimeoutMs: commandTimeoutMs(this.env),
        sentinel: sentinelSettings(this.env),
        autoShip: eff.autoShip,
        paused: eff.paused,
        rollbackStreak: settings.rollbackStreak,
        escalations: rpEscalations,
      },
    );
    // T1: items whose pushed code is parked dispatch at width 1 (the push is the build: no drone races it).
    let parkedItems = new Set<string>();
    const wp = new WorkPlanner(
      { items: state.items, claims: state.claims, escalations: open, settings, maxSeq: state.maxItemSeq },
      {
        hive,
        now,
        newId: () => crypto.randomUUID(),
        autonomy: eff.level,
        commandTimeoutMs: commandTimeoutMs(this.env),
        itemOfTrain: (trainId) => this.itemOfTrain(trainId),
        widthOf: (item, slotsFree, s) =>
          parkedItems.has(item.itemId) ? 1 : raceWidth({
            action: "BUILD",
            bestOf: item.bestOf,
            difficulty: item.difficulty,
            modelPin: pin,
            race: s.race,
            maxRaceWidth: s.guardrails.maxRaceWidth,
            slotsFree,
            remainingCredits,
          }),
      },
    );
    acc.onLanded = (l) => acc.release(rp.landed({ trainIds: l.trainIds, headSha: l.sha }));
    // The settings row WorkPlanner may rewrite starts from `settings` (pre-applied).
    acc.settings = settings;
    const d: Decision = { hive, now, tp, rp, wp, ep, hs, eff, state, trainsAtStart, acc };
    const value = run(d);

    if (!opts.bookkeeping) {
      // wp.absorb: prompt → item status, claims, releases, follow-ups, credits.
      const prompts = [...acc.prompts.values()].map((p) => ({
        promptId: p.promptId,
        status: p.status,
        summary: p.summary,
        attempts: p.attempts,
        ...(acc.itemConflicts.has(p.promptId) ? { conflicts: acc.itemConflicts.get(p.promptId)! } : {}),
        ...(acc.infraFailed.has(p.promptId) ? { infra: true } : {}),
        ...(acc.awaiting.has(p.promptId) ? { awaiting: true } : {}),
        ...(acc.reworkWaits.has(p.promptId) ? { reworkWait: acc.reworkWaits.get(p.promptId)! } : {}),
      }));
      acc.work(
        wp.absorb({
          prompts,
          trains: [...acc.trains.values()],
          releases: [...acc.releases.values()].map((r) => ({ ...r, itemIds: r.trainIds.map((id) => this.itemOfTrain(id, acc)).filter((x): x is string => !!x) })),
          followUps: acc.followUps,
          memberFailures: acc.conflictClaims.map((c) => ({ trainId: "", itemId: c.itemId, cause: "integration" as const, claimPaths: c.paths })),
          credits: acc.credits,
        }),
      );
      acc.esc(
        ep.resolveStale({
          releases: [...acc.releases.values()].map((r) => ({ releaseId: r.releaseId, phase: r.phase })),
          items: [...acc.items.values()].map((i) => ({ itemId: i.itemId, status: i.status })),
        }),
      );
      if (acc.executorLost) {
        acc.esc(
          ep.open({
            reason: "EXECUTOR_LOST",
            subject: { type: "hive", id: hive },
            summary: `${acc.carInfraFailures ?? 3} merge-queue cars in a row failed on infrastructure (MERGE / LANDER drone or preview deploy). Car formation is paused until you retry.`,
          }),
        );
      }
      // Dispatch READY items: one prompt run per item, all forked from main.
      const merged = new Map(trainsAtStart);
      for (const t of acc.trains.values()) merged.set(t.trainId, t);
      // External hive: a parked push is the build the item waits to dispatch; it must not eat the capacity it needs.
      const building = [...merged.values()].filter((t) => isActive(t) && !isCar(t) && !(external && isParked(t))).length;
      // A pending push intent holds its targeted item READY; parked pushes resume at width 1.
      const held = new Set([...merged.values()].filter(awaitingPush).map((t) => t.promptId));
      parkedItems = new Set([...merged.values()].filter(isParked).map((t) => t.promptId));
      const dispatch = acc.work(wp.dispatchReady({ activeBuilds: building, leasedSlots: leased, held, parked: parkedItems }));
      for (const s of dispatch.dispatches) {
        const item = acc.items.get(s.itemId) ?? state.items.find((i) => i.itemId === s.itemId);
        acc.train(
          tp.submit({
            promptId: s.itemId,
            promptText: s.promptText,
            raceWidth: s.width,
            difficulty: s.difficulty,
            ...(item ? { item: plannerItem(item), attempts: item.attempts } : { item: { itemId: s.itemId, traceId: s.traceId, priority: s.priority, bestOf: s.bestOf } }),
          }),
        );
      }
      // Autonomy: the rollback streak and SLO after this decision.
      const openNow = new Map(open.map((e) => [e.escalationId, e]));
      for (const e of acc.escalations.values()) {
        if (e.status === "OPEN") openNow.set(e.escalationId, e);
        else openNow.delete(e.escalationId);
      }
      const base = acc.settings ?? settings;
      const after = this.autonomy(base, hs, [...openNow.values()], acc.releases.values(), acc.rollbackStreak ?? base.rollbackStreak);
      const tr = autonomyTransition(base.degradedBy, after.eff, { hive, now, slo: after.slo, escalations: [...openNow.values()] });
      acc.events.push(...tr.events);
      for (const e of tr.escalations) acc.escalations.set(e.escalationId, e);
      acc.settings = { ...base, degradedBy: tr.degradedBy };
    }
    this.syncAttempts(d);
    this.releaseBases(d);
    // Final settings row: the planners' counters plus streak, queue and lease.
    const s = acc.settings ?? settings;
    acc.settings = {
      ...s,
      ...(acc.rollbackStreak !== undefined ? { rollbackStreak: acc.rollbackStreak } : {}),
      ...(acc.carInfraFailures !== undefined ? { carInfraFailures: acc.carInfraFailures } : {}),
    };
    if (state.settings && sameSettings(state.settings, acc.settings)) acc.settings = null;
    return { value, acc };
  }

  /** Named trains / items / releases the cache does not hold, plus every candidate of a RACING race and goal children. */
  private withExtras(state: ActiveState, opts: DecideOptions): ActiveState {
    const trains = new Map(state.trains.map((t) => [t.trainId, t]));
    let changed = false;
    const addTrains = (rows: TrainRecord[]) => {
      for (const t of rows) {
        if (!trains.has(t.trainId)) {
          trains.set(t.trainId, t);
          changed = true;
        }
      }
    };
    addTrains([...this.cleanup.values()]);
    const missing = (opts.trains ?? []).filter((id) => !trains.has(id));
    if (missing.length) addTrains(this.loadTrains(missing));
    let races = state.races;
    const wantRaces = (opts.races ?? []).filter((id) => !races.some((r) => r.raceId === id));
    if (wantRaces.length) {
      const extra = this.sql
        .exec(`SELECT * FROM races WHERE race_id IN (${wantRaces.map(() => "?").join(",")})`, ...wantRaces)
        .toArray()
        .map(rowToRace);
      if (extra.length) {
        races = [...races, ...extra];
        changed = true;
      }
    }
    // Rework loop (R13): a DECIDED race whose winner (an attempt's train) is still active, so a car conflict can move it to REWORKING.
    const wonRaceIds = [...new Set([...trains.values()].filter((t) => t.attemptId && t.raceOutcome === "WON" && isActive(t) && t.raceId).map((t) => t.raceId!))].filter((id) => !races.some((r) => r.raceId === id));
    if (wonRaceIds.length) {
      const extra = this.sql.exec(`SELECT * FROM races WHERE race_id IN (${wonRaceIds.map(() => "?").join(",")})`, ...wonRaceIds).toArray().map(rowToRace);
      if (extra.length) {
        races = [...races, ...extra];
        changed = true;
      }
    }
    // Every candidate of a loaded race, EJECTED ones included (a REWORK candidate is EJECTED and must be seen).
    let prompts = state.prompts;
    if (races.length) {
      const ids = races.flatMap((r) => r.trainIds).filter((id) => !trains.has(id));
      if (ids.length) addTrains(this.loadTrains(ids));
      // Rework loop: a race held only by REWORK candidates (or a REWORKING race) has no active train, so the warm state
      // lacks its item's prompt; a slot expiry or fallback then must still fail the prompt (the item awaits a contributor).
      const have = new Set(prompts.map((p) => p.promptId));
      const want = [...new Set(races.filter((r) => r.state === "RACING" || r.state === "REWORKING").map((r) => r.itemId))].filter((id) => !have.has(id));
      const extra = want.map((id) => this.loadPrompt(id)).filter((p): p is PromptRecord => !!p);
      if (extra.length) {
        prompts = [...prompts, ...extra];
        changed = true;
      }
    }
    const items = new Map(state.items.map((i) => [i.itemId, i]));
    const wantItems = new Set<string>(opts.items ?? []);
    for (const i of state.items) {
      for (const dep of i.dependsOn) wantItems.add(dep);
      if (i.duplicateOf) wantItems.add(i.duplicateOf);
      if (i.parentId) wantItems.add(i.parentId);
    }
    const goals = state.items.filter((i) => i.kind === "goal").map((i) => i.itemId);
    const extraItems: WorkItemRecord[] = [];
    const need = [...wantItems].filter((id) => !items.has(id));
    if (need.length) extraItems.push(...this.loadItems(need));
    if (goals.length) {
      extraItems.push(
        ...this.sql
          .exec(`SELECT * FROM work_items WHERE status IN (${TERMINAL_ITEMS_SQL}) AND parent_id IN (${goals.map(() => "?").join(",")})`, ...goals)
          .toArray()
          .map(rowToWorkItem),
      );
    }
    for (const i of extraItems) {
      if (!items.has(i.itemId)) {
        items.set(i.itemId, i);
        changed = true;
      }
    }
    const releases = new Map(state.releases.map((r) => [r.releaseId, r]));
    for (const id of opts.releases ?? []) {
      if (!releases.has(id)) {
        const r = this.loadRelease(id);
        if (r) {
          releases.set(id, r);
          changed = true;
        }
      }
    }
    if (!changed) return state;
    const bySeq = <X extends { seq: number }>(a: X, b: X) => a.seq - b.seq;
    return { ...state, trains: [...trains.values()].sort(bySeq), items: [...items.values()].sort(bySeq), releases: [...releases.values()].sort(bySeq), races, prompts: [...prompts].sort(bySeq) };
  }

  /**
   * Persist one decision (one transaction: rows, events, metric rollups), then
   * update the cache, broadcast (coalesced), write AE points, and dispatch.
   */
  private async commit(hive: string, acc: Acc): Promise<void> {
    const now = this.now();
    const drafts = [...acc.events, ...this.issuedEvents(acc)];
    const trains = [...acc.trains.values()];
    const verdicts = acc.effects.flatMap((e) => (e.type === "broadcast" && e.message.type === "sentinel.verdict" ? [e.message.verdict] : []));
    const statsChanged = acc.modelStats.length > 0 || acc.routerFloor !== undefined || acc.picks.length > 0;
    const router = acc.routerDispatches !== undefined || acc.routerFloor !== undefined;
    const claims = [...acc.claims.values()];
    const releasedClaims = (this.cache.get()?.claims ?? []).filter((c) => acc.released.has(c.itemId));
    let events: QueenEvent[] = [];
    const activeBuilds = (() => {
      const m = new Map((this.cache.get()?.trains ?? []).map((t) => [t.trainId, t]));
      for (const t of trains) m.set(t.trainId, t);
      return [...m.values()].filter((t) => isActive(t) && !isCar(t)).length;
    })();
    try {
      this.ctx.storage.transactionSync(() => {
        if (acc.settings) upsertHiveSettings(this.sql, acc.settings);
        for (const p of acc.prompts.values()) {
          upsertPrompt(this.sql, p);
          // A pushed submission's prompt text is only known at gitPushed (the upsert keeps the original text).
          this.sql.exec("UPDATE prompt_runs SET prompt_text = ? WHERE prompt_id = ? AND prompt_text != ?", p.promptText, p.promptId, p.promptText);
        }
        for (const t of trains) upsertTrain(this.sql, t);
        for (const d of acc.deployments.values()) upsertDeployment(this.sql, d);
        for (const r of acc.releases.values()) upsertRelease(this.sql, r);
        for (const r of acc.races.values()) upsertRace(this.sql, r);
        for (const i of acc.items.values()) upsertWorkItem(this.sql, i);
        for (const b of acc.itemBases.values()) setItemBase(this.sql, b);
        for (const r of acc.repoDeletes.values()) upsertRepoDelete(this.sql, r);
        for (const id of acc.released) deleteClaims(this.sql, id);
        for (const c of claims) upsertClaim(this.sql, c);
        for (const e of acc.escalations.values()) upsertEscalation(this.sql, e);
        for (const v of verdicts) upsertVerdict(this.sql, v, now);
        for (const d of acc.modelStats) applyModelStatDelta(this.sql, d, now);
        for (const d of acc.picks) applyPickDelta(this.sql, d, now);
        if (router) saveRouter(this.sql, { dispatches: acc.routerDispatches, floor: acc.routerFloor });
        for (const [itemId, n] of acc.itemConflicts) {
          if (!acc.items.has(itemId)) this.sql.exec("UPDATE work_items SET conflicts = ? WHERE item_id = ?", n, itemId);
        }
        for (const sub of acc.submissions) insertSubmission(this.sql, sub);
        for (const u of acc.submissionUpdates) updateSubmission(this.sql, u.key, u.patch);
        for (const a of acc.attempts.values()) upsertAttempt(this.sql, a);
        for (const trainId of acc.abortedIntents) {
          this.sql.exec("UPDATE submissions SET outcome = 'aborted:transient' WHERE train_id = ? AND outcome = 'pending'", trainId);
        }
        events = appendEvents(this.sql, drafts, { hive, ts: now });
        recordMetrics(this.sql, events, { now, activeBuilds });
      });
    } catch (e) {
      // The cache may no longer equal the database: reload on the next decide().
      this.invalidate();
      throw e;
    }
    if (acc.settings) this.pendingLease = null;
    this.cache.apply({
      trains,
      prompts: [...acc.prompts.values()],
      items: [...acc.items.values()],
      claimsAdded: claims,
      claimsReleased: releasedClaims,
      races: [...acc.races.values()],
      releases: [...acc.releases.values()],
      escalations: [...acc.escalations.values()],
      ...(acc.settings ? { settings: acc.settings } : {}),
    });
    for (const t of trains) {
      if (!isActive(t) && (t.forkState === "DELETING" || t.deployState === "TEARING_DOWN" || keptFork(t) || keptLoser(t))) this.cleanup.set(t.trainId, t);
      else this.cleanup.delete(t.trainId);
      if (t.passedSeq) this.maxPassedSeq = Math.max(this.maxPassedSeq, t.passedSeq);
    }

    // Broadcast (coalesced): planner messages (trains as v2), escalations, events, models, hive.
    const msgs: QueenServerUnitMessage[] = [];
    for (const e of acc.effects) {
      if (e.type !== "broadcast" || e.message.type === "batch") continue;
      const m = e.message;
      if (m.type === "train.updated") {
        const t = acc.trains.get(m.train.trainId);
        msgs.push(t ? { type: "train.updated", train: toMergeTrainV2(t) } : m);
      } else {
        msgs.push(m);
      }
    }
    for (const e of acc.escalations.values()) msgs.push({ type: "escalation.updated", escalation: e });
    for (const e of events) if (e.severity !== "debug") msgs.push({ type: "event.appended", event: e });
    if (statsChanged) msgs.push({ type: "models.updated", stats: listModelStats(this.sql), floor: this.routerFloorView() });
    const status = this.hiveStatus();
    if (status) msgs.push({ type: "hive.updated", hive: status });
    this.coalescer.push(msgs);
    this.coalescer.endApply();

    // Telemetry after commit: never awaited, never fatal (D1).
    try {
      this.sink.beginInvocation();
      this.sink.writeEvents(events, this.env.QUEEN_ENVIRONMENT ?? "production");
      logEvents(events);
    } catch {
      /* telemetry must never break a decision */
    }

    await this.execute(hive, acc.effects.filter((e): e is Dispatchable => e.type !== "broadcast"));
    await this.armWatchdog();
  }

  /** `command.issued` for every new non-broadcast effect (re-dispatches of the same command id are skipped). */
  private issuedEvents(acc: Acc): EventDraft[] {
    const before = this.cache.get();
    const prevTrains = new Map([...(before?.trains ?? []), ...this.cleanup.values()].map((t) => [t.trainId, t]));
    const prevReleases = new Map((before?.releases ?? []).map((r) => [r.releaseId, r]));
    const out: EventDraft[] = [];
    for (const e of acc.effects) {
      if (e.type === "broadcast" || e.type === "oracle") continue; // the ledger records Oracle commands itself
      if (e.type === "dispatchDrone") {
        const prev = prevTrains.get(e.trainId);
        const phase = e.task.action === "LAND" ? "LANDING" : "BUILDING";
        if (prev && prev.phase === phase && prev.forkState === "READY" && prev.droneAttempt === e.attempt && !prev.dispatched) continue;
        const commandId = droneInstanceId(e.task, e.attempt);
        const tp = e.task.trace ? parseTraceparent(e.task.trace.traceparent) : null;
        out.push({
          type: "command.issued",
          actor: "queen",
          traceId: tp?.traceId ?? null,
          spanId: spanIdFor(commandId),
          parentSpanId: spanIdFor(e.trainId),
          itemId: e.task.action === "MERGE" || e.task.members?.length ? null : e.task.promptId,
          trainId: e.trainId,
          commandId,
          summary: clip(`${e.task.action} drone ${commandId}${e.task.modelChoice ? ` on ${e.task.modelChoice.model}` : ""}`, 500),
          data: { action: e.task.action, kind: "drone", role: e.task.role, ...(e.task.modelChoice ? { model: e.task.modelChoice.model } : {}), attempt: e.attempt },
        });
        continue;
      }
      const cmd = e.command;
      const isRelease = "releaseId" in e;
      if (isRelease) {
        const prev = prevReleases.get(e.releaseId);
        if (prev && (prev.deployCommandId === cmd.commandId || prev.sentinelCommandId === cmd.commandId || prev.rollbackCommandId === cmd.commandId)) continue;
      } else {
        const prev = prevTrains.get(e.trainId);
        if (prev && [prev.forkCommandId, prev.deleteCommandId, prev.deployCommandId, prev.teardownCommandId, prev.gateCommandId].includes(cmd.commandId)) continue;
      }
      const trace = "trace" in cmd && cmd.trace ? parseTraceparent(cmd.trace.traceparent) : null;
      const owner = isRelease ? undefined : (acc.trains.get(e.trainId) ?? prevTrains.get(e.trainId));
      const op = "op" in cmd ? cmd.op : "kind" in cmd && cmd.kind === "gate" ? "GATE" : "VERIFY";
      const env = "environment" in cmd ? cmd.environment : "";
      out.push({
        type: "command.issued",
        actor: "queen",
        traceId: trace?.traceId ?? (isRelease ? traceIdFromUuid(e.releaseId) : null),
        spanId: spanIdFor(cmd.commandId),
        parentSpanId: isRelease ? spanIdFor(e.releaseId) : spanIdFor(e.trainId),
        itemId: owner && !isCar(owner) ? owner.promptId : null,
        trainId: isRelease ? null : e.trainId,
        releaseId: isRelease ? e.releaseId : null,
        commandId: cmd.commandId,
        summary: clip(`${e.type} ${op}${env ? ` ${env}` : ""} ${cmd.commandId}`, 500),
        data: { action: op, kind: e.type, ...(env ? { environment: env } : {}) },
      });
    }
    return out;
  }

  /** `command.result` for an executor report about train `t`. */
  private commandResult(t: TrainRecord, commandId: string, summary: string, data: Record<string, unknown>, actor = "drone"): EventDraft {
    return {
      type: "command.result",
      severity: data.outcome === "error" ? "warn" : "info",
      actor,
      traceId: traceOfTrain(t),
      spanId: spanIdFor(commandId),
      parentSpanId: spanIdFor(t.trainId),
      itemId: isCar(t) ? null : t.promptId,
      trainId: t.trainId,
      commandId,
      summary: clip(summary, 500),
      data,
    };
  }

  private releaseEvent(
    rel: ReleaseRecord,
    type: "command.result" | "sentinel.verdict",
    commandId: string,
    summary: string,
    data: Record<string, unknown>,
    actor: string,
    severity: EventDraft["severity"] = data.outcome === "error" ? "warn" : "info",
  ): EventDraft {
    return {
      type,
      severity,
      actor,
      traceId: rel.traceId ?? traceIdFromUuid(rel.releaseId),
      spanId: spanIdFor(commandId),
      parentSpanId: spanIdFor(rel.releaseId),
      releaseId: rel.releaseId,
      commandId,
      summary: clip(summary, 500),
      data,
    };
  }

  /** Start executors, grouped per Workflow (createBatch); drone dispatches are confirmed in one bookkeeping decision. */
  private async execute(hive: string, effects: Dispatchable[]): Promise<void> {
    if (!effects.length) return;
    let failed = false;
    const limit = this.dispatchTimeoutMs();
    // A hung executor call must not stall the rest of the batch (or strand it until a later alarm).
    const bounded = <T>(p: Promise<T>, what: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not settle within ${limit} ms`)), limit);
      });
      return Promise.race([p, late]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
    };
    const group = async <C extends { commandId: string }>(
      port: { dispatch(c: C): Promise<unknown>; dispatchMany?(cs: readonly C[]): Promise<{ failed: string[] }> },
      cmds: C[],
    ) => {
      if (!cmds.length) return;
      try {
        if (cmds.length > 1 && port.dispatchMany) {
          if ((await bounded(port.dispatchMany(cmds), `dispatch of ${cmds.length} commands`)).failed.length) failed = true;
          return;
        }
        for (const c of cmds) {
          try {
            await bounded(port.dispatch(c), `dispatch of ${c.commandId}`);
          } catch (err) {
            console.error(`queen: dispatch of ${c.commandId} failed`, err);
            failed = true;
          }
        }
      } catch (err) {
        console.error("queen: batch dispatch failed", err);
        failed = true;
      }
    };
    await group(this.ports.provisioner, effects.flatMap((e) => (e.type === "provision" ? [e.command] : [])));
    await group(this.ports.herald, effects.flatMap((e) => (e.type === "deploy" ? [e.command] : [])));
    await group(this.ports.sentinel, effects.flatMap((e) => (e.type === "sentinel" ? [e.command] : [])));
    await group(this.ports.oracle, effects.flatMap((e) => (e.type === "oracle" ? [e.command] : [])));
    await group(this.ports.gatekeeper, effects.flatMap((e) => (e.type === "gate" ? [e.command] : [])));

    const drones = effects.filter((e): e is Extract<Effect, { type: "dispatchDrone" }> => e.type === "dispatchDrone");
    const started: typeof drones = [];
    if (drones.length > 1 && this.ports.dispatcher.dispatchMany) {
      try {
        const res = await bounded(this.ports.dispatcher.dispatchMany(drones.map((e) => ({ task: e.task, attempt: e.attempt }))), `dispatch of ${drones.length} drones`);
        const bad = new Set(res.failed);
        for (const e of drones) {
          if (bad.has(droneInstanceId(e.task, e.attempt))) failed = true;
          else started.push(e);
        }
      } catch (err) {
        console.error("queen: drone batch dispatch failed", err);
        failed = true;
      }
    } else {
      for (const e of drones) {
        try {
          await bounded(this.ports.dispatcher.dispatch(e.task, e.attempt), `drone dispatch for ${e.trainId}`);
          started.push(e);
        } catch (err) {
          console.error(`queen: drone dispatch for ${e.trainId} failed`, err);
          failed = true;
        }
      }
    }
    if (started.length) {
      const { acc } = this.decide(
        hive,
        (d) => {
          for (const e of started) d.acc.train(d.tp.dispatched(e.trainId, e.task.action === "LAND" ? "LANDING" : "BUILDING"));
        },
        { bookkeeping: true, trains: started.map((e) => e.trainId) },
      );
      await this.commit(hive, acc);
    }
    if (failed) await this.ioFailed();
  }

  /**
   * A dispatch failed: reconcile (which re-sends it) within RECONCILE_DELAY_MS. Moves an armed alarm EARLIER:
   * the alarm is usually already set to a watchdog deadline minutes out, and keeping it stalled the retry.
   */
  private async ioFailed(): Promise<void> {
    console.error(`queen: a dispatch failed; reconciling in ${RECONCILE_DELAY_MS} ms`);
    await this.alarmNoLaterThan(Date.now() + RECONCILE_DELAY_MS);
  }

  /**
   * Arm the alarm at `at` unless one is due sooner. Never moves an alarm later: a stored alarm in the past is
   * merely due and about to fire (e.g. the sim's now+1ms job booking), and it re-arms when it runs. Inside
   * alarm() the stored value is the one now firing, so compare against what this run has requested instead.
   */
  protected async alarmNoLaterThan(at: number): Promise<void> {
    if (this.inAlarm) {
      if (this.alarmRearmAt !== null && this.alarmRearmAt <= at) return;
      this.alarmRearmAt = at;
      await this.ctx.storage.setAlarm(at);
      return;
    }
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }

  /**
   * Keep the alarm armed while any command is outstanding: the earliest
   * watchdog deadline over trains (and cleanups), races, releases and Oracle
   * commands. Only ever moves an existing alarm earlier.
   */
  private async armWatchdog(): Promise<void> {
    const state = this.cache.get();
    if (!state) return;
    const now = this.now();
    const timeout = commandTimeoutMs(this.env);
    const deadlines = [
      watchdogDeadline([...state.trains, ...this.cleanup.values()], timeout, now, state.races),
      releaseWatchdogDeadline(state.releases, timeout, sentinelSettings(this.env).windowSeconds, now),
      workWatchdogDeadline(state.items, timeout, now),
      this.attemptDeadline(timeout),
    ];
    const slots = this.attemptSlots();
    if (slots.some((s) => s.rework)) {
      // REWORK candidates are EJECTED, so the warm state does not hold them: read the RACING races' candidates.
      const racing = state.races.filter((r) => r.state === "RACING");
      const trains = this.loadTrains(racing.flatMap((r) => r.trainIds));
      const holdMs = effectiveSettings(state.settings, now).guardrails.reworkHoldMs;
      deadlines.push(...reworkDeadlines({ races: racing, trains, slots, holdMs, graceMs: RACE_GRACE_MS, now }));
    }
    // The lease needs no alarm: every RPC renews it before decide() when due, and
    // an expired lease means "no global cap" (fail open) until then.
    const due = deadlines.filter((d): d is number => d !== null);
    if (!due.length) return;
    await this.alarmNoLaterThan(Date.now() + Math.max(0, Math.min(...due) - now) + WATCHDOG_SLACK_MS);
  }

  private busy(state: ActiveState): boolean {
    return state.items.some((i) => i.status === "READY" || i.status === "ACTIVE" || i.status === "DECOMPOSING" || i.status === "TRIAGE") || state.trains.some(isActive);
  }

  /**
   * The SwarmGovernor lease (D9): one DO-to-DO call before decide(), only when
   * due (expiring within 30 s with demand, or held while idle). A failure
   * leaves the hive on its own caps (fail open). `SWARM_LEASE=off` disables it.
   */
  private async maybeLease(hive: string, demand: boolean): Promise<void> {
    const ns = this.env.SWARM_GOVERNOR;
    if (!ns || this.env.SWARM_LEASE === "off") return;
    const now = this.now();
    let state: ActiveState;
    try {
      state = this.activeState();
    } catch {
      return;
    }
    const s = this.pendingLease ? { ...(state.settings ?? defaultSettingsRecord(hive, now)), ...this.pendingLease } : state.settings;
    const busy = demand || this.busy(state);
    const expires = s?.leaseExpiresAt ?? null;
    const held = (s?.leasedSlots ?? 0) > 0 && expires !== null && expires > now;
    const due = busy ? expires === null || expires - now <= LEASE_RENEW_MS : held;
    if (!due) return;
    const hs = effectiveSettings(s ?? null, now);
    try {
      const lease = await ns.get(ns.idFromName("global")).lease({ hive, want: busy ? Math.min(1000, hs.guardrails.maxActiveTrains) : 0, ttlMs: LEASE_TTL_MS });
      this.pendingLease = { leasedSlots: lease.granted, leaseExpiresAt: lease.expiresAt };
    } catch (e) {
      console.error("queen: SwarmGovernor lease failed; using per-hive caps", e);
    }
  }

  // ── transitions (load → decide → commit) ──────────────────────────────

  private async trainTransition(trainId: string, fn: (d: Decision, t: TrainRecord) => PlanResult): Promise<TrainUpdate> {
    const hive = this.hiveNamespace();
    if (hive === null || !this.trainExists(trainId)) throw new QueenError("NOT_FOUND", `train ${trainId} not found`);
    const { value: plan, acc } = this.decide(
      hive,
      (d) => {
        const t = d.trainsAtStart.get(trainId) ?? this.loadTrain(trainId)!;
        return fn(d, t);
      },
      { trains: [trainId] },
    );
    await this.commit(hive, acc);
    const train = this.loadTrain(trainId);
    return { outcome: plan.outcome, train: train ? toMergeTrainV2(train) : null };
  }

  private async releaseTransition(releaseId: string, fn: (d: Decision, r: ReleaseRecord) => ReleasePlanResult): Promise<ReleaseUpdate> {
    const hive = this.hiveNamespace();
    const rel = this.loadRelease(releaseId);
    if (hive === null || !rel) throw new QueenError("NOT_FOUND", `release ${releaseId} not found`);
    const { value: plan, acc } = this.decide(hive, (d) => fn(d, d.state.releases.find((r) => r.releaseId === releaseId) ?? rel), { releases: [releaseId] });
    await this.commit(hive, acc);
    const after = this.loadRelease(releaseId);
    return { outcome: plan.outcome, release: after ? toRelease(after) : null };
  }

  private throwWorkError(res: WorkPlanResult): void {
    if (res.error) throw new QueenError(httpCode(res.error.status), res.error.message);
  }

  // ── hive status ───────────────────────────────────────────────────────

  /** HiveStatus (§2.10): settings, effective autonomy, budget, SLO, counts, throughput, concurrency, headline. */
  hiveStatus(): HiveStatus | null {
    const hive = this.hiveNamespace();
    if (hive === null) return null;
    const now = this.now();
    const stored = loadHiveSettings(this.sql);
    const s = rollBudgetDay(stored ?? defaultSettingsRecord(hive, now), now);
    const hs = effectiveSettings(s, now);
    const open = this.sql.exec(`${ESCALATION_SELECT} WHERE status = 'OPEN'`).toArray().map(rowToEscalation);
    const { eff, slo } = this.autonomy(s, hs, open);
    const counts: Record<string, number> = {};
    for (const r of this.sql.exec("SELECT status, COUNT(*) AS n FROM work_items GROUP BY status").toArray()) counts[String(r.status)] = Number(r.n);
    const one = (q: string, ...b: SqlStorageValue[]) => Number(this.sql.exec(q, ...b).one().n ?? 0);
    const leadTimes = this.sql
      .exec("SELECT shipped_at - created_at AS ms FROM work_items WHERE kind != 'goal' AND shipped_at >= ? ORDER BY ms", now - 7 * DAY_MS)
      .toArray()
      .map((r) => Number(r.ms));
    const landedItems = this.sql.exec("SELECT attempts FROM work_items WHERE kind != 'goal' AND landed_at >= ?", now - 7 * DAY_MS).toArray();
    const activeBuilds = one("SELECT COUNT(*) AS n FROM merge_trains WHERE lane = 'BUILD' AND phase NOT IN ('MERGED', 'EJECTED')");
    const queueDepth = one("SELECT COUNT(*) AS n FROM merge_trains WHERE lane = 'QUEUE' AND phase NOT IN ('MERGED', 'EJECTED')");
    const leased = this.leasedSlots(s, now);
    const exhausted = budgetExhausted(s, hs.budget);
    const releaseInFlight = one("SELECT COUNT(*) AS n FROM releases WHERE phase IN ('STAGING', 'VALIDATING', 'AWAITING_TAP', 'CANARY')") > 0;
    return {
      hive,
      mode: this.isSim() ? "sim" : "live",
      settings: { ...hs, autonomy: s.autonomy },
      effectiveAutonomy: eff.level,
      degradedBy: eff.reasons.slice(0, 5),
      headline: hiveHeadline({ openEscalations: open.length, level: eff.level, budgetExhausted: exhausted, counts, queueCars: queueDepth, releaseInFlight }),
      budget: { day: utcDay(now), creditsUsed: s.creditsUsed, creditsLimit: hs.budget.dailyCredits, dispatches: s.dispatches, dispatchLimit: hs.budget.dailyDispatches },
      slo: { window: slo.window, attempted: slo.attempted, failed: slo.failed, target: slo.target, errorBudgetRemaining: slo.errorBudgetRemaining, exhausted: slo.exhausted },
      counts,
      throughput: {
        shipped24h: one("SELECT COUNT(*) AS n FROM work_items WHERE kind != 'goal' AND shipped_at >= ?", now - DAY_MS),
        landed24h: one("SELECT COUNT(*) AS n FROM work_items WHERE kind != 'goal' AND landed_at >= ?", now - DAY_MS),
        leadTimeP50Ms: leadTimes.length ? leadTimes[Math.floor((leadTimes.length - 1) / 2)]! : null,
        firstTryPassRate: landedItems.length ? landedItems.filter((r) => Number(r.attempts) === 0).length / landedItems.length : null,
      },
      concurrency: {
        activeBuilds,
        slots: hs.guardrails.maxActiveTrains,
        leasedSlots: leased ?? 0,
        affinityWaits: one("SELECT COUNT(*) AS n FROM work_items WHERE status = 'READY' AND wait_reason LIKE 'affinity%'"),
        queueDepth,
        waitingToBoard: one("SELECT COUNT(*) AS n FROM merge_trains WHERE lane = 'BUILD' AND phase = 'PASSED' AND car_id IS NULL"),
        landed1h: one("SELECT COUNT(*) AS n FROM work_items WHERE kind != 'goal' AND landed_at >= ?", now - HOUR_MS),
        conflicts24h: one("SELECT COUNT(*) AS n FROM event_log WHERE type = 'queue.conflict' AND ts >= ?", now - DAY_MS),
        bisects24h: one("SELECT COUNT(*) AS n FROM event_log WHERE type = 'queue.bisect' AND ts >= ?", now - DAY_MS),
        queueWaitP50Ms: null,
      },
    };
  }

  // ── reads ─────────────────────────────────────────────────────────────

  /** The persisted builder tier floor, as the War Room sees it. */
  private routerFloorView() {
    return toRouterFloor(loadRouter(this.sql).floor, routerPolicy(this.env));
  }

  private hiveNamespace(): string | null {
    const cached = this.cache.get()?.settings?.hive;
    if (cached) return cached;
    const s = this.sql.exec("SELECT hive FROM hive_settings WHERE id = 1").toArray()[0];
    if (s) return String(s.hive);
    const row = this.sql.exec("SELECT namespace FROM prompt_runs LIMIT 1").toArray()[0];
    return row ? String(row.namespace) : null;
  }

  /** The hive of a user route: the DO's hive, or (a new hive) the one the route named. */
  private hiveFor(named: string): string {
    const hive = this.hiveNamespace();
    if (hive !== null && hive !== named) throw new QueenError("CONFLICT", `this hive is "${hive}", not "${named}"`);
    return hive ?? named;
  }

  private loadPrompt(promptId: string): PromptRecord | null {
    const row = this.sql.exec("SELECT * FROM prompt_runs WHERE prompt_id = ?", promptId).toArray()[0];
    return row ? rowToPrompt(row) : null;
  }

  private loadItem(itemId: string): WorkItemRecord | null {
    const row = this.sql.exec("SELECT * FROM work_items WHERE item_id = ?", itemId).toArray()[0];
    return row ? rowToWorkItem(row) : null;
  }

  private loadItems(ids: string[]): WorkItemRecord[] {
    if (!ids.length) return [];
    return this.sql.exec(`SELECT * FROM work_items WHERE item_id IN (${ids.map(() => "?").join(",")})`, ...ids).toArray().map(rowToWorkItem);
  }

  private loadEscalation(id: string): EscalationRecord | null {
    const row = this.sql.exec(`${ESCALATION_SELECT} WHERE escalation_id = ?`, id).toArray()[0];
    return row ? rowToEscalation(row) : null;
  }

  /** The prompt run of an item: its row once dispatched, else synthesized (QUEUED). */
  private promptRunOf(item: WorkItemRecord): PromptRun {
    const p = this.loadPrompt(item.itemId);
    if (p) return toPromptRun(p);
    return { promptId: item.itemId, namespace: item.hive, promptText: item.body || item.title, status: "QUEUED", createdAt: item.createdAt };
  }

  private trainIdForCommand(commandId: string): string | null {
    const row = this.sql
      .exec("SELECT train_id FROM merge_trains WHERE deploy_command_id = ? OR teardown_command_id = ? LIMIT 1", commandId, commandId)
      .toArray()[0];
    return row ? String(row.train_id) : null;
  }

  private releaseIdForCommand(commandId: string): string | null {
    const row = this.sql
      .exec(
        `SELECT release_id FROM releases
         WHERE deploy_command_id = ? OR rollback_command_id = ? OR substr(?, 1, length(release_id) + 1) = release_id || '-'
         ORDER BY seq DESC LIMIT 1`,
        commandId,
        commandId,
        commandId,
      )
      .toArray()[0];
    return row ? String(row.release_id) : null;
  }

  private loadRelease(releaseId: string): ReleaseRecord | null {
    const row = this.sql.exec("SELECT * FROM releases WHERE release_id = ?", releaseId).toArray()[0];
    return row ? rowToRelease(row) : null;
  }

  private loadTrain(trainId: string): TrainRecord | null {
    const row = this.sql.exec("SELECT * FROM merge_trains WHERE train_id = ?", trainId).toArray()[0];
    return row ? rowToTrain(row) : null;
  }

  private loadTrains(ids: string[]): TrainRecord[] {
    if (!ids.length) return [];
    return this.sql.exec(`SELECT * FROM merge_trains WHERE train_id IN (${ids.map(() => "?").join(",")})`, ...ids).toArray().map(rowToTrain);
  }

  private trainExists(trainId: string): boolean {
    if (this.cache.get()?.trains.some((t) => t.trainId === trainId)) return true;
    return this.sql.exec("SELECT 1 AS x FROM merge_trains WHERE train_id = ?", trainId).toArray().length > 0;
  }

  /** BUILD trainId → its item (= prompt) id. */
  private itemOfTrain(trainId: string, acc?: Acc): string | null {
    const t = acc?.trains.get(trainId) ?? this.cache.get()?.trains.find((x) => x.trainId === trainId);
    if (t) return isCar(t) ? null : t.promptId;
    const row = this.sql.exec("SELECT prompt_id, lane FROM merge_trains WHERE train_id = ?", trainId).toArray()[0];
    return row && row.lane !== "QUEUE" ? String(row.prompt_id) : null;
  }

  private previewDeployments(trains: TrainRecord[]): Deployment[] {
    const ids = trains.flatMap((t) => [t.trainId, ...(t.members ?? [])]);
    if (!ids.length) return [];
    return this.sql
      .exec(`SELECT * FROM deployments WHERE environment = 'preview' AND train_id IN (${ids.map(() => "?").join(",")})`, ...ids)
      .toArray()
      .map(rowToDeployment);
  }

  // ── sockets ───────────────────────────────────────────────────────────

  private attachment(ws: WebSocket): SocketAttachment | null {
    try {
      return (ws.deserializeAttachment() as SocketAttachment | null) ?? null;
    } catch {
      return null;
    }
  }

  /** One frame (a coalesced `batch` or a single message) to every subscribed socket. */
  private broadcastNow(message: QueenServerMessage): void {
    const frame = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue; // getWebSockets may include CLOSING sockets
      if (!this.attachment(ws)?.subscribed) continue;
      this.sendRaw(ws, frame);
    }
  }

  private send(ws: WebSocket, message: QueenServerMessage): void {
    this.sendRaw(ws, JSON.stringify(message));
  }

  private sendRaw(ws: WebSocket, frame: string): void {
    try {
      ws.send(frame);
    } catch (err) {
      console.warn("queen: dropping frame for a dead socket", err);
    }
  }
}

/** A work item as the train planner needs it. */
function plannerItem(i: WorkItemRecord): PlannerItem {
  return {
    itemId: i.itemId,
    traceId: i.traceId,
    priority: i.priority,
    paths: [...i.paths],
    bestOf: i.bestOf,
    conflicts: i.conflicts,
    status: i.status,
    ...(i.inbox?.handoff ? { handoff: true } : {}),
    ...(i.judge ? { judge: i.judge } : {}),
    ...(i.entryWindowMs !== undefined ? { entryWindowMs: i.entryWindowMs } : {}),
  };
}

function sameSettings(a: HiveSettingsRecord, b: HiveSettingsRecord): boolean {
  const norm = (s: HiveSettingsRecord) => JSON.stringify({ ...s, updatedAt: 0, budgetBoost: s.budgetBoost ?? null });
  return norm(a) === norm(b);
}

/** Smoke routes of a car member: `/features/<name>` for each changed `src/features/<name>.js` (the registry excluded). */
export function smokePathsOf(changedPaths: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of changedPaths) {
    const m = /^src\/features\/([A-Za-z0-9._-]+)\.js$/.exec(p);
    if (m && m[1] !== "index") out.push(`/features/${m[1]}`);
    if (out.length === 10) break;
  }
  return out;
}

export type { TrainPhase };

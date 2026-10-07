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
 */
import { DurableObject } from "cloudflare:workers";
import {
  AppendAuditSchema,
  AppendAuditsSchema,
  BuildResultSchema,
  DeployResultSchema,
  EventQuerySchema,
  FileWorkItemSchema,
  LandResultSchema,
  MergeResultSchema,
  OracleResultSchema,
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
  traceIdFromUuid,
  type AppendAuditInput,
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
  type HiveSettings,
  type HiveStatus,
  type ItemDetail,
  type LandResultInput,
  type MergeResultInput,
  type MergeTrain,
  type MetricsView,
  type OracleResultInput,
  type PromptRun,
  type ProvisionResult,
  type QueenEvent,
  type QueenServerMessage,
  type QueenServerUnitMessage,
  type QueueView,
  type Release,
  type ScribeSummary,
  type SentinelVerdict,
  type SubmitPrompt,
  type TraceView,
  type TrainResult,
  type UpdateHiveSettings,
  type WorkAction,
  type WorkItem,
} from "@queenos/queen-types";
import {
  ESCALATION_SELECT,
  applyModelStatDelta,
  appendAuditRow,
  deleteClaims,
  listModelStats,
  listRecentAudit,
  listRouterStats,
  listVerdicts,
  loadHiveSettings,
  loadRouter,
  migrate,
  rowToDeployment,
  rowToEscalation,
  rowToEvent,
  rowToPrompt,
  rowToRace,
  rowToRelease,
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
} from "./db";
import { WorkflowDroneDispatcher, droneInstanceId, type DroneDispatcher } from "./drones";
import {
  WorkflowCommandDispatcher,
  type DeployDispatcher,
  type OracleDispatcher,
  type ProvisionerDispatcher,
  type SentinelDispatcher,
} from "./executors";
import { QueenError, asQueenError, parseOrThrow, type QueenErrorCode } from "./errors";
import { DEFAULT_POLICY, toRouterFloor, type FloorState, type RouterPolicy } from "./models/router";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  TrainPlanner,
  isActive,
  isCar,
  toMergeTrainV2,
  toPromptRun,
  traceOfTrain,
  watchdogDeadline,
  type Effect,
  type HiveState,
  type ModelStatDelta,
  type Outcome,
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
import { EscalationPlanner, type EscalationIntent, type EscalationPlanResult } from "./autonomy/escalation";
import { autonomyTransition, changeSuccessFromReleases, effectiveAutonomy, errorBudget, hiveHeadline, type EffectiveAutonomy, type SloStatus } from "./autonomy/policy";
import { appendEvents, pruneEvents, queryEvents } from "./obs/events";
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
  routerDispatches?: number;
  routerFloor?: FloorState;
  itemConflicts = new Map<string, number>();
  conflictClaims: { itemId: string; paths: string[] }[] = [];
  carInfraFailures?: number;
  executorLost = false;
  /** Prompts FAILED on infrastructure (→ EXECUTOR_LOST on the item, not REWORK_EXHAUSTED). */
  infraFailed = new Map<string, string>();
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
    if (r.routerDispatches !== undefined) this.routerDispatches = r.routerDispatches;
    if (r.routerFloor !== undefined) this.routerFloor = r.routerFloor;
    for (const c of r.itemConflicts) this.itemConflicts.set(c.itemId, c.conflicts);
    this.conflictClaims.push(...r.conflictClaims);
    if (r.carInfraFailures !== undefined) this.carInfraFailures = r.carInfraFailures;
    if (r.executorLost) this.executorLost = true;
    for (const f of r.infraFailed ?? []) this.infraFailed.set(f.promptId, f.summary);
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
      dispatcher: new WorkflowDroneDispatcher(env.DRONES),
    };
  }

  /** Seam for sim: filing hints from a prompt's text (the sim's `[race]` marker sets bestOf 3). */
  protected filingHints(text: string): { bestOf?: number } {
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
      (d) => d.acc.work(d.wp.fileItem({ ...spec, ...(spec.bestOf === undefined && hints.bestOf ? { bestOf: hints.bestOf } : {}), actor: `user:${input.user}` })),
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
    const { value: res, acc } = this.decide(hive, (d) => d.acc.work(d.wp.action(input.itemId, action, `user:${input.user}`)), { items: [input.itemId] });
    await this.commit(hive, acc);
    this.throwWorkError(res);
    const item = this.loadItem(input.itemId);
    return { outcome: res.outcome, item: item ? toWorkItem(item) : null };
  }

  /** Open work items (the sim Oracle's TRIAGE dedupe). */
  listOpenItems(): { itemId: string; title: string; status: string }[] {
    return this.sql
      .exec(`SELECT item_id, title, status FROM work_items WHERE status NOT IN (${TERMINAL_ITEMS_SQL}) AND kind != 'goal' ORDER BY seq`)
      .toArray()
      .map((r) => ({ itemId: String(r.item_id), title: String(r.title), status: String(r.status) }));
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
      d.acc.events.push({
        type: "gate.verdict",
        severity: r.passed ? "info" : "warn",
        actor: "gatekeeper",
        // (gateInfra: not a verdict; the planner re-deploys and re-gates, no attempt charged.)
        traceId: traceOfTrain(t),
        spanId: spanIdFor(`gate:${t.trainId}:${sha}`),
        parentSpanId: spanIdFor(t.trainId),
        itemId: isCar(t) ? null : t.promptId,
        trainId: t.trainId,
        summary: clip(`gate ${r.passed ? "passed" : gateInfra ? "could not run (infrastructure; re-gating)" : "failed"}: ${r.summary}`, 500),
        data: {
          outcome: r.passed ? "PASSED" : gateInfra ? "INFRA" : "FAILED",
          ...(gateInfra ? { cause: "infra" } : {}),
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
      .exec("SELECT * FROM races WHERE state = 'RACING' OR race_id IN (SELECT race_id FROM races ORDER BY created_at DESC LIMIT 20) ORDER BY created_at")
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
      trains: desc(this.sql.exec("SELECT * FROM merge_trains ORDER BY seq DESC LIMIT ?", SNAPSHOT_LIMIT).toArray().map(rowToTrain)).map(toMergeTrainV2),
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
    const { acc } = this.decide(hive, (d) => {
      d.acc.train(d.tp.reconcile());
      d.acc.release(d.rp.reconcile());
      leaseDue = d.acc.work(d.wp.reconcile()).leaseDue ?? false;
    });
    await this.commit(hive, acc);
    try {
      this.ctx.storage.transactionSync(() => pruneEvents(this.sql, this.now()));
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
        .exec("SELECT * FROM merge_trains WHERE phase IN ('MERGED', 'EJECTED') AND (fork_state = 'DELETING' OR deploy_state = 'TEARING_DOWN')")
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
          raceWidth({
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
      const building = [...merged.values()].filter((t) => isActive(t) && !isCar(t)).length;
      const dispatch = acc.work(wp.dispatchReady({ activeBuilds: building, leasedSlots: leased }));
      for (const s of dispatch.dispatches) {
        const item = acc.items.get(s.itemId) ?? state.items.find((i) => i.itemId === s.itemId);
        acc.train(
          tp.submit({
            promptId: s.itemId,
            promptText: s.promptText,
            raceWidth: s.width,
            difficulty: s.difficulty,
            ...(item ? { item: plannerItem(item) } : { item: { itemId: s.itemId, traceId: s.traceId, priority: s.priority, bestOf: s.bestOf } }),
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
    const racing = state.races.map((r) => r.raceId);
    if (racing.length) {
      const ids = state.races.flatMap((r) => r.trainIds).filter((id) => !trains.has(id));
      if (ids.length) addTrains(this.loadTrains(ids));
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
    return { ...state, trains: [...trains.values()].sort(bySeq), items: [...items.values()].sort(bySeq), releases: [...releases.values()].sort(bySeq) };
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
    const statsChanged = acc.modelStats.length > 0 || acc.routerFloor !== undefined;
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
        for (const p of acc.prompts.values()) upsertPrompt(this.sql, p);
        for (const t of trains) upsertTrain(this.sql, t);
        for (const d of acc.deployments.values()) upsertDeployment(this.sql, d);
        for (const r of acc.releases.values()) upsertRelease(this.sql, r);
        for (const r of acc.races.values()) upsertRace(this.sql, r);
        for (const i of acc.items.values()) upsertWorkItem(this.sql, i);
        for (const id of acc.released) deleteClaims(this.sql, id);
        for (const c of claims) upsertClaim(this.sql, c);
        for (const e of acc.escalations.values()) upsertEscalation(this.sql, e);
        for (const v of verdicts) upsertVerdict(this.sql, v, now);
        for (const d of acc.modelStats) applyModelStatDelta(this.sql, d, now);
        if (router) saveRouter(this.sql, { dispatches: acc.routerDispatches, floor: acc.routerFloor });
        for (const [itemId, n] of acc.itemConflicts) {
          if (!acc.items.has(itemId)) this.sql.exec("UPDATE work_items SET conflicts = ? WHERE item_id = ?", n, itemId);
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
      if (!isActive(t) && (t.forkState === "DELETING" || t.deployState === "TEARING_DOWN")) this.cleanup.set(t.trainId, t);
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
        if (prev && [prev.forkCommandId, prev.deleteCommandId, prev.deployCommandId, prev.teardownCommandId].includes(cmd.commandId)) continue;
      }
      const trace = "trace" in cmd && cmd.trace ? parseTraceparent(cmd.trace.traceparent) : null;
      const owner = isRelease ? undefined : (acc.trains.get(e.trainId) ?? prevTrains.get(e.trainId));
      const op = "op" in cmd ? cmd.op : "VERIFY";
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
    ];
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
  return { itemId: i.itemId, traceId: i.traceId, priority: i.priority, paths: [...i.paths], bestOf: i.bestOf, conflicts: i.conflicts };
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

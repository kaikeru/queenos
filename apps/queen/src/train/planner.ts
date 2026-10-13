/**
 * Train planner (pure: no I/O, no clock, no randomness). v2 design §2.3.
 *
 * Two lanes of trains, both in `merge_trains`, told apart by `lane`:
 * - BUILD (one train per build attempt of an item: a race candidate or a
 *   rework). Every BUILD train forks from hive main (`<namespace>`) the moment
 *   it is enqueued: independent items build in parallel, nothing waits for a
 *   predecessor, and a failed build never supersedes anyone. The one exception
 *   is `waitForCarSeq` (a conflict / integration rework): it stays
 *   WAITING_PARENT until every QUEUE car with seq ≤ waitForCarSeq is terminal,
 *   then forks from main. Fork → BUILDER → push → preview → gate is v1's
 *   pipeline. A pass moves the train to PASSED with a queue ticket
 *   (`passedSeq`): it is waiting to board a car.
 * - QUEUE (one train per merge *car*, v1's speculative train repurposed).
 *   queue.ts (WP1.11) forms cars, interprets the MERGE drone's result, fails
 *   and bisects cars and lands them; this planner materialises cars, forks
 *   them (from the car ahead once it pushed, or main), dispatches the MERGE
 *   drone in place of a builder, deploys car previews and lands the head car
 *   with the LANDER (always a fast-forward).
 *
 * The merge queue is on when `ctx.queue` is set (WP2.1 wires it). Without it
 * (Phase 1, queue.ts still a seam) passed builds land directly, one at a time
 * in `passedSeq` order; since they all forked from main, a build that lost the
 * race to main gets NOT_FAST_FORWARD from the lander and is reworked.
 *
 * Races (best-of-N, §2.3.6): `enqueue(prompt, action, w > 1)` creates a race
 * and w BUILD candidates on w distinct models (router.routeRace). A passing
 * candidate waits in TESTING (`raceOutcome PASSED`); a failing one is ejected
 * alone. The race is decided when every candidate reported, or at its
 * deadline (RACE_GRACE_MS after the first pass): rankCandidates() picks the
 * winner (PASSED + passedSeq), the others are EJECTED as LOST. No pass at all:
 * the race is ABANDONED and the prompt is reworked once (attempts + 1) with
 * the best failure's Scribe summary. Race candidates never move the AIMD floor.
 *
 * Unchanged from v1: forks, deletes, preview deploys and teardowns are
 * commands to executors, stored on the train row (persisted before dispatch)
 * and matched by command id, so duplicate and late results are idempotent;
 * the watchdog re-issues lost commands; MERGED and EJECTED trains get their
 * fork deleted and preview torn down; REWORK carries the Scribe summary and
 * is capped by `maxReworks`.
 *
 * v2 observability: every train carries its item's `traceId`; every command
 * and drone task carries `trace.traceparent` (span = spanIdFor(command id /
 * drone instance id)); every visible phase change is an EventDraft in
 * `PlanResult.events`.
 *
 * Human-push design rev 2 (T1): pushed code arrives in PRE-FORKED trains. The git proxy forks hive main
 * itself and pushes the contributor's code to the fork's `main`, so a contributed train (origin
 * human / agent) never forks or dispatches a builder: `intent()` creates it in BUILDING with
 * `forkState: PENDING` (the intent's watchdog clock is `forkIssuedAt`; no `gitPushed` within
 * `commandTimeoutMs` ejects it, no attempt charged); `pushed()` adopts the fork (READY, headSha,
 * baseSha) and either deploys its preview at once (DEPLOYING, exactly like a drone's build-result) or
 * PARKS it (BUILDING, fork READY) until its item is dispatched, where `submit()` resumes it instead of
 * forking a builder. A rejected contributed train is not reworked: its prompt FAILS ("awaiting
 * contributor") and its fork is KEPT (EJECTED with `forkState: READY`; `deleteIssuedAt` holds the
 * delete-after deadline, KEEP_FORK_MS) so a handoff can fork from it. With a handoff (`Queen: rework`,
 * or the `handoff` action) the item reworks as a drone item, and the REWORK forks FROM the kept fork
 * (`FORK.from`) with the rendered v1 note as its brief.
 *
 * Every method returns the changed rows (for the DO to persist) plus an
 * explicit list of effects for the DO to execute afterwards.
 */
import type {
  BuildResult,
  DeployCommand,
  GateCommand,
  DeployResult,
  Deployment,
  DroneTask,
  EventDraft,
  LandResult,
  MergeConflict,
  MergeMember,
  MergeResult,
  MergeTrain,
  ModelChoice,
  PromptRun,
  PromptStatus,
  ProvisionCommand,
  RaceJudge,
  ProvisionResult,
  QueenServerMessage,
  RecalledMemory,
  ReworkReason,
  SubmissionOrigin,
  TraceContext,
  TrainPhase as QueenTrainPhase,
  TrainResult,
  TrainState,
  WorkStatus,
} from "@queenos/queen-types";
import {
  INFRA_SUMMARY_PREFIX,
  MAX_GATE_COMMAND_ID,
  MAX_RECALL_QUERY,
  RACE_GRACE_MS,
  isInfraStopped,
  memoryToRagSnippet,
  reworkReasonText,
  spanIdFor,
  traceIdFromUuid,
  traceparent,
} from "@queenos/queen-types";
import { droneInstanceId } from "../drones";
import {
  DEFAULT_POLICY,
  INITIAL_FLOOR,
  floorAfter,
  isCatalogModel,
  route,
  routeRace,
  type FloorOutcome,
  type FloorState,
  type RouterPolicy,
  type RouterRole,
  type RouterStats,
} from "../models/router";
import type { RaceRecord } from "../records";
import * as queue from "./queue";
import { LOSER_FORK_KEEP_MS, checkPick, decideMode, isHumanBy, judgeOf, keptLoser, pickDeadline, pickDue, recommend, releaseLoser } from "./pick";
import { buildCredits, rankCandidates, raceWidth, type RaceCandidate } from "./race";
import { holdEnd, iso, nextSlot, type AttemptSlot, type ReworkSettings } from "./rework";

/**
 * Planner-internal train lifecycle (TrainPhaseSchema in queen-types, exposed
 * to the War Room). `status` (TrainStateSchema) is derived from it.
 */
export type TrainPhase = QueenTrainPhase;

export type ForkState = "NONE" | "PENDING" | "READY" | "DELETING" | "DELETED" | "DELETE_FAILED";
/** Lifecycle of the train's Worker Preview (Herald). */
export type DeployState = "NONE" | "PENDING" | "LIVE" | "FAILED" | "TEARING_DOWN" | "TORN_DOWN" | "TEARDOWN_FAILED";
export type TrainAction = "BUILD" | "REWORK";

/** Fork attempts (each a new Provisioner instance) before the train fails. */
export const MAX_FORK_ATTEMPTS = 3;
/**
 * Watchdog cap for every other command kind (DEPLOY, TEARDOWN, DELETE, drone
 * tasks): attempts, each under a new command / instance id, before the same
 * failure path as an `ok:false` result. Same value as the fork cap.
 */
export const MAX_COMMAND_ATTEMPTS = MAX_FORK_ATTEMPTS;
/** Default for COMMAND_TIMEOUT_MS: how long a dispatched command may stay unreported. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;
/** Default Guardrails.maxConflictReworks (D7). */
export const DEFAULT_MAX_CONFLICT_REWORKS = 2;
/**
 * ONE infra path (5xx / 429 / lost executors are never the change's fault): a builder drone
 * (`TrainResult.cause = "infra"` in BUILDING), a fork (ok:false or lost), a preview deploy
 * (`DeployResult.retryable`, or lost) and a gate (`cause = "infra"` in TESTING) are all re-dispatched
 * with no attempt, rework or model-failure charge, up to the same cap: MAX_COMMAND_ATTEMPTS tries of
 * that command (persisted in its command id / droneAttempt). Past it, infraExhausted(): the train is
 * EJECTED ("failed on infrastructure: …") and the item FAILED with EXECUTOR_LOST, never
 * REWORK_EXHAUSTED. Preview / gate retries wait INFRA_RETRY_BASE_MS·2^(n-1) (jittered) via the alarm.
 *
 * Merge-queue CARS are the exception (retireCar): an Artifacts repo can go "sick" right after a push
 * (smart-HTTP 503s for 40 s to 7+ min, inherited by forks of it) while a fresh fork of the same content
 * works at once. So a car whose preview deploy, integration gate or MERGE drone reports infra (that
 * executor's in-step and Workflow retries already spent) is not retried against the same repo: it is
 * RETIRED after that one round, its members re-board a fresh car, and that car does not stack on a
 * suspect car ahead (carForkGuard). BUILD trains and race candidates keep MAX_INFRA_ATTEMPTS.
 */
export const MAX_INFRA_ATTEMPTS = MAX_COMMAND_ATTEMPTS;
/** A rejected contributed train's fork is kept this long for a handoff (or until its item leaves FAILED). */
export const KEEP_FORK_MS = 24 * 3_600_000;

/** Whose code a train carries: a contributed (human / agent) train came through the git proxy. Absent origin = drone. */
export function isContributed(t: Pick<TrainRecord, "origin" | "lane">): boolean {
  return !!t.origin && t.origin.kind !== "drone" && t.lane !== "QUEUE";
}

/** A pre-forked train still waiting for its push (`gitIntent` accepted, no `gitPushed` yet). */
export function awaitingPush(t: TrainRecord): boolean {
  return isActive(t) && isContributed(t) && t.phase === "BUILDING" && t.forkState === "PENDING";
}

/** A pushed train parked until its item is dispatched (paused, budget, capacity, dependencies). */
export function isParked(t: TrainRecord): boolean {
  return isActive(t) && isContributed(t) && t.phase === "BUILDING" && t.forkState === "READY";
}

/** A rejected contributed train whose fork is kept for a handoff; `deleteIssuedAt` is its delete-after deadline. */
export function keptFork(t: TrainRecord): boolean {
  return !isActive(t) && isContributed(t) && t.forkState === "READY" && t.raceOutcome !== "LOST";
}
export const INFRA_RETRY_BASE_MS = 30_000;
export const INFRA_RETRY_MAX_MS = 5 * 60_000;

/** Deterministic jitter in [0.5, 1.5) from a key (the planner is pure: no randomness). */
function jitter(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return 0.5 + (h >>> 0) / 2 ** 32;
}

/** Backoff before infra retry n (n = the failed DEPLOY attempt): 30 s, 60 s, 120 s … (cap 5 min), ±50% jitter per train. */
export function infraRetryDelayMs(t: Pick<TrainRecord, "trainId" | "deployCommandId">): number {
  const n = Math.max(1, commandAttempt(t.deployCommandId));
  return Math.round(Math.min(INFRA_RETRY_MAX_MS, INFRA_RETRY_BASE_MS * 2 ** (n - 1)) * jitter(`${t.trainId}:${n}`));
}

/**
 * Automatic gate-infra re-gates of a CONTRIBUTED train (MCP fix wave): when its gate could not run (`cause: "infra"`
 * in TESTING on a live preview), the same head is re-gated, without a re-deploy, up to this many times after the
 * first gate, with its own budget (`gateInfraRounds`, not the preview deploy's). Past it: gateInfraExhausted (an infra
 * verdict, never a plain rejection). Drone trains keep the re-deploy path (infraRetry).
 */
export const MAX_GATE_INFRA_ROUNDS = 3;

/** Backoff before gate-infra re-gate k (1-based): 30 s, 60 s, 120 s … (cap 5 min), ±50% jitter per train and round. */
export function gateInfraBackoffMs(t: Pick<TrainRecord, "trainId">, k: number): number {
  return Math.round(Math.min(INFRA_RETRY_MAX_MS, INFRA_RETRY_BASE_MS * 2 ** (Math.max(1, k) - 1)) * jitter(`${t.trainId}:g:${k}`));
}

/**
 * n of the next gate ROUND after gate id `id`: the next odd n (a round's first gate is odd, its one watchdog
 * re-dispatch the following even n; the watchdog relies on that parity). 1 when none was issued.
 */
export function nextGateRound(id: string | null | undefined): number {
  const n = gateAttempt(id);
  return n % 2 === 1 ? n + 2 : n + 1;
}

/** n of the gate a (re-)deployed preview starts: round d of TESTING, but never an id a re-gate already used. */
function deployGateRound(t: TrainRecord): number {
  return Math.max(2 * Math.max(1, commandAttempt(t.deployCommandId)) - 1, nextGateRound(t.gateCommandId));
}

/** The gate watchdog's clock: the gate's issue time, or its notBefore when that is later (an infra re-gate's backoff). */
export function gateClock(t: TrainRecord, now: number): number {
  return Math.max(t.gateIssuedAt ?? now, t.gateNotBefore ?? 0);
}

/** A train parked for an infra retry: DEPLOYING with its last deploy FAILED (the clock is the failure time). */
function awaitingInfraRetry(t: TrainRecord): boolean {
  return isActive(t) && t.phase === "DEPLOYING" && t.deployState === "FAILED";
}

/** When a parked train's preview is re-deployed (null when it is not parked). */
export function infraRetryAt(t: TrainRecord, now: number): number | null {
  return awaitingInfraRetry(t) ? (t.deployIssuedAt ?? now) + infraRetryDelayMs(t) : null;
}

export interface TrainRecord extends MergeTrain {
  seq: number;
  /** The prompt this train was provisioned for (a car: its first member's prompt). */
  promptId: string;
  phase: TrainPhase;
  forkState: ForkState;
  /** Repo the fork was (or will be) created from. */
  forkSource: string | null;
  /** Train head pushed by the builder / reported by the gatekeeper. */
  headSha: string | null;
  /** Hive main SHA after the lander pushed. */
  landedSha: string | null;
  summary: string | null;
  reason: string | null;
  action: TrainAction;
  /** Whether the drone for the current phase (BUILDING / LANDING) was dispatched. */
  dispatched: boolean;
  /** Current Provisioner FORK command (also the Workflow instance id). */
  forkCommandId: string | null;
  /** Current Provisioner DELETE command. */
  deleteCommandId: string | null;
  deployState: DeployState;
  /** Current Herald DEPLOY (preview) command. */
  deployCommandId: string | null;
  /** Current Herald TEARDOWN (preview) command. */
  teardownCommandId: string | null;
  previewUrl: string | null;
  /**
   * Watchdog clocks: when the current command of each kind was issued (its
   * command id assigned), or when the current drone was dispatched. Null when
   * none is outstanding. Stamped by setTrain whenever the id changes.
   */
  forkIssuedAt: number | null;
  deleteIssuedAt: number | null;
  deployIssuedAt: number | null;
  teardownIssuedAt: number | null;
  droneIssuedAt: number | null;
  /** When the BUILD train passed its gate (migration v13); the merge queue reads it for queue-wait. */
  passedAt?: number | null;
  /**
   * The Queen-started gate of the current TESTING round (v15; gatekeepers Workflow instance id,
   * `gateCommandId(repo, head, n)`), and when it was issued (the gate watchdog's clock).
   */
  gateCommandId?: string | null;
  gateIssuedAt?: number | null;
  /** v18: automatic gate-infra re-gates of this train so far (MAX_GATE_INFRA_ROUNDS; absent = 0). */
  gateInfraRounds?: number;
  /** v18: the current gate's GateCommand.notBefore (epoch ms; an infra re-gate's backoff), null / absent = at once. */
  gateNotBefore?: number | null;
  /** Attempt number of the current phase's drone (instance id suffix when > 1). */
  droneAttempt: number;
  /** Router's choice, or (after the build) the model that actually built the head. */
  model: string | null;
  modelReason: string | null;
  /** Full router decision for the current builder dispatch (fallbacks included). */
  modelChoice: ModelChoice | null;
  /** droneAttempt the choice was made for: a re-dispatch of the same attempt reuses it. */
  modelChoiceAttempt: number | null;
  /** Stats bookkeeping, so a result is counted once: BUILT (attempt counted), then PASSED / FAILED. */
  modelOutcome: ModelOutcome | null;
  /** The current choice was a probe one tier under the hive's floor. */
  modelProbe: boolean;
  /** Hive memories the Provisioner recalled when it forked this train (best first). Feeds `ragContext`. */
  memories: RecalledMemory[];
  // v2 internals (migrations v9 / v11). The visible v2 fields (traceId, raceId,
  // lane, members, carId, passedSeq, ...) come from MergeTrain.
  /** Build credits (budget + race ranking). */
  credits?: number | null;
  /** QUEUE car: the failed car id; pool BUILD train: a pending bisect pin `"<failedCarId>#<half>"` (queue.ts). */
  bisectOf?: string | null;
  /**
   * BUILD: the builder's Think `verify` tool passed (BuildResult.verified; race
   * ranking key 4). Persisted in `merge_trains.verified` (v12; NULL = unknown).
   */
  verified?: boolean | null;
}

export type ModelOutcome = "BUILT" | "PASSED" | "FAILED";

/**
 * A track-record change for one (model, role), applied by the DO in the same
 * transaction as the train rows. Emitted only by applied transitions, guarded
 * by the train's modelOutcome, so duplicate / stale results never count twice.
 */
export interface ModelStatDelta {
  model: string;
  role: RouterRole;
  attempts: number;
  passes: number;
  failures: number;
  /** A timed build (feeds avgBuildMs). */
  buildMs?: number;
  /** "pass" resets the consecutive-failure streak, "fail" extends it. */
  streak?: "pass" | "fail";
}

export interface PromptRecord extends PromptRun {
  seq: number;
  summary: string | null;
  attempts: number;
  /** v8 `race_width` / `difficulty` (the work item's dispatch decision; absent on v1 records). */
  raceWidth?: number;
  difficulty?: string;
}

/** What the planner needs to know about the work item behind a prompt (prompt_id = item_id). */
export interface PlannerItem {
  itemId: string;
  /** The item's trace (default: traceIdFromUuid(itemId), which matches the v8/v9 backfill). */
  traceId?: string | null;
  /** 0..3 (merge-queue member order). Default 2. */
  priority?: number;
  /** Predicted touch set (race ranking key 5). */
  paths?: string[];
  /** Explicit race width for reworks. */
  bestOf?: number | null;
  /** Conflict reworks so far (work_items.conflicts; D7). */
  conflicts?: number;
  /** The item's status at the start of the decision (kept forks are released once it leaves FAILED). */
  status?: WorkStatus;
  /** The contributor handed the item to the swarm (`Queen: rework` or the `handoff` action). */
  handoff?: boolean;
  /** Race judge (§10.2): `human` holds a race with ≥ 2 passes for a pick. Absent: the hive's (`PlannerContext.pick.judge`). */
  judge?: RaceJudge;
  /** MCP create_goal: this item's race entry window (ms); absent = the hive's. */
  entryWindowMs?: number;
}

export interface HiveState {
  prompts: PromptRecord[];
  /**
   * All active trains, plus any terminal train relevant to the call. v2: plus
   * every candidate (terminal ones included) of each loaded RACING race.
   */
  trains: TrainRecord[];
  /** Deployment rows of the loaded trains (preview rows are `preview-<trainId>`). */
  deployments?: Deployment[];
  maxTrainSeq: number;
  maxPromptSeq: number;
  /** Router track record for this hive (model_stats). */
  modelStats?: RouterStats[];
  /** Router decisions made so far in this hive (exploration cadence). */
  routerDispatches?: number;
  /** The hive's builder tier floor (AIMD + probes). */
  routerFloor?: FloorState;
  /** v2: RACING races (and any race named by the call). */
  races?: RaceRecord[];
  /** v2: work items of the loaded prompts. */
  items?: PlannerItem[];
  /** v2: MAX(passed_seq) over every train (terminal ones included): queue tickets stay monotonic. */
  maxPassedSeq?: number;
  /** Rework loop (v19): slots of the hive's open attempts (attempts.reworks / rework_reason / rework_due_at). */
  slots?: AttemptSlot[];
}

/** Race policy inputs (HiveSettings.race + Guardrails + budget), for rework widths. */
export interface RaceSettings {
  reworkWidth: number;
  hardWidth: number;
  maxRaceWidth: number;
  /** Build slots free when the plan starts (§2.3.1); the planner tracks its own usage. */
  slotsFree: number;
  /** Daily credits left (null = no budget check). */
  remainingCredits?: number | null;
}

/** The queue.ts functions the planner calls (injectable for tests; default: queue.ts). */
export interface QueueHooks {
  formCars: typeof queue.formCars;
  mergeResult: typeof queue.mergeResult;
  carFailed: typeof queue.carFailed;
  carLanded: typeof queue.carLanded;
}

export const DEFAULT_QUEUE_HOOKS: QueueHooks = {
  formCars: queue.formCars,
  mergeResult: queue.mergeResult,
  carFailed: queue.carFailed,
  carLanded: queue.carLanded,
};

/** Turns the merge queue on (passed builds board cars instead of landing directly). */
export interface QueueOptions {
  settings: queue.QueueSettings;
  /** hive_settings.car_infra_failures. */
  carInfraFailures?: number;
  /** Car formation paused (open EXECUTOR_LOST). */
  paused?: boolean;
  hooks?: Partial<QueueHooks>;
}

export interface PlannerContext {
  namespace: string;
  now: number;
  newId: () => string;
  /** Rework attempts allowed before a prompt is FAILED. Default 2. */
  maxReworks?: number;
  /** Conflict reworks allowed before a prompt is FAILED (Guardrails.maxConflictReworks). Default 2. */
  maxConflictReworks?: number;
  /** Watchdog: an outstanding command older than this is re-issued. Default 10 min. */
  commandTimeoutMs?: number;
  /** MODEL_ROUTER_PIN_BUILDER: force this model for builder / rework drones. */
  modelPin?: string | null;
  /** ROUTER_BACKOFF_STREAK / ROUTER_PROBE_AFTER. */
  routerPolicy?: RouterPolicy;
  /** v2: rework race widths. Absent: reworks are single builds (v1). */
  race?: RaceSettings;
  /** v2: how long the other candidates get after a race's first pass. Default RACE_GRACE_MS. */
  raceGraceMs?: number;
  /** v2: the merge queue. Absent: passed builds land directly (Phase 1 default); car results are still handled. */
  queue?: QueueOptions;
  /** v2: item priority for car member order (default: HiveState.items, else 2). */
  priorityOf?: (promptId: string) => number;
  /**
   * T1: the rendered v1 verdict note of a commit (the `notesFor` projection), the brief of a REWORK seeded
   * from a contributor's rejected head. A read-only ledger lookup; absent or null = no brief.
   */
  briefFor?: (sha: string) => string | null;
  /**
   * T9a human-judged races (§10.2): the hive's default judge (`settings.race.judge`, default auto), the pick
   * window (`settings.race.pickWindowMs`, default 15 min) and `Guardrails.maxPickingRaces` (default 2, min 1).
   */
  pick?: { judge?: RaceJudge; pickWindowMs?: number; maxPickingRaces?: number };
  /**
   * `settings.executors === "external"`: the hive has no swarm. No item ever gets a drone REWORK (a failed
   * item awaits its contributor), and `submit` never forks a builder. Default false.
   */
  external?: boolean;
  /**
   * External hives: how long a race a push opens stays open to new entries, from its creation (the first push;
   * `settings.race.entryWindowMs`, default ENTRY_WINDOW_DEFAULT_MS). Until `entryClosesAt` the race is not decided
   * (passes and all-failed are held) unless a human closes entries early. 0 or absent: no window (`entryClosesAt`
   * stays null: decided as soon as every candidate reported, or at the grace deadline). Swarm hives leave it 0.
   */
  entryWindowMs?: number;
  /**
   * Rework loop (rework-loop spec §5.5): external hives' rework guardrails. Absent (swarm hives): no attempt ever gets a
   * slot and every rejection is handled as before the rework loop.
   */
  rework?: ReworkSettings;
}

/** A human pick (§10.3): +1 pick for the winner's (model, role), +1 against the recommendation when it differed (db.applyPickDelta). */
export interface PickDelta {
  model: string;
  role: RouterRole;
  againstRecommendation: boolean;
}

export type Effect =
  | { type: "provision"; trainId: string; command: ProvisionCommand }
  | { type: "deploy"; trainId: string; command: DeployCommand }
  | { type: "gate"; trainId: string; command: GateCommand }
  | { type: "dispatchDrone"; trainId: string; task: DroneTask; attempt: number }
  | { type: "broadcast"; message: QueenServerMessage };

export type Outcome =
  | "applied"
  | "ignored:unknown"
  | "ignored:stale"
  | "ignored:duplicate"
  | "ignored:premature";

export interface PlanResult {
  outcome: Outcome;
  prompts: PromptRecord[];
  trains: TrainRecord[];
  deployments: Deployment[];
  effects: Effect[];
  /** Track-record changes to apply (then broadcast models.updated). */
  modelStats: ModelStatDelta[];
  /** New router decision count, when this plan made a decision. */
  routerDispatches?: number;
  /** New floor state, when this plan moved it. */
  routerFloor?: FloorState;
  /** v2: event_log drafts (train phases, races, queue). */
  events: EventDraft[];
  /** v2: changed race rows. */
  races: RaceRecord[];
  /** v2: what landed on main (a car: all its members; a direct landing: the train) → rp.landed. */
  landed?: { sha: string; trainIds: string[] };
  /** v2: paths to claim (source "conflict") on items whose member conflicted in a car (§2.3.5). */
  conflictClaims: { itemId: string; paths: string[] }[];
  /** v2: new work_items.conflicts per item (conflict reworks, D7). */
  itemConflicts: { itemId: string; conflicts: number }[];
  /** v2: new hive_settings.car_infra_failures, when it changed. */
  carInfraFailures?: number;
  /** v2: open EXECUTOR_LOST (subject hive) and pause car formation. */
  executorLost?: boolean;
  /** Prompts FAILED on infrastructure (infra retries / executor attempts spent): EXECUTOR_LOST on the item, not REWORK_EXHAUSTED. */
  infraFailed?: { promptId: string; summary: string }[];
  /** T1: prompts of contributed code FAILED at the gate: the item waits for its contributor (no escalation, no rework). */
  awaitingContributor?: { promptId: string; summary: string }[];
  /** T1: push intents ended without a push (gitAborted, the intent watchdog, or a newer push): submissions `aborted:transient`. */
  abortedIntents?: string[];
  /** T9a: human picks to count in model_stats (picks / picksAgainstRecommendation). */
  picks?: PickDelta[];
  /** T9a: a pick the rules refused (`pick()`): the route answers this status. */
  refused?: { status: 404 | 409; message: string };
  /** Rework loop: attempt slots this plan changed (the Queen writes them onto attempts rows). */
  slots: AttemptSlot[];
  /** Rework loop: an item's wait reason while its race is REWORKING (`awaiting rework (...)`); null clears it (Task 3 sets it). */
  reworkWaits: { itemId: string; waitReason: string | null }[];
}

const TERMINAL: ReadonlySet<TrainPhase> = new Set(["MERGED", "EJECTED"]);
/** Phases in which a car has pushed, so the next car can fork from it. */
const PUSHED: ReadonlySet<TrainPhase> = new Set(["DEPLOYING", "TESTING", "PASSED", "LANDING"]);
/** Preview states that may have left a live (or half-created) Worker Preview behind. */
const PREVIEW_EXISTS: ReadonlySet<DeployState> = new Set(["PENDING", "LIVE", "FAILED"]);
const ACTOR = "queen";

export function isActive(t: TrainRecord): boolean {
  return !TERMINAL.has(t.phase);
}

/** A QUEUE-lane train (merge car). Absent lane = BUILD. */
export function isCar(t: Pick<TrainRecord, "lane">): boolean {
  return t.lane === "QUEUE";
}

export function statusOf(phase: TrainPhase): TrainState {
  switch (phase) {
    case "WAITING_PARENT":
    case "BUILDING":
      return "BUILDING";
    // Pushed and being verified: deploying the preview is the first test step.
    case "DEPLOYING":
    case "TESTING":
    case "PASSED":
    case "LANDING":
      return "TESTING";
    default:
      return phase;
  }
}

/** Artifacts repo names allow alphanumerics, dots, hyphens and underscores. */
export function trainRepoName(namespace: string, trainId: string): string {
  return `${namespace}-train-${trainId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`;
}

/**
 * Whether `repo` is the fork named `name`, or a re-fork of it under `name-rN` (N ≥ 2; the Provisioner's and the
 * git proxy's retry names for a sick or ghost first fork, 1deb7ab). Nothing else: not `name-r2x`, not `name-r2-r3`.
 */
export function isForkOf(name: string, repo: string): boolean {
  if (repo === name) return true;
  if (!repo.startsWith(`${name}-r`)) return false;
  return /^[1-9]\d{0,2}$/.test(repo.slice(name.length + 2)) && Number(repo.slice(name.length + 2)) >= 2;
}

/** Deterministic, attempt-numbered command id: `<trainId>-<op>-<n>`. */
export function nextCommandId(trainId: string, op: string, previous: string | null): string {
  const n = previous ? Number(/-(\d+)$/.exec(previous)?.[1] ?? 0) + 1 : 1;
  return `${trainId}-${op}-${n}`;
}

export function commandAttempt(commandId: string | null): number {
  return commandId ? Number(/-(\d+)$/.exec(commandId)?.[1] ?? 0) : 0;
}

/**
 * Queen-started gates (GateCommand): how long a gate may run without a verdict before the watchdog re-dispatches
 * it (once per TESTING round), then sends the train down the infra path. A live gate takes 30–90 s, but its
 * inspect step may retry a sick repo for several minutes per attempt, so this is twice the command timeout.
 */
export const GATE_TIMEOUT_FACTOR = 2;
export const GATE_TIMEOUT_MS = GATE_TIMEOUT_FACTOR * DEFAULT_COMMAND_TIMEOUT_MS;

/**
 * Workflow instance id of the n-th Queen-started gate of a train head: `gate-<repo>-<head>-q<n>` (Workflows ids:
 * at most 100 characters of `[A-Za-z0-9_-]`; the middle is clipped, never the `-q<n>` suffix). It never equals
 * the push-triggered gate's id (`gate-<repo>-<head>`, gatekeepers `gateInstanceId`). Round d of TESTING (the d-th
 * preview deploy) uses n = 2d − 1, and its one watchdog re-dispatch n = 2d.
 */
export function gateCommandId(repo: string, head: string, n: number): string {
  const suffix = `-q${n}`;
  return `gate-${repo}-${head}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, MAX_GATE_COMMAND_ID - suffix.length) + suffix;
}

/** n of a gate command id (0 when none). */
export function gateAttempt(id: string | null | undefined): number {
  return id ? Number(/-q(\d+)$/.exec(id)?.[1] ?? 0) : 0;
}

/** The trace a train belongs to: its item's, else derived from its prompt id (= item id). */
export function traceOfTrain(t: Pick<TrainRecord, "traceId" | "promptId">): string {
  return t.traceId ?? traceIdFromUuid(t.promptId);
}

/** W3C trace context for a command or drone instance of `t` (span = spanIdFor(key)). */
export function traceFor(t: Pick<TrainRecord, "traceId" | "promptId">, key: string): TraceContext {
  return { traceparent: traceparent(traceOfTrain(t), spanIdFor(key)) };
}

/** Command-id field -> its watchdog clock (setTrain stamps the clock when the id changes). */
const ISSUED_AT = {
  forkCommandId: "forkIssuedAt",
  deleteCommandId: "deleteIssuedAt",
  deployCommandId: "deployIssuedAt",
  teardownCommandId: "teardownIssuedAt",
  gateCommandId: "gateIssuedAt",
} as const;

/**
 * How soon the alarm re-sends a drone the DO has not confirmed dispatched (a failed Workflows create, or a
 * crash between commit and create). Such a drone has no watchdog clock (droneIssuedAt is null until
 * dispatched), so without this it waited for whatever alarm happened to be armed (live: ~5 min).
 */
export const UNDISPATCHED_RETRY_MS = 15_000;

/** Whether the train's current-phase drone should be out but is not confirmed dispatched (reconcile sends it). */
function droneUndispatched(t: TrainRecord): boolean {
  return isActive(t) && !t.dispatched && !isContributed(t) && ((t.phase === "BUILDING" && t.forkState === "READY") || t.phase === "LANDING");
}

/** Whether the train's current-phase drone is out (dispatched, not yet reported). */
function droneOutstanding(t: TrainRecord): boolean {
  return isActive(t) && t.dispatched && !isContributed(t) && ((t.phase === "BUILDING" && t.forkState === "READY") || t.phase === "LANDING");
}

/**
 * Issue times of every command the train is waiting on (executor or drone).
 * A command without a clock (a row from before the watchdog) reports `now`.
 */
export function outstandingSince(t: TrainRecord, now: number): number[] {
  const out: (number | null)[] = [];
  if (t.forkState === "DELETING") out.push(t.deleteIssuedAt);
  if (t.deployState === "TEARING_DOWN") out.push(t.teardownIssuedAt);
  if (isActive(t)) {
    if (t.forkState === "PENDING") out.push(t.forkIssuedAt);
    if (t.phase === "DEPLOYING" && t.deployState === "PENDING") out.push(t.deployIssuedAt);
    if (droneOutstanding(t)) out.push(t.droneIssuedAt);
    if (carGateOutstanding(t)) out.push(t.deployIssuedAt);
  }
  return out.map((x) => x ?? now);
}

/**
 * A car waiting on its integration gate (TESTING, preview LIVE). The gatekeeper's inspect step can retry a
 * sick repo for far longer than COMMAND_TIMEOUT_MS, so the watchdog bounds it from the preview deploy's
 * issue time: past the timeout the car is retired like any car infra round (retireCar), and its members
 * re-board a fresh car. BUILD trains have no gate watchdog (unchanged).
 */
function carGateOutstanding(t: TrainRecord): boolean {
  return isActive(t) && isCar(t) && t.phase === "TESTING" && t.deployState === "LIVE";
}

/**
 * The train waits on its Queen-started gate: TESTING on a live preview, a gate issued, no verdict yet (a race
 * candidate that passed stays in TESTING until its race is decided; that gate has reported).
 */
export function gateOutstanding(t: TrainRecord): boolean {
  return isActive(t) && t.phase === "TESTING" && t.deployState === "LIVE" && !!t.gateCommandId && t.raceOutcome !== "PASSED";
}

/** In TESTING with no Queen-started gate and no verdict: a row from before v15 (reconcile gates it). */
function ungated(t: TrainRecord): boolean {
  return isActive(t) && t.phase === "TESTING" && t.deployState === "LIVE" && !t.gateCommandId && t.raceOutcome !== "PASSED";
}

/**
 * Repo a WAITING_PARENT train forks from now, or null while it must wait (`cars`: the active QUEUE cars):
 * - BUILD: hive main, unless a conflict / integration rework still waits for a car with seq ≤ waitForCarSeq;
 * - QUEUE: the car ahead once it has pushed (null until then), or main; a car that avoids a suspect car
 *   ahead (carForkGuard, waitForCarSeq) waits for every car up to it to be terminal, then forks from main.
 * The planner's scheduleFork runs carForkGuard first, which may still turn a car's "ready" into a wait.
 */
export function forkSourceOf(t: TrainRecord, cars: readonly TrainRecord[], namespace: string): string | null {
  const others = cars.filter((c) => c.trainId !== t.trainId && isActive(c) && isCar(c));
  const wait = t.waitForCarSeq;
  if (wait !== null && wait !== undefined) return others.some((c) => c.seq <= wait) ? null : namespace;
  if (!isCar(t)) return namespace;
  const ahead = others.filter((c) => c.seq < t.seq).sort((a, b) => a.seq - b.seq).at(-1);
  if (!ahead) return namespace;
  return PUSHED.has(ahead.phase) ? ahead.artifactRepo : null;
}

/**
 * A train still WAITING_PARENT although nothing it waits for is left (its car ahead pushed or ended, the car
 * its rework waits for is terminal). Every transition that frees a wait runs kick(), so this only happens when
 * a kick was missed; the alarm then forks it (reconcile → scheduleFork) instead of the train waiting forever.
 */
export function forkOverdue(t: TrainRecord, trains: readonly TrainRecord[]): boolean {
  if (!isActive(t) || t.phase !== "WAITING_PARENT") return false;
  // The namespace only names the fork source (main); readiness does not depend on it.
  return forkSourceOf(t, trains.filter((c) => isActive(c) && isCar(c)), "main") !== null;
}

/**
 * When the DO alarm must next run: the earliest `issuedAt + timeout` over
 * every outstanding command, or the earliest RACING race deadline or PICKING pick deadline (v2 / T9a; pass
 * `races`), a kept fork's delete-after deadline, or a WAITING_PARENT train whose wait is already over (forkOverdue,
 * UNDISPATCHED_RETRY_MS out), or null if none.
 */
export function watchdogDeadline(trains: readonly TrainRecord[], timeoutMs: number, now: number, races: readonly RaceRecord[] = []): number | null {
  const all = trains.flatMap((t) => outstandingSince(t, now)).map((x) => x + timeoutMs);
  for (const t of trains) {
    const at = infraRetryAt(t, now);
    if (at !== null) all.push(at);
    if (droneUndispatched(t)) all.push(now + UNDISPATCHED_RETRY_MS);
    if (forkOverdue(t, trains)) all.push(now + UNDISPATCHED_RETRY_MS);
    if ((keptFork(t) || keptLoser(t)) && t.deleteIssuedAt !== null) all.push(t.deleteIssuedAt);
    // BUILD gates (cars keep their retire watchdog, from the preview deploy: outstandingSince).
    if (gateOutstanding(t) && !isCar(t)) all.push(gateClock(t, now) + GATE_TIMEOUT_FACTOR * timeoutMs);
    if (ungated(t)) all.push(now + UNDISPATCHED_RETRY_MS);
  }
  for (const r of races) {
    // Only a future deadline: a past one (no live pass left, candidates pending) would re-arm the alarm at once, forever.
    if (r.state === "RACING" && r.deadlineAt !== null && r.deadlineAt > now) all.push(r.deadlineAt);
    // External hives: the race is decided no earlier than its entry window closing. Only a future close counts: once
    // it passed, a still-RACING race waits on candidates (own watchdogs), and a past time would spin the alarm.
    if (r.state === "RACING" && r.entryClosesAt != null && r.entryClosesAt > now) all.push(r.entryClosesAt);
    // T9a: a PICKING race auto-picks its recommendation at its pick deadline (queen:deadline).
    if (r.state === "PICKING" && r.pickDeadlineAt !== null && r.pickDeadlineAt !== undefined) all.push(r.pickDeadlineAt);
  }
  return all.length ? Math.min(...all) : null;
}

export function previewDeploymentId(trainId: string): string {
  return `preview-${trainId}`;
}

/**
 * The v1 War Room view of a train (the snapshot and `train.updated`). Kept
 * v1-shaped on purpose (migrations.test: a v7 hive's snapshot is unchanged by
 * v8–v11). v2 consumers use toMergeTrainV2 (WP2 switches the snapshot and
 * broadcasts to it together with the dashboard).
 */
export function toMergeTrain(t: TrainRecord): MergeTrain {
  return {
    trainId: t.trainId,
    baseSha: t.baseSha,
    includedPrompts: [...t.includedPrompts],
    artifactRepo: t.artifactRepo,
    status: t.status,
    createdAt: t.createdAt,
    phase: t.phase,
    reason: t.reason,
    summary: t.summary,
    headSha: t.headSha,
    landedSha: t.landedSha,
    previewUrl: t.previewUrl,
    model: t.model,
    modelReason: t.modelReason,
    memories: t.memories.map((m) => ({ ...m })),
  };
}

/** toMergeTrain plus the v2 fields that are set (lane only for cars: absent = BUILD). */
export function toMergeTrainV2(t: TrainRecord): MergeTrain {
  const v2: Partial<MergeTrain> = {};
  if (t.traceId) v2.traceId = t.traceId;
  if (t.raceId) v2.raceId = t.raceId;
  if (t.candidate !== null && t.candidate !== undefined) v2.candidate = t.candidate;
  if (t.raceOutcome) v2.raceOutcome = t.raceOutcome;
  if (t.score) v2.score = { ...t.score };
  if (t.lane === "QUEUE") v2.lane = "QUEUE";
  if (t.members) v2.members = [...t.members];
  if (t.carId) v2.carId = t.carId;
  if (t.passedSeq !== null && t.passedSeq !== undefined) v2.passedSeq = t.passedSeq;
  if (t.conflict) v2.conflict = { ...t.conflict, paths: [...t.conflict.paths] };
  if (t.changedPaths) v2.changedPaths = [...t.changedPaths];
  if (t.waitForCarSeq !== null && t.waitForCarSeq !== undefined) v2.waitForCarSeq = t.waitForCarSeq;
  if (t.lane === "QUEUE") v2.carSeq = t.seq;
  if (t.origin) v2.origin = { ...t.origin };
  if (t.attemptId) v2.attemptId = t.attemptId;
  return { ...toMergeTrain(t), ...v2 };
}

export function toPromptRun(p: PromptRecord): PromptRun {
  return {
    promptId: p.promptId,
    namespace: p.namespace,
    promptText: p.promptText,
    status: p.status,
    createdAt: p.createdAt,
  };
}

function copyTrain(t: TrainRecord): TrainRecord {
  return {
    ...t,
    includedPrompts: [...t.includedPrompts],
    memories: [...(t.memories ?? [])],
    ...(t.members ? { members: [...t.members] } : {}),
    ...(t.changedPaths ? { changedPaths: [...t.changedPaths] } : {}),
  };
}

/** How a fail() came about, for the rework it triggers. */
interface FailOptions {
  /** conflict → conflicts + 1 (D7), not attempts; integration / default → attempts + 1. */
  cause?: "conflict" | "integration";
  waitForCarSeq?: number | null;
  conflict?: MergeConflict | null;
  /** For a car: a gate verdict (bisect) or infrastructure. Default infra. */
  carCause?: queue.CarFailureCause;
  /** The failure summary (external hives: shown while the item awaits a new submission). */
  summary?: string;
}

export class TrainPlanner {
  private readonly prompts = new Map<string, PromptRecord>();
  private readonly trains: TrainRecord[];
  private maxTrainSeq: number;
  private maxPromptSeq: number;
  private maxPassedSeq: number;
  private readonly maxReworks: number;
  private readonly maxConflictReworks: number;
  private readonly timeoutMs: number;
  private readonly dirtyPrompts = new Map<string, boolean>(); // id -> broadcast?
  private readonly dirtyTrains = new Map<string, boolean>();
  private readonly deployments = new Map<string, Deployment>();
  private readonly dirtyDeployments = new Set<string>();
  private readonly races = new Map<string, RaceRecord>();
  private readonly dirtyRaces = new Set<string>();
  private readonly slots = new Map<string, AttemptSlot>();
  private readonly dirtySlots = new Set<string>();
  private readonly reworkWaits = new Map<string, string | null>();
  private readonly items = new Map<string, PlannerItem>();
  private readonly conflicts = new Map<string, number>();
  private readonly dirtyConflicts = new Set<string>();
  private effects: Effect[] = [];
  private events: EventDraft[] = [];
  private landed: { sha: string; trainIds: string[] } | null = null;
  private conflictClaims: { itemId: string; paths: string[] }[] = [];
  private modelDeltas: ModelStatDelta[] = [];
  private readonly modelStats: RouterStats[];
  private routerDispatches: number;
  private routerDirty = false;
  private floor: FloorState;
  private floorDirty = false;
  private carInfraFailures: number;
  private carInfraDirty = false;
  private executorLost = false;
  /** Car repos a car forked from failed on infra in this plan (carForkGuard: do not stack on them). */
  private readonly suspectRepos = new Set<string>();
  private infraFailed: { promptId: string; summary: string }[] = [];
  private awaitingContributor: { promptId: string; summary: string }[] = [];
  private abortedIntents: string[] = [];
  private picks: PickDelta[] = [];
  private refused: { status: 404 | 409; message: string } | null = null;
  private readonly hooks: QueueHooks;
  private readonly activeBuildsAtStart: number;
  private landing = false;
  private landAgain = false;

  constructor(
    state: HiveState,
    private readonly ctx: PlannerContext,
  ) {
    for (const p of state.prompts) this.prompts.set(p.promptId, { ...p });
    this.trains = state.trains.map(copyTrain);
    for (const d of state.deployments ?? []) this.deployments.set(d.deploymentId, { ...d });
    for (const r of state.races ?? []) this.races.set(r.raceId, { ...r, trainIds: [...r.trainIds] });
    for (const s of state.slots ?? []) this.slots.set(s.attemptId, { ...s, rework: s.rework ? { ...s.rework } : null });
    for (const i of state.items ?? []) {
      this.items.set(i.itemId, { ...i });
      if (i.conflicts !== undefined) this.conflicts.set(i.itemId, i.conflicts);
    }
    this.maxTrainSeq = state.maxTrainSeq;
    this.maxPromptSeq = state.maxPromptSeq;
    this.maxPassedSeq = Math.max(state.maxPassedSeq ?? 0, ...this.trains.map((t) => t.passedSeq ?? 0));
    this.modelStats = state.modelStats ?? [];
    this.routerDispatches = state.routerDispatches ?? 0;
    this.floor = { ...(state.routerFloor ?? INITIAL_FLOOR) };
    this.maxReworks = ctx.maxReworks ?? 2;
    this.maxConflictReworks = ctx.maxConflictReworks ?? DEFAULT_MAX_CONFLICT_REWORKS;
    this.timeoutMs = ctx.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.carInfraFailures = ctx.queue?.carInfraFailures ?? 0;
    this.hooks = { ...DEFAULT_QUEUE_HOOKS, ...(ctx.queue?.hooks ?? {}) };
    this.activeBuildsAtStart = this.activeBuilds();
  }

  // ── public transitions ────────────────────────────────────────────────

  /**
   * A prompt (a dispatched work item: promptId = itemId) gets its BUILD
   * train(s), forked from hive main at once. `raceWidth` > 1 starts a race
   * (the caller applied race.raceWidth(); the planner narrows it to the
   * number of distinct models the router can offer).
   */
  submit(input: { promptId: string; promptText: string; raceWidth?: number; difficulty?: "normal" | "hard"; item?: PlannerItem; attempts?: number }): PlanResult {
    // An item filed in the same decision (not in HiveState.items): its trace, priority and paths.
    if (input.item) {
      this.items.set(input.item.itemId, { ...input.item });
      if (input.item.conflicts !== undefined) this.conflicts.set(input.item.itemId, input.item.conflicts);
    }
    // T1: pushed code parked for this item is its build: resume it (no fork, no builder).
    const parked = this.active().filter((t) => t.promptId === input.promptId && isParked(t));
    if (parked.length) {
      const prompt = this.ensurePrompt(input.promptId, input.promptText, input.attempts ?? this.prompts.get(input.promptId)?.attempts ?? 0);
      this.setPromptStatus(prompt.promptId, "QUEUED");
      for (const t of parked) this.resumePushed(t);
      return this.finish("applied");
    }
    // External hive: there is no swarm to build; the item waits for a git-pushed submission. Defensive only:
    // the ledger dispatches an item in external mode solely when it has parked pushed code (handled above).
    if (this.ctx.external) {
      this.events.push({
        type: "train.phase",
        severity: "warn",
        actor: ACTOR,
        traceId: this.item(input.promptId)?.traceId ?? traceIdFromUuid(input.promptId),
        spanId: spanIdFor(input.promptId),
        itemId: input.promptId,
        summary: clip500(`item ${input.promptId}: external hive, no builder forked (awaiting a git-pushed submission)`),
        data: { external: true },
      });
      return this.finish("ignored:stale");
    }
    // A retried item re-submits its existing prompt id (attempts reset; filing order kept).
    const prev = this.prompts.get(input.promptId);
    const prompt: PromptRecord = {
      promptId: input.promptId,
      namespace: this.ctx.namespace,
      promptText: input.promptText,
      status: "QUEUED",
      createdAt: prev?.createdAt ?? this.ctx.now,
      seq: prev?.seq ?? ++this.maxPromptSeq,
      summary: null,
      attempts: 0,
      ...(input.raceWidth !== undefined ? { raceWidth: input.raceWidth } : {}),
      ...(input.difficulty !== undefined ? { difficulty: input.difficulty } : {}),
    };
    this.prompts.set(prompt.promptId, prompt);
    this.markPrompt(prompt);
    this.enqueue(prompt, "BUILD", input.raceWidth ?? 1);
    return this.finish("applied");
  }

  // ── T1: pushed submissions (pre-forked trains) ─────────────────────────

  /**
   * `gitIntent` accepted a push: a pre-forked BUILD train in BUILDING with `forkState: PENDING`. The proxy
   * forks hive main under `artifactRepo` itself; nothing is dispatched. `promptId` is the targeted item, or
   * the id intake will file the new item under. `forkIssuedAt` is the intent watchdog's clock.
   */
  intent(input: { trainId: string; promptId: string; origin: SubmissionOrigin; traceId?: string | null; promptText?: string; attemptId?: string }): PlanResult {
    if (this.find(input.trainId)) return this.finish("ignored:duplicate");
    // Every train row needs its prompt row (FK); `promptText` is passed when the item has none yet.
    if (input.promptText !== undefined) this.ensurePrompt(input.promptId, input.promptText, this.prompts.get(input.promptId)?.attempts ?? 0);
    const train: TrainRecord = {
      ...this.blankTrain(input.trainId, input.promptId, "BUILD"),
      phase: "BUILDING",
      status: "BUILDING",
      forkState: "PENDING",
      forkSource: this.ctx.namespace,
      forkCommandId: nextCommandId(input.trainId, "intent", null),
      forkIssuedAt: this.ctx.now,
      traceId: input.traceId ?? this.item(input.promptId)?.traceId ?? traceIdFromUuid(input.promptId),
      origin: { ...input.origin },
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    };
    this.trains.push(train);
    this.markTrain(train);
    this.event(train, {
      type: "train.enqueued",
      summary: clip500(`push intent: train ${train.trainId} (${train.artifactRepo}) for ${input.promptId} from ${input.origin.kind}:${input.origin.id}`),
      data: { action: "BUILD", lane: "BUILD", origin: input.origin, preForked: true },
    });
    return this.finish("applied");
  }

  /**
   * `gitPushed`: the push landed on the pre-forked train's `main`. The train becomes the item's submission:
   * it adopts the fork (READY, head, base), joins or creates the item's race when correlated, and enters the
   * pipeline exactly where a drone's build-result does (DEPLOYING → preview → gate), unless its item is not
   * ACTIVE yet (`resume: false`): then it is parked until the item is dispatched (paused, budget, capacity).
   */
  pushed(input: {
    trainId: string;
    /** The fork the push landed in: the intent's repo, or the proxy's `-rN` re-fork of it (adopted). */
    repo?: string;
    headSha: string;
    baseSha: string;
    origin: SubmissionOrigin;
    promptId: string;
    promptText: string;
    attempts: number;
    item: PlannerItem;
    race: { join: string } | { create: true } | null;
    resume: boolean;
    /**
     * `attemptRegate`, or a rework slot's fix (rework-loop spec §5.1): the attempt's head re-enters the race its previous
     * train is already a candidate of. Its entry window may have closed since: that is not a new entry, so the
     * closed-window guard does not apply. A REWORKING race may be rejoined too (only the winner's attempt is routed
     * there), and a push inside the attempt's open slot closes that slot (`closeSlotByPush`).
     */
    rejoin?: true;
  }): PlanResult {
    const t = this.find(input.trainId);
    if (!t || !isContributed(t)) return this.finish("ignored:unknown");
    if (!isActive(t)) return this.finish("ignored:stale");
    if (!awaitingPush(t)) return this.finish("ignored:duplicate");
    this.items.set(input.item.itemId, { ...input.item });
    const prompt = this.ensurePrompt(input.promptId, input.promptText, input.attempts);
    this.setTrain(t, {
      promptId: input.promptId,
      includedPrompts: [input.promptId],
      traceId: input.item.traceId ?? traceIdFromUuid(input.promptId),
      origin: { ...input.origin },
      headSha: input.headSha,
      baseSha: input.baseSha,
      forkState: "READY",
      artifactRepo: input.repo ?? t.artifactRepo,
    });
    let race = input.race && "join" in input.race ? this.races.get(input.race.join) : undefined;
    // Defensive (intake already files a follow-up): never join a race whose entry window has closed.
    const closedJoin = !input.rejoin && !!race && race.state === "RACING" && race.entryClosesAt != null && this.ctx.now >= race.entryClosesAt;
    // A rejoin (re-gate, rework slot fix) may also re-enter a REWORKING race: only the winner's attempt is routed there.
    const joinable = !!race && (race.state === "RACING" || (input.rejoin === true && race.state === "REWORKING"));
    if (race && (!joinable || closedJoin)) race = undefined;
    if (race) {
      const anyPassed = race.trainIds.some((id) => {
        const x = this.find(id);
        return !!x && isActive(x) && x.raceOutcome === "PASSED";
      });
      this.setRace(race, { trainIds: [...race.trainIds, t.trainId] });
      this.setTrain(t, { raceId: race.raceId, candidate: race.trainIds.length - 1, raceOutcome: "RACING" }, false);
      this.event(t, {
        type: "train.enqueued",
        summary: clip500(`pushed train ${t.trainId} joined race ${race.raceId} as candidate ${race.trainIds.length} (${input.origin.kind})`),
        data: { action: "BUILD", lane: "BUILD", raceId: race.raceId, candidate: race.trainIds.length - 1, origin: input.origin, joined: true },
      });
      if (input.rejoin) this.closeSlotByPush(t, race, anyPassed);
    } else if (input.race && !closedJoin) {
      const raceId = this.ctx.newId();
      const window = input.item.entryWindowMs ?? this.ctx.entryWindowMs ?? 0;
      const created: RaceRecord = {
        raceId,
        itemId: input.promptId,
        width: 1,
        state: "RACING",
        trainIds: [t.trainId],
        winnerTrainId: null,
        reason: null,
        deadlineAt: null,
        createdAt: this.ctx.now,
        decidedAt: null,
        entryClosesAt: window > 0 ? this.ctx.now + window : null,
      };
      this.races.set(raceId, created);
      this.dirtyRaces.add(raceId);
      this.setTrain(t, { raceId, candidate: 0, raceOutcome: "RACING" }, false);
      this.events.push({
        type: "race.started",
        actor: ACTOR,
        traceId: traceOfTrain(t),
        spanId: spanIdFor(raceId),
        parentSpanId: spanIdFor(input.promptId),
        itemId: input.promptId,
        trainId: t.trainId,
        summary: clip500(`race ${raceId}: opened for a ${input.origin.kind} submission (train ${t.trainId})`),
        data: { raceId, width: 1, trainIds: [t.trainId], models: [], action: "BUILD", origin: input.origin },
      });
    }
    if (input.resume) {
      this.resumePushed(t);
    } else {
      this.setPromptStatus(prompt.promptId, "QUEUED");
    }
    return this.finish("applied");
  }

  /** A parked (or just pushed) contributed train enters the pipeline: preview deploy, then the gate. */
  private resumePushed(t: TrainRecord): void {
    if (!isParked(t)) return;
    this.setTrain(t, { phase: "DEPLOYING" });
    this.promptStatus(t, "IN_TRAIN");
    this.deployPreview(t);
  }

  /**
   * `gitAborted` (or a newer push of the same branch replacing a stale intent): the push never landed.
   * The intent's train is EJECTED with no attempt charged and its fork, if the proxy made one, is deleted.
   * A train that was already pushed is never aborted (ignored:stale).
   */
  abort(trainId: string, reason: string): PlanResult {
    const t = this.find(trainId);
    if (!t || !isContributed(t)) return this.finish("ignored:unknown");
    if (!isActive(t)) return this.finish("ignored:duplicate");
    if (!awaitingPush(t)) return this.finish("ignored:stale");
    this.endIntent(t, `push aborted: ${reason}`);
    return this.finish("applied");
  }

  private endIntent(t: TrainRecord, reason: string): void {
    this.eject(t, clip500(reason));
    this.abortedIntents.push(t.trainId);
  }

  /**
   * A re-push of the same branch replaces the contributor's train while it is not yet in a car (§6.2):
   * EJECTED ("superseded by push <sha>", race outcome LOST), no attempt charged, fork deleted, preview torn
   * down. Call it AFTER the new train joined the race, so the race does not decide without it.
   */
  supersede(trainId: string, byHead: string): PlanResult {
    const t = this.find(trainId);
    if (!t || !isContributed(t)) return this.finish("ignored:unknown");
    if (!isActive(t)) return this.finish("ignored:stale");
    if (awaitingPush(t)) {
      this.endIntent(t, `superseded by push ${byHead.slice(0, 7)} before it landed`);
      return this.finish("applied");
    }
    if (t.carId || t.phase === "LANDING") return this.finish("ignored:stale");
    const race = this.racingRaceOf(t);
    this.eject(t, `superseded by push ${byHead.slice(0, 7)}`, race ? { raceOutcome: "LOST" } : {});
    if (race) this.maybeDecide(race);
    this.maybeLand();
    return this.finish("applied");
  }

  /** v17: the attempt reached a terminal state: delete its fork once, through this (its current) train's Provisioner DELETE. */
  deleteAttemptFork(trainId: string): PlanResult {
    const t = this.find(trainId);
    if (!t || !t.attemptId) return this.finish("ignored:unknown");
    if (t.forkState === "DELETING" || t.forkState === "DELETED") return this.finish("ignored:duplicate");
    this.setTrain(t, { forkState: "DELETING", deleteCommandId: nextCommandId(t.trainId, "delete", t.deleteCommandId) }, false);
    this.emitDelete(t);
    return this.finish("applied");
  }

  /**
   * v17 `end_attempt`: the contributor withdraws a candidate that has not boarded a car: EJECTED (race outcome LOST
   * while its race is RACING, which may decide it), no attempt charged. When it was the item's only live train the
   * item awaits a contributor (FAILED, reopened by the next push) instead of staying ACTIVE with nothing to build.
   */
  withdraw(trainId: string, reason: string): PlanResult {
    const t = this.find(trainId);
    if (!t || !isContributed(t)) return this.finish("ignored:unknown");
    if (!isActive(t)) return this.finish("ignored:stale");
    if (t.carId || t.phase === "LANDING") return this.finish("ignored:stale");
    const race = this.racingRaceOf(t);
    this.eject(t, clip500(`withdrawn: ${reason}`), race ? { raceOutcome: "LOST" } : {});
    if (race?.state === "REWORKING") {
      this.abandonRework(race, `the winner's attempt withdrew its fix (${reason})`);
      return this.finish("applied");
    }
    if (race) this.maybeDecide(race);
    // Rework loop (§4, §5.6, pre-flight F4): a REWORK slot still holding the RACING race keeps the item open; the race's
    // own resolution (decide, or the fallback at the slot's end) settles it, never a FAILED item mid-slot.
    const held = race?.state === "RACING" && race.trainIds.some((id) => this.find(id)?.raceOutcome === "REWORK");
    if (!held && !this.trains.some((x) => isActive(x) && !isCar(x) && x.promptId === t.promptId)) this.awaitContributor(t.promptId, `withdrawn: ${reason}`);
    this.maybeLand();
    return this.finish("applied");
  }

  /**
   * Rework loop (§5.6): the attempt ended (end_attempt, or the watchdog expired it). Its REWORK candidate leaves its RACING
   * race (FAILED; the race then decides), and a REWORKING race whose winner is this attempt falls back. Its slot closes.
   * Call it after `withdraw` (which handles an active train). `ignored:stale` when it held nothing.
   */
  attemptEnded(attemptId: string, why: string): PlanResult {
    let changed = false;
    for (const race of [...this.races.values()]) {
      if (race.state === "REWORKING") {
        if (this.find(race.winnerTrainId ?? "")?.attemptId !== attemptId) continue;
        this.abandonRework(race, `attempt ${attemptId} ended (${why})`);
        changed = true;
      } else if (race.state === "RACING") {
        const rework = race.trainIds.map((id) => this.find(id)).filter((x): x is TrainRecord => !!x && x.attemptId === attemptId && x.raceOutcome === "REWORK");
        if (!rework.length) continue;
        for (const x of rework) this.endRework(x, "FAILED", `attempt ${attemptId} ended (${why})`);
        this.maybeDecide(race);
        changed = true;
      }
    }
    const s = this.slots.get(attemptId);
    if (s?.rework) {
      this.setSlot({ ...s, rework: null });
      changed = true;
    }
    this.maybeLand();
    return this.finish(changed ? "applied" : "ignored:stale");
  }

  /**
   * The contributor hands a FAILED item to the swarm (§6.3, `workAction handoff`): a REWORK as for drones,
   * under maxReworks, forked FROM the rejected submission's kept fork when it still exists. The item's
   * prompt row is passed in (a FAILED prompt is not in the warm state).
   */
  handoff(input: { promptId: string; promptText: string; summary: string | null; attempts: number; item: PlannerItem }): PlanResult {
    this.items.set(input.item.itemId, { ...input.item, handoff: true });
    const p = this.ensurePrompt(input.promptId, input.promptText, input.attempts);
    if (input.summary) this.setPromptSummary(p.promptId, input.summary);
    this.rework(p.promptId);
    this.maybeLand();
    return this.finish("applied");
  }

  /** The prompt row of an item, created (or refreshed) for a pushed or handed-off submission. */
  private ensurePrompt(promptId: string, promptText: string, attempts: number): PromptRecord {
    const prev = this.prompts.get(promptId);
    if (prev) {
      if (prev.attempts !== attempts || prev.promptText !== promptText) {
        prev.attempts = attempts;
        prev.promptText = promptText;
        this.markPrompt(prev, false);
      }
      return prev;
    }
    const prompt: PromptRecord = {
      promptId,
      namespace: this.ctx.namespace,
      promptText,
      status: "QUEUED",
      createdAt: this.ctx.now,
      seq: ++this.maxPromptSeq,
      summary: null,
      attempts,
    };
    this.prompts.set(promptId, prompt);
    this.markPrompt(prompt);
    return prompt;
  }

  /** The blank row every new BUILD / QUEUE train starts from. */
  private blankTrain(trainId: string, promptId: string, action: TrainAction): TrainRecord {
    return {
      trainId,
      baseSha: "",
      includedPrompts: [promptId],
      artifactRepo: trainRepoName(this.ctx.namespace, trainId),
      status: "BUILDING",
      createdAt: this.ctx.now,
      seq: ++this.maxTrainSeq,
      promptId,
      phase: "WAITING_PARENT",
      forkState: "NONE",
      forkSource: null,
      headSha: null,
      landedSha: null,
      summary: null,
      reason: null,
      action,
      dispatched: false,
      forkCommandId: null,
      deleteCommandId: null,
      deployState: "NONE",
      deployCommandId: null,
      teardownCommandId: null,
      previewUrl: null,
      forkIssuedAt: null,
      deleteIssuedAt: null,
      deployIssuedAt: null,
      teardownIssuedAt: null,
      droneIssuedAt: null,
      droneAttempt: 1,
      model: null,
      modelReason: null,
      modelChoice: null,
      modelChoiceAttempt: null,
      modelOutcome: null,
      modelProbe: false,
      memories: [],
      traceId: null,
      lane: "BUILD",
      raceId: null,
      candidate: null,
      raceOutcome: null,
      carId: null,
      passedSeq: null,
      waitForCarSeq: null,
    };
  }

  /** The Provisioner reports a FORK or DELETE outcome (matched by command id). */
  provisionResult(r: ProvisionResult): PlanResult {
    const t = this.find(r.trainId);
    if (!t) return this.finish("ignored:unknown");
    return r.op === "FORK" ? this.forkResult(t, r) : this.deleteResult(t, r);
  }

  private forkResult(t: TrainRecord, r: ProvisionResult): PlanResult {
    if (r.commandId !== t.forkCommandId) return this.finish("ignored:stale"); // an older attempt
    if (!isActive(t)) {
      // Ejected while the fork was in flight: a created fork is an orphan.
      if (r.ok && t.forkState !== "DELETING") this.deleteFork(t);
      return this.finish("ignored:stale");
    }
    if (t.forkState !== "PENDING") return this.finish("ignored:duplicate");
    if (!r.ok) {
      this.forkFailed(t, r.summary || `Provisioner could not fork ${t.forkSource ?? "the hive repo"}`);
      return this.finish("applied");
    }
    this.setTrain(t, {
      forkState: "READY",
      baseSha: r.baseSha ?? t.baseSha,
      artifactRepo: r.artifactRepo ?? t.artifactRepo,
      memories: r.memories ?? [],
      dispatched: false,
      droneAttempt: 1,
    });
    this.promptStatus(t, "BUILDING");
    this.dispatchBuilder(t);
    return this.finish("applied");
  }

  /** A fork attempt failed (ok:false or timed out): retry under a new command id, or fail the train. */
  private forkFailed(t: TrainRecord, summary: string): void {
    if (commandAttempt(t.forkCommandId) < MAX_FORK_ATTEMPTS) {
      // Retry with a new command (Workflow instance ids are single-use).
      this.setTrain(t, { phase: "WAITING_PARENT", forkState: "NONE" }, false);
      this.scheduleFork(t);
    } else {
      this.promptSummary(t, summary);
      this.infraExhausted(t, `fork failed: ${summary}`);
    }
  }

  private deleteResult(t: TrainRecord, r: ProvisionResult): PlanResult {
    if (r.commandId !== t.deleteCommandId) return this.finish("ignored:stale");
    if (t.forkState !== "DELETING") return this.finish("ignored:duplicate");
    // Bookkeeping only: a failed delete is recorded, never retried in a loop.
    this.setTrain(t, { forkState: r.ok ? "DELETED" : "DELETE_FAILED" }, false);
    return this.finish("applied");
  }

  /** The Herald reports a preview DEPLOY or TEARDOWN outcome (matched by command id). */
  deployResult(r: DeployResult): PlanResult {
    const t = r.trainId ? this.find(r.trainId) : this.trains.find((x) => x.deployCommandId === r.commandId || x.teardownCommandId === r.commandId);
    if (!t || r.environment !== "preview") return this.finish("ignored:unknown");
    if (r.op === "DEPLOY") return this.previewDeployed(t, r);
    if (r.op === "TEARDOWN") return this.previewTornDown(t, r);
    return this.finish("ignored:unknown");
  }

  private previewDeployed(t: TrainRecord, r: DeployResult): PlanResult {
    if (r.commandId !== t.deployCommandId) return this.finish("ignored:stale");
    if (!isActive(t)) {
      // The deploy finished after the train ended (it was never seen LIVE) and
      // its teardown was already issued: the preview may have been re-created
      // behind that teardown, so tear it down again. Recording the URL makes a
      // duplicate of this late report a no-op.
      const seen = this.deployments.get(previewDeploymentId(t.trainId))?.url ?? t.previewUrl;
      if (r.ok && !seen) {
        this.setDeployment(t, { url: r.url ?? null });
        this.teardownPreview(t, true);
      }
      return this.finish("ignored:stale");
    }
    if (t.deployState !== "PENDING") return this.finish("ignored:duplicate");
    if (t.phase !== "DEPLOYING") return this.finish("ignored:premature");
    const commitSha = r.commitSha ?? t.headSha;
    if (!r.ok || !r.url) {
      const summary = r.summary || (r.ok ? "Herald reported a deploy without a preview URL." : "Preview deploy failed.");
      // Infrastructure (5xx / 429 past Herald's retries): not the change's fault. Re-deploy after a backoff.
      if (!r.ok && r.retryable) this.infraRetry(t, `preview deploy failed: ${summary}`);
      else this.previewFailed(t, summary, commitSha, r.versionId ?? null);
      return this.finish("applied");
    }
    this.setTrain(t, { deployState: "LIVE", previewUrl: r.url, phase: "TESTING" });
    this.setDeployment(t, { status: "LIVE", url: r.url, versionId: r.versionId ?? null, commitSha, summary: r.summary ?? null });
    this.dispatchGate(t, deployGateRound(t));
    return this.finish("applied");
  }

  /** A preview deploy failed (ok:false, no URL, or timed out for the last time). */
  private previewFailed(t: TrainRecord, summary: string, commitSha: string | null, versionId: string | null, infra = false): void {
    this.setTrain(t, { deployState: "FAILED" }, false);
    this.setDeployment(t, { status: "FAILED", summary, commitSha, versionId });
    this.promptSummary(t, summary);
    if (infra) this.infraExhausted(t, `preview deploy failed: ${summary}`);
    else this.fail(t, `preview deploy failed: ${summary}`, { carCause: "infra" });
  }

  private previewTornDown(t: TrainRecord, r: DeployResult): PlanResult {
    if (r.commandId !== t.teardownCommandId) return this.finish("ignored:stale");
    if (t.deployState !== "TEARING_DOWN") return this.finish("ignored:duplicate");
    if (r.ok) {
      this.setTrain(t, { deployState: "TORN_DOWN" }, false);
      this.setDeployment(t, { status: "TORN_DOWN" });
    } else {
      this.teardownFailed(t, r.summary ?? "unknown error");
    }
    return this.finish("applied");
  }

  private teardownFailed(t: TrainRecord, summary: string): void {
    this.setTrain(t, { deployState: "TEARDOWN_FAILED" }, false);
    this.setDeployment(t, { status: "FAILED", summary: `teardown failed: ${summary}`.slice(0, 500) });
  }

  /** The DO dispatched the drone for the train's current phase. Internal only. */
  dispatched(trainId: string, phase: TrainPhase): PlanResult {
    const t = this.find(trainId);
    if (!t || t.phase !== phase || t.dispatched) return this.finish("ignored:stale");
    this.setTrain(t, { dispatched: true }, false);
    return this.finish("applied");
  }

  /** A builder pushed the BUILD train head: deploy its preview (DEPLOYING). Nothing forks from a build train. */
  buildResult(r: BuildResult): PlanResult {
    const t = this.find(r.trainId);
    if (!t || isCar(t)) return this.finish("ignored:unknown"); // cars report mergeResult
    if (!isActive(t)) return this.finish("ignored:stale");
    if (t.phase !== "BUILDING") return this.finish("ignored:duplicate");
    if (t.forkState !== "READY") return this.finish("ignored:premature");
    this.recordBuild(t, r);
    this.setTrain(t, {
      phase: "DEPLOYING",
      headSha: r.headSha,
      ...(r.changedPaths ? { changedPaths: [...r.changedPaths] } : {}),
      ...(r.verified !== undefined ? { verified: r.verified } : {}),
    });
    this.promptStatus(t, "IN_TRAIN");
    this.deployPreview(t);
    return this.finish("applied");
  }

  /** The MERGE drone's report for a car (`trainId` = car id). Guards as buildResult's. */
  mergeResult(r: MergeResult): PlanResult {
    const car = this.find(r.trainId);
    if (!car || !isCar(car)) return this.finish("ignored:unknown");
    if (!isActive(car)) return this.finish("ignored:stale");
    if (car.phase !== "BUILDING") return this.finish("ignored:duplicate");
    if (car.forkState !== "READY") return this.finish("ignored:premature");
    if (!r.ok && r.cause === "infra") return this.driveInfraFailure(car, r);
    this.applyQueue(this.hooks.mergeResult(car, r, this.trains, this.queueContext()));
    if (isActive(car) && car.phase === "BUILDING") {
      // The queue left the car where it was (e.g. ok:false without a decision): an infra failure.
      this.fail(car, r.summary || "MERGE drone failed (nothing pushed)", { carCause: "infra" });
    }
    this.maybeLand();
    return this.finish("applied");
  }

  /** A gatekeeper reports the test verdict (a BUILD train's full gate, or a car's integration gate). */
  trainResult(r: TrainResult): PlanResult {
    const t = this.find(r.trainId);
    if (!t) return this.finish("ignored:unknown");
    if (!isActive(t)) return this.finish("ignored:stale");
    if (t.phase === "PASSED" || t.phase === "LANDING") return this.finish("ignored:duplicate");
    if (t.raceOutcome === "PASSED") return this.finish("ignored:duplicate"); // a race candidate already passed
    if (t.phase === "WAITING_PARENT" || t.forkState !== "READY") {
      return this.finish("ignored:premature");
    }
    // A gate the Queen replaced (watchdog re-dispatch, a later TESTING round) is not this round's judge.
    if (r.gateId && !r.commandId && t.gateCommandId && r.gateId !== t.gateCommandId) return this.finish("ignored:stale");
    // A pass must come from testing the live preview; a failure (e.g. the
    // builder giving up) is honoured in any phase.
    if (r.passed && t.phase !== "TESTING") return this.finish("ignored:premature");
    // The gate itself could not run (gatekeepers report in TESTING, without a drone commandId). Contributed code on a
    // live preview: re-gate the same head (its own budget); anything else: re-deploy, re-gate.
    if (!r.passed && r.cause === "infra" && t.phase === "TESTING" && !r.commandId) {
      if (!isCar(t) && isContributed(t) && t.deployState === "LIVE") this.regateInfra(t, `gate could not run: ${r.summary}`);
      else this.infraRetry(t, `gate could not run: ${r.summary}`);
      return this.finish("applied");
    }
    if (!r.passed && r.cause === "infra" && !isCar(t)) return this.builderInfraFailure(t, r);
    if (isCar(t)) {
      if (!r.passed) {
        this.fail(t, r.summary, { carCause: "gate" });
      } else {
        this.setTrain(t, { phase: "PASSED", summary: r.summary, headSha: r.commitSha ?? t.headSha, ...(r.score ? { score: r.score } : {}) });
        this.maybeLand();
      }
      return this.finish("applied");
    }
    this.promptSummary(t, r.summary);
    this.recordVerdict(t, r.passed);
    if (!r.passed) {
      this.setTrain(t, { summary: r.summary, ...(r.score ? { score: r.score } : {}) }, false);
      this.fail(t, r.summary);
      return this.finish("applied");
    }
    const race = this.racingRaceOf(t);
    if (race?.state === "REWORKING") {
      this.reworkWon(t, race, r);
      return this.finish("applied");
    }
    if (race) {
      // A candidate stays in TESTING until the race is decided.
      this.setTrain(t, { raceOutcome: "PASSED", summary: r.summary, headSha: r.commitSha ?? t.headSha, score: r.score ?? null });
      // The others get the grace after the first pass, or after the entry window closes when that is later
      // (a candidate that entered just before the close still gets its grace).
      if (race.deadlineAt === null) this.setRace(race, { deadlineAt: Math.max(this.ctx.now, race.entryClosesAt ?? 0) + (this.ctx.raceGraceMs ?? RACE_GRACE_MS) });
      this.maybeDecide(race);
      return this.finish("applied");
    }
    this.pass(t, { summary: r.summary, headSha: r.commitSha ?? t.headSha, ...(r.score ? { score: r.score } : {}) });
    this.maybeLand();
    return this.finish("applied");
  }

  /** The lander confirms (or fails) the push of a head (a car's, or a direct-landing build's) to hive main. */
  landResult(r: LandResult): PlanResult {
    const t = this.find(r.trainId);
    if (!t) return this.finish("ignored:unknown");
    if (!isActive(t)) return this.finish("ignored:stale");
    if (t.phase !== "LANDING") return this.finish("ignored:premature");
    if (!r.landed && r.cause === "infra") return this.driveInfraFailure(t, r);
    if (!r.landed) {
      this.landFailed(t, r.summary || "lander could not push the train head to main");
      return this.finish("applied");
    }
    const sha = r.mainSha ?? t.headSha ?? null;
    if (isCar(t)) {
      this.applyQueue(this.hooks.carLanded(t, sha ?? "", this.trains, this.queueContext()));
      if (isActive(t)) this.setTrain(t, { phase: "MERGED", landedSha: sha });
      this.cleanUp(t); // the car's own fork and preview (idempotent: applyQueue may have issued them)
      const members = (t.members ?? []).filter((id) => this.find(id)?.phase === "MERGED");
      if (sha) this.landed = { sha, trainIds: members };
    } else {
      this.setTrain(t, { phase: "MERGED", landedSha: r.mainSha ?? null });
      this.deleteFork(t);
      this.teardownPreview(t);
      this.promptStatus(t, "MERGED");
      if (r.summary) this.promptSummary(t, r.summary);
      if (sha) this.landed = { sha, trainIds: [t.trainId] };
    }
    this.maybeLand();
    return this.finish("applied");
  }

  /**
   * A MERGE / LAND drone whose transient Artifacts errors (5xx / 429) outlasted its own retries (the drone
   * backs off in-step, and the Workflow retries 10/20/40 s, before it reports). Not a verdict, no member charge.
   * MERGE: the car is RETIRED after this one round (retireCar: members re-board a fresh car, not stacked on a
   * suspect repo). LAND: the SAME car's lander is re-dispatched under the next attempt (the car already passed
   * its gate); past MAX_COMMAND_ATTEMPTS, landFailed. A report from an attempt other than the current one is stale.
   */
  private driveInfraFailure(t: TrainRecord, r: MergeResult | LandResult): PlanResult {
    if (!droneOutstanding(t)) return this.finish("ignored:stale");
    if (r.commandId && r.commandId !== droneInstanceId({ trainId: t.trainId, action: t.phase === "LANDING" ? "LAND" : "MERGE" }, t.droneAttempt)) {
      return this.finish("ignored:stale");
    }
    const summary = r.summary || "drone hit an infrastructure error";
    // A car's MERGE drone: retire the car (members re-board a fresh fork); a LANDER retries the same car.
    if (isCar(t) && t.phase === "BUILDING") this.retireCar(t, `MERGE drone hit infra: ${summary}`);
    else this.redispatchDrone(t, summary, true);
    return this.finish("applied");
  }

  private landFailed(t: TrainRecord, summary: string): void {
    this.promptSummary(t, summary);
    this.fail(t, summary, { carCause: "infra" });
  }

  /**
   * Crash / failure recovery (DO alarm). First the watchdog (see watchdog()),
   * then re-dispatch every pending command (same command id, so a command
   * that did start is not started twice), re-deriving a pending fork's
   * source, plus undispatched drones; then due race deadlines and the queue.
   */
  reconcile(): PlanResult {
    this.watchdog();
    for (const t of this.trains) {
      if (t.forkState === "DELETING") {
        if (!t.deleteCommandId) this.setTrain(t, { deleteCommandId: nextCommandId(t.trainId, "delete", null) }, false);
        this.emitDelete(t);
      }
      if (t.deployState === "TEARING_DOWN") {
        if (!t.teardownCommandId) this.setTrain(t, { teardownCommandId: nextCommandId(t.trainId, "teardown", null) }, false);
        this.emitTeardown(t);
      }
    }
    this.releaseKeptForks();
    for (const t of this.active()) {
      if (isContributed(t) && (t.phase === "BUILDING" || t.phase === "WAITING_PARENT")) {
        // Pre-forked: the proxy forks and pushes; nothing to (re-)send. The intent watchdog bounds it.
        continue;
      } else if (t.phase === "WAITING_PARENT") {
        this.scheduleFork(t);
      } else if (t.forkState === "PENDING") {
        const source = this.forkSourceFor(t);
        if (source === null) {
          // A car whose predecessor was ejected / re-formed: wait for the new one.
          this.setTrain(t, { phase: "WAITING_PARENT", forkState: "NONE", forkSource: null });
        } else {
          if (source !== t.forkSource || !t.forkCommandId) {
            // New params need a new command (instance ids are single-use).
            this.setTrain(t, { forkSource: source, forkCommandId: nextCommandId(t.trainId, "fork", t.forkCommandId) }, false);
          }
          this.emitFork(t);
        }
      } else if (t.phase === "BUILDING" && t.forkState === "READY" && !t.dispatched) {
        this.dispatchBuilder(t);
      } else if (t.phase === "DEPLOYING" && t.deployState === "PENDING") {
        this.emitDeploy(t);
      } else if (t.phase === "DEPLOYING" && t.deployState === "NONE") {
        this.deployPreview(t);
      } else if (awaitingInfraRetry(t) && (infraRetryAt(t, this.ctx.now) ?? 0) <= this.ctx.now) {
        this.deployPreview(t);
      } else if (t.phase === "LANDING" && !t.dispatched) {
        this.dispatchLander(t);
      } else if (gateOutstanding(t)) {
        // Same instance id: a gate that did start is not started twice (createOrExisting).
        this.emitGate(t);
      } else if (ungated(t)) {
        // In TESTING from before Queen-started gates (v15): its push-event gate may have given up long ago.
        this.dispatchGate(t, deployGateRound(t));
      }
    }
    this.expireSlots();
    for (const race of [...this.races.values()]) {
      if (race.state === "RACING" || race.state === "PICKING") this.maybeDecide(race);
    }
    this.maybeLand();
    return this.finish("applied");
  }

  /**
   * A builder drone that could not run for infrastructure reasons (Workers AI
   * rate limits past every retry). Not a verdict: no rework, no model failure,
   * the router floor untouched. The drone is re-dispatched under the next
   * attempt, exactly as the watchdog does for a lost drone (and with the same
   * attempt cap, past which it fails like a lost drone). A report from an
   * attempt other than the current one is stale (the watchdog already moved on).
   */
  private builderInfraFailure(t: TrainRecord, r: TrainResult): PlanResult {
    if (!droneOutstanding(t) || t.phase !== "BUILDING") return this.finish("ignored:stale");
    if (r.commandId && r.commandId !== droneInstanceId({ trainId: t.trainId, action: t.action }, t.droneAttempt)) return this.finish("ignored:stale");
    this.redispatchDrone(t, r.summary, true);
    return this.finish("applied");
  }

  /**
   * Re-issue an outstanding builder / lander drone under the next attempt, or give up past the cap.
   * `infra` (the drone reported an infrastructure failure): past the cap, infraExhausted (EXECUTOR_LOST).
   */
  private redispatchDrone(t: TrainRecord, summary: string, infra = false): void {
    const lander = t.phase === "LANDING";
    if (t.droneAttempt < MAX_COMMAND_ATTEMPTS) {
      this.setTrain(t, { dispatched: false, droneAttempt: t.droneAttempt + 1 }, false);
      if (lander) this.dispatchLander(t);
      else this.dispatchBuilder(t);
    } else if (lander) {
      this.landFailed(t, summary);
    } else if (infra) {
      this.promptSummary(t, summary);
      this.infraExhausted(t, summary);
    } else {
      // Same path as a builder giving up (a failed trainResult); a car: infra.
      this.promptSummary(t, summary);
      this.fail(t, summary, { carCause: "infra" });
    }
  }

  /**
   * Executors can die without reporting (a crashed Workflow, a lost RPC).
   * Any FORK / DELETE / DEPLOY / TEARDOWN command or drone task outstanding
   * for `commandTimeoutMs` is re-issued under a NEW command id (new drone
   * instance id), so a result for the old id is ignored as stale. After the
   * attempt cap it takes the same path as an `ok:false` result.
   */
  private watchdog(): void {
    const now = this.ctx.now;
    const expired = (at: number | null) => at !== null && now - at >= this.timeoutMs;
    const late = (what: string, id: string | null) =>
      `${what}${id ? ` ${id}` : ""} did not report within ${Math.round(this.timeoutMs / 60_000)} min (executor lost?)`;
    // Snapshot: fail() appends re-queued trains, which are fresh.
    for (const t of [...this.trains]) {
      if (t.forkState === "DELETING" && expired(t.deleteIssuedAt)) {
        if (commandAttempt(t.deleteCommandId) < MAX_COMMAND_ATTEMPTS) this.deleteFork(t);
        else this.setTrain(t, { forkState: "DELETE_FAILED", deleteIssuedAt: null }, false);
      }
      if (t.deployState === "TEARING_DOWN" && expired(t.teardownIssuedAt)) {
        if (commandAttempt(t.teardownCommandId) < MAX_COMMAND_ATTEMPTS) this.teardownPreview(t, true);
        else this.teardownFailed(t, late("Herald TEARDOWN", t.teardownCommandId));
      }
      if (!isActive(t)) continue;
      if (awaitingPush(t)) {
        if (expired(t.forkIssuedAt)) this.endIntent(t, `push intent expired: no gitPushed within ${Math.round(this.timeoutMs / 60_000)} min`);
        continue;
      }
      if (t.forkState === "PENDING" && expired(t.forkIssuedAt)) {
        this.forkFailed(t, late("Provisioner FORK", t.forkCommandId));
      } else if (t.phase === "DEPLOYING" && t.deployState === "PENDING" && expired(t.deployIssuedAt)) {
        if (commandAttempt(t.deployCommandId) < MAX_COMMAND_ATTEMPTS) this.deployPreview(t);
        else this.previewFailed(t, late("Herald DEPLOY", t.deployCommandId), t.headSha, null, true);
      } else if (gateOutstanding(t) && !isCar(t) && now - gateClock(t, now) >= GATE_TIMEOUT_FACTOR * this.timeoutMs) {
        const n = gateAttempt(t.gateCommandId);
        const mins = Math.round((GATE_TIMEOUT_FACTOR * this.timeoutMs) / 60_000);
        // Once per TESTING round (odd n: the round's first gate): a fresh gate instance; then the infra path.
        if (n % 2 === 1) this.dispatchGate(t, n + 1, `gate ${t.gateCommandId} did not report within ${mins} min; re-gating`);
        else this.infraRetry(t, `gate did not report within ${mins} min, twice (${t.gateCommandId})`);
      } else if (carGateOutstanding(t) && expired(t.deployIssuedAt ?? now)) {
        this.retireCar(t, `integration gate did not report within ${Math.round(this.timeoutMs / 60_000)} min of the preview deploy (sick repo?)`);
      } else if (droneOutstanding(t) && expired(t.droneIssuedAt)) {
        this.redispatchDrone(t, late(t.phase === "LANDING" ? "LANDER drone" : isCar(t) ? "MERGE drone" : "BUILDER drone", null));
      }
    }
  }

  // ── internals: lanes ──────────────────────────────────────────────────

  private active(): TrainRecord[] {
    return this.trains.filter(isActive).sort((a, b) => a.seq - b.seq);
  }

  /** Active QUEUE cars in seq order. */
  private cars(): TrainRecord[] {
    return this.active().filter(isCar);
  }

  /** Active BUILD trains (slots, §2.3.1). */
  private activeBuilds(): number {
    return this.trains.filter((t) => isActive(t) && !isCar(t)).length;
  }

  private find(trainId: string): TrainRecord | undefined {
    return this.trains.find((t) => t.trainId === trainId);
  }

  private item(promptId: string): PlannerItem | undefined {
    return this.items.get(promptId);
  }

  /**
   * Repo to fork from, or null to wait:
   * - BUILD: hive main, unless a conflict / integration rework still waits for
   *   a car with seq ≤ waitForCarSeq to become terminal;
   * - QUEUE: the car ahead once it has pushed (null until then), or main; a car that
   *   avoids a suspect car ahead (carForkGuard, waitForCarSeq) waits for it to be
   *   terminal, then forks from main.
   */
  private forkSourceFor(t: TrainRecord): string | null {
    return forkSourceOf(t, this.cars(), this.ctx.namespace);
  }

  /** Build slots still free for rework races (the plan's own usage included). */
  private slotsFree(): number {
    const base = this.ctx.race?.slotsFree ?? Number.POSITIVE_INFINITY;
    return base + this.activeBuildsAtStart - this.activeBuilds();
  }

  private enqueue(prompt: PromptRecord, action: TrainAction, width = 1, opts: { waitForCarSeq?: number | null } = {}): TrainRecord[] {
    const item = this.item(prompt.promptId);
    const traceId = item?.traceId ?? traceIdFromUuid(prompt.promptId);
    let choices: ModelChoice[] = [];
    if (width > 1) {
      choices = this.routeRaceFor(prompt, action, width);
      width = choices.length;
    }
    const raceId = width > 1 ? this.ctx.newId() : null;
    const created: TrainRecord[] = [];
    for (let candidate = 0; candidate < width; candidate++) {
      const trainId = this.ctx.newId();
      const choice = raceId ? choices[candidate]! : null;
      const train: TrainRecord = {
        trainId,
        baseSha: "", // resolved from the fork once it exists
        includedPrompts: [prompt.promptId],
        artifactRepo: trainRepoName(this.ctx.namespace, trainId),
        status: "BUILDING",
        createdAt: this.ctx.now,
        seq: ++this.maxTrainSeq,
        promptId: prompt.promptId,
        phase: "WAITING_PARENT",
        forkState: "NONE",
        forkSource: null,
        headSha: null,
        landedSha: null,
        summary: null,
        reason: null,
        action,
        dispatched: false,
        forkCommandId: null,
        deleteCommandId: null,
        deployState: "NONE",
        deployCommandId: null,
        teardownCommandId: null,
        previewUrl: null,
        forkIssuedAt: null,
        deleteIssuedAt: null,
        deployIssuedAt: null,
        teardownIssuedAt: null,
        droneIssuedAt: null,
        droneAttempt: 1,
        model: choice?.model ?? null,
        modelReason: choice?.reason ?? null,
        modelChoice: choice,
        modelChoiceAttempt: choice ? 1 : null,
        modelOutcome: null,
        modelProbe: false,
        memories: [],
        traceId,
        lane: "BUILD",
        raceId,
        candidate: raceId ? candidate : null,
        raceOutcome: raceId ? "RACING" : null,
        carId: null,
        passedSeq: null,
        waitForCarSeq: opts.waitForCarSeq ?? null,
      };
      this.trains.push(train);
      this.markTrain(train);
      created.push(train);
      this.event(train, {
        type: "train.enqueued",
        summary: `${action} train ${trainId} for ${prompt.promptId}${raceId ? ` (race ${raceId} candidate ${candidate + 1}/${width})` : ""}`,
        data: { action, lane: "BUILD", raceId, candidate: raceId ? candidate : null, waitForCarSeq: opts.waitForCarSeq ?? null, model: choice?.model ?? null },
      });
    }
    if (raceId) {
      const race: RaceRecord = {
        raceId,
        itemId: prompt.promptId,
        width,
        state: "RACING",
        trainIds: created.map((t) => t.trainId),
        winnerTrainId: null,
        reason: null,
        deadlineAt: null,
        createdAt: this.ctx.now,
        decidedAt: null,
      };
      this.races.set(raceId, race);
      this.dirtyRaces.add(raceId);
      this.events.push({
        type: "race.started",
        actor: ACTOR,
        traceId,
        spanId: spanIdFor(raceId),
        parentSpanId: spanIdFor(prompt.promptId),
        itemId: prompt.promptId,
        summary: `race ${raceId}: ${width} candidates on ${choices.map((c) => c.model).join(", ")}`,
        data: { raceId, width, trainIds: race.trainIds, models: choices.map((c) => c.model), action },
      });
    }
    this.setPromptStatus(prompt.promptId, "QUEUED");
    for (const t of created) this.scheduleFork(t);
    return created;
  }

  private scheduleFork(t: TrainRecord): void {
    if (t.phase !== "WAITING_PARENT") return;
    this.carForkGuard(t);
    const source = this.forkSourceFor(t);
    if (source === null) return;
    this.setTrain(t, {
      phase: "BUILDING",
      forkState: "PENDING",
      forkSource: source,
      forkCommandId: nextCommandId(t.trainId, "fork", t.forkCommandId),
    });
    this.emitFork(t);
  }

  /** Fork every train that can now (a waiting rework whose car ended, a car whose predecessor pushed). */
  private kick(): void {
    for (const t of this.active()) if (t.phase === "WAITING_PARENT") this.scheduleFork(t);
  }

  private emitFork(t: TrainRecord): void {
    this.effects.push({
      type: "provision",
      trainId: t.trainId,
      command: {
        op: "FORK",
        commandId: t.forkCommandId!,
        hive: this.ctx.namespace,
        trainId: t.trainId,
        sourceRepo: t.forkSource!,
        ...seedFrom(this.seedOf(t)),
        forkName: t.artifactRepo,
        ...this.recallQuery(t),
        trace: traceFor(t, t.forkCommandId!),
      },
    });
  }

  /** What the Provisioner recalls hive memories for: the train's prompt (a pure function of it, so re-dispatches match). Cars recall nothing. */
  private recallQuery(t: TrainRecord): { recallQuery?: string } {
    if (isCar(t)) return {};
    const text = this.prompts.get(t.promptId)?.promptText;
    return text ? { recallQuery: text.slice(0, MAX_RECALL_QUERY) } : {};
  }

  private emitDelete(t: TrainRecord): void {
    this.effects.push({
      type: "provision",
      trainId: t.trainId,
      command: { op: "DELETE", commandId: t.deleteCommandId!, hive: this.ctx.namespace, trainId: t.trainId, repo: t.artifactRepo, trace: traceFor(t, t.deleteCommandId!) },
    });
  }

  private deployPreview(t: TrainRecord): void {
    if (!t.headSha) return;
    this.setTrain(t, { deployState: "PENDING", deployCommandId: nextCommandId(t.trainId, "deploy", t.deployCommandId) }, false);
    this.setDeployment(t, { status: "PENDING", url: null, versionId: null, commitSha: t.headSha, summary: null });
    this.emitDeploy(t);
  }

  private emitDeploy(t: TrainRecord): void {
    this.effects.push({
      type: "deploy",
      trainId: t.trainId,
      command: {
        op: "DEPLOY",
        commandId: t.deployCommandId!,
        hive: this.ctx.namespace,
        environment: "preview",
        trainId: t.trainId,
        artifactRepo: t.artifactRepo,
        commitSha: t.headSha!,
        trace: traceFor(t, t.deployCommandId!),
      },
    });
  }

  /**
   * Start the n-th Queen-started gate of the train's head (GateCommand). The gatekeeper's GateTarget names it
   * (`gateId`), so the push-triggered gate and any replaced gate stand down; its report carries `gateId`.
   */
  private dispatchGate(t: TrainRecord, n: number, why?: string, notBefore: number | null = null): void {
    if (!t.headSha) return;
    this.setTrain(t, { gateCommandId: gateCommandId(t.artifactRepo, t.headSha, n), gateNotBefore: notBefore }, false);
    if (why) this.event(t, { type: "command.result", severity: "warn", summary: clip500(`train ${t.trainId}: ${why}`), data: { kind: "gate", outcome: "lost", next: t.gateCommandId } });
    this.emitGate(t);
  }

  private emitGate(t: TrainRecord): void {
    if (!t.headSha || !t.gateCommandId) return;
    this.effects.push({
      type: "gate",
      trainId: t.trainId,
      command: {
        kind: "gate",
        commandId: t.gateCommandId,
        hive: this.ctx.namespace,
        trainId: t.trainId,
        repo: t.artifactRepo,
        branch: "main",
        after: t.headSha,
        trace: traceFor(t, t.gateCommandId),
        ...(t.gateNotBefore ? { notBefore: t.gateNotBefore } : {}),
      },
    });
  }

  /**
   * Issue a preview TEARDOWN (a new command each time). `force` re-issues one
   * even while another is in flight: a deploy that completed late may have
   * re-created the preview behind the earlier teardown.
   */
  private teardownPreview(t: TrainRecord, force = false): void {
    if (t.deployCommandId === null) return; // never deployed
    if (t.deployState === "TEARING_DOWN" && !force) return;
    this.setTrain(t, { deployState: "TEARING_DOWN", teardownCommandId: nextCommandId(t.trainId, "teardown", t.teardownCommandId) }, false);
    this.emitTeardown(t);
  }

  private emitTeardown(t: TrainRecord): void {
    this.effects.push({
      type: "deploy",
      trainId: t.trainId,
      command: { op: "TEARDOWN", commandId: t.teardownCommandId!, hive: this.ctx.namespace, environment: "preview", trainId: t.trainId, trace: traceFor(t, t.teardownCommandId!) },
    });
  }

  private setDeployment(t: TrainRecord, patch: Partial<Deployment>): void {
    const id = previewDeploymentId(t.trainId);
    const prev: Deployment = this.deployments.get(id) ?? {
      deploymentId: id,
      hive: this.ctx.namespace,
      environment: "preview",
      trainId: t.trainId,
      status: "PENDING",
      url: null,
      versionId: null,
      commitSha: null,
      percent: null,
      summary: null,
      updatedAt: this.ctx.now,
    };
    this.deployments.set(id, { ...prev, ...patch, updatedAt: this.ctx.now });
    this.dirtyDeployments.add(id);
  }

  /** A car pushed: the car behind it can fork from it. */
  private scheduleSuccessor(car: TrainRecord): void {
    const next = this.cars().find((x) => x.seq > car.seq);
    if (next) this.scheduleFork(next);
  }

  /** A BUILD train passed its gate (or won its race): it takes a queue ticket and waits to board. */
  private pass(t: TrainRecord, patch: Partial<TrainRecord>): void {
    // passedAt is the "passed at" clock the queue reads to compute queue-wait on landing.
    this.setTrain(t, { ...patch, phase: "PASSED", passedSeq: ++this.maxPassedSeq, passedAt: this.ctx.now });
    this.promptStatus(t, "IN_TRAIN");
  }

  /** Re-entrancy-safe: fail() inside a queue decision may ask to land again. */
  private maybeLand(): void {
    if (this.landing) {
      this.landAgain = true;
      return;
    }
    this.landing = true;
    try {
      let rounds = 0;
      do {
        this.landAgain = false;
        this.landStep();
      } while (this.landAgain && ++rounds < 16);
    } finally {
      this.landing = false;
    }
  }

  private landStep(): void {
    if (this.ctx.queue) {
      // Passed builds board cars; the head car lands once every car ahead merged.
      this.applyQueue(this.hooks.formCars(this.trains, this.queueContext()));
      const head = this.cars()[0];
      if (head?.phase === "PASSED") {
        this.setTrain(head, { phase: "LANDING", dispatched: false, droneAttempt: 1 });
        this.dispatchLander(head);
      }
    } else if (!this.active().some((t) => !isCar(t) && t.phase === "LANDING")) {
      // Direct landing (no merge queue): one build at a time, in ticket order.
      const next = this.active()
        .filter((t) => !isCar(t) && t.phase === "PASSED")
        .sort((a, b) => (a.passedSeq ?? Number.MAX_SAFE_INTEGER) - (b.passedSeq ?? Number.MAX_SAFE_INTEGER) || a.seq - b.seq)[0];
      if (next) {
        this.setTrain(next, { phase: "LANDING", dispatched: false, droneAttempt: 1 });
        this.dispatchLander(next);
      }
    }
    this.kick();
  }

  // ── internals: failure ────────────────────────────────────────────────

  /**
   * The train's preview deploy or gate failed on infrastructure: no attempt charged, no rework.
   * Park it (DEPLOYING, deploy FAILED, clock = now) and let the alarm re-deploy the preview after
   * infraRetryDelayMs (the gatekeeper waiting on the train re-gates once it is back in TESTING).
   * Past MAX_INFRA_ATTEMPTS deploys: infraExhausted. A car is never parked: retireCar.
   */
  private infraRetry(t: TrainRecord, summary: string): void {
    if (isCar(t)) {
      this.setDeployment(t, { status: "FAILED", summary: clip500(`${summary} (infrastructure: car retired)`) });
      this.retireCar(t, summary);
      return;
    }
    const n = commandAttempt(t.deployCommandId);
    if (n >= MAX_INFRA_ATTEMPTS) {
      this.setTrain(t, { deployState: "FAILED" }, false);
      this.setDeployment(t, { status: "FAILED", summary: clip500(summary) });
      this.promptSummary(t, summary);
      this.infraExhausted(t, `${summary} (after ${n} attempts)`);
      return;
    }
    this.setTrain(t, { phase: "DEPLOYING", deployState: "FAILED", deployIssuedAt: this.ctx.now });
    const delay = infraRetryDelayMs(t);
    this.setDeployment(t, { status: "FAILED", summary: clip500(`${summary} (infrastructure: retry ${n}/${MAX_INFRA_ATTEMPTS - 1} in ${Math.round(delay / 1000)} s)`) });
    this.event(t, {
      type: "train.phase",
      severity: "warn",
      summary: clip500(`${isCar(t) ? "car" : "train"} ${t.trainId} infra retry ${n}/${MAX_INFRA_ATTEMPTS - 1} in ${Math.round(delay / 1000)} s: ${summary}`),
      data: { from: "TESTING", to: "DEPLOYING", lane: t.lane ?? "BUILD", infraRetry: n, delayMs: delay },
    });
  }

  /**
   * A contributed train's gate could not run: re-gate the same head (no re-deploy) after gateInfraBackoffMs, under the
   * next gate round's id with GateCommand.notBefore, up to MAX_GATE_INFRA_ROUNDS times; then gateInfraExhausted.
   */
  private regateInfra(t: TrainRecord, summary: string): void {
    const k = (t.gateInfraRounds ?? 0) + 1;
    if (k > MAX_GATE_INFRA_ROUNDS) {
      this.gateInfraExhausted(t, summary, k - 1);
      return;
    }
    const delay = gateInfraBackoffMs(t, k);
    const previous = t.gateCommandId ?? null;
    this.setTrain(t, { gateInfraRounds: k }, false);
    this.dispatchGate(t, nextGateRound(previous), undefined, this.ctx.now + delay);
    this.event(t, {
      type: "command.result",
      severity: "warn",
      summary: clip500(`train ${t.trainId} gate infra: re-gate ${k}/${MAX_GATE_INFRA_ROUNDS} of the same head in ${Math.round(delay / 1000)} s: ${summary}`),
      data: { kind: "gate", outcome: "infra", previous, next: t.gateCommandId, gateInfraRound: k, of: MAX_GATE_INFRA_ROUNDS, delayMs: delay },
    });
  }

  /**
   * The re-gates are spent: an INFRA verdict, not a rejection. The summary carries INFRA_SUMMARY_PREFIX (the durable
   * marker, `isInfraStopped`); then infraExhausted: a race candidate fails like any candidate (ejected, the race decides
   * or abandons, the item awaits its contributor); a train outside a race is ejected with EXECUTOR_LOST on its item.
   * The item is not reopened: the agent decides (`attemptRegate`, or a new push).
   */
  private gateInfraExhausted(t: TrainRecord, summary: string, rounds: number): void {
    const s = clip500(`${INFRA_SUMMARY_PREFIX}gate could not run after ${rounds + 1} tries: ${summary}`);
    this.setTrain(t, { summary: s, gateNotBefore: null }, false);
    this.promptSummary(t, s);
    // infraExhausted: a race candidate fails alone (its summary already carries the prefix); a contributed train
    // outside a race keeps the EXECUTOR_LOST path (never a REWORK drone, never a silent FAILED).
    this.infraExhausted(t, s);
  }

  /**
   * An executor kept failing on infrastructure (infra retries or command attempts spent). A car:
   * the queue's infra path (members return to the pool; 3 in a row → EXECUTOR_LOST on the hive).
   * A race candidate: ejected alone, as any failed candidate. A build: EJECTED and its prompt
   * FAILED with attempts unchanged, reported in `infraFailed` (EXECUTOR_LOST on the item).
   */
  private infraExhausted(t: TrainRecord, summary: string): void {
    if (!isActive(t)) return;
    if (isCar(t)) {
      this.fail(t, summary, { carCause: "infra" });
      return;
    }
    if (this.racingRaceOf(t)) {
      // A race candidate is ejected alone; its summary marks it infra-stopped (never read as a rejection).
      this.fail(t, summary.startsWith(INFRA_SUMMARY_PREFIX) ? summary : `${INFRA_SUMMARY_PREFIX}${summary}`, { carCause: "infra" });
      return;
    }
    this.eject(t, `failed on infrastructure: ${summary}`);
    const p = this.prompts.get(t.promptId);
    if (p) {
      this.setPromptSummary(p.promptId, summary);
      this.setPromptStatus(p.promptId, "FAILED");
      this.infraFailed.push({ promptId: p.promptId, summary: clip500(summary) });
    }
    this.maybeLand();
  }

  private fail(t: TrainRecord, summary: string, opts: FailOptions = {}): void {
    if (!isActive(t)) return;
    if (isCar(t)) {
      this.failCar(t, summary, opts.carCause ?? "infra");
      return;
    }
    // Rework loop (§5.3): a race winner (an attempt's train) ejected from its car by a conflict or an integration failure.
    if (opts.cause && t.attemptId && t.raceOutcome === "WON" && this.ctx.rework) {
      const won = t.raceId ? this.races.get(t.raceId) : undefined;
      if (won && won.state === "DECIDED" && won.winnerTrainId === t.trainId) {
        this.winnerRejected(t, won, summary, opts);
        return;
      }
    }
    const race = opts.cause ? undefined : this.racingRaceOf(t);
    if (race) {
      this.raceCandidateFailed(t, race, summary);
      return;
    }
    if (isContributed(t)) {
      // Human / agent code (§6.2): its fork is kept for a handoff; no auto-rework unless handed off.
      this.ejectKeepingFork(t, `failed: ${summary}`, opts.conflict ? { conflict: opts.conflict } : {});
      if (this.handoffOf(t.promptId)) this.rework(t.promptId, opts);
      else this.awaitContributor(t.promptId, summary);
      this.maybeLand();
      return;
    }
    this.eject(t, `failed: ${summary}`, opts.conflict ? { conflict: opts.conflict } : {});
    this.rework(t.promptId, { ...opts, summary });
    this.maybeLand();
  }

  /** The contributor handed this item to the swarm. */
  private handoffOf(promptId: string): boolean {
    // An external hive has no swarm: a handoff (a `Queen: rework` trailer, or one made before a switch) never reworks.
    return !this.ctx.external && this.item(promptId)?.handoff === true;
  }

  /** A contributed item's code was rejected: the prompt FAILS and the item waits for its contributor (no escalation). */
  private awaitContributor(promptId: string, summary: string): void {
    const p = this.prompts.get(promptId);
    if (!p) return;
    this.setPromptSummary(p.promptId, clip500(summary));
    this.setPromptStatus(p.promptId, "FAILED");
    this.awaitingContributor.push({ promptId: p.promptId, summary: clip500(summary) });
  }

  /** EJECTED like eject(), but the fork is kept until `now + KEEP_FORK_MS` (deleteIssuedAt) for a handoff. */
  private ejectKeepingFork(t: TrainRecord, reason: string, extra: Partial<TrainRecord> = {}): void {
    if (t.forkState !== "READY") {
      this.eject(t, reason, extra);
      return;
    }
    this.setTrain(t, { ...extra, phase: "EJECTED", reason, deleteIssuedAt: this.ctx.now + KEEP_FORK_MS });
    if (PREVIEW_EXISTS.has(t.deployState)) this.teardownPreview(t);
  }

  /** The newest kept fork of a prompt (a REWORK's seed: the contributor's rejected head). */
  private seedOf(t: TrainRecord): { repo: string; headSha: string } | null {
    if (t.action !== "REWORK" || isCar(t) || !this.handoffOf(t.promptId)) return null;
    const kept = this.trains.filter((x) => keptFork(x) && x.promptId === t.promptId && x.headSha).sort((a, b) => a.seq - b.seq).at(-1);
    return kept ? { repo: kept.artifactRepo, headSha: kept.headSha! } : null;
  }

  /**
   * Delete kept forks no longer needed for a handoff (alarm): past their delete-after deadline, or once the
   * item left FAILED and no REWORK of it is active (a seeded REWORK forks from, and is briefed by, the newest one).
   */
  private releaseKeptForks(): void {
    for (const t of this.trains) {
      // T9a: a picked race's loser keeps its fork until the winner is terminal or LOSER_FORK_KEEP_MS ran out.
      if (keptLoser(t)) {
        const winner = this.trains.find((x) => x.raceId === t.raceId && x.raceOutcome === "WON" && x.trainId !== t.trainId);
        if (releaseLoser(t, winner, this.ctx.now)) this.deleteFork(t);
        continue;
      }
      if (!keptFork(t)) continue;
      const due = t.deleteIssuedAt === null || this.ctx.now >= t.deleteIssuedAt;
      const newest = !this.trains.some((x) => keptFork(x) && x.promptId === t.promptId && x.seq > t.seq);
      const reworking = this.trains.some((x) => isActive(x) && !isCar(x) && x.promptId === t.promptId && x.action === "REWORK");
      const needed = newest && (this.item(t.promptId)?.status === "FAILED" || reworking);
      if (due || !needed) this.deleteFork(t);
    }
  }

  /** The prompt's train failed: EJECTED, then a REWORK (or FAILED past the cap). */
  private rework(promptId: string, opts: FailOptions = {}): void {
    const failed = this.prompts.get(promptId);
    if (!failed) return;
    // External hive: no drone REWORK, handed off or not; the item awaits a new submission.
    if (this.ctx.external) {
      this.awaitContributor(promptId, opts.summary ?? failed.summary ?? "failed; awaiting a new submission");
      return;
    }
    let exhausted: boolean;
    if (opts.cause === "conflict") {
      const n = (this.conflicts.get(promptId) ?? 0) + 1;
      this.conflicts.set(promptId, n);
      this.dirtyConflicts.add(promptId);
      exhausted = n > this.maxConflictReworks;
    } else {
      failed.attempts += 1;
      exhausted = failed.attempts > this.maxReworks;
    }
    this.setPromptStatus(failed.promptId, "EJECTED");
    this.effects.push({
      type: "broadcast",
      message: { type: "prompt.updated", promptRun: toPromptRun(failed) },
    });
    if (exhausted) {
      this.setPromptStatus(failed.promptId, "FAILED");
    } else {
      this.enqueue(failed, "REWORK", this.reworkWidth(failed), { waitForCarSeq: opts.waitForCarSeq ?? null });
    }
  }

  private reworkWidth(p: PromptRecord): number {
    const race = this.ctx.race;
    if (!race) return 1;
    return raceWidth({
      action: "REWORK",
      bestOf: this.item(p.promptId)?.bestOf ?? null,
      modelPin: this.ctx.modelPin ?? null,
      race,
      maxRaceWidth: race.maxRaceWidth,
      slotsFree: this.slotsFree(),
      remainingCredits: race.remainingCredits ?? null,
    });
  }

  private eject(t: TrainRecord, reason: string, extra: Partial<TrainRecord> = {}): void {
    this.setTrain(t, { ...extra, phase: "EJECTED", reason });
    this.cleanUp(t);
  }

  /** Delete the fork and tear the preview down, unless that is already under way. */
  private cleanUp(t: TrainRecord): void {
    if (t.forkState === "PENDING" || t.forkState === "READY") this.deleteFork(t);
    if (PREVIEW_EXISTS.has(t.deployState)) this.teardownPreview(t);
  }

  private deleteFork(t: TrainRecord): void {
    // v17: an attempt's trains share one fork that the ATTEMPT owns. A train never deletes it on its own teardown
    // (supersede, eject, landing, a kept fork's release): it only lets go of it (`NONE`). The Queen deletes the fork
    // once, on the attempt's terminal transition, through deleteAttemptFork. A DELETE already in flight (DELETING:
    // the watchdog re-sends it) goes on as before.
    if (t.attemptId && t.forkState !== "DELETING") {
      if (t.forkState === "PENDING" || t.forkState === "READY") this.setTrain(t, { forkState: "NONE" }, false);
      return;
    }
    this.setTrain(t, { forkState: "DELETING", deleteCommandId: nextCommandId(t.trainId, "delete", t.deleteCommandId) }, false);
    this.emitDelete(t);
  }

  // ── internals: merge queue ────────────────────────────────────────────

  private queueContext(): queue.QueueContext {
    return {
      namespace: this.ctx.namespace,
      now: this.ctx.now,
      newId: this.ctx.newId,
      settings: this.ctx.queue?.settings ?? { maxQueueBatch: 1, maxQueueDepth: 1 },
      priorityOf: this.ctx.priorityOf ?? ((promptId) => this.item(promptId)?.priority ?? 2),
      carInfraFailures: this.carInfraFailures,
      paused: (this.ctx.queue?.paused ?? false) || this.executorLost,
    };
  }

  /** A car failed: queue.carFailed decides (supersede, bisect, integration rework, infra count). */
  private failCar(car: TrainRecord, summary: string, cause: queue.CarFailureCause, opts?: queue.CarFailedOptions): void {
    // The repo this car forked from may be sick (forks inherit it): no replacement car stacks on it.
    if (cause === "infra" && car.forkSource && car.forkSource !== this.ctx.namespace) this.suspectRepos.add(car.forkSource);
    const ctx = this.queueContext();
    this.applyQueue(opts ? this.hooks.carFailed(car, summary, cause, this.trains, ctx, opts) : this.hooks.carFailed(car, summary, cause, this.trains, ctx));
    if (isActive(car)) this.eject(car, `failed: ${summary}`);
    this.maybeLand();
  }

  /**
   * A car hit infra once, on its preview deploy, integration gate or MERGE drone (that executor's own
   * retries already spent). Its repo, or the car ahead it forked from, may be "sick" (Artifacts 503s for
   * minutes after a push; forks inherit it), so it is not re-deployed / re-gated / re-merged: the queue's
   * infra path retires it (EJECTED "retired on infra …", later cars superseded, members back to the pool
   * with no charge), formCars boards them on a fresh car, and carForkGuard keeps that car off the suspect
   * fork source. Counts toward EXECUTOR_LOST at CAR_INFRA_RETIREMENTS_BEFORE_LOST (queue.ts).
   */
  private retireCar(car: TrainRecord, summary: string): void {
    if (!isActive(car)) return;
    this.failCar(car, summary, "infra", { retired: true });
  }

  /**
   * The car ahead `t` would stack on is suspect when a car forked from it just failed on infra (this plan,
   * or a retired car still loaded), or it is itself in an infra retry (a re-dispatched LANDER, a parked
   * preview). Forking from it would likely inherit its sick repo.
   */
  private suspectCar(ahead: TrainRecord): string | null {
    if (this.suspectRepos.has(ahead.artifactRepo)) return `a car forked from it failed on infra`;
    const retired = this.trains.find(
      (x) => isCar(x) && x.phase === "EJECTED" && x.forkSource === ahead.artifactRepo && (x.reason ?? "").startsWith(queue.RETIRED_ON_INFRA),
    );
    if (retired) return `car ${retired.trainId} forked from it retired on infra`;
    if (awaitingInfraRetry(ahead)) return "it is waiting out an infra retry";
    if (ahead.phase === "LANDING" && ahead.droneAttempt > 1) return `its LANDER is on attempt ${ahead.droneAttempt}`;
    return null;
  }

  /**
   * Fork-source rule for a car about to fork (WAITING_PARENT, not already waiting): when the car ahead is
   * suspect, do not stack on it. Forking from hive main at once would test a tree without the car ahead and
   * could never fast-forward main after it lands, so the car WAITS for every car up to the one ahead to be
   * terminal (persisted as waitForCarSeq, the BUILD rework rule) and then forks from main. If that car
   * fails instead, this car is superseded as usual (it carries the car's prompts) and its members re-board.
   */
  private carForkGuard(t: TrainRecord): void {
    if (!isCar(t) || t.phase !== "WAITING_PARENT" || (t.waitForCarSeq ?? null) !== null) return;
    const ahead = this.cars()
      .filter((c) => c.seq < t.seq)
      .at(-1);
    if (!ahead) return;
    const why = this.suspectCar(ahead);
    if (!why) return;
    this.setTrain(t, { waitForCarSeq: ahead.seq }, false);
    this.event(t, {
      type: "queue.car",
      severity: "warn",
      summary: clip500(`car ${t.trainId} will not fork from car ${ahead.trainId} (${why}); it forks from main once ${ahead.trainId} has landed`),
      data: { carId: t.trainId, avoided: ahead.trainId, waitForCarSeq: ahead.seq, reason: why },
    });
  }

  /**
   * Apply a queue decision: materialise new cars, apply patches through
   * setTrain (then react to phase changes: car pushed → preview + successor;
   * member MERGED → prompt MERGED), take the queue's own effects and events
   * (its fork DELETEs / TEARDOWNs of trains it ejected or merged), then fail()
   * each MemberFailure.
   */
  private applyQueue(d: queue.QueueDecision): void {
    const moved: [TrainRecord, TrainPhase][] = [];
    for (const { trainId, patch } of d.patches) {
      const t = this.find(trainId);
      if (!t) continue;
      const before = t.phase;
      this.setTrain(t, patch);
      if (t.phase !== before) moved.push([t, before]);
    }
    this.effects.push(...d.effects);
    this.events.push(...d.events);
    if (d.carInfraFailures !== undefined && d.carInfraFailures !== this.carInfraFailures) {
      this.carInfraFailures = d.carInfraFailures;
      this.carInfraDirty = true;
    }
    if (d.executorLost) this.executorLost = true;
    for (const draft of d.cars) this.materializeCar(draft);
    for (const [t] of moved) {
      if (isCar(t)) {
        if (t.phase === "DEPLOYING" && t.deployState === "NONE") this.deployPreview(t);
        if (PUSHED.has(t.phase)) this.scheduleSuccessor(t);
      } else if (t.phase === "MERGED") {
        this.promptStatus(t, "MERGED");
      }
      if (!isActive(t)) this.cleanUp(t); // no-op when the queue already issued the commands
    }
    for (const f of d.failures) {
      const t = this.find(f.trainId);
      if (!t || !isActive(t)) continue;
      this.promptSummary(t, f.summary);
      if (f.claimPaths.length) this.conflictClaims.push({ itemId: t.promptId, paths: [...f.claimPaths] });
      this.fail(t, f.summary, { cause: f.cause, waitForCarSeq: f.waitForCarSeq, conflict: f.conflict });
    }
  }

  private materializeCar(draft: queue.CarDraft): void {
    if (this.find(draft.carId)) return;
    const members = draft.members.map((id) => this.find(id)).filter((t): t is TrainRecord => !!t);
    const first = members[0];
    const car: TrainRecord = {
      trainId: draft.carId,
      baseSha: "",
      includedPrompts: [...draft.includedPrompts],
      artifactRepo: trainRepoName(this.ctx.namespace, draft.carId),
      status: "BUILDING",
      createdAt: this.ctx.now,
      seq: ++this.maxTrainSeq,
      promptId: first?.promptId ?? draft.includedPrompts.at(-1) ?? draft.carId,
      phase: "WAITING_PARENT",
      forkState: "NONE",
      forkSource: null,
      headSha: null,
      landedSha: null,
      summary: null,
      reason: null,
      action: "BUILD",
      dispatched: false,
      forkCommandId: null,
      deleteCommandId: null,
      deployState: "NONE",
      deployCommandId: null,
      teardownCommandId: null,
      previewUrl: null,
      forkIssuedAt: null,
      deleteIssuedAt: null,
      deployIssuedAt: null,
      teardownIssuedAt: null,
      droneIssuedAt: null,
      droneAttempt: 1,
      model: null,
      modelReason: null,
      modelChoice: null,
      modelChoiceAttempt: null,
      modelOutcome: null,
      modelProbe: false,
      memories: [],
      traceId: first ? traceOfTrain(first) : null,
      lane: "QUEUE",
      members: [...draft.members],
      bisectOf: draft.bisectOf,
    };
    this.trains.push(car);
    this.markTrain(car);
    for (const m of members) if (m.carId !== draft.carId) this.setTrain(m, { carId: draft.carId }, false);
    this.event(car, { type: "train.enqueued", summary: `car ${car.trainId} with ${members.length} member(s)`, data: { lane: "QUEUE", members: draft.members, bisectOf: draft.bisectOf } });
    this.scheduleFork(car);
  }

  private mergeMembers(car: TrainRecord): MergeMember[] {
    return (car.members ?? []).flatMap((id) => {
      const m = this.find(id);
      if (!m) return [];
      const title = (this.prompts.get(m.promptId)?.promptText ?? m.promptId).split("\n")[0]!.slice(0, 120);
      return [{ trainId: m.trainId, promptId: m.promptId, artifactRepo: m.artifactRepo, headSha: m.headSha ?? "", title }];
    });
  }

  // ── internals: races ──────────────────────────────────────────────────

  /** The train's race, if it is a candidate still in a RACING race (a passed candidate held in PICKING; a fix in REWORKING). */
  private racingRaceOf(t: TrainRecord): RaceRecord | undefined {
    if (!t.raceId || isCar(t)) return undefined;
    const race = this.races.get(t.raceId);
    if (race?.state !== "RACING" && race?.state !== "PICKING" && race?.state !== "REWORKING") return undefined;
    return t.raceOutcome === "RACING" || t.raceOutcome === "PASSED" ? race : undefined;
  }

  private setRace(r: RaceRecord, patch: Partial<RaceRecord>): void {
    Object.assign(r, patch);
    this.dirtyRaces.add(r.raceId);
  }

  // ── internals: the rework loop (rework-loop spec §5) ─────────────────

  private setSlot(s: AttemptSlot): void {
    this.slots.set(s.attemptId, s);
    this.dirtySlots.add(s.attemptId);
  }

  /** The train's attempt's open slot, or null. */
  private openSlotOf(t: TrainRecord): AttemptSlot | null {
    if (!t.attemptId) return null;
    const s = this.slots.get(t.attemptId);
    return s?.rework ? s : null;
  }

  /** Open the next slot of `t`'s attempt (an external hive, an attempt's train, a slot left, the item open), or null. */
  private giveSlot(t: TrainRecord, reason: ReworkReason): AttemptSlot | null {
    if (!this.ctx.rework || !t.attemptId || !isContributed(t)) return null;
    const next = nextSlot(this.slots.get(t.attemptId), t.attemptId, reason, this.ctx.rework, this.ctx.now, this.item(t.promptId)?.status);
    if (next) this.setSlot(next);
    return next;
  }

  /** A REWORK candidate still holds its RACING race (§5.2): its slot is open and its hold has not ended. */
  private holding(t: TrainRecord, race: RaceRecord, anyPassed: boolean): boolean {
    const s = this.openSlotOf(t);
    if (!s) return false;
    return this.ctx.now < holdEnd(s.rework!, race, anyPassed, { holdMs: this.ctx.rework?.holdMs ?? 0, graceMs: this.ctx.raceGraceMs ?? RACE_GRACE_MS });
  }

  /**
   * A REWORK candidate leaves the race: FAILED (its slot expired, its attempt ended, the race fell back) or LOST (the race
   * was decided while it was still in rework). Its slot closes. The reason keeps the rework text (R20: the head still reads
   * as rejected); `why` goes on the event.
   */
  private endRework(t: TrainRecord, outcome: "FAILED" | "LOST", why: string): void {
    if (t.raceOutcome !== "REWORK") return;
    this.setTrain(t, { raceOutcome: outcome });
    const s = t.attemptId ? this.slots.get(t.attemptId) : undefined;
    if (s?.rework) this.setSlot({ ...s, rework: null });
    this.event(t, { type: "train.phase", severity: "warn", summary: clip500(`train ${t.trainId} ${outcome} (was in rework): ${why}`), data: { raceId: t.raceId ?? null, raceOutcome: outcome, rework: true } });
  }

  /** Slots whose dueAt passed (alarm): the REWORK candidate fails, its race decides (or abandons). */
  private expireSlots(): void {
    for (const s of [...this.slots.values()]) {
      if (!s.rework || s.rework.dueAt > this.ctx.now) continue;
      const t = this.trains.find((x) => x.attemptId === s.attemptId && x.raceOutcome === "REWORK");
      if (!t) {
        this.setSlot({ ...s, rework: null });
        continue;
      }
      const race = t.raceId ? this.races.get(t.raceId) : undefined;
      this.endRework(t, "FAILED", `rework slot ${s.rework.round} of attempt ${s.attemptId} expired at ${iso(s.rework.dueAt)}`);
      if (race?.state === "REWORKING") this.abandonRework(race, `rework slot ${s.rework.round} of attempt ${s.attemptId} expired`);
      else if (race) this.maybeDecide(race);
    }
  }

  /** Set (or clear) the item's REWORKING wait reason; its prompt rides along so the ledger absorbs it. */
  private reworkWait(itemId: string, waitReason: string | null): void {
    this.reworkWaits.set(itemId, waitReason === null ? null : clip(waitReason, 200));
    const p = this.prompts.get(itemId);
    if (p) this.markPrompt(p, false);
  }

  /**
   * A push inside the attempt's open slot (§5.1): the slot closes (reworks kept), the old REWORK train of the attempt
   * fails (no longer pending), and (R3) a RACING race's grace deadline moves out to the slot's hold end, so the fix is
   * not cut off by a grace clock that started before it existed.
   */
  private closeSlotByPush(t: TrainRecord, race: RaceRecord, anyPassed: boolean): void {
    const s = t.attemptId ? this.slots.get(t.attemptId) : undefined;
    if (!s?.rework || s.rework.dueAt <= this.ctx.now) return;
    const end = holdEnd(s.rework, race, anyPassed, { holdMs: this.ctx.rework?.holdMs ?? 0, graceMs: this.ctx.raceGraceMs ?? RACE_GRACE_MS });
    for (const old of this.trains) if (old !== t && old.attemptId === t.attemptId && old.raceOutcome === "REWORK") this.setTrain(old, { raceOutcome: "FAILED" }, false);
    this.setSlot({ ...s, rework: null });
    if (race.state === "RACING" && race.deadlineAt !== null && end > race.deadlineAt) this.setRace(race, { deadlineAt: end });
  }

  /**
   * §5.3: the winner was rejected in the merge train. With a slot: REWORK (conflict, or findings for an integration
   * failure), race DECIDED → REWORKING, the item waits for the fix ("awaiting rework"); only this attempt may push, and its
   * push rejoins this race (no new race, no entry window). Without one (R8): the fallback at once.
   */
  private winnerRejected(t: TrainRecord, race: RaceRecord, summary: string, opts: FailOptions): void {
    const reason: ReworkReason = opts.cause === "conflict" ? "conflict" : "findings";
    const extra: Partial<TrainRecord> = opts.conflict ? { conflict: opts.conflict } : {};
    const slot = this.giveSlot(t, reason);
    if (!slot) {
      this.ejectKeepingFork(t, clip500(`failed: ${summary}`), { ...extra, raceOutcome: "FAILED" });
      this.abandonRework(race, `winner ${t.trainId} was rejected in the train (${reason}) and attempt ${t.attemptId} has no rework slot left`);
      return;
    }
    const { dueAt, round } = slot.rework!;
    this.ejectKeepingFork(t, reworkReasonText(reason, dueAt, `failed: ${summary}`), { ...extra, raceOutcome: "REWORK" });
    this.setRace(race, { state: "REWORKING" });
    this.raceEvent(race, t, `race ${race.raceId} reworking: winner ${t.trainId} was rejected in the train (${reason}); attempt ${t.attemptId} may push a fix until ${iso(dueAt)}`, { outcome: "REWORKING", winner: t.trainId, reason, dueAt, round }, "warn");
    this.reworkWait(race.itemId, `awaiting rework (attempt ${t.attemptId}, due ${iso(dueAt)})`);
    this.maybeLand();
  }

  /** §5.3: the REWORKING race's fix passed its gate: it wins (a queue ticket), the race is DECIDED again. */
  private reworkWon(t: TrainRecord, race: RaceRecord, r: TrainResult): void {
    for (const id of race.trainIds) {
      const x = this.find(id);
      if (x && x !== t) this.endRework(x, "FAILED", `race ${race.raceId}: the rework of attempt ${t.attemptId ?? "?"} passed`);
    }
    const reason = clip(`reworked by attempt ${t.attemptId ?? "?"}: ${t.trainId} passed every gate`, 300);
    this.pass(t, { raceOutcome: "WON", reason, summary: r.summary, headSha: r.commitSha ?? t.headSha, score: r.score ?? null });
    this.setRace(race, { state: "DECIDED", winnerTrainId: t.trainId, reason, decidedAt: this.ctx.now });
    this.raceEvent(race, t, `race ${race.raceId} decided again: ${t.trainId} (the rework of the winner) passed`, { winner: t.trainId, outcome: "DECIDED", rework: true });
    this.reworkWait(race.itemId, null);
    this.maybeLand();
  }

  /** §5.3: the REWORKING race's fix was rejected: the next round's slot, or the fallback. Infra keeps the race waiting (R7). */
  private reworkFixFailed(t: TrainRecord, race: RaceRecord, summary: string): void {
    const why = `failed in race: ${summary}`;
    if (isInfraStopped({ summary })) {
      this.ejectKeepingFork(t, why, { raceOutcome: "FAILED", summary: clip500(summary) });
      this.reworkWait(race.itemId, `awaiting rework (attempt ${t.attemptId}: its rebased head could not be gated; retry_gates)`);
      return;
    }
    const slot = this.giveSlot(t, "findings");
    if (!slot) {
      this.ejectKeepingFork(t, why, { raceOutcome: "FAILED", summary: clip500(summary) });
      this.abandonRework(race, `the rebased head of attempt ${t.attemptId} was rejected and it has no rework slot left`);
      return;
    }
    const { dueAt, round } = slot.rework!;
    this.ejectKeepingFork(t, reworkReasonText("findings", dueAt, why), { raceOutcome: "REWORK", summary: clip500(summary) });
    this.raceEvent(race, t, `race ${race.raceId} still reworking: the rebased head ${t.trainId} was rejected; attempt ${t.attemptId} has until ${iso(dueAt)} (round ${round})`, { outcome: "REWORKING", reason: "findings", dueAt, round }, "warn");
    this.reworkWait(race.itemId, `awaiting rework (attempt ${t.attemptId}, due ${iso(dueAt)})`);
  }

  /**
   * §5.6, the rework fallback: the race is ABANDONED (REWORK → FAILED, a fix in flight is withdrawn), the item goes FAILED
   * "awaiting contributor", which reopens it to any agent's start_attempt. The Queen then releases its base (R6).
   */
  private abandonRework(race: RaceRecord, why: string): void {
    if (race.state === "ABANDONED") return;
    for (const id of race.trainIds) {
      const x = this.find(id);
      if (!x) continue;
      if (x.raceOutcome === "REWORK") this.endRework(x, "FAILED", why);
      else if (isActive(x) && x.raceOutcome === "RACING") this.eject(x, clip500(`withdrawn: race ${race.raceId} abandoned (${why})`), { raceOutcome: "LOST" });
    }
    this.setRace(race, { state: "ABANDONED", reason: clip(`abandoned: ${why}`, 300), decidedAt: this.ctx.now });
    this.raceEvent(race, this.find(race.winnerTrainId ?? ""), `race ${race.raceId} abandoned: ${why}; the item reopens to any agent`, { outcome: "ABANDONED", fallback: true }, "warn");
    this.reworkWait(race.itemId, null);
    this.awaitContributor(race.itemId, `rework fallback: ${why}`);
    this.maybeLand();
  }

  /**
   * A candidate failed (gate, build, watchdog): eject it alone; no rework yet. Rework loop (§5.2): an attempt's candidate
   * rejected on findings in a RACING race keeps its place with a rework slot (REWORK) instead; infra never uses a slot.
   */
  private raceCandidateFailed(t: TrainRecord, race: RaceRecord, summary: string): void {
    if (race.state === "REWORKING") {
      this.reworkFixFailed(t, race, summary);
      return;
    }
    const why = `failed in race: ${summary}`;
    const slot = race.state === "RACING" && !isInfraStopped({ summary }) ? this.giveSlot(t, "findings") : null;
    if (slot) {
      this.ejectKeepingFork(t, reworkReasonText("findings", slot.rework!.dueAt, why), { raceOutcome: "REWORK", summary: clip500(summary) });
      this.maybeDecide(race);
      return;
    }
    const patch: Partial<TrainRecord> = { raceOutcome: "FAILED", summary: clip500(summary) };
    if (isContributed(t)) this.ejectKeepingFork(t, why, patch);
    else this.eject(t, why, patch);
    this.maybeDecide(race);
  }

  /**
   * Decide the race once every candidate has reported, or at its deadline.
   * Candidates missing from the loaded state are terminal (reported, failed).
   * T9a: a human-judged race with ≥ 2 passes is held in PICKING instead (pick.ts decideMode).
   */
  private maybeDecide(race: RaceRecord): void {
    if (race.state === "PICKING") {
      this.maybeDecidePicking(race);
      return;
    }
    if (race.state !== "RACING") return;
    const cands = race.trainIds.map((id) => this.find(id)).filter((t): t is TrainRecord => !!t);
    const live = cands.filter(isActive);
    const pending = live.filter((t) => t.raceOutcome === "RACING");
    const passed = live.filter((t) => t.raceOutcome === "PASSED");
    const reworking = cands.filter((t) => t.raceOutcome === "REWORK");
    // The grace clock belongs to a live pass: once the last one left (superseded, failed), the next pass restarts it.
    if (!passed.length && race.deadlineAt !== null) this.setRace(race, { deadlineAt: null });
    // An open entry window holds everything (passes and all-failed alike): another agent may still enter.
    if (race.entryClosesAt != null && this.ctx.now < race.entryClosesAt) return;
    const due = race.deadlineAt !== null && this.ctx.now >= race.deadlineAt;
    if (pending.length && !(due && passed.length)) return;
    // Rework loop (§5.2): a REWORK candidate is pending until its hold ends, even though its train is no longer active.
    if (reworking.some((t) => this.holding(t, race, passed.length > 0))) return;
    const predicted = this.item(race.itemId)?.paths ?? [];
    if (passed.length) {
      for (const t of reworking) this.endRework(t, "LOST", `lost race ${race.raceId}: still in rework at the race deadline`);
      const judge = judgeOf(this.item(race.itemId)?.judge, this.ctx.pick?.judge);
      const picking = [...this.races.values()].filter((r) => r.state === "PICKING" && r.raceId !== race.raceId).length;
      const mode = decideMode({ judge, passed: passed.length, picking, maxPicking: this.ctx.pick?.maxPickingRaces ?? Number.NaN });
      if (mode === "pick") {
        this.enterPicking(race, passed, pending, predicted);
        return;
      }
      const ranking = rankCandidates(passed.map(toCandidate), { predictedPaths: predicted });
      const winner = this.find(ranking.winner!.trainId)!;
      const losers = [...passed, ...pending]
        .filter((l) => l !== winner)
        .map((l) => ({ t: l, why: l.raceOutcome === "RACING" ? "still running at the race deadline" : (ranking.lostBecause[l.trainId] ?? "ranked lower") }));
      // Auto races keep their pre-T9a shape (no decidedBy); a human-judged race records who decided it.
      const by = judge === "human" ? `queen:${mode}` : null;
      const reason = mode === "cap" ? clip(`${ranking.reason} (maxPickingRaces reached: decided without a pick)`, 300) : ranking.reason;
      this.decideRace(race, winner, losers, { reason, by, summary: `${winner.trainId} ${reason}` });
      return;
    }
    this.abandonRace(race, cands, predicted);
  }

  /** Nobody passed: one failure for the item, with the best failure's Scribe summary (no human, even when judged by one). */
  private abandonRace(race: RaceRecord, cands: TrainRecord[], predicted: readonly string[]): void {
    for (const t of cands) this.endRework(t, "FAILED", `race ${race.raceId} abandoned: no candidate passed`);
    const prompt = this.prompts.get(race.itemId);
    const failed = cands.filter((t) => t.raceOutcome === "FAILED");
    const best = failed.length ? this.find(rankCandidates(failed.map(toCandidate), { predictedPaths: predicted }).winner!.trainId) : undefined;
    const why = best?.summary ?? prompt?.summary ?? "every race candidate failed";
    this.setRace(race, { state: "ABANDONED", reason: clip(`abandoned: no candidate passed; best failure ${best?.trainId ?? "?"}: ${why}`, 300), decidedAt: this.ctx.now });
    this.raceEvent(race, best ?? cands[0], `race ${race.raceId} abandoned: no candidate passed`, { outcome: "ABANDONED", best: best?.trainId ?? null }, "warn");
    if (prompt) {
      this.setPromptSummary(prompt.promptId, why);
      // Only contributed candidates (a race a push opened): the item waits for its contributor, unless handed off.
      if (cands.length && cands.every(isContributed) && !this.handoffOf(prompt.promptId)) this.awaitContributor(prompt.promptId, why);
      else this.rework(prompt.promptId);
    }
    this.maybeLand();
  }

  /**
   * T9a (§10.2): hold a human-judged race for a pick. The passed candidates stay alive (TESTING, previews LIVE,
   * forks kept); still-running ones lose as at any deadline. The race records the Queen's recommendation and
   * `pickDeadlineAt`, when the Queen picks it itself (`queen:deadline`).
   */
  private enterPicking(race: RaceRecord, passed: TrainRecord[], pending: TrainRecord[], predicted: readonly string[]): void {
    const rec = recommend(passed.map(toCandidate), predicted)!;
    for (const l of pending) this.eject(l, `lost race ${race.raceId}: still running when it went to a human pick`, { raceOutcome: "LOST" });
    const pickDeadlineAt = pickDeadline(this.ctx.now, this.ctx.pick?.pickWindowMs);
    this.setRace(race, { state: "PICKING", recommendedTrainId: rec.trainId, recommendReason: rec.reason, pickDeadlineAt });
    const recommended = this.find(rec.trainId);
    this.events.push({
      type: "race.picking",
      actor: ACTOR,
      traceId: recommended ? traceOfTrain(recommended) : traceIdFromUuid(race.itemId),
      spanId: spanIdFor(race.raceId),
      parentSpanId: spanIdFor(race.itemId),
      itemId: race.itemId,
      trainId: rec.trainId,
      summary: clip500(`race ${race.raceId}: ${passed.length} candidates passed every gate; waiting for a human pick until ${new Date(pickDeadlineAt).toISOString()} (${rec.reason}: ${rec.trainId})`),
      data: {
        raceId: race.raceId,
        candidates: passed.map((t) => ({ trainId: t.trainId, model: t.model, previewUrl: t.previewUrl })),
        recommended: rec.trainId,
        recommendReason: rec.reason,
        pickDeadlineAt,
      },
    });
  }

  /**
   * A PICKING race: a candidate left (superseded, failed) or its pick window ran out. No live pass left → the
   * usual ABANDONED path; one left → `queen:single`; at `pickDeadlineAt` → the recommendation (or, if it is
   * gone, the best live one), `queen:deadline`. Otherwise it keeps waiting (a paused hive included).
   */
  private maybeDecidePicking(race: RaceRecord): void {
    const cands = race.trainIds.map((id) => this.find(id)).filter((t): t is TrainRecord => !!t);
    const passed = cands.filter((t) => isActive(t) && t.raceOutcome === "PASSED");
    const predicted = this.item(race.itemId)?.paths ?? [];
    if (!passed.length) {
      this.abandonRace(race, cands, predicted);
      return;
    }
    const single = passed.length === 1;
    if (!single && !pickDue(race, this.ctx.now)) return;
    const ranking = rankCandidates(passed.map(toCandidate), { predictedPaths: predicted });
    const winner = passed.find((t) => t.trainId === race.recommendedTrainId) ?? this.find(ranking.winner!.trainId)!;
    const by = single ? "queen:single" : "queen:deadline";
    const reason = single
      ? clip(`only candidate left in the pick; ${race.recommendReason ?? ranking.reason}`, 300)
      : clip(`no pick within the window: the Queen's recommendation; ${race.recommendReason ?? ranking.reason}`, 300);
    const losers = passed.filter((l) => l !== winner).map((l) => ({ t: l, why: "not picked before the pick deadline" }));
    this.decideRace(race, winner, losers, { reason, by, summary: `${winner.trainId} by ${by}`, keepLoserForks: true });
  }

  /**
   * The winner passes (WON, a queue ticket), the losers are EJECTED (LOST). A race decided out of PICKING keeps
   * its losers' forks for a re-pick (`keepLoserForks`, LOSER_FORK_KEEP_MS); their previews are torn down.
   */
  private decideRace(
    race: RaceRecord,
    winner: TrainRecord,
    losers: { t: TrainRecord; why: string }[],
    opts: { reason: string; by: string | null; summary: string; keepLoserForks?: boolean; humanReason?: string | null },
  ): void {
    this.pass(winner, { raceOutcome: "WON", reason: opts.reason });
    for (const { t, why } of losers) {
      if (opts.keepLoserForks) this.ejectKeepingLoserFork(t, `lost race to ${winner.trainId}: ${why}`);
      else this.eject(t, `lost race to ${winner.trainId}: ${why}`, { raceOutcome: "LOST" });
    }
    this.setRace(race, { state: "DECIDED", winnerTrainId: winner.trainId, reason: opts.reason, decidedAt: this.ctx.now, ...(opts.by ? { decidedBy: opts.by } : {}) });
    const picked = race.recommendedTrainId !== null && race.recommendedTrainId !== undefined;
    this.raceEvent(race, winner, `race ${race.raceId} decided: ${opts.summary}`, {
      winner: winner.trainId,
      winnerModel: winner.model,
      outcome: "DECIDED",
      ...(opts.by ? { by: opts.by } : {}),
      ...(picked ? { recommended: race.recommendedTrainId, agreed: winner.trainId === race.recommendedTrainId } : {}),
      ...(opts.humanReason ? { reason: opts.humanReason } : {}),
    });
    if (isHumanBy(opts.by)) this.countPick(winner, winner.trainId !== race.recommendedTrainId);
    this.maybeLand();
  }

  /** EJECTED (LOST) with its preview torn down, the fork kept until `now + LOSER_FORK_KEEP_MS` (deleteIssuedAt). */
  private ejectKeepingLoserFork(t: TrainRecord, reason: string): void {
    if (t.forkState !== "READY") {
      this.eject(t, reason, { raceOutcome: "LOST" });
      return;
    }
    this.setTrain(t, { raceOutcome: "LOST", phase: "EJECTED", reason, deleteIssuedAt: this.ctx.now + LOSER_FORK_KEEP_MS });
    if (PREVIEW_EXISTS.has(t.deployState)) this.teardownPreview(t);
  }

  /** model_stats picks (§10.3), per (model, role); contributed candidates have no model. */
  private countPick(winner: TrainRecord, againstRecommendation: boolean): void {
    if (!winner.model || !isCatalogModel(winner.model)) return;
    const role: RouterRole = winner.modelChoice?.role === "rework" || (!winner.modelChoice && winner.action === "REWORK") ? "rework" : "builder";
    this.picks.push({ model: winner.model, role, againstRecommendation });
  }

  /**
   * T9a `POST /hives/:hive/races/:raceId/pick` (§10.2, §10.3): a human picks `trainId`.
   * - PICKING: `trainId` (a live passed candidate) wins, the others lose with their forks kept; `race.decided`
   *   `by: human:<email>`, `agreed` = the pick was the Queen's recommendation; picks counted in model_stats.
   * - DECIDED out of PICKING, the winner not yet in a car: a re-pick. The winner steps back (EJECTED, LOST, no
   *   attempt, fork kept) and `trainId` is restored to PASSED with a new queue ticket.
   * - Otherwise `refused` (409; 404 for an unknown race), nothing changes.
   */
  pick(input: { raceId: string; trainId: string; by: string; reason?: string | null }): PlanResult {
    const race = this.races.get(input.raceId);
    if (!race) {
      this.refused = { status: 404, message: `race ${input.raceId} not found` };
      return this.finish("ignored:unknown");
    }
    const cands = race.trainIds.map((id) => this.find(id)).filter((t): t is TrainRecord => !!t);
    const check = checkPick(race, input.trainId, cands);
    if (!check.ok) {
      this.refused = { status: check.status, message: check.message };
      return this.finish("ignored:stale");
    }
    const pickedBy = input.by.replace(/^human:/, "");
    const why = input.reason?.trim() ? clip(input.reason.trim(), 300) : null;
    const reason = clip(`picked by ${pickedBy}${why ? `: ${why}` : ""}`, 300);
    const chosen = this.find(input.trainId)!;
    if (check.mode === "pick") {
      const losers = cands
        .filter((t) => t !== chosen && isActive(t) && t.raceOutcome === "PASSED")
        .map((t) => ({ t, why: `not picked (${pickedBy}${why ? `: ${clip(why, 120)}` : ""})` }));
      this.decideRace(race, chosen, losers, { reason, by: input.by, summary: `${chosen.trainId} picked by ${pickedBy}`, keepLoserForks: true, humanReason: why });
      return this.finish("applied");
    }
    // Re-pick before boarding: swap the winner.
    const old = this.find(check.winnerTrainId)!;
    // The old winner never boarded: no attempt is charged, and its fork is kept like any picked loser's.
    this.ejectKeepingLoserFork(old, `lost race to ${chosen.trainId}: re-picked by ${pickedBy}`);
    this.setTrain(chosen, { deleteIssuedAt: null }, false);
    this.pass(chosen, { raceOutcome: "WON", reason });
    this.setRace(race, { winnerTrainId: chosen.trainId, reason, decidedAt: this.ctx.now, decidedBy: input.by });
    this.raceEvent(race, chosen, `race ${race.raceId} re-picked: ${chosen.trainId} instead of ${old.trainId} by ${pickedBy}`, {
      winner: chosen.trainId,
      winnerModel: chosen.model,
      outcome: "DECIDED",
      by: input.by,
      recommended: race.recommendedTrainId ?? null,
      agreed: chosen.trainId === race.recommendedTrainId,
      repick: true,
      previous: old.trainId,
      ...(why ? { reason: why } : {}),
    });
    this.countPick(chosen, chosen.trainId !== race.recommendedTrainId);
    this.maybeLand();
    return this.finish("applied");
  }

  /**
   * `POST /hives/:hive/races/:raceId/close-entries` (external hives, human-push design §2.5): a human ends the
   * entry window now. Only a RACING race with an entry window still open (`entryClosesAt` in the future) can be
   * closed; else `refused` (404 unknown race; 409 not RACING, no window, or already closed), nothing changes.
   * Closing sets `entryClosesAt = now`; a candidate that already passed has started the grace clock, and the
   * others now get at most `raceGraceMs` more from the close (`deadlineAt = min(existing, now + grace)`; the
   * existing one was measured from the old close). With no pass yet the first pass sets it from the close.
   * Then the race is evaluated at once: decided (auto judge), held in PICKING (judge human, ≥ 2 passes), or
   * ABANDONED when everything already failed.
   */
  closeEntries(input: { raceId: string; by: string }): PlanResult {
    const race = this.races.get(input.raceId);
    if (!race) {
      this.refused = { status: 404, message: `race ${input.raceId} not found` };
      return this.finish("ignored:unknown");
    }
    if (race.state !== "RACING") {
      this.refused = { status: 409, message: `race ${race.raceId} is ${race.state}: only a RACING race takes entries` };
      return this.finish("ignored:stale");
    }
    const now = this.ctx.now;
    if (race.entryClosesAt == null) {
      this.refused = { status: 409, message: `race ${race.raceId} has no entry window to close` };
      return this.finish("ignored:stale");
    }
    if (race.entryClosesAt <= now) {
      this.refused = { status: 409, message: `race ${race.raceId} is already closed to entries` };
      return this.finish("ignored:stale");
    }
    const grace = this.ctx.raceGraceMs ?? RACE_GRACE_MS;
    this.setRace(race, {
      entryClosesAt: now,
      ...(race.deadlineAt !== null ? { deadlineAt: Math.min(race.deadlineAt, now + grace) } : {}),
    });
    const who = input.by.replace(/^human:/, "");
    const first = this.find(race.trainIds[0] ?? "");
    this.events.push({
      type: "race.entries-closed",
      actor: `user:${who}`,
      traceId: first ? traceOfTrain(first) : traceIdFromUuid(race.itemId),
      spanId: spanIdFor(race.raceId),
      parentSpanId: spanIdFor(race.itemId),
      itemId: race.itemId,
      trainId: null,
      summary: clip500(`race ${race.raceId}: entries closed by ${who} (${race.trainIds.length} candidates)`),
      data: { raceId: race.raceId, by: input.by, candidates: race.trainIds.length },
    });
    this.maybeDecide(race);
    return this.finish("applied");
  }

  private raceEvent(race: RaceRecord, t: TrainRecord | undefined, summary: string, data: Record<string, unknown>, severity: EventDraft["severity"] = "info"): void {
    this.events.push({
      type: "race.decided",
      severity,
      actor: ACTOR,
      traceId: t ? traceOfTrain(t) : traceIdFromUuid(race.itemId),
      spanId: spanIdFor(race.raceId),
      parentSpanId: spanIdFor(race.itemId),
      itemId: race.itemId,
      trainId: t?.trainId ?? null,
      summary: clip500(summary),
      data: { raceId: race.raceId, ...data },
    });
  }

  private routeRaceFor(p: PromptRecord, action: TrainAction, width: number): ModelChoice[] {
    const role: RouterRole = action === "REWORK" ? "rework" : "builder";
    const summary = action === "REWORK" ? (p.summary ?? "") : "";
    this.routerDispatches += 1;
    this.routerDirty = true;
    return routeRace(
      {
        role,
        attempt: p.attempts + 1,
        promptChars: p.promptText.length + summary.length,
        stats: this.modelStats,
        pin: this.ctx.modelPin ?? null,
        dispatchIndex: this.routerDispatches,
        floor: this.floor,
        policy: this.policy(),
      },
      width,
    );
  }

  // ── internals: drones ─────────────────────────────────────────────────

  private dispatchBuilder(t: TrainRecord): void {
    if (isCar(t)) {
      this.dispatchMerge(t);
      return;
    }
    const p = this.prompts.get(t.promptId);
    if (!p) return;
    const modelChoice = this.routeBuilder(t, p);
    const task: DroneTask = {
      promptId: p.promptId,
      trainId: t.trainId,
      namespace: this.ctx.namespace,
      artifactRepo: t.artifactRepo,
      baseRef: "main",
      promptText: p.promptText,
      role: "BUILDER",
      action: t.action,
      ragContext: t.memories.map(memoryToRagSnippet),
      ...(t.action === "REWORK" && p.summary ? { scribeSummary: p.summary } : {}),
      modelChoice,
      ...this.seedTask(t),
    };
    this.pushDrone(t, task);
  }

  /** A seeded REWORK (handoff): where its code starts, and the rendered v1 note of the rejected head as its brief. */
  private seedTask(t: TrainRecord): Pick<DroneTask, "seed" | "brief"> {
    const seed = this.seedOf(t);
    if (!seed) return {};
    const brief = this.ctx.briefFor?.(seed.headSha) ?? null;
    return { seed: { repo: seed.repo, ref: "refs/heads/main", headSha: seed.headSha }, ...(brief ? { brief } : {}) };
  }

  /** A car's "builder": the deterministic MERGE drone (no LLM, no model choice). */
  private dispatchMerge(car: TrainRecord): void {
    const members = this.mergeMembers(car);
    this.pushDrone(car, {
      promptId: car.promptId,
      trainId: car.trainId,
      namespace: this.ctx.namespace,
      artifactRepo: car.artifactRepo,
      baseRef: "main",
      promptText: `queue car ${car.trainId}: ${members.length} members`,
      role: "LANDER",
      action: "MERGE",
      ragContext: [],
      members,
    });
  }

  private dispatchLander(t: TrainRecord): void {
    const car = isCar(t);
    const members = car ? this.mergeMembers(t) : [];
    const p = this.prompts.get(t.promptId);
    this.pushDrone(t, {
      promptId: t.promptId,
      trainId: t.trainId,
      namespace: this.ctx.namespace,
      artifactRepo: t.artifactRepo,
      baseRef: t.headSha ?? "main",
      promptText: car ? `queue car ${t.trainId}: ${members.length} members` : (p?.promptText ?? t.promptId),
      role: "LANDER",
      action: "LAND",
      ragContext: [],
      ...(car ? { members } : {}),
    });
  }

  private pushDrone(t: TrainRecord, task: DroneTask): void {
    const attempt = t.droneAttempt;
    this.effects.push({
      type: "dispatchDrone",
      trainId: t.trainId,
      attempt,
      task: { ...task, trace: traceFor(t, droneInstanceId(task, attempt)) },
    });
  }

  // ── model router ──────────────────────────────────────────────────────

  /**
   * The builder's model for this dispatch. Chosen once per drone attempt and
   * persisted on the train before dispatch, so a reconcile re-dispatch of the
   * same Workflow instance carries the same choice. The attempt is the
   * prompt's failed attempts plus the drone attempt: 1 for a first BUILD,
   * >= 2 for a REWORK or a watchdog re-dispatch (escalation). Race candidates
   * were routed at enqueue (routeRace); their re-dispatches never move the floor.
   */
  private routeBuilder(t: TrainRecord, p: PromptRecord): ModelChoice {
    if (t.modelChoice && t.modelChoiceAttempt === t.droneAttempt) return t.modelChoice;
    const role: RouterRole = t.action === "REWORK" ? "rework" : "builder";
    const summary = t.action === "REWORK" ? (p.summary ?? "") : "";
    this.routerDispatches += 1;
    this.routerDirty = true;
    const routed = route({
      role,
      attempt: p.attempts + t.droneAttempt,
      promptChars: p.promptText.length + summary.length,
      stats: this.modelStats,
      pin: this.ctx.modelPin ?? null,
      dispatchIndex: this.routerDispatches,
      floor: this.floor,
      policy: this.policy(),
      inFlight: this.buildersInFlight(t),
    });
    if (routed.floorRouted && !t.raceId) this.setFloor(routed.floor);
    const choice = routed.choice;
    this.setTrain(t, {
      modelChoice: choice,
      modelChoiceAttempt: t.droneAttempt,
      model: choice.model,
      modelReason: choice.reason,
      modelProbe: routed.probe,
    });
    return choice;
  }

  /**
   * Builder/rework drones in flight per model (the router's load spread): every
   * other active BUILD train in BUILDING whose model was chosen for its current
   * drone attempt, including ones routed earlier in this same decision.
   */
  private buildersInFlight(except: TrainRecord): Record<string, number> {
    const out: Record<string, number> = {};
    for (const o of this.trains) {
      if (o === except || !isActive(o) || isCar(o) || o.phase !== "BUILDING") continue;
      const m = o.modelChoice;
      if (!m || o.modelChoiceAttempt !== o.droneAttempt) continue;
      out[m.model] = (out[m.model] ?? 0) + 1;
    }
    return out;
  }

  private policy(): RouterPolicy {
    return this.ctx.routerPolicy ?? DEFAULT_POLICY;
  }

  private setFloor(next: FloorState): void {
    const f = this.floor;
    if (f.tier === next.tier && f.passStreak === next.passStreak && f.aboveStreak === next.aboveStreak && f.note === next.note) return;
    this.floor = { ...next };
    this.floorDirty = true;
  }

  /**
   * Only first-attempt BUILD dispatches are routed by (and move) the hive's
   * floor. Reworks, re-dispatches and race candidates leave it alone.
   */
  private floorOutcome(t: TrainRecord, outcome: FloorOutcome, model: string): void {
    const c = t.modelChoice;
    if (!c || c.role !== "builder" || t.action !== "BUILD" || t.modelChoiceAttempt !== 1 || t.raceId) return;
    if (!isCatalogModel(model)) return; // scripted drones / unknown pins teach the router nothing
    this.setFloor(floorAfter(this.floor, outcome, c.tier, t.modelProbe, this.policy()));
  }

  /** build-result: count the attempt for the model that built the head, and a failure for each model that could not. */
  private recordBuild(t: TrainRecord, r: BuildResult): void {
    const credits = buildCredits(r.usage, r.model ?? t.modelChoice?.model ?? null);
    if (credits !== null) this.setTrain(t, { credits }, false);
    if (t.modelOutcome !== null) return;
    const choice = t.modelChoice;
    const used = r.model ?? choice?.model ?? null;
    if (!used) return; // a pre-router dispatch: nothing to attribute
    const role: RouterRole = choice?.role === "rework" || (!choice && t.action === "REWORK") ? "rework" : "builder";
    const failed = [...new Set(r.failedModels ?? [])].filter((m) => m !== used);
    // Only catalog models are tracked (a scripted drone reports its own name).
    const tracked = failed.filter((m) => isCatalogModel(m));
    for (const model of tracked) this.modelDeltas.push({ model, role, attempts: 1, passes: 0, failures: 1, streak: "fail" });
    if (tracked.length) this.floorOutcome(t, "unusable", tracked[0]!);
    if (isCatalogModel(used)) {
      this.modelDeltas.push({ model: used, role, attempts: 1, passes: 0, failures: 0, ...(r.buildMs !== undefined ? { buildMs: r.buildMs } : {}) });
    }
    const reason =
      choice && used !== choice.model
        ? `fell back to ${used}${failed.length ? ` after ${failed.length} unusable` : ""} · ${choice.reason}`
        : (choice?.reason ?? t.modelReason);
    this.setTrain(t, { model: used, modelReason: reason ? clip200(reason) : null, modelOutcome: "BUILT" });
  }

  /**
   * Gate verdict: a pass credits the model that built the head; a fail after
   * the build is the build's failure. A fail before any build-result (the
   * builder gave up) counts as an attempt and a failure for the chosen model.
   */
  private recordVerdict(t: TrainRecord, passed: boolean): void {
    const role: RouterRole = t.modelChoice?.role === "rework" || (!t.modelChoice && t.action === "REWORK") ? "rework" : "builder";
    if (t.modelOutcome === "BUILT" && t.model && !isCatalogModel(t.model)) {
      this.setTrain(t, { modelOutcome: passed ? "PASSED" : "FAILED" }, false);
    } else if (t.modelOutcome === "BUILT" && t.model) {
      this.modelDeltas.push(
        passed
          ? { model: t.model, role, attempts: 0, passes: 1, failures: 0, streak: "pass" }
          : { model: t.model, role, attempts: 0, passes: 0, failures: 1, streak: "fail" },
      );
      this.setTrain(t, { modelOutcome: passed ? "PASSED" : "FAILED" }, false);
      this.floorOutcome(t, passed ? "pass" : "gate-fail", t.model);
    } else if (t.modelOutcome === null && !passed && t.phase === "BUILDING" && t.modelChoice) {
      // The builder gave up ("no usable change set from …"): a builder failure.
      const model = t.modelChoice.model;
      if (isCatalogModel(model)) this.modelDeltas.push({ model, role, attempts: 1, passes: 0, failures: 1, streak: "fail" });
      this.setTrain(t, { modelOutcome: "FAILED" }, false);
      this.floorOutcome(t, "unusable", model);
    }
  }

  // ── rows, events, result ──────────────────────────────────────────────

  private setTrain(t: TrainRecord, patch: Partial<TrainRecord>, visible = true): void {
    const before = t.phase;
    // Watchdog clocks: a new command id (or a confirmed drone dispatch) starts one.
    const stamped: Partial<TrainRecord> = {};
    for (const [idField, clock] of Object.entries(ISSUED_AT) as [keyof typeof ISSUED_AT, (typeof ISSUED_AT)[keyof typeof ISSUED_AT]][]) {
      if (idField in patch && patch[idField] !== t[idField] && !(clock in patch)) stamped[clock] = patch[idField] ? this.ctx.now : null;
    }
    if ("dispatched" in patch && patch.dispatched !== t.dispatched && !("droneIssuedAt" in patch)) {
      stamped.droneIssuedAt = patch.dispatched ? this.ctx.now : null;
    }
    Object.assign(t, patch, stamped);
    t.status = statusOf(t.phase);
    this.markTrain(t, visible || t.phase !== before);
    if (t.phase !== before) this.phaseEvent(t, before);
  }

  /** `train.phase`: a build train's span is a child of its item's; a car's is recorded in each member's trace. */
  private phaseEvent(t: TrainRecord, from: TrainPhase): void {
    const to = t.phase;
    const severity: EventDraft["severity"] = to === "EJECTED" ? "warn" : "info";
    const what = isCar(t) ? "car" : "train";
    const summary = clip500(`${what} ${t.trainId} ${from} → ${to}${to === "EJECTED" && t.reason ? `: ${t.reason}` : ""}`);
    const data = { from, to, lane: t.lane ?? "BUILD", ...(t.raceId ? { raceId: t.raceId, candidate: t.candidate ?? null } : {}), ...(t.reason && to === "EJECTED" ? { reason: t.reason } : {}) };
    this.event(t, { type: "train.phase", severity, summary, data });
  }

  private event(t: TrainRecord, e: Pick<EventDraft, "type" | "summary" | "data" | "severity">): void {
    if (isCar(t)) {
      const members = (t.members ?? []).map((id) => this.find(id)).filter((m): m is TrainRecord => !!m);
      if (members.length) {
        for (const m of members) {
          this.events.push({ ...e, actor: ACTOR, traceId: traceOfTrain(m), spanId: spanIdFor(t.trainId), parentSpanId: spanIdFor(m.trainId), itemId: m.promptId, trainId: t.trainId });
        }
        return;
      }
      this.events.push({ ...e, actor: ACTOR, traceId: traceOfTrain(t), spanId: spanIdFor(t.trainId), parentSpanId: null, itemId: null, trainId: t.trainId });
      return;
    }
    this.events.push({ ...e, actor: ACTOR, traceId: traceOfTrain(t), spanId: spanIdFor(t.trainId), parentSpanId: spanIdFor(t.promptId), itemId: t.promptId, trainId: t.trainId });
  }

  private markTrain(t: TrainRecord, visible = true): void {
    this.dirtyTrains.set(t.trainId, (this.dirtyTrains.get(t.trainId) ?? false) || visible);
  }

  private markPrompt(p: PromptRecord, visible = true): void {
    this.dirtyPrompts.set(p.promptId, (this.dirtyPrompts.get(p.promptId) ?? false) || visible);
  }

  /** Prompt status of a BUILD train's prompt (cars carry several prompts and set none). */
  private promptStatus(t: TrainRecord, status: PromptStatus): void {
    if (!isCar(t)) this.setPromptStatus(t.promptId, status);
  }

  private promptSummary(t: TrainRecord, summary: string): void {
    if (!isCar(t)) this.setPromptSummary(t.promptId, summary);
  }

  private setPromptStatus(promptId: string, status: PromptStatus): void {
    const p = this.prompts.get(promptId);
    if (!p || p.status === status) return;
    p.status = status;
    this.markPrompt(p);
  }

  private setPromptSummary(promptId: string, summary: string): void {
    const p = this.prompts.get(promptId);
    if (!p || p.summary === summary) return;
    p.summary = summary;
    this.markPrompt(p, false);
  }

  private finish(outcome: Outcome): PlanResult {
    const prompts = [...this.dirtyPrompts.keys()].map((id) => ({ ...this.prompts.get(id)! }));
    const trains = [...this.dirtyTrains.keys()].map((id) => copyTrain(this.find(id)!));
    const deployments = [...this.dirtyDeployments].map((id) => ({ ...this.deployments.get(id)! }));
    const races = [...this.dirtyRaces].map((id) => {
      const r = this.races.get(id)!;
      return { ...r, trainIds: [...r.trainIds] };
    });
    const broadcasts: Effect[] = [
      ...prompts
        .filter((p) => this.dirtyPrompts.get(p.promptId))
        .map((p): Effect => ({ type: "broadcast", message: { type: "prompt.updated", promptRun: toPromptRun(p) } })),
      ...trains
        .filter((t) => this.dirtyTrains.get(t.trainId))
        .map((t): Effect => ({ type: "broadcast", message: { type: "train.updated", train: toMergeTrain(t) } })),
      ...deployments.map((d): Effect => ({ type: "broadcast", message: { type: "deployment.updated", deployment: d } })),
      ...races.map((r): Effect => ({ type: "broadcast", message: { type: "race.updated", race: r } })),
    ];
    // The watchdog may re-issue a command that reconcile then re-emits: one dispatch each.
    const seen = new Set<string>();
    const effects = this.effects.filter((e) => {
      const key =
        e.type === "provision" || e.type === "deploy"
          ? `cmd:${e.command.commandId}`
          : e.type === "dispatchDrone"
            ? `drone:${e.trainId}:${e.task.action}:${e.attempt}`
            : null;
      if (key === null) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const result: PlanResult = {
      outcome,
      prompts,
      trains,
      deployments,
      effects: [...effects, ...broadcasts],
      modelStats: this.modelDeltas,
      ...(this.routerDirty ? { routerDispatches: this.routerDispatches } : {}),
      ...(this.floorDirty ? { routerFloor: { ...this.floor } } : {}),
      events: this.events,
      races,
      ...(this.landed ? { landed: this.landed } : {}),
      conflictClaims: this.conflictClaims,
      itemConflicts: [...this.dirtyConflicts].map((itemId) => ({ itemId, conflicts: this.conflicts.get(itemId)! })),
      ...(this.carInfraDirty ? { carInfraFailures: this.carInfraFailures } : {}),
      ...(this.executorLost ? { executorLost: true } : {}),
      ...(this.infraFailed.length ? { infraFailed: this.infraFailed } : {}),
      ...(this.awaitingContributor.length ? { awaitingContributor: this.awaitingContributor } : {}),
      ...(this.abortedIntents.length ? { abortedIntents: this.abortedIntents } : {}),
      ...(this.picks.length ? { picks: this.picks } : {}),
      ...(this.refused ? { refused: this.refused } : {}),
      slots: [...this.dirtySlots].map((id) => {
        const s = this.slots.get(id)!;
        return { ...s, rework: s.rework ? { ...s.rework } : null };
      }),
      reworkWaits: [...this.reworkWaits].map(([itemId, waitReason]) => ({ itemId, waitReason })),
    };
    this.picks = [];
    this.refused = null;
    this.infraFailed = [];
    this.awaitingContributor = [];
    this.abortedIntents = [];
    this.modelDeltas = [];
    this.events = [];
    this.landed = null;
    this.conflictClaims = [];
    this.routerDirty = false;
    this.floorDirty = false;
    this.carInfraDirty = false;
    this.dirtyPrompts.clear();
    this.dirtyTrains.clear();
    this.dirtyDeployments.clear();
    this.dirtyRaces.clear();
    this.dirtyConflicts.clear();
    this.dirtySlots.clear();
    this.reworkWaits.clear();
    this.effects = [];
    return result;
  }
}

/** `FORK.from` for a seeded REWORK (absent: fork `sourceRepo`, hive main). */
function seedFrom(seed: { repo: string } | null): { from?: string } {
  return seed ? { from: seed.repo } : {};
}

function toCandidate(t: TrainRecord): RaceCandidate {
  return {
    trainId: t.trainId,
    candidate: t.candidate ?? 0,
    passed: t.raceOutcome === "PASSED" || t.raceOutcome === "WON",
    score: t.score ?? null,
    verified: t.verified ?? null,
    changedPaths: t.changedPaths ?? null,
    credits: t.credits ?? null,
    model: t.model,
  };
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function clip200(s: string): string {
  return clip(s, 200);
}

function clip500(s: string): string {
  return clip(s, 500);
}

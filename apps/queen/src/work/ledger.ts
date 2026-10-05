/**
 * Work ledger planner (v2 design §2.1, §2.2, §2.3.1, §2.3.5, §2.5, §2.9, §3.4).
 * Pure: no I/O, no clock (ctx.now), no randomness (ctx.newId).
 *
 * The ledger turns prompts into work items (a goal fans out into features,
 * bugs and chores through the Oracle), walks each item through its state
 * machine, and dispatches READY items to the train planner:
 *
 *   DECOMPOSING ──Oracle ok / fallback──▶ children filed, goal ACTIVE (rollup)
 *   TRIAGE ──dup ≥ 0.90──▶ DUPLICATE ──not_duplicate──▶ READY / BLOCKED
 *   TRIAGE ──no dup──▶ BLOCKED ──deps LANDED──▶ READY ──dispatch──▶ ACTIVE
 *   ACTIVE ──car MERGED──▶ LANDED ──release SHIPPED──▶ SHIPPED
 *   ACTIVE ──prompt FAILED──▶ FAILED (+ REWORK_EXHAUSTED) ──retry──▶ READY
 *   TRIAGE / BLOCKED / READY / FAILED ──cancel──▶ CANCELLED
 *
 * Like TrainPlanner and ReleasePlanner, every public method returns the
 * changed rows plus events and effects (Oracle commands, broadcasts) for the
 * Queen to persist and execute in one transaction. Rows are returned even when
 * a user call is `rejected` (a GUARDRAIL_TRIPPED escalation may be opened).
 *
 * State contract (what the Queen loads into `WorkState.items`):
 * - every non-terminal item (TERMINAL = SHIPPED, DUPLICATE, CANCELLED);
 * - every child of a non-terminal goal (goal rollup);
 * - every item a call names: a filing's parent and dependsOn, the items of a
 *   release in `absorb`, the prior Queen bug of a failed release, and the
 *   dependencies and duplicate targets of loaded items.
 * A dependency that is not loaded is "unknown" and keeps its dependent BLOCKED.
 */
import {
  CHILD_DEDUPE_THRESHOLD,
  DEDUPE_THRESHOLD,
  MODEL_CATALOG,
  TERMINAL_WORK_STATUSES,
  escalationActions,
  spanIdFor,
  traceIdFromUuid,
  traceparent,
  type AutonomyLevel,
  type DecomposedChild,
  type Difficulty,
  type EscalationAction,
  type EscalationReason,
  type EscalationSubject,
  type EventDraft,
  type EventSeverity,
  type EventType,
  type FileWorkItem,
  type FollowUp,
  type HiveSettings,
  type MergeConflict,
  type ModelChoice,
  type OracleCommand,
  type OracleResult,
  type PromptStatus,
  type QueenServerMessage,
  type ReleasePhase,
  type SimilarItem,
  type WorkAction,
  type WorkItem,
  type WorkKind,
  type WorkSource,
  type WorkStatus,
} from "@queenos/queen-types";
import type { EscalationRecord, HiveSettingsRecord, PathClaim } from "../records";
import type { WorkItemRecord } from "../records";
import { affinityWaitReason, blockingClaim, claimsFor, widen } from "./affinity";
import { composePrompt, itemTextFromPrompt, releaseBugText, MAX_BODY_CHARS, MAX_TITLE_CHARS } from "./compose";
import {
  budgetExhausted,
  checkFiling,
  creditsFor,
  defaultSettingsRecord,
  dispatchesLeft,
  effectiveSettings,
  epochHour,
  followUpPriority,
  normalizePaths,
  normalizeTitle,
  rollBudgetDay,
} from "./guardrails";

// ── public types ─────────────────────────────────────────────────────────

export interface WorkState {
  /** See the state contract in the module comment. */
  items: WorkItemRecord[];
  /** `path_claims` rows of ACTIVE items (stale rows of other items are released by reconcile). */
  claims: PathClaim[];
  /** OPEN escalations (hive-level dedupe; an item's escalation is resolved by retry / cancel). */
  escalations: EscalationRecord[];
  /** The `hive_settings` row; null before the first filing (created, autonomous; D2). */
  settings: HiveSettingsRecord | null;
  /** max(work_items.seq). */
  maxSeq: number;
}

export interface WorkContext {
  hive: string;
  now: number;
  newId: () => string;
  /** Effective autonomy (autonomy/policy.ts); `paused` stops dispatch. Default: the configured level. */
  autonomy?: AutonomyLevel;
  /** Router choice for role "planner" (DECOMPOSE). Default: the catalog's planner models, in order. */
  plannerModel?: ModelChoice;
  /** Oracle watchdog: an unreported command older than this is re-issued. Default 10 min. */
  commandTimeoutMs?: number;
  /** BUILD trainId → itemId (= promptId) for trains not in the absorbed input (a release's MERGED trains). */
  itemOfTrain?: (trainId: string) => string | null;
  /**
   * Race width of a dispatch (train/race.ts `raceWidth`). Default: bestOf, or
   * `race.hardWidth` for a hard item, else 1; capped by maxRaceWidth. The
   * planner always clamps the answer to [1, slotsFree].
   */
  widthOf?: (item: WorkItemRecord, slotsFree: number, settings: HiveSettings) => number;
}

export type WorkOutcome =
  | "applied"
  | "ignored:unknown"
  | "ignored:stale"
  | "ignored:duplicate"
  /** The action is not valid in the item's current status (HTTP 409). */
  | "conflict"
  /** A user filing broke a guardrail or named an unknown item (HTTP `error.status`). */
  | "rejected";

export interface WorkError {
  status: 400 | 404 | 409;
  code: string;
  message: string;
}

/** A READY item handed to `TrainPlanner.submit` (prompt_runs.prompt_id = itemId). */
export interface DispatchSubmission {
  itemId: string;
  promptText: string;
  /** Race width (≥ 1, already fitted to the free slots and the dispatch budget). */
  width: number;
  difficulty: Difficulty;
  priority: number;
  bestOf: number | null;
  traceId: string;
  spanId: string;
}

export type WorkEffect =
  | { type: "oracle"; itemId: string; command: OracleCommand }
  | { type: "broadcast"; message: QueenServerMessage };

export interface WorkPlanResult {
  outcome: WorkOutcome;
  error?: WorkError;
  /** The item a filing created or an action targeted. */
  itemId?: string;
  items: WorkItemRecord[];
  /** Claims to upsert (`upsertClaim`). */
  claims: PathClaim[];
  /** Items whose claims are all deleted (`deleteClaims`), applied before `claims`. */
  releasedClaims: string[];
  escalations: EscalationRecord[];
  /** The whole settings row, when it changed (budget, hourly counter). */
  settings?: HiveSettingsRecord;
  events: EventDraft[];
  effects: WorkEffect[];
  /** dispatchReady only: items to submit, in dispatch order. */
  submissions: DispatchSubmission[];
  /** reconcile only: the SwarmGovernor lease should be renewed before the next decide(). */
  leaseDue?: boolean;
}

/** Train-planner prompt rows (structurally: PromptRecord). */
export interface AbsorbPrompt {
  promptId: string;
  status: PromptStatus;
  summary?: string | null;
  /** Gate-failure reworks so far (mirrored onto the item). */
  attempts?: number;
  /** Merge-conflict reworks so far, when the train planner tracks them (mirrored; D7). */
  conflicts?: number;
}

/** Train-planner train rows (structurally: TrainRecord). */
export interface AbsorbTrain {
  trainId: string;
  promptId: string;
  phase?: string;
  lane?: "BUILD" | "QUEUE";
  changedPaths?: string[];
  conflict?: MergeConflict | null;
}

/** Release-planner rows (structurally: ReleaseRecord). */
export interface AbsorbRelease {
  releaseId: string;
  phase: ReleasePhase;
  /** Member BUILD trains it carries. */
  trainIds: string[];
  summary?: string | null;
  canaryPercent?: number | null;
  traceId?: string | null;
  /** The items it carries, when the Queen resolved them (else via trains / ctx.itemOfTrain). */
  itemIds?: string[];
}

/** Follow-ups from a build (`BuildResult.followUps`) or a gate (`TrainResult.followUps`). */
export interface AbsorbFollowUps {
  source: "drone" | "gatekeeper";
  /** `drone:BUILDER`, `gatekeeper:SECURITY`, ... */
  actor: string;
  /** The item being built / gated. */
  itemId: string | null;
  trainId: string | null;
  followUps: FollowUp[];
}

/** A BUILD member the merge queue failed (queue.ts MemberFailure). */
export interface AbsorbMemberFailure {
  trainId: string;
  itemId?: string;
  cause: "conflict" | "integration";
  claimPaths: string[];
}

export interface AbsorbInput {
  prompts?: readonly AbsorbPrompt[];
  trains?: readonly AbsorbTrain[];
  releases?: readonly AbsorbRelease[];
  followUps?: readonly AbsorbFollowUps[];
  memberFailures?: readonly AbsorbMemberFailure[];
  /** Credits spent by this transition (builds), added to today's budget. */
  credits?: number;
}

export interface DispatchCapacity {
  /** Active BUILD-lane trains (race candidates included). */
  activeBuilds: number;
  /** SwarmGovernor lease (§4.3); absent = no global cap. */
  leasedSlots?: number | null;
}

export interface FileGoalInput {
  promptText: string;
  priority?: number;
  bestOf?: number;
  /** `user:<email>` (or `user` for the open v1 route). */
  actor: string;
  itemId?: string;
}

export interface FileItemInput extends FileWorkItem {
  actor: string;
  itemId?: string;
}

export interface FilePromptInput {
  promptText: string;
  decompose?: boolean;
  priority?: number;
  bestOf?: number;
  actor: string;
  itemId?: string;
}

// ── constants and pure helpers ───────────────────────────────────────────

/** Oracle command attempts (each a new Workflow instance) before the fallback (same cap as executor commands). */
export const MAX_ORACLE_ATTEMPTS = 3;
export const DEFAULT_ORACLE_TIMEOUT_MS = 10 * 60_000;
/** Open items sent to DECOMPOSE as context. */
export const MAX_OPEN_ITEMS_CONTEXT = 30;
/** Renew the SwarmGovernor lease this long before it expires. */
export const LEASE_RENEW_MARGIN_MS = 30_000;
/** Max hops when resolving a `duplicateOf` chain. */
const MAX_DUP_HOPS = 10;

const TERMINAL: ReadonlySet<WorkStatus> = new Set(TERMINAL_WORK_STATUSES);
const ORACLE_STATUSES: ReadonlySet<WorkStatus> = new Set(["DECOMPOSING", "TRIAGE"]);
const DEP_MET: ReadonlySet<WorkStatus> = new Set(["LANDED", "SHIPPED"]);
const CANCELLABLE: ReadonlySet<WorkStatus> = new Set(["TRIAGE", "BLOCKED", "READY", "FAILED"]);

export function isTerminalWork(status: WorkStatus): boolean {
  return TERMINAL.has(status);
}

/** Dispatch order: priority, then filing seq. */
export function dispatchOrder(a: Pick<WorkItemRecord, "priority" | "seq">, b: Pick<WorkItemRecord, "priority" | "seq">): number {
  return a.priority - b.priority || a.seq - b.seq;
}

/** `<itemId>-<op>-<n>`. */
export function oracleCommandId(itemId: string, op: "decompose" | "triage", attempt: number): string {
  return `${itemId}-${op}-${attempt}`;
}

function attemptOf(commandId: string | null): number {
  return commandId ? Number(/-(\d+)$/.exec(commandId)?.[1] ?? 0) : 0;
}

/**
 * When the DO alarm must next run for the Oracle watchdog: the earliest
 * `commandIssuedAt + timeout` over items waiting on an Oracle command, or null.
 */
export function workWatchdogDeadline(items: readonly WorkItemRecord[], timeoutMs: number, now: number): number | null {
  const at = items.filter((i) => ORACLE_STATUSES.has(i.status) && i.commandId).map((i) => (i.commandIssuedAt ?? now) + timeoutMs);
  return at.length ? Math.min(...at) : null;
}

/** The planner model a DECOMPOSE uses when the Queen gives none: the catalog's planner models, in order. */
export function defaultPlannerChoice(): ModelChoice {
  const planners = MODEL_CATALOG.filter((m) => m.roles.includes("planner"));
  const first = planners[0] ?? MODEL_CATALOG[0]!;
  return {
    model: first.id,
    tier: first.tier,
    role: "planner",
    reason: "catalog planner default",
    fallbacks: planners.slice(1, 4).map((m) => m.id),
  };
}

/** The contract shape of a row (drops Queen-internal columns). */
export function toWorkItem(r: WorkItemRecord): WorkItem {
  return {
    itemId: r.itemId,
    hive: r.hive,
    kind: r.kind,
    title: r.title,
    body: r.body,
    acceptance: [...r.acceptance],
    priority: r.priority,
    status: r.status,
    parentId: r.parentId,
    rootId: r.rootId,
    depth: r.depth,
    dependsOn: [...r.dependsOn],
    source: { ...r.source },
    traceId: r.traceId,
    spanId: r.spanId,
    difficulty: r.difficulty,
    bestOf: r.bestOf,
    attempts: r.attempts,
    conflicts: r.conflicts,
    paths: [...r.paths],
    waitReason: r.waitReason,
    duplicateOf: r.duplicateOf,
    blockedReason: r.blockedReason,
    releaseId: r.releaseId,
    escalationId: r.escalationId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function copyItem(i: WorkItemRecord): WorkItemRecord {
  return {
    ...i,
    acceptance: [...i.acceptance],
    dependsOn: [...i.dependsOn],
    paths: [...i.paths],
    source: { ...i.source },
  };
}

function claimKey(c: Pick<PathClaim, "path" | "itemId">): string {
  return `${c.itemId}\u0000${c.path}`;
}

type DepVerdict = { met: true } | { met: false; reason: string };

interface NewItemSpec {
  itemId: string;
  kind: WorkKind;
  title: string;
  body: string;
  acceptance: string[];
  priority: number;
  status: WorkStatus;
  parentId: string | null;
  rootId: string;
  depth: number;
  dependsOn: string[];
  source: WorkSource;
  traceId: string;
  difficulty: Difficulty;
  bestOf: number | null;
  paths: string[];
  duplicateOf?: string | null;
}

// ── the planner ──────────────────────────────────────────────────────────

export class WorkPlanner {
  private readonly items = new Map<string, WorkItemRecord>();
  private readonly claims = new Map<string, PathClaim>();
  private readonly escalations = new Map<string, EscalationRecord>();
  private settings: HiveSettingsRecord;
  private readonly hs: HiveSettings;
  private maxSeq: number;
  private readonly timeoutMs: number;

  private readonly dirtyItems = new Set<string>();
  private readonly dirtyClaims = new Set<string>();
  private readonly released = new Set<string>();
  private readonly dirtyEscalations = new Set<string>();
  private settingsDirty = false;
  private events: EventDraft[] = [];
  private effects: WorkEffect[] = [];
  private submissions: DispatchSubmission[] = [];

  constructor(
    state: WorkState,
    private readonly ctx: WorkContext,
  ) {
    for (const i of state.items) this.items.set(i.itemId, copyItem(i));
    for (const c of state.claims) this.claims.set(claimKey(c), { ...c });
    for (const e of state.escalations) this.escalations.set(e.escalationId, { ...e, subject: { ...e.subject }, actions: [...e.actions] });
    this.maxSeq = state.maxSeq;
    this.timeoutMs = ctx.commandTimeoutMs ?? DEFAULT_ORACLE_TIMEOUT_MS;
    if (state.settings) {
      this.settings = { ...state.settings, degradedBy: [...state.settings.degradedBy] };
    } else {
      this.settings = defaultSettingsRecord(ctx.hive, ctx.now);
      this.settingsDirty = true;
    }
    this.hs = effectiveSettings(this.settings);
    const rolled = rollBudgetDay(this.settings, ctx.now);
    if (rolled !== this.settings) {
      this.settings = rolled;
      this.settingsDirty = true;
    }
  }

  /** The effective autonomy dispatch obeys. */
  private get autonomy(): AutonomyLevel {
    return this.ctx.autonomy ?? this.settings.autonomy;
  }

  // ── filing ────────────────────────────────────────────────────────────

  /** `submit_prompt`: `decompose` files a goal (Oracle DECOMPOSE); otherwise one user `feature` item (v1 semantics). */
  filePrompt(input: FilePromptInput): WorkPlanResult {
    if (input.decompose) return this.fileGoal(input);
    const text = itemTextFromPrompt(input.promptText);
    return this.fileItem({
      kind: "feature",
      title: text.title,
      body: text.body,
      acceptance: [],
      priority: input.priority ?? 2,
      dependsOn: [],
      paths: [],
      ...(input.bestOf !== undefined ? { bestOf: input.bestOf } : {}),
      actor: input.actor,
      ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
    });
  }

  /** A user prompt to decompose: one `goal` item in DECOMPOSING, and an Oracle DECOMPOSE command. */
  fileGoal(input: FileGoalInput): WorkPlanResult {
    const g = this.hs.guardrails;
    const verdict = checkFiling({ depth: 0, openItems: this.openCount(), autoFiled: false, autoFiledThisHour: 0, guardrails: g });
    if (!verdict.ok) return this.rejectFiling(verdict.reason, verdict.message, input.actor);
    const itemId = input.itemId ?? this.ctx.newId();
    if (this.items.has(itemId)) return this.finish("ignored:duplicate", { itemId });
    const text = itemTextFromPrompt(input.promptText);
    const goal = this.create({
      itemId,
      kind: "goal",
      title: text.title,
      body: text.body,
      acceptance: [],
      priority: input.priority ?? 2,
      status: "DECOMPOSING",
      parentId: null,
      rootId: itemId,
      depth: 0,
      dependsOn: [],
      source: { kind: "user", actor: input.actor },
      traceId: traceIdFromUuid(itemId),
      difficulty: "normal",
      bestOf: input.bestOf ?? null,
      paths: [],
    });
    this.event("item.filed", goal, `goal filed: ${goal.title}`, { kind: "goal", source: "user", status: goal.status }, input.actor);
    this.issueOracle(goal, "decompose", 1);
    return this.finish("applied", { itemId });
  }

  /** A user filing (`POST /items`): skips TRIAGE (users are not deduped) → READY, or BLOCKED on its dependencies. */
  fileItem(input: FileItemInput): WorkPlanResult {
    const g = this.hs.guardrails;
    const parent = input.parentId ? this.items.get(input.parentId) : undefined;
    if (input.parentId && !parent) {
      return this.finish("rejected", { error: { status: 404, code: "unknown_parent", message: `unknown parent ${input.parentId}` } });
    }
    const unknownDep = input.dependsOn.find((d) => !this.items.has(d));
    if (unknownDep !== undefined) {
      return this.finish("rejected", { error: { status: 400, code: "unknown_dependency", message: `unknown dependency ${unknownDep}` } });
    }
    const depth = parent ? parent.depth + 1 : 0;
    const verdict = checkFiling({ depth, openItems: this.openCount(), autoFiled: false, autoFiledThisHour: 0, guardrails: g });
    if (!verdict.ok) return this.rejectFiling(verdict.reason, verdict.message, input.actor);
    const itemId = input.itemId ?? this.ctx.newId();
    if (this.items.has(itemId)) return this.finish("ignored:duplicate", { itemId });
    const item = this.create({
      itemId,
      kind: input.kind,
      title: clip(input.title, MAX_TITLE_CHARS),
      body: clip(input.body, MAX_BODY_CHARS),
      acceptance: input.acceptance.slice(0, 8),
      priority: input.priority,
      status: "BLOCKED",
      parentId: parent?.itemId ?? null,
      rootId: parent?.rootId ?? itemId,
      depth,
      dependsOn: [...new Set(input.dependsOn)].slice(0, 8),
      source: { kind: "user", actor: input.actor },
      traceId: parent?.traceId ?? traceIdFromUuid(itemId),
      difficulty: input.difficulty ?? "normal",
      bestOf: input.bestOf ?? null,
      paths: normalizePaths(input.paths),
    });
    this.settleNew(item);
    this.event("item.filed", item, `${item.kind} filed: ${item.title}`, { kind: item.kind, source: "user", status: item.status }, input.actor);
    this.settle();
    return this.finish("applied", { itemId });
  }

  private rejectFiling(reason: string, message: string, actor: string): WorkPlanResult {
    this.event("guardrail.tripped", null, `user filing refused: ${message}`, { guardrail: reason, actor }, "queen", "warn");
    if (!this.hasOpen("GUARDRAIL_TRIPPED", { type: "hive", id: this.ctx.hive })) {
      this.openEscalation("GUARDRAIL_TRIPPED", { type: "hive", id: this.ctx.hive }, `A user filing was refused: ${message}.`, null, ["ack"]);
    }
    return this.finish("rejected", { error: { status: 409, code: reason, message } });
  }

  // ── Oracle results ────────────────────────────────────────────────────

  /** An Oracle DECOMPOSE or TRIAGE result (idempotent by commandId). */
  oracleResult(r: OracleResult): WorkPlanResult {
    const item = this.items.get(r.itemId);
    if (!item) return this.finish("ignored:unknown");
    if (item.commandId !== r.commandId) {
      // Answered (or cancelled) items no longer wait on the Oracle: a re-delivery is a duplicate; an older attempt is stale.
      return this.finish(ORACLE_STATUSES.has(item.status) ? "ignored:stale" : "ignored:duplicate", { itemId: item.itemId });
    }
    const credits = creditsFor(r.model, r.usage);
    if (credits > 0) this.addCredits(credits);
    this.event("command.result", item, `oracle ${r.op} ${r.ok ? "ok" : "failed"}${r.summary ? `: ${r.summary}` : ""}`, {
      op: r.op,
      ok: r.ok,
      ...(r.model ? { model: r.model } : {}),
      ...(credits > 0 ? { credits } : {}),
    }, "oracle", r.ok ? "info" : "warn", r.commandId);
    if (r.op === "DECOMPOSE" && item.status === "DECOMPOSING") this.decompose(item, r.ok ? (r.children ?? []) : [], r.commandId);
    else if (r.op === "TRIAGE" && item.status === "TRIAGE") this.triage(item, r.ok ? (r.similar ?? []) : []);
    else return this.finish("ignored:stale", { itemId: item.itemId });
    this.settle();
    return this.finish("applied", { itemId: item.itemId });
  }

  /**
   * File a goal's children (§2.2 step 5): duplicates (≥ CHILD_DEDUPE_THRESHOLD
   * against a live item, resolved through duplicateOf chains), dependency keys
   * mapped to ids (cycles dropped), paths normalised, extras over
   * maxChildrenPerItem dropped (GUARDRAIL_TRIPPED). No children (ok:false, an
   * empty answer, the watchdog) → one `feature` child with the whole prompt.
   */
  private decompose(goal: WorkItemRecord, answer: readonly DecomposedChild[], commandId: string | null): void {
    const max = this.hs.guardrails.maxChildrenPerItem;
    const seenKeys = new Set<string>();
    let children = answer.filter((c) => !seenKeys.has(c.key) && seenKeys.add(c.key));
    const fallback = children.length === 0;
    if (fallback) {
      children = [
        {
          key: "c1",
          kind: "feature",
          title: goal.title,
          body: goal.body,
          acceptance: [],
          priority: goal.priority,
          difficulty: goal.difficulty,
          dependsOn: [],
          paths: [],
          similar: [],
        },
      ];
    }
    const dropped = children.slice(max);
    children = children.slice(0, max);
    if (dropped.length) {
      const msg = `${answer.length} children proposed: kept ${max} (maxChildrenPerItem), dropped ${dropped.map((c) => c.key).join(", ")}`;
      this.event("guardrail.tripped", goal, msg, { guardrail: "maxChildrenPerItem", dropped: dropped.map((c) => c.key) }, "queen", "warn");
      this.openEscalation("GUARDRAIL_TRIPPED", { type: "item", id: goal.itemId }, `Goal "${clip(goal.title, 60)}": ${msg}.`, goal.traceId, ["ack"]);
    }

    const idOf = (key: string) => `${goal.itemId}-${key}`;
    const kept = new Set(children.map((c) => c.key));
    // Duplicates against live items that existed before this answer.
    const dupOf = new Map<string, string>();
    for (const c of children) {
      const target = this.bestDuplicate(c.similar, CHILD_DEDUPE_THRESHOLD, new Set([goal.itemId, idOf(c.key)]));
      if (target) dupOf.set(c.key, target);
    }
    // Dependency edges between children, in answer order; an edge that closes a cycle is dropped.
    const edges = new Map<string, string[]>(children.map((c) => [c.key, []]));
    const reaches = (from: string, to: string): boolean => {
      const stack = [from];
      const seen = new Set<string>();
      while (stack.length) {
        const k = stack.pop()!;
        if (k === to) return true;
        if (seen.has(k)) continue;
        seen.add(k);
        stack.push(...(edges.get(k) ?? []));
      }
      return false;
    };
    const cycles: string[] = [];
    for (const c of children) {
      for (const d of c.dependsOn) {
        if (!kept.has(d) || d === c.key || edges.get(c.key)!.includes(d)) continue;
        if (reaches(d, c.key)) {
          cycles.push(`${c.key}→${d}`);
          continue;
        }
        edges.get(c.key)!.push(d);
      }
    }
    if (cycles.length) {
      this.event("guardrail.tripped", goal, `dependency cycle: dropped ${cycles.join(", ")}`, { guardrail: "dependencyCycle", dropped: cycles }, "queen", "warn");
    }

    const created: WorkItemRecord[] = [];
    for (const c of children) {
      const itemId = idOf(c.key);
      if (this.items.has(itemId)) continue; // re-delivery
      const deps = edges.get(c.key)!.map((d) => dupOf.get(d) ?? idOf(d));
      const dup = dupOf.get(c.key) ?? null;
      created.push(
        this.create({
          itemId,
          kind: c.kind,
          title: clip(c.title, MAX_TITLE_CHARS),
          body: clip(c.body, MAX_BODY_CHARS),
          acceptance: c.acceptance.slice(0, 8),
          priority: Math.max(c.priority, goal.priority),
          status: dup ? "DUPLICATE" : "BLOCKED",
          parentId: goal.itemId,
          rootId: goal.rootId,
          depth: goal.depth + 1,
          dependsOn: [...new Set(deps)].slice(0, 8),
          source: { kind: "oracle", actor: "oracle", itemId: goal.itemId, ...(commandId ? { commandId } : {}) },
          traceId: goal.traceId,
          difficulty: c.difficulty,
          bestOf: goal.bestOf,
          paths: normalizePaths(c.paths),
          duplicateOf: dup,
        }),
      );
    }
    for (const child of created) if (child.status !== "DUPLICATE") this.settleNew(child);
    for (const child of created) {
      this.event("item.filed", child, `${child.kind} filed: ${child.title}`, { kind: child.kind, source: "oracle", status: child.status, paths: child.paths }, "oracle");
      if (child.duplicateOf) this.event("item.duplicate", child, `duplicate of ${child.duplicateOf}`, { duplicateOf: child.duplicateOf }, "oracle");
    }
    goal.commandId = null;
    goal.commandIssuedAt = null;
    this.setStatus(goal, "ACTIVE", "queen");
    this.event("item.decomposed", goal, fallback ? "decomposition fell back to one item" : `decomposed into ${created.length} items`, {
      fallback,
      children: created.map((c) => c.itemId),
      duplicates: created.filter((c) => c.duplicateOf).length,
      dropped: dropped.length,
    }, "queen", fallback ? "warn" : "info");
  }

  /** TRIAGE (§2.9): an auto-filed item scoring ≥ DEDUPE_THRESHOLD against a live item is a DUPLICATE; else READY / BLOCKED. */
  private triage(item: WorkItemRecord, similar: readonly SimilarItem[]): void {
    item.commandId = null;
    item.commandIssuedAt = null;
    this.markItem(item);
    const target = this.bestDuplicate(similar, DEDUPE_THRESHOLD, new Set([item.itemId]));
    if (target) {
      item.duplicateOf = target;
      this.setStatus(item, "DUPLICATE", "queen");
      this.event("item.duplicate", item, `duplicate of ${target}`, { duplicateOf: target }, "oracle");
      return;
    }
    this.setStatus(item, this.depStatus(item), "queen");
  }

  /** The live item a similar-list points to (best score first, through duplicateOf chains), or null. */
  private bestDuplicate(similar: readonly SimilarItem[], threshold: number, exclude: ReadonlySet<string>): string | null {
    const sorted = [...similar].sort((a, b) => b.score - a.score);
    for (const s of sorted) {
      if (s.score < threshold) break;
      const target = this.resolveDuplicate(s.itemId);
      if (!target || exclude.has(target.itemId) || isTerminalWork(target.status) || target.kind === "goal") continue;
      return target.itemId;
    }
    return null;
  }

  /** Follow `duplicateOf` to the live original (null when the chain leaves the loaded items or loops). */
  private resolveDuplicate(itemId: string): WorkItemRecord | null {
    let cur = this.items.get(itemId);
    for (let hops = 0; cur && cur.status === "DUPLICATE" && cur.duplicateOf; hops++) {
      if (hops >= MAX_DUP_HOPS) return null;
      cur = this.items.get(cur.duplicateOf);
    }
    return cur ?? null;
  }

  // ── absorbing train / release / queue outcomes ────────────────────────

  /**
   * Fold the other planners' changes into the ledger (§3.1 `wp.absorb`):
   * prompt status → item status (MERGED → LANDED, FAILED → FAILED +
   * REWORK_EXHAUSTED); `changedPaths` and conflict paths → claims; a release
   * SHIPPED → its LANDED items SHIPPED; ROLLED_BACK / FAILED → one P0 bug per
   * release (the rollback streak is the ReleasePlanner's, WP1.3);
   * follow-ups → TRIAGE items behind the guardrails.
   */
  absorb(input: AbsorbInput): WorkPlanResult {
    if (input.credits && input.credits > 0) this.addCredits(input.credits);
    const trainItem = new Map<string, string>();
    for (const t of input.trains ?? []) trainItem.set(t.trainId, t.promptId);
    const itemOfTrain = (trainId: string): string | null => trainItem.get(trainId) ?? this.ctx.itemOfTrain?.(trainId) ?? null;
    const mirroredConflicts = new Set<string>();

    for (const p of input.prompts ?? []) {
      const item = this.items.get(p.promptId);
      if (!item || item.kind === "goal") continue;
      if (item.status !== "ACTIVE") continue;
      if (p.attempts !== undefined && p.attempts !== item.attempts) {
        item.attempts = p.attempts;
        this.markItem(item);
      }
      if (p.conflicts !== undefined) {
        mirroredConflicts.add(item.itemId);
        if (p.conflicts !== item.conflicts) {
          item.conflicts = p.conflicts;
          this.markItem(item);
        }
      }
      if (p.status === "MERGED") this.setStatus(item, "LANDED", "queen");
      else if (p.status === "FAILED") this.failItem(item, p.summary ?? null);
    }

    for (const t of input.trains ?? []) {
      if ((t.lane ?? "BUILD") !== "BUILD") continue;
      const item = this.items.get(t.promptId);
      if (!item) continue;
      if (item.status === "ACTIVE" && t.changedPaths?.length) this.widenClaims(item, t.changedPaths, "actual");
      if (item.status === "ACTIVE" && t.conflict?.paths.length) this.widenClaims(item, t.conflict.paths, "conflict");
      if (item.status === "ACTIVE" && t.phase === "MERGED") this.setStatus(item, "LANDED", "queen");
    }

    for (const f of input.memberFailures ?? []) {
      const id = f.itemId ?? itemOfTrain(f.trainId);
      const item = id ? this.items.get(id) : undefined;
      if (!item || item.status !== "ACTIVE") continue;
      if (f.cause === "conflict" && !mirroredConflicts.has(item.itemId)) {
        item.conflicts += 1;
        this.markItem(item);
      }
      if (f.claimPaths.length) this.widenClaims(item, f.claimPaths, "conflict");
    }

    for (const r of input.releases ?? []) this.absorbRelease(r, itemOfTrain);
    for (const f of input.followUps ?? []) this.fileFollowUps(f);
    this.settle();
    return this.finish("applied");
  }

  private absorbRelease(r: AbsorbRelease, itemOfTrain: (trainId: string) => string | null): void {
    const ids = r.itemIds ?? r.trainIds.map(itemOfTrain).filter((x): x is string => x !== null);
    const items = [...new Set(ids)].map((id) => this.items.get(id)).filter((x): x is WorkItemRecord => x !== undefined);
    if (r.phase === "SHIPPED") {
      for (const item of items) {
        if (item.status !== "LANDED") continue;
        item.releaseId = r.releaseId;
        this.setStatus(item, "SHIPPED", "queen", `shipped in release ${r.releaseId}`);
      }
      return;
    }
    if (r.phase !== "ROLLED_BACK" && r.phase !== "FAILED") return;
    // One Queen bug per release (exact ref check): a repeated release row changes nothing.
    const prior = [...this.items.values()].some((i) => i.source.kind === "queen" && i.source.releaseId === r.releaseId);
    if (prior) return;
    const text = releaseBugText({ releaseId: r.releaseId, phase: r.phase, summary: r.summary ?? null }, items.map((i) => i.title));
    const bugId = this.ctx.newId();
    const paths = normalizePaths(items.flatMap((i) => i.paths));
    const bug = this.create({
      itemId: bugId,
      kind: "bug",
      title: text.title,
      body: text.body,
      acceptance: [],
      priority: 0,
      status: "READY",
      parentId: null,
      rootId: bugId,
      depth: 0,
      dependsOn: [],
      source: { kind: "queen", actor: "queen", releaseId: r.releaseId },
      traceId: traceIdFromUuid(bugId),
      difficulty: "normal",
      bestOf: null,
      paths,
    });
    this.event("item.filed", bug, `P0 bug filed: ${bug.title}`, { kind: "bug", source: "queen", releaseId: r.releaseId, items: items.map((i) => i.itemId) }, "queen", "warn", null, r.releaseId);
    this.event("followup.filed", bug, `release ${r.releaseId} ${r.phase === "ROLLED_BACK" ? "rolled back" : "failed"}: P0 bug ${bugId}`, { origin: "release", releaseId: r.releaseId }, "queen", "warn", null, r.releaseId);
    // The rollback streak (ROLLBACK_STREAK, autonomy.degraded) is counted by the ReleasePlanner (WP1.3), not here.
  }

  /** Follow-ups (§2.9, §3.4): truncated, depth / open / hourly caps, exact dedupe, then TRIAGE. */
  private fileFollowUps(f: AbsorbFollowUps): void {
    const g = this.hs.guardrails;
    const parent = f.itemId ? this.items.get(f.itemId) : undefined;
    const keep = f.followUps.slice(0, g.maxFollowUpsPerBuild);
    for (const fu of f.followUps.slice(g.maxFollowUpsPerBuild)) {
      this.dropFollowUp(f, fu, "truncated", `more than maxFollowUpsPerBuild (${g.maxFollowUpsPerBuild})`, parent);
    }
    for (const fu of keep) {
      const asChild = f.source === "drone" && parent !== undefined;
      const depth = asChild ? parent.depth + 1 : 0;
      const ref = f.itemId ?? "";
      const norm = normalizeTitle(fu.title);
      const dup = [...this.items.values()].find(
        (i) => !isTerminalWork(i.status) && i.source.kind === f.source && (i.source.itemId ?? "") === ref && i.normalizedTitle === norm,
      );
      if (dup) {
        this.dropFollowUp(f, fu, "duplicate", `same as open item ${dup.itemId}`, parent);
        continue;
      }
      this.rollAutoFiledHour();
      const verdict = checkFiling({
        depth,
        openItems: this.openCount(),
        autoFiled: true,
        autoFiledThisHour: this.settings.autoFiledCount,
        guardrails: g,
      });
      if (!verdict.ok) {
        if (verdict.reason === "max_auto_filed_per_hour") {
          // Count the attempt: the first drop of the hour (count == cap) opens one GUARDRAIL_TRIPPED.
          if (this.settings.autoFiledCount === g.maxAutoFiledPerHour) {
            this.event("guardrail.tripped", parent ?? null, verdict.message, { guardrail: "maxAutoFiledPerHour" }, "queen", "warn");
            this.openEscalation("GUARDRAIL_TRIPPED", { type: "hive", id: this.ctx.hive }, `Auto-filing paused for this hour: ${verdict.message}.`, null, ["ack"]);
          }
          this.updateSettings({ autoFiledCount: this.settings.autoFiledCount + 1 });
        }
        this.dropFollowUp(f, fu, verdict.reason, verdict.message, parent);
        continue;
      }
      this.updateSettings({ autoFiledCount: this.settings.autoFiledCount + 1 });
      const itemId = this.ctx.newId();
      const item = this.create({
        itemId,
        kind: fu.kind,
        title: clip(fu.title, MAX_TITLE_CHARS),
        body: clip(fu.body, MAX_BODY_CHARS),
        acceptance: [],
        priority: followUpPriority(f.source, fu),
        status: "TRIAGE",
        parentId: asChild ? parent.itemId : null,
        rootId: asChild ? parent.rootId : itemId,
        depth,
        dependsOn: [],
        source: {
          kind: f.source,
          actor: f.actor,
          ...(f.itemId ? { itemId: f.itemId } : {}),
          ...(f.trainId ? { trainId: f.trainId } : {}),
        },
        traceId: asChild ? parent.traceId : traceIdFromUuid(itemId),
        difficulty: "normal",
        bestOf: null,
        paths: normalizePaths(fu.paths),
      });
      this.event("item.filed", item, `${item.kind} filed by ${f.actor}: ${item.title}`, { kind: item.kind, source: f.source, status: "TRIAGE" }, f.actor);
      this.event("followup.filed", item, `follow-up from ${f.actor}${f.itemId ? ` on ${f.itemId}` : ""}`, {
        origin: f.source,
        ...(f.itemId ? { onItem: f.itemId } : {}),
        ...(f.trainId ? { trainId: f.trainId } : {}),
      }, f.actor);
      this.issueOracle(item, "triage", 1);
    }
  }

  private dropFollowUp(f: AbsorbFollowUps, fu: FollowUp, reason: string, message: string, parent: WorkItemRecord | undefined): void {
    this.event("followup.dropped", parent ?? null, `follow-up dropped (${reason}): ${clip(fu.title, 80)}`, {
      reason,
      message,
      title: fu.title,
      origin: f.source,
      ...(f.trainId ? { trainId: f.trainId } : {}),
    }, f.actor, "warn");
  }

  private rollAutoFiledHour(): void {
    const hour = epochHour(this.ctx.now);
    if (this.settings.autoFiledHour !== hour) this.updateSettings({ autoFiledHour: hour, autoFiledCount: 0 });
  }

  // ── dispatch ──────────────────────────────────────────────────────────

  /**
   * Walk READY items by priority then seq (§2.3.1) and dispatch each one whose
   * checks all hold: autonomy ≠ paused, budget left, slots free (width lowered
   * to fit), dependencies LANDED / SHIPPED, and no path-claim overlap with an
   * ACTIVE item (§2.3.5). A skipped item does not block lower ones; it gets a
   * `waitReason` (and an `affinity.wait` event once per holder).
   */
  dispatchReady(cap: DispatchCapacity): WorkPlanResult {
    const g = this.hs.guardrails;
    const ready = [...this.items.values()].filter((i) => i.status === "READY" && i.kind !== "goal").sort(dispatchOrder);
    const slots = Math.max(0, Math.min(g.maxActiveTrains, cap.leasedSlots ?? Number.MAX_SAFE_INTEGER));
    let used = Math.max(0, cap.activeBuilds);
    const paused = this.autonomy === "paused";
    let budgetBlocked = false;

    for (const item of ready) {
      if (paused) {
        this.setWait(item, "paused");
        continue;
      }
      if (budgetExhausted(this.settings, this.hs.budget)) {
        this.setWait(item, "budget");
        budgetBlocked = true;
        continue;
      }
      if (used >= slots) {
        this.setWait(item, `capacity ${used}/${slots}`);
        continue;
      }
      const dep = this.depVerdict(item);
      if (!dep.met) {
        // Defensive: READY items have met dependencies; one that doesn't goes back to BLOCKED.
        item.blockedReason = clip(dep.reason, 200);
        item.waitReason = null;
        this.setStatus(item, "BLOCKED", "queen");
        continue;
      }
      const block = blockingClaim(item, [...this.claims.values()], this.activeIds());
      if (block) {
        const reason = affinityWaitReason(block);
        if (item.waitReason !== reason) {
          this.event("affinity.wait", item, reason, { path: block.path, holder: block.holder }, "queen");
        }
        this.setWait(item, reason);
        continue;
      }
      const slotsFree = slots - used;
      const left = dispatchesLeft(this.settings, this.hs.budget);
      const asked = this.ctx.widthOf ? this.ctx.widthOf(item, slotsFree, this.hs) : this.defaultWidth(item);
      const width = Math.max(1, Math.min(Math.trunc(asked) || 1, slotsFree, Math.max(1, left)));
      this.dispatch(item, width);
      used += width;
    }
    if (budgetBlocked && !this.hasOpen("BUDGET_EXHAUSTED", { type: "hive", id: this.ctx.hive })) {
      const s = this.settings;
      const b = this.hs.budget;
      const summary = `Today's budget is spent: ${Math.round(s.creditsUsed)}/${b.dailyCredits} credits, ${s.dispatches}/${b.dailyDispatches} dispatches. Dispatch resumes at the next UTC day.`;
      this.event("budget.exhausted", null, summary, { creditsUsed: s.creditsUsed, dispatches: s.dispatches, ...b }, "queen", "warn");
      this.openEscalation("BUDGET_EXHAUSTED", { type: "hive", id: this.ctx.hive }, summary, null);
    }
    return this.finish("applied");
  }

  private defaultWidth(item: WorkItemRecord): number {
    const w = item.bestOf ?? (item.difficulty === "hard" ? this.hs.race.hardWidth : 1);
    return Math.min(w, this.hs.guardrails.maxRaceWidth);
  }

  private dispatch(item: WorkItemRecord, width: number): void {
    item.waitReason = null;
    item.blockedReason = null;
    this.setStatus(item, "ACTIVE", "queen", width > 1 ? `dispatched (race of ${width})` : "dispatched");
    const claims = claimsFor(item, this.ctx.now);
    for (const c of claims) this.putClaim(c);
    if (claims.length) {
      this.event("affinity.claimed", item, `claimed ${claims.map((c) => c.path).join(", ")}`, { paths: claims.map((c) => c.path), source: "predicted" }, "queen", "debug");
    }
    this.updateSettings({ dispatches: this.settings.dispatches + width });
    this.submissions.push({
      itemId: item.itemId,
      promptText: composePrompt(item),
      width,
      difficulty: item.difficulty,
      priority: item.priority,
      bestOf: item.bestOf,
      traceId: item.traceId,
      spanId: item.spanId,
    });
  }

  private setWait(item: WorkItemRecord, reason: string): void {
    const r = clip(reason, 200);
    if (item.waitReason === r) return;
    item.waitReason = r;
    this.markItem(item);
  }

  // ── human actions ─────────────────────────────────────────────────────

  /** `POST /items/:id/actions` (and escalation resolutions `retry` / `cancel`). */
  action(itemId: string, a: WorkAction, actor: string): WorkPlanResult {
    switch (a.action) {
      case "retry":
        return this.retry(itemId, actor, a.note);
      case "cancel":
        return this.cancel(itemId, actor, a.note);
      case "not_duplicate":
        return this.notDuplicate(itemId, actor, a.note);
    }
  }

  /** FAILED → READY (or BLOCKED): attempts and conflicts reset; its REWORK_EXHAUSTED escalation resolves. */
  retry(itemId: string, actor: string, note?: string): WorkPlanResult {
    const item = this.items.get(itemId);
    if (!item) return this.notFound(itemId);
    if (item.status !== "FAILED" || item.kind === "goal") return this.invalid(item, "retry", "only a FAILED item can be retried");
    item.attempts = 0;
    item.conflicts = 0;
    item.blockedReason = null;
    item.waitReason = null;
    this.resolveItemEscalation(item, "retry", actor, note);
    this.setStatus(item, this.depStatus(item), actor, `retried by ${actor}${note ? `: ${note}` : ""}`);
    this.settle();
    return this.finish("applied", { itemId });
  }

  /** TRIAGE / BLOCKED / READY / FAILED → CANCELLED (ACTIVE cannot be cancelled in v2). */
  cancel(itemId: string, actor: string, note?: string): WorkPlanResult {
    const item = this.items.get(itemId);
    if (!item) return this.notFound(itemId);
    if (!CANCELLABLE.has(item.status) || item.kind === "goal") {
      return this.invalid(item, "cancel", `a ${item.kind} in ${item.status} cannot be cancelled`);
    }
    item.commandId = null; // a late TRIAGE answer becomes stale
    item.commandIssuedAt = null;
    item.waitReason = null;
    this.resolveItemEscalation(item, "cancel", actor, note);
    this.setStatus(item, "CANCELLED", actor, `cancelled by ${actor}${note ? `: ${note}` : ""}`);
    this.settle();
    return this.finish("applied", { itemId });
  }

  /** A human overrides a dedupe: DUPLICATE → READY (or BLOCKED), duplicateOf cleared. */
  notDuplicate(itemId: string, actor: string, note?: string): WorkPlanResult {
    const item = this.items.get(itemId);
    if (!item) return this.notFound(itemId);
    if (item.status !== "DUPLICATE") return this.invalid(item, "not_duplicate", "only a DUPLICATE item can be marked not a duplicate");
    const was = item.duplicateOf;
    item.duplicateOf = null;
    this.setStatus(item, this.depStatus(item), actor, `not a duplicate of ${was ?? "?"} (${actor})${note ? `: ${note}` : ""}`);
    this.settle();
    return this.finish("applied", { itemId });
  }

  private notFound(itemId: string): WorkPlanResult {
    return this.finish("ignored:unknown", { itemId, error: { status: 404, code: "unknown_item", message: `unknown item ${itemId}` } });
  }

  private invalid(item: WorkItemRecord, action: string, message: string): WorkPlanResult {
    return this.finish("conflict", { itemId: item.itemId, error: { status: 409, code: `invalid_${action}`, message: `${message} (it is ${item.status})` } });
  }

  // ── reconcile (alarm) ─────────────────────────────────────────────────

  /**
   * The alarm's ledger pass (§3.1): the Oracle watchdog (re-issue, then after
   * MAX_ORACLE_ATTEMPTS: DECOMPOSE falls back to one item, TRIAGE skips
   * dedupe, and an EXECUTOR_LOST escalation on the item says so); release the
   * claims of items that are no longer ACTIVE; unblock and roll up; the
   * budget day; and the lease renewal flag.
   */
  reconcile(): WorkPlanResult {
    const now = this.ctx.now;
    for (const item of [...this.items.values()].sort(dispatchOrder)) {
      if (!ORACLE_STATUSES.has(item.status) || !item.commandId) continue;
      if ((item.commandIssuedAt ?? now) + this.timeoutMs > now) continue;
      const op = item.status === "DECOMPOSING" ? "decompose" : "triage";
      const attempt = attemptOf(item.commandId);
      this.event("command.result", item, `oracle ${op} attempt ${attempt} timed out`, { op: op.toUpperCase(), ok: false, timeout: true }, "queen", "warn", item.commandId);
      if (attempt < MAX_ORACLE_ATTEMPTS) {
        this.issueOracle(item, op, attempt + 1);
        continue;
      }
      const summary = `The Oracle did not answer ${op.toUpperCase()} after ${attempt} attempts: ${
        op === "decompose" ? "fell back to one item with the whole prompt" : "filed without dedupe"
      }.`;
      this.openEscalation("EXECUTOR_LOST", { type: "item", id: item.itemId }, summary, item.traceId, ["ack"]);
      if (op === "decompose") this.decompose(item, [], null);
      else this.triage(item, []);
    }
    // Claims of items that are not ACTIVE (landed / failed / cancelled, or unknown) are stale.
    const active = this.activeIds();
    const stale = new Set([...this.claims.values()].filter((c) => !active.has(c.itemId)).map((c) => c.itemId));
    for (const id of stale) this.releaseClaims(id, this.items.get(id) ?? null);
    this.settle();
    const s = this.settings;
    const busy = [...this.items.values()].some((i) => i.status === "READY" || i.status === "ACTIVE") || s.leasedSlots > 0;
    const leaseDue = busy && (s.leaseExpiresAt === null || s.leaseExpiresAt - now <= LEASE_RENEW_MARGIN_MS);
    return this.finish("applied", { leaseDue });
  }

  // ── internals: state machine ──────────────────────────────────────────

  private create(spec: NewItemSpec): WorkItemRecord {
    const now = this.ctx.now;
    const item: WorkItemRecord = {
      itemId: spec.itemId,
      hive: this.ctx.hive,
      kind: spec.kind,
      title: spec.title,
      body: spec.body,
      acceptance: spec.acceptance,
      priority: spec.priority,
      status: spec.status,
      parentId: spec.parentId,
      rootId: spec.rootId,
      depth: spec.depth,
      dependsOn: spec.dependsOn,
      source: spec.source,
      traceId: spec.traceId,
      spanId: spanIdFor(spec.itemId),
      difficulty: spec.difficulty,
      bestOf: spec.bestOf,
      attempts: 0,
      conflicts: 0,
      paths: spec.paths,
      waitReason: null,
      duplicateOf: spec.duplicateOf ?? null,
      blockedReason: null,
      releaseId: null,
      escalationId: null,
      createdAt: now,
      updatedAt: now,
      seq: ++this.maxSeq,
      commandId: null,
      commandIssuedAt: null,
      normalizedTitle: normalizeTitle(spec.title),
      landedAt: null,
      shippedAt: null,
    };
    this.items.set(item.itemId, item);
    this.markItem(item);
    return item;
  }

  /** Initial status of a freshly created item from its dependencies (no event: `item.filed` carries it). */
  private settleNew(item: WorkItemRecord): void {
    const v = this.depVerdict(item);
    item.status = v.met ? "READY" : "BLOCKED";
    item.blockedReason = v.met ? null : clip(v.reason, 200);
  }

  private depStatus(item: WorkItemRecord): "READY" | "BLOCKED" {
    const v = this.depVerdict(item);
    item.blockedReason = v.met ? null : clip(v.reason, 200);
    return v.met ? "READY" : "BLOCKED";
  }

  /**
   * Dependencies are met when each one (through duplicateOf) is LANDED or
   * SHIPPED. A FAILED or CANCELLED dependency is not cascaded: the item stays
   * BLOCKED with "dependency <id> failed" (§2.1).
   */
  private depVerdict(item: WorkItemRecord): DepVerdict {
    for (const id of item.dependsOn) {
      const dep = this.resolveDuplicate(id);
      if (!dep) return { met: false, reason: `dependency ${id} unknown` };
      if (DEP_MET.has(dep.status)) continue;
      if (dep.status === "FAILED") return { met: false, reason: `dependency ${id} failed` };
      if (dep.status === "CANCELLED") return { met: false, reason: `dependency ${id} cancelled` };
      return { met: false, reason: `waiting on ${id}` };
    }
    return { met: true };
  }

  private setStatus(item: WorkItemRecord, status: WorkStatus, actor: string, why?: string): void {
    if (item.status === status) {
      this.markItem(item);
      return;
    }
    const from = item.status;
    item.status = status;
    if (status === "LANDED" && item.landedAt === null) item.landedAt = this.ctx.now;
    if (status === "SHIPPED" && item.shippedAt === null) item.shippedAt = this.ctx.now;
    if (status !== "READY") item.waitReason = null;
    if (status !== "BLOCKED") item.blockedReason = null;
    if (status !== "ACTIVE") this.releaseClaims(item.itemId, item);
    this.markItem(item);
    this.event("item.status", item, why ?? `${from} → ${status}`, { from, to: status }, actor, status === "FAILED" ? "warn" : "info");
  }

  private failItem(item: WorkItemRecord, summary: string | null): void {
    this.setStatus(item, "FAILED", "queen", summary ? `failed: ${clip(summary, 200)}` : "failed");
    this.openEscalation(
      "REWORK_EXHAUSTED",
      { type: "item", id: item.itemId },
      clip(`"${clip(item.title, 80)}" failed after ${item.attempts} reworks and ${item.conflicts} merge conflicts. ${summary ?? ""}`.trim(), 500),
      item.traceId,
    );
  }

  /**
   * Unblock and roll up until nothing changes: BLOCKED items whose
   * dependencies are met → READY (others refresh their blockedReason), and
   * goals roll up from their children (§2.1 rules).
   */
  private settle(): void {
    for (let pass = 0; pass <= this.items.size; pass++) {
      let changed = false;
      for (const item of [...this.items.values()].sort(dispatchOrder)) {
        if (item.status === "BLOCKED") {
          const v = this.depVerdict(item);
          if (v.met) {
            item.blockedReason = null;
            this.setStatus(item, "READY", "queen", "dependencies landed");
            changed = true;
          } else if (item.blockedReason !== clip(v.reason, 200)) {
            item.blockedReason = clip(v.reason, 200);
            this.markItem(item);
          }
        } else if (item.kind === "goal" && (item.status === "ACTIVE" || item.status === "FAILED")) {
          const next = this.rollup(item);
          if (next && next !== item.status) {
            this.setStatus(item, next, "queen", `rollup: ${next.toLowerCase()}`);
            changed = true;
          }
        }
      }
      if (!changed) return;
    }
  }

  /** A goal's status from its children: SHIPPED when all are SHIPPED / DUPLICATE / CANCELLED (CANCELLED if all were cancelled), FAILED when the rest are done and one FAILED, else ACTIVE. */
  private rollup(goal: WorkItemRecord): WorkStatus | null {
    const children = [...this.items.values()].filter((i) => i.parentId === goal.itemId);
    if (children.length === 0) return null;
    if (children.every((c) => isTerminalWork(c.status))) {
      return children.every((c) => c.status === "CANCELLED") ? "CANCELLED" : "SHIPPED";
    }
    if (children.every((c) => isTerminalWork(c.status) || c.status === "FAILED")) return "FAILED";
    return "ACTIVE";
  }

  // ── internals: claims ─────────────────────────────────────────────────

  private activeIds(): Set<string> {
    return new Set([...this.items.values()].filter((i) => i.status === "ACTIVE").map((i) => i.itemId));
  }

  private putClaim(c: PathClaim): void {
    const k = claimKey(c);
    this.claims.set(k, c);
    this.dirtyClaims.add(k);
  }

  private widenClaims(item: WorkItemRecord, paths: readonly string[], source: "actual" | "conflict"): void {
    const added = widen(item.itemId, paths, source, [...this.claims.values()], this.ctx.now);
    for (const c of added) this.putClaim(c);
    if (added.length) {
      this.event("affinity.claimed", item, `claimed ${added.length} ${source} path${added.length === 1 ? "" : "s"}`, {
        paths: added.map((c) => c.path).slice(0, 50),
        source,
      }, "queen", "debug");
    }
  }

  private releaseClaims(itemId: string, item: WorkItemRecord | null): void {
    const mine = [...this.claims.entries()].filter(([, c]) => c.itemId === itemId);
    if (mine.length === 0) return;
    for (const [k] of mine) {
      this.claims.delete(k);
      this.dirtyClaims.delete(k);
    }
    this.released.add(itemId);
    this.event("affinity.released", item, `released ${mine.length} path claim${mine.length === 1 ? "" : "s"}`, { paths: mine.map(([, c]) => c.path).slice(0, 50) }, "queen", "debug", null, null, itemId);
  }

  // ── internals: Oracle commands ────────────────────────────────────────

  private issueOracle(item: WorkItemRecord, op: "decompose" | "triage", attempt: number): void {
    const commandId = oracleCommandId(item.itemId, op, attempt);
    item.commandId = commandId;
    item.commandIssuedAt = this.ctx.now;
    this.markItem(item);
    const trace = { traceparent: traceparent(item.traceId, item.spanId) };
    const command: OracleCommand =
      op === "decompose"
        ? {
            op: "DECOMPOSE",
            commandId,
            hive: this.ctx.hive,
            itemId: item.itemId,
            trace,
            promptText: (item.body || item.title).slice(0, 16_000),
            model: this.ctx.plannerModel ?? defaultPlannerChoice(),
            openItems: this.openItemsContext(item.itemId),
            limits: { maxChildren: this.hs.guardrails.maxChildrenPerItem },
          }
        : {
            op: "TRIAGE",
            commandId,
            hive: this.ctx.hive,
            itemId: item.itemId,
            trace,
            kind: item.kind,
            title: item.title,
            body: item.body.slice(0, 2000),
          };
    this.effects.push({ type: "oracle", itemId: item.itemId, command });
    this.updateSettings({ dispatches: this.settings.dispatches + 1 }); // Oracle instances count (§2.9)
    this.event("command.issued", item, `oracle ${command.op}${attempt > 1 ? ` (attempt ${attempt})` : ""}`, { op: command.op, attempt }, "queen", "info", commandId);
  }

  private openItemsContext(exclude: string): Extract<OracleCommand, { op: "DECOMPOSE" }>["openItems"] {
    return [...this.items.values()]
      .filter((i) => i.itemId !== exclude && i.kind !== "goal" && !isTerminalWork(i.status) && i.status !== "FAILED")
      .sort(dispatchOrder)
      .slice(0, MAX_OPEN_ITEMS_CONTEXT)
      .map((i) => ({ itemId: i.itemId, title: i.title, status: i.status, paths: [...i.paths] }));
  }

  // ── internals: escalations, settings, counters ────────────────────────

  private openCount(): number {
    let n = 0;
    for (const i of this.items.values()) if (!isTerminalWork(i.status)) n++;
    return n;
  }

  private hasOpen(reason: EscalationReason, subject: EscalationSubject): boolean {
    return [...this.escalations.values()].some(
      (e) => e.status === "OPEN" && e.reason === reason && e.subject.type === subject.type && e.subject.id === subject.id,
    );
  }

  private openEscalation(
    reason: EscalationReason,
    subject: EscalationSubject,
    summary: string,
    traceId: string | null,
    actions?: EscalationAction[],
  ): EscalationRecord {
    const e: EscalationRecord = {
      escalationId: this.ctx.newId(),
      hive: this.ctx.hive,
      reason,
      status: "OPEN",
      subject: { ...subject },
      traceId,
      summary: clip(summary, 500),
      actions: actions ?? escalationActions(reason),
      createdAt: this.ctx.now,
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
    };
    this.escalations.set(e.escalationId, e);
    this.dirtyEscalations.add(e.escalationId);
    const item = subject.type === "item" ? this.items.get(subject.id) : undefined;
    if (item) {
      item.escalationId = e.escalationId;
      this.markItem(item);
    }
    this.event("escalation.opened", item ?? null, `${reason}: ${clip(summary, 200)}`, { escalationId: e.escalationId, reason, subject }, "queen", "warn");
    return e;
  }

  private resolveItemEscalation(item: WorkItemRecord, action: string, actor: string, note?: string): void {
    const e = item.escalationId ? this.escalations.get(item.escalationId) : undefined;
    if (!e || e.status !== "OPEN") return;
    e.status = "RESOLVED";
    e.resolvedAt = this.ctx.now;
    e.resolvedBy = actor;
    e.resolution = clip(note ? `${action}: ${note}` : action, 500);
    this.dirtyEscalations.add(e.escalationId);
    this.event("escalation.resolved", item, `${e.reason} resolved: ${action}`, { escalationId: e.escalationId, reason: e.reason, action }, actor);
  }

  private updateSettings(patch: Partial<HiveSettingsRecord>): void {
    this.settings = { ...this.settings, ...patch, updatedAt: this.ctx.now };
    this.settingsDirty = true;
  }

  private addCredits(credits: number): void {
    this.updateSettings({ creditsUsed: this.settings.creditsUsed + credits });
  }

  private markItem(item: WorkItemRecord): void {
    item.updatedAt = this.ctx.now;
    this.dirtyItems.add(item.itemId);
  }

  private event(
    type: EventType,
    item: WorkItemRecord | null,
    summary: string,
    data: Record<string, unknown> | null,
    actor: string,
    severity: EventSeverity = "info",
    commandId: string | null = null,
    releaseId: string | null = null,
    itemId: string | null = null,
  ): void {
    this.events.push({
      type,
      severity,
      actor,
      traceId: item?.traceId ?? null,
      spanId: item?.spanId ?? null,
      parentSpanId: item?.parentId ? spanIdFor(item.parentId) : null,
      itemId: item?.itemId ?? itemId,
      trainId: null,
      releaseId,
      commandId,
      summary: clip(summary, 500),
      data,
    });
  }

  private finish(
    outcome: WorkOutcome,
    extra: { itemId?: string; error?: WorkError; leaseDue?: boolean } = {},
  ): WorkPlanResult {
    const items = [...this.dirtyItems].map((id) => copyItem(this.items.get(id)!));
    const escalations = [...this.dirtyEscalations].map((id) => {
      const e = this.escalations.get(id)!;
      return { ...e, subject: { ...e.subject }, actions: [...e.actions] };
    });
    const claims = [...this.dirtyClaims].map((k) => ({ ...this.claims.get(k)! }));
    const broadcasts: WorkEffect[] = [
      ...items.map((i): WorkEffect => ({ type: "broadcast", message: { type: "item.updated", item: toWorkItem(i) } })),
      ...escalations.map((e): WorkEffect => ({ type: "broadcast", message: { type: "escalation.updated", escalation: e } })),
    ];
    const result: WorkPlanResult = {
      outcome,
      ...(extra.error ? { error: extra.error } : {}),
      ...(extra.itemId !== undefined ? { itemId: extra.itemId } : {}),
      items,
      claims,
      releasedClaims: [...this.released],
      escalations,
      ...(this.settingsDirty ? { settings: { ...this.settings, degradedBy: [...this.settings.degradedBy] } } : {}),
      events: this.events,
      effects: [...this.effects, ...broadcasts],
      submissions: this.submissions,
      ...(extra.leaseDue !== undefined ? { leaseDue: extra.leaseDue } : {}),
    };
    this.dirtyItems.clear();
    this.dirtyClaims.clear();
    this.released.clear();
    this.dirtyEscalations.clear();
    this.settingsDirty = false;
    this.events = [];
    this.effects = [];
    this.submissions = [];
    return result;
  }
}

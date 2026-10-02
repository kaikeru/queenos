/**
 * Speculative Merge Train planner (pure: no I/O, no clock, no randomness).
 *
 * Model (Google-style submit queue, chained forks):
 * - Every queued prompt owns exactly one *active* train. Active trains, in
 *   `seq` order, ARE the queue. Train k contains main + prompts 1..k.
 * - Content is cumulative via chained forks: train-1 is forked from the hive
 *   repo (`<namespace>`), train-k is forked from train-(k-1)'s fork once
 *   train-(k-1)'s builder has pushed. Builds chain; tests run speculatively and
 *   in parallel.
 * - Results arrive in any order. A passed train lands only when it is the
 *   head of the queue (every earlier train has MERGED). Later passed trains
 *   wait and cascade once the head lands.
 * - Landing is a git push performed by a LANDER drone (Artifacts has no merge
 *   API). The train is MERGED only when the lander confirms the new main SHA.
 * - A failed train is EJECTED and its fork deleted. Every later train that
 *   contains the failed prompt is superseded (EJECTED) and re-provisioned under
 *   a new train id, forked from the nearest surviving predecessor (or main).
 *   The failed prompt re-enters the queue at the tail as a REWORK train, which
 *   carries the Scribe summary. After `maxReworks` reworks it is FAILED.
 *
 * Every method returns the changed rows (for the DO to persist) plus an
 * explicit list of effects for the DO to execute afterwards.
 */
import type {
  BuildResult,
  DroneTask,
  LandResult,
  MergeTrain,
  PromptRun,
  PromptStatus,
  QueenServerMessage,
  TrainPhase as QueenTrainPhase,
  TrainResult,
  TrainState,
} from "@queenos/queen-types";

/**
 * Planner-internal train lifecycle (TrainPhaseSchema in queen-types, exposed
 * to the War Room). `status` (TrainStateSchema) is derived from it.
 */
export type TrainPhase = QueenTrainPhase;

export type ForkState = "NONE" | "PENDING" | "READY" | "DELETING" | "DELETED";
export type TrainAction = "BUILD" | "REWORK";

export interface TrainRecord extends MergeTrain {
  seq: number;
  /** The prompt this train was provisioned for (its tail). */
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
}

export interface PromptRecord extends PromptRun {
  seq: number;
  summary: string | null;
  attempts: number;
}

export interface HiveState {
  prompts: PromptRecord[];
  /** All active trains, plus any terminal train relevant to the call. */
  trains: TrainRecord[];
  maxTrainSeq: number;
  maxPromptSeq: number;
}

export interface PlannerContext {
  namespace: string;
  now: number;
  newId: () => string;
  /** Rework attempts allowed before a prompt is FAILED. Default 2. */
  maxReworks?: number;
}

export type Effect =
  | { type: "provisionFork"; trainId: string; source: string; artifactRepo: string }
  | { type: "deleteFork"; trainId: string; artifactRepo: string }
  | { type: "dispatchDrone"; trainId: string; task: DroneTask }
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
  effects: Effect[];
}

const TERMINAL: ReadonlySet<TrainPhase> = new Set(["MERGED", "EJECTED"]);
const PUSHED: ReadonlySet<TrainPhase> = new Set(["TESTING", "PASSED", "LANDING"]);

export function isActive(t: TrainRecord): boolean {
  return !TERMINAL.has(t.phase);
}

export function statusOf(phase: TrainPhase): TrainState {
  switch (phase) {
    case "WAITING_PARENT":
    case "BUILDING":
      return "BUILDING";
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
  };
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

export class TrainPlanner {
  private readonly prompts = new Map<string, PromptRecord>();
  private readonly trains: TrainRecord[];
  private maxTrainSeq: number;
  private maxPromptSeq: number;
  private readonly maxReworks: number;
  private readonly dirtyPrompts = new Map<string, boolean>(); // id -> broadcast?
  private readonly dirtyTrains = new Map<string, boolean>();
  private effects: Effect[] = [];

  constructor(
    state: HiveState,
    private readonly ctx: PlannerContext,
  ) {
    for (const p of state.prompts) this.prompts.set(p.promptId, { ...p });
    this.trains = state.trains.map((t) => ({ ...t, includedPrompts: [...t.includedPrompts] }));
    this.maxTrainSeq = state.maxTrainSeq;
    this.maxPromptSeq = state.maxPromptSeq;
    this.maxReworks = ctx.maxReworks ?? 2;
  }

  // ── public transitions ────────────────────────────────────────────────

  /** A new prompt joins the tail of the queue. */
  submit(input: { promptId: string; promptText: string }): PlanResult {
    const prompt: PromptRecord = {
      promptId: input.promptId,
      namespace: this.ctx.namespace,
      promptText: input.promptText,
      status: "QUEUED",
      createdAt: this.ctx.now,
      seq: ++this.maxPromptSeq,
      summary: null,
      attempts: 0,
    };
    this.prompts.set(prompt.promptId, prompt);
    this.markPrompt(prompt);
    this.enqueue(prompt, "BUILD");
    return this.finish("applied");
  }

  /** The DO finished creating the fork. */
  forkReady(input: { trainId: string; artifactRepo: string; baseSha: string }): PlanResult {
    const t = this.find(input.trainId);
    if (!t) return this.finish("ignored:unknown");
    if (!isActive(t)) {
      // Superseded while the fork was in flight: the fork is an orphan.
      if (t.forkState !== "DELETING") this.deleteFork(t);
      return this.finish("ignored:stale");
    }
    if (t.forkState !== "PENDING") return this.finish("ignored:duplicate");
    this.setTrain(t, { forkState: "READY", baseSha: input.baseSha, dispatched: false });
    this.setPromptStatus(t.promptId, "BUILDING");
    this.dispatchBuilder(t);
    return this.finish("applied");
  }

  /** The DO deleted a fork (or it was already gone). Internal bookkeeping only. */
  forkDeleted(trainId: string): PlanResult {
    const t = this.find(trainId);
    if (!t) return this.finish("ignored:unknown");
    if (t.forkState !== "DELETING") return this.finish("ignored:duplicate");
    this.setTrain(t, { forkState: "DELETED" }, false);
    return this.finish("applied");
  }

  /** The DO dispatched the drone for the train's current phase. Internal only. */
  dispatched(trainId: string, phase: TrainPhase): PlanResult {
    const t = this.find(trainId);
    if (!t || t.phase !== phase || t.dispatched) return this.finish("ignored:stale");
    this.setTrain(t, { dispatched: true }, false);
    return this.finish("applied");
  }

  /** A builder pushed the train head; successors may now fork from it. */
  buildResult(r: BuildResult): PlanResult {
    const t = this.find(r.trainId);
    if (!t) return this.finish("ignored:unknown");
    if (!isActive(t)) return this.finish("ignored:stale");
    if (t.phase !== "BUILDING") return this.finish("ignored:duplicate");
    if (t.forkState !== "READY") return this.finish("ignored:premature");
    this.setTrain(t, { phase: "TESTING", headSha: r.headSha });
    this.setPromptStatus(t.promptId, "IN_TRAIN");
    this.scheduleSuccessor(t);
    return this.finish("applied");
  }

  /** A gatekeeper reports the speculative test verdict. */
  trainResult(r: TrainResult): PlanResult {
    const t = this.find(r.trainId);
    if (!t) return this.finish("ignored:unknown");
    if (!isActive(t)) return this.finish("ignored:stale");
    if (t.phase === "PASSED" || t.phase === "LANDING") return this.finish("ignored:duplicate");
    if (t.phase === "WAITING_PARENT" || t.forkState !== "READY") {
      return this.finish("ignored:premature");
    }
    this.setPromptSummary(t.promptId, r.summary);
    if (!r.passed) {
      this.fail(t, r.summary);
      return this.finish("applied");
    }
    const wasBuilding = t.phase === "BUILDING";
    this.setTrain(t, {
      phase: "PASSED",
      summary: r.summary,
      headSha: r.commitSha ?? t.headSha,
    });
    this.setPromptStatus(t.promptId, "IN_TRAIN");
    // A pass implies the builder pushed, even if build-result never arrived.
    if (wasBuilding) this.scheduleSuccessor(t);
    this.maybeLand();
    return this.finish("applied");
  }

  /** The lander confirms (or fails) the push of the train head to hive main. */
  landResult(r: LandResult): PlanResult {
    const t = this.find(r.trainId);
    if (!t) return this.finish("ignored:unknown");
    if (!isActive(t)) return this.finish("ignored:stale");
    if (t.phase !== "LANDING") return this.finish("ignored:premature");
    if (!r.landed) {
      const summary = r.summary || "lander could not push the train head to main";
      this.setPromptSummary(t.promptId, summary);
      this.fail(t, summary);
      return this.finish("applied");
    }
    this.setTrain(t, { phase: "MERGED", landedSha: r.mainSha ?? null });
    this.deleteFork(t);
    this.setPromptStatus(t.promptId, "MERGED");
    if (r.summary) this.setPromptSummary(t.promptId, r.summary);
    this.maybeLand();
    return this.finish("applied");
  }

  /**
   * Crash / failure recovery (DO alarm): re-issue pending forks (re-deriving
   * their source), pending deletes and undispatched drones.
   */
  reconcile(): PlanResult {
    for (const t of this.trains) {
      if (t.forkState === "DELETING") {
        this.effects.push({ type: "deleteFork", trainId: t.trainId, artifactRepo: t.artifactRepo });
      }
    }
    for (const t of this.active()) {
      if (t.phase === "WAITING_PARENT") {
        this.scheduleFork(t);
      } else if (t.forkState === "PENDING") {
        const source = this.forkSourceFor(t);
        if (source === null) {
          // Predecessor was superseded/re-queued: wait for the new one.
          this.setTrain(t, { phase: "WAITING_PARENT", forkState: "NONE", forkSource: null });
        } else {
          if (source !== t.forkSource) this.setTrain(t, { forkSource: source }, false);
          this.effects.push({
            type: "provisionFork",
            trainId: t.trainId,
            source,
            artifactRepo: t.artifactRepo,
          });
        }
      } else if (t.phase === "BUILDING" && t.forkState === "READY" && !t.dispatched) {
        this.dispatchBuilder(t);
      } else if (t.phase === "LANDING" && !t.dispatched) {
        this.dispatchLander(t);
      }
    }
    this.maybeLand();
    return this.finish("applied");
  }

  // ── internals ─────────────────────────────────────────────────────────

  private active(): TrainRecord[] {
    return this.trains.filter(isActive).sort((a, b) => a.seq - b.seq);
  }

  private find(trainId: string): TrainRecord | undefined {
    return this.trains.find((t) => t.trainId === trainId);
  }

  private predecessor(t: TrainRecord): TrainRecord | undefined {
    return this.active()
      .filter((x) => x.seq < t.seq)
      .at(-1);
  }

  /** Repo to fork from, or null when the predecessor has not pushed yet. */
  private forkSourceFor(t: TrainRecord): string | null {
    const parent = this.predecessor(t);
    if (!parent) return this.ctx.namespace;
    return PUSHED.has(parent.phase) ? parent.artifactRepo : null;
  }

  private enqueue(prompt: PromptRecord, action: TrainAction): TrainRecord {
    const ahead = this.active().map((t) => t.promptId);
    const trainId = this.ctx.newId();
    const train: TrainRecord = {
      trainId,
      baseSha: "", // resolved from the fork once it exists
      includedPrompts: [...ahead, prompt.promptId],
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
    };
    this.trains.push(train);
    this.markTrain(train);
    this.setPromptStatus(prompt.promptId, "QUEUED");
    this.scheduleFork(train);
    return train;
  }

  private scheduleFork(t: TrainRecord): void {
    if (t.phase !== "WAITING_PARENT") return;
    const source = this.forkSourceFor(t);
    if (source === null) return;
    this.setTrain(t, { phase: "BUILDING", forkState: "PENDING", forkSource: source });
    this.effects.push({
      type: "provisionFork",
      trainId: t.trainId,
      source,
      artifactRepo: t.artifactRepo,
    });
  }

  private scheduleSuccessor(t: TrainRecord): void {
    const next = this.active().find((x) => x.seq > t.seq);
    if (next) this.scheduleFork(next);
  }

  private maybeLand(): void {
    const head = this.active()[0];
    if (head?.phase !== "PASSED") return;
    this.setTrain(head, { phase: "LANDING", dispatched: false });
    this.dispatchLander(head);
  }

  private fail(t: TrainRecord, summary: string): void {
    const queue = this.active();
    const idx = queue.indexOf(t);
    this.eject(t, `failed: ${summary}`);
    const superseded = queue
      .slice(idx + 1)
      .filter((s) => s.includedPrompts.includes(t.promptId));
    for (const s of superseded) {
      this.eject(s, `superseded: prompt ${t.promptId} ejected from train ${t.trainId}`);
    }
    // Successors slide forward, re-forked from the nearest survivor (or main).
    for (const s of superseded) {
      const p = this.prompts.get(s.promptId);
      if (p) this.enqueue(p, s.action);
    }
    // The failed prompt is ejected, then re-enters the queue as a rework.
    const failed = this.prompts.get(t.promptId);
    if (failed) {
      failed.attempts += 1;
      this.setPromptStatus(failed.promptId, "EJECTED");
      this.effects.push({
        type: "broadcast",
        message: { type: "prompt.updated", promptRun: toPromptRun(failed) },
      });
      if (failed.attempts > this.maxReworks) {
        this.setPromptStatus(failed.promptId, "FAILED");
      } else {
        this.enqueue(failed, "REWORK");
      }
    }
    this.maybeLand();
  }

  private eject(t: TrainRecord, reason: string): void {
    this.setTrain(t, { phase: "EJECTED", reason });
    if (t.forkState === "PENDING" || t.forkState === "READY") this.deleteFork(t);
  }

  private deleteFork(t: TrainRecord): void {
    this.setTrain(t, { forkState: "DELETING" }, false);
    this.effects.push({ type: "deleteFork", trainId: t.trainId, artifactRepo: t.artifactRepo });
  }

  private dispatchBuilder(t: TrainRecord): void {
    const p = this.prompts.get(t.promptId);
    if (!p) return;
    this.effects.push({
      type: "dispatchDrone",
      trainId: t.trainId,
      task: {
        promptId: p.promptId,
        trainId: t.trainId,
        namespace: this.ctx.namespace,
        artifactRepo: t.artifactRepo,
        baseRef: "main",
        promptText: p.promptText,
        role: "BUILDER",
        action: t.action,
        ragContext: [],
        ...(t.action === "REWORK" && p.summary ? { scribeSummary: p.summary } : {}),
      },
    });
  }

  private dispatchLander(t: TrainRecord): void {
    const p = this.prompts.get(t.promptId);
    this.effects.push({
      type: "dispatchDrone",
      trainId: t.trainId,
      task: {
        promptId: t.promptId,
        trainId: t.trainId,
        namespace: this.ctx.namespace,
        artifactRepo: t.artifactRepo,
        baseRef: t.headSha ?? "main",
        promptText: p?.promptText ?? t.promptId,
        role: "LANDER",
        action: "LAND",
        ragContext: [],
      },
    });
  }

  private setTrain(t: TrainRecord, patch: Partial<TrainRecord>, visible = true): void {
    Object.assign(t, patch);
    t.status = statusOf(t.phase);
    this.markTrain(t, visible);
  }

  private markTrain(t: TrainRecord, visible = true): void {
    this.dirtyTrains.set(t.trainId, (this.dirtyTrains.get(t.trainId) ?? false) || visible);
  }

  private markPrompt(p: PromptRecord, visible = true): void {
    this.dirtyPrompts.set(p.promptId, (this.dirtyPrompts.get(p.promptId) ?? false) || visible);
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
    const trains = [...this.dirtyTrains.keys()].map((id) => {
      const t = this.find(id)!;
      return { ...t, includedPrompts: [...t.includedPrompts] };
    });
    const broadcasts: Effect[] = [
      ...prompts
        .filter((p) => this.dirtyPrompts.get(p.promptId))
        .map((p): Effect => ({ type: "broadcast", message: { type: "prompt.updated", promptRun: toPromptRun(p) } })),
      ...trains
        .filter((t) => this.dirtyTrains.get(t.trainId))
        .map((t): Effect => ({ type: "broadcast", message: { type: "train.updated", train: toMergeTrain(t) } })),
    ];
    const result: PlanResult = { outcome, prompts, trains, effects: [...this.effects, ...broadcasts] };
    this.dirtyPrompts.clear();
    this.dirtyTrains.clear();
    this.effects = [];
    return result;
  }
}

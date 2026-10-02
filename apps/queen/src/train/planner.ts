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
 * - The Queen performs no I/O. Forks and fork deletes are commands to the
 *   Provisioner Workflow; preview deploys and teardowns are commands to the
 *   Herald Workflow. Each command id is stored on the train row (persisted
 *   before dispatch); results come back asynchronously and are matched by
 *   command id, so duplicate and late results are idempotent.
 * - After the builder pushes, the train is DEPLOYING: the Herald deploys the
 *   head to a per-train Worker Preview. A LIVE preview moves the train to
 *   TESTING (gatekeepers smoke-test `previewUrl`); a failed deploy fails the
 *   train like a failed test. Successor forks chain on the push, not the deploy.
 * - Landing is a git push performed by a LANDER drone (Artifacts has no merge
 *   API). The train is MERGED only when the lander confirms the new main SHA.
 * - MERGED and EJECTED trains get their fork deleted and their preview torn down.
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
  DeployCommand,
  DeployResult,
  Deployment,
  DroneTask,
  LandResult,
  MergeTrain,
  PromptRun,
  PromptStatus,
  ProvisionCommand,
  ProvisionResult,
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

export type ForkState = "NONE" | "PENDING" | "READY" | "DELETING" | "DELETED" | "DELETE_FAILED";
/** Lifecycle of the train's Worker Preview (Herald). */
export type DeployState = "NONE" | "PENDING" | "LIVE" | "FAILED" | "TEARING_DOWN" | "TORN_DOWN" | "TEARDOWN_FAILED";
export type TrainAction = "BUILD" | "REWORK";

/** Fork attempts (each a new Provisioner instance) before the train fails. */
export const MAX_FORK_ATTEMPTS = 3;

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
  /** Deployment rows of the loaded trains (preview rows are `preview-<trainId>`). */
  deployments?: Deployment[];
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
  | { type: "provision"; trainId: string; command: ProvisionCommand }
  | { type: "deploy"; trainId: string; command: DeployCommand }
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
  deployments: Deployment[];
  effects: Effect[];
}

const TERMINAL: ReadonlySet<TrainPhase> = new Set(["MERGED", "EJECTED"]);
/** Phases in which the builder has pushed, so a successor can fork from this train. */
const PUSHED: ReadonlySet<TrainPhase> = new Set(["DEPLOYING", "TESTING", "PASSED", "LANDING"]);
/** Preview states that may have left a live (or half-created) Worker Preview behind. */
const PREVIEW_EXISTS: ReadonlySet<DeployState> = new Set(["PENDING", "LIVE", "FAILED"]);

export function isActive(t: TrainRecord): boolean {
  return !TERMINAL.has(t.phase);
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

/** Deterministic, attempt-numbered command id: `<trainId>-<op>-<n>`. */
export function nextCommandId(trainId: string, op: string, previous: string | null): string {
  const n = previous ? Number(/-(\d+)$/.exec(previous)?.[1] ?? 0) + 1 : 1;
  return `${trainId}-${op}-${n}`;
}

export function commandAttempt(commandId: string | null): number {
  return commandId ? Number(/-(\d+)$/.exec(commandId)?.[1] ?? 0) : 0;
}

export function previewDeploymentId(trainId: string): string {
  return `preview-${trainId}`;
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
    previewUrl: t.previewUrl,
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
  private readonly deployments = new Map<string, Deployment>();
  private readonly dirtyDeployments = new Set<string>();
  private effects: Effect[] = [];

  constructor(
    state: HiveState,
    private readonly ctx: PlannerContext,
  ) {
    for (const p of state.prompts) this.prompts.set(p.promptId, { ...p });
    this.trains = state.trains.map((t) => ({ ...t, includedPrompts: [...t.includedPrompts] }));
    for (const d of state.deployments ?? []) this.deployments.set(d.deploymentId, { ...d });
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

  /** The Provisioner reports a FORK or DELETE outcome (matched by command id). */
  provisionResult(r: ProvisionResult): PlanResult {
    const t = this.find(r.trainId);
    if (!t) return this.finish("ignored:unknown");
    return r.op === "FORK" ? this.forkResult(t, r) : this.deleteResult(t, r);
  }

  private forkResult(t: TrainRecord, r: ProvisionResult): PlanResult {
    if (r.commandId !== t.forkCommandId) return this.finish("ignored:stale"); // an older attempt
    if (!isActive(t)) {
      // Superseded while the fork was in flight: a created fork is an orphan.
      if (r.ok && t.forkState !== "DELETING") this.deleteFork(t);
      return this.finish("ignored:stale");
    }
    if (t.forkState !== "PENDING") return this.finish("ignored:duplicate");
    if (!r.ok) {
      const summary = r.summary || `Provisioner could not fork ${t.forkSource ?? "the hive repo"}`;
      if (commandAttempt(t.forkCommandId) < MAX_FORK_ATTEMPTS) {
        // Retry with a new command (Workflow instance ids are single-use).
        this.setTrain(t, { phase: "WAITING_PARENT", forkState: "NONE" }, false);
        this.scheduleFork(t);
      } else {
        this.setPromptSummary(t.promptId, summary);
        this.fail(t, `fork failed: ${summary}`);
      }
      return this.finish("applied");
    }
    this.setTrain(t, {
      forkState: "READY",
      baseSha: r.baseSha ?? t.baseSha,
      artifactRepo: r.artifactRepo ?? t.artifactRepo,
      dispatched: false,
    });
    this.setPromptStatus(t.promptId, "BUILDING");
    this.dispatchBuilder(t);
    return this.finish("applied");
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
      this.setTrain(t, { deployState: "FAILED" }, false);
      this.setDeployment(t, { status: "FAILED", summary, commitSha, versionId: r.versionId ?? null });
      this.setPromptSummary(t.promptId, summary);
      this.fail(t, `preview deploy failed: ${summary}`);
      return this.finish("applied");
    }
    this.setTrain(t, { deployState: "LIVE", previewUrl: r.url, phase: "TESTING" });
    this.setDeployment(t, { status: "LIVE", url: r.url, versionId: r.versionId ?? null, commitSha, summary: r.summary ?? null });
    return this.finish("applied");
  }

  private previewTornDown(t: TrainRecord, r: DeployResult): PlanResult {
    if (r.commandId !== t.teardownCommandId) return this.finish("ignored:stale");
    if (t.deployState !== "TEARING_DOWN") return this.finish("ignored:duplicate");
    if (r.ok) {
      this.setTrain(t, { deployState: "TORN_DOWN" }, false);
      this.setDeployment(t, { status: "TORN_DOWN" });
    } else {
      this.setTrain(t, { deployState: "TEARDOWN_FAILED" }, false);
      this.setDeployment(t, { status: "FAILED", summary: `teardown failed: ${r.summary ?? "unknown error"}`.slice(0, 500) });
    }
    return this.finish("applied");
  }

  /** The DO dispatched the drone for the train's current phase. Internal only. */
  dispatched(trainId: string, phase: TrainPhase): PlanResult {
    const t = this.find(trainId);
    if (!t || t.phase !== phase || t.dispatched) return this.finish("ignored:stale");
    this.setTrain(t, { dispatched: true }, false);
    return this.finish("applied");
  }

  /**
   * A builder pushed the train head: deploy its preview (DEPLOYING), and let
   * the successor fork from it right away (chaining does not wait on deploys).
   */
  buildResult(r: BuildResult): PlanResult {
    const t = this.find(r.trainId);
    if (!t) return this.finish("ignored:unknown");
    if (!isActive(t)) return this.finish("ignored:stale");
    if (t.phase !== "BUILDING") return this.finish("ignored:duplicate");
    if (t.forkState !== "READY") return this.finish("ignored:premature");
    this.setTrain(t, { phase: "DEPLOYING", headSha: r.headSha });
    this.setPromptStatus(t.promptId, "IN_TRAIN");
    this.deployPreview(t);
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
    // A pass must come from testing the live preview; a failure (e.g. the
    // builder giving up) is honoured in any phase.
    if (r.passed && t.phase !== "TESTING") return this.finish("ignored:premature");
    this.setPromptSummary(t.promptId, r.summary);
    if (!r.passed) {
      this.fail(t, r.summary);
      return this.finish("applied");
    }
    this.setTrain(t, {
      phase: "PASSED",
      summary: r.summary,
      headSha: r.commitSha ?? t.headSha,
    });
    this.setPromptStatus(t.promptId, "IN_TRAIN");
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
    this.teardownPreview(t);
    this.setPromptStatus(t.promptId, "MERGED");
    if (r.summary) this.setPromptSummary(t.promptId, r.summary);
    this.maybeLand();
    return this.finish("applied");
  }

  /**
   * Crash / failure recovery (DO alarm): re-dispatch every pending command
   * (same command id, so a command that did start is not started twice),
   * re-deriving a pending fork's source, plus undispatched drones.
   */
  reconcile(): PlanResult {
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
    for (const t of this.active()) {
      if (t.phase === "WAITING_PARENT") {
        this.scheduleFork(t);
      } else if (t.forkState === "PENDING") {
        const source = this.forkSourceFor(t);
        if (source === null) {
          // Predecessor was superseded/re-queued: wait for the new one.
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
      forkCommandId: null,
      deleteCommandId: null,
      deployState: "NONE",
      deployCommandId: null,
      teardownCommandId: null,
      previewUrl: null,
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
    this.setTrain(t, {
      phase: "BUILDING",
      forkState: "PENDING",
      forkSource: source,
      forkCommandId: nextCommandId(t.trainId, "fork", t.forkCommandId),
    });
    this.emitFork(t);
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
        forkName: t.artifactRepo,
      },
    });
  }

  private emitDelete(t: TrainRecord): void {
    this.effects.push({
      type: "provision",
      trainId: t.trainId,
      command: { op: "DELETE", commandId: t.deleteCommandId!, hive: this.ctx.namespace, trainId: t.trainId, repo: t.artifactRepo },
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
      command: { op: "TEARDOWN", commandId: t.teardownCommandId!, hive: this.ctx.namespace, environment: "preview", trainId: t.trainId },
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
    if (PREVIEW_EXISTS.has(t.deployState)) this.teardownPreview(t);
  }

  private deleteFork(t: TrainRecord): void {
    this.setTrain(t, { forkState: "DELETING", deleteCommandId: nextCommandId(t.trainId, "delete", t.deleteCommandId) }, false);
    this.emitDelete(t);
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
    const deployments = [...this.dirtyDeployments].map((id) => ({ ...this.deployments.get(id)! }));
    const broadcasts: Effect[] = [
      ...prompts
        .filter((p) => this.dirtyPrompts.get(p.promptId))
        .map((p): Effect => ({ type: "broadcast", message: { type: "prompt.updated", promptRun: toPromptRun(p) } })),
      ...trains
        .filter((t) => this.dirtyTrains.get(t.trainId))
        .map((t): Effect => ({ type: "broadcast", message: { type: "train.updated", train: toMergeTrain(t) } })),
      ...deployments.map((d): Effect => ({ type: "broadcast", message: { type: "deployment.updated", deployment: d } })),
    ];
    const result: PlanResult = { outcome, prompts, trains, deployments, effects: [...this.effects, ...broadcasts] };
    this.dirtyPrompts.clear();
    this.dirtyTrains.clear();
    this.dirtyDeployments.clear();
    this.effects = [];
    return result;
  }
}

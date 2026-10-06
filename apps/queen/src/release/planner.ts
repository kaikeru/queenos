/**
 * Release train planner (pure: no I/O, no clock, no randomness). P3.
 *
 * Landed trains accumulate into a release. Each release walks the ladder:
 *
 *   STAGING ──ok──▶ VALIDATING ──PROMOTE──▶ AWAITING_TAP ──tap──▶ CANARY 1 → 10 → 50 → 100 ──▶ SHIPPED
 *      │!ok             │ROLLBACK                                    │ROLLBACK / deploy !ok
 *      ▼                ▼                                            ▼
 *    FAILED           FAILED (P5: bisect + revert)          Herald ROLLBACK ──▶ ROLLED_BACK
 *
 * - The Queen only decides. Herald (DeployCommand) performs every deploy and
 *   rollback; Sentinel (SentinelCommand) returns every health verdict. Each
 *   command id is persisted on the release row before dispatch and doubles as
 *   the executor's Workflow instance id; results are matched against it, so
 *   duplicates and late (stale) results are idempotent.
 * - A train merging while a release is in STAGING / VALIDATING / AWAITING_TAP
 *   supersedes it (its outstanding commands are cancelled logically: their
 *   results come back `ignored:stale`) and a new release is cut for the new
 *   main head. During CANARY the new head is queued on the canary release and
 *   cut once the canary ends (SHIPPED, ROLLED_BACK, or FAILED).
 * - A release carries every train landed since the last SHIPPED release.
 * - At most one release is in flight (non-terminal) per hive.
 *
 * Command ids: `<releaseId>-<op>-<attempt>`, op one of `staging`, `validate`,
 * `canary<p>`, `verify<p>`, `rollback`.
 *
 * v2 autonomy (design §2.4, §2.5):
 * - Staging PROMOTE with `ctx.autoShip` runs the tap body with AUTO_SHIP_ACTOR
 *   (straight to CANARY); otherwise the release parks at AWAITING_TAP and an
 *   APPROVAL_REQUIRED escalation opens. `ctx.paused` parks without one (no new
 *   canary starts, and taps are refused, until the hive is unpaused).
 * - An `inconclusive` staging verdict parks at AWAITING_TAP even when
 *   autonomous and opens SENTINEL_INCONCLUSIVE; an inconclusive canary verdict
 *   takes the normal rollback path and opens SENTINEL_INCONCLUSIVE (ack only).
 * - `reconcile()` auto-taps a parked release once `autoShip` is true, unless it
 *   has an open SENTINEL_INCONCLUSIVE or a human chose `hold`; in a supervised
 *   hive it opens APPROVAL_REQUIRED for a parked release that never had one.
 * - Infrastructure is never the change's fault. A Herald DEPLOY that fails with
 *   `retryable` (5xx / 429 past Herald's own retries) is re-issued, up to
 *   MAX_COMMAND_ATTEMPTS; a lost executor (watchdog cap) or an inconclusive
 *   canary verdict is infrastructure too. Then the release is PARKED, never
 *   FAILED / ROLLED_BACK: staging stays in STAGING; a canary has its traffic
 *   rolled back to stable (if it was split) and returns to AWAITING_TAP. Either
 *   way EXECUTOR_LOST (or SENTINEL_INCONCLUSIVE) opens on the release, the
 *   rollback streak and the error budget are untouched, and no P0 bug is filed
 *   (bugs come only from FAILED / ROLLED_BACK). `retry` re-runs the step; a newer
 *   main head supersedes the parked release as usual.
 * - Each ROLLED_BACK or canary-FAILED release bumps `rollbackStreak`
 *   (ROLLBACK_STREAK at 2); SHIPPED resets it. A failed Herald rollback opens
 *   ROLLBACK_FAILED. Superseding a parked release resolves its escalations as
 *   `superseded`; a tap resolves them as `ship`.
 */
import {
  AUTO_SHIP_ACTOR,
  CANARY_STEPS,
  INFRA_SUMMARY_PREFIX,
  isInfraStopped,
  traceIdFromUuid,
  type DeployCommand,
  type DeployResult,
  type Deployment,
  type Escalation,
  type EscalationAction,
  type EscalationReason,
  type EventDraft,
  type QueenServerMessage,
  type Release,
  type ReleasePhase,
  type SentinelCommand,
  type SentinelVerdict,
} from "@queenos/queen-types";
import {
  PARKED_RELEASE_REASONS,
  QUEEN_ACTOR,
  SUPERSEDED_RESOLUTION,
  escalationOpenedEvent,
  escalationResolvedEvent,
  isAbout,
  newEscalation,
  resolutionAction,
  resolvedEscalation,
} from "../autonomy/escalation";
import { ROLLBACK_STREAK_LIMIT } from "../autonomy/policy";
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_ATTEMPTS, commandAttempt, nextCommandId } from "../train/planner";

/** What the release is waiting on right now (null: nothing outstanding). */
export type ReleasePending = "DEPLOY" | "SENTINEL" | "ROLLBACK";

export interface ReleaseRecord extends Release {
  /** Creation order (newest release = max seq). */
  seq: number;
  /** CANARY: index into CANARY_STEPS of the current step. */
  step: number | null;
  pending: ReleasePending | null;
  /** Current Herald DEPLOY (staging or canary step). */
  deployCommandId: string | null;
  deployIssuedAt: number | null;
  /** Current Sentinel command (staging validation or canary verification). */
  sentinelCommandId: string | null;
  sentinelIssuedAt: number | null;
  /** Current Herald ROLLBACK. */
  rollbackCommandId: string | null;
  rollbackIssuedAt: number | null;
  /** CANARY only: a main head that landed during the canary, cut as the next release when it ends. */
  nextHeadSha: string | null;
  nextTrainIds: string[];
}

export interface ReleaseState {
  /** The in-flight release (if any), the newest release, and any release named by the call. */
  releases: ReleaseRecord[];
  /** Environment rows (staging / canary / prod) of the hive. */
  deployments: Deployment[];
  maxSeq: number;
}

export interface SentinelSettings {
  windowSeconds: number;
  minRequests: number;
}

export interface ReleaseContext {
  namespace: string;
  now: number;
  newId: () => string;
  /** Watchdog timeout for Herald commands (and the floor for Sentinel). Default 10 min. */
  commandTimeoutMs?: number;
  sentinel?: SentinelSettings;
  /** v2: effective autonomy is `autonomous` (policy.ts). Default false (v1: every release waits for a tap). */
  autoShip?: boolean;
  /** v2: effective autonomy is `paused`: no new canary starts (auto or tapped). Default false. */
  paused?: boolean;
  /** v2: `hive_settings.rollback_streak` before this plan. Default 0. */
  rollbackStreak?: number;
  /**
   * v2: the hive's OPEN escalations plus every escalation (any status) whose
   * subject is a release in `state.releases`; a resolved `hold` blocks auto-ship.
   */
  escalations?: readonly Escalation[];
}

export const DEFAULT_SENTINEL: SentinelSettings = { windowSeconds: 60, minRequests: 100 };
/** Sentinel gets its whole window plus this much before the watchdog calls it lost. */
export const SENTINEL_GRACE_MS = 5 * 60_000;
export const SENTINEL_PATHS = ["/", "/health"];

export type ReleaseEffect =
  | { type: "deploy"; releaseId: string; command: DeployCommand }
  | { type: "sentinel"; releaseId: string; command: SentinelCommand }
  | { type: "broadcast"; message: QueenServerMessage };

export type ReleaseOutcome =
  | "applied"
  | "ignored:unknown"
  | "ignored:stale"
  | "ignored:duplicate"
  | "ignored:premature"
  /** The request is not valid in the release's current phase (tap outside AWAITING_TAP). */
  | "conflict";

export interface ReleasePlanResult {
  outcome: ReleaseOutcome;
  releases: ReleaseRecord[];
  deployments: Deployment[];
  effects: ReleaseEffect[];
  /** v2: escalation rows opened or resolved by this plan (upsert them). */
  escalations: Escalation[];
  /** v2: `release.phase`, `release.autoshipped` and escalation events. */
  events: EventDraft[];
  /** v2: `hive_settings.rollback_streak` after this plan. */
  rollbackStreak: number;
}

const IN_FLIGHT: ReadonlySet<ReleasePhase> = new Set(["STAGING", "VALIDATING", "AWAITING_TAP", "CANARY"]);
/** In-flight phases a newly landed head replaces (CANARY is never interrupted). */
const SUPERSEDABLE: ReadonlySet<ReleasePhase> = new Set(["STAGING", "VALIDATING", "AWAITING_TAP"]);

export function isInFlight(r: Pick<Release, "phase">): boolean {
  return IN_FLIGHT.has(r.phase);
}

export const stagingScript = (hive: string) => `${hive}-staging`;
export const appScript = (hive: string) => `${hive}-app`;
/** Environment rows have fixed ids (one DO per hive). */
export const envDeploymentId = (env: "staging" | "canary" | "prod") => env;

/** Sentinel's watchdog timeout: its window plus grace, never below the command timeout. */
export function sentinelTimeoutMs(commandTimeoutMs: number, windowSeconds: number): number {
  return Math.max(commandTimeoutMs, windowSeconds * 1000 + SENTINEL_GRACE_MS);
}

/** `<releaseId>-<op>-<n>`: the attempt after `previous` when it is the same op, else attempt 1. */
export function releaseCommandId(releaseId: string, op: string, previous: string | null): string {
  const same = previous?.startsWith(`${releaseId}-${op}-`) ? previous : null;
  return nextCommandId(releaseId, op, same);
}

/** Issue time of the command a release is waiting on, or null. Rows without a clock count from `now`. */
function outstanding(r: ReleaseRecord, now: number): { at: number; kind: ReleasePending } | null {
  if (!isInFlight(r) || r.pending === null) return null;
  const at = r.pending === "DEPLOY" ? r.deployIssuedAt : r.pending === "SENTINEL" ? r.sentinelIssuedAt : r.rollbackIssuedAt;
  return { at: at ?? now, kind: r.pending };
}

/** When the alarm must next run for release commands: earliest issue time + its timeout, or null. */
export function releaseWatchdogDeadline(
  releases: readonly ReleaseRecord[],
  commandTimeoutMs: number,
  windowSeconds: number,
  now: number,
): number | null {
  const due = releases.flatMap((r) => {
    const o = outstanding(r, now);
    if (!o) return [];
    return [o.at + (o.kind === "SENTINEL" ? sentinelTimeoutMs(commandTimeoutMs, windowSeconds) : commandTimeoutMs)];
  });
  return due.length ? Math.min(...due) : null;
}

export function toRelease(r: ReleaseRecord): Release {
  return {
    releaseId: r.releaseId,
    hive: r.hive,
    headSha: r.headSha,
    trainIds: [...r.trainIds],
    phase: r.phase,
    canaryPercent: r.canaryPercent,
    stagingUrl: r.stagingUrl,
    prodUrl: r.prodUrl,
    candidateVersionId: r.candidateVersionId,
    stableVersionId: r.stableVersionId,
    tappedBy: r.tappedBy,
    tappedAt: r.tappedAt,
    summary: r.summary,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const clip = (s: string) => (s.length > 500 ? `${s.slice(0, 497)}...` : s);

/** INFRA_SUMMARY_PREFIX also marks a canary rollback in flight as infra, so rollbackResult parks instead of ROLLED_BACK. */
const isInfraStop = isInfraStopped;
const short = (sha: string) => sha.slice(0, 7);

const ISSUED_AT = {
  deployCommandId: "deployIssuedAt",
  sentinelCommandId: "sentinelIssuedAt",
  rollbackCommandId: "rollbackIssuedAt",
} as const;

export class ReleasePlanner {
  private readonly releases: ReleaseRecord[];
  private readonly deployments = new Map<string, Deployment>();
  private readonly dirty = new Map<string, boolean>(); // releaseId -> broadcast?
  private readonly dirtyDeployments = new Set<string>();
  private effects: ReleaseEffect[] = [];
  private maxSeq: number;
  private readonly timeoutMs: number;
  private readonly sentinel: SentinelSettings;
  private readonly escalations: Escalation[];
  private readonly dirtyEscalations = new Set<string>();
  private events: EventDraft[] = [];
  private streak: number;

  constructor(
    state: ReleaseState,
    private readonly ctx: ReleaseContext,
  ) {
    this.releases = state.releases.map((r) => ({ ...r, trainIds: [...r.trainIds], nextTrainIds: [...r.nextTrainIds] }));
    for (const d of state.deployments) this.deployments.set(d.deploymentId, { ...d });
    this.maxSeq = state.maxSeq;
    this.timeoutMs = ctx.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.sentinel = ctx.sentinel ?? DEFAULT_SENTINEL;
    this.escalations = (ctx.escalations ?? []).map((e) => ({ ...e, subject: { ...e.subject }, actions: [...e.actions] }));
    this.streak = ctx.rollbackStreak ?? 0;
  }

  // ── public transitions ────────────────────────────────────────────────

  /**
   * Trains MERGED: main is now `headSha`. Cut, supersede, or queue a release.
   * v2: a merge-queue car lands several member trains with one push (`trainIds`).
   */
  landed(input: { trainId?: string; trainIds?: string[]; headSha: string }): ReleasePlanResult {
    const cur = this.inFlight();
    const all = input.trainIds ?? (input.trainId ? [input.trainId] : []);
    const ids = all.filter((id) => !this.releases.some((r) => r.trainIds.includes(id) || r.nextTrainIds.includes(id)));
    if (ids.length === 0) return this.finish("ignored:duplicate");
    if (cur?.phase === "CANARY") {
      // Never interrupt a canary: queue the head, cut it when the canary ends.
      this.set(cur, { nextHeadSha: input.headSha, nextTrainIds: [...cur.nextTrainIds, ...ids] }, false);
      return this.finish("applied");
    }
    const base = this.sinceLastShipped();
    if (cur && SUPERSEDABLE.has(cur.phase)) {
      const next = this.create(input.headSha, [...base, ...ids]);
      this.set(cur, { phase: "SUPERSEDED", pending: null, summary: clip(`Superseded by release ${next.releaseId} (main ${short(input.headSha)}).`) });
      this.resolveParked(cur, QUEEN_ACTOR, SUPERSEDED_RESOLUTION);
      this.stage(next);
      return this.finish("applied");
    }
    this.stage(this.create(input.headSha, [...base, ...ids]));
    return this.finish("applied");
  }

  /** Herald reports a staging / canary DEPLOY or a ROLLBACK (matched by command id). */
  deployResult(r: DeployResult): ReleasePlanResult {
    const rel = this.resolve(r.releaseId, r.commandId);
    if (!rel) return this.finish("ignored:unknown");
    const kind: ReleasePending | null =
      r.op === "DEPLOY" && r.commandId === rel.deployCommandId ? "DEPLOY" : r.op === "ROLLBACK" && r.commandId === rel.rollbackCommandId ? "ROLLBACK" : null;
    if (kind === null || rel.phase === "SUPERSEDED") return this.finish("ignored:stale");
    if (rel.pending !== kind) return this.finish("ignored:duplicate");
    if (kind === "ROLLBACK") {
      this.rollbackResult(rel, r);
    } else if (rel.phase === "STAGING") {
      this.stagingDeployed(rel, r);
    } else if (rel.phase === "CANARY") {
      this.canaryDeployed(rel, r);
    } else {
      return this.finish("ignored:duplicate");
    }
    return this.finish("applied");
  }

  /** Sentinel reports a health verdict (matched by command id). */
  sentinelVerdict(v: SentinelVerdict): ReleasePlanResult {
    const rel = this.resolve(v.releaseId, v.commandId);
    if (!rel) return this.finish("ignored:unknown");
    if (v.commandId !== rel.sentinelCommandId || rel.phase === "SUPERSEDED") return this.finish("ignored:stale");
    if (rel.pending !== "SENTINEL") return this.finish("ignored:duplicate");
    const expected = rel.phase === "VALIDATING" ? "staging" : rel.phase === "CANARY" ? "canary" : null;
    if (v.environment !== expected) return this.finish("ignored:stale");
    this.effects.push({ type: "broadcast", message: { type: "sentinel.verdict", verdict: v } });
    if (rel.phase === "VALIDATING") {
      if (v.inconclusive) {
        this.stagingInconclusive(rel, v.summary);
      } else if (v.verdict === "PROMOTE") {
        this.set(rel, { phase: "AWAITING_TAP", pending: null, summary: clip(v.summary) });
        if (this.ctx.autoShip && !this.ctx.paused) this.autoShip(rel);
        else if (!this.ctx.paused) this.openApproval(rel);
      } else {
        this.stagingFailed(rel, `Staging validation failed: ${v.summary}`);
      }
    } else if (v.verdict === "PROMOTE" && !v.inconclusive) {
      this.promoteCanary(rel, v.summary);
    } else if (v.inconclusive) {
      // Nothing was measured (unreachable, too few answers): not the change. Roll traffic back, park, ask.
      const percent = rel.canaryPercent ?? 0;
      this.canaryInfraStop(rel, `Canary at ${percent}% inconclusive: ${v.summary}`, "SENTINEL_INCONCLUSIVE");
    } else {
      this.startRollback(rel, `Canary at ${rel.canaryPercent ?? 0}% failed: ${v.summary}`);
    }
    return this.finish("applied");
  }

  /** A human taps to ship (identity from Cloudflare Access). Only valid in AWAITING_TAP. */
  tap(releaseId: string, user: string): ReleasePlanResult {
    const rel = this.releases.find((r) => r.releaseId === releaseId);
    if (!rel) return this.finish("ignored:unknown");
    // Paused: no new canary starts until the hive is unpaused.
    if (rel.phase !== "AWAITING_TAP" || this.ctx.paused) return this.finish("conflict");
    this.startCanary(rel, user);
    this.resolveParked(rel, user, "ship");
    return this.finish("applied");
  }

  /**
   * `retry` on a release's EXECUTOR_LOST: re-run the step infrastructure stopped.
   * A parked staging deploy is re-issued; a parked canary (AWAITING_TAP after an
   * infra stop) restarts at 1% (the human's retry is the tap).
   */
  retry(releaseId: string, user: string): ReleasePlanResult {
    const rel = this.releases.find((r) => r.releaseId === releaseId);
    if (!rel) return this.finish("ignored:unknown");
    if (rel.phase === "STAGING" && rel.pending === null) {
      this.set(rel, { summary: null });
      this.stage(rel);
      return this.finish("applied");
    }
    if (rel.phase === "AWAITING_TAP" && !this.ctx.paused) {
      this.startCanary(rel, user);
      this.resolveParked(rel, user, "ship");
      return this.finish("applied");
    }
    return this.finish("conflict");
  }

  /** The tap body: record who/when and start the 1% canary. */
  private startCanary(rel: ReleaseRecord, actor: string): void {
    this.set(rel, { tappedBy: actor, tappedAt: this.ctx.now, phase: "CANARY", step: 0, summary: clip(`Tapped to ship by ${actor}.`) });
    this.deployCanary(rel);
  }

  /** The Queen taps on its own (autonomous hive). */
  private autoShip(rel: ReleaseRecord): void {
    this.startCanary(rel, AUTO_SHIP_ACTOR);
    this.resolveParked(rel, AUTO_SHIP_ACTOR, "auto-shipped");
    this.events.push({
      type: "release.autoshipped",
      actor: AUTO_SHIP_ACTOR,
      traceId: rel.traceId ?? null,
      releaseId: rel.releaseId,
      summary: clip(`Release ${rel.releaseId} (main ${short(rel.headSha)}) auto-shipped: canary started at ${CANARY_STEPS[0]}%.`),
      data: { headSha: rel.headSha, trainIds: rel.trainIds },
    });
  }

  /** AWAITING_TAP and parked: an open SENTINEL_INCONCLUSIVE, or a human chose `hold`. */
  private parkedByHuman(rel: ReleaseRecord): boolean {
    return this.escalationsOf(rel).some(
      (e) =>
        (e.status === "OPEN" && (e.reason === "SENTINEL_INCONCLUSIVE" || e.reason === "EXECUTOR_LOST")) ||
        (PARKED_RELEASE_REASONS.has(e.reason) && resolutionAction(e) === "hold"),
    );
  }

  /**
   * Autonomy changed (or the Queen restarted): an AWAITING_TAP release ships on
   * its own once autoShip holds, unless parked; a supervised hive asks once.
   */
  private reconcileParked(): void {
    const rel = this.inFlight();
    if (rel?.phase !== "AWAITING_TAP" || this.ctx.paused) return;
    if (this.ctx.autoShip) {
      if (!this.parkedByHuman(rel)) this.autoShip(rel);
      return;
    }
    if (!this.escalationsOf(rel).some((e) => PARKED_RELEASE_REASONS.has(e.reason))) this.openApproval(rel);
  }

  /**
   * Crash / failure recovery (DO alarm): the watchdog first, then re-dispatch
   * the in-flight release's outstanding command under the same id (a no-op if
   * the executor did start it).
   */
  reconcile(): ReleasePlanResult {
    this.watchdog();
    this.reconcileParked();
    const rel = this.inFlight();
    if (rel?.pending === "DEPLOY") this.emitDeploy(rel);
    else if (rel?.pending === "SENTINEL") this.emitSentinel(rel);
    else if (rel?.pending === "ROLLBACK") this.emitRollback(rel);
    return this.finish("applied");
  }

  /**
   * An outstanding command unreported past its timeout is re-issued under a
   * new id (a late result for the old id is then stale). After the attempt
   * cap it takes the same path as a failed result. Sentinel's timeout is its
   * window plus grace.
   */
  private watchdog(): void {
    const rel = this.inFlight();
    if (!rel) return;
    const o = outstanding(rel, this.ctx.now);
    if (!o) return;
    const limit = o.kind === "SENTINEL" ? sentinelTimeoutMs(this.timeoutMs, this.sentinel.windowSeconds) : this.timeoutMs;
    if (this.ctx.now - o.at < limit) return;
    const id = o.kind === "DEPLOY" ? rel.deployCommandId : o.kind === "SENTINEL" ? rel.sentinelCommandId : rel.rollbackCommandId;
    const late = `${o.kind === "SENTINEL" ? "Sentinel" : `Herald ${o.kind}`} ${id ?? ""} did not report within ${Math.round(limit / 60_000)} min (executor lost?)`;
    if (commandAttempt(id) < MAX_COMMAND_ATTEMPTS) {
      if (o.kind === "DEPLOY" && rel.phase === "STAGING") this.deployStaging(rel);
      else if (o.kind === "DEPLOY") this.deployCanary(rel);
      else if (o.kind === "SENTINEL") this.dispatchSentinel(rel);
      else this.dispatchRollback(rel);
      return;
    }
    if (o.kind === "ROLLBACK") return this.rollbackFailed(rel, late);
    // A lost executor is infrastructure, never the change: park and escalate (no FAILED, no rollback count, no bug).
    if (rel.phase === "STAGING") return this.stagingInfraStop(rel, late);
    if (rel.phase === "VALIDATING") return this.stagingInconclusive(rel, late);
    this.canaryInfraStop(rel, late, "EXECUTOR_LOST");
  }

  // ── staging ───────────────────────────────────────────────────────────

  private stage(rel: ReleaseRecord): void {
    this.setEnv("staging", { status: "PENDING", commitSha: rel.headSha, versionId: null, percent: 100, summary: null });
    this.deployStaging(rel);
  }

  private deployStaging(rel: ReleaseRecord): void {
    this.set(rel, { pending: "DEPLOY", deployCommandId: releaseCommandId(rel.releaseId, "staging", rel.deployCommandId) }, false);
    this.emitDeploy(rel);
  }

  private stagingDeployed(rel: ReleaseRecord, r: DeployResult): void {
    if (!r.ok || !r.url) {
      const why = r.summary || (r.ok ? "Herald reported a staging deploy without a URL." : "Staging deploy failed.");
      this.setEnv("staging", { status: "FAILED", summary: clip(why), versionId: r.versionId ?? null });
      if (!r.ok && r.retryable) {
        // Infrastructure (5xx / 429 past Herald's retries): re-issue, then park.
        if (commandAttempt(rel.deployCommandId) < MAX_COMMAND_ATTEMPTS) this.deployStaging(rel);
        else this.stagingInfraStop(rel, why);
        return;
      }
      this.stagingFailed(rel, `Staging deploy failed: ${why}`);
      return;
    }
    this.setEnv("staging", { status: "LIVE", url: r.url, versionId: r.versionId ?? null, commitSha: r.commitSha ?? rel.headSha, summary: r.summary ?? null });
    this.set(rel, { phase: "VALIDATING", stagingUrl: r.url, summary: r.summary ? clip(r.summary) : rel.summary });
    this.dispatchSentinel(rel);
  }

  /**
   * Staging deploy or validation failed. P5 hook: bisect the release over its
   * trains' landed SHAs (stage the midpoint, log2(k) Herald + Sentinel rounds),
   * revert the culprit with a Reverter drone and re-cut. For now: FAILED.
   */
  private stagingFailed(rel: ReleaseRecord, summary: string): void {
    this.set(rel, { phase: "FAILED", pending: null, summary: clip(summary) });
  }

  /** Staging could not be deployed for infrastructure reasons: parked in STAGING (a newer head supersedes it; `retry` re-deploys). */
  private stagingInfraStop(rel: ReleaseRecord, why: string): void {
    const summary = clip(`${INFRA_SUMMARY_PREFIX}staging deploy did not complete after ${commandAttempt(rel.deployCommandId)} attempts: ${why}`);
    this.set(rel, { pending: null, summary });
    this.openEscalation("EXECUTOR_LOST", rel, `Release ${rel.releaseId} (main ${short(rel.headSha)}) is parked: ${summary.slice(INFRA_SUMMARY_PREFIX.length)}`);
  }

  /** Nobody measured staging (unreachable, too few answers, Sentinel lost): parked even when autonomous. */
  private stagingInconclusive(rel: ReleaseRecord, why: string): void {
    this.set(rel, { phase: "AWAITING_TAP", pending: null, summary: clip(`Sentinel inconclusive on staging: ${why}`) });
    this.openEscalation("SENTINEL_INCONCLUSIVE", rel, `Sentinel could not measure staging for release ${rel.releaseId} (main ${short(rel.headSha)}): ${why}`);
  }

  // ── canary ────────────────────────────────────────────────────────────

  private deployCanary(rel: ReleaseRecord): void {
    const percent = CANARY_STEPS[rel.step ?? 0]!;
    this.set(rel, { pending: "DEPLOY", deployCommandId: releaseCommandId(rel.releaseId, `canary${percent}`, rel.deployCommandId) }, false);
    this.setEnv("canary", { status: "PENDING", commitSha: rel.headSha, percent, summary: null });
    this.emitDeploy(rel);
  }

  private canaryDeployed(rel: ReleaseRecord, r: DeployResult): void {
    const first = (rel.step ?? 0) === 0 && rel.candidateVersionId === null;
    const stable = first ? (r.stableVersionId ?? null) : rel.stableVersionId;
    const candidate = first ? (r.versionId ?? null) : rel.candidateVersionId;
    const url = r.url ?? rel.prodUrl;
    if (first && stable && !rel.stableVersionId) this.set(rel, { stableVersionId: stable }, false);
    if (!r.ok || !candidate || !url) {
      const why = r.summary || (!r.ok ? "Canary deploy failed." : !candidate ? "Herald reported a canary deploy without a version id." : "Herald reported a canary deploy without a URL.");
      this.setEnv("canary", { status: "FAILED", summary: clip(why) });
      if (!r.ok && r.retryable) {
        // Infrastructure (5xx / 429 past Herald's retries): re-issue the same step, then stop on infra.
        if (commandAttempt(rel.deployCommandId) < MAX_COMMAND_ATTEMPTS) this.deployCanary(rel);
        else this.canaryInfraStop(rel, `Canary deploy at ${CANARY_STEPS[rel.step ?? 0]}% did not complete after ${commandAttempt(rel.deployCommandId)} attempts: ${why}`, "EXECUTOR_LOST");
        return;
      }
      this.startRollback(rel, `Canary deploy at ${CANARY_STEPS[rel.step ?? 0]}% failed: ${why}`);
      return;
    }
    // First prod deploy: nothing to split against, Herald put the candidate at 100%.
    const step = first && !stable ? CANARY_STEPS.length - 1 : (rel.step ?? 0);
    const percent = CANARY_STEPS[step]!;
    this.set(rel, { step, canaryPercent: percent, candidateVersionId: candidate, stableVersionId: stable, prodUrl: url });
    this.setEnv("canary", { status: "LIVE", url, versionId: candidate, commitSha: rel.headSha, percent, summary: r.summary ?? null });
    this.setEnv("prod", stable
      ? { status: "LIVE", url, versionId: stable, percent: 100 - percent, summary: null }
      : { status: "LIVE", url, versionId: candidate, commitSha: rel.headSha, percent: 100, summary: "First prod deploy: no stable version to split against." });
    this.dispatchSentinel(rel);
  }

  private promoteCanary(rel: ReleaseRecord, summary: string): void {
    const step = rel.step ?? 0;
    if (step < CANARY_STEPS.length - 1) {
      this.set(rel, { step: step + 1, summary: clip(summary) });
      this.deployCanary(rel);
      return;
    }
    // 100% and healthy: the candidate is the new stable baseline.
    this.set(rel, { phase: "SHIPPED", pending: null, canaryPercent: 100, summary: clip(summary) });
    this.setEnv("prod", { status: "LIVE", url: rel.prodUrl, versionId: rel.candidateVersionId, commitSha: rel.headSha, percent: 100, summary: clip(`Shipped release ${rel.releaseId}.`) });
    this.setEnv("canary", { status: "TORN_DOWN", percent: null, summary: null });
    this.streak = 0;
    for (const e of this.escalations) {
      if (e.status === "OPEN" && e.reason === "ROLLBACK_STREAK") this.resolveEscalation(e, QUEEN_ACTOR, `cleared: release ${rel.releaseId} shipped`);
    }
    this.cutQueued(rel, false);
  }

  /**
   * A canary stopped by infrastructure (deploy 5xx past its retries, a lost executor, an
   * inconclusive verdict). If traffic may be split (a candidate is up and there is a stable
   * version), Herald rolls it back first; then the release is parked (canaryParked).
   */
  private canaryInfraStop(rel: ReleaseRecord, why: string, reason: "EXECUTOR_LOST" | "SENTINEL_INCONCLUSIVE"): void {
    this.set(rel, { summary: clip(`${INFRA_SUMMARY_PREFIX}${why}`) });
    this.openEscalation(
      reason,
      rel,
      reason === "EXECUTOR_LOST"
        ? `Release ${rel.releaseId} (main ${short(rel.headSha)}) stopped on infrastructure, not a bad change: ${why}. Traffic is back on the stable version; retry restarts the canary.`
        : `Sentinel could not measure the ${rel.canaryPercent ?? 0}% canary of release ${rel.releaseId}; traffic is back on the stable version and the release is parked (ack to let it ship again): ${why}`,
      // Canary-time SENTINEL_INCONCLUSIVE stays ack-only (it is opened while the release is still in CANARY).
      reason === "SENTINEL_INCONCLUSIVE" ? ["ack"] : undefined,
    );
    if (rel.stableVersionId && rel.candidateVersionId) this.dispatchRollback(rel);
    else this.canaryParked(rel);
  }

  /**
   * After an infra stop (and its rollback, if any): back to AWAITING_TAP with the canary reset,
   * untapped, so it never counts against the error budget or the rollback streak and files no
   * bug. A head that landed during the canary supersedes it instead.
   */
  private canaryParked(rel: ReleaseRecord): void {
    this.setEnv("canary", { status: "TORN_DOWN", percent: null });
    if (rel.nextHeadSha) {
      this.set(rel, { phase: "SUPERSEDED", pending: null });
      this.resolveParked(rel, QUEEN_ACTOR, SUPERSEDED_RESOLUTION);
      for (const e of this.escalationsOf(rel)) {
        if (e.status === "OPEN" && e.reason === "EXECUTOR_LOST") this.resolveEscalation(e, QUEEN_ACTOR, SUPERSEDED_RESOLUTION);
      }
      this.cutQueued(rel, true);
      return;
    }
    this.set(rel, { phase: "AWAITING_TAP", pending: null, step: null, canaryPercent: null, candidateVersionId: null, tappedBy: null, tappedAt: null });
  }

  private startRollback(rel: ReleaseRecord, summary: string): void {
    if (!rel.stableVersionId) {
      // The candidate (if it got uploaded) is serving 100% of prod and Herald reads the live
      // deployment for the next release's stable version, so state that honestly.
      const live = rel.candidateVersionId;
      const tail = live
        ? ` Candidate ${live.slice(0, 8)} is still serving 100% of prod because there was no prior version to roll back to; it becomes the stable version for the next release.`
        : " No stable version to roll back to (first prod deploy), so nothing was rolled back.";
      this.set(rel, { phase: "FAILED", pending: null, canaryPercent: live ? 100 : rel.canaryPercent, summary: clip(`${summary.length + tail.length > 500 ? `${summary.slice(0, Math.max(0, 497 - tail.length))}...` : summary}${tail}`) });
      if (live) {
        this.setEnv("prod", { status: "LIVE", url: rel.prodUrl, versionId: live, commitSha: rel.headSha, percent: 100, summary: clip(`Release ${rel.releaseId} failed its canary, but this version is still live: no prior version to roll back to.`) });
        this.setEnv("canary", { status: "TORN_DOWN", percent: null });
      }
      this.countRollback(rel);
      this.cutQueued(rel, true);
      return;
    }
    this.set(rel, { summary: clip(summary) });
    this.dispatchRollback(rel);
  }

  private dispatchRollback(rel: ReleaseRecord): void {
    this.set(rel, { pending: "ROLLBACK", rollbackCommandId: releaseCommandId(rel.releaseId, "rollback", rel.rollbackCommandId) }, false);
    this.emitRollback(rel);
  }

  private rollbackResult(rel: ReleaseRecord, r: DeployResult): void {
    if (!r.ok) {
      const why = `Herald ROLLBACK failed: ${r.summary ?? "unknown error"}`;
      if (commandAttempt(rel.rollbackCommandId) < MAX_COMMAND_ATTEMPTS) this.dispatchRollback(rel);
      else this.rollbackFailed(rel, why);
      return;
    }
    this.setEnv("prod", { status: "LIVE", url: rel.prodUrl, versionId: rel.stableVersionId, percent: 100, summary: clip(`Rolled back release ${rel.releaseId}: ${rel.summary ?? ""}`) });
    if (isInfraStop(rel)) {
      // The traffic is safe again; the change was never judged: park, do not count.
      this.canaryParked(rel);
      return;
    }
    this.set(rel, { phase: "ROLLED_BACK", pending: null, canaryPercent: 0 });
    this.setEnv("canary", { status: "TORN_DOWN", percent: null });
    this.countRollback(rel);
    this.cutQueued(rel, true);
  }

  private rollbackFailed(rel: ReleaseRecord, why: string): void {
    this.set(rel, { phase: "FAILED", pending: null, summary: clip(`${rel.summary ?? "Canary failed."} ${why}; prod may still split traffic, roll back manually.`) });
    this.setEnv("prod", { status: "FAILED", summary: clip(why) });
    this.openEscalation("ROLLBACK_FAILED", rel, `Release ${rel.releaseId}: ${why}. Prod may still split traffic between ${rel.stableVersionId ?? "?"} and ${rel.candidateVersionId ?? "?"}; roll back by hand, then ack.`);
    // An infra stop whose rollback failed too: still not the change (no streak; the budget and bug filing skip it as well).
    if (!isInfraStop(rel)) this.countRollback(rel);
    this.cutQueued(rel, true);
  }

  /** The canary ended: cut the head that landed meanwhile (keeping unshipped trains when it did not ship). */
  private cutQueued(rel: ReleaseRecord, keepTrains: boolean): void {
    if (!rel.nextHeadSha) return;
    const trainIds = [...(keepTrains ? rel.trainIds : []), ...rel.nextTrainIds];
    const head = rel.nextHeadSha;
    this.set(rel, { nextHeadSha: null, nextTrainIds: [] }, false);
    this.stage(this.create(head, trainIds));
  }

  // ── sentinel ──────────────────────────────────────────────────────────

  private dispatchSentinel(rel: ReleaseRecord): void {
    const op = rel.phase === "VALIDATING" ? "validate" : `verify${rel.canaryPercent ?? 0}`;
    this.set(rel, { pending: "SENTINEL", sentinelCommandId: releaseCommandId(rel.releaseId, op, rel.sentinelCommandId) }, false);
    this.emitSentinel(rel);
  }

  private emitSentinel(rel: ReleaseRecord): void {
    const base = {
      commandId: rel.sentinelCommandId!,
      hive: this.ctx.namespace,
      releaseId: rel.releaseId,
      paths: [...SENTINEL_PATHS],
      windowSeconds: this.sentinel.windowSeconds,
      minRequests: this.sentinel.minRequests,
    };
    const command: SentinelCommand =
      rel.phase === "VALIDATING"
        ? { ...base, environment: "staging", scriptName: stagingScript(this.ctx.namespace), url: rel.stagingUrl! }
        : {
            ...base,
            environment: "canary",
            scriptName: appScript(this.ctx.namespace),
            url: rel.prodUrl!,
            canaryPercent: rel.canaryPercent ?? 100,
            ...(rel.candidateVersionId ? { candidateVersionId: rel.candidateVersionId } : {}),
            ...(rel.stableVersionId ? { stableVersionId: rel.stableVersionId } : {}),
          };
    this.effects.push({ type: "sentinel", releaseId: rel.releaseId, command });
  }

  // ── herald ────────────────────────────────────────────────────────────

  private emitDeploy(rel: ReleaseRecord): void {
    const common = {
      op: "DEPLOY" as const,
      commandId: rel.deployCommandId!,
      hive: this.ctx.namespace,
      releaseId: rel.releaseId,
      artifactRepo: this.ctx.namespace,
      commitSha: rel.headSha,
    };
    let command: DeployCommand;
    if (rel.phase === "STAGING") {
      command = { ...common, environment: "staging" };
    } else {
      const step = rel.step ?? 0;
      command = {
        ...common,
        environment: "canary",
        percent: CANARY_STEPS[step]!,
        // Later steps re-split the already-uploaded candidate against the stable version.
        ...(step > 0 && rel.candidateVersionId ? { versionId: rel.candidateVersionId } : {}),
        ...(step > 0 && rel.stableVersionId ? { stableVersionId: rel.stableVersionId } : {}),
      };
    }
    this.effects.push({ type: "deploy", releaseId: rel.releaseId, command });
  }

  private emitRollback(rel: ReleaseRecord): void {
    this.effects.push({
      type: "deploy",
      releaseId: rel.releaseId,
      command: { op: "ROLLBACK", commandId: rel.rollbackCommandId!, hive: this.ctx.namespace, environment: "canary", toVersionId: rel.stableVersionId! },
    });
  }

  // ── autonomy: escalations and the rollback streak ─────────────────────

  /** A canary ended in ROLLED_BACK or FAILED: the streak grows; at the limit the hive is asked. */
  private countRollback(rel: ReleaseRecord): void {
    this.streak += 1;
    if (this.streak < ROLLBACK_STREAK_LIMIT) return;
    const hive = this.ctx.namespace;
    if (this.escalations.some((e) => e.status === "OPEN" && e.reason === "ROLLBACK_STREAK")) return;
    this.pushEscalation(
      newEscalation(hive, this.ctx.now, {
        reason: "ROLLBACK_STREAK",
        subject: { type: "hive", id: hive },
        traceId: rel.traceId ?? null,
        summary: `${this.streak} releases in a row were rolled back or failed their canary (latest ${rel.releaseId}); the hive runs supervised.`,
      }),
    );
  }

  private openApproval(rel: ReleaseRecord): void {
    this.openEscalation("APPROVAL_REQUIRED", rel, `Release ${rel.releaseId} (main ${short(rel.headSha)}, ${rel.trainIds.length} train${rel.trainIds.length === 1 ? "" : "s"}) passed staging: ${rel.summary ?? "healthy"}`);
  }

  /** Open `reason` about `rel` unless one is already open. */
  private openEscalation(reason: EscalationReason, rel: ReleaseRecord, summary: string, actions?: EscalationAction[]): void {
    if (this.escalationsOf(rel).some((e) => e.status === "OPEN" && e.reason === reason)) return;
    this.pushEscalation(
      newEscalation(this.ctx.namespace, this.ctx.now, {
        reason,
        subject: { type: "release", id: rel.releaseId },
        traceId: rel.traceId ?? null,
        summary,
        ...(actions ? { actions } : {}),
      }),
    );
  }

  private pushEscalation(e: Escalation): void {
    this.escalations.push(e);
    this.dirtyEscalations.add(e.escalationId);
    this.events.push(escalationOpenedEvent(e));
  }

  /** Resolve the open APPROVAL_REQUIRED / SENTINEL_INCONCLUSIVE (ship/hold kind) of a parked release. */
  private resolveParked(rel: ReleaseRecord, by: string, resolution: string): void {
    for (const e of this.escalationsOf(rel)) {
      if (e.status === "OPEN" && PARKED_RELEASE_REASONS.has(e.reason) && e.actions.includes("ship")) this.resolveEscalation(e, by, resolution);
    }
  }

  private resolveEscalation(e: Escalation, by: string, resolution: string): void {
    Object.assign(e, resolvedEscalation(e, by, resolution, this.ctx.now));
    this.dirtyEscalations.add(e.escalationId);
    this.events.push(escalationResolvedEvent(e));
  }

  private escalationsOf(rel: ReleaseRecord): Escalation[] {
    return this.escalations.filter((e) => isAbout(e, "release", rel.releaseId));
  }

  // ── internals ─────────────────────────────────────────────────────────

  private inFlight(): ReleaseRecord | undefined {
    return this.releases.filter(isInFlight).sort((a, b) => b.seq - a.seq)[0];
  }

  private newest(): ReleaseRecord | undefined {
    return [...this.releases].sort((a, b) => b.seq - a.seq)[0];
  }

  /** Trains landed since the last SHIPPED release (the newest release carries them cumulatively). */
  private sinceLastShipped(): string[] {
    const last = this.newest();
    return !last || last.phase === "SHIPPED" ? [] : [...last.trainIds];
  }

  private resolve(releaseId: string | undefined, commandId: string): ReleaseRecord | undefined {
    if (releaseId) return this.releases.find((r) => r.releaseId === releaseId);
    return this.releases.find((r) => commandId.startsWith(`${r.releaseId}-`));
  }

  private create(headSha: string, trainIds: string[]): ReleaseRecord {
    const releaseId = this.ctx.newId();
    const rel: ReleaseRecord = {
      releaseId,
      // Each release gets its own trace, minted from its id (§2.6).
      traceId: traceIdFromUuid(releaseId),
      hive: this.ctx.namespace,
      headSha,
      trainIds,
      phase: "STAGING",
      canaryPercent: null,
      stagingUrl: null,
      prodUrl: null,
      candidateVersionId: null,
      stableVersionId: null,
      tappedBy: null,
      tappedAt: null,
      summary: null,
      createdAt: this.ctx.now,
      updatedAt: this.ctx.now,
      seq: ++this.maxSeq,
      step: null,
      pending: null,
      deployCommandId: null,
      deployIssuedAt: null,
      sentinelCommandId: null,
      sentinelIssuedAt: null,
      rollbackCommandId: null,
      rollbackIssuedAt: null,
      nextHeadSha: null,
      nextTrainIds: [],
    };
    this.releases.push(rel);
    this.dirty.set(rel.releaseId, true);
    return rel;
  }

  private set(rel: ReleaseRecord, patch: Partial<ReleaseRecord>, visible = true): void {
    const stamped: Partial<ReleaseRecord> = {};
    for (const [idField, clock] of Object.entries(ISSUED_AT) as [keyof typeof ISSUED_AT, (typeof ISSUED_AT)[keyof typeof ISSUED_AT]][]) {
      if (idField in patch && patch[idField] !== rel[idField] && !(clock in patch)) stamped[clock] = patch[idField] ? this.ctx.now : null;
    }
    const from = rel.phase;
    // Strictly increasing: the War Room drops updates older than (or equal to) the one it holds.
    Object.assign(rel, patch, stamped, { updatedAt: Math.max(this.ctx.now, rel.updatedAt + 1) });
    if (patch.phase !== undefined && patch.phase !== from) {
      const bad = rel.phase === "FAILED" || rel.phase === "ROLLED_BACK";
      this.events.push({
        type: "release.phase",
        severity: bad ? "warn" : "info",
        actor: rel.phase === "CANARY" && rel.tappedBy ? rel.tappedBy : QUEEN_ACTOR,
        traceId: rel.traceId ?? null,
        releaseId: rel.releaseId,
        summary: clip(`Release ${rel.releaseId}: ${from} → ${rel.phase}${rel.summary ? `. ${rel.summary}` : ""}`),
        data: { from, to: rel.phase, headSha: rel.headSha, canaryPercent: rel.canaryPercent },
      });
    }
    this.dirty.set(rel.releaseId, (this.dirty.get(rel.releaseId) ?? false) || visible);
  }

  private setEnv(env: "staging" | "canary" | "prod", patch: Partial<Deployment>): void {
    const id = envDeploymentId(env);
    const prev: Deployment = this.deployments.get(id) ?? {
      deploymentId: id,
      hive: this.ctx.namespace,
      environment: env,
      trainId: null,
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

  private finish(outcome: ReleaseOutcome): ReleasePlanResult {
    const releases = [...this.dirty.keys()].map((id) => {
      const r = this.releases.find((x) => x.releaseId === id)!;
      return { ...r, trainIds: [...r.trainIds], nextTrainIds: [...r.nextTrainIds] };
    });
    const deployments = [...this.dirtyDeployments].map((id) => ({ ...this.deployments.get(id)! }));
    // The watchdog may re-issue a command that reconcile then re-emits: one dispatch each.
    const seen = new Set<string>();
    const effects = this.effects.filter((e) => {
      if (e.type === "broadcast") return true;
      if (seen.has(e.command.commandId)) return false;
      seen.add(e.command.commandId);
      return true;
    });
    const broadcasts: ReleaseEffect[] = [
      ...releases.filter((r) => this.dirty.get(r.releaseId)).map((r): ReleaseEffect => ({ type: "broadcast", message: { type: "release.updated", release: toRelease(r) } })),
      ...deployments.map((d): ReleaseEffect => ({ type: "broadcast", message: { type: "deployment.updated", deployment: d } })),
    ];
    const escalations = [...this.dirtyEscalations].map((id) => {
      const e = this.escalations.find((x) => x.escalationId === id)!;
      return { ...e, subject: { ...e.subject }, actions: [...e.actions] };
    });
    const result: ReleasePlanResult = {
      outcome,
      releases,
      deployments,
      effects: [...effects, ...broadcasts],
      escalations,
      events: this.events,
      rollbackStreak: this.streak,
    };
    this.dirty.clear();
    this.dirtyDeployments.clear();
    this.dirtyEscalations.clear();
    this.effects = [];
    this.events = [];
    return result;
  }
}

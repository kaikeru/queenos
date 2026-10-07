/**
 * The gate control flow ("The Bouncer and The Scribe"), written against a
 * minimal StepRunner and the GatekeeperPorts seam so it is testable without
 * Workflows, Artifacts or the Queen. GatekeeperWorkflow.run() is a thin adapter.
 *
 * Two entry points, one Workflow class:
 * - handlePush: the instance Artifacts starts per push event. Pure filtering,
 *   then dispatches ONE deterministic instance per (repo, after) = idempotency.
 * - runGate: that deterministic instance. Waits for the Queen to reach TESTING,
 *   clone+scan+test in one step, audits, Scribe, Vectorize, verdict. The Queen also
 *   starts it directly (a GATE command, `task.commandId`) when a train enters TESTING;
 *   then the Queen's GateTarget.gateId names the one instance that gates the round.
 *
 * Replay rules: all clock reads and I/O are inside steps; steps return small
 * serializable values.
 */
import type { WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { isTransientError, retryTransient, spanIdFor, type AppendAuditInput, type AuditEvent, type AuditStatus, type DroneRole, type FollowUp, type GateScore, type GateTarget, type GitNotesPayload, type MemoryOutcome, type SubmissionOrigin, type TrainLane } from "@queenos/queen-types";
import { AiGatewayError, LedgerError, buildGitNotesPayload, composeMemoryText, memoryIdFor } from "@queenos/hive-kit";
import type { GateConfig } from "./config";
import { classifyPush, gateInstanceId, parsePushEvent, type GateTask } from "./event";
import { formatFinding, type ScanReport } from "./findings";
import { integrationRoutes, inspectPush, type Inspection, type IntegrationSpec } from "./inspect";
import type { FailureChunk, GatekeeperPorts, QueenPort, QueenSnapshot } from "./ports";
import { MAX_PROMPT_CHARS, SCRIPTED_REVIEW_MODEL, runReview, scriptedReview, type ReviewOutcome, type ReviewPacket } from "./review";
import { MAX_SUMMARY_CHARS, clip, extractiveSummary, summarizeFailure, type ScribeResult } from "./scribe";
import { NotImplementedError } from "./test-runner";

export interface StepRunner {
  do<T>(name: string, config: WorkflowStepConfig, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

export const LOOKUP_STEP: WorkflowStepConfig = { retries: { limit: 4, delay: "2 seconds", backoff: "exponential" }, timeout: "30 seconds" };
/**
 * Clone + scan + test. Inside each try, transient Artifacts errors (5xx / 429) are retried with
 * jitter first (retryTransient), so a swarm of gates does not retry in lockstep; then Workflows
 * retries the step 4 more times (15 s, 30 s, 60 s, 120 s). Only then is it reported, as infra.
 * The timeout is per attempt: 4 in-step tries (<= 5+10+20 s of jittered sleeps at the default base)
 * around clone/scan/test work, so 8 minutes.
 */
export const INSPECT_STEP: WorkflowStepConfig = { retries: { limit: 4, delay: "15 seconds", backoff: "exponential" }, timeout: "8 minutes" };
/** In-step jittered tries of the inspect body on transient errors. */
export const INSPECT_TRANSIENT_ATTEMPTS = 4;
export const SCRIBE_STEP: WorkflowStepConfig = { retries: { limit: 2, delay: "3 seconds", backoff: "exponential" }, timeout: "2 minutes" };
export const REPORT_STEP: WorkflowStepConfig = { retries: { limit: 5, delay: "2 seconds", backoff: "exponential" }, timeout: "30 seconds" };
/** The reviewer retries internally (and fails open), so Workflows must not retry it again. */
export const REVIEW_STEP: WorkflowStepConfig = { retries: { limit: 0, delay: "1 second" }, timeout: "3 minutes" };
export const BEST_EFFORT_STEP: WorkflowStepConfig = { retries: { limit: 1, delay: "2 seconds" }, timeout: "1 minute" };
export const DISPATCH_STEP: WorkflowStepConfig = { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" }, timeout: "30 seconds" };

export const POLICY_MODEL = "queenos/policy-scan-v1";
export const SECURITY_MODEL = "queenos/security-scan-v1";
export const SCRIBE_EXTRACTIVE_MODEL = "queenos/scribe-extractive-v1";

const messageOf = (e: unknown) => String((e as Error)?.message ?? e);

export function isPermanentQueenError(e: unknown): boolean {
  return /^(INVALID_INPUT|NOT_FOUND|CONFLICT): /.test(messageOf(e));
}

/** Errors that will not get better on retry become NonRetryableError inside steps. */
export function toStepError(e: unknown): unknown {
  if (e instanceof NonRetryableError) return e;
  // An HTTP 503 / 429 / 5xx (e.g. isomorphic-git "HTTP Error: 503 Service Unavailable") is always worth a retry.
  if (isTransientError(e)) return e;
  const permanent = e instanceof NotImplementedError || (e instanceof AiGatewayError && !e.retryable) || e instanceof LedgerError || /^(INVALID_INPUT|NOT_FOUND|CONFLICT|UNAVAILABLE): /.test(messageOf(e));
  return permanent ? new NonRetryableError(clip(messageOf(e), 1_000)) : e;
}

// ── trigger instance ────────────────────────────────────────────────────────

export type PushRunResult =
  | { status: "ignored"; reason: string }
  | { status: "dispatched" | "duplicate"; gateId: string; repo: string; after: string };

export async function handlePush(payload: unknown, step: StepRunner, ports: GatekeeperPorts, config: GateConfig): Promise<PushRunResult> {
  const parsed = parsePushEvent(payload);
  if (!parsed.ok) {
    console.warn("gatekeeper: unparseable push event", parsed.error);
    return { status: "ignored", reason: "invalid-event" };
  }
  const c = classifyPush(parsed.event, { artifactsNamespace: config.artifactsNamespace });
  if (c.action === "ignore") return { status: "ignored", reason: c.reason };
  const gateId = gateInstanceId(c.task);
  const started = await step.do("dispatch gate", DISPATCH_STEP, () => ports.dispatcher.start(gateId, c.task).catch((e) => Promise.reject(toStepError(e))));
  return { status: started === "started" ? "dispatched" : "duplicate", gateId, repo: c.task.repo, after: c.task.after };
}

// ── the gate ────────────────────────────────────────────────────────────────

export type ReadyLookup = {
  status: "ready";
  trainId: string;
  promptId: string;
  promptText: string;
  /** Up to 4 KB, for the reviewer. */
  promptFull: string;
  previewUrl: string | null;
  /** The newest BUILDER ledger's first reasoning steps (small, for hive memory). */
  builderReasoning: string[];
  /** BUILD: the full gate. QUEUE: the integration gate. */
  lane: TrainLane;
  /** The car's base (QUEUE: the integration gate scans `baseSha..head`). */
  baseSha: string | null;
  /** The train's trace id (a car's members each have their own: `memberTraces`). */
  traceId: string | null;
  /** QUEUE: smoke routes (`/`, `/health`, every member's smokePaths) and the members' trace ids. */
  routes: IntegrationSpec["routes"];
  memberTraces: string[];
  /** The Queen-started gate that owns this TESTING round (GateTarget.gateId); null: none (or an older Queen). */
  gateId: string | null;
  /** BUILD: whose code the train carries. Null = drone (absent on older Queens). Non-drone origins fail closed. */
  origin: SubmissionOrigin | null;
};
export type Lookup = ReadyLookup | { status: "waiting"; phase: string } | { status: "ignored"; reason: string };

const WAITING_PHASES = new Set(["BUILDING", "WAITING_PARENT", "DEPLOYING"]);

/** `GateTarget` (Queen RPC) to a lookup. The member list is the integration gate's smoke-route source. */
export function lookupFromTarget(t: GateTarget, builderReasoning: string[]): Lookup {
  // DEPLOYING: the Herald is putting the train on a Worker Preview; TESTING follows with `previewUrl` set.
  if (WAITING_PHASES.has(t.phase)) return { status: "waiting", phase: t.phase };
  if (t.phase !== "TESTING") return { status: "ignored", reason: `phase-${t.phase}` };
  if (!t.promptId) return { status: "ignored", reason: "train-without-prompt" };
  const members = t.lane === "QUEUE" ? (t.members ?? []) : [];
  return {
    status: "ready",
    trainId: t.trainId,
    promptId: t.promptId,
    promptText: t.promptText.slice(0, 500),
    promptFull: t.promptText.slice(0, MAX_PROMPT_CHARS),
    previewUrl: t.previewUrl || null,
    builderReasoning,
    lane: t.lane,
    baseSha: t.baseSha,
    traceId: t.traceId,
    routes: t.lane === "QUEUE" ? integrationRoutes(members) : [],
    memberTraces: [...new Set(members.flatMap((m) => (m.traceId ? [m.traceId] : [])))],
    gateId: t.gateId ?? null,
    origin: t.origin ?? null,
  };
}

/** The pre-v2 path, kept as the fallback: find the train in the Queen's snapshot by repo. */
export function lookupFromSnapshot(snap: QueenSnapshot, task: Pick<GateTask, "repo" | "after">): Lookup {
  const train = snap.trains.find((t) => t.artifactRepo === task.repo);
  if (!train) return { status: "ignored", reason: "unknown-train" };
  const phase = train.phase ?? train.status;
  if (WAITING_PHASES.has(phase)) return { status: "waiting", phase };
  if (phase !== "TESTING") return { status: "ignored", reason: `phase-${phase}` };
  if (train.headSha && train.headSha !== task.after) return { status: "ignored", reason: "not-train-head" };
  const promptId = train.includedPrompts.at(-1) ?? "";
  if (!promptId) return { status: "ignored", reason: "train-without-prompt" };
  const promptText = snap.promptRuns.find((p) => p.promptId === promptId)?.promptText ?? promptId;
  const lane: TrainLane = train.lane ?? "BUILD";
  // A v2 Queen's snapshot knows a car's member ids; smoke paths and titles are not in it (getGateTarget has them).
  const memberTrains = lane === "QUEUE" ? (train.members ?? []).flatMap((id) => snap.trains.filter((m) => m.trainId === id)) : [];
  return {
    status: "ready",
    trainId: train.trainId,
    promptId,
    promptText: promptText.slice(0, 500),
    promptFull: promptText.slice(0, MAX_PROMPT_CHARS),
    // `previewUrl` is absent in sim mode and on trains from before the Herald existed.
    previewUrl: train.previewUrl || null,
    builderReasoning: builderReasoningFor(snap.recentAudit, promptId),
    lane,
    baseSha: lane === "QUEUE" ? train.baseSha : null,
    traceId: train.traceId ?? null,
    routes: lane === "QUEUE" ? integrationRoutes([]) : [],
    memberTraces: [...new Set(memberTrains.flatMap((m) => (m.traceId ? [m.traceId] : [])))],
    gateId: null,
    origin: train.origin ?? null,
  };
}

/**
 * Which train does this push belong to, and is it ready to be gated? Asks the Queen's
 * `getGateTarget(repo)` RPC; when the Queen predates it (or the call fails) scans the snapshot instead.
 */
export async function lookupTrain(queen: QueenPort, task: Pick<GateTask, "repo" | "after">): Promise<Lookup> {
  if (typeof queen.getGateTarget === "function") {
    try {
      const target = await queen.getGateTarget(task.repo);
      if (!target) return { status: "ignored", reason: "unknown-train" };
      // The BUILDER ledger (hive memory) is only in the snapshot's audit tail: best effort.
      let reasoning: string[] = [];
      if (target.lane === "BUILD" && target.phase === "TESTING") {
        reasoning = await queen.getSnapshot().then((snap) => builderReasoningFor(snap.recentAudit, target.promptId)).catch(() => []);
      }
      return lookupFromTarget(target, reasoning);
    } catch (e) {
      console.warn("gatekeeper: getGateTarget unavailable; scanning the snapshot", messageOf(e));
    }
  }
  return lookupFromSnapshot(await queen.getSnapshot(), task);
}

const MEMORY_REASONING_STEPS = 6;
const MEMORY_REASONING_STEP_CHARS = 300;

/** The newest BUILDER ledger entry for this prompt that has a payload: its first few steps. */
function builderReasoningFor(audit: AuditEvent[] | undefined, promptId: string): string[] {
  let best: AuditEvent | undefined;
  for (const e of audit ?? []) {
    if (e.promptId !== promptId || e.droneRole !== "BUILDER" || !e.gitNotesPayload) continue;
    if (!best || e.createdAt > best.createdAt) best = e;
  }
  return (best?.gitNotesPayload?.reasoningSteps ?? []).slice(0, MEMORY_REASONING_STEPS).map((s) => clip(s, MEMORY_REASONING_STEP_CHARS));
}

export type GateRunResult =
  | { status: "ignored"; reason: string }
  | {
      status: "gated";
      trainId: string;
      passed: boolean;
      summary: string;
      queenOutcome: string;
      /** REVIEWER outcome; absent when review is off or did not run. */
      review?: "approved" | "rejected" | "skipped";
      lane?: TrainLane;
      /** v2: what was reported with the verdict. */
      score?: GateScore;
      followUps?: FollowUp[];
      scribe?: ScribeResult["method"];
      vectorized?: number;
      /** The gate itself could not run (reported with `cause: "infra"`). */
      infra?: boolean;
      /** Gate runs this instance made (> 1 after infra re-gates). */
      rounds?: number;
    };

interface Ctx {
  task: GateTask;
  step: StepRunner;
  ports: GatekeeperPorts;
  config: GateConfig;
  train: ReadyLookup;
}

/** Step names of round r > 1 get a suffix (Workflows caches steps by name; round 1 keeps its names for replay). */
function roundSteps(step: StepRunner, round: number): StepRunner {
  if (round === 1) return step;
  return { do: (name, c, fn) => step.do(`${name} ~r${round}`, c, fn), sleep: (name, ms) => step.sleep(`${name} ~r${round}`, ms) };
}

/**
 * Gate a push. When the gate itself fails on infrastructure it reports `cause: "infra"`; the Queen
 * then re-deploys the preview (no attempt charged) and this instance waits for TESTING again and
 * re-gates, up to `config.infraRounds` runs. It stops as soon as the Queen did not apply the report
 * or the train left (ejected after the Queen's infra cap: EXECUTOR_LOST).
 */
export async function runGate(task: GateTask, step: StepRunner, ports: GatekeeperPorts, config: GateConfig): Promise<GateRunResult> {
  let last: GateRunResult | null = null;
  for (let round = 1; round <= config.infraRounds; round++) {
    const s = roundSteps(step, round);
    // Later rounds wait out the Queen's backoff (30 s .. 3 min) plus the re-deploy.
    if (round > 1) await s.sleep("infra: wait for the re-deploy", config.phaseWaitMs);
    const out = await gateRound(task, s, ports, config, round === 1 ? config.phaseRetries : config.phaseRetries * 3);
    if (out.status !== "gated") return last ?? out;
    const result = round > 1 ? { ...out, rounds: round } : out;
    if (!out.infra || out.queenOutcome !== "applied") return result;
    last = result;
  }
  return last!;
}

async function gateRound(task: GateTask, step: StepRunner, ports: GatekeeperPorts, config: GateConfig, lookups: number): Promise<GateRunResult> {
  // 1. Wait for the Queen to process the builder's build-result (push event vs RPC race).
  let train: ReadyLookup | null = null;
  for (let i = 1; i <= lookups; i++) {
    const look = await step.do(`lookup train #${i}`, LOOKUP_STEP, () => lookupTrain(ports.queen(task.hive), task));
    if (look.status === "ignored") return { status: "ignored", reason: look.reason };
    if (look.status === "ready") {
      train = look;
      break;
    }
    if (i < lookups) await step.sleep(`wait for TESTING #${i}`, config.phaseWaitMs);
  }
  if (!train) return { status: "ignored", reason: "phase-timeout" };
  // The Queen started a gate for this TESTING round and it is not this instance (the push-event gate, or a Queen
  // gate the watchdog replaced): stand down, so one gate judges the round (no duplicate audits or verdicts).
  if (train.gateId && train.gateId !== (task.commandId ?? null)) return { status: "ignored", reason: "queen-gate" };

  const ctx: Ctx = { task, step, ports, config, train };
  const integration = train.lane === "QUEUE";
  glog(ctx, "lookup", "ready", { phaseRetries: config.phaseRetries });

  // 2. POLICY + SECURITY run while the dashboard shows yellow.
  await audits(ctx, "audit: policy+security running", [
    ["POLICY", "RUNNING", null],
    ["SECURITY", "RUNNING", null],
  ]);

  let inspection: Inspection;
  const spec: IntegrationSpec | undefined = integration ? { baseSha: train.baseSha, routes: train.routes } : undefined;
  const build = integration ? undefined : { baseSha: train.baseSha, origin: train.origin };
  try {
    inspection = await step.do("inspect: clone, scan, test", INSPECT_STEP, () =>
      retryTransient(() => inspectPush(ports, task, config, train.trainId, train.previewUrl, train.promptFull, spec, build), {
        attempts: INSPECT_TRANSIENT_ATTEMPTS,
        baseMs: config.transientBaseMs,
        maxMs: config.transientBaseMs * 8,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        onRetry: (attempt, delayMs, err) => glog(ctx, "inspect", "transient-retry", { attempt, delayMs, error: clip(messageOf(err), 200) }),
      }).catch((e) => Promise.reject(toStepError(e))),
    );
  } catch (e) {
    glog(ctx, "inspect", "infra-failure", { error: clip(messageOf(e), 200) });
    return failInfra(ctx, e);
  }
  if (inspection.status === "stale") return { status: "ignored", reason: "stale-head" };

  const ms = Math.max(0, inspection.endedAtMs - inspection.startedAtMs);
  // When the reviewer will run next, its RUNNING rides in this batch (it still precedes the reviewer's result).
  const reviewing = !!inspection.review && !integration;
  await audits(ctx, "audit: policy+security result", [
    ["POLICY", inspection.policy.passed ? "PASSED" : "REJECTED", ledgerFor(ctx, POLICY_MODEL, ms, scanSteps("policy", inspection.policy), inspection.policy.passed)],
    ["SECURITY", inspection.security.passed ? "PASSED" : "REJECTED", ledgerFor(ctx, SECURITY_MODEL, ms, scanSteps("security", inspection.security), inspection.security.passed)],
    ...(reviewing ? [["REVIEWER", "RUNNING", null] as AuditRow] : []),
  ]);

  // 2b. REVIEWER: does the change satisfy the prompt? Only for working code (policy, security, smoke passed).
  // The integration gate (a QUEUE car) has no reviewer: every member was reviewed on its own build.
  let reviewState: "approved" | "skipped" | undefined;
  let counts = { satisfied: 0, missing: 0 };
  if (reviewing && inspection.review) {
    const r = await reviewGate(ctx, inspection.review);
    if (r.infra) return failReviewerInfra(ctx, r.reason);
    if (r.rejected) return failReview(ctx, r.feedback, r.missing, r.report, inspection.changedPaths, inspection);
    reviewState = r.skipped ? "skipped" : "approved";
    counts = r.counts;
  }
  const extras = reportExtras(ctx, inspection, reviewState, counts);
  glog(ctx, "inspect", inspection.policy.passed && inspection.security.passed ? "scanned" : "scan-failed", { ms, followUps: inspection.followUps.length, changedFiles: inspection.changedFiles, ...(integration ? {} : { diffSource: inspection.diffSource, origin: train.origin?.kind ?? "drone" }) });

  const passed = inspection.policy.passed && inspection.security.passed && (inspection.tests?.passed ?? false);
  if (passed) {
    const summary = clip(
      `${integration ? "Integration gate" : "Gate"} passed: policy (${inspection.policy.filesScanned} files), security, tests (${inspection.tests?.checks ?? 0} checks) at ${task.after.slice(0, 12)}.`,
      MAX_SUMMARY_CHARS,
    );
    const verdict = reviewState === "approved" ? `${summary} The reviewer approved the change.` : summary;
    await remember(ctx, "PASSED", verdict, inspection.changedPaths);
    const queenOutcome = await report(ctx, true, summary, extras);
    glog(ctx, "gate", "passed", { ms: Math.max(0, Date.now() - inspection.startedAtMs) });
    return { status: "gated", trainId: train.trainId, passed: true, summary, queenOutcome, lane: train.lane, ...extras, ...(reviewState ? { review: reviewState } : {}) };
  }

  // 3. Failure: the Scribe compacts the raw log; the Queen only ever sees the summary.
  const rawLog = inspection.failureLog ?? "gate failed (no log captured)";
  await audit(ctx, "audit: scribe running", "SCRIBE", "RUNNING", null);
  let scribe: ScribeResult;
  try {
    scribe = await step.do("scribe: summarize", SCRIBE_STEP, () =>
      summarizeFailure({
        log: rawLog,
        ...(inspection.failingCheck ? { failingCheck: inspection.failingCheck } : {}),
        llm: ports.llm,
        model: ctx.config.aiGateway.model,
        metadata: { trainId: train.trainId, promptId: train.promptId, role: "SCRIBE" },
      }).catch((e) => Promise.reject(toStepError(e))),
    );
  } catch (e) {
    console.warn("gatekeeper: scribe LLM failed; using extractive summary", messageOf(e));
    scribe = { summary: extractiveSummary(rawLog, inspection.failingCheck ?? undefined), method: "extractive" };
  }
  let summary = clip(scribe.summary, MAX_SUMMARY_CHARS);
  // The integration gate's Scribe summary must name the failing member's route (the LLM may drop it).
  const route = inspection.failedRoute;
  if (route && !summary.includes(route.path)) {
    const who = route.trainId ? ` (member ${route.title ? `"${route.title}" ` : ""}${route.trainId})` : "";
    summary = clip(`Integration gate: GET ${route.path}${who} failed. ${summary}`, MAX_SUMMARY_CHARS);
  }
  await step.do("scribe: record summary", REPORT_STEP, async () => {
    try {
      await ports.queen(task.hive).recordScribeSummary({ promptId: train.promptId, trainId: train.trainId, summary });
    } catch (e) {
      if (!isPermanentQueenError(e)) throw e;
      console.warn("gatekeeper: Queen rejected the scribe summary", messageOf(e));
    }
    return { recorded: true };
  });
  await audit(ctx, "audit: scribe result", "SCRIBE", "PASSED", ledgerFor(ctx, scribe.model ?? SCRIBE_EXTRACTIVE_MODEL, 0, [`method: ${scribe.method}`, summary], true));

  const vectorized = await vectorize(ctx, rawLog);
  await remember(ctx, "FAILED", summary, inspection.changedPaths);
  const queenOutcome = await report(ctx, false, summary, extras);
  glog(ctx, "gate", "failed", { ms: Math.max(0, Date.now() - inspection.startedAtMs), check: inspection.failingCheck ?? undefined });
  return { status: "gated", trainId: train.trainId, passed: false, summary, queenOutcome, lane: train.lane, ...extras, ...(reviewState ? { review: reviewState } : {}), scribe: scribe.method, vectorized };
}

// ── reviewer ──────────────────────────────────────────────────────────────

type ReviewGate = { rejected: false; infra?: undefined; skipped: boolean; counts: { satisfied: number; missing: number } } | { rejected: true; infra?: undefined; feedback: string; missing: string[]; report: string } | { rejected: false; infra: true; reason: string };

async function reviewGate(ctx: Ctx, packet: ReviewPacket): Promise<ReviewGate> {
  const { config, ports, step, train } = ctx;
  let outcome: ReviewOutcome & { ms: number };
  if (config.reviewMode === "scripted") {
    outcome = { kind: "verdict", verdict: scriptedReview(train.promptFull, packet.rework), model: SCRIPTED_REVIEW_MODEL, ms: 0 };
  } else {
    try {
      outcome = await step.do("review: llm", REVIEW_STEP, async () => {
        const t0 = Date.now();
        const o = await runReview({
          llm: ports.reviewLlm,
          model: config.reviewModel,
          input: packet.text,
          timeoutMs: config.reviewTimeoutMs,
          metadata: { trainId: train.trainId, promptId: train.promptId, role: "REVIEWER" },
        });
        return { ...o, ms: Date.now() - t0 };
      });
    } catch (e) {
      outcome = { kind: "unavailable", reason: clip(messageOf(e), 300), model: config.reviewModel, ms: 0 };
    }
  }

  if (outcome.kind === "unavailable" && ctx.train.origin && ctx.train.origin.kind !== "drone") {
    // Fail closed for pushed (human / agent) code: nobody else has read it. Reported as infra, so the Queen re-gates.
    console.warn("gatekeeper: reviewer unavailable for non-drone origin; failing closed", outcome.reason);
    await audit(ctx, "audit: reviewer result", "REVIEWER", "REJECTED", ledgerFor(ctx, outcome.model, outcome.ms, [`reviewer unavailable, failing closed for ${ctx.train.origin.kind} origin: ${outcome.reason}`], false));
    return { rejected: false, infra: true, reason: outcome.reason };
  }
  if (outcome.kind === "unavailable") {
    // Fail open (drone origin): infrastructure hiccups must not eject trains.
    console.warn("gatekeeper: reviewer unavailable; continuing", outcome.reason);
    await audit(ctx, "audit: reviewer result", "REVIEWER", "PASSED", ledgerFor(ctx, outcome.model, outcome.ms, [`warning: reviewer unavailable, failing open: ${outcome.reason}`], true));
    return { rejected: false, skipped: true, counts: { satisfied: 0, missing: 0 } };
  }

  const v = outcome.verdict;
  const reasoning = [
    `verdict: ${v.verdict}`,
    ...v.satisfied.map((x) => `satisfied: ${x}`),
    ...v.missing.map((x) => `missing: ${x}`),
    `feedback: ${v.feedback}`,
  ];
  if (v.verdict === "APPROVE") {
    await audit(ctx, "audit: reviewer result", "REVIEWER", "PASSED", ledgerFor(ctx, outcome.model, outcome.ms, reasoning, true));
    return { rejected: false, skipped: false, counts: { satisfied: v.satisfied.length, missing: v.missing.length } };
  }
  await audit(ctx, "audit: reviewer result", "REVIEWER", "REJECTED", ledgerFor(ctx, outcome.model, outcome.ms, reasoning, false));
  const report = [`REVIEWER rejected the change: it does not satisfy the prompt.`, `Prompt: ${train.promptFull}`, ...reasoning.slice(1)].join("\n");
  return { rejected: true, feedback: v.feedback, missing: v.missing, report };
}

/** Reviewer unavailable on pushed code: not a verdict. Reported as infra (the Queen re-gates, no attempt charged). */
async function failReviewerInfra(ctx: Ctx, reason: string): Promise<GateRunResult> {
  const summary = clip(`Reviewer unavailable for ${ctx.train.origin?.kind ?? "non-drone"} code, so the gate cannot pass it: ${reason}`, MAX_SUMMARY_CHARS);
  const queenOutcome = await report(ctx, false, summary, { cause: "infra" });
  glog(ctx, "gate", "reviewer-unavailable-infra", {});
  return { status: "gated", trainId: ctx.train.trainId, passed: false, summary, queenOutcome, lane: ctx.train.lane, infra: true };
}

/** The reviewer's feedback is the Scribe summary, so the Queen's REWORK carries it to the next builder. */
async function failReview(ctx: Ctx, feedback: string, missing: string[], rawLog: string, changedPaths: string[], inspection: Extract<Inspection, { status: "done" }>): Promise<GateRunResult> {
  const { task, train, ports } = ctx;
  const summary = clip(feedback, MAX_SUMMARY_CHARS);
  await ctx.step.do("scribe: record summary", REPORT_STEP, async () => {
    try {
      await ports.queen(task.hive).recordScribeSummary({ promptId: train.promptId, trainId: train.trainId, summary });
    } catch (e) {
      if (!isPermanentQueenError(e)) throw e;
      console.warn("gatekeeper: Queen rejected the reviewer summary", messageOf(e));
    }
    return { recorded: true };
  });
  const vectorized = await vectorize(ctx, rawLog);
  await remember(ctx, "REJECTED_BY_REVIEW", missing.length ? `${feedback} Missing: ${missing.join("; ")}` : feedback, changedPaths);
  // No score on a rejection (GateScore.review has no "rejected"); out-of-diff findings are still filed.
  const followUps = inspection.followUps.length ? { followUps: inspection.followUps } : {};
  const queenOutcome = await report(ctx, false, summary, { ...followUps, ...(claimedPaths(ctx, inspection)) });
  glog(ctx, "gate", "rejected-by-review", {});
  return { status: "gated", trainId: train.trainId, passed: false, summary, queenOutcome, lane: train.lane, review: "rejected", vectorized, ...followUps };
}

// ── helpers ───────────────────────────────────────────────────────────────

function scanSteps(label: string, r: ScanReport): string[] {
  if (r.findings.length === 0) return [`${label}: ${r.filesScanned} files scanned, no findings`];
  return [`${label}: ${r.findings.length} finding(s) in ${r.filesScanned} files`, ...r.findings.slice(0, 8).map(formatFinding)];
}

function ledgerFor(ctx: Ctx, model: string, executionTimeMs: number, reasoningSteps: string[], ok: boolean): GitNotesPayload | null {
  try {
    return buildGitNotesPayload({
      taskPrompt: ctx.train.promptText,
      model,
      temperature: 0,
      reasoningSteps,
      result: ok ? "success" : "failure",
      executionTimeMs,
    });
  } catch (e) {
    console.warn("gatekeeper: could not build ledger payload", messageOf(e));
    return null;
  }
}

type AuditRow = [DroneRole, AuditStatus, GitNotesPayload | null];

/** Consecutive audits in one Queen RPC (one step, order kept). */
async function audits(ctx: Ctx, name: string, rows: AuditRow[]): Promise<void> {
  // trainId + commitSha: race siblings of one item (same promptId) keep their own findings (notes, REWORK brief).
  const inputs: AppendAuditInput[] = rows.map(([droneRole, status, gitNotesPayload]) => ({
    promptId: ctx.train.promptId,
    trainId: ctx.train.trainId,
    commitSha: ctx.task.after,
    droneRole,
    status,
    gitNotesPayload,
  }));
  // Auditing never blocks the gate: permanent Queen errors are logged and skipped.
  await ctx.step.do(name, REPORT_STEP, async () => {
    try {
      const evs = await ctx.ports.queen(ctx.task.hive).appendAudits(inputs);
      return { eventIds: evs.map((e) => e.eventId as string) };
    } catch (e) {
      if (!isPermanentQueenError(e)) throw e;
      console.warn(`gatekeeper: audit batch ${name} rejected by the Queen`, messageOf(e));
      return { eventIds: [] as string[] };
    }
  });
}

async function audit(ctx: Ctx, name: string, role: DroneRole, status: AuditStatus, gitNotesPayload: GitNotesPayload | null): Promise<void> {
  await audits(ctx, name, [[role, status, gitNotesPayload]]);
}

/** The v2 fields of `TrainResult`: the gate score, and out-of-diff findings as follow-ups. */
function reportExtras(ctx: Ctx, inspection: Extract<Inspection, { status: "done" }>, reviewState: "approved" | "skipped" | undefined, counts: { satisfied: number; missing: number }): { score: GateScore; followUps?: FollowUp[]; changedPaths?: string[] } {
  const review: GateScore["review"] = ctx.train.lane === "QUEUE" ? "skipped" : ctx.config.reviewMode === "off" ? "off" : (reviewState ?? "skipped");
  return {
    score: { review, satisfied: counts.satisfied, missing: counts.missing, changedFiles: inspection.changedFiles, changedBytes: inspection.changedBytes, checks: inspection.tests?.checks ?? 0 },
    ...(inspection.followUps.length ? { followUps: inspection.followUps } : {}),
    ...(claimedPaths(ctx, inspection)),
  };
}

/** `TrainResult.changedPaths`: BUILD gates with a verified tree diff only (a commit-walk fallback is a heuristic, not a claim). */
function claimedPaths(ctx: Ctx, inspection: Extract<Inspection, { status: "done" }>): { changedPaths?: string[] } {
  return ctx.train.lane === "BUILD" && inspection.diffSource === "tree" && inspection.allChangedPaths.length ? { changedPaths: inspection.allChangedPaths } : {};
}

/** One structured log line per trace: the train's, and for a car each member's (§2.6). Never throws. */
function glog(ctx: Ctx, step: string, outcome: string, extra: Record<string, unknown>): void {
  const { train, task } = ctx;
  const traces = [...new Set([...(train.traceId ? [train.traceId] : []), ...train.memberTraces])];
  const base = { hive: task.hive, step: `gate: ${step}`, outcome, lane: train.lane, train_id: train.trainId, commit_sha: task.after, span_id: spanIdFor(`gate:${train.trainId}:${task.after}`), parent_span_id: spanIdFor(train.trainId), ...extra };
  try {
    for (const trace_id of traces.length ? traces : [null]) ctx.ports.log({ ...base, trace_id });
  } catch {
    /* logging never fails a gate */
  }
}

async function report(ctx: Ctx, passed: boolean, summary: string, extras: { score?: GateScore; followUps?: FollowUp[]; changedPaths?: string[]; cause?: "infra" } = {}): Promise<string> {
  return ctx.step.do("report: train result", REPORT_STEP, async () => {
    try {
      const gateId = ctx.task.commandId ? { gateId: ctx.task.commandId } : {};
      const r = await ctx.ports.queen(ctx.task.hive).reportTrainResult({ trainId: ctx.train.trainId, passed, summary, commitSha: ctx.task.after, ...extras, ...gateId });
      return String(r.outcome);
    } catch (e) {
      if (!isPermanentQueenError(e)) throw e;
      return `rejected: ${clip(messageOf(e), 200)}`;
    }
  });
}

/**
 * The gate itself broke (clone failed after its retries, sandbox not implemented, ...): report it as
 * infrastructure (`cause: "infra"`), never as a verdict on the change. The Queen re-deploys and
 * re-gates (no attempt charged), then opens EXECUTOR_LOST past its cap.
 */
async function failInfra(ctx: Ctx, err: unknown): Promise<GateRunResult> {
  const summary = clip(`Gatekeeper could not inspect the push: ${messageOf(err)}`, MAX_SUMMARY_CHARS);
  const steps = [summary];
  await audits(ctx, "audit: policy+security result", [
    ["POLICY", "REJECTED", ledgerFor(ctx, POLICY_MODEL, 0, steps, false)],
    ["SECURITY", "REJECTED", ledgerFor(ctx, SECURITY_MODEL, 0, steps, false)],
  ]);
  await ctx.step.do("scribe: record summary", REPORT_STEP, async () => {
    try {
      await ctx.ports.queen(ctx.task.hive).recordScribeSummary({ promptId: ctx.train.promptId, trainId: ctx.train.trainId, summary });
    } catch (e) {
      if (!isPermanentQueenError(e)) throw e;
    }
    return { recorded: true };
  });
  const queenOutcome = await report(ctx, false, summary, { cause: "infra" });
  return { status: "gated", trainId: ctx.train.trainId, passed: false, summary, queenOutcome, lane: ctx.train.lane, infra: true };
}

export const CHUNK_CHARS = 1_500;
export const MAX_CHUNKS = 6;

export function chunkLog(log: string, size = CHUNK_CHARS, max = MAX_CHUNKS): string[] {
  const out: string[] = [];
  for (let i = 0; i < log.length && out.length < max; i += size) out.push(log.slice(i, i + size));
  return out;
}

/** Best effort: Vectorize/AI trouble never fails the gate. */
async function vectorize(ctx: Ctx, rawLog: string): Promise<number> {
  const { task, train } = ctx;
  const chunks: FailureChunk[] = chunkLog(rawLog).map((text, i) => ({
    id: `${train.trainId}:${task.after.slice(0, 12)}:${i}`,
    text,
    metadata: { trainId: train.trainId, promptId: train.promptId, namespace: task.hive, kind: "failure-log", commitSha: task.after, chunk: i },
  }));
  try {
    const r = await ctx.step.do("vectorize: store failure log", BEST_EFFORT_STEP, () => ctx.ports.failures.store(chunks));
    return r.stored;
  } catch (e) {
    console.warn("gatekeeper: vectorize failed (ignored)", messageOf(e));
    return 0;
  }
}

/** Best effort: one hive memory per gate verdict. Never fails the gate; never called for infra failures. */
async function remember(ctx: Ctx, outcome: MemoryOutcome, verdict: string, changedPaths: string[]): Promise<void> {
  const { task, train } = ctx;
  // A car's verdict is about a merge of already-remembered members, not a prompt: no memory.
  if (train.lane === "QUEUE") return;
  try {
    await ctx.step.do("memory: remember", BEST_EFFORT_STEP, async () => {
      await ctx.ports.memory.remember({
        memoryId: memoryIdFor(train.trainId, task.after),
        namespace: task.hive,
        trainId: train.trainId,
        promptId: train.promptId,
        commitSha: task.after,
        outcome,
        promptText: train.promptFull.slice(0, 300),
        text: composeMemoryText({
          promptText: train.promptFull,
          outcome,
          verdict,
          reasoning: train.builderReasoning,
          changedFiles: changedPaths.slice(0, 30),
        }),
        createdAt: Date.now(),
      });
      return { remembered: true };
    });
  } catch (e) {
    console.warn("gatekeeper: memory failed (ignored)", messageOf(e));
  }
}

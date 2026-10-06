/**
 * The Herald control flow, written against a minimal StepRunner and the
 * HeraldPorts seam so it can be tested without Workflows, Artifacts, the
 * Queen or the Cloudflare API. HeraldWorkflow.run() is a thin adapter.
 *
 * Contract (packages/queen-types/src/executors.ts): one instance per command
 * (instance id = commandId, params = the DeployCommand). We ALWAYS report a
 * DeployResult back, ok or not.
 *
 * Secrets: the Cloudflare token is fetched from the CredentialsPort inside the
 * step that uses it and is never returned from a step or logged.
 */
import type { WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { CloudflareApiError, type DeploymentVersion } from "@queenos/hive-kit";
import { DeployCommandSchema, isTransientError, retryTransient, type DeployCommand, type DeployResult } from "@queenos/queen-types";
import type { HeraldPorts } from "./ports";
import { SourceError, previewNameFor, readWorkerSource, stagingWorkerNameFor, workerNameFor, type WorkerSource } from "./source";

export interface StepRunner {
  do<T>(name: string, config: WorkflowStepConfig, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

/**
 * Transient errors (Artifacts / Cloudflare API 5xx, 429, network) are retried twice: first inside
 * each try with jitter (withTransientRetry: up to TRANSIENT_ATTEMPTS, so a swarm of deploys does not
 * retry in lockstep), then by Workflows (10 s, 20 s, 40 s). Only then is a failure reported, and a
 * transient one is reported `retryable` (the Queen re-dispatches; never a verdict on the change).
 */
export const REST_STEP: WorkflowStepConfig = { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" };
export const DEPLOY_STEP: WorkflowStepConfig = { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" };
export const TRANSIENT_ATTEMPTS = 3;
export const TRANSIENT_BASE_MS = 2_000;
export const REPORT_STEP: WorkflowStepConfig = { retries: { limit: 5, delay: "2 seconds", backoff: "exponential" }, timeout: "30 seconds" };

const MAX_SUMMARY = 500;
const clip = (s: string, n = MAX_SUMMARY) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const messageOf = (e: unknown) => String((e as Error)?.message ?? e);

export const NOT_IMPLEMENTED = "not implemented (P3)";

export class HeraldFailedError extends Error {
  override readonly name = "HeraldFailedError";
}

/** Errors that will not get better on retry become NonRetryableError inside steps. */
export function toStepError(e: unknown): unknown {
  if (e instanceof NonRetryableError) return e;
  // An HTTP 503 / 429 / 5xx (isomorphic-git "HTTP Error: 503 Service Unavailable", a retryable API error) always retries.
  if (isTransientError(e)) return e;
  const permanent =
    e instanceof SourceError ||
    (e instanceof CloudflareApiError && !e.retryable) ||
    /^(INVALID_INPUT|NOT_FOUND|CONFLICT|UNAVAILABLE): /.test(messageOf(e));
  return permanent ? new NonRetryableError(clip(messageOf(e), 1_000)) : e;
}

/** "source head … is not the requested commit": Artifacts briefly serving a stale head (not the change). */
const STALE_HEAD = /is not the requested commit/;

/** Whether a deploy failure is infrastructure (worth re-dispatching), not the change. */
export function isRetryableFailure(e: unknown): boolean {
  return isTransientError(e) || STALE_HEAD.test(messageOf(e));
}

/** Every step body retries transient errors in place with jittered backoff before Workflows' own retries. */
export function withTransientRetry(step: StepRunner, ports: Pick<HeraldPorts, "sleep">): StepRunner {
  const sleep = ports.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  return {
    do: (name, config, fn) => step.do(name, config, () => retryTransient(fn, { attempts: TRANSIENT_ATTEMPTS, baseMs: TRANSIENT_BASE_MS, maxMs: 8 * TRANSIENT_BASE_MS, sleep })),
    sleep: (name, ms) => step.sleep(name, ms),
  };
}

function isPermanentQueenError(e: unknown): boolean {
  return /^(INVALID_INPUT|NOT_FOUND|CONFLICT): /.test(messageOf(e));
}

export type HeraldRunResult = { commandId: string; op: DeployCommand["op"]; environment: DeployCommand["environment"]; ok: boolean; summary: string; url?: string; queenOutcome: string };

type Outcome = {
  ok: boolean;
  /** ok:false on infrastructure (DeployResult.retryable). */
  retryable?: boolean;
  summary: string;
  url?: string;
  versionId?: string;
  stableVersionId?: string;
  percent?: number;
  commitSha?: string;
};

type DeployCmd = Extract<DeployCommand, { op: "DEPLOY" }>;
type RollbackCmd = Extract<DeployCommand, { op: "ROLLBACK" }>;

export async function runHerald(payload: unknown, step: StepRunner, ports: HeraldPorts): Promise<HeraldRunResult> {
  const parsed = DeployCommandSchema.safeParse(payload);
  if (!parsed.success) {
    // Outside any step, so never retried; there is no commandId to report against.
    throw new HeraldFailedError(`invalid DeployCommand: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  const cmd = parsed.data;
  step = withTransientRetry(step, ports);

  // Log trace context if present
  if (cmd.trace) {
    const traceparentParts = cmd.trace.traceparent.split("-");
    console.log(
      JSON.stringify({
        trace_id: traceparentParts[1],
        span_id: traceparentParts[2],
        hive: cmd.hive,
        command_id: cmd.commandId,
        step: "herald_start",
        op: cmd.op,
        environment: cmd.environment,
      })
    );
  }

  let outcome: Outcome;
  if (cmd.op === "DEPLOY" && cmd.environment === "preview") {
    outcome = await deployPreview(cmd, step, ports);
  } else if (cmd.op === "DEPLOY" && cmd.environment === "staging") {
    outcome = await deployStaging(cmd, step, ports);
  } else if (cmd.op === "DEPLOY" && cmd.environment === "canary") {
    outcome = await deployCanary(cmd, step, ports);
  } else if (cmd.op === "ROLLBACK" && cmd.environment === "canary") {
    outcome = await rollbackCanary(cmd, step, ports);
  } else if (cmd.op === "TEARDOWN" && cmd.environment === "preview") {
    outcome = await teardownPreview(cmd, step, ports);
  } else {
    outcome = { ok: false, summary: NOT_IMPLEMENTED };
  }

  const result: DeployResult = {
    commandId: cmd.commandId,
    op: cmd.op,
    environment: cmd.environment,
    ...(cmd.op !== "ROLLBACK" && cmd.trainId ? { trainId: cmd.trainId } : {}),
    ok: outcome.ok,
    ...(!outcome.ok && outcome.retryable ? { retryable: true } : {}),
    ...(outcome.url ? { url: outcome.url } : {}),
    ...(outcome.versionId ? { versionId: outcome.versionId } : {}),
    ...(outcome.stableVersionId ? { stableVersionId: outcome.stableVersionId } : {}),
    ...(cmd.op === "DEPLOY" && cmd.releaseId ? { releaseId: cmd.releaseId } : {}),
    ...(outcome.percent !== undefined ? { percent: outcome.percent } : {}),
    ...(outcome.commitSha ? { commitSha: outcome.commitSha } : {}),
    summary: clip(outcome.summary),
  };

  const queenOutcome = await step.do("report: deploy result", REPORT_STEP, async () => {
    try {
      const r = (await ports.queen(cmd.hive).reportDeployResult(result)) as { outcome?: unknown } | null | undefined;
      return String(r?.outcome ?? "reported");
    } catch (e) {
      if (!isPermanentQueenError(e)) throw e;
      return `rejected: ${clip(messageOf(e), 200)}`;
    }
  });

  // Log trace context for result if present
  if (cmd.trace) {
    const traceparentParts = cmd.trace.traceparent.split("-");
    console.log(
      JSON.stringify({
        trace_id: traceparentParts[1],
        span_id: traceparentParts[2],
        hive: cmd.hive,
        command_id: cmd.commandId,
        step: "herald_result",
        op: cmd.op,
        outcome: outcome.ok ? "ok" : "fail",
        ms: 0, // timing collected by Workflows
      })
    );
  }

  return {
    commandId: cmd.commandId,
    op: cmd.op,
    environment: cmd.environment,
    ok: outcome.ok,
    summary: result.summary ?? "",
    ...(outcome.url ? { url: outcome.url } : {}),
    queenOutcome,
  };
}

// ── preview DEPLOY ─────────────────────────────────────────────────────────

async function deployPreview(cmd: DeployCmd, step: StepRunner, ports: HeraldPorts): Promise<Outcome> {
  if (!cmd.trainId) return { ok: false, summary: "a preview deploy needs a trainId" };
  const trainId = cmd.trainId;
  const worker = workerNameFor(cmd.hive);
  const preview = previewNameFor(trainId);

  try {
    // 1. The parent Worker (`<hive>-app`) must exist before it can have Previews.
    await step.do("ensure parent worker", REST_STEP, async () => {
      try {
        const creds = await ports.credentials.cloudflare(cmd.hive, `herald ${cmd.op} ${cmd.commandId}`);
        const r = await ports.cloudflare(creds).ensureWorker(worker);
        return { created: r.created };
      } catch (e) {
        throw toStepError(e);
      }
    });

    // 2. Clone, read the modules, create/update the Preview. One step: the
    // in-memory clone cannot cross steps, and only small values come back out.
    const deployed = await step.do("read source, deploy preview", DEPLOY_STEP, async () => {
      try {
        const access = await ports.artifacts.access(cmd.artifactRepo, "read");
        const repo = await ports.git.clone({ remote: access.remote, token: access.token, depth: 1 });
        const head = await repo.head();
        if (head?.oid !== cmd.commitSha) {
          // Retryable: Artifacts may briefly serve a stale head.
          throw new Error(`source head ${head?.oid.slice(0, 12) ?? "(none)"} is not the requested commit ${cmd.commitSha.slice(0, 12)}`);
        }
        const source = await readWorkerSource(repo);

        const creds = await ports.credentials.cloudflare(cmd.hive, `herald ${cmd.op} ${cmd.commandId}`);
        const cf = ports.cloudflare(creds);
        const existing = await cf.getPreview(worker, preview);
        const info = existing ?? (await cf.createPreview(worker, preview));
        const dep = await cf.deployPreview(worker, info.id, {
          mainModule: source.mainModule,
          modules: source.modules,
          compatibilityDate: source.compatibilityDate,
          annotations: { "workers/commit_sha": cmd.commitSha, "workers/message": `QueenOS train ${trainId}` },
        });
        // Report the Preview's own alias URL (`t-<id>-<worker>.<sub>.workers.dev`), NOT the
        // deployment-pinned one (`<8 hex>-<worker>…`): the alias follows the newest deployment
        // and stops resolving ~5 s after the Preview is deleted, so TEARDOWN really takes the
        // site down. Pinned deployment URLs keep serving until the whole Worker is deleted and
        // no API removes them (see teardownPreview).
        const url = info.urls[0] ?? dep.urls[0] ?? null;
        return { url, versionId: dep.id, created: !existing, modules: source.modules.length, bytes: source.totalBytes };
      } catch (e) {
        throw toStepError(e);
      }
    });

    if (!deployed.url) return { ok: false, summary: clip(`Preview ${preview} deployed (${deployed.versionId}) but Cloudflare returned no URL (is workers.dev previews enabled for ${worker}?)`) };
    return {
      ok: true,
      url: deployed.url,
      versionId: deployed.versionId,
      commitSha: cmd.commitSha,
      summary: `${deployed.created ? "Created" : "Updated"} Worker Preview ${preview} on ${worker}: ${deployed.modules} modules, ${deployed.bytes} bytes, commit ${cmd.commitSha.slice(0, 12)}.`,
    };
  } catch (e) {
    return { ok: false, summary: clip(`Preview deploy failed: ${messageOf(e)}`), ...(isRetryableFailure(e) ? { retryable: true } : {}) };
  }
}

// ── shared: source + staging / canary ─────────────────────────────────────

/** Clone the repo at the commit and read the no-build Worker source (same reader as previews). */
async function readSourceAt(cmd: DeployCmd, ports: HeraldPorts): Promise<WorkerSource> {
  const access = await ports.artifacts.access(cmd.artifactRepo, "read");
  const repo = await ports.git.clone({ remote: access.remote, token: access.token, depth: 1 });
  const head = await repo.head();
  if (head?.oid !== cmd.commitSha) {
    // Retryable: Artifacts may briefly serve a stale head.
    throw new Error(`source head ${head?.oid.slice(0, 12) ?? "(none)"} is not the requested commit ${cmd.commitSha.slice(0, 12)}`);
  }
  return readWorkerSource(repo);
}

const annotationsFor = (cmd: DeployCmd) => ({
  "workers/commit_sha": cmd.commitSha,
  "workers/message": clip(cmd.releaseId ? `QueenOS release ${cmd.releaseId}` : `QueenOS ${cmd.environment} deploy`, 100),
});

/** Run one Cloudflare REST step: credential fetched inside, errors classified for retry. */
function cfStep<T>(step: StepRunner, name: string, config: WorkflowStepConfig, cmd: DeployCommand, ports: HeraldPorts, fn: (cf: ReturnType<HeraldPorts["cloudflare"]>) => Promise<T>): Promise<T> {
  return step.do(name, config, async () => {
    try {
      const creds = await ports.credentials.cloudflare(cmd.hive, `herald ${cmd.op} ${cmd.commandId}`);
      return await fn(ports.cloudflare(creds));
    } catch (e) {
      throw toStepError(e);
    }
  });
}

/** Staging: `<hive>-staging`, always 100% of the newest candidate. */
async function deployStaging(cmd: DeployCmd, step: StepRunner, ports: HeraldPorts): Promise<Outcome> {
  const script = stagingWorkerNameFor(cmd.hive);
  try {
    await cfStep(step, "ensure staging worker", REST_STEP, cmd, ports, async (cf) => {
      const r = await cf.ensureWorker(script);
      await cf.enableSubdomain(script);
      return { created: r.created };
    });

    const deployed = await step.do("read source, upload, deploy staging", DEPLOY_STEP, async () => {
      try {
        const source = await readSourceAt(cmd, ports);
        const creds = await ports.credentials.cloudflare(cmd.hive, `herald ${cmd.op} ${cmd.commandId}`);
        const cf = ports.cloudflare(creds);
        const { versionId } = await cf.uploadVersion(script, { mainModule: source.mainModule, modules: source.modules, compatibilityDate: source.compatibilityDate, annotations: annotationsFor(cmd) });
        await cf.createDeployment(script, [{ versionId, percentage: 100 }]);
        const url = await cf.workerUrl(script);
        return { url, versionId, modules: source.modules.length, bytes: source.totalBytes };
      } catch (e) {
        throw toStepError(e);
      }
    });

    return {
      ok: true,
      url: deployed.url,
      versionId: deployed.versionId,
      percent: 100,
      commitSha: cmd.commitSha,
      summary: `Deployed ${script} at 100%: version ${deployed.versionId}, ${deployed.modules} modules, ${deployed.bytes} bytes, commit ${cmd.commitSha.slice(0, 12)}.`,
    };
  } catch (e) {
    // The repo head moved past this commit (and stayed there through the step's retries):
    // a newer release owns staging, so never overwrite it with older code.
    if (/is not the requested commit/.test(messageOf(e))) return { ok: false, summary: "superseded" };
    return { ok: false, summary: clip(`Staging deploy failed: ${messageOf(e)}`), ...(isTransientError(e) ? { retryable: true } : {}) };
  }
}

/** The version holding 100% (else the largest share) of a deployment: the stable one. */
function stableOf(versions: DeploymentVersion[]): string | null {
  return [...versions].sort((a, b) => b.percentage - a.percentage)[0]?.versionId ?? null;
}

/** Canary on `<hive>-app`: first step uploads the candidate, later steps only move the split. */
async function deployCanary(cmd: DeployCmd, step: StepRunner, ports: HeraldPorts): Promise<Outcome> {
  const script = workerNameFor(cmd.hive);
  const percent = cmd.percent ?? 100;
  try {
    await cfStep(step, "ensure app worker", REST_STEP, cmd, ports, async (cf) => {
      const r = await cf.ensureWorker(script);
      await cf.enableSubdomain(script); // prod traffic is served on workers.dev
      return { created: r.created };
    });

    let candidate = cmd.versionId;
    let stable = cmd.stableVersionId;
    if (!candidate) {
      // First step. Upload, then read the live deployment BEFORE deploying anything:
      // that is the stable version (none on a hive's first prod deploy).
      const uploaded = await step.do("read source, upload candidate", DEPLOY_STEP, async () => {
        try {
          const source = await readSourceAt(cmd, ports);
          const creds = await ports.credentials.cloudflare(cmd.hive, `herald ${cmd.op} ${cmd.commandId}`);
          const cf = ports.cloudflare(creds);
          const { versionId } = await cf.uploadVersion(script, { mainModule: source.mainModule, modules: source.modules, compatibilityDate: source.compatibilityDate, annotations: annotationsFor(cmd) });
          const current = await cf.getCurrentDeployment(script);
          const stableVersionId = current ? stableOf(current.versions.filter((v) => v.versionId !== versionId)) : null;
          return { versionId, stableVersionId, modules: source.modules.length, bytes: source.totalBytes };
        } catch (e) {
          throw toStepError(e);
        }
      });
      candidate = uploaded.versionId;
      stable = uploaded.stableVersionId ?? undefined;
    }
    const candidateId = candidate;

    // With no stable version there is nothing to split against: candidate takes 100%.
    const effective = stable && stable !== candidateId ? percent : 100;
    const versions: DeploymentVersion[] =
      stable && effective < 100 ? [{ versionId: candidateId, percentage: effective }, { versionId: stable, percentage: 100 - effective }] : [{ versionId: candidateId, percentage: 100 }];

    const url = await cfStep(step, "deploy canary split", REST_STEP, cmd, ports, async (cf) => {
      await cf.createDeployment(script, versions, { annotations: { "workers/message": clip(`QueenOS canary ${effective}%`, 100) } });
      return cf.workerUrl(script);
    });

    const split = versions.map((v) => `${v.versionId} ${v.percentage}%`).join(", ");
    return {
      ok: true,
      url,
      versionId: candidateId,
      ...(stable ? { stableVersionId: stable } : {}),
      percent: effective,
      commitSha: cmd.commitSha,
      summary: `Deployed ${script}: ${split}${stable ? "" : " (first prod deploy, no stable version)"}.`,
    };
  } catch (e) {
    return { ok: false, summary: clip(`Canary deploy failed: ${messageOf(e)}`), ...(isRetryableFailure(e) ? { retryable: true } : {}) };
  }
}

/** Rollback: the target version alone at 100%, forced when secrets differ. */
async function rollbackCanary(cmd: RollbackCmd, step: StepRunner, ports: HeraldPorts): Promise<Outcome> {
  const script = workerNameFor(cmd.hive);
  try {
    const r = await cfStep(step, "rollback deployment", REST_STEP, cmd, ports, async (cf) => {
      const versions = [{ versionId: cmd.toVersionId, percentage: 100 }];
      const annotations = { "workers/message": clip(`QueenOS rollback to ${cmd.toVersionId}`, 100) };
      let forced = false;
      try {
        await cf.createDeployment(script, versions, { annotations });
      } catch (e) {
        if (!(e instanceof CloudflareApiError && e.secretsMismatch)) throw e;
        forced = true;
        await cf.createDeployment(script, versions, { annotations, force: true });
      }
      return { url: await cf.workerUrl(script), forced };
    });
    return { ok: true, url: r.url, versionId: cmd.toVersionId, percent: 100, summary: `Rolled ${script} back to ${cmd.toVersionId} at 100%${r.forced ? " (forced: secrets differ)" : ""}.` };
  } catch (e) {
    return { ok: false, summary: clip(`Rollback failed: ${messageOf(e)}`) };
  }
}

// ── preview TEARDOWN ───────────────────────────────────────────────────────

/**
 * Verified on the real API (scratchpad run against Worker `queenos-day1-canary`): `DELETE …/previews/{name}`
 * removes the alias URL within ~5 s, but each deployment's pinned URL
 * (`https://<deployment-id-8>-<worker>.<sub>.workers.dev`) keeps returning 200 until the parent
 * Worker is deleted. Nothing removes it: DELETE of a preview's active deployment is refused
 * (10339 "Actively deployed versions cannot be deleted"), deleting a superseded deployment (200)
 * does not stop its URL, and the preview-less version is 404 in the API yet still served. So we
 * never hand out pinned URLs (deployPreview reports the alias); a leaked pinned URL stays live
 * until its Worker is deleted. We must not delete `<hive>-app` (it is prod).
 */
async function teardownPreview(cmd: Extract<DeployCommand, { op: "TEARDOWN" }>, step: StepRunner, ports: HeraldPorts): Promise<Outcome> {
  if (!cmd.trainId) return { ok: false, summary: "a preview teardown needs a trainId" };
  const worker = workerNameFor(cmd.hive);
  const preview = previewNameFor(cmd.trainId);
  try {
    const existed = await step.do("delete preview", REST_STEP, async () => {
      try {
        const creds = await ports.credentials.cloudflare(cmd.hive, `herald ${cmd.op} ${cmd.commandId}`);
        return await ports.cloudflare(creds).deletePreview(worker, preview);
      } catch (e) {
        throw toStepError(e);
      }
    });
    return { ok: true, summary: existed ? `Deleted Worker Preview ${preview} on ${worker}.` : `Worker Preview ${preview} was already gone.` };
  } catch (e) {
    return { ok: false, summary: clip(`Preview teardown failed: ${messageOf(e)}`) };
  }
}

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
import { CloudflareApiError } from "@queenos/hive-kit";
import { DeployCommandSchema, type DeployCommand, type DeployResult } from "@queenos/queen-types";
import type { HeraldPorts } from "./ports";
import { SourceError, previewNameFor, readWorkerSource, workerNameFor } from "./source";

export interface StepRunner {
  do<T>(name: string, config: WorkflowStepConfig, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

export const REST_STEP: WorkflowStepConfig = { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "2 minutes" };
export const DEPLOY_STEP: WorkflowStepConfig = { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" };
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
  const permanent =
    e instanceof SourceError ||
    (e instanceof CloudflareApiError && !e.retryable) ||
    /^(INVALID_INPUT|NOT_FOUND|CONFLICT|UNAVAILABLE): /.test(messageOf(e));
  return permanent ? new NonRetryableError(clip(messageOf(e), 1_000)) : e;
}

function isPermanentQueenError(e: unknown): boolean {
  return /^(INVALID_INPUT|NOT_FOUND|CONFLICT): /.test(messageOf(e));
}

export type HeraldRunResult = { commandId: string; op: DeployCommand["op"]; environment: DeployCommand["environment"]; ok: boolean; summary: string; url?: string; queenOutcome: string };

type Outcome = { ok: boolean; summary: string; url?: string; versionId?: string; commitSha?: string };

export async function runHerald(payload: unknown, step: StepRunner, ports: HeraldPorts): Promise<HeraldRunResult> {
  const parsed = DeployCommandSchema.safeParse(payload);
  if (!parsed.success) {
    // Outside any step, so never retried; there is no commandId to report against.
    throw new HeraldFailedError(`invalid DeployCommand: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  const cmd = parsed.data;

  let outcome: Outcome;
  if (cmd.environment !== "preview" || cmd.op === "ROLLBACK") {
    outcome = { ok: false, summary: NOT_IMPLEMENTED };
  } else if (cmd.op === "DEPLOY") {
    outcome = await deployPreview(cmd, step, ports);
  } else {
    outcome = await teardownPreview(cmd, step, ports);
  }

  const result: DeployResult = {
    commandId: cmd.commandId,
    op: cmd.op,
    environment: cmd.environment,
    ...(cmd.op !== "ROLLBACK" && cmd.trainId ? { trainId: cmd.trainId } : {}),
    ok: outcome.ok,
    ...(outcome.url ? { url: outcome.url } : {}),
    ...(outcome.versionId ? { versionId: outcome.versionId } : {}),
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

async function deployPreview(cmd: Extract<DeployCommand, { op: "DEPLOY" }>, step: StepRunner, ports: HeraldPorts): Promise<Outcome> {
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
        const url = dep.urls[0] ?? info.urls[0] ?? null;
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
    return { ok: false, summary: clip(`Preview deploy failed: ${messageOf(e)}`) };
  }
}

// ── preview TEARDOWN ───────────────────────────────────────────────────────

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

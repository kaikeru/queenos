/**
 * Simulation ports for local demos: no Artifacts, LLM or Cloudflare credentials.
 *
 * SimExecutors stands in for every executor Workflow the Queen dispatches to,
 * and calls back into the Queen over its public RPC surface exactly like the
 * real executors would:
 * - provisioner: FORK reports ok after ~300 ms (DELETE shortly after).
 * - herald: DEPLOY reports a LIVE preview at `https://<trainId>-preview.sim.queenos.dev`
 *   after ~1.5 s; TEARDOWN reports ok and is recorded (see teardowns()).
 * - drones: scripted builder / gatekeeper / lander behaviour (build-result,
 *   audit events, train-result, land-result).
 *
 * Scheduling uses Durable Object alarms, not setTimeout: the jobs live in DO
 * storage, so they survive hibernation and eviction, and the DO is woken by
 * the alarm. (A setTimeout inside ctx.waitUntil would be lost whenever the DO
 * hibernates or is evicted mid-demo.) Because the Queen's own `alarm()` is
 * also the reconcile hook, the sim subclass runs due jobs and then calls
 * super.alarm(). Like Workflow instance ids, a job id (command id, or
 * `<trainId>-<action>` for drones) runs at most once, so reconcile's
 * re-dispatches are no-ops.
 *
 * Deterministic outcomes: a prompt containing "[fail]" fails its first build
 * test (SECURITY rejects it); the REWORK attempt passes.
 *
 * Nothing in production code imports this file; only src/sim/worker.ts does.
 */
import type {
  AppendAuditInput,
  AuditEvent,
  BuildResult,
  DeployCommand,
  DeployResult,
  DroneRole,
  DroneTask,
  GitNotesPayload,
  LandResultInput,
  MergeTrain,
  ProvisionCommand,
  ProvisionResult,
  TrainResult,
} from "@queenos/queen-types";
import type { DroneDispatcher } from "../drones";
import { droneInstanceId } from "../drones";
import type { DeployDispatcher, ProvisionerDispatcher } from "../executors";

/** The slice of QueenNode the simulated executors call (its public RPC surface). */
export interface SimQueen {
  appendAudit(a: AppendAuditInput): Promise<AuditEvent>;
  reportBuildResult(r: BuildResult): Promise<{ outcome: string }>;
  reportTrainResult(r: TrainResult): Promise<{ outcome: string }>;
  reportLandResult(r: LandResultInput): Promise<{ outcome: string }>;
  reportProvisionResult(r: ProvisionResult): Promise<{ outcome: string }>;
  reportDeployResult(r: DeployResult): Promise<{ outcome: string }>;
  getSnapshot(): { trains: MergeTrain[] } | Promise<{ trains: MergeTrain[] }>;
}

/** The slice of DurableObjectStorage the scheduler needs (KV + alarm). */
export interface SimStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

export interface SimDelays {
  fork: number;
  delete: number;
  deploy: number;
  teardown: number;
  build: number;
  test: number;
  land: number;
}

export const DEFAULT_SIM_DELAYS: SimDelays = {
  fork: 300,
  delete: 200,
  deploy: 1500,
  teardown: 400,
  build: 3500,
  test: 3000,
  land: 2000,
};

export const FAIL_MARKER = "[fail]";
/** The sim gatekeeper waits for TESTING (the preview going LIVE) this often, this many times. */
export const TEST_RETRY_MS = 500;
export const TEST_MAX_TRIES = 40;

type DroneJob = { id: string; kind: "build" | "test" | "land"; due: number; task: DroneTask; tries?: number };
type ProvisionJob = { id: string; kind: "provision"; due: number; command: ProvisionCommand };
type DeployJob = { id: string; kind: "deploy"; due: number; command: DeployCommand };
type Job = DroneJob | ProvisionJob | DeployJob;

const JOBS_KEY = "sim:jobs";
const DONE_KEY = "sim:done";
const TEARDOWNS_KEY = "sim:teardowns";
const DONE_LIMIT = 2000;
const MODEL = "claude-opus-5-5";

/** Small deterministic string hash, rendered as a 40-char hex "git SHA". */
export function fakeSha(seed: string): string {
  let out = "";
  for (let round = 0; out.length < 40; round++) {
    let h = 0x811c9dc5 ^ (round * 0x9e3779b1);
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
}

export function simPreviewUrl(trainId: string): string {
  return `https://${trainId}-preview.sim.queenos.dev`;
}

export class SimExecutors {
  readonly drones: DroneDispatcher = { dispatch: (task) => this.dispatchDrone(task) };
  readonly provisioner: ProvisionerDispatcher = {
    dispatch: (command) =>
      this.enqueue({ id: command.commandId, kind: "provision", due: this.now() + (command.op === "FORK" ? this.delays.fork : this.delays.delete), command }),
  };
  readonly herald: DeployDispatcher = {
    dispatch: (command) =>
      this.enqueue({ id: command.commandId, kind: "deploy", due: this.now() + (command.op === "DEPLOY" ? this.delays.deploy : this.delays.teardown), command }),
  };

  constructor(
    private readonly queen: () => SimQueen,
    private readonly store: SimStore,
    private readonly delays: SimDelays = DEFAULT_SIM_DELAYS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Train ids whose preview the sim Herald tore down, in order. */
  async teardowns(): Promise<string[]> {
    return (await this.store.get<string[]>(TEARDOWNS_KEY)) ?? [];
  }

  /** Run every job that is due, then re-arm the alarm for the next one. Call from alarm(). */
  async runDue(): Promise<number> {
    const jobs = (await this.store.get<Job[]>(JOBS_KEY)) ?? [];
    const t = this.now();
    const due = jobs.filter((j) => j.due <= t);
    // Remove first and mark done: running a job re-enters dispatch (directly or via
    // reconcile), which must see the job as already taken.
    await this.store.put(
      JOBS_KEY,
      jobs.filter((j) => j.due > t),
    );
    await this.markDone(due.map((j) => j.id));
    for (const job of due) {
      try {
        await this.run(job);
      } catch (e) {
        console.error(`sim: job ${job.id} failed`, e);
      }
    }
    const rest = (await this.store.get<Job[]>(JOBS_KEY)) ?? [];
    if (rest.length) await this.arm(Math.min(...rest.map((j) => j.due)));
    return due.length;
  }

  // ── dispatch ──────────────────────────────────────────────────────────

  private async dispatchDrone(task: DroneTask): Promise<{ instanceId: string }> {
    const id = droneInstanceId(task);
    const kind = task.action === "LAND" ? "land" : "build";
    if (!(await this.add({ id, kind, due: this.now() + this.delays[kind], task }))) return { instanceId: id };
    // The drone "starts": its first card pulses yellow immediately.
    if (kind === "build") await this.audit(task, "BUILDER", "RUNNING", null);
    else await this.audit(task, "LANDER", "RUNNING", null);
    return { instanceId: id };
  }

  private async enqueue(job: Job): Promise<{ instanceId: string }> {
    await this.add(job);
    return { instanceId: job.id };
  }

  /** Add a job unless its id is queued or already ran (Workflow instance-id semantics). */
  private async add(job: Job): Promise<boolean> {
    const jobs = (await this.store.get<Job[]>(JOBS_KEY)) ?? [];
    const done = (await this.store.get<string[]>(DONE_KEY)) ?? [];
    if (jobs.some((j) => j.id === job.id) || done.includes(job.id)) return false;
    await this.store.put(JOBS_KEY, [...jobs, job]);
    await this.arm(job.due);
    return true;
  }

  private async markDone(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const done = (await this.store.get<string[]>(DONE_KEY)) ?? [];
    await this.store.put(DONE_KEY, [...done, ...ids].slice(-DONE_LIMIT));
  }

  // ── scripted executor behaviour ───────────────────────────────────────

  private async run(job: Job): Promise<void> {
    switch (job.kind) {
      case "provision":
        return this.runProvision(job.command);
      case "deploy":
        return this.runDeploy(job.command);
      default:
        return this.runDrone(job);
    }
  }

  private async runProvision(c: ProvisionCommand): Promise<void> {
    if (c.op === "FORK") {
      await this.queen().reportProvisionResult({
        commandId: c.commandId,
        op: "FORK",
        trainId: c.trainId,
        ok: true,
        artifactRepo: c.forkName,
        baseSha: fakeSha(`base:${c.sourceRepo}`),
      });
    } else {
      await this.queen().reportProvisionResult({ commandId: c.commandId, op: "DELETE", trainId: c.trainId, ok: true });
    }
  }

  private async runDeploy(c: DeployCommand): Promise<void> {
    switch (c.op) {
      case "DEPLOY":
        await this.queen().reportDeployResult({
          commandId: c.commandId,
          op: "DEPLOY",
          environment: c.environment,
          trainId: c.trainId,
          ok: true,
          url: simPreviewUrl(c.trainId ?? c.environment),
          versionId: `sim-${fakeSha(c.commandId).slice(0, 12)}`,
          commitSha: c.commitSha,
          summary: "Sim Herald deployed the train head to a Worker Preview.",
        });
        return;
      case "TEARDOWN": {
        const torn = await this.teardowns();
        await this.store.put(TEARDOWNS_KEY, [...torn, c.trainId ?? c.environment].slice(-DONE_LIMIT));
        await this.queen().reportDeployResult({
          commandId: c.commandId,
          op: "TEARDOWN",
          environment: c.environment,
          trainId: c.trainId,
          ok: true,
        });
        return;
      }
      case "ROLLBACK":
        await this.queen().reportDeployResult({ commandId: c.commandId, op: "ROLLBACK", environment: c.environment, ok: true });
        return;
    }
  }

  private async trainPhase(trainId: string): Promise<MergeTrain | undefined> {
    const snap = await this.queen().getSnapshot();
    return snap.trains.find((t) => t.trainId === trainId);
  }

  private async runDrone(job: DroneJob): Promise<void> {
    const task = job.task;
    switch (job.kind) {
      case "build": {
        const headSha = fakeSha(`head:${task.trainId}`);
        const res = await this.queen().reportBuildResult({ trainId: task.trainId, headSha });
        if (res.outcome !== "applied") {
          // Superseded while building: close the pulsing card instead of leaving it yellow.
          await this.audit(task, "BUILDER", "REJECTED", {
            ...builderNote(task, headSha),
            result: "failure",
            reasoningSteps: ["Train was superseded by an upstream ejection; abandoned this build."],
          });
          return;
        }
        await this.audit(task, "BUILDER", "PASSED", builderNote(task, headSha));
        await this.audit(task, "POLICY", "RUNNING", null);
        await this.audit(task, "SECURITY", "RUNNING", null);
        await this.audit(task, "GATEKEEPER", "RUNNING", null);
        await this.schedule({ id: `${task.trainId}-test`, kind: "test", due: this.now() + this.delays.test, task });
        return;
      }
      case "test": {
        // Like the real gatekeepers: wait for the Herald's preview (TESTING) first.
        const train = await this.trainPhase(task.trainId);
        const tries = job.tries ?? 0;
        if ((train?.phase === "DEPLOYING" || train?.phase === "BUILDING") && tries < TEST_MAX_TRIES) {
          await this.schedule({ ...job, due: this.now() + TEST_RETRY_MS, tries: tries + 1 });
          return;
        }
        const shouldFail = task.promptText.includes(FAIL_MARKER) && task.action === "BUILD";
        const url = train?.previewUrl ?? simPreviewUrl(task.trainId);
        await this.audit(task, "GATEKEEPER", "PASSED", smokeNote(task, url));
        await this.audit(task, "POLICY", "PASSED", reviewNote(task, "policy", true));
        await this.audit(task, "SECURITY", shouldFail ? "REJECTED" : "PASSED", reviewNote(task, "security", !shouldFail));
        const summary = shouldFail
          ? "Security scan rejected the change: an unbounded retry loop swallows errors. Rework should add a retry cap and surface the failure."
          : "Policy and security checks passed and the preview answered its smoke test; the change is scoped to the requested module with tests.";
        await this.audit(task, "SCRIBE", "PASSED", scribeNote(task, summary));
        await this.queen().reportTrainResult({
          trainId: task.trainId,
          passed: !shouldFail,
          summary,
          commitSha: fakeSha(`head:${task.trainId}`),
        });
        return;
      }
      case "land": {
        const res = await this.queen().reportLandResult({
          trainId: task.trainId,
          landed: true,
          mainSha: fakeSha(`main:${task.baseRef}`),
          summary: "Landed on main via fast-forward push.",
        });
        const ok = res.outcome === "applied";
        await this.audit(task, "LANDER", ok ? "PASSED" : "REJECTED", landerNote(task, ok));
        return;
      }
    }
  }

  /** Queue or replace a follow-up job (same id). */
  private async schedule(job: Job): Promise<void> {
    const jobs = (await this.store.get<Job[]>(JOBS_KEY)) ?? [];
    await this.store.put(JOBS_KEY, [...jobs.filter((j) => j.id !== job.id), job]);
    await this.arm(job.due);
  }

  /** Move the alarm earlier if needed (never later than an already-pending one). */
  private async arm(due: number): Promise<void> {
    const current = await this.store.getAlarm();
    if (current === null || due < current) await this.store.setAlarm(Math.max(due, this.now() + 1));
  }

  private audit(task: DroneTask, role: DroneRole, status: AppendAuditInput["status"], note: GitNotesPayload | null) {
    return this.queen().appendAudit({ promptId: task.promptId, droneRole: role, status, gitNotesPayload: note });
  }
}

// ── plausible Cognitive Ledger payloads ──────────────────────────────────

const subject = (task: DroneTask) => task.promptText.replace(FAIL_MARKER, "").trim().slice(0, 80);

function builderNote(task: DroneTask, headSha: string): GitNotesPayload {
  const rework = task.action === "REWORK";
  return {
    taskPrompt: task.promptText,
    model: MODEL,
    temperature: 0.2,
    reasoningSteps: [
      `Parsed the request: "${subject(task)}".`,
      ...(rework && task.scribeSummary ? [`Read Scribe's note on the failed attempt: ${task.scribeSummary}`] : []),
      "Searched the repo for the module boundary and existing conventions.",
      "Drafted the smallest change that satisfies the request and added a focused test.",
      `Committed and pushed ${headSha.slice(0, 7)} to ${task.artifactRepo}.`,
    ],
    result: "success",
    executionTimeMs: 2600 + (task.promptText.length % 7) * 150,
    discardedPaths: [
      "Rewrite the whole module (rejected: widens the blast radius).",
      "Add a new dependency (rejected: policy prefers the standard library).",
    ],
  };
}

function reviewNote(task: DroneTask, kind: "policy" | "security", ok: boolean): GitNotesPayload {
  const failing = !ok;
  return {
    taskPrompt: task.promptText,
    model: MODEL,
    temperature: 0,
    reasoningSteps:
      kind === "policy"
        ? ["Checked the diff touches only paths allowed by the hive policy.", "Verified commit message and test coverage rules."]
        : failing
          ? [
              "Scanned the diff for secrets, injection and unbounded loops.",
              "Found a retry loop with no cap that swallows errors.",
              "Rejected the train; flagged for REWORK.",
            ]
          : ["Scanned the diff for secrets, injection and unbounded loops.", "No findings."],
    result: ok ? "success" : "failure",
    executionTimeMs: 900 + (task.promptText.length % 5) * 120,
    discardedPaths: failing ? ["Waive the finding (rejected: no policy exception exists)."] : [],
  };
}

function smokeNote(task: DroneTask, url: string): GitNotesPayload {
  return {
    taskPrompt: task.promptText,
    model: MODEL,
    temperature: 0,
    reasoningSteps: [`Smoke-tested the train's Worker Preview: GET ${url}/ -> 200.`, "Preview serves the train head; no 5xx in the sampled requests."],
    result: "success",
    executionTimeMs: 350,
    discardedPaths: [],
  };
}

function scribeNote(task: DroneTask, summary: string): GitNotesPayload {
  return {
    taskPrompt: task.promptText,
    model: MODEL,
    temperature: 0.1,
    reasoningSteps: [summary],
    result: summary.startsWith("Security scan rejected") ? "failure" : "success",
    executionTimeMs: 400,
    discardedPaths: ["Raw build and scan logs (compacted away; the Queen only keeps summaries)."],
  };
}

function landerNote(task: DroneTask, ok: boolean): GitNotesPayload {
  return {
    taskPrompt: task.promptText,
    model: MODEL,
    temperature: 0,
    reasoningSteps: ["Confirmed the train head is the head of the queue.", ok ? "Pushed the head to the hive's main branch." : "Push was refused."],
    result: ok ? "success" : "failure",
    executionTimeMs: 700,
    discardedPaths: [],
  };
}

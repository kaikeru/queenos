/**
 * Simulation ports for local demos: no Artifacts, LLM or Cloudflare credentials.
 *
 * - SimForkProvisioner: forks "succeed" after a short delay.
 * - SimDroneDispatcher: instead of starting a Workflow, it schedules scripted
 *   drone behaviour that calls back into the Queen (build-result, audit
 *   events, train-result, land-result) exactly like the real drones would.
 *
 * Scheduling uses Durable Object alarms, not setTimeout: the jobs live in DO
 * storage, so they survive hibernation and eviction, and the DO is woken by
 * the alarm. (A setTimeout inside ctx.waitUntil would be lost whenever the DO
 * hibernates or is evicted mid-demo.) Because the Queen's own `alarm()` is
 * also the reconcile hook, the sim subclass runs due jobs and then calls
 * super.alarm().
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
  DroneRole,
  DroneTask,
  GitNotesPayload,
  LandResultInput,
  TrainResult,
} from "@queenos/queen-types";
import type { ForkProvisioner, ForkResult } from "../artifacts";
import type { DroneDispatcher } from "../drones";
import { droneInstanceId } from "../drones";

/** The slice of QueenNode the simulated drones call (its public RPC surface). */
export interface SimQueen {
  appendAudit(a: AppendAuditInput): Promise<AuditEvent>;
  reportBuildResult(r: BuildResult): Promise<{ outcome: string }>;
  reportTrainResult(r: TrainResult): Promise<{ outcome: string }>;
  reportLandResult(r: LandResultInput): Promise<{ outcome: string }>;
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
  build: number;
  test: number;
  land: number;
}

export const DEFAULT_SIM_DELAYS: SimDelays = { fork: 300, build: 3500, test: 3000, land: 2000 };

export const FAIL_MARKER = "[fail]";

type JobKind = "build" | "test" | "land";
interface Job {
  id: string;
  kind: JobKind;
  due: number;
  task: DroneTask;
}

const JOBS_KEY = "sim:jobs";
const MODEL = "claude-sonnet-4-5";

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

export class SimForkProvisioner implements ForkProvisioner {
  constructor(private readonly delayMs: number = DEFAULT_SIM_DELAYS.fork) {}

  async forkTrain(source: string, name: string): Promise<ForkResult> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    return { artifactRepo: name, baseSha: fakeSha(`base:${source}`) };
  }

  async deleteFork(): Promise<boolean> {
    return true;
  }
}

export class SimDroneDispatcher implements DroneDispatcher {
  constructor(
    private readonly queen: () => SimQueen,
    private readonly store: SimStore,
    private readonly delays: SimDelays = DEFAULT_SIM_DELAYS,
    private readonly now: () => number = Date.now,
  ) {}

  async dispatch(task: DroneTask): Promise<{ instanceId: string }> {
    const id = droneInstanceId(task);
    const jobs = (await this.store.get<Job[]>(JOBS_KEY)) ?? [];
    if (jobs.some((j) => j.id === id)) return { instanceId: id }; // idempotent per (train, action)
    const kind: JobKind = task.action === "LAND" ? "land" : "build";
    const job: Job = { id, kind, due: this.now() + this.delays[kind], task };
    await this.store.put(JOBS_KEY, [...jobs, job]);
    await this.arm(job.due);
    // The drone "starts": its first card pulses yellow immediately.
    if (kind === "build") await this.audit(task, "BUILDER", "RUNNING", null);
    else await this.audit(task, "LANDER", "RUNNING", null);
    return { instanceId: id };
  }

  /** Run every job that is due, then re-arm the alarm for the next one. Call from alarm(). */
  async runDue(): Promise<number> {
    const jobs = (await this.store.get<Job[]>(JOBS_KEY)) ?? [];
    const t = this.now();
    const due = jobs.filter((j) => j.due <= t);
    // Remove first: running a job re-enters dispatch(), which edits the list.
    await this.store.put(
      JOBS_KEY,
      jobs.filter((j) => j.due > t),
    );
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

  // ── scripted drone behaviour ──────────────────────────────────────────

  private async run(job: Job): Promise<void> {
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
        await this.schedule({ id: `${task.trainId}-test`, kind: "test", due: this.now() + this.delays.test, task });
        return;
      }
      case "test": {
        const shouldFail = task.promptText.includes(FAIL_MARKER) && task.action === "BUILD";
        await this.audit(task, "POLICY", "PASSED", reviewNote(task, "policy", true));
        await this.audit(task, "SECURITY", shouldFail ? "REJECTED" : "PASSED", reviewNote(task, "security", !shouldFail));
        const summary = shouldFail
          ? "Security scan rejected the change: an unbounded retry loop swallows errors. Rework should add a retry cap and surface the failure."
          : "Policy and security checks passed; the change is scoped to the requested module with tests.";
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

/**
 * In-memory stand-ins for Artifacts, git remotes, the Queen, Vectorize and the
 * LLM. Git itself is real (hive-kit GitRepo on MemFS); only the network is faked.
 */
import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowStepConfig } from "cloudflare:workers";
import type { AppendAuditInput, AuditEvent, ScribeSummary, TrainResult } from "@queenos/queen-types";
import { GitRepo, initRepo, type CompletionRequest, type CompletionResult } from "@queenos/hive-kit";
import { readConfig, type GateConfig, type GateVars } from "../src/config";
import type { GateTask } from "../src/event";
import type { StepRunner } from "../src/orchestrate";
import type {
  ArtifactsPort,
  CloneRequest,
  FailureChunk,
  FailureStore,
  GateDispatcher,
  GatekeeperPorts,
  GitPort,
  GitSession,
  QueenPort,
  QueenSnapshot,
  RepoAccess,
} from "../src/ports";
import type { ScribeLlm } from "../src/scribe";
import type { SmokeProbe, SmokeResult } from "../src/smoke";
import { ScriptedTestRunner, type TestRunner } from "../src/test-runner";

export const T0 = 1_790_000_000;
export const HIVE = "hive";
export const REPO = "hive-train-aaaaaaaaaaaa";
export const remoteOf = (repo: string) => `https://acct.artifacts.cloudflare.net/git/queenos/${repo}.git`;

export function config(vars: GateVars = {}): GateConfig {
  return readConfig({ GATE_PHASE_RETRIES: "4", GATE_PHASE_WAIT_MS: "5000", ...vars });
}

export class FakeArtifacts implements ArtifactsPort {
  readonly calls: { repo: string; scope: string }[] = [];
  failWith: Error | null = null;
  async access(repo: string, scope: "read" | "write"): Promise<RepoAccess> {
    this.calls.push({ repo, scope });
    if (this.failWith) throw this.failWith;
    return { remote: remoteOf(repo), token: `art_v1_${"a".repeat(40)}?expires=${T0 + 900}` };
  }
}

export class FakeGitHost implements GitPort {
  readonly repos = new Map<string, GitRepo>();
  readonly clones: CloneRequest[] = [];

  /** A remote with a `seed` commit on main; returns its SHA. */
  async seed(repo: string, files: Record<string, string> = { "README.md": "# hive\n" }): Promise<string> {
    const r = await initRepo({ remote: { url: remoteOf(repo) } });
    await r.writeFiles(Object.entries(files).map(([path, content]) => ({ path, content })));
    const oid = await r.commitAll({ message: "seed", timestamp: T0 - 3600 });
    this.repos.set(remoteOf(repo), r);
    return oid;
  }

  repo(repo: string): GitRepo {
    const r = this.repos.get(remoteOf(repo));
    if (!r) throw new Error(`no fake repo ${repo}`);
    return r;
  }

  /** Commit like the scripted builder drone does (message lists changed files). */
  async build(repo: string, opts: { prompt: string; action?: "build" | "rework"; files: Record<string, string>; ts?: number }): Promise<string> {
    const r = this.repo(repo);
    await r.writeFiles(Object.entries(opts.files).map(([path, content]) => ({ path, content })));
    const subject = `queen(${opts.action ?? "build"}): ${opts.prompt.slice(0, 60)}`;
    const list = Object.keys(opts.files).map((p) => `- ${p}`).join("\n");
    return r.commitAll({ message: `${subject}\n\n${list}\n\nQueen-Prompt: p1\nQueen-Train: t1\n`, timestamp: opts.ts ?? T0 });
  }

  async clone(req: CloneRequest): Promise<GitSession> {
    this.clones.push(req);
    const r = this.repos.get(req.remote);
    if (!r) throw new Error(`NOT_FOUND: fake remote ${req.remote}`);
    return r;
  }
}

export interface FakeTrain {
  trainId: string;
  artifactRepo: string;
  phase: string;
  headSha: string | null;
  includedPrompts: string[];
  previewUrl?: string | null;
}

type QueenCall =
  | { method: "getSnapshot" }
  | { method: "appendAudit"; input: AppendAuditInput }
  | { method: "recordScribeSummary"; input: ScribeSummary }
  | { method: "reportTrainResult"; input: TrainResult };

export class FakeQueen implements QueenPort {
  readonly calls: QueenCall[] = [];
  /** Phases returned by successive getSnapshot calls (the last one sticks). */
  phases: string[] = ["TESTING"];
  train: FakeTrain = { trainId: "train-1", artifactRepo: REPO, phase: "TESTING", headSha: null, includedPrompts: ["prompt-0", "prompt-1"] };
  promptText = "Add a dark mode toggle to settings";
  extraTrains: FakeTrain[] = [];
  reportError: Error | null = null;

  async getSnapshot(): Promise<QueenSnapshot> {
    this.calls.push({ method: "getSnapshot" });
    const phase = this.phases.length > 1 ? this.phases.shift()! : this.phases[0]!;
    const toTrain = (t: FakeTrain) => ({
      trainId: t.trainId,
      baseSha: "b".repeat(40),
      includedPrompts: t.includedPrompts,
      artifactRepo: t.artifactRepo,
      status: "TESTING" as const,
      createdAt: T0,
      phase: (t === this.train ? phase : t.phase) as "TESTING",
      headSha: t.headSha,
      ...(t.previewUrl !== undefined ? { previewUrl: t.previewUrl } : {}),
    });
    return {
      type: "snapshot",
      promptRuns: [{ promptId: "prompt-1", namespace: HIVE, promptText: this.promptText, status: "IN_TRAIN", createdAt: T0 }],
      trains: [...this.extraTrains, this.train].map(toTrain),
      recentAudit: [],
    };
  }
  async appendAudit(input: AppendAuditInput): Promise<Pick<AuditEvent, "eventId">> {
    this.calls.push({ method: "appendAudit", input });
    return { eventId: `evt-${this.calls.length}` };
  }
  async recordScribeSummary(input: ScribeSummary) {
    this.calls.push({ method: "recordScribeSummary", input });
    return {};
  }
  async reportTrainResult(input: TrainResult) {
    this.calls.push({ method: "reportTrainResult", input });
    if (this.reportError) throw this.reportError;
    return { outcome: "applied" };
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
  audits(): AppendAuditInput[] {
    return this.calls.flatMap((c) => (c.method === "appendAudit" ? [c.input] : []));
  }
  /** `ROLE:STATUS` per audit. */
  auditSeq(): string[] {
    return this.audits().map((a) => `${a.droneRole}:${a.status}`);
  }
  reports(): TrainResult[] {
    return this.calls.flatMap((c) => (c.method === "reportTrainResult" ? [c.input] : []));
  }
  scribes(): ScribeSummary[] {
    return this.calls.flatMap((c) => (c.method === "recordScribeSummary" ? [c.input] : []));
  }
}

export class FakeFailureStore implements FailureStore {
  readonly stored: FailureChunk[][] = [];
  error: Error | null = null;
  async store(chunks: FailureChunk[]) {
    if (this.error) throw this.error;
    this.stored.push(chunks);
    return { stored: chunks.length };
  }
}

export class FakeLlm implements ScribeLlm {
  readonly requests: CompletionRequest[] = [];
  constructor(private readonly reply: string | Error) {}
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    if (this.reply instanceof Error) throw this.reply;
    return { text: this.reply, usage: { inputTokens: 1, outputTokens: 1 }, model: "claude-haiku-4-5", provider: "anthropic", stopReason: "end_turn" };
  }
}

export class FakeDispatcher implements GateDispatcher {
  readonly started: { id: string; task: GateTask }[] = [];
  async start(id: string, task: GateTask): Promise<"started" | "exists"> {
    if (this.started.some((s) => s.id === id)) return "exists";
    this.started.push({ id, task });
    return "started";
  }
}

export class FakeSmoke implements SmokeProbe {
  readonly urls: string[] = [];
  result: SmokeResult = { passed: true, status: 200, log: "smoke: ok" };
  async check(url: string): Promise<SmokeResult> {
    this.urls.push(url);
    return this.result;
  }
}

export class FakeWorld {
  readonly artifacts = new FakeArtifacts();
  readonly git = new FakeGitHost();
  readonly queen = new FakeQueen();
  readonly failures = new FakeFailureStore();
  readonly dispatcher = new FakeDispatcher();
  readonly smoke = new FakeSmoke();
  llm: ScribeLlm | null = null;
  tests: TestRunner = new ScriptedTestRunner();

  ports(): GatekeeperPorts {
    return {
      artifacts: this.artifacts,
      git: this.git,
      queen: () => this.queen,
      llm: this.llm,
      tests: this.tests,
      smoke: this.smoke,
      failures: this.failures,
      dispatcher: this.dispatcher,
    };
  }
}

/** Step runner that executes inline, emulating Workflows retries (no delays). */
export class InlineSteps implements StepRunner {
  readonly log: { name: string; attempts: number; ok: boolean }[] = [];
  readonly sleeps: { name: string; ms: number }[] = [];

  async do<T>(name: string, config: WorkflowStepConfig, fn: () => Promise<T>): Promise<T> {
    const limit = config.retries?.limit ?? 5;
    for (let attempt = 1; ; attempt++) {
      try {
        const value = await fn();
        this.log.push({ name, attempts: attempt, ok: true });
        return structuredClone(value); // Workflows persists step results
      } catch (e) {
        if (e instanceof NonRetryableError || attempt > limit) {
          this.log.push({ name, attempts: attempt, ok: false });
          throw e;
        }
      }
    }
  }

  async sleep(name: string, ms: number): Promise<void> {
    this.sleeps.push({ name, ms });
  }

  names(): string[] {
    return this.log.map((l) => l.name);
  }
}

export function gateTask(after: string, overrides: Partial<GateTask> = {}): GateTask {
  return { kind: "gate", repo: REPO, hive: HIVE, branch: "main", after, ...overrides };
}

/** The documented `pushed` envelope. */
export function pushedEnvelope(o: { repoName?: string; ref?: string; before?: string; after?: string; namespace?: string; message?: string } = {}) {
  return {
    type: "cf.artifacts.repo.pushed",
    source: { type: "artifacts.repo", namespace: o.namespace ?? "queenos", repoName: o.repoName ?? REPO },
    payload: {
      ref: o.ref ?? "refs/heads/main",
      before: o.before ?? "b".repeat(40),
      after: o.after ?? "a".repeat(40),
      commits: [{ id: o.after ?? "a".repeat(40), message: o.message ?? "queen(build): x", parents: [], extra: "ignored" }],
      totalCommitsCount: 1,
      commitsTruncated: false,
      unknownFutureField: { x: 1 },
    },
    metadata: { accountId: "acct", eventSchemaVersion: "1", eventTimestamp: "2026-10-02T00:00:00Z" },
  };
}

// ── shared world for the Workflow integration test (test/worker.ts) ───────

let current: FakeWorld | null = null;
export function setWorld(w: FakeWorld | null): void {
  current = w;
}
export function currentWorld(): FakeWorld {
  if (!current) throw new Error("no fake world installed (setWorld)");
  return current;
}

/**
 * In-memory stand-ins for Artifacts, git remotes, the Queen and the LLM.
 * Git itself is real (hive-kit GitRepo on MemFS); only the network is faked:
 * each "remote" is one shared working copy, and pushes are recorded.
 */
import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowStepConfig } from "cloudflare:workers";
import type {
  AppendAuditInput,
  BuildResult,
  DroneTaskInput,
  LandResultInput,
  TrainResult,
} from "@queenos/queen-types";
import {
  GitError,
  GitRepo,
  type CompletionRequest,
  type CompletionResult,
  type PushInput,
  type PushOutcome,
} from "@queenos/hive-kit";
import type { ArtifactsPort, CloneRequest, DronePorts, GitPort, GitSession, LlmPort, QueenPort, RepoAccess } from "../src/ports";
import type { StepRunner } from "../src/orchestrate";

export const T0_SECONDS = 1_790_000_000;
export const remoteOf = (repo: string) => `https://acct.artifacts.cloudflare.net/git/queenos/${repo}.git`;

export class FakeArtifacts implements ArtifactsPort {
  readonly calls: { repo: string; scope: string }[] = [];
  async access(repo: string, scope: "read" | "write"): Promise<RepoAccess> {
    this.calls.push({ repo, scope });
    return { remote: remoteOf(repo), token: `art_v1_${"a".repeat(40)}?expires=${T0_SECONDS + 900}` };
  }
}

export interface PushRecord {
  url: string;
  ref: string;
  remoteRef: string;
  oid: string;
}

class FakeRemoteRepo extends GitRepo {
  constructor(
    private readonly host: FakeGitHost,
    url: string,
  ) {
    super({ remote: { url } });
  }

  override async push(input: PushInput): Promise<PushOutcome> {
    const url = input.remote?.url ?? this.remote!.url;
    const remoteRef = input.remoteRef ?? input.ref;
    if (this.host.rejectNotes && remoteRef.startsWith("refs/notes/")) {
      throw new GitError("PUSH_REJECTED", `push to ${remoteRef} rejected (deny refs/notes)`);
    }
    if (this.host.nonFastForward.has(url)) throw new GitError("NOT_FAST_FORWARD", `push to ${remoteRef} is not a fast-forward`);
    const oid = await this.resolveRef(input.ref);
    this.host.pushes.push({ url, ref: input.ref, remoteRef, oid });
    this.host.remoteRefs.set(`${url}#${remoteRef}`, oid);
    return { ref: input.ref, remoteRef, oid };
  }

  override async fetchRef(): Promise<string | null> {
    return null; // no remote notes in the fake world
  }
}

export class FakeGitHost implements GitPort {
  readonly repos = new Map<string, FakeRemoteRepo>();
  readonly clones: CloneRequest[] = [];
  readonly pushes: PushRecord[] = [];
  readonly remoteRefs = new Map<string, string>();
  rejectNotes = false;
  readonly nonFastForward = new Set<string>();

  /** Create a remote with one commit on main; returns its head SHA. */
  async seed(repo: string, files: Record<string, string> = { "README.md": "# hive\n" }): Promise<string> {
    const r = new FakeRemoteRepo(this, remoteOf(repo));
    await r.init("main");
    await r.writeFiles(Object.entries(files).map(([path, content]) => ({ path, content })));
    const oid = await r.commitAll({ message: "seed", timestamp: T0_SECONDS - 3600 });
    this.repos.set(remoteOf(repo), r);
    return oid;
  }

  repo(repo: string): GitRepo {
    const r = this.repos.get(remoteOf(repo));
    if (!r) throw new Error(`no fake repo ${repo}`);
    return r;
  }

  async clone(req: CloneRequest): Promise<GitSession> {
    this.clones.push(req);
    const r = this.repos.get(req.remote);
    if (!r) throw new Error(`NOT_FOUND: fake remote ${req.remote}`);
    return r;
  }
}

type QueenCall =
  | { method: "reportBuildResult"; input: BuildResult }
  | { method: "reportLandResult"; input: LandResultInput }
  | { method: "reportTrainResult"; input: TrainResult }
  | { method: "appendAudit"; input: AppendAuditInput };

export class FakeQueen implements QueenPort {
  readonly calls: (QueenCall & { namespace: string })[] = [];
  constructor(private readonly namespace: string) {}

  async reportBuildResult(input: BuildResult) {
    this.calls.push({ method: "reportBuildResult", input, namespace: this.namespace });
    return { outcome: "applied" };
  }
  async reportLandResult(input: LandResultInput) {
    this.calls.push({ method: "reportLandResult", input, namespace: this.namespace });
    return { outcome: "applied" };
  }
  async reportTrainResult(input: TrainResult) {
    this.calls.push({ method: "reportTrainResult", input, namespace: this.namespace });
    return { outcome: "applied" };
  }
  async appendAudit(input: AppendAuditInput) {
    this.calls.push({ method: "appendAudit", input, namespace: this.namespace });
    return { eventId: `evt-${this.calls.length}` };
  }

  audits() {
    return this.calls.flatMap((c) => (c.method === "appendAudit" ? [c.input] : []));
  }
}

export class FakeLlm implements LlmPort {
  readonly requests: CompletionRequest[] = [];
  constructor(private readonly reply: (req: CompletionRequest, n: number) => string | Error) {}
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    const r = this.reply(req, this.requests.length);
    if (r instanceof Error) throw r;
    return { text: r, usage: { inputTokens: 10, outputTokens: 20 }, model: "claude-opus-5-5", provider: "anthropic", stopReason: "end_turn" };
  }
}

export class FakeWorld {
  readonly artifacts = new FakeArtifacts();
  readonly git = new FakeGitHost();
  readonly queens = new Map<string, FakeQueen>();
  llm: LlmPort | null = null;

  queen(namespace: string): FakeQueen {
    let q = this.queens.get(namespace);
    if (!q) this.queens.set(namespace, (q = new FakeQueen(namespace)));
    return q;
  }

  ports(): DronePorts {
    return { artifacts: this.artifacts, git: this.git, queen: (ns) => this.queen(ns), llm: this.llm };
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
        // Step results must survive serialization (Workflows persists them).
        return structuredClone(value);
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

export function task(overrides: Partial<DroneTaskInput> = {}): DroneTaskInput {
  return {
    promptId: "prompt-1",
    trainId: "train-1",
    namespace: "hive",
    artifactRepo: "hive-train-aaaaaaaaaaaa",
    baseRef: "main",
    promptText: "Add a dark mode toggle to settings",
    role: "BUILDER",
    action: "BUILD",
    ragContext: [],
    ...overrides,
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

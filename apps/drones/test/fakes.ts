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
  MergeResultInput,
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
import type { ArtifactsPort, CloneRequest, DronePorts, MergeCarFn, GitPort, GitSession, LlmPort, QueenPort, RepoAccess } from "../src/ports";
import type { StepRunner } from "../src/orchestrate";
import type { AgentBuildInput, AgentBuildResult, AgentPort } from "../src/agent/contract";

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
  | { method: "reportMergeResult"; input: MergeResultInput }
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
  async reportMergeResult(input: MergeResultInput) {
    this.calls.push({ method: "reportMergeResult", input, namespace: this.namespace });
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
    return { text: r, usage: { inputTokens: 10, outputTokens: 20 }, model: req.model, finishReason: "stop" };
  }
}

export class FakeWorld {
  readonly artifacts = new FakeArtifacts();
  readonly git = new FakeGitHost();
  readonly queens = new Map<string, FakeQueen>();
  llm: LlmPort | null = null;
  agent: FakeAgent | null = null;
  mergeCar: MergeCarFn | undefined;
  /** Analytics Engine stand-in: every point written. */
  readonly points: { indexes: string[]; blobs: string[]; doubles: number[] }[] = [];

  queen(namespace: string): FakeQueen {
    let q = this.queens.get(namespace);
    if (!q) this.queens.set(namespace, (q = new FakeQueen(namespace)));
    return q;
  }

  ports(): DronePorts {
    return { artifacts: this.artifacts, git: this.git, queen: (ns) => this.queen(ns), llm: this.llm, agent: this.agent, analytics: { writeDataPoint: (p) => void this.points.push(p) }, mergeCar: this.mergeCar };
  }
}

/** Step runner that executes inline, emulating Workflows retries (no delays). */
export class InlineSteps implements StepRunner {
  readonly log: { name: string; attempts: number; ok: boolean }[] = [];
  readonly sleeps: { name: string; ms: number }[] = [];
  /** Retry delays a step's dynamic `retries.delay` function chose (Workflows calls it after each failed attempt). */
  readonly retryDelays: { name: string; attempt: number; error: string; ms: number }[] = [];

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
        const delay = config.retries?.delay;
        if (typeof delay === "function") {
          const ctx = { step: { name, count: 1 }, attempt, config: {} } as unknown as Parameters<typeof delay>[0]["ctx"];
          const ms = Number(await delay({ ctx, error: e as Error }));
          this.retryDelays.push({ name, attempt, error: String((e as Error)?.message ?? e), ms });
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

/** What a scripted fake agent run does with its seeded workspace. */
export type AgentScript = (input: AgentBuildInput, files: Record<string, string>) => Partial<AgentBuildResult> | Error;

/**
 * Stand-in for the BuilderAgent DOs: one entry per DO name, submissions de-duplicated by idempotency
 * key (a second call with the same key re-attaches and returns the same result).
 */
export class FakeAgent implements AgentPort {
  readonly calls: { name: string; input: AgentBuildInput }[] = [];
  /** Submissions actually started (not re-attached). */
  readonly started: string[] = [];
  private readonly done = new Map<string, AgentBuildResult>();
  constructor(private readonly script: (model: string) => AgentScript) {}

  async build(name: string, input: AgentBuildInput): Promise<AgentBuildResult> {
    this.calls.push({ name, input: structuredClone(input) });
    const prior = this.done.get(input.idempotencyKey);
    if (prior) return { ...structuredClone(prior), reattached: true };
    this.started.push(input.idempotencyKey);
    const files = structuredClone(input.base);
    const out = this.script(input.model)(input, files);
    if (out instanceof Error) {
      this.started.pop();
      throw out;
    }
    const r: AgentBuildResult = {
      status: "completed",
      files,
      finish: null,
      lastVerify: null,
      trace: [],
      usage: { inputTokens: 100, outputTokens: 10, steps: 3 },
      reattached: false,
      ...out,
    };
    this.done.set(input.idempotencyKey, r);
    return structuredClone(r);
  }
}

export const PASSING_VERIFY = {
  ok: true,
  probes: [
    { path: "/", status: 200, contentType: "text/html; charset=utf-8", bodyStart: "<!doctype html>" },
    { path: "/health", status: 200, contentType: "application/json", bodyStart: '{"ok":true}' },
  ],
  problems: [],
};

/** A well-behaved agent: rewrites src/index.js to serve HTML at "/", verifies, finishes. */
export const htmlAgent: AgentScript = (_input, files) => {
  files["src/index.js"] = (files["src/index.js"] ?? "").replace("ok: true, app", "html: true, app");
  return {
    finish: { summary: "Serve HTML at /", reasoningSteps: ["The router owns /", "Edited src/index.js"], discardedPaths: ["new /features/status page"] },
    lastVerify: PASSING_VERIFY,
    trace: ["t1 read src/index.js", "t2 edit src/index.js", "t3 verify / 200 text/html; /health 200 json -> ok"],
  };
};

/** The worker-starter template as a hive repo (kept in sync by hand with templates/worker-starter). */
export const STARTER_FILES: Record<string, string> = {
  ".queen/deploy.json": '{\n  "main": "src/index.js",\n  "compatibility_date": "2026-10-02"\n}\n',
  "src/features/index.js": `// Feature registry. Keep this exact shape: one 'import * as fN from "./<file>.js";' per feature module, then "export const features = [...]". QueenOS merges it line by line.
export const features = [];
`,
  "src/index.js": `import { features } from "./features/index.js";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") return json({ ok: true, app: "worker-starter", features: features.map((f) => f.slug) });
    if (url.pathname === "/health") return json({ ok: true });
    return json({ ok: false }, 404);
  },
};
`,
};

/**
 * Fake Worker Loader: "runs" the Worker by looking up canned responses per path, keyed off the
 * modules it was given (so tests can model broken edits). Records every load.
 */
export class FakeLoader {
  readonly loads: { mainModule: string; modules: Record<string, string>; globalOutbound: null; compatibilityDate: string; limits?: { cpuMs?: number } }[] = [];
  constructor(private readonly respond: (path: string, modules: Record<string, string>) => Response | Error) {}
  load(code: FakeLoader["loads"][number]) {
    this.loads.push(code);
    const respond = this.respond;
    return {
      getEntrypoint: () => ({
        async fetch(req: Request): Promise<Response> {
          const r = respond(new URL(req.url).pathname, code.modules);
          if (r instanceof Error) throw r;
          return r;
        },
      }),
    };
  }
}

/** Responses of the starter router: "/" is HTML when src/index.js mentions "<html", else JSON. */
export const starterResponses = (path: string, modules: Record<string, string>): Response | Error => {
  const index = modules["src/index.js"] ?? "";
  if (index.includes("THROW_ON_LOAD")) return new Error("SyntaxError: Unexpected token");
  if (path === "/health") return index.includes("BREAK_HEALTH") ? new Response("nope", { status: 200, headers: { "content-type": "text/plain" } }) : Response.json({ ok: true });
  if (path === "/") return index.includes("<html") ? new Response("<!doctype html><html>hi</html>", { headers: { "content-type": "text/html; charset=utf-8" } }) : Response.json({ ok: true });
  if (path === "/boom") return new Response("err", { status: 500 });
  return Response.json({ ok: false }, { status: 404 });
};

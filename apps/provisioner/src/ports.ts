/**
 * Provisioner ports: every side effect goes through this object (mirrors
 * apps/drones). Tests swap in fakes via ProvisionerWorkflow.createPorts().
 */
import type { HiveCreatedResult, ProvisionResult, RecalledMemory } from "@queenos/queen-types";
import { HiveMemory, initRepo, type GitRepo, type RemoteSpec } from "@queenos/hive-kit";

// ── Artifacts ────────────────────────────────────────────────────────────

export interface ForkResult {
  artifactRepo: string;
  /** Head of the fork's default branch, i.e. the SHA the train starts from. */
  baseSha: string;
}

export interface ArtifactsPort {
  /**
   * Fork `sourceRepo` (the hive repo, or the predecessor train's fork) into
   * `forkName`. Idempotent: an existing fork of that name is reused, so a
   * retried command converges. May create the fork under a suffixed name
   * (`-r2`...) after Artifacts errors; `artifactRepo` is the name that exists.
   */
  forkTrain(sourceRepo: string, forkName: string): Promise<ForkResult>;
  /** Delete a repo. Returns false when it did not exist. */
  deleteRepo(name: string): Promise<boolean>;
  /** Create an empty hive repo (default branch main). An existing repo is success. */
  ensureRepo(name: string): Promise<void>;
  /** Mint a short-lived repo token and return the remote. */
  access(repo: string, scope: "read" | "write"): Promise<RepoAccess>;
  /**
   * SHA of the newest commit on `main` carrying a `Queen-Genesis:` trailer (a
   * seed from an earlier attempt or command), or null when there is none.
   */
  findSeed(repo: string): Promise<string | null>;
}

export interface RepoAccess {
  remote: string;
  /** Never leaves the step that minted it. */
  token: string;
}

/** Token TTL: long enough for init + push, short enough to be disposable (min 60). */
export const TOKEN_TTL_SECONDS = 15 * 60;

/** Commit trailer that marks the Genesis seed commit. */
export const SEED_TRAILER = "Queen-Genesis";

/** Codes that mean "the repo is still being created; try again shortly". */
const IN_PROGRESS = new Set(["FORK_IN_PROGRESS", "CREATE_IN_PROGRESS", "IMPORT_IN_PROGRESS"]);

export function errorCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

export interface BindingArtifactsOptions {
  /** Branch whose head becomes the train's base SHA. Default "main". */
  branch?: string;
  /** Attempts for in-progress errors. Default 6. */
  attempts?: number;
  /** First backoff delay (doubles each attempt). Default 250 ms. */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** fetch used for the readiness probe. Default globalThis.fetch. */
  fetch?: typeof fetch;
  /** Upper bound of the per-name start jitter. Default 3000 ms. */
  maxJitterMs?: number;
  /** Fork names tried before giving up (name, name-r2, ...). Default 4. */
  maxForks?: number;
  /** Per fork/delete call timeout (a fork once hung). Default 30 s. */
  forkTimeoutMs?: number;
  /** How long the probe tolerates 5xx. Default 20 s. */
  probeBudgetMs?: number;
  /** No new fork name is started after this much time. Default 100 s (step timeout is 3 min). */
  budgetMs?: number;
}

class TimeoutError extends Error {}

/** A fork name that should be abandoned (and deleted); the caller retries under a new one. */
class RetryableForkError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Stable 0..max ms from the fork name (FNV-1a), so Workflow step retries re-use it. */
export function forkJitterMs(name: string, max: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  return max <= 0 ? 0 : h % (max + 1);
}

/** Ported from apps/queen/src/artifacts.ts (ArtifactsForkProvisioner). */
export class BindingArtifactsPort implements ArtifactsPort {
  private readonly branch: string;
  private readonly attempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchFn: typeof fetch;
  private readonly maxJitterMs: number;
  private readonly maxForks: number;
  private readonly forkTimeoutMs: number;
  private readonly probeBudgetMs: number;
  private readonly budgetMs: number;

  constructor(
    private readonly artifacts: Artifacts | undefined,
    opts: BindingArtifactsOptions = {},
  ) {
    this.branch = opts.branch ?? "main";
    this.attempts = opts.attempts ?? 6;
    this.baseDelayMs = opts.baseDelayMs ?? 250;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.maxJitterMs = opts.maxJitterMs ?? 3000;
    this.maxForks = opts.maxForks ?? 4;
    this.forkTimeoutMs = opts.forkTimeoutMs ?? 30_000;
    this.probeBudgetMs = opts.probeBudgetMs ?? 20_000;
    this.budgetMs = opts.budgetMs ?? 100_000;
  }

  async forkTrain(sourceRepo: string, forkName: string): Promise<ForkResult> {
    const artifacts = this.binding();
    const startedAt = Date.now();
    // Concurrent forks of one source make Artifacts return INTERNAL_ERROR; spread them out.
    // Deterministic per name, so a re-run step (retry) waits the same amount.
    await this.sleep(forkJitterMs(forkName, this.maxJitterMs));

    let lastError: unknown;
    for (let n = 1; n <= this.maxForks; n++) {
      // A failed fork leaves an unusable ghost name, so each retry uses a new one.
      // The Queen adopts ProvisionResult.artifactRepo (planner.forkResult).
      const candidate = n === 1 ? forkName : `${forkName}-r${n}`;
      try {
        const baseSha = await this.forkOnce(artifacts, sourceRepo, candidate);
        return { artifactRepo: candidate, baseSha };
      } catch (e) {
        if (!(e instanceof RetryableForkError)) throw e;
        lastError = e.cause;
        console.warn(`fork ${candidate} unusable (${e.message}); ${n < this.maxForks ? "retrying under a new name" : "giving up"}`);
        await this.deleteQuietly(artifacts, candidate);
        if (n >= this.maxForks || Date.now() - startedAt > this.budgetMs) break;
        await this.sleep(this.baseDelayMs * 4 * 2 ** (n - 1));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`fork of ${sourceRepo} failed`);
  }

  /** One fork under one name. Throws RetryableForkError when that name should be abandoned. */
  private async forkOnce(artifacts: Artifacts, sourceRepo: string, forkName: string): Promise<string> {
    // The source being missing is a real error; do not mistake it for a ghost.
    await this.retry(async () => {
      using source = await artifacts.get(sourceRepo);
      try {
        await withTimeout(
          source.fork(forkName, { defaultBranchOnly: true, description: `QueenOS merge train forked from ${sourceRepo}` }),
          this.forkTimeoutMs,
          `fork ${forkName} timed out`,
        );
      } catch (e) {
        const code = errorCode(e);
        if (code === "ALREADY_EXISTS") return; // reuse a fork from an earlier attempt
        if (code === "INTERNAL_ERROR" || code === "NOT_FOUND" || e instanceof TimeoutError) throw new RetryableForkError(`fork ${code ?? "timeout"}`, e);
        throw e;
      }
    });
    // `get()` throws FORK_IN_PROGRESS until the fork is usable.
    let probe: { remote: string; token: string } | null = null;
    const baseSha = await this.retry(async () => {
      using fork = await artifacts.get(forkName);
      const [head] = await fork.log({ ref: this.branch, limit: 1 });
      if (!head) throw new Error(`UNAVAILABLE: fork ${forkName} has no ${this.branch} branch`);
      try {
        const [{ remote }, { plaintext }] = await Promise.all([fork.info(), fork.createToken("read", 60)]);
        probe = { remote, token: plaintext };
      } catch {
        probe = null; // the probe is advisory; never fail a fork because it could not run
      }
      return head.hash;
    }).catch((e: unknown) => {
      if (errorCode(e) === "NOT_FOUND") throw new RetryableForkError("fork vanished (ghost name)", e);
      throw e;
    });
    if (probe && !(await this.readable(probe))) {
      throw new RetryableForkError("fork returns 5xx on smart-HTTP reads", new Error(`UNAVAILABLE: fork ${forkName} is not readable (503)`));
    }
    return baseSha;
  }

  /** false only when git smart-HTTP keeps answering 5xx for ~20 s; inconclusive results count as readable. */
  private async readable(p: { remote: string; token: string }): Promise<boolean> {
    const auth = `Basic ${btoa(`x:${p.token.split("?expires=")[0]}`)}`;
    const url = `${p.remote.replace(/\/$/, "")}/info/refs?service=git-upload-pack`;
    let waited = 0;
    for (let delay = 1000; ; delay = Math.min(delay * 2, 4000)) {
      let status: number;
      try {
        status = (await this.fetchFn(url, { headers: { authorization: auth } })).status;
      } catch {
        return true; // network trouble says nothing about the repo
      }
      if (status < 500) return true;
      if (waited + delay > this.probeBudgetMs) return false;
      await this.sleep(delay);
      waited += delay;
    }
  }

  private async deleteQuietly(artifacts: Artifacts, name: string): Promise<void> {
    try {
      await withTimeout(artifacts.delete(name), this.forkTimeoutMs, `delete ${name} timed out`);
    } catch {
      // Best effort: a ghost may not exist, or the delete may hang.
    }
  }

  async deleteRepo(name: string): Promise<boolean> {
    const artifacts = this.binding();
    return this.retry(() => artifacts.delete(name));
  }

  async ensureRepo(name: string): Promise<void> {
    const artifacts = this.binding();
    try {
      await artifacts.create(name, { setDefaultBranch: "main", description: "QueenOS hive" });
    } catch (e) {
      if (errorCode(e) !== "ALREADY_EXISTS") throw e;
    }
  }

  async access(repo: string, scope: "read" | "write"): Promise<RepoAccess> {
    const artifacts = this.binding();
    return this.retry(async () => {
      using handle = await artifacts.get(repo);
      const [{ remote }, { plaintext }] = await Promise.all([handle.info(), handle.createToken(scope, TOKEN_TTL_SECONDS)]);
      return { remote, token: plaintext };
    });
  }

  async findSeed(repo: string): Promise<string | null> {
    const artifacts = this.binding();
    return this.retry(async () => {
      using handle = await artifacts.get(repo);
      let commits: { hash: string; message: string }[];
      try {
        commits = await handle.log({ ref: this.branch, limit: 20 });
      } catch (e) {
        // A repo that has never been pushed has no main yet.
        if (errorCode(e) === "NOT_FOUND" || errorCode(e) === "REF_NOT_FOUND") return null;
        throw e;
      }
      const seed = commits.find((c) => new RegExp(`^${SEED_TRAILER}: \\S+`, "m").test(c.message));
      return seed?.hash ?? null;
    });
  }

  private binding(): Artifacts {
    if (!this.artifacts) throw new Error("UNAVAILABLE: ARTIFACTS binding is not configured");
    return this.artifacts;
  }

  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (attempt >= this.attempts || !IN_PROGRESS.has(errorCode(e) ?? "")) throw e;
        await this.sleep(this.baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
}

// ── Queen ────────────────────────────────────────────────────────────────

/** RPC surface of apps/queen's QueenNode used by the provisioner. */
export interface QueenPort {
  reportProvisionResult(input: ProvisionResult): Promise<unknown>;
}

/** Cross-script DO binding to QueenNode; one DO per hive, `idFromName(hive)`. */
export function queenRpc(ns: DurableObjectNamespace | undefined, hive: string): QueenPort {
  if (!ns) throw new Error("UNAVAILABLE: QUEEN binding is not configured");
  // The binding is untyped across scripts; QueenPort mirrors QueenNode's RPC methods.
  return ns.get(ns.idFromName(hive)) as unknown as QueenPort;
}

// ── git (seeding a new hive) ─────────────────────────────────────────────

/** The subset of hive-kit's GitRepo CREATE_HIVE uses. */
export type SeedSession = Pick<GitRepo, "writeFiles" | "commitAll" | "push">;

export interface GitPort {
  /** A fresh, empty working copy (default branch main) wired to `remote`. */
  init(remote: RemoteSpec): Promise<SeedSession>;
}

export const isomorphicGitPort: GitPort = {
  init: (remote) => initRepo({ remote, defaultBranch: "main" }),
};

// ── Genesis ──────────────────────────────────────────────────────────────

/** RPC surface of apps/genesis's GenesisNode used by the provisioner. */
export interface GenesisPort {
  reportHiveCreated(input: HiveCreatedResult): Promise<unknown>;
}

/** Cross-script DO binding to GenesisNode; one DO per hive, `idFromName(hive)`. */
export function genesisRpc(ns: DurableObjectNamespace | undefined, hive: string): GenesisPort {
  if (!ns) throw new Error("UNAVAILABLE: GENESIS binding is not configured");
  return ns.get(ns.idFromName(hive)) as unknown as GenesisPort;
}

// ── bundle ───────────────────────────────────────────────────────────────

/** Hive memory recall (HiveMemory over Vectorize). Throws on trouble; the caller is best effort. */
export interface RecallPort {
  recall(namespace: string, query: string, opts?: { excludeTrainId?: string }): Promise<RecalledMemory[]>;
}

export interface ProvisionerPorts {
  artifacts: ArtifactsPort;
  recall: RecallPort;
  queen(hive: string): QueenPort;
  git: GitPort;
  genesis(hive: string): GenesisPort;
}

export interface ProvisionerEnvBindings {
  ARTIFACTS?: Artifacts;
  QUEEN?: DurableObjectNamespace;
  GENESIS?: DurableObjectNamespace;
  AI?: Ai;
  MEMORY?: VectorizeIndex;
}

export function createProdPorts(env: ProvisionerEnvBindings): ProvisionerPorts {
  return {
    artifacts: new BindingArtifactsPort(env.ARTIFACTS),
    recall: new HiveMemory(env.AI, env.MEMORY),
    queen: (hive) => queenRpc(env.QUEEN, hive),
    git: isomorphicGitPort,
    genesis: (hive) => genesisRpc(env.GENESIS, hive),
  };
}

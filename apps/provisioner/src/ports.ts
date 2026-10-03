/**
 * Provisioner ports: every side effect goes through this object (mirrors
 * apps/drones). Tests swap in fakes via ProvisionerWorkflow.createPorts().
 */
import type { HiveCreatedResult, ProvisionResult } from "@queenos/queen-types";
import { initRepo, type GitRepo, type RemoteSpec } from "@queenos/hive-kit";

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
   * retried command converges.
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
}

/** Ported from apps/queen/src/artifacts.ts (ArtifactsForkProvisioner). */
export class BindingArtifactsPort implements ArtifactsPort {
  private readonly branch: string;
  private readonly attempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly artifacts: Artifacts | undefined,
    opts: BindingArtifactsOptions = {},
  ) {
    this.branch = opts.branch ?? "main";
    this.attempts = opts.attempts ?? 6;
    this.baseDelayMs = opts.baseDelayMs ?? 250;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async forkTrain(sourceRepo: string, forkName: string): Promise<ForkResult> {
    const artifacts = this.binding();
    await this.retry(async () => {
      // Repo handles are Disposable RPC stubs (docs/discovery.md §1).
      using source = await artifacts.get(sourceRepo);
      try {
        await source.fork(forkName, {
          defaultBranchOnly: true,
          description: `QueenOS merge train forked from ${sourceRepo}`,
        });
      } catch (e) {
        if (errorCode(e) !== "ALREADY_EXISTS") throw e; // reuse a fork from an earlier attempt
      }
    });
    // `get()` throws FORK_IN_PROGRESS until the fork is usable.
    const baseSha = await this.retry(async () => {
      using fork = await artifacts.get(forkName);
      const [head] = await fork.log({ ref: this.branch, limit: 1 });
      if (!head) throw new Error(`UNAVAILABLE: fork ${forkName} has no ${this.branch} branch`);
      return head.hash;
    });
    return { artifactRepo: forkName, baseSha };
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

export interface ProvisionerPorts {
  artifacts: ArtifactsPort;
  queen(hive: string): QueenPort;
  git: GitPort;
  genesis(hive: string): GenesisPort;
}

export interface ProvisionerEnvBindings {
  ARTIFACTS?: Artifacts;
  QUEEN?: DurableObjectNamespace;
  GENESIS?: DurableObjectNamespace;
}

export function createProdPorts(env: ProvisionerEnvBindings): ProvisionerPorts {
  return {
    artifacts: new BindingArtifactsPort(env.ARTIFACTS),
    queen: (hive) => queenRpc(env.QUEEN, hive),
    git: isomorphicGitPort,
    genesis: (hive) => genesisRpc(env.GENESIS, hive),
  };
}

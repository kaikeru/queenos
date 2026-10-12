/**
 * Artifacts fork helpers shared by the git proxy (`apps/git`: train forks on the push path) and `queenos-mcp` (MCP race
 * bases and attempt forks). Moved from apps/git/src/upstream.ts (`forkTrain`; the Provisioner's approach of commit
 * 1deb7ab): fork with a timeout, wait while `get()` answers FORK_IN_PROGRESS, probe receive-pack readiness (a fork can
 * inherit its parent's 503 episode) and re-fork under `name-r2`, `name-r3` when a fork is a ghost or sick.
 * Workers-safe: no Node built-ins.
 */

/** The subset of an Artifacts repo handle a fork needs (the real binding's `ArtifactsRepo` fits it). */
export interface ForkRepoHandle extends Disposable {
  log(opts?: { ref?: string; limit?: number }): Promise<{ hash: string }[]>;
  fork(name: string, opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean }): Promise<unknown>;
}

/** The subset of the Artifacts binding a fork needs. */
export interface ForkArtifacts {
  get(name: string): Promise<ForkRepoHandle>;
  delete(name: string): Promise<boolean>;
}

export interface ProbeResult {
  status: number;
  /** The upstream `cf-ray`, for error evidence. */
  ray: string | null;
}

export interface ForkDeps {
  artifacts: ForkArtifacts;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** `GET <remote of repo>/info/refs?service=git-receive-pack` with a write credential; null = network trouble (inconclusive). */
  probeStatus(repo: string): Promise<ProbeResult | null>;
  /** Called before a repo is deleted (apps/git drops its cached credentials). */
  forget?(repo: string): void;
}

export interface ForkOptions {
  /** Names tried (name, name-r2, …). Default 3: each try costs 2–6 s. */
  maxForks?: number;
  /** One fork call. Default 30 s (a fork once hung; 1deb7ab). */
  forkTimeoutMs?: number;
  /** How long `get()` may say FORK_IN_PROGRESS. Default 30 s. */
  readyTimeoutMs?: number;
  /** How long the receive-pack probe tolerates 5xx before re-forking. Default 6 s. */
  probeBudgetMs?: number;
  /** Probe receive-pack before returning. Default true; a read-only fork (an MCP race base) is never pushed to. */
  probe?: boolean;
  readOnly?: boolean;
  description?: string;
  /** Prefix of the re-fork warning. Default "fork". */
  logPrefix?: string;
}

export interface ForkResult {
  /** The repo that exists (and, unless `probe: false`, is pushable): `name`, or `name-rN` after a re-fork. */
  repo: string;
  /** The source branch head at fork time (the fork's default branch head). */
  baseSha: string;
  /** Every name a fork was attempted under (the abandoned ones were deleted already). */
  attempted: string[];
}

/** The repo does not exist (Artifacts NOT_FOUND). */
export class RepoNotFoundError extends Error {
  constructor(readonly repo: string) {
    super(`no repo ${repo}`);
    this.name = "RepoNotFoundError";
  }
}

/** The Artifacts error code of a binding error (`.code`, or a `CODE:` message prefix), if any. */
export function errorCode(e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  const m = /^([A-Z_]{3,}):/.exec(e instanceof Error ? e.message : String(e));
  return m ? m[1]! : null;
}

class TimeoutError extends Error {}

/** This fork name is unusable (ghost, INTERNAL_ERROR, sick); delete it and try `-rN`. */
class RetryableForkError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Fork `source`'s default branch into `name` and wait until it is usable (and, by default, accepts receive-pack). A
 * sick fork or a ghost name is deleted and re-forked under `name-r2`, `name-r3`. Throws {@link RepoNotFoundError} for a
 * missing source.
 */
export async function forkRepo(deps: ForkDeps, source: string, branch: string, name: string, opts: ForkOptions = {}): Promise<ForkResult> {
  const maxForks = opts.maxForks ?? 3;
  const attempted: string[] = [];
  let last: unknown = null;
  for (let n = 1; n <= maxForks; n++) {
    const candidate = n === 1 ? name : `${name}-r${n}`;
    attempted.push(candidate);
    try {
      const baseSha = await forkOnce(deps, source, branch, candidate, opts);
      return { repo: candidate, baseSha, attempted };
    } catch (e) {
      if (!(e instanceof RetryableForkError)) throw e;
      last = e;
      console.warn(`${opts.logPrefix ?? "fork"}: fork ${candidate} unusable (${e.message}); ${n < maxForks ? "re-forking under a new name" : "giving up"}`);
      await deleteRepoQuietly(deps, candidate);
      if (n < maxForks) await deps.sleep(500 * n);
    }
  }
  throw new Error(`fork of ${source} failed after ${maxForks} tries: ${last instanceof Error ? last.message : String(last)}`);
}

async function forkOnce(deps: ForkDeps, source: string, branch: string, name: string, opts: ForkOptions): Promise<string> {
  let handle: ForkRepoHandle;
  try {
    handle = await deps.artifacts.get(source);
  } catch (e) {
    if (errorCode(e) === "NOT_FOUND") throw new RepoNotFoundError(source);
    throw e;
  }
  {
    using src = handle;
    try {
      await withTimeout(
        src.fork(name, { defaultBranchOnly: true, ...(opts.readOnly ? { readOnly: true } : {}), description: opts.description ?? `QueenOS fork of ${source}` }),
        opts.forkTimeoutMs ?? 30_000,
        `fork ${name} timed out`,
      );
    } catch (e) {
      const code = errorCode(e);
      // A fork from an earlier try of this name: reuse it (the name is fresh per intent).
      if (code !== "ALREADY_EXISTS") {
        if (code === "INTERNAL_ERROR" || code === "NOT_FOUND" || e instanceof TimeoutError) throw new RetryableForkError(`fork ${code ?? "timeout"}`);
        throw e;
      }
    }
  }

  // `get()` throws FORK_IN_PROGRESS until the fork is usable.
  const readyBy = deps.now() + (opts.readyTimeoutMs ?? 30_000);
  let baseSha: string | null = null;
  for (let delay = 250; ; delay = Math.min(delay * 2, 2000)) {
    try {
      using fork = await deps.artifacts.get(name);
      const [head] = await fork.log({ ref: branch, limit: 1 });
      if (!head) throw new RetryableForkError(`fork has no ${branch}`);
      baseSha = head.hash;
      break;
    } catch (e) {
      if (e instanceof RetryableForkError) throw e;
      const code = errorCode(e);
      if (code === "NOT_FOUND") throw new RetryableForkError("fork vanished (ghost name)");
      if (code !== "FORK_IN_PROGRESS" && code !== "INTERNAL_ERROR") throw e;
      if (deps.now() + delay > readyBy) throw new RetryableForkError(`fork not ready (${code})`);
      await deps.sleep(delay);
    }
  }

  if (opts.probe !== false) {
    const p = await pushable(deps, name, opts.probeBudgetMs ?? 6000);
    if (!p.ok) throw new RetryableForkError(`fork returns 5xx on receive-pack${p.ray ? ` (cf-ray=${p.ray})` : ""}`);
  }
  return baseSha;
}

/** Not ok only when the fork keeps answering 5xx for the probe budget; inconclusive results count as pushable. */
async function pushable(deps: ForkDeps, repo: string, budgetMs: number): Promise<{ ok: boolean; ray: string | null }> {
  let waited = 0;
  let ray: string | null = null;
  for (let delay = 1000; ; delay = Math.min(delay * 2, 4000)) {
    const r = await deps.probeStatus(repo).catch(() => null);
    if (!r) return { ok: true, ray };
    ray = r.ray ?? ray;
    if (r.status < 500) return { ok: true, ray };
    if (waited + delay > budgetMs) return { ok: false, ray };
    await deps.sleep(delay);
    waited += delay;
  }
}

/** Delete a repo, ignoring errors (a ghost may not exist; the Queen's cleanup is the backstop). */
export async function deleteRepoQuietly(deps: Pick<ForkDeps, "artifacts" | "forget">, repo: string): Promise<void> {
  deps.forget?.(repo);
  try {
    await withTimeout(deps.artifacts.delete(repo), 30_000, `delete ${repo} timed out`);
  } catch {
    // best effort
  }
}

/**
 * Everything that talks to Artifacts: smart-HTTP requests (with 503 retries on replayable requests and
 * error evidence), the push-path fork (readiness probe and `-rN` re-fork, the provisioner's approach from
 * commit 1deb7ab) and `readCommit`. Credentials come from {@link TokenCache} and are only ever put in the
 * `authorization` header of an upstream request.
 */
import { errorCode, RepoNotFoundError, type ArtifactsLike, type TokenCache, type TokenScope } from "./tokens.js";

export interface UpstreamDeps {
  artifacts: ArtifactsLike;
  tokens: TokenCache;
  /** Upstream HTTP (tests pass a fake Artifacts git server). */
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export type GitEndpoint = "info/refs" | "git-upload-pack" | "git-receive-pack";

/** Client request headers that are forwarded upstream. `authorization` and cookies never are. */
const FORWARDED = ["content-type", "accept", "content-encoding", "git-protocol", "user-agent", "content-length"];

/** §9: 503 episodes on reads: retry 3× with 2 / 4 / 6 s backoff, then answer 503 with Retry-After. */
export const READ_RETRY_DELAYS_MS = [2000, 4000, 6000];
export const RETRY_AFTER_S = 30;

export interface UpstreamRequest {
  hive: string;
  repo: string;
  scope: TokenScope;
  endpoint: GitEndpoint;
  /** Query string including `?`, or "". */
  search?: string;
  method: "GET" | "POST";
  /** A buffered body can be retried; a stream cannot. */
  body?: Uint8Array | ReadableStream<Uint8Array> | null;
  clientHeaders: Headers;
  /** Header overrides; `null` deletes the header. */
  headers?: Record<string, string | null>;
  /** Retry 503s (only for GET and buffered bodies). */
  retry503?: boolean;
  signal?: AbortSignal;
}

/** An upstream git HTTP failure, with evidence in the message (never the request's credentials). */
export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

/**
 * Evidence of an upstream error response, in hive-kit `withHttpEvidence`'s format:
 * `HTTP 503 receive-pack cf-ray=… retry-after=… body="…"`. Reads (and consumes) at most 200 body bytes.
 * Artifacts tokens (`art_v1_…`) are redacted from the body excerpt.
 */
export async function httpEvidence(res: Response, endpoint: GitEndpoint | string): Promise<string> {
  const parts = [`HTTP ${res.status}`, endpoint.replace(/^git-/, "")];
  const ray = res.headers.get("cf-ray");
  const retryAfter = res.headers.get("retry-after");
  if (ray) parts.push(`cf-ray=${ray}`);
  if (retryAfter) parts.push(`retry-after=${retryAfter}`);
  let snippet = "";
  try {
    const reader = res.body?.getReader();
    if (reader) {
      const { value } = await reader.read();
      await reader.cancel().catch(() => undefined);
      if (value) snippet = new TextDecoder().decode(value.subarray(0, 200));
    }
  } catch {
    // body unreadable: keep what we have
  }
  snippet = snippet
    .replace(/art_v\d_\S+/g, "[redacted]")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/"/g, "'")
    .trim();
  if (snippet) parts.push(`body="${snippet}"`);
  return parts.join(" ");
}

/** One smart-HTTP request to a repo's git endpoint. Returns the final response (any status). */
export async function upstreamFetch(deps: UpstreamDeps, r: UpstreamRequest): Promise<Response> {
  const auth = await deps.tokens.auth(r.repo, r.scope, r.hive);
  const h = new Headers();
  for (const k of FORWARDED) {
    const v = r.clientHeaders.get(k);
    if (v) h.set(k, v);
  }
  for (const [k, v] of Object.entries(r.headers ?? {})) {
    if (v === null) h.delete(k);
    else h.set(k, v);
  }
  h.set("authorization", auth.authorization);
  const url = `${auth.remote}/${r.endpoint}${r.search ?? ""}`;
  const replayable = r.method === "GET" || r.body instanceof Uint8Array || r.body == null;
  for (let attempt = 0; ; attempt++) {
    const res = await deps.fetch(url, { method: r.method, headers: h, body: r.body ?? null, signal: r.signal });
    const retry = r.retry503 && replayable && res.status === 503 && attempt < READ_RETRY_DELAYS_MS.length;
    if (!retry) return res;
    await res.body?.cancel().catch(() => undefined);
    await deps.sleep(READ_RETRY_DELAYS_MS[attempt]!);
  }
}

// ── the push-path fork ──────────────────────────────────────────────────

export interface ForkOptions {
  /** Names tried (name, name-r2, …). Default 3: each try costs 2–6 s of the client's push. */
  maxForks?: number;
  /** One fork call. Default 30 s (a fork once hung; 1deb7ab). */
  forkTimeoutMs?: number;
  /** How long `get()` may say FORK_IN_PROGRESS. Default 30 s. */
  readyTimeoutMs?: number;
  /** How long the receive-pack probe tolerates 5xx before re-forking. Default 6 s. */
  probeBudgetMs?: number;
}

export interface ForkResult {
  /** The repo that exists and is pushable: `name`, or `name-rN` after a re-fork. */
  repo: string;
  /** Hive main at fork time (the fork's default branch head): the push's `old` and `gitPushed.baseSha`. */
  baseSha: string;
  /** Every name a fork was attempted under (the abandoned ones were deleted already). */
  attempted: string[];
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
 * Fork hive main into `name` (the repo the Queen's `gitIntent` returned) and wait until it accepts
 * smart-HTTP. A sick fork (5xx on `info/refs?service=git-receive-pack`, the per-repo 503 episodes a fork
 * inherits) or a ghost name is deleted and re-forked under `name-r2`, `name-r3` (§9). The client's body
 * has not been read yet, so nothing needs replaying. Throws {@link RepoNotFoundError} for a missing hive.
 */
export async function forkTrain(deps: UpstreamDeps, hive: string, branch: string, name: string, opts: ForkOptions = {}): Promise<ForkResult> {
  const maxForks = opts.maxForks ?? 3;
  const attempted: string[] = [];
  let last: unknown = null;
  for (let n = 1; n <= maxForks; n++) {
    const candidate = n === 1 ? name : `${name}-r${n}`;
    attempted.push(candidate);
    try {
      const baseSha = await forkOnce(deps, hive, branch, candidate, opts);
      return { repo: candidate, baseSha, attempted };
    } catch (e) {
      if (!(e instanceof RetryableForkError)) throw e;
      last = e;
      console.warn(`git: fork ${candidate} unusable (${e.message}); ${n < maxForks ? "re-forking under a new name" : "giving up"}`);
      await deleteRepoQuietly(deps, candidate);
      if (n < maxForks) await deps.sleep(500 * n);
    }
  }
  throw new Error(`fork of ${hive} failed after ${maxForks} tries: ${last instanceof Error ? last.message : String(last)}`);
}

async function forkOnce(deps: UpstreamDeps, hive: string, branch: string, name: string, opts: ForkOptions): Promise<string> {
  let source;
  try {
    source = await deps.artifacts.get(hive);
  } catch (e) {
    if (errorCode(e) === "NOT_FOUND") throw new RepoNotFoundError(hive);
    throw e;
  }
  {
    using src = source;
    try {
      await withTimeout(
        src.fork(name, { defaultBranchOnly: true, description: `QueenOS pushed submission (train fork of ${hive})` }),
        opts.forkTimeoutMs ?? 30_000,
        `fork ${name} timed out`,
      );
    } catch (e) {
      const code = errorCode(e);
      // A fork from an earlier try of this name: reuse it (the name is the Queen's, fresh per intent).
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

  // Readiness probe (1deb7ab): a fork can inherit its parent's 503 episode. The push goes to
  // receive-pack, so probe exactly that advertisement with the write token.
  if (!(await pushable(deps, hive, name, opts.probeBudgetMs ?? 6000))) throw new RetryableForkError("fork returns 5xx on receive-pack");
  return baseSha;
}

/** false only when the fork keeps answering 5xx for the probe budget; inconclusive results count as pushable. */
async function pushable(deps: UpstreamDeps, hive: string, repo: string, budgetMs: number): Promise<boolean> {
  let waited = 0;
  for (let delay = 1000; ; delay = Math.min(delay * 2, 4000)) {
    let status: number;
    try {
      const res = await upstreamFetch(deps, {
        hive,
        repo,
        scope: "write",
        endpoint: "info/refs",
        search: "?service=git-receive-pack",
        method: "GET",
        clientHeaders: new Headers(),
      });
      status = res.status;
      await res.body?.cancel().catch(() => undefined);
    } catch {
      return true; // network trouble says nothing about the repo
    }
    if (status < 500) return true;
    if (waited + delay > budgetMs) return false;
    await deps.sleep(delay);
    waited += delay;
  }
}

/** Delete a repo, ignoring errors (a ghost may not exist; the Queen's cleanup is the backstop). */
export async function deleteRepoQuietly(deps: UpstreamDeps, repo: string): Promise<void> {
  deps.tokens.forget(repo);
  try {
    await withTimeout(deps.artifacts.delete(repo), 30_000, `delete ${repo} timed out`);
  } catch {
    // best effort
  }
}

export interface HeadCommit {
  title: string;
  message: string;
}

/** The pushed head commit's message, read through the binding (2 retries on errors). */
export async function readHeadCommit(deps: UpstreamDeps, repo: string, sha: string): Promise<HeadCommit> {
  let last: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      using r = await deps.artifacts.get(repo);
      const c = await r.readCommit(sha);
      if (!c) throw new Error(`commit ${sha.slice(0, 12)} not found in ${repo}`);
      const message = String(c.message);
      return { title: message.split("\n")[0]!.trim(), message };
    } catch (e) {
      last = e;
      if (attempt < 2) await deps.sleep(500 * (attempt + 1));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

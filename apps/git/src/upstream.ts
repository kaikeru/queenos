/**
 * Everything that talks to Artifacts: smart-HTTP requests (with 503 retries on replayable requests and
 * error evidence), the push-path fork (readiness probe and `-rN` re-fork, the provisioner's approach from
 * commit 1deb7ab) and `readCommit`. Credentials come from {@link TokenCache} and are only ever put in the
 * `authorization` header of an upstream request.
 */
import type { ArtifactsLike, TokenCache, TokenScope } from "./tokens.js";
import { deleteRepoQuietly as deleteRepo, forkRepo, type ForkDeps, type ForkOptions, type ForkResult } from "@queenos/hive-kit/artifacts";

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

// ── the push-path fork (forkRepo lives in @queenos/hive-kit/artifacts, shared with queenos-mcp) ──────

export type { ForkOptions, ForkResult };

/**
 * Fork hive main into `name` (the repo the Queen's `gitIntent` returned) and wait until it accepts smart-HTTP. A sick
 * fork (5xx on `info/refs?service=git-receive-pack`) or a ghost name is deleted and re-forked under `name-r2`, `name-r3`
 * (§9). Throws RepoNotFoundError for a missing hive.
 */
export function forkTrain(deps: UpstreamDeps, hive: string, branch: string, name: string, opts: ForkOptions = {}): Promise<ForkResult> {
  return forkRepo(forkDepsOf(deps, hive), hive, branch, name, { description: `QueenOS pushed submission (train fork of ${hive})`, logPrefix: "git", ...opts });
}

/** Delete a repo, ignoring errors; its cached credentials are dropped first. */
export function deleteRepoQuietly(deps: UpstreamDeps, repo: string): Promise<void> {
  return deleteRepo({ artifacts: deps.artifacts, forget: (r) => deps.tokens.forget(r) }, repo);
}

/** The probe is exactly the proxy's own receive-pack advertisement request, with the write token of the train fork. */
function forkDepsOf(deps: UpstreamDeps, hive: string): ForkDeps {
  return {
    artifacts: deps.artifacts,
    sleep: deps.sleep,
    now: deps.now,
    forget: (repo) => deps.tokens.forget(repo),
    probeStatus: async (repo) => {
      try {
        const res = await upstreamFetch(deps, { hive, repo, scope: "write", endpoint: "info/refs", search: "?service=git-receive-pack", method: "GET", clientHeaders: new Headers() });
        await res.body?.cancel().catch(() => undefined);
        return { status: res.status, ray: res.headers.get("cf-ray") };
      } catch {
        return null; // network trouble says nothing about the repo
      }
    },
  };
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

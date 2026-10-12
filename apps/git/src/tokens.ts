/**
 * Artifacts credentials of the git proxy (docs/human-push-design.md §8.2). Tokens are minted per repo through
 * the binding, cached in module memory for less than their TTL, and only ever leave this module as an
 * `Authorization` header value handed to `fetch`. They are never logged, returned to a client or put in a URL.
 *
 * Scope rule, enforced here rather than trusted to callers: hive main (and any non-train repo) only ever
 * gets a **read** token; a **write** token is minted only for a train fork of the hive
 * (`<hive>-train-<12 alnum>[-rN]`). A proxy bug therefore cannot write hive main.
 */
import { RepoNotFoundError, errorCode } from "@queenos/hive-kit/artifacts";

/** Moved to @queenos/hive-kit (shared with queenos-mcp); re-exported so the proxy's imports stay as they are. */
export { RepoNotFoundError, errorCode };

/** The subset of an Artifacts repo handle the proxy uses (the real binding's `ArtifactsRepo` fits it). */
export interface ArtifactsRepoLike extends Disposable {
  createToken(scope?: "write" | "read", ttl?: number): Promise<{ plaintext: string }>;
  info(): Promise<{ remote: string; defaultBranch: string }>;
  readCommit(hash: string): Promise<{ hash: string; message: string; parents: string[] } | null>;
  log(opts?: { ref?: string; limit?: number }): Promise<{ hash: string }[]>;
  fork(name: string, opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean }): Promise<unknown>;
}

/** The subset of the Artifacts binding the proxy uses. */
export interface ArtifactsLike {
  get(name: string): Promise<ArtifactsRepoLike>;
  delete(name: string): Promise<boolean>;
}

export type TokenScope = "read" | "write";

export interface UpstreamAuth {
  /** `Basic …` header value. Secret: never log or return it. */
  authorization: string;
  /** The repo's HTTPS git remote (no credentials in it), without a trailing slash. */
  remote: string;
  /** The repo's default branch (hive main's is the branch the advert keeps and pushes may not target). */
  defaultBranch: string;
}

/** `<hive>-train-<12 alnum>` (Queen `trainRepoName`), optionally with the `-rN` re-fork suffix. */
export function isTrainFork(hive: string, repo: string): boolean {
  if (!repo.startsWith(`${hive}-train-`)) return false;
  return /^[A-Za-z0-9]{12}(-r[0-9]{1,2})?$/.test(repo.slice(hive.length + 7));
}

/** Tokens live this long upstream; the cache drops them 10 minutes earlier. */
const TOKEN_TTL_S = 3600;
const CACHE_MS = 50 * 60_000;

interface Entry {
  auth: UpstreamAuth;
  exp: number;
}

export class TokenCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly artifacts: ArtifactsLike,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Credentials for `repo` (of hive `hive`) in `scope`. A write token is refused (throws) unless `repo` is a train fork of
   * `hive`. Throws {@link RepoNotFoundError} when the repo does not exist.
   */
  async auth(repo: string, scope: TokenScope, hive: string): Promise<UpstreamAuth> {
    if (scope === "write" && !isTrainFork(hive, repo)) throw new Error(`refusing a write token for ${repo}: not a train fork of ${hive}`);
    const key = `${scope}:${repo}`;
    const hit = this.entries.get(key);
    if (hit && hit.exp > this.now()) return hit.auth;
    let handle: ArtifactsRepoLike;
    try {
      handle = await this.artifacts.get(repo);
    } catch (e) {
      if (errorCode(e) === "NOT_FOUND") throw new RepoNotFoundError(repo);
      throw e;
    }
    using r = handle;
    const [t, info] = await Promise.all([r.createToken(scope, TOKEN_TTL_S), r.info()]);
    // Artifacts appends `?expires=<unix>` to the plaintext; the git password is the part before it.
    const password = String(t.plaintext).split("?expires=")[0]!;
    const auth: UpstreamAuth = {
      authorization: `Basic ${btoa(`x:${password}`)}`,
      remote: String(info.remote).replace(/\/+$/, ""),
      defaultBranch: info.defaultBranch || "main",
    };
    this.entries.set(key, { auth, exp: this.now() + CACHE_MS });
    return auth;
  }

  /** Drop every cached credential of `repo` (it was deleted). */
  forget(repo: string): void {
    this.entries.delete(`read:${repo}`);
    this.entries.delete(`write:${repo}`);
  }
}

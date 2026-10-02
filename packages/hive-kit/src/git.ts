/**
 * isomorphic-git helpers over MemFS (docs/discovery.md §2).
 *
 * - Transport is the fetch-based `isomorphic-git/http/web` client.
 * - Artifacts auth follows Cloudflare's isomorphic-git example: `onAuth`
 *   returns `{ username: "x", password: <token without ?expires=> }`.
 * - Commits take explicit author/committer timestamps so a retried Workflow
 *   step produces the same SHA (the push then becomes a no-op).
 */
import git from "isomorphic-git";
import webHttp from "isomorphic-git/http/web";
import { MemFS } from "./memfs.js";

export type HttpClient = typeof webHttp;

/** The Cognitive Ledger notes ref. */
export const NOTES_REF = "refs/notes/queen";
export const ZERO_OID = "0000000000000000000000000000000000000000";
const DEFAULT_DIR = "/repo";

export interface GitIdentity {
  name: string;
  email: string;
}

export const DRONE_IDENTITY: GitIdentity = { name: "QueenOS Drone", email: "drone@queenos.dev" };

/** A file to write (content) or delete (`delete: true`), relative to the repo root. */
export type FileChange = { path: string; content: string | Uint8Array } | { path: string; delete: true };

export interface CommitInput {
  message: string;
  /** Unix seconds. Fixed by the caller (e.g. from a `step.do`) for replay-safe SHAs. */
  timestamp: number;
  author?: GitIdentity;
  committer?: GitIdentity;
  timezoneOffset?: number;
  /** Create a commit even when nothing changed. Default false (throws NOTHING_TO_COMMIT). */
  allowEmpty?: boolean;
}

export interface CommitInfo {
  oid: string;
  message: string;
  parents: string[];
  tree: string;
  author: { name: string; email: string; timestamp: number };
}

export type GitErrorCode =
  | "NOT_FAST_FORWARD"
  | "PUSH_REJECTED"
  | "NOTHING_TO_COMMIT"
  | "NOT_FOUND"
  | "INVALID_PATH"
  | "NO_REMOTE"
  | "AUTH"
  | "UNKNOWN";

export class GitError extends Error {
  override readonly name = "GitError";
  constructor(
    readonly code: GitErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(`${code}: ${message}`);
  }
}

/** Strip the `?expires=<unix>` suffix Artifacts appends to tokens. */
export function stripTokenExpiry(token: string): string {
  return token.split("?expires=")[0] ?? token;
}

/** isomorphic-git `onAuth` for an Artifacts repo token. */
export function artifactsAuth(token: string): () => { username: string; password: string } {
  const password = stripTokenExpiry(token);
  return () => ({ username: "x", password });
}

/** Repo-relative path safety: no absolute paths, `..`, `.git`, NUL or backslashes. */
export function assertRepoPath(path: string): string {
  const clean = path.replace(/^\.\/+/, "");
  const parts = clean.split("/");
  if (
    clean.length === 0 ||
    clean.startsWith("/") ||
    clean.includes("\\") ||
    clean.includes("\0") ||
    parts.some((p) => p === "" || p === "." || p === "..") ||
    parts[0] === ".git"
  ) {
    throw new GitError("INVALID_PATH", `invalid repo path "${path}"`);
  }
  return clean;
}

function errName(e: unknown): string {
  const err = e as { code?: unknown; name?: unknown } | null;
  return String(err?.code ?? err?.name ?? "");
}

/** Normalize isomorphic-git push failures into GitError codes. */
function pushError(e: unknown, target: string): GitError {
  if (e instanceof GitError) return e;
  const name = errName(e);
  const reason = String((e as { data?: { reason?: unknown } } | null)?.data?.reason ?? "");
  if (name === "PushRejectedError") {
    return reason === "not-fast-forward"
      ? new GitError("NOT_FAST_FORWARD", `push to ${target} is not a fast-forward`, e)
      : new GitError("PUSH_REJECTED", `push to ${target} rejected (${reason || "unknown"})`, e);
  }
  if (name === "HttpError") {
    const status = Number((e as { data?: { statusCode?: unknown } }).data?.statusCode ?? 0);
    if (status === 401 || status === 403) return new GitError("AUTH", `push to ${target}: HTTP ${status}`, e);
  }
  if (name === "NotFoundError") return new GitError("NOT_FOUND", `push to ${target}: ${(e as Error).message}`, e);
  return new GitError("UNKNOWN", `push to ${target}: ${(e as Error)?.message ?? String(e)}`, e);
}

export interface RemoteSpec {
  url: string;
  token?: string;
}

export interface PushInput {
  /** Local ref to push (branch name or full ref). */
  ref: string;
  /** Remote ref. Defaults to the same name. */
  remoteRef?: string;
  force?: boolean;
  /** Push to a different remote than the one cloned from. */
  remote?: RemoteSpec;
}

export interface PushOutcome {
  ref: string;
  remoteRef: string;
  oid: string;
}

export interface GitRepoOptions {
  fs?: MemFS;
  dir?: string;
  remote?: RemoteSpec;
  http?: HttpClient;
}

/** A working copy in memory. Everything lives in the JS heap; keep repos small. */
export class GitRepo {
  readonly fs: MemFS;
  readonly dir: string;
  readonly remote: RemoteSpec | undefined;
  protected readonly http: HttpClient;

  constructor(opts: GitRepoOptions = {}) {
    this.fs = opts.fs ?? new MemFS();
    this.dir = opts.dir ?? DEFAULT_DIR;
    this.remote = opts.remote;
    this.http = opts.http ?? webHttp;
  }

  protected get base() {
    return { fs: this.fs, dir: this.dir };
  }

  /** `git init` this working copy (for new repos and tests; clones are already initialised). */
  async init(defaultBranch = "main"): Promise<this> {
    this.fs.mkdirSync(this.dir, true);
    await git.init({ ...this.base, defaultBranch });
    return this;
  }

  /** Write (or delete) files in the working tree. Paths are repo-relative. */
  async writeFiles(changes: FileChange[]): Promise<void> {
    for (const c of changes) {
      const path = `${this.dir}/${assertRepoPath(c.path)}`;
      if ("delete" in c) {
        if (this.fs.exists(path)) this.fs.unlinkSync(path);
      } else {
        this.fs.writeFileDeep(path, c.content);
      }
    }
  }

  /** Read working-tree files as UTF-8. Default: every tracked file at HEAD. Missing paths are skipped. */
  async readFiles(paths?: string[]): Promise<Record<string, string>> {
    const list = paths ?? (await this.listFiles());
    const out: Record<string, string> = {};
    for (const p of list) {
      const abs = `${this.dir}/${assertRepoPath(p)}`;
      if (this.fs.exists(abs)) out[p] = this.fs.readFileSync(abs, "utf8") as string;
    }
    return out;
  }

  /** Files tracked in the index (or at `ref`, if given). */
  async listFiles(ref?: string): Promise<string[]> {
    return git.listFiles({ ...this.base, ...(ref ? { ref } : {}) });
  }

  /** Stage every change (adds, edits, deletes) and commit. Returns the commit SHA. */
  async commitAll(input: CommitInput): Promise<string> {
    // statusMatrix rows: [path, HEAD, WORKDIR, STAGE]; 1/1/1 means unchanged.
    for (const [filepath, , workdir, stage] of await git.statusMatrix(this.base)) {
      if (workdir === 0 && stage !== 0) await git.remove({ ...this.base, filepath });
      else if (workdir !== 0 && workdir !== stage) await git.add({ ...this.base, filepath });
    }
    const staged = await git.statusMatrix(this.base);
    const changed = staged.some(([, h, w, s]) => !(h === 1 && w === 1 && s === 1));
    if (!changed && !input.allowEmpty) throw new GitError("NOTHING_TO_COMMIT", "working tree matches HEAD");
    const author = this.signature(input.author ?? DRONE_IDENTITY, input);
    const committer = this.signature(input.committer ?? input.author ?? DRONE_IDENTITY, input);
    return git.commit({ ...this.base, message: input.message, author, committer });
  }

  /** Attach a note to `oid` (default ref: refs/notes/queen). Returns the notes commit SHA. */
  async addNote(input: {
    oid: string;
    note: string;
    ref?: string;
    timestamp: number;
    author?: GitIdentity;
    force?: boolean;
  }): Promise<string> {
    const sig = this.signature(input.author ?? DRONE_IDENTITY, { timestamp: input.timestamp });
    return git.addNote({
      ...this.base,
      ref: input.ref ?? NOTES_REF,
      oid: input.oid,
      note: input.note,
      force: input.force ?? true,
      author: sig,
      committer: sig,
    });
  }

  /** Note text for `oid`, or null when there is none. */
  async readNote(oid: string, ref = NOTES_REF): Promise<string | null> {
    try {
      const bytes = await git.readNote({ ...this.base, ref, oid });
      return new TextDecoder().decode(bytes);
    } catch (e) {
      if (errName(e) === "NotFoundError") return null;
      throw e;
    }
  }

  /** `{target, note}` pairs on a notes ref, where `note` is the note blob SHA ([] when the ref does not exist). */
  async listNotes(ref = NOTES_REF): Promise<{ target: string; note: string }[]> {
    try {
      return await git.listNotes({ ...this.base, ref });
    } catch (e) {
      if (errName(e) === "NotFoundError") return [];
      throw e;
    }
  }

  /** Push a ref. Throws GitError NOT_FAST_FORWARD / PUSH_REJECTED / AUTH / ... */
  async push(input: PushInput): Promise<PushOutcome> {
    const remote = input.remote ?? this.remote;
    if (!remote) throw new GitError("NO_REMOTE", "no remote to push to");
    const ref = input.ref;
    const remoteRef = input.remoteRef ?? ref;
    let oid: string;
    try {
      oid = await git.resolveRef({ ...this.base, ref });
    } catch (e) {
      throw new GitError("NOT_FOUND", `local ref ${ref} not found`, e);
    }
    let result: Awaited<ReturnType<typeof git.push>>;
    try {
      result = await git.push({
        ...this.base,
        http: this.http,
        url: remote.url,
        ref,
        remoteRef,
        force: input.force ?? false,
        ...(remote.token ? { onAuth: artifactsAuth(remote.token) } : {}),
      });
    } catch (e) {
      throw pushError(e, remoteRef);
    }
    const refResult = Object.values(result.refs ?? {})[0];
    if (!result.ok || (refResult && !refResult.ok)) {
      const why = refResult?.error ?? result.error ?? "unknown";
      throw new GitError(
        /non-fast-forward|fetch first|not a fast forward/i.test(why) ? "NOT_FAST_FORWARD" : "PUSH_REJECTED",
        `push to ${remoteRef} rejected: ${why}`,
      );
    }
    return { ref, remoteRef, oid };
  }

  /**
   * Push the notes ref. Forced by default: the drones are the single writer per
   * train fork (docs/discovery.md §2 open risks). UNVERIFIED that Artifacts'
   * receive-pack accepts refs/notes/*; callers must handle failure.
   */
  async pushNotes(input: { ref?: string; force?: boolean; remote?: RemoteSpec } = {}): Promise<PushOutcome> {
    const ref = input.ref ?? NOTES_REF;
    return this.push({ ref, remoteRef: ref, force: input.force ?? true, ...(input.remote ? { remote: input.remote } : {}) });
  }

  /**
   * Fetch a single remote ref (e.g. a notes ref) into `localRef`.
   * Returns the fetched SHA, or null if the remote does not have the ref.
   */
  async fetchRef(input: { remoteRef: string; localRef: string; remote?: RemoteSpec; depth?: number }): Promise<string | null> {
    const remote = input.remote ?? this.remote;
    if (!remote) throw new GitError("NO_REMOTE", "no remote to fetch from");
    const name = `queen-fetch-${Math.abs(hashString(remote.url + input.localRef)).toString(36)}`;
    await git.addRemote({ ...this.base, remote: name, url: remote.url, force: true });
    await git.setConfig({ ...this.base, path: `remote.${name}.fetch`, value: `+${input.remoteRef}:${input.localRef}` });
    try {
      const res = await git.fetch({
        ...this.base,
        http: this.http,
        remote: name,
        ref: input.remoteRef,
        singleBranch: true,
        tags: false,
        ...(input.depth ? { depth: input.depth } : {}),
        ...(remote.token ? { onAuth: artifactsAuth(remote.token) } : {}),
      });
      return res.fetchHead ?? null;
    } catch (e) {
      if (errName(e) === "NotFoundError") return null;
      throw e;
    }
  }

  async resolveRef(ref: string): Promise<string> {
    try {
      return await git.resolveRef({ ...this.base, ref });
    } catch (e) {
      throw new GitError("NOT_FOUND", `ref ${ref} not found`, e);
    }
  }

  async writeRef(ref: string, oid: string, force = true): Promise<void> {
    await git.writeRef({ ...this.base, ref, value: oid, force });
  }

  /** Commit metadata, or null if the object is not present locally. */
  async readCommit(oid: string): Promise<CommitInfo | null> {
    try {
      const { oid: o, commit } = await git.readCommit({ ...this.base, oid });
      return {
        oid: o,
        message: commit.message,
        parents: commit.parent,
        tree: commit.tree,
        author: { name: commit.author.name, email: commit.author.email, timestamp: commit.author.timestamp },
      };
    } catch (e) {
      if (errName(e) === "NotFoundError") return null;
      throw e;
    }
  }

  /** HEAD commit (null on an unborn branch). */
  async head(): Promise<CommitInfo | null> {
    let oid: string;
    try {
      oid = await git.resolveRef({ ...this.base, ref: "HEAD" });
    } catch {
      return null;
    }
    return this.readCommit(oid);
  }

  async currentBranch(): Promise<string | undefined> {
    return (await git.currentBranch({ ...this.base, fullname: false })) ?? undefined;
  }

  private signature(id: GitIdentity, input: { timestamp: number; timezoneOffset?: number }) {
    return { name: id.name, email: id.email, timestamp: Math.floor(input.timestamp), timezoneOffset: input.timezoneOffset ?? 0 };
  }
}

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

export interface CloneOptions {
  /** HTTPS remote, e.g. `https://<acct>.artifacts.cloudflare.net/git/<ns>/<repo>.git`. */
  remote: string;
  /** Artifacts repo token (`art_v1_…?expires=…`). */
  token?: string;
  /** Branch to clone. Default: the remote HEAD. */
  ref?: string;
  /** Shallow depth. Default 1. Pass 0 for full history. */
  depth?: number;
  dir?: string;
  fs?: MemFS;
  http?: HttpClient;
}

/** Single-branch shallow clone into a fresh MemFS. */
export async function cloneRepo(opts: CloneOptions): Promise<GitRepo> {
  const remote: RemoteSpec = { url: opts.remote, ...(opts.token ? { token: opts.token } : {}) };
  const repo = new GitRepo({
    remote,
    ...(opts.fs ? { fs: opts.fs } : {}),
    ...(opts.dir ? { dir: opts.dir } : {}),
    ...(opts.http ? { http: opts.http } : {}),
  });
  const depth = opts.depth ?? 1;
  await git.clone({
    fs: repo.fs,
    dir: repo.dir,
    http: opts.http ?? webHttp,
    url: opts.remote,
    singleBranch: true,
    noTags: true,
    ...(opts.ref ? { ref: opts.ref } : {}),
    ...(depth > 0 ? { depth } : {}),
    ...(opts.token ? { onAuth: artifactsAuth(opts.token) } : {}),
  });
  return repo;
}

/** `git init` in memory (tests, or seeding a brand-new repo before a first push). */
export async function initRepo(opts: GitRepoOptions & { defaultBranch?: string } = {}): Promise<GitRepo> {
  const repo = new GitRepo(opts);
  await repo.init(opts.defaultBranch);
  return repo;
}

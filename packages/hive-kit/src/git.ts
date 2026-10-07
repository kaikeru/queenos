/**
 * isomorphic-git helpers over MemFS (docs/discovery.md §2).
 *
 * - Transport is the fetch-based `isomorphic-git/http/web` client.
 * - Artifacts auth follows Cloudflare's isomorphic-git example: `onAuth`
 *   returns `{ username: "x", password: <token without ?expires=> }`.
 * - Commits take explicit author/committer timestamps so a retried Workflow
 *   step produces the same SHA (the push then becomes a no-op).
 */
import git, { type MergeDriverCallback } from "isomorphic-git";
import webHttp from "isomorphic-git/http/web";
import type { MergeConflictKind } from "@queenos/queen-types";
import { MemFS } from "./memfs.js";
import { registryMergeDriver } from "./merge-driver.js";

export type HttpClient = typeof webHttp;

const EVIDENCE_BODY_BYTES = 200;

/** Smart-HTTP endpoint kind of a request URL. */
export function endpointKind(url: string): string {
  const path = url.split("?")[0] ?? url;
  if (path.endsWith("/info/refs")) return "info/refs";
  if (path.endsWith("/git-upload-pack")) return "upload-pack";
  if (path.endsWith("/git-receive-pack")) return "receive-pack";
  return "other";
}

/** One line of body text: control chars flattened, tokens redacted, clipped. */
function bodySnippet(bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes.subarray(0, EVIDENCE_BODY_BYTES));
  return text
    .replace(/art_v\d_\S+/g, "[redacted]")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/"/g, "'")
    .trim();
}

async function drain(body: unknown): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
    for await (const c of body as AsyncIterable<Uint8Array>) parts.push(c);
  } else if (body && typeof (body as Iterable<Uint8Array>)[Symbol.iterator] === "function") {
    for (const c of body as Iterable<Uint8Array>) parts.push(c);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Wrap an isomorphic-git HttpClient so a non-2xx response carries evidence in
 * its `statusMessage` (which isomorphic-git puts in HttpError.message):
 * `Service Unavailable [HTTP 503 upload-pack cf-ray=... retry-after=... body="..."]`.
 * The error body is read (and replayed to isomorphic-git) only for error
 * statuses. Request headers (auth) are never read or included.
 */
export function withHttpEvidence(inner: HttpClient): HttpClient {
  return {
    ...inner,
    request: async (req) => {
      const res = await inner.request(req);
      if (res.statusCode >= 200 && res.statusCode < 300) return res;
      let bytes: Uint8Array = new Uint8Array(0);
      try {
        bytes = await drain(res.body);
      } catch {
        // body unreadable: keep what we have
      }
      const h = res.headers ?? {};
      const parts = [`HTTP ${res.statusCode}`, endpointKind(req.url)];
      if (h["cf-ray"]) parts.push(`cf-ray=${h["cf-ray"]}`);
      if (h["retry-after"]) parts.push(`retry-after=${h["retry-after"]}`);
      const snippet = bodySnippet(bytes);
      if (snippet) parts.push(`body="${snippet}"`);
      return {
        ...res,
        statusMessage: `${res.statusMessage ?? ""} [${parts.join(" ")}]`.trim(),
        body: (async function* () {
          if (bytes.length) yield bytes;
        })(),
      };
    },
  } as HttpClient;
}

/** The default transport: the web client with error-evidence capture. */
const defaultHttp: HttpClient = withHttpEvidence(webHttp);

/** The Cognitive Ledger notes ref. */
export const NOTES_REF = "refs/notes/queen";
export const ZERO_OID = "0000000000000000000000000000000000000000";
const DEFAULT_DIR = "/repo";

export interface GitIdentity {
  name: string;
  email: string;
}

export const DRONE_IDENTITY: GitIdentity = { name: "QueenOS Drone", email: "drone@queenos.dev" };
/** Author/committer of the merge queue's merge commits (v2 design §2.3.4). */
export const QUEEN_MERGE_IDENTITY: GitIdentity = { name: "QueenOS Merge Queue", email: "queue@queenos.dev" };
/** `deepen` default: git's `--unshallow` depth (the whole history). */
export const FULL_DEPTH = 0x7fffffff;
const SHA_RE = /^[0-9a-f]{40}$/;
const MERGE_THEIRS_REF = "refs/queen/merge-theirs";

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

export interface MergeInput {
  /** Branch or SHA to merge in. */
  theirs: string;
  /** Branch receiving the merge (default: the current branch). */
  ours?: string;
  message: string;
  /** Unix seconds for author and committer: a replay makes the same SHA. */
  timestamp: number;
  author?: GitIdentity;
  committer?: GitIdentity;
  /** Default `registryMergeDriver` (union of the feature registry, diff3 elsewhere). */
  mergeDriver?: MergeDriverCallback;
  /** Allow a fast-forward (default true). */
  fastForward?: boolean;
}

/**
 * Why a merge did not happen. `content` = overlapping edits (isomorphic-git
 * MergeConflictError); `unsupported` = add/add of a path with different
 * content, a type change (MergeNotSupportedError), no merge base (shallow or
 * unrelated history), or several bases (criss-cross: no recursive strategy).
 */
export interface GitMergeConflict {
  kind: Exclude<MergeConflictKind, "missing">;
  reason: "conflict" | "add-add" | "not-supported" | "no-merge-base" | "criss-cross";
  /** Conflicting paths (best effort for `unsupported`), sorted. */
  paths: string[];
  ours: string;
  theirs: string;
  /** Merge bases found (0 or ≥2 for the base errors). */
  bases: string[];
}

export type MergeOutcome =
  | { oid: string; fastForward: boolean; alreadyMerged: boolean; mergeCommit: boolean; base: string }
  | { conflict: GitMergeConflict };

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
  if (name === "GitPushError") {
    // A ref the server refused (`ng <ref> <why>`): a moved ref ("fetch first",
    // "non-fast-forward") is a clean NOT_FAST_FORWARD, anything else a rejection.
    const details = String((e as { data?: { prettyDetails?: unknown } }).data?.prettyDetails ?? (e as Error).message);
    return /non-fast-forward|fetch first|not a fast forward|stale info/i.test(details)
      ? new GitError("NOT_FAST_FORWARD", `push to ${target} is not a fast-forward (${details.trim()})`, e)
      : new GitError("PUSH_REJECTED", `push to ${target} rejected: ${details.trim()}`, e);
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
    this.http = opts.http ?? defaultHttp;
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

  /**
   * Three-way merge `theirs` into `ours` (default: the current branch) with
   * `abortOnConflict`: on a conflict nothing moves (ref, index, worktree) and
   * `{conflict}` is returned. On success the branch moves (fast-forward or a
   * merge commit at `timestamp`) and, when it is the checked-out branch, the
   * worktree is checked out to match.
   */
  async merge(input: MergeInput): Promise<MergeOutcome> {
    const ours = input.ours ?? (await this.currentBranch());
    if (!ours) throw new GitError("NOT_FOUND", "merge: no current branch and no `ours`");
    const ourOid = await this.resolveRef(ours);
    let theirsRef = input.theirs;
    if (SHA_RE.test(input.theirs)) {
      if (!(await this.readCommit(input.theirs))) throw new GitError("NOT_FOUND", `merge: commit ${input.theirs} not present`);
      await this.writeRef(MERGE_THEIRS_REF, input.theirs);
      theirsRef = MERGE_THEIRS_REF;
    }
    const theirOid = await this.resolveRef(theirsRef);
    const bases = await this.findMergeBase([ourOid, theirOid]);
    const conflict = (c: Omit<GitMergeConflict, "ours" | "theirs" | "bases">): MergeOutcome => ({
      conflict: { ...c, paths: [...new Set(c.paths)].sort(), ours: ourOid, theirs: theirOid, bases },
    });
    if (bases.length === 0) return conflict({ kind: "unsupported", reason: "no-merge-base", paths: [] });
    if (bases.length > 1) return conflict({ kind: "unsupported", reason: "criss-cross", paths: [] });
    const base = bases[0]!;
    if (base === theirOid) return { oid: ourOid, fastForward: false, alreadyMerged: true, mergeCommit: false, base };

    const author = this.signature(input.author ?? QUEEN_MERGE_IDENTITY, input);
    const committer = this.signature(input.committer ?? input.author ?? QUEEN_MERGE_IDENTITY, input);
    let res: Awaited<ReturnType<typeof git.merge>>;
    try {
      res = await git.merge({
        ...this.base,
        ours,
        theirs: theirsRef,
        fastForward: input.fastForward ?? true,
        abortOnConflict: true,
        message: input.message,
        author,
        committer,
        mergeDriver: input.mergeDriver ?? registryMergeDriver,
      });
    } catch (e) {
      const name = errName(e);
      if (name === "MergeConflictError") {
        const data = (e as { data?: { filepaths?: string[]; bothModified?: string[] } }).data ?? {};
        const paths = data.filepaths ?? [];
        const baseFiles = new Set(await this.listFiles(base));
        const addAdd = (data.bothModified ?? []).filter((p) => !baseFiles.has(p));
        const onlyAddAdd = paths.length > 0 && paths.every((p) => addAdd.includes(p));
        return conflict({ kind: onlyAddAdd ? "unsupported" : "content", reason: onlyAddAdd ? "add-add" : "conflict", paths });
      }
      if (name === "MergeNotSupportedError") {
        const mine = new Set(await this.changedPaths(base, ourOid));
        const paths = (await this.changedPaths(base, theirOid)).filter((p) => mine.has(p));
        return conflict({ kind: "unsupported", reason: "not-supported", paths });
      }
      throw e;
    } finally {
      if (theirsRef === MERGE_THEIRS_REF) await git.deleteRef({ ...this.base, ref: MERGE_THEIRS_REF }).catch(() => undefined);
    }
    const oid = res.oid ?? (await this.resolveRef(ours));
    const current = await this.currentBranch();
    if (current && (ours === current || ours === `refs/heads/${current}`)) {
      // Best effort: the merge itself is done (the ref moved). A worktree
      // that cannot be checked out (e.g. a leftover directory where a file
      // now lives) stays stale; callers that commit afterwards must check out.
      await git.checkout({ ...this.base, ref: current, force: true }).catch(() => undefined);
    }
    return { oid, fastForward: res.fastForward === true, alreadyMerged: res.alreadyMerged === true, mergeCommit: res.mergeCommit === true, base };
  }

  /**
   * Best common ancestors of `refs` (branches or SHAs), as `git merge-base
   * --all --octopus`. Shallow boundaries count as roots, so a shallow clone
   * may return [] where `deepen` would find one.
   */
  async findMergeBase(refs: string[]): Promise<string[]> {
    const oids = await Promise.all(refs.map((r) => (SHA_RE.test(r) ? r : this.resolveRef(r))));
    return git.findMergeBase({ ...this.base, oids });
  }

  /** Paths whose blob or mode differs between two commits (`from` null = the empty tree), sorted. */
  async changedPaths(from: string | null, to: string): Promise<string[]> {
    const [a, b] = await Promise.all([from && from !== ZERO_OID ? this.treeEntries(from) : new Map<string, string>(), this.treeEntries(to)]);
    const out = new Set<string>();
    for (const [p, v] of a) if (b.get(p) !== v) out.add(p);
    for (const p of b.keys()) if (!a.has(p)) out.add(p);
    return [...out].sort();
  }

  /**
   * Fetch more history of a remote ref (default: the whole history), clearing
   * shallow boundaries the server unshallows. Returns the fetched SHA.
   */
  async deepen(input: { remoteRef?: string; localRef?: string; remote?: RemoteSpec; depth?: number } = {}): Promise<string | null> {
    const remoteRef = input.remoteRef ?? "refs/heads/main";
    return this.fetchRef({
      remoteRef,
      localRef: input.localRef ?? `refs/queen/deepen/${remoteRef.replace(/^refs\//, "")}`,
      ...(input.remote ? { remote: input.remote } : {}),
      depth: input.depth ?? FULL_DEPTH,
    });
  }

  /** Commits recorded as shallow boundaries (`.git/shallow`); [] for a full clone. */
  async shallowCommits(): Promise<string[]> {
    const path = `${this.dir}/.git/shallow`;
    if (!this.fs.exists(path)) return [];
    return (this.fs.readFileSync(path, "utf8") as string).split("\n").filter((l) => SHA_RE.test(l));
  }

  /** `path → mode:oid` for every blob in a commit's tree. */
  private async treeEntries(ref: string): Promise<Map<string, string>> {
    const oid = SHA_RE.test(ref) ? ref : await this.resolveRef(ref);
    const out = new Map<string, string>();
    const walkTree = async (treeOid: string, prefix: string): Promise<void> => {
      const { tree } = await git.readTree({ ...this.base, oid: treeOid });
      for (const e of tree) {
        const p = prefix ? `${prefix}/${e.path}` : e.path;
        if (e.type === "tree") await walkTree(e.oid, p);
        else if (e.type === "blob") out.set(p, `${e.mode}:${e.oid}`);
      }
    };
    const { commit } = await git.readCommit({ ...this.base, oid });
    await walkTree(commit.tree, "");
    return out;
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
  /** Artifacts repo token (`art_v2_x_…?expires=…`). */
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
    http: opts.http ?? defaultHttp,
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

// ── in-memory git remote (tests and sim) ───────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

function pkt(line: string | Uint8Array): Uint8Array {
  const body = typeof line === "string" ? enc.encode(line) : line;
  const out = new Uint8Array(body.length + 4);
  out.set(enc.encode((body.length + 4).toString(16).padStart(4, "0")));
  out.set(body, 4);
  return out;
}
const FLUSH = enc.encode("0000");

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** pkt-lines up to the first flush; returns the lines and the offset after the flush. */
function readPktLines(buf: Uint8Array, from = 0): { lines: string[]; next: number } {
  const lines: string[] = [];
  let o = from;
  while (o + 4 <= buf.length) {
    const len = parseInt(dec.decode(buf.subarray(o, o + 4)), 16);
    if (len === 0) return { lines, next: o + 4 };
    lines.push(dec.decode(buf.subarray(o + 4, o + len)));
    o += len;
  }
  return { lines, next: o };
}

/** Wrap `data` in side-band-64k channel `band` packets. */
function sideBand(band: number, data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let o = 0; o < data.length; o += 65515) out.push(pkt(concat([new Uint8Array([band]), data.subarray(o, o + 65515)])));
  return out;
}

/**
 * Git smart-HTTP (protocol v1) remotes held in memory, for tests and sim mode:
 * `http` is an isomorphic-git HttpClient that serves upload-pack (clone,
 * fetch, shallow `deepen`) and receive-pack (push, compare-and-swap on the old
 * SHA: a moved ref is rejected as "fetch first", i.e. NOT_FAST_FORWARD) from
 * `GitRepo`s keyed by URL. No Node built-ins: everything lives on MemFS.
 */
export class MemoryGitServer {
  readonly repos = new Map<string, GitRepo>();
  /** Every accepted ref update, in order. */
  readonly pushes: { url: string; ref: string; oid: string }[] = [];
  /** Return a reason to reject an update of `ref` on `url` (e.g. deny refs/notes/*). */
  deny: ((url: string, ref: string) => string | undefined) | undefined;

  readonly http: HttpClient = {
    request: async (req) => this.handle(req.url, req.method ?? "GET", req.body),
  } as HttpClient;

  /** Create an empty repo served at `url`. */
  async create(url: string, defaultBranch = "main"): Promise<GitRepo> {
    const repo = await initRepo({ defaultBranch });
    this.repos.set(url, repo);
    return repo;
  }

  repo(url: string): GitRepo {
    const r = this.repos.get(url);
    if (!r) throw new GitError("NOT_FOUND", `no in-memory remote ${url}`);
    return r;
  }

  private async handle(url: string, method: string, body: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | undefined) {
    const u = new URL(url);
    const m = /^(.*?)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(`${u.origin}${u.pathname}`);
    const repo = m ? this.repos.get(m[1]!) : undefined;
    const respond = (statusCode: number, contentType: string, parts: Uint8Array[]) => ({
      url,
      method,
      statusCode,
      statusMessage: statusCode === 200 ? "OK" : "Not Found",
      headers: { "content-type": contentType },
      body: [concat(parts)] as unknown as AsyncIterableIterator<Uint8Array>,
    });
    if (!m || !repo) return respond(404, "text/plain", [enc.encode("not found")]);
    const kind = m[2]!;
    if (kind === "info/refs") {
      const service = u.searchParams.get("service") ?? "git-upload-pack";
      return respond(200, `application/x-${service}-advertisement`, await this.advertise(repo, service));
    }
    const chunks: Uint8Array[] = [];
    if (body) for await (const c of body as AsyncIterable<Uint8Array>) chunks.push(c);
    const input = concat(chunks);
    const out = kind === "git-upload-pack" ? await this.uploadPack(repo, input) : await this.receivePack(m[1]!, repo, input);
    return respond(200, `application/x-${kind}-result`, out);
  }

  private async refs(repo: GitRepo): Promise<[string, string][]> {
    const fs = repo.fs;
    const root = `${repo.dir}/.git/`;
    const names = fs.walkFiles(`${root}refs`).map((p) => p.slice(root.length));
    const out: [string, string][] = [];
    for (const name of names.sort()) out.push([name, await repo.resolveRef(name)]);
    return out;
  }

  private async advertise(repo: GitRepo, service: string): Promise<Uint8Array[]> {
    const refs = await this.refs(repo);
    const branch = await repo.currentBranch();
    const caps =
      service === "git-receive-pack"
        ? "report-status side-band-64k delete-refs"
        : `side-band-64k shallow${branch ? ` symref=HEAD:refs/heads/${branch}` : ""}`;
    const head = branch ? refs.find(([n]) => n === `refs/heads/${branch}`) : undefined;
    const all: [string, string][] = service === "git-upload-pack" && head ? [["HEAD", head[1]], ...refs] : refs;
    const lines = all.length
      ? all.map(([name, oid], i) => pkt(`${oid} ${name}${i === 0 ? `\0${caps}` : ""}\n`))
      : [pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`)];
    return [pkt(`# service=${service}\n`), FLUSH, ...lines, FLUSH];
  }

  private async uploadPack(repo: GitRepo, input: Uint8Array): Promise<Uint8Array[]> {
    const { lines } = readPktLines(input);
    const wants: string[] = [];
    const clientShallow = new Set<string>();
    let depth = Infinity;
    for (const l of lines) {
      const [cmd, arg] = l.trim().split(/\s+/);
      if (cmd === "want" && arg) wants.push(arg);
      else if (cmd === "shallow" && arg) clientShallow.add(arg);
      else if (cmd === "deepen" && arg) depth = Number(arg) >= FULL_DEPTH ? Infinity : Number(arg);
    }
    const base = { fs: repo.fs, dir: repo.dir };
    // Breadth-first from the wants, each commit at its shortest depth.
    const seen = new Map<string, number>();
    const boundary = new Set<string>();
    let frontier: (readonly [string, number])[] = wants.map((oid) => [oid, 1] as const);
    const objects = new Set<string>();
    const addTree = async (oid: string): Promise<void> => {
      if (objects.has(oid)) return;
      objects.add(oid);
      for (const e of (await git.readTree({ ...base, oid })).tree) {
        if (e.type === "tree") await addTree(e.oid);
        else if (e.type === "blob") objects.add(e.oid);
      }
    };
    while (frontier.length) {
      const next: (readonly [string, number])[] = [];
      for (const [oid, d] of frontier) {
        if (seen.has(oid)) continue;
        seen.set(oid, d);
        const { commit } = await git.readCommit({ ...base, oid });
        objects.add(oid);
        await addTree(commit.tree);
        if (d >= depth) {
          if (commit.parent.length) boundary.add(oid);
        } else for (const p of commit.parent) next.push([p, d + 1]);
      }
      frontier = next;
    }
    const out: Uint8Array[] = [];
    if (Number.isFinite(depth) || clientShallow.size) {
      for (const oid of boundary) if (!clientShallow.has(oid)) out.push(pkt(`shallow ${oid}\n`));
      for (const oid of clientShallow) if (seen.has(oid) && !boundary.has(oid)) out.push(pkt(`unshallow ${oid}\n`));
      out.push(FLUSH);
    }
    out.push(pkt("NAK\n"));
    const { packfile } = await git.packObjects({ ...base, oids: [...objects] });
    out.push(...sideBand(1, packfile!), FLUSH);
    return out;
  }

  private async receivePack(url: string, repo: GitRepo, input: Uint8Array): Promise<Uint8Array[]> {
    const { lines, next } = readPktLines(input);
    const pack = input.subarray(next);
    const base = { fs: repo.fs, dir: repo.dir };
    if (pack.length > 32) {
      const name = `pack-${Array.from(pack.subarray(pack.length - 20), (b) => b.toString(16).padStart(2, "0")).join("")}`;
      const filepath = `.git/objects/pack/${name}.pack`;
      repo.fs.writeFileDeep(`${repo.dir}/${filepath}`, pack);
      await git.indexPack({ ...base, filepath });
    }
    const report: Uint8Array[] = [pkt("unpack ok\n")];
    for (const l of lines) {
      const [oldOid, newOid, ref] = l.split("\0")[0]!.trim().split(" ") as [string, string, string];
      const current = await repo.resolveRef(ref).catch(() => ZERO_OID);
      const denied = this.deny?.(url, ref);
      if (denied) report.push(pkt(`ng ${ref} ${denied}\n`));
      else if (current !== oldOid) report.push(pkt(`ng ${ref} fetch first\n`));
      else {
        if (newOid === ZERO_OID) await git.deleteRef({ ...base, ref });
        else await repo.writeRef(ref, newOid);
        this.pushes.push({ url, ref, oid: newOid });
        report.push(pkt(`ok ${ref}\n`));
      }
    }
    report.push(FLUSH);
    return [...sideBand(1, concat(report)), FLUSH];
  }
}

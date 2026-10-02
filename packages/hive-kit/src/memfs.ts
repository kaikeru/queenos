/**
 * Minimal in-memory filesystem for isomorphic-git (docs/discovery.md §2).
 *
 * isomorphic-git only needs the `fs.promises` subset below, and it branches on
 * `err.code` (ENOENT, EEXIST, ENOTDIR, ...), so every error carries a Node-style
 * `.code`. Cloudflare's example MemoryFS throws plain Errors, which breaks
 * `mkdirp` and `exists()`.
 *
 * No Node built-ins: paths are POSIX strings, file data is Uint8Array.
 */

export type FsErrorCode = "ENOENT" | "EEXIST" | "ENOTDIR" | "EISDIR" | "ENOTEMPTY" | "EINVAL";

export interface FsError extends Error {
  code: FsErrorCode;
  path: string;
  syscall: string;
}

export function fsError(code: FsErrorCode, syscall: string, path: string): FsError {
  return Object.assign(new Error(`${code}: ${syscall} '${path}'`), { code, syscall, path });
}

export function isFsError(e: unknown, code?: FsErrorCode): e is FsError {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" && (code === undefined || c === code);
}

type Node =
  | { kind: "file"; data: Uint8Array; mode: number; ino: number; mtimeMs: number }
  | { kind: "dir"; mode: number; ino: number; mtimeMs: number }
  | { kind: "symlink"; target: string; mode: number; ino: number; mtimeMs: number };

export interface MemStats {
  type: "file" | "dir" | "symlink";
  mode: number;
  size: number;
  ino: number;
  uid: number;
  gid: number;
  dev: number;
  mtimeMs: number;
  ctimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

type Encoding = "utf8" | "utf-8";
type ReadOptions = Encoding | { encoding?: Encoding | null } | null | undefined;
type WriteOptions = Encoding | { encoding?: Encoding | null; mode?: number } | null | undefined;

const FILE_MODE = 0o100644;
const DIR_MODE = 0o040755;
const LINK_MODE = 0o120000;

/** Normalize to an absolute POSIX path: collapses `//`, `.` and `..`. */
export function normalizePath(path: string): string {
  if (typeof path !== "string" || path.length === 0) throw fsError("EINVAL", "path", String(path));
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function wantsString(opts: ReadOptions): boolean {
  const enc = typeof opts === "string" ? opts : opts?.encoding;
  return enc === "utf8" || enc === "utf-8";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * In-memory fs. Pass the instance itself as isomorphic-git's `fs` (it uses the
 * enumerable `promises` property).
 */
export class MemFS {
  private readonly nodes = new Map<string, Node>();
  private nextIno = 1;
  /** Clock for mtimes; injectable for deterministic tests. */
  private readonly now: () => number;

  /** isomorphic-git requires `promises` to be an enumerable own property. */
  readonly promises: {
    readFile(path: string, opts?: ReadOptions): Promise<Uint8Array | string>;
    writeFile(path: string, data: Uint8Array | string, opts?: WriteOptions): Promise<void>;
    unlink(path: string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    mkdir(path: string, opts?: { recursive?: boolean } | number): Promise<void>;
    rmdir(path: string): Promise<void>;
    stat(path: string): Promise<MemStats>;
    lstat(path: string): Promise<MemStats>;
    readlink(path: string): Promise<string>;
    symlink(target: string, path: string): Promise<void>;
  };

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.nodes.set("/", { kind: "dir", mode: DIR_MODE, ino: this.nextIno++, mtimeMs: this.now() });
    // Arrow functions (bound) with arity 1 for rmdir, so isomorphic-git
    // falls back to its own recursive rm.
    this.promises = {
      readFile: async (path, opts) => this.readFileSync(path, opts),
      writeFile: async (path, data, opts) => this.writeFileSync(path, data, opts),
      unlink: async (path) => this.unlinkSync(path),
      readdir: async (path) => this.readdirSync(path),
      mkdir: async (path, opts) => this.mkdirSync(path, typeof opts === "object" && opts?.recursive === true),
      rmdir: async (path) => this.rmdirSync(path),
      stat: async (path) => this.statSync(path, true),
      lstat: async (path) => this.statSync(path, false),
      readlink: async (path) => this.readlinkSync(path),
      symlink: async (target, path) => this.symlinkSync(target, path),
    };
  }

  // ── sync core ──────────────────────────────────────────────────────────

  readFileSync(path: string, opts?: ReadOptions): Uint8Array | string {
    const p = normalizePath(path);
    const node = this.resolve(p, true, "open");
    if (node.kind === "dir") throw fsError("EISDIR", "read", p);
    if (node.kind !== "file") throw fsError("EINVAL", "read", p);
    return wantsString(opts) ? decoder.decode(node.data) : node.data.slice();
  }

  writeFileSync(path: string, data: Uint8Array | string, opts?: WriteOptions): void {
    const p = normalizePath(path);
    if (p === "/") throw fsError("EISDIR", "open", p);
    this.requireDir(parentOf(p), "open", p);
    const existing = this.nodes.get(p);
    if (existing?.kind === "dir") throw fsError("EISDIR", "open", p);
    const bytes = typeof data === "string" ? encoder.encode(data) : new Uint8Array(data);
    const mode = typeof opts === "object" && opts?.mode !== undefined ? opts.mode : FILE_MODE;
    this.nodes.set(p, {
      kind: "file",
      data: bytes,
      mode: existing?.kind === "file" && mode === FILE_MODE ? existing.mode : mode,
      ino: existing?.ino ?? this.nextIno++,
      mtimeMs: this.now(),
    });
    this.touch(parentOf(p));
  }

  unlinkSync(path: string): void {
    const p = normalizePath(path);
    const node = this.nodes.get(p);
    this.requireDir(parentOf(p), "unlink", p);
    if (!node) throw fsError("ENOENT", "unlink", p);
    if (node.kind === "dir") throw fsError("EISDIR", "unlink", p);
    this.nodes.delete(p);
    this.touch(parentOf(p));
  }

  readdirSync(path: string): string[] {
    const p = normalizePath(path);
    const node = this.resolve(p, true, "scandir");
    if (node.kind !== "dir") throw fsError("ENOTDIR", "scandir", p);
    return this.children(p).sort();
  }

  mkdirSync(path: string, recursive = false): void {
    const p = normalizePath(path);
    const existing = this.nodes.get(p);
    if (existing) {
      if (recursive && existing.kind === "dir") return;
      throw fsError("EEXIST", "mkdir", p);
    }
    const parent = parentOf(p);
    const pnode = this.nodes.get(parent);
    if (!pnode) {
      if (!recursive) throw fsError("ENOENT", "mkdir", p);
      this.mkdirSync(parent, true);
    } else if (pnode.kind !== "dir") {
      throw fsError("ENOTDIR", "mkdir", p);
    }
    this.nodes.set(p, { kind: "dir", mode: DIR_MODE, ino: this.nextIno++, mtimeMs: this.now() });
    this.touch(parent);
  }

  rmdirSync(path: string): void {
    const p = normalizePath(path);
    if (p === "/") throw fsError("EINVAL", "rmdir", p);
    const node = this.nodes.get(p);
    if (!node) {
      this.requireDir(parentOf(p), "rmdir", p);
      throw fsError("ENOENT", "rmdir", p);
    }
    if (node.kind !== "dir") throw fsError("ENOTDIR", "rmdir", p);
    if (this.children(p).length > 0) throw fsError("ENOTEMPTY", "rmdir", p);
    this.nodes.delete(p);
    this.touch(parentOf(p));
  }

  statSync(path: string, follow = true): MemStats {
    const p = normalizePath(path);
    const node = this.resolve(p, follow, follow ? "stat" : "lstat");
    const size = node.kind === "file" ? node.data.byteLength : node.kind === "symlink" ? encoder.encode(node.target).byteLength : 0;
    const type = node.kind;
    return {
      type,
      mode: node.mode,
      size,
      ino: node.ino,
      uid: 1,
      gid: 1,
      dev: 1,
      mtimeMs: node.mtimeMs,
      ctimeMs: node.mtimeMs,
      isFile: () => type === "file",
      isDirectory: () => type === "dir",
      isSymbolicLink: () => type === "symlink",
    };
  }

  readlinkSync(path: string): string {
    const p = normalizePath(path);
    const node = this.resolve(p, false, "readlink");
    if (node.kind !== "symlink") throw fsError("EINVAL", "readlink", p);
    return node.target;
  }

  symlinkSync(target: string, path: string): void {
    const p = normalizePath(path);
    this.requireDir(parentOf(p), "symlink", p);
    if (this.nodes.has(p)) throw fsError("EEXIST", "symlink", p);
    this.nodes.set(p, { kind: "symlink", target, mode: LINK_MODE, ino: this.nextIno++, mtimeMs: this.now() });
  }

  // ── conveniences (not used by isomorphic-git) ──────────────────────────

  exists(path: string): boolean {
    try {
      this.resolve(normalizePath(path), true, "access");
      return true;
    } catch {
      return false;
    }
  }

  /** mkdir -p the parent, then write. */
  writeFileDeep(path: string, data: Uint8Array | string): void {
    this.mkdirSync(parentOf(normalizePath(path)), true);
    this.writeFileSync(path, data);
  }

  /** All regular-file paths under `root` (absolute, sorted). */
  walkFiles(root = "/", skip: (path: string) => boolean = () => false): string[] {
    const out: string[] = [];
    const base = normalizePath(root);
    const prefix = base === "/" ? "/" : base + "/";
    for (const [p, n] of this.nodes) {
      if (n.kind === "file" && p.startsWith(prefix) && !skip(p)) out.push(p);
    }
    return out.sort();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private children(dir: string): string[] {
    const prefix = dir === "/" ? "/" : dir + "/";
    const names: string[] = [];
    for (const p of this.nodes.keys()) {
      if (p !== dir && p.startsWith(prefix) && !p.slice(prefix.length).includes("/")) {
        names.push(p.slice(prefix.length));
      }
    }
    return names;
  }

  /** Every ancestor must exist and be a directory, else ENOENT / ENOTDIR. */
  private requireDir(dir: string, syscall: string, path: string): void {
    const node = this.nodes.get(dir);
    if (!node) {
      if (dir !== "/") this.requireAncestors(dir, syscall, path);
      throw fsError("ENOENT", syscall, path);
    }
    if (node.kind !== "dir") throw fsError("ENOTDIR", syscall, path);
  }

  private requireAncestors(dir: string, syscall: string, path: string): void {
    let cur = parentOf(dir);
    while (cur !== "/") {
      const n = this.nodes.get(cur);
      if (n && n.kind !== "dir") throw fsError("ENOTDIR", syscall, path);
      cur = parentOf(cur);
    }
  }

  private resolve(p: string, follow: boolean, syscall: string, hops = 0): Node {
    const node = this.nodes.get(p);
    if (!node) {
      this.requireAncestors(p, syscall, p);
      throw fsError("ENOENT", syscall, p);
    }
    if (follow && node.kind === "symlink") {
      if (hops > 16) throw fsError("EINVAL", syscall, p);
      const target = node.target.startsWith("/") ? node.target : parentOf(p) + "/" + node.target;
      return this.resolve(normalizePath(target), true, syscall, hops + 1);
    }
    return node;
  }

  private touch(dir: string): void {
    const n = this.nodes.get(dir);
    if (n) n.mtimeMs = this.now();
  }
}

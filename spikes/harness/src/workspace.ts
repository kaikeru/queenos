/**
 * A Map-backed `WorkspaceLike` so Think's workspace tools (read/write/edit/list/find/grep/delete)
 * run without a Durable Object. The whole state is `snapshot()`-able plain JSON, which is what a
 * Workflow step would carry between turns (overlay = files changed vs. the base tree).
 */
import type { FileInfo } from "@cloudflare/shell";

const norm = (p: string) => "/" + p.replace(/^\/+/, "").replace(/\/+$/, "");

function globToRegExp(pattern: string): RegExp {
  let p = pattern.startsWith("/") ? pattern : `/${pattern}`;
  if (!/^\/\*\*/.test(p) && !pattern.startsWith("/")) p = `/**${p}`; // relative globs match anywhere
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*") {
      if (p[i + 1] === "*") {
        i++;
        if (p[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = p.indexOf("}", i);
      re += `(?:${p.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export class MapWorkspace {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>(["/"]);
  readonly touched = new Set<string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(initial)) this.put(norm(p), c, false);
  }

  private put(p: string, c: string, mark = true) {
    this.files.set(p, c);
    if (mark) this.touched.add(p);
    const parts = p.split("/").slice(1, -1);
    for (let i = 1; i <= parts.length; i++) this.dirs.add("/" + parts.slice(0, i).join("/"));
  }

  private info(p: string): FileInfo {
    const isFile = this.files.has(p);
    const content = this.files.get(p) ?? "";
    return {
      path: p,
      name: p.split("/").pop() || "/",
      type: isFile ? "file" : "directory",
      mimeType: isFile ? (p.endsWith(".js") ? "text/javascript" : p.endsWith(".json") ? "application/json" : "text/plain") : "inode/directory",
      size: isFile ? new TextEncoder().encode(content).byteLength : 0,
      createdAt: 0,
      updatedAt: 0,
    };
  }

  async readFile(path: string) {
    return this.files.get(norm(path)) ?? null;
  }
  async readFileBytes(path: string) {
    const t = this.files.get(norm(path));
    return t == null ? null : new TextEncoder().encode(t);
  }
  async writeFile(path: string, content: string) {
    this.put(norm(path), content);
  }
  async writeFileBytes(path: string, content: Uint8Array | ArrayBuffer) {
    this.put(norm(path), new TextDecoder().decode(content));
  }
  async mkdir(path: string) {
    this.dirs.add(norm(path));
  }
  async stat(path: string) {
    const p = norm(path);
    return this.files.has(p) || this.dirs.has(p) ? this.info(p) : null;
  }
  async readDir(dir = "/", opts?: { limit?: number; offset?: number }) {
    const d = norm(dir) === "/" ? "" : norm(dir);
    const kids = new Set<string>();
    for (const p of [...this.files.keys(), ...this.dirs]) {
      if (p !== "/" && p !== d && p.startsWith(d + "/") && !p.slice(d.length + 1).includes("/")) kids.add(p);
    }
    const all = [...kids].sort().map((p) => this.info(p));
    const off = opts?.offset ?? 0;
    return all.slice(off, opts?.limit ? off + opts.limit : undefined);
  }
  async glob(pattern: string) {
    const re = globToRegExp(pattern);
    return [...this.files.keys()].filter((p) => re.test(p)).sort().map((p) => this.info(p));
  }
  async rm(path: string, opts?: { recursive?: boolean }) {
    const p = norm(path);
    this.files.delete(p);
    this.touched.add(p);
    if (opts?.recursive) for (const f of [...this.files.keys()]) if (f.startsWith(p + "/")) (this.files.delete(f), this.touched.add(f));
    this.dirs.delete(p);
  }

  /** Repo-relative path -> content. */
  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.files].map(([p, c]) => [p.slice(1), c]));
  }
}

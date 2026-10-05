/**
 * The builder LLM's output contract: a strict JSON file-change set.
 *
 * Local to drones for now; proposed as a queen-types addition
 * (`DroneChangeSetSchema`) once the dashboard wants to render it.
 */
import { z } from "zod";
import { assertRepoPath } from "@queenos/hive-kit";

/** Caps keep the `generate` step result far below the 1 MiB Workflows limit. */
export const MAX_FILES = 20;
export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_TOTAL_BYTES = 512 * 1024;
export const MAX_PATH_CHARS = 200;
export const MAX_REASONING_STEPS = 20;
export const MAX_DISCARDED_PATHS = 50;
/** Reserved for the ledger fallback; the LLM may not write there. */
export const RESERVED_PREFIXES = [".queen/", ".git/"];

/** Paths a coding agent may read but never change: platform config, deploy contract, git internals. */
export function isProtectedPath(path: string): boolean {
  return RESERVED_PREFIXES.some((r) => path.startsWith(r)) || path === "package.json" || /^wrangler\.(?:jsonc?|toml)$/.test(path);
}

const byteLength = (s: string) => new TextEncoder().encode(s).byteLength;

const RepoPath = z
  .string()
  .min(1)
  .max(MAX_PATH_CHARS)
  .transform((p, ctx) => {
    try {
      const clean = assertRepoPath(p);
      if (RESERVED_PREFIXES.some((r) => clean.startsWith(r))) {
        ctx.addIssue({ code: "custom", message: `path "${p}" is reserved` });
        return z.NEVER;
      }
      return clean;
    } catch {
      ctx.addIssue({ code: "custom", message: `unsafe path "${p}"` });
      return z.NEVER;
    }
  });

export const FileWriteSchema = z.object({
  path: RepoPath,
  content: z.string().refine((c) => byteLength(c) <= MAX_FILE_BYTES, `file exceeds ${MAX_FILE_BYTES} bytes`),
});

export const ChangeSetSchema = z
  .object({
    files: z.array(FileWriteSchema).max(MAX_FILES),
    /** Paths to delete (the tool-loop agent can remove files; the single-shot JSON contract never does). */
    deletes: z.array(RepoPath).max(MAX_FILES).default([]),
    reasoningSteps: z.array(z.string().max(2_000)).max(MAX_REASONING_STEPS).default([]),
    discardedPaths: z.array(z.string().max(MAX_PATH_CHARS)).max(MAX_DISCARDED_PATHS).default([]),
  })
  .superRefine((cs, ctx) => {
    if (cs.files.length + cs.deletes.length === 0) ctx.addIssue({ code: "custom", message: "change set is empty", path: ["files"] });
    const seen = new Set<string>();
    for (const f of [...cs.files, ...cs.deletes.map((path) => ({ path }))]) {
      if (seen.has(f.path)) ctx.addIssue({ code: "custom", message: `duplicate path "${f.path}"`, path: ["files"] });
      seen.add(f.path);
    }
    const total = cs.files.reduce((n, f) => n + byteLength(f.content), 0);
    if (total > MAX_TOTAL_BYTES) ctx.addIssue({ code: "custom", message: `change set exceeds ${MAX_TOTAL_BYTES} bytes`, path: ["files"] });
  });

export type ChangeSet = z.infer<typeof ChangeSetSchema>;

export class ChangeSetError extends Error {
  override readonly name: string = "ChangeSetError";
}

/**
 * Pull the JSON object out of an LLM reply (tolerates ```json fences, leading/trailing prose,
 * raw newlines inside strings, and `files` given as a path -> content map), then validate it.
 */
export function parseChangeSet(text: string): ChangeSet {
  if (!text.trim()) throw new ChangeSetError("empty model output (no text; the model may have spent its token budget on reasoning)");
  let lastErr = "no JSON object in model output";
  for (const candidate of jsonCandidates(text)) {
    for (const attempt of [candidate, escapeControlCharsInStrings(candidate)]) {
      let raw: unknown;
      try {
        raw = JSON.parse(attempt);
      } catch (e) {
        lastErr = `change set is not valid JSON: ${(e as Error).message}`;
        continue;
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      return validateChangeSet(normalizeRaw(raw as Record<string, unknown>));
    }
  }
  throw new ChangeSetError(lastErr);
}

/** Common deviations: `files` as a { path: content } map, `contents`/`code` instead of `content`, `filename`/`file` instead of `path`. */
function normalizeRaw(raw: Record<string, unknown>): unknown {
  let files = raw.files;
  if (files && typeof files === "object" && !Array.isArray(files)) {
    files = Object.entries(files as Record<string, unknown>).map(([path, content]) => ({ path, content }));
  }
  if (Array.isArray(files)) {
    files = files.map((f) => {
      if (!f || typeof f !== "object") return f;
      const o = f as Record<string, unknown>;
      return { path: o.path ?? o.filename ?? o.file ?? o.name, content: o.content ?? o.contents ?? o.code };
    });
  }
  return { ...raw, files };
}

export function validateChangeSet(raw: unknown): ChangeSet {
  const r = ChangeSetSchema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ChangeSetError(`invalid change set: ${issues}`);
  }
  return r.data;
}

/** Candidate JSON texts, best first: fenced blocks (last first), the whole reply, then balanced `{...}` spans. */
export function jsonCandidates(text: string): string[] {
  const out: string[] = [];
  const fences = [...text.matchAll(/```(?:json|javascript|js)?[ \t]*\r?\n?([\s\S]*?)```/gi)].map((m) => m[1]!.trim());
  out.push(...fences.reverse());
  out.push(text.trim());
  for (const body of [...out]) {
    for (const span of balancedObjects(body)) out.push(span);
  }
  const seen = new Set<string>();
  return out.filter((c) => c.startsWith("{") && !seen.has(c) && seen.add(c));
}

/** Top-level balanced `{...}` spans (string-aware), longest first. */
function balancedObjects(text: string): string[] {
  const spans: string[] = [];
  for (let start = text.indexOf("{"); start !== -1 && spans.length < 5; ) {
    let depth = 0;
    let inStr = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const c = text[i]!;
      if (inStr) {
        if (c === "\\") i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) break;
    spans.push(text.slice(start, end + 1));
    start = text.indexOf("{", end + 1);
  }
  return spans.sort((a, b) => b.length - a.length);
}

/** Models often emit literal newlines/tabs inside JSON strings; escape them so JSON.parse accepts the text. */
export function escapeControlCharsInStrings(json: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i]!;
    if (inStr) {
      if (c === "\\") {
        out += c + (json[++i] ?? "");
        continue;
      }
      if (c === '"') inStr = false;
      else if (c === "\n") {
        out += "\\n";
        continue;
      } else if (c === "\r") {
        out += "\\r";
        continue;
      } else if (c === "\t") {
        out += "\\t";
        continue;
      }
    } else if (c === '"') inStr = true;
    out += c;
  }
  return out;
}

// ── template fit (worker-starter, no build) ──────────────────────────────

const IMPORT_SPEC_RE = /(?:^|[\n;])\s*(?:import\s+(?:[^"'\n]*?\s+from\s+)?|export\s+[^"'\n]*?\s+from\s+)["']([^"']+)["']/g;

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function resolveRelative(fromFile: string, spec: string): string {
  const parts = dirname(fromFile).split("/").filter(Boolean);
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/** `export const path = "/status"`: a feature module that owns a top-level route (worker-starter router). */
const FEATURE_PATH_RE = /export\s+const\s+path\s*=\s*["'`]([^"'`]*)["'`]/;

const exportsName = (code: string, name: string) =>
  new RegExp(`export\\s+(?:async\\s+)?(?:const|let|var|function\\*?|class)\\s+${name}\\b`).test(code) ||
  new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(code);

/**
 * Problems that would make the change set not run on the no-build template. Static and conservative:
 * relative-only imports that resolve, no TypeScript/JSX, feature modules export `slug` and `handle`
 * (and optionally a literal top-level `path`), and a rewritten router keeps `/health`. Returns human-readable messages (fed to the repair turn).
 */
export function templateFitProblems(cs: Pick<ChangeSet, "files"> & { deletes?: string[] }, repoFiles: Iterable<string> = []): string[] {
  const deleted = new Set(cs.deletes ?? []);
  const known = new Set<string>([...[...repoFiles].filter((f) => !deleted.has(f)), ...cs.files.map((f) => f.path)]);
  const problems: string[] = [];
  for (const f of cs.files) {
    if (/^src\/.*\.(?:ts|tsx|jsx|mts|cts)$/.test(f.path)) problems.push(`${f.path}: only plain .js files are allowed under src/ (no TypeScript/JSX, there is no build step)`);
    if (!/^src\/.*\.js$/.test(f.path)) continue;
    if (/\brequire\s*\(/.test(f.content) || /\bmodule\.exports\b/.test(f.content)) problems.push(`${f.path}: use ES modules (import/export), not require/module.exports`);
    for (const m of f.content.matchAll(IMPORT_SPEC_RE)) {
      const spec = m[1]!;
      if (!spec.startsWith("./") && !spec.startsWith("../")) {
        problems.push(`${f.path}: import "${spec}" is not allowed (relative imports with .js only; no npm packages or Node built-ins)`);
      } else if (!known.has(resolveRelative(f.path, spec))) {
        problems.push(`${f.path}: import "${spec}" does not exist in the repo or your change set (use the exact path with .js)`);
      }
    }
    const isModule = /^src\/features\/(?!index\.js$)[^/]+\.js$/.test(f.path);
    if (isModule) {
      if (!exportsName(f.content, "slug")) problems.push(`${f.path}: feature modules must export const slug = "<slug>"`);
      if (!exportsName(f.content, "handle")) problems.push(`${f.path}: feature modules must export function handle(request)`);
      const route = FEATURE_PATH_RE.exec(f.content)?.[1];
      if (exportsName(f.content, "path") && route === undefined) {
        problems.push(`${f.path}: export the route as a string literal, e.g. export const path = "/status"`);
      } else if (route !== undefined && (!/^\/[A-Za-z0-9._~/-]*$/.test(route) || route === "/" || route === "/health" || route.startsWith("/features/"))) {
        problems.push(`${f.path}: path "${route}" is not allowed (must start with "/", and "/", "/health" and /features/* are owned by the router)`);
      }
    }
    if (f.path === "src/index.js" && !(/\/health/.test(f.content) && /export\s+default/.test(f.content))) {
      problems.push(`src/index.js: must keep "export default { fetch }" with the "/" and "/health" routes working`);
    }
  }
  return problems;
}

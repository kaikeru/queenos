/**
 * Behavioral verify for the no-build template: load the edited Worker (every src/**\/*.js as an ES
 * module, entry from .queen/deploy.json) into a Dynamic Worker via the Worker Loader binding, with
 * outbound network blocked, and fetch a few paths. Proves the routes answer; the Herald + Sentinel
 * remain the deploy truth (no bindings, no network here).
 */
import { templateFitProblems } from "../change-set";

export interface ProbeResult {
  path: string;
  status: number;
  contentType: string | null;
  /** First characters of the body (what the model sees). */
  bodyStart: string;
}

export interface VerifyResult {
  ok: boolean;
  /** True when no Worker Loader binding is configured: verify degrades instead of failing. */
  skipped?: boolean;
  probes: ProbeResult[];
  /** Template-fit problems of the changed files (static checks). */
  problems: string[];
  error?: string;
}

/** The subset of the Worker Loader binding verify uses (tests pass a fake). */
export interface LoaderLike {
  load(code: {
    compatibilityDate: string;
    mainModule: string;
    modules: Record<string, string>;
    globalOutbound: null;
    limits?: { cpuMs?: number };
  }): { getEntrypoint(): { fetch(req: Request): Promise<Response> } };
}

export const VERIFY_CPU_MS = 100;
export const VERIFY_BODY_CHARS = 400;
export const MAX_VERIFY_PATHS = 5;
export const DEFAULT_COMPAT_DATE = "2026-10-02";
const ORIGIN = "https://verify.queenos.invalid";

const isJson = (ct: string | null) => /\bjson\b/i.test(ct ?? "");

export interface VerifyInput {
  /** Full workspace snapshot: repo path (no leading slash) -> content. */
  files: Record<string, string>;
  /** Changed/added files and deletions, for the template-fit checks. */
  changed: { files: { path: string; content: string }[]; deletes: string[] };
  /** Extra paths to GET besides "/" and "/health". */
  paths?: string[];
}

export async function verifyWorker(loader: LoaderLike | undefined, input: VerifyInput): Promise<VerifyResult> {
  const problems = templateFitProblems(input.changed, Object.keys(input.files));
  if (!loader) return { ok: problems.length === 0, skipped: true, probes: [], problems };

  let deploy: { main?: unknown; compatibility_date?: unknown } = {};
  try {
    deploy = JSON.parse(input.files[".queen/deploy.json"] ?? "{}");
  } catch {
    /* default entry */
  }
  const main = typeof deploy.main === "string" ? deploy.main : "src/index.js";
  const modules: Record<string, string> = {};
  for (const [p, c] of Object.entries(input.files)) if (/^src\/.*\.js$/.test(p)) modules[p] = c;
  if (!modules[main]) return { ok: false, probes: [], problems, error: `entry module ${main} is missing` };

  const extra = (input.paths ?? []).filter((p) => p.startsWith("/")).slice(0, MAX_VERIFY_PATHS);
  const paths = [...new Set(["/", "/health", ...extra])];
  try {
    // load() (not get()): a fresh isolate per verify, so no caching across edits.
    const worker = loader.load({
      compatibilityDate: typeof deploy.compatibility_date === "string" ? deploy.compatibility_date : DEFAULT_COMPAT_DATE,
      mainModule: main,
      modules,
      globalOutbound: null,
      limits: { cpuMs: VERIFY_CPU_MS },
    });
    const ep = worker.getEntrypoint();
    const probes: ProbeResult[] = [];
    for (const path of paths) {
      const res = await ep.fetch(new Request(`${ORIGIN}${path}`, { headers: { accept: "text/html,application/json;q=0.9,*/*;q=0.8" } }));
      const body = await res.text();
      probes.push({ path, status: res.status, contentType: res.headers.get("content-type"), bodyStart: body.slice(0, VERIFY_BODY_CHARS) });
    }
    const health = probes.find((p) => p.path === "/health");
    const errors: string[] = [];
    for (const p of probes) if (p.status >= 500) errors.push(`${p.path} returned ${p.status}`);
    if (health && (health.status !== 200 || !isJson(health.contentType))) errors.push(`/health must return 200 JSON (got ${health.status} ${health.contentType ?? "no content-type"})`);
    return {
      ok: errors.length === 0 && problems.length === 0,
      probes,
      problems,
      ...(errors.length ? { error: errors.join("; ") } : {}),
    };
  } catch (e) {
    return { ok: false, probes: [], problems, error: String((e as Error)?.message ?? e).slice(0, 500) };
  }
}

/** One line for the ledger trace, e.g. `verify / 200 text/html; /health 200 json -> ok`. */
export function describeVerify(r: VerifyResult): string {
  if (r.skipped) return `verify skipped (no loader)${r.problems.length ? `, ${r.problems.length} template problem(s)` : ""}`;
  const probes = r.probes.map((p) => `${p.path} ${p.status} ${(p.contentType ?? "").split(";")[0]!.replace(/^application\//, "")}`.trim()).join("; ");
  const why = r.ok ? "ok" : (r.error ?? r.problems[0] ?? "failed");
  return `verify ${probes || "(no probes)"} -> ${why}`.slice(0, 300);
}

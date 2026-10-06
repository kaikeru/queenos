/**
 * Preview smoke test: `GET <previewUrl>/` must answer 2xx.
 *
 * This is the first REAL check in the gate (docs/deploy-discovery.md §2): the
 * Herald deployed the train to a Worker Preview before TESTING, and a 500 here
 * is a bug in the pushed code, not a scripted verdict. The log (status, body
 * snippet) is what the Scribe compacts.
 */

export type SmokeFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface SmokeResult {
  passed: boolean;
  /** Final HTTP status, absent when every attempt failed at the network level. */
  status?: number;
  /** `content-type` of the final response (evidence for the LLM reviewer). */
  contentType?: string;
  /** First ~1 KB of the final response body (evidence for the LLM reviewer). */
  body?: string;
  /** Raw log; kept as the failure log for the Scribe. */
  log: string;
  firstError?: string;
}

/**
 * `base` (`/`, `/health`): must answer 2xx.
 * `feature` (a member's smokePaths, probed with no query string): the route must exist and not crash, so any
 * status below 500 except 404 passes (a 400/401/405/422 is the app deliberately validating its input).
 */
export type SmokeKind = "base" | "feature";

export interface SmokeProbe {
  /** `GET <previewUrl><path>` (default `/`, kind `base`). */
  check(previewUrl: string, path?: string, kind?: SmokeKind): Promise<SmokeResult>;
}

/** Does this status satisfy the probe kind? */
export const smokeStatusOk = (status: number, kind: SmokeKind): boolean =>
  kind === "feature" ? status < 500 && status !== 404 && status >= 100 : status >= 200 && status < 300;

export interface SmokeOptions {
  fetch?: SmokeFetch;
  /** Attempts before giving up (a fresh workers.dev hostname can lag). Default 4. */
  attempts?: number;
  /** Delay between attempts. Default 2000 ms. */
  delayMs?: number;
  /** Per-request timeout. Default 10 s. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const SMOKE_CHECK = "preview smoke > GET / returns 2xx";
/** The check name for one route (the Scribe quotes it). `/` keeps the v1 name. */
export const smokeCheckName = (path: string, kind: SmokeKind = "base") =>
  kind === "feature" ? `preview smoke > GET ${path} is routed and does not crash (not 404, not 5xx)` : path === "/" ? SMOKE_CHECK : `preview smoke > GET ${path} returns 2xx`;
const BODY_SNIPPET_CHARS = 500;
export const EVIDENCE_BODY_CHARS = 1_024;

export class FetchSmokeProbe implements SmokeProbe {
  private readonly fetchFn: SmokeFetch;
  private readonly attempts: number;
  private readonly delayMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: SmokeOptions = {}) {
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.attempts = Math.max(1, opts.attempts ?? 4);
    this.delayMs = opts.delayMs ?? 2_000;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async check(previewUrl: string, path = "/", kind: SmokeKind = "base"): Promise<SmokeResult> {
    const route = path.startsWith("/") ? path : `/${path}`;
    const url = `${previewUrl.replace(/\/+$/, "")}${route}`;
    const lines = [`> smoke: GET ${url} (timeout ${this.timeoutMs}ms, up to ${this.attempts} attempts)`];
    let status: number | undefined;
    let body = "";
    let contentType: string | undefined;
    let networkError: string | undefined;

    for (let i = 1; i <= this.attempts; i++) {
      networkError = undefined;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
      try {
        const res = await this.fetchFn(url, { method: "GET", redirect: "manual", signal: ctl.signal, headers: { "user-agent": "queenos-gatekeeper-smoke" } });
        status = res.status;
        contentType = res.headers.get("content-type") ?? undefined;
        body = (await res.text().catch(() => "")).slice(0, EVIDENCE_BODY_CHARS);
        lines.push(`smoke attempt ${i}/${this.attempts}: HTTP ${status}`);
        if (smokeStatusOk(status, kind)) return { passed: true, status, ...evidence(contentType, body), log: [...lines, `smoke: ok, body: ${oneLine(body.slice(0, BODY_SNIPPET_CHARS))}`].join("\n") };
      } catch (e) {
        status = undefined;
        networkError = ctl.signal.aborted ? `timed out after ${this.timeoutMs}ms` : String((e as Error)?.message ?? e);
        lines.push(`smoke attempt ${i}/${this.attempts}: network failure: ${networkError}`);
      } finally {
        clearTimeout(timer);
      }
      if (i < this.attempts) await this.sleep(this.delayMs);
    }

    const firstError =
      status !== undefined
        ? `AssertionError: preview smoke failed: GET ${route} returned HTTP ${status} (expected ${kind === "feature" ? "a routed, non-crashing response: not 404, not 5xx" : "2xx"})`
        : `AssertionError: preview smoke failed: GET ${route} unreachable after ${this.attempts} attempts (${networkError})`;
    lines.push("", ` FAIL  ${smokeCheckName(route, kind)}`, firstError);
    if (status !== undefined) lines.push(`response body: ${oneLine(body.slice(0, BODY_SNIPPET_CHARS)) || "(empty)"}`);
    return { passed: false, ...(status !== undefined ? { status } : {}), log: lines.join("\n"), firstError };
  }
}

const evidence = (contentType: string | undefined, body: string) => ({ ...(contentType ? { contentType } : {}), body });
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

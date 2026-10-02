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
  /** Raw log; kept as the failure log for the Scribe. */
  log: string;
  firstError?: string;
}

export interface SmokeProbe {
  check(previewUrl: string): Promise<SmokeResult>;
}

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
const BODY_SNIPPET_CHARS = 500;

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

  async check(previewUrl: string): Promise<SmokeResult> {
    const url = `${previewUrl.replace(/\/+$/, "")}/`;
    const lines = [`> smoke: GET ${url} (timeout ${this.timeoutMs}ms, up to ${this.attempts} attempts)`];
    let status: number | undefined;
    let body = "";
    let networkError: string | undefined;

    for (let i = 1; i <= this.attempts; i++) {
      networkError = undefined;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
      try {
        const res = await this.fetchFn(url, { method: "GET", redirect: "manual", signal: ctl.signal, headers: { "user-agent": "queenos-gatekeeper-smoke" } });
        status = res.status;
        body = (await res.text().catch(() => "")).slice(0, BODY_SNIPPET_CHARS);
        lines.push(`smoke attempt ${i}/${this.attempts}: HTTP ${status}`);
        if (status >= 200 && status < 300) return { passed: true, status, log: [...lines, `smoke: ok, body: ${oneLine(body)}`].join("\n") };
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
        ? `AssertionError: preview smoke failed: GET / returned HTTP ${status} (expected 2xx)`
        : `AssertionError: preview smoke failed: GET / unreachable after ${this.attempts} attempts (${networkError})`;
    lines.push("", ` FAIL  ${SMOKE_CHECK}`, firstError);
    if (status !== undefined) lines.push(`response body: ${oneLine(body) || "(empty)"}`);
    return { passed: false, ...(status !== undefined ? { status } : {}), log: lines.join("\n"), firstError };
  }
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

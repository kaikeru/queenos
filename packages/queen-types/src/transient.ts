/**
 * Transient infrastructure errors (pure; shared by the executors). A 503 from
 * Artifacts or the Cloudflare API under load says nothing about the change
 * being built, so executors retry it in place (jittered, so a swarm of
 * concurrent builds does not retry in lockstep) and, if it outlasts that,
 * report it as infrastructure (`TrainResult.cause = "infra"`,
 * `DeployResult.retryable`) instead of failing the change.
 */

const TRANSIENT_STATUS = /\b(?:HTTP(?: Error)?:? ?\(?|status(?: code)?:? ?)(408|425|429|5\d\d)\b/i;
const TRANSIENT_TEXT =
  /Service Unavailable|Bad Gateway|Gateway Timeout|Too Many Requests|rate.?limit|ECONNRESET|ETIMEDOUT|socket hang up|network (?:connection )?(?:lost|error)|fetch failed|Internal Server Error|overloaded/i;

/**
 * Whether `e` is worth retrying: an error object with `retryable: true`
 * (hive-kit CloudflareApiError, AiGatewayError), an HTTP status of 408/425/429/5xx
 * (`status`, isomorphic-git's `data.statusCode`), or a message that says so
 * ("HttpError: HTTP Error: 503 Service Unavailable", "... (HTTP 502) ..."). Works on
 * the message alone, because Workflows re-throws a step's final error re-serialised.
 */
export function isTransientError(e: unknown): boolean {
  if (e === null || e === undefined) return false;
  if (typeof e === "object") {
    const o = e as { retryable?: unknown; status?: unknown; data?: { statusCode?: unknown } };
    if (o.retryable === true) return true;
    if (o.retryable === false) return false;
    for (const s of [o.status, o.data?.statusCode]) {
      if (typeof s === "number" && (s === 408 || s === 425 || s === 429 || (s >= 500 && s <= 599))) return true;
    }
  }
  const msg = String((e as { message?: unknown })?.message ?? e);
  return TRANSIENT_STATUS.test(msg) || TRANSIENT_TEXT.test(msg);
}

/** Full-jitter exponential backoff: uniform in [0, min(maxMs, baseMs·2^(attempt-1))]. `rand` in [0, 1). */
export function jitteredBackoffMs(attempt: number, baseMs: number, maxMs: number, rand: number): number {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.max(0, Math.min(1, rand)) * cap);
}

export interface TransientRetryOptions {
  /** Total tries (first one included). */
  attempts: number;
  baseMs: number;
  maxMs: number;
  sleep: (ms: number) => Promise<unknown>;
  /** Default Math.random. */
  random?: () => number;
  /** Called before each sleep (logging). */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

/** Run `fn`, retrying transient errors (isTransientError) with jittered backoff; anything else is thrown at once. */
export async function retryTransient<T>(fn: () => Promise<T>, o: TransientRetryOptions): Promise<T> {
  const random = o.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= o.attempts || !isTransientError(e)) throw e;
      const delay = jitteredBackoffMs(attempt, o.baseMs, o.maxMs, random());
      o.onRetry?.(attempt, delay, e);
      await o.sleep(delay);
    }
  }
}

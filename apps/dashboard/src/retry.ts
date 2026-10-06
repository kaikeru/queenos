/** Auto-retry policy for the shared fetch hook: 5xx and network errors, with backoff. */
import { ApiError } from "./api";

export const RETRY_TRIES = 3;

export function isRetryable(e: unknown): boolean {
  if (e instanceof ApiError) return e.status === 0 || e.status >= 500;
  return e instanceof TypeError; // fetch network failure
}

/** Delay before retry number `attempt` (1-based): 400ms, 800ms, 1600ms. */
export function retryDelayMs(attempt: number): number {
  return 400 * 2 ** (attempt - 1);
}

/** Run `load`, retrying retryable failures up to `tries` times in total. `wait` and `cancelled` are injectable for tests. */
export async function withRetry<T>(
  load: () => Promise<T>,
  opts: { tries?: number; wait?: (ms: number) => Promise<void>; cancelled?: () => boolean } = {},
): Promise<T> {
  const tries = opts.tries ?? RETRY_TRIES;
  const wait = opts.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await load();
    } catch (e) {
      if (attempt >= tries || !isRetryable(e) || opts.cancelled?.()) throw e;
      await wait(retryDelayMs(attempt));
    }
  }
}

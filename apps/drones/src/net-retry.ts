/**
 * In-step jittered retries for the MERGE / LAND drones' git network calls
 * (Artifacts access, clone, fetch, deepen, push). A 503 under swarm load says
 * nothing about the change; a NOT_FAST_FORWARD / PUSH_REJECTED is a verdict and
 * is never transient (isTransientError only matches 408/425/429/5xx and
 * "Service Unavailable"-style text), so it surfaces at once.
 */
import { retryTransient, type TransientRetryOptions } from "@queenos/queen-types";

/** Tries per network call (first one included). */
export const NET_ATTEMPTS = 4;
export const NET_BASE_MS = 5_000;
export const NET_MAX_MS = 30_000;

/** Overrides for tests (no real waiting). */
export type NetRetry = Partial<Pick<TransientRetryOptions, "attempts" | "baseMs" | "maxMs" | "sleep" | "random" | "onRetry">>;

export function netRetry<T>(net: NetRetry | undefined, fn: () => Promise<T>): Promise<T> {
  return retryTransient(fn, {
    attempts: NET_ATTEMPTS,
    baseMs: NET_BASE_MS,
    maxMs: NET_MAX_MS,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ...net,
  });
}

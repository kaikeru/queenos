/** Sentinel ports: every side effect goes through this object. Tests swap in fakes. */
import type { SentinelVerdict } from "@queenos/queen-types";

/** One timed GET. `status` is null for a network error or timeout. */
export interface ProbeResult {
  status: number | null;
  ms: number;
}
export type Probe = (url: string, headers: Record<string, string>) => Promise<ProbeResult>;

export const REQUEST_TIMEOUT_MS = 5_000;

/** Timed GET over a fetch implementation; never throws. */
export function makeProbe(fetchImpl: typeof fetch = fetch, now: () => number = () => Date.now()): Probe {
  return async (url, headers) => {
    const t0 = now();
    try {
      const r = await fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: "manual" });
      void r.body?.cancel();
      return { status: r.status, ms: Math.max(0, now() - t0) };
    } catch {
      return { status: null, ms: Math.max(0, now() - t0) };
    }
  };
}

/** RPC surface of apps/queen's QueenNode used by the Sentinel. */
export interface QueenPort {
  reportSentinelVerdict(input: SentinelVerdict): Promise<unknown>;
}

/** Cross-script DO binding to QueenNode; one DO per hive, `idFromName(hive)`. */
export function queenRpc(ns: DurableObjectNamespace | undefined, hive: string): QueenPort {
  if (!ns) throw new Error("UNAVAILABLE: QUEEN binding is not configured");
  return ns.get(ns.idFromName(hive)) as unknown as QueenPort;
}

export interface SentinelPorts {
  probe: Probe;
  queen(hive: string): QueenPort;
}

export interface SentinelEnvBindings {
  QUEEN?: DurableObjectNamespace;
}

export function createProdPorts(env: SentinelEnvBindings): SentinelPorts {
  return { probe: makeProbe(), queen: (hive) => queenRpc(env.QUEEN, hive) };
}

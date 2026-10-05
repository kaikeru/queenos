/**
 * SwarmGovernor (v2 design §4.3, item 4; decision D9): one Durable Object
 * named `global` in the queen Worker that leases build slots to hives, so the
 * account-wide Workers AI quota is honoured once more than one hive is busy.
 *
 * - `lease({hive, want, ttlMs})` grants `min(want, ceiling − Σ other unexpired
 *   leases)`, where `ceiling = min(SWARM_MAX_ACTIVE_BUILDS,
 *   ⌊SWARM_AI_RPM / EST_RPM_PER_BUILD⌋)`.
 * - Every hive with demand is guaranteed ⌊ceiling / hivesWithDemand⌋; a hive
 *   asking for more than it holds makes the others shrink at their next renewal.
 * - `want = 0` releases the hive's lease. Leases are a soft ceiling for new
 *   dispatches; running builds are never pre-empted.
 *
 * The Queen calls it before decide(), never inside it. WP0 seam: WP1.13
 * implements it; WP2.1 binds it (`SWARM_GOVERNOR`, a new_sqlite_classes
 * migration tag) and sets the `SWARM_*` vars.
 */
import { DurableObject } from "cloudflare:workers";
import type { SwarmLease, SwarmLeaseRequest } from "@queenos/queen-types";

/** The governor's env vars (strings, as wrangler vars). */
export interface GovernorEnv {
  SWARM_MAX_ACTIVE_BUILDS?: string;
  SWARM_AI_RPM?: string;
}

export interface GovernorCeilings {
  maxActiveBuilds: number;
  aiRpm: number;
}

/** One hive's current lease. */
export interface LeaseRecord {
  hive: string;
  granted: number;
  want: number;
  expiresAt: number;
}

/** Ceilings from env, defaulting to queen-types SWARM_DEFAULTS (64 builds, 240 rpm). */
export function governorCeilings(env: GovernorEnv): GovernorCeilings {
  void env;
  throw new Error("not implemented");
}

/** `min(maxActiveBuilds, ⌊aiRpm / EST_RPM_PER_BUILD⌋)` (queen-types EST_RPM_PER_BUILD = 4). */
export function globalCeiling(c: GovernorCeilings): number {
  void c;
  throw new Error("not implemented");
}

/**
 * Pure lease decision: the new lease for `req.hive` given every hive's lease
 * (expired ones ignored) at `now`. Returns the lease and the updated table.
 */
export function decideLease(
  leases: readonly LeaseRecord[],
  req: SwarmLeaseRequest,
  now: number,
  ceilings: GovernorCeilings,
): { lease: SwarmLease; leases: LeaseRecord[] } {
  void leases;
  void req;
  void now;
  void ceilings;
  throw new Error("not implemented");
}

export class SwarmGovernor extends DurableObject<GovernorEnv> {
  /** Grant (or renew, or with `want = 0` release) a hive's slot lease. */
  async lease(req: SwarmLeaseRequest): Promise<SwarmLease> {
    void req;
    throw new Error("not implemented");
  }
}

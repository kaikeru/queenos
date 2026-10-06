/**
 * SwarmGovernor (v2 design §4.3, item 4; decision D9): one Durable Object
 * named `global` in the queen Worker that leases build slots to hives, so the
 * account-wide Workers AI quota is honoured once more than one hive is busy.
 *
 * - `lease({hive, want, ttlMs})` grants `min(want, ceiling − Σ other unexpired
 *   leases)`, where `ceiling = min(SWARM_MAX_ACTIVE_BUILDS,
 *   ⌊SWARM_AI_RPM / SWARM_RPM_PER_BUILD⌋)` (SWARM_RPM_PER_BUILD defaults to
 *   queen-types EST_RPM_PER_BUILD = 20, a Think tool-loop build).
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
import { EST_RPM_PER_BUILD, SWARM_DEFAULTS, type SwarmLease, type SwarmLeaseRequest } from "@queenos/queen-types";

/** The governor's env vars (strings, as wrangler vars). */
export interface GovernorEnv {
  SWARM_MAX_ACTIVE_BUILDS?: string;
  SWARM_AI_RPM?: string;
  /** Workers AI requests/min one active build makes (default EST_RPM_PER_BUILD). */
  SWARM_RPM_PER_BUILD?: string;
}

export interface GovernorCeilings {
  maxActiveBuilds: number;
  aiRpm: number;
  /** Requests/min per active build; the rpm budget allows ⌊aiRpm / rpmPerBuild⌋ builds. */
  rpmPerBuild: number;
}

/** One hive's current lease. */
export interface LeaseRecord {
  hive: string;
  granted: number;
  want: number;
  expiresAt: number;
}

function posInt(v: string | undefined, fallback: number): number {
  const n = v === undefined ? NaN : Number(v);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Ceilings from env, defaulting to queen-types SWARM_DEFAULTS (64 builds, 240 rpm) and EST_RPM_PER_BUILD (20). */
export function governorCeilings(env: GovernorEnv): GovernorCeilings {
  const rpmPerBuild = posInt(env.SWARM_RPM_PER_BUILD, EST_RPM_PER_BUILD);
  return {
    maxActiveBuilds: posInt(env.SWARM_MAX_ACTIVE_BUILDS, SWARM_DEFAULTS.maxActiveBuilds),
    aiRpm: posInt(env.SWARM_AI_RPM, SWARM_DEFAULTS.aiRpm),
    rpmPerBuild: rpmPerBuild > 0 ? rpmPerBuild : EST_RPM_PER_BUILD,
  };
}

/** `min(maxActiveBuilds, ⌊aiRpm / rpmPerBuild⌋)`: 240 rpm / 20 = 12 live builds. */
export function globalCeiling(c: Pick<GovernorCeilings, "maxActiveBuilds" | "aiRpm"> & { rpmPerBuild?: number }): number {
  return Math.min(c.maxActiveBuilds, Math.floor(c.aiRpm / Math.max(1, c.rpmPerBuild ?? EST_RPM_PER_BUILD)));
}

/**
 * Pure lease decision: the new lease for `req.hive` given every hive's lease
 * (expired ones ignored) at `now`. Returns the lease and the updated table.
 *
 * Grant = min(want, max(room, share)) where `room` is the ceiling minus what
 * the other hives hold, and `share` = ⌊ceiling / hivesWithDemand⌋ is the
 * guaranteed fair share. A hive still short of its share is treated as holding
 * min(want, share) so that a hive over its share shrinks at its next renewal.
 * Leases are a soft ceiling: a hive below its share may be granted slots while
 * others still hold theirs until they renew.
 */
export function decideLease(
  leases: readonly LeaseRecord[],
  req: SwarmLeaseRequest,
  now: number,
  ceilings: GovernorCeilings,
): { lease: SwarmLease; leases: LeaseRecord[] } {
  const ceiling = globalCeiling(ceilings);
  const others = leases.filter((l) => l.hive !== req.hive && l.expiresAt > now);
  const demand = others.filter((l) => l.want > 0).length + (req.want > 0 ? 1 : 0);
  const share = demand > 0 ? Math.floor(ceiling / demand) : ceiling;

  let granted = 0;
  const table = [...others];
  if (req.want > 0) {
    const claimed = others.reduce(
      (sum, l) => sum + (l.want > l.granted ? Math.max(l.granted, Math.min(l.want, share)) : l.granted),
      0,
    );
    granted = Math.min(req.want, Math.max(ceiling - claimed, share));
    table.push({ hive: req.hive, granted, want: req.want, expiresAt: now + req.ttlMs });
  }
  const lease: SwarmLease = {
    hive: req.hive,
    granted,
    expiresAt: req.want > 0 ? now + req.ttlMs : now,
    globalActive: table.reduce((sum, l) => sum + l.granted, 0),
    globalCeiling: ceiling,
    aiRpmCeiling: ceilings.aiRpm,
  };
  return { lease, leases: table };
}

export class SwarmGovernor extends DurableObject<GovernorEnv> {
  protected now(): number {
    return Date.now();
  }

  /** Grant (or renew, or with `want = 0` release) a hive's slot lease. */
  async lease(req: SwarmLeaseRequest): Promise<SwarmLease> {
    // No await below: the read-decide-write is atomic in the single-threaded DO.
    const kv = this.ctx.storage.kv;
    const current = kv.get<LeaseRecord[]>("leases") ?? [];
    const { lease, leases } = decideLease(current, req, this.now(), governorCeilings(this.env));
    kv.put("leases", leases);
    return lease;
  }
}

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SWARM_DEFAULTS, type SwarmLeaseRequest } from "@queenos/queen-types";
import type { QueenNode } from "../src/queen-node";
import { SwarmGovernor, decideLease, globalCeiling, governorCeilings, type GovernorEnv, type LeaseRecord } from "../src/scale/governor";

const C = { maxActiveBuilds: 64, aiRpm: 240 }; // ceiling 60
const stubFor = (ns: string) => env.QUEEN_NODE.get(env.QUEEN_NODE.idFromName(ns));
const req = (hive: string, want: number, ttlMs = 120_000): SwarmLeaseRequest => ({ hive, want, ttlMs });

/** Applies decideLease repeatedly the way the DO does. */
function table() {
  let leases: LeaseRecord[] = [];
  return {
    ask(hive: string, want: number, now: number, ceilings = C) {
      const r = decideLease(leases, req(hive, want), now, ceilings);
      leases = r.leases;
      return r.lease;
    },
    get leases() {
      return leases;
    },
  };
}

describe("ceilings", () => {
  it("defaults, env overrides and the rpm clamp", () => {
    expect(governorCeilings({})).toEqual({ maxActiveBuilds: SWARM_DEFAULTS.maxActiveBuilds, aiRpm: SWARM_DEFAULTS.aiRpm });
    expect(governorCeilings({ SWARM_MAX_ACTIVE_BUILDS: "10", SWARM_AI_RPM: "400" })).toEqual({ maxActiveBuilds: 10, aiRpm: 400 });
    expect(governorCeilings({ SWARM_MAX_ACTIVE_BUILDS: "junk", SWARM_AI_RPM: "-1" })).toEqual(governorCeilings({}));
    expect(globalCeiling(C)).toBe(60); // min(64, 240/4)
    expect(globalCeiling({ maxActiveBuilds: 10, aiRpm: 400 })).toBe(10);
    expect(globalCeiling({ maxActiveBuilds: 1000, aiRpm: 400 })).toBe(100);
  });
});

describe("decideLease", () => {
  it("grants min(want, ceiling) to a lone hive", () => {
    const t = table();
    expect(t.ask("a", 24, 0)).toMatchObject({ granted: 24, expiresAt: 120_000, globalActive: 24, globalCeiling: 60, aiRpmCeiling: 240 });
    expect(t.ask("a", 500, 1)).toMatchObject({ granted: 60 });
  });

  it("limits a second hive to the remaining room", () => {
    const t = table();
    t.ask("a", 24, 0);
    expect(t.ask("b", 100, 1)).toMatchObject({ granted: 36, globalActive: 60 });
  });

  it("renewal replaces the hive's own lease and extends expiry", () => {
    const t = table();
    t.ask("a", 10, 0);
    expect(t.ask("a", 12, 50_000)).toMatchObject({ granted: 12, expiresAt: 170_000, globalActive: 12 });
    expect(t.leases).toHaveLength(1);
  });

  it("expired leases free their slots", () => {
    const t = table();
    t.ask("a", 60, 0);
    expect(t.ask("b", 60, 119_999).granted).toBe(30); // a still holds 60: b gets its fair share (soft ceiling)
    const u = table();
    u.ask("a", 60, 0);
    expect(u.ask("b", 60, 120_000)).toMatchObject({ granted: 60, globalActive: 60 }); // a expired
    expect(u.leases.map((l) => l.hive)).toEqual(["b"]);
  });

  it("fair share: a late hive is guaranteed floor(ceiling / hivesWithDemand), and the greedy one shrinks on renewal", () => {
    const t = table();
    expect(t.ask("a", 60, 0).granted).toBe(60);
    expect(t.ask("b", 60, 1).granted).toBe(30);
    expect(t.ask("a", 60, 2).granted).toBe(30);
    expect(t.ask("b", 60, 3).granted).toBe(30);
    expect(t.ask("c", 60, 4).granted).toBe(20); // 60 / 3
    expect(t.ask("a", 60, 5).granted).toBe(20);
    expect(t.ask("b", 60, 6).granted).toBe(20);
    expect(t.ask("c", 60, 7)).toMatchObject({ granted: 20, globalActive: 60 });
  });

  it("a hive wanting less than its share leaves the rest to others", () => {
    const t = table();
    t.ask("a", 5, 0);
    t.ask("b", 60, 1);
    expect(t.ask("b", 60, 2).granted).toBe(55);
    expect(t.ask("a", 40, 3).granted).toBe(30); // growing a back: guaranteed share
    expect(t.ask("b", 60, 4).granted).toBe(30);
  });

  it("want = 0 releases the lease", () => {
    const t = table();
    t.ask("a", 40, 0);
    t.ask("b", 20, 1);
    expect(t.ask("a", 0, 2)).toMatchObject({ granted: 0, globalActive: 20, hive: "a" });
    expect(t.leases.map((l) => l.hive)).toEqual(["b"]);
    expect(t.ask("b", 60, 3).granted).toBe(60);
    // releasing an unknown hive is a no-op
    expect(t.ask("zzz", 0, 4)).toMatchObject({ granted: 0 });
  });

  it("a zero ceiling grants nothing", () => {
    expect(table().ask("a", 5, 0, { maxActiveBuilds: 0, aiRpm: 240 }).granted).toBe(0);
  });
});

class Clocked extends SwarmGovernor {
  t = 1_000;
  protected override now() {
    return this.t;
  }
}

describe("SwarmGovernor DO class", () => {
  /** A governor over a real SQLite-backed DO state (borrowed from a QueenNode: the binding is wired in Phase 2). */
  async function withGovernor(env: GovernorEnv, fn: (g: Clocked) => Promise<void>) {
    await runInDurableObject(stubFor(`gov-${crypto.randomUUID()}`), async (_q: QueenNode, state) => {
      await fn(new Clocked(state, env));
    });
  }

  it("leases, renews, expires and releases through storage", async () => {
    await withGovernor({ SWARM_MAX_ACTIVE_BUILDS: "10", SWARM_AI_RPM: "400" }, async (g) => {
      expect(await g.lease(req("a", 8))).toMatchObject({ granted: 8, globalCeiling: 10, aiRpmCeiling: 400, expiresAt: 121_000 });
      expect(await g.lease(req("b", 8))).toMatchObject({ granted: 5 });
      g.t = 200_000; // both expired
      expect(await g.lease(req("b", 8))).toMatchObject({ granted: 8, globalActive: 8 });
      expect(await g.lease(req("b", 0))).toMatchObject({ granted: 0, globalActive: 0 });
      expect(await g.lease(req("a", 10))).toMatchObject({ granted: 10 });
    });
  });
});

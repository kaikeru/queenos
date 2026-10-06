/**
 * WP3.4 load test (v2 design §8 row 3.4, §4.3 item 7): 500 sim items through
 * one hive on the real sim ports (test/worker.ts SimQueenNode, fast delays,
 * stepped through the DO alarm). No wall-clock assertions: every bound is a
 * count (rows read, frames, RPCs, event rows). Frame density is measured on
 * the broadcast timestamps (sliding 1 s window), never on how long the run took.
 *
 * Filing: the Oracle caps a decomposition at maxChildrenPerItem <= 24, so
 * demoSwarmPrompt(500) is split into 21 goals (20 x 24 + 20 bullets), each
 * decomposed by the Oracle fake exactly like the 24-item Swarm demo. The
 * bullets keep their unique words and the demo's [race]/[collide]/[batch-fail]
 * markers, so races, merge conflicts and a bisect happen under load too.
 */
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { EVENT_RETENTION_ROWS } from "@queenos/queen-types";
import { demoSwarmPrompt } from "../src/sim/sim-v2";
import type { QueenNode } from "../src/queen-node";
import type { SimQueenNode } from "./worker";

const ITEMS = 500;
const MAX_STEPS = 6000;
const GOAL_SIZE = 24; // the Oracle's maxChildrenPerItem ceiling
const simNs = () => (env as unknown as { SIM_QUEEN: DurableObjectNamespace<SimQueenNode> }).SIM_QUEEN;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Queen RPCs the executors and drones call: the report* surface plus the drone-side writes. */
const RPCS = [
  "reportOracleResult",
  "reportTrainResult",
  "reportBuildResult",
  "reportMergeResult",
  "reportLandResult",
  "reportProvisionResult",
  "reportDeployResult",
  "reportSentinelVerdict",
  "recordScribeSummary",
  "appendAudit",
] as const;

interface Probe {
  rpcs: number;
  /** SQLite row loads (StateCache.sqlReads) added during report RPCs, summed per call. */
  readsInReports: number;
  /** All loads after warm-up (alarms and decide() included). */
  readsTotal: number;
  frames: number[];
  sizes: number[];
  byMethod: Record<string, number>;
}

// Opt-in (~70 s): `pnpm --filter @queenos/queen test:load` sets VITE_QUEEN_LOAD=1 (vite inlines it; workerd has no host env).
const enabled = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_QUEEN_LOAD === "1";
describe.skipIf(!enabled)("WP3.4 load: 500 items through one hive", () => {
  it("lands everything with a warm cache, coalesced frames and a bounded RPC and event budget", async () => {
    const hive = `load-${crypto.randomUUID().slice(0, 8)}`;
    const stub = simNs().get(simNs().idFromName(hive));
    await stub.updateSettings({
      hive,
      user: "load@example.com",
      patch: { guardrails: { maxActiveTrains: 256, maxChildrenPerItem: GOAL_SIZE, maxOpenItems: 100 }, budget: { dailyDispatches: 100_000, dailyCredits: 10_000_000 } },
    });

    // Instrument the live DO instance: RPC counters, per-report read deltas, frame timestamps.
    await runInDurableObject(stub, (q: QueenNode) => {
      const probe: Probe = { rpcs: 0, readsInReports: 0, readsTotal: 0, frames: [], sizes: [], byMethod: {} };
      (globalThis as unknown as { __probe: Probe }).__probe = probe;
      const target = q as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      for (const name of RPCS) {
        const orig = target[name]!.bind(q);
        target[name] = async (...args: unknown[]) => {
          const before = q.cache.sqlReads;
          probe.rpcs++;
          probe.byMethod[name] = (probe.byMethod[name] ?? 0) + 1;
          try {
            return await orig(...args);
          } finally {
            probe.readsInReports += q.cache.sqlReads - before;
          }
        };
      }
      const raw = q as unknown as { broadcastNow: (m: unknown) => void };
      const origBroadcast = raw.broadcastNow.bind(q);
      raw.broadcastNow = (m) => {
        probe.frames.push(Date.now());
        probe.sizes.push((m as { messages?: unknown[] }).messages?.length ?? 1);
        origBroadcast(m);
      };
    });

    const count = (sql: string, ...a: (string | number)[]) =>
      runInDurableObject(stub, (q: QueenNode) => Number(q.sql.exec(sql, ...a).one().n));
    const children = () => count("SELECT COUNT(*) AS n FROM work_items WHERE kind != 'goal' AND parent_id IS NOT NULL");
    const done = () => count("SELECT COUNT(*) AS n FROM work_items WHERE kind != 'goal' AND status IN ('LANDED', 'SHIPPED')");

    // Warm-up: the cache loads once on the first decide(); counters start after that.
    await runDurableObjectAlarm(stub);
    const warmReads = await runInDurableObject(stub, (q: QueenNode) => {
      const p = (globalThis as unknown as { __probe: Probe }).__probe;
      p.readsInReports = 0;
      p.rpcs = 0;
      p.frames.length = 0;
      p.sizes.length = 0;
      p.byMethod = {};
      return q.cache.sqlReads;
    });

    // 500 bullets from the demo prompt, filed as 21 goals of <= 24. User filings
    // are guardrailed (maxOpenItems <= 100, GUARDRAIL_MAX), so intake is rolling:
    // the next goal is filed whenever the hive has room, like a backlogged queue.
    const bullets = demoSwarmPrompt(ITEMS).split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toHaveLength(ITEMS);
    const pending: string[] = [];
    for (let i = 0; i < bullets.length; i += GOAL_SIZE) pending.push(bullets.slice(i, i + GOAL_SIZE).join("\n"));
    const goalCount = pending.length;
    let filed = 0;
    let peakOpen = 0;
    const open = () => count("SELECT COUNT(*) AS n FROM work_items WHERE status NOT IN ('SHIPPED', 'FAILED', 'DUPLICATE', 'CANCELLED')");
    const tryFile = async () => {
      // Stay under the guardrail (it counts the goal and every decomposed child).
      // One goal at a time: its children only exist once the Oracle answers.
      while (pending.length > 0 && (await open()) <= 76 && (await count("SELECT COUNT(*) AS n FROM work_items WHERE status = 'DECOMPOSING'")) === 0) {
        try {
          await stub.submitWork({ namespace: hive, promptText: pending[0]!, decompose: true });
        } catch (e) {
          const by = await runInDurableObject(stub, (q: QueenNode) => q.sql.exec("SELECT kind, status, COUNT(*) AS n FROM work_items GROUP BY 1, 2").toArray());
          throw new Error(`${String(e)} mine=${await open()} filed=${filed} ${JSON.stringify(by)}`);
        }
        pending.shift();
        filed++;
      }
    };

    let guard = 0;
    while (pending.length > 0 || (await done()) < ITEMS) {
      await tryFile();
      peakOpen = Math.max(peakOpen, await open());
      await runDurableObjectAlarm(stub);
      await sleep(2);
      if (++guard > MAX_STEPS) throw new Error(`load: stuck at ${await done()}/${ITEMS} (by ${JSON.stringify(await runInDurableObject(stub, (q: QueenNode) => ({ items: q.sql.exec("SELECT status, COUNT(*) AS n FROM work_items GROUP BY 1").toArray(), rel: q.sql.exec("SELECT phase, COUNT(*) AS n FROM releases GROUP BY 1").toArray(), trains: q.sql.exec("SELECT lane, phase, COUNT(*) AS n FROM merge_trains GROUP BY 1, 2").toArray(), esc: q.sql.exec("SELECT reason, status, COUNT(*) AS n FROM escalations GROUP BY 1, 2").toArray() })))} children ${await children()}, open ${await open()}, pending goals ${pending.length}, steps ${guard})`);
    }
    // One more alarm so the event prune runs at the end state.
    await runDurableObjectAlarm(stub);

    const m = await runInDurableObject(stub, (q: QueenNode) => {
      const p = (globalThis as unknown as { __probe: Probe }).__probe;
      let maxIn1s = 0;
      for (let i = 0, j = 0; i < p.frames.length; i++) {
        while (p.frames[i]! - p.frames[j]! >= 1000) j++;
        maxIn1s = Math.max(maxIn1s, i - j + 1);
      }
      const n = (s: string) => Number(q.sql.exec(s).one().n);
      return {
        rpcs: p.rpcs,
        byMethod: p.byMethod,
        minGapMs: Math.min(...p.frames.slice(1).map((t, i) => t - p.frames[i]!)),
        gapsUnder5ms: p.frames.slice(1).filter((t, i) => t - p.frames[i]! < 5).length,
        gapsUnder95: p.frames.slice(1).filter((t, i) => t - p.frames[i]! < 95).length,
        maxFrameMsgs: Math.max(...p.sizes),
        readsInReports: p.readsInReports,
        readsAfterWarm: q.cache.sqlReads - warmReads,
        frames: p.frames.length,
        maxFramesIn1s: maxIn1s,
        buildTrains: n("SELECT COUNT(*) AS n FROM merge_trains WHERE lane = 'BUILD'"),
        events: n("SELECT COUNT(*) AS n FROM event_log"),
        landed: n("SELECT COUNT(*) AS n FROM work_items WHERE kind != 'goal' AND status IN ('LANDED', 'SHIPPED')"),
        nonLanded: n("SELECT COUNT(*) AS n FROM work_items WHERE kind != 'goal' AND status NOT IN ('LANDED', 'SHIPPED')"),
        children: n("SELECT COUNT(*) AS n FROM work_items WHERE kind != 'goal'"),
      };
    });
    const perTrain = m.rpcs / m.buildTrains;
    console.log("LOAD", JSON.stringify({ ...m, goals: filed, peakOpen, rpcsPerBuildTrain: perTrain }));
    expect(filed).toBe(goalCount);

    expect(m.children).toBeGreaterThanOrEqual(ITEMS);
    expect(m.nonLanded).toBe(0);
    expect(m.landed).toBe(m.children);
    expect.soft(m.readsInReports).toBe(0);
    expect.soft(m.readsAfterWarm).toBe(0);
    expect.soft(m.maxFramesIn1s).toBeLessThanOrEqual(10);
    expect.soft(perTrain).toBeLessThanOrEqual(16);
    expect(m.events).toBeLessThan(EVENT_RETENTION_ROWS);
  }, 3_600_000);
});


/** Sim mode (rework-loop spec §11): two items on one file; the second winner conflicts once, reworks, lands. */
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { reworkDemo, type DemoQueen } from "../src/sim/rework-demo";
import type { SimQueenNode } from "./worker";

const simNs = () => (env as unknown as { SIM_QUEEN: DurableObjectNamespace<SimQueenNode> }).SIM_QUEEN;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("sim: the rework demo", () => {
  it("the second winner conflicts, gets a conflict slot, syncs its base, pushes a rebased head as the same candidate and lands", async () => {
    const hive = `rework-${crypto.randomUUID().slice(0, 8)}`;
    const stub = simNs().get(simNs().idFromName(hive));
    const log = await reworkDemo(stub as unknown as DemoQueen, hive, {
      tick: async () => {
        await runDurableObjectAlarm(stub);
        await sleep(5);
      },
    });
    expect(log.join("\n")).toMatch(/opus: .* LANDED/);
    expect(log.join("\n")).toMatch(/kimi: REJECTED \(conflict in src\/shared\.js\)/);
    expect(log.at(-1)).toMatch(/kimi: rebased head .* LANDED as the same candidate in race /);
  }, 60_000);
});

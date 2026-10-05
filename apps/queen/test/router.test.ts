import { describe, expect, it } from "vitest";
import { MODEL_CATALOG, RouterFloorSchema, type CatalogModel } from "@queenos/queen-types";
import {
  CONTEXT_HEADROOM_TOKENS,
  DEFAULT_POLICY,
  EXPLORE_EVERY,
  INITIAL_FLOOR,
  chooseModel,
  floorAfter,
  route,
  toRouterFloor,
  type FloorState,
  type RouterStats,
} from "../src/models/router";

// Catalog order: frontier DS Pro, Kimi, GLM-5.3; fast DS Flash, GLM Flash, Qwen.
const DS_PRO = "@cf/deepseek-ai/deepseek-v4-pro-0813"; // frontier, cost 9, 1M
const KIMI = "@cf/moonshotai/kimi-k2.7-code"; // frontier, cost 8, 262k
const GLM = "@cf/zai-org/glm-5.3"; // frontier, cost 8, 1M, slow (SLOW_MODEL_HINTS)
const DS_FLASH = "@cf/deepseek-ai/deepseek-v4-flash-0731"; // fast, cost 3, 1M
const GLM_FLASH = "@cf/zai-org/glm-5.3-flash"; // fast, cost 3, 1M
const QWEN = "@cf/qwen/qwen3.8-27b"; // fast, cost 2, 262k

const stat = (model: string, attempts: number, passes: number, over: Partial<RouterStats> = {}): RouterStats => ({
  model,
  role: "builder",
  attempts,
  passes,
  failures: attempts - passes,
  avgBuildMs: null,
  updatedAt: 0,
  ...over,
});
const build = (over: Partial<Parameters<typeof chooseModel>[0]> = {}) => chooseModel({ role: "builder", attempt: 1, promptChars: 200, stats: [], ...over });
const frontierFloor: FloorState = { tier: "frontier", passStreak: 0, aboveStreak: 0, note: null };

describe("router: tier policy and escalation", () => {
  it("a first BUILD routes at the floor (fast by default); all untried, the cheapest wins", () => {
    const c = build();
    expect(c).toMatchObject({ model: QWEN, tier: "fast", role: "builder" });
    expect(c.reason).toBe("fast tier · no track record yet; lowest cost · floor: fast");
  });

  it("REWORK and any attempt >= 2 escalate to frontier, without touching the floor", () => {
    const r = route({ role: "rework", attempt: 2, promptChars: 200, stats: [] });
    expect(r.choice).toMatchObject({ model: KIMI, tier: "frontier", role: "rework" });
    expect(r.choice.reason).toMatch(/^rework → escalated to frontier · frontier tier/);
    expect(r.floorRouted).toBe(false);
    expect(r.floor).toEqual(INITIAL_FLOOR);
    const again = route({ role: "builder", attempt: 2, promptChars: 200, stats: [], floor: { ...frontierFloor, aboveStreak: 2 } });
    expect(again.choice).toMatchObject({ tier: "frontier" });
    expect(again.choice.reason).toMatch(/^attempt 2 → escalated to frontier/);
    expect(again.floor.aboveStreak).toBe(2);
  });

  it("is deterministic and keeps reasons within 200 chars", () => {
    const input = { role: "builder" as const, attempt: 1, promptChars: 900, stats: [stat(QWEN, 3, 2)], dispatchIndex: 3 };
    expect(chooseModel(input)).toEqual(chooseModel(input));
    const long = route({ ...input, floor: { ...frontierFloor, note: "x".repeat(300) } });
    expect(long.choice.reason.length).toBeLessThanOrEqual(200);
  });
});

describe("router: context filtering", () => {
  it("drops models whose window cannot hold the prompt plus headroom", () => {
    // 700k chars ≈ 233k tokens + 64k headroom > 262k: Qwen and Kimi are out.
    expect(build({ promptChars: 700_000 }).model).toBe(DS_FLASH);
    // DS Pro (cost 9) beats GLM-5.3 (cost 8, but slow: x0.8).
    expect(chooseModel({ role: "rework", attempt: 2, promptChars: 700_000, stats: [] }).model).toBe(DS_PRO);
    // Exactly at the limit still fits.
    expect(build({ promptChars: (262_144 - CONTEXT_HEADROOM_TOKENS) * 3 }).model).toBe(QWEN);
  });

  it("steps up a tier when nothing fits in the wanted tier; largest window when nothing fits at all", () => {
    const catalog: CatalogModel[] = [
      { id: "small-fast", label: "s", tier: "fast", contextWindow: 70_000, cost: 1, roles: ["builder"] },
      { id: "big-frontier", label: "b", tier: "frontier", contextWindow: 500_000, cost: 8, roles: ["builder"] },
    ];
    const c = build({ catalog, promptChars: 60_000 });
    expect(c).toMatchObject({ model: "big-frontier", tier: "frontier" });
    expect(c.reason).toContain("fast tier has no fit → frontier");
    const none = build({ catalog, promptChars: 5_000_000 });
    expect(none.model).toBe("big-frontier");
    expect(none.reason).toMatch(/no model fits/);
  });
});

describe("router: cost per success", () => {
  it("a cheap 80% model beats an expensive 95% one", () => {
    const catalog: CatalogModel[] = [
      { id: "pricey", label: "p", tier: "fast", contextWindow: 1e6, cost: 8, roles: ["builder"] },
      { id: "cheap", label: "c", tier: "fast", contextWindow: 1e6, cost: 2, roles: ["builder"] },
    ];
    const c = build({ catalog, stats: [stat("pricey", 20, 19), stat("cheap", 20, 16)] });
    expect(c.model).toBe("cheap");
    expect(c.reason).toContain("best value 16/20 @ cost 2");
    expect(c.fallbacks).toEqual(["pricey"]);
  });

  it("frontier only wins a fast-floor build when the fast record makes it cheaper per success", () => {
    const bad = [stat(QWEN, 10, 0, { failStreak: 3 }), stat(GLM_FLASH, 10, 0), stat(DS_FLASH, 10, 0)];
    const c = build({ stats: bad });
    expect(c.tier).toBe("frontier");
    expect(c.reason).toContain("frontier beats fast on cost per success");
    expect(build({ stats: [stat(QWEN, 10, 6)] }).tier).toBe("fast");
  });

  it("smoothed rates with ties broken by lower cost, then catalog order; streak penalty", () => {
    // GLM Flash 1/1 and Qwen 3/4 are both 2/3 smoothed; Qwen is cheaper anyway.
    expect(build({ stats: [stat(GLM_FLASH, 1, 1), stat(QWEN, 4, 3)] }).model).toBe(QWEN);
    // Qwen poor: DS Flash and GLM Flash tie on value and cost -> catalog order.
    expect(build({ stats: [stat(QWEN, 6, 0)] }).model).toBe(DS_FLASH);
    // DS Flash 3/5 (0.571) beats GLM Flash 2/4 (0.5)... unless it is on a 2-failure streak (0.471).
    const base = [stat(QWEN, 6, 0), stat(GLM_FLASH, 4, 2), stat(DS_FLASH, 5, 3)];
    expect(build({ stats: base }).model).toBe(DS_FLASH);
    expect(build({ stats: [base[0]!, base[1]!, stat(DS_FLASH, 5, 3, { failStreak: 2 })] }).model).toBe(GLM_FLASH);
  });

  it("only learns from the same role: rework stats never steer first-attempt builds", () => {
    const reworkOnly = [stat(DS_FLASH, 10, 10, { role: "rework" }), stat(QWEN, 10, 0, { role: "rework" })];
    expect(build({ stats: reworkOnly }).model).toBe(QWEN);
  });
});

describe("router: slow models", () => {
  it("a hinted or measured-slow model loses its tie (x0.8 value)", () => {
    expect(chooseModel({ role: "rework", attempt: 2, promptChars: 10, stats: [stat(KIMI, 4, 0, { role: "rework" })] }).model).toBe(DS_PRO);
    const slowFlash = [stat(DS_FLASH, 2, 2, { avgBuildMs: 130_000 }), stat(GLM_FLASH, 2, 2, { avgBuildMs: 20_000 }), stat(QWEN, 6, 0)];
    expect(build({ stats: slowFlash }).model).toBe(GLM_FLASH);
  });
});

describe("router: exploration", () => {
  it(`every ${EXPLORE_EVERY}th dispatch tries the least-tried candidate in the tier`, () => {
    const stats = [stat(QWEN, 4, 4), stat(DS_FLASH, 3, 1)]; // GLM Flash untried
    expect(build({ stats, dispatchIndex: 4 }).model).toBe(QWEN);
    const e = build({ stats, dispatchIndex: 5 });
    expect(e.model).toBe(GLM_FLASH);
    expect(e.reason).toContain("exploring least-tried (0 attempts; every 5th dispatch)");
    expect(build({ stats, dispatchIndex: 6 }).model).toBe(QWEN);
    expect(build({ stats, dispatchIndex: 10 }).model).toBe(GLM_FLASH);
  });

  it("explores within the tier (never across) and keeps the normal reason when the best is the least tried", () => {
    const c = build({ stats: [stat(GLM_FLASH, 2, 2), stat(DS_FLASH, 2, 2)], dispatchIndex: 5 });
    expect(c.model).toBe(QWEN);
    expect(c.reason).not.toContain("exploring");
  });
});

describe("router: pin and fallbacks", () => {
  it("MODEL_ROUTER_PIN_BUILDER forces the model; blank is ignored; no exploration and no floor counters", () => {
    const r = route({ role: "builder", attempt: 1, promptChars: 10, stats: [], pin: GLM, dispatchIndex: 5, floor: { ...frontierFloor, aboveStreak: 1 } });
    expect(r.choice).toMatchObject({ model: GLM, tier: "frontier", reason: "pinned by MODEL_ROUTER_PIN_BUILDER" });
    expect(r.floor.aboveStreak).toBe(1);
    expect(chooseModel({ role: "rework", attempt: 2, promptChars: 10, stats: [], pin: "@cf/other/model" })).toMatchObject({
      model: "@cf/other/model",
      tier: "frontier",
      reason: "pinned by MODEL_ROUTER_PIN_BUILDER (rework → escalated to frontier)",
    });
    expect(build({ pin: "  " }).model).toBe(QWEN);
  });

  it("fallbacks: next best in the same tier, then one tier up; at most 2", () => {
    expect(build().fallbacks).toEqual([DS_FLASH, GLM_FLASH]);
    // GLM-5.3 is slow (up to ~150 s of a 200 s budget): last.
    expect(chooseModel({ role: "rework", attempt: 2, promptChars: 10, stats: [] }).fallbacks).toEqual([DS_PRO, GLM]);
    const catalog = MODEL_CATALOG.filter((m) => m.id !== GLM_FLASH && m.id !== DS_FLASH);
    expect(build({ catalog }).fallbacks).toEqual([KIMI]);
  });
});

describe("router: tier floor (AIMD + probes)", () => {
  it("a gate failure or an unusable change set raises the floor one tier (cap frontier)", () => {
    const up = floorAfter({ ...INITIAL_FLOOR, passStreak: 2 }, "gate-fail", "fast", false);
    expect(up).toEqual({ tier: "frontier", passStreak: 0, aboveStreak: 0, note: "raised to frontier after a gate failure" });
    expect(floorAfter(INITIAL_FLOOR, "unusable", "fast", false).note).toBe("raised to frontier after an unusable change set");
    expect(floorAfter(up, "gate-fail", "frontier", false).tier).toBe("frontier");
  });

  it(`backs off one tier after ${DEFAULT_POLICY.backoffStreak} clean builds at the floor, never below the cheapest builder tier`, () => {
    let f = frontierFloor;
    f = floorAfter(f, "pass", "frontier", false);
    f = floorAfter(f, "pass", "frontier", false);
    expect(f).toMatchObject({ tier: "frontier", passStreak: 2 });
    // A pass routed above or below the floor (no probe) does not count.
    expect(floorAfter(f, "pass", "fast", false)).toEqual(f);
    f = floorAfter(f, "pass", "frontier", false);
    expect(f).toEqual({ tier: "fast", passStreak: 0, aboveStreak: 0, note: "backed off to fast after 3 clean builds" });
    for (let i = 0; i < 5; i++) f = floorAfter(f, "pass", "fast", false);
    expect(f.tier).toBe("fast"); // builder models are fast/frontier only
    expect(floorAfter(f, "pass", "fast", false, { backoffStreak: 1, probeAfter: 4 }).tier).toBe("fast");
  });

  it("the floor note prefixes the next floor-routed reason once, with the floor state", () => {
    const raised = floorAfter(INITIAL_FLOOR, "gate-fail", "fast", false);
    const r = route({ role: "builder", attempt: 1, promptChars: 10, stats: [], floor: raised });
    expect(r.choice.tier).toBe("frontier");
    expect(r.choice.reason).toBe("raised to frontier after a gate failure · frontier tier · no track record yet; lowest cost · floor: frontier · 0/3 to back off · probe in 3");
    expect(r.floor).toEqual({ tier: "frontier", passStreak: 0, aboveStreak: 1, note: null });
  });

  it(`probes one tier down after ${DEFAULT_POLICY.probeAfter} floor dispatches above the cheapest tier`, () => {
    let floor = frontierFloor;
    const tiers: string[] = [];
    let probeAt = -1;
    for (let i = 1; i <= 10; i++) {
      const r = route({ role: "builder", attempt: 1, promptChars: 10, stats: [], floor });
      tiers.push(r.choice.tier);
      if (r.probe && probeAt < 0) {
        probeAt = i;
        expect(r.choice.reason).toMatch(/^probe: trying fast tier again · /);
        expect(r.choice.fallbacks).toEqual([DS_FLASH, GLM_FLASH]);
      }
      floor = r.floor;
    }
    expect(tiers).toEqual(["frontier", "frontier", "frontier", "frontier", "fast", "frontier", "frontier", "frontier", "frontier", "fast"]);
    expect(probeAt).toBe(5);
    // Reworks do not advance the probe count.
    const rework = route({ role: "rework", attempt: 2, promptChars: 10, stats: [], floor: { ...frontierFloor, aboveStreak: 3 } });
    expect(rework.floor.aboveStreak).toBe(3);
  });

  it("a probe that passes drops the floor at once; a failed probe keeps it and restarts the count", () => {
    expect(floorAfter({ ...frontierFloor, passStreak: 1 }, "pass", "fast", true)).toEqual({
      tier: "fast",
      passStreak: 0,
      aboveStreak: 0,
      note: "dropped to fast after a probe passed",
    });
    expect(floorAfter(frontierFloor, "gate-fail", "fast", true)).toMatchObject({ tier: "frontier", passStreak: 0, aboveStreak: 0 });
  });

  it("toRouterFloor: the War Room view validates against RouterFloorSchema", () => {
    expect(RouterFloorSchema.parse(toRouterFloor(INITIAL_FLOOR))).toEqual({ tier: "fast", streak: 0, backoffAfter: 3, probeIn: null });
    expect(toRouterFloor({ tier: "frontier", passStreak: 2, aboveStreak: 3, note: null })).toEqual({ tier: "frontier", streak: 2, backoffAfter: 3, probeIn: 1 });
    expect(toRouterFloor({ tier: "light", passStreak: 0, aboveStreak: 0, note: null }).tier).toBe("fast");
  });
});

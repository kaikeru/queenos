import { describe, expect, it } from "vitest";
import { MODEL_CATALOG, RouterFloorSchema, type CatalogModel } from "@queenos/queen-types";
import {
  CONTEXT_HEADROOM_TOKENS,
  DEFAULT_POLICY,
  EXPLORE_EVERY,
  INITIAL_FLOOR,
  cheapestBuilderTier,
  chooseModel,
  floorAfter,
  route,
  routeRace,
  toRouterFloor,
  vendorOf,
  type FloorState,
  type RouterStats,
} from "../src/models/router";

// Catalog order: frontier DS Pro, Kimi, GLM-5.3; fast DS Flash, GLM Flash, Qwen.
const DS_PRO = "@cf/deepseek-ai/deepseek-v4-pro-0813"; // frontier, cost 9, 1M
const KIMI = "@cf/moonshotai/kimi-k2.7-code"; // frontier, cost 8, 262k
const GLM = "@cf/zai-org/glm-5.3"; // frontier, cost 8, 1M, slow (catalog flag)
const DS_FLASH = "@cf/deepseek-ai/deepseek-v4-flash-0731"; // fast, cost 3, 1M
const GLM_FLASH = "@cf/zai-org/glm-5.3-flash"; // fast, cost 3, 1M
const QWEN = "@cf/qwen/qwen3.8-27b"; // fast, cost 2, 262k, toolLoop: false (never builder/rework)

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
    expect(c).toMatchObject({ model: DS_FLASH, tier: "fast", role: "builder" });
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
    // 700k chars ≈ 233k tokens + 64k headroom > 262k: Kimi is out.
    expect(build({ promptChars: 700_000 }).model).toBe(DS_FLASH);
    // DS Pro (cost 9) beats GLM-5.3 (cost 8, but slow: x0.8).
    expect(chooseModel({ role: "rework", attempt: 2, promptChars: 700_000, stats: [] }).model).toBe(DS_PRO);
    // Exactly at the limit still fits.
    expect(chooseModel({ role: "rework", attempt: 2, promptChars: (262_144 - CONTEXT_HEADROOM_TOKENS) * 3, stats: [] }).model).toBe(KIMI);
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
    expect(build({ stats: [stat(DS_FLASH, 10, 6)] }).tier).toBe("fast");
  });

  it("smoothed rates with ties broken by lower cost, then catalog order; streak penalty", () => {
    // GLM Flash 1/1 and DS Flash 3/4 are both 2/3 smoothed, same cost -> catalog order.
    expect(build({ stats: [stat(GLM_FLASH, 1, 1), stat(DS_FLASH, 4, 3)] }).model).toBe(DS_FLASH);
    // DS Flash poor: GLM Flash wins.
    expect(build({ stats: [stat(DS_FLASH, 6, 0)] }).model).toBe(GLM_FLASH);
    // DS Flash 3/5 (0.571) beats GLM Flash 2/4 (0.5)... unless it is on a 2-failure streak (0.471).
    const base = [stat(GLM_FLASH, 4, 2), stat(DS_FLASH, 5, 3)];
    expect(build({ stats: base }).model).toBe(DS_FLASH);
    expect(build({ stats: [base[0]!, stat(DS_FLASH, 5, 3, { failStreak: 2 })] }).model).toBe(GLM_FLASH);
  });

  it("only learns from the same role: rework stats never steer first-attempt builds", () => {
    const reworkOnly = [stat(GLM_FLASH, 10, 10, { role: "rework" }), stat(DS_FLASH, 10, 0, { role: "rework" })];
    expect(build({ stats: reworkOnly }).model).toBe(DS_FLASH);
  });
});

describe("router: slow models", () => {
  it("a hinted or measured-slow model loses its tie (x0.8 value)", () => {
    expect(chooseModel({ role: "rework", attempt: 2, promptChars: 10, stats: [stat(KIMI, 4, 0, { role: "rework" })] }).model).toBe(DS_PRO);
    const slowFlash = [stat(DS_FLASH, 2, 2, { avgBuildMs: 130_000 }), stat(GLM_FLASH, 2, 2, { avgBuildMs: 20_000 })];
    expect(build({ stats: slowFlash }).model).toBe(GLM_FLASH);
  });
});

describe("router: catalog slow flag", () => {
  const mk = (id: string, slow?: boolean): CatalogModel => ({ id, label: id, tier: "fast", contextWindow: 1e6, cost: 2, roles: ["builder"], ...(slow !== undefined ? { slow } : {}) });

  it("the real catalog flags GLM-5.3 (and only it) as slow", () => {
    expect(MODEL_CATALOG.filter((m) => m.slow).map((m) => m.id)).toEqual([GLM]);
  });

  it("slow comes from the catalog entry, not a hard-coded id list", () => {
    // Equal cost and record: the unflagged model wins even though it is listed later.
    expect(build({ catalog: [mk("a", true), mk("b")] }).model).toBe("b");
    expect(build({ catalog: [mk("a"), mk("b", true)] }).model).toBe("a");
    // Flagging GLM-5.3 off in a custom catalog removes the discount (GLM, cost 8, then beats DS Pro, cost 9... and Kimi loses on catalog order only).
    const unflagged = MODEL_CATALOG.map((m) => (m.id === GLM ? { ...m, slow: undefined } : m));
    expect(chooseModel({ role: "rework", attempt: 2, promptChars: 10, stats: [], catalog: unflagged }).fallbacks).toEqual([GLM, DS_PRO]);
  });

  it("a measured-slow model is still discounted without the flag", () => {
    expect(build({ catalog: [mk("a"), mk("b")], stats: [stat("a", 2, 2, { avgBuildMs: 130_000 }), stat("b", 2, 2)] }).model).toBe("b");
  });
});

describe("router: toolLoop (builder and rework only run tool-loop models)", () => {
  const mk = (id: string, cost: number, over: Partial<CatalogModel> = {}): CatalogModel => ({ id, label: id, tier: "fast", contextWindow: 1e6, cost, roles: ["builder", "rework"], ...over });

  it("the real catalog marks only Qwen 3.8 as toolLoop: false", () => {
    expect(MODEL_CATALOG.filter((m) => m.toolLoop === false).map((m) => m.id)).toEqual([QWEN]);
  });

  it("never picks a toolLoop: false model even when it is the cheapest, nor lists it as a fallback", () => {
    const catalog = [mk("no-loop", 1, { toolLoop: false }), mk("ok-a", 2), mk("ok-b", 3)];
    const c = build({ catalog });
    expect(c.model).toBe("ok-a");
    expect(c.fallbacks).toEqual(["ok-b"]);
    // Even a perfect track record does not bring it back.
    expect(build({ catalog, stats: [stat("no-loop", 50, 50)] }).model).toBe("ok-a");
    // Exploration of the least-tried model stays inside the usable set.
    expect(build({ catalog, dispatchIndex: EXPLORE_EVERY, stats: [stat("ok-a", 3, 3), stat("ok-b", 3, 3)] }).model).not.toBe("no-loop");
    // Rework escalation too.
    const frontier = [mk("no-loop", 1, { tier: "frontier", toolLoop: false }), mk("ok", 9, { tier: "frontier" })];
    const rework = chooseModel({ role: "rework", attempt: 2, promptChars: 10, stats: [], catalog: frontier });
    expect(rework.model).toBe("ok");
    expect(rework.fallbacks).toEqual([]);
  });

  it("an explicit toolLoop: true or absent flag is usable", () => {
    expect(build({ catalog: [mk("a", 1, { toolLoop: true })] }).model).toBe("a");
    expect(build({ catalog: [mk("a", 1)] }).model).toBe("a");
  });

  it("the floor default never lands on one: a tier holding only toolLoop: false models is not a builder tier", () => {
    const catalog = [mk("no-loop", 1, { toolLoop: false }), mk("front", 8, { tier: "frontier" })];
    expect(cheapestBuilderTier(catalog)).toBe("frontier");
    const c = build({ catalog });
    expect(c).toMatchObject({ model: "front", tier: "frontier" });
    expect(c.reason).toContain("floor: frontier");
  });

  it("real catalog: no builder or rework choice or fallback is ever Qwen", () => {
    for (const role of ["builder", "rework"] as const) {
      for (const attempt of [1, 2]) {
        for (let dispatchIndex = 0; dispatchIndex <= 10; dispatchIndex++) {
          for (const stats of [[], [stat(QWEN, 30, 30, { role })], [stat(DS_FLASH, 10, 0, { role }), stat(GLM_FLASH, 10, 0, { role })]]) {
            const c = chooseModel({ role, attempt, promptChars: 200, stats, dispatchIndex });
            expect([c.model, ...c.fallbacks]).not.toContain(QWEN);
          }
        }
      }
    }
  });

  it("with only toolLoop: false builders, the no-fit fallback is still not one of them when another exists", () => {
    const catalog = [mk("no-loop", 1, { toolLoop: false, contextWindow: 9e9 }), mk("small", 2, { contextWindow: 70_000 })];
    expect(build({ catalog, promptChars: 5_000_000 }).model).toBe("small");
  });
});

describe("router: exploration", () => {
  it(`every ${EXPLORE_EVERY}th dispatch tries the least-tried candidate in the tier`, () => {
    const stats = [stat(DS_FLASH, 4, 4)]; // GLM Flash untried
    expect(build({ stats, dispatchIndex: 4 }).model).toBe(DS_FLASH);
    const e = build({ stats, dispatchIndex: 5 });
    expect(e.model).toBe(GLM_FLASH);
    expect(e.reason).toContain("exploring least-tried (0 attempts; every 5th dispatch)");
    expect(build({ stats, dispatchIndex: 6 }).model).toBe(DS_FLASH);
    expect(build({ stats, dispatchIndex: 10 }).model).toBe(GLM_FLASH);
  });

  it("explores within the tier (never across) and keeps the normal reason when the best is the least tried", () => {
    const c = build({ stats: [stat(DS_FLASH, 2, 2), stat(GLM_FLASH, 5, 3)], dispatchIndex: 5 });
    expect(c.model).toBe(DS_FLASH);
    expect(c.reason).not.toContain("exploring");
  });
});

describe("router: load spread (Workers AI limits are per model)", () => {
  it("moves a dispatch to the least-in-flight model of the same tier, round-robin across a burst", () => {
    const inFlight: Record<string, number> = {};
    const picks: string[] = [];
    for (let i = 0; i < 6; i++) {
      const c = build({ inFlight: { ...inFlight } });
      picks.push(c.model);
      inFlight[c.model] = (inFlight[c.model] ?? 0) + 1;
      expect(c.tier).toBe("fast");
    }
    expect(picks).toEqual([DS_FLASH, GLM_FLASH, DS_FLASH, GLM_FLASH, DS_FLASH, GLM_FLASH]);
    const spread = build({ inFlight: { [DS_FLASH]: 3, [GLM_FLASH]: 1 } });
    expect(spread).toMatchObject({ model: GLM_FLASH, fallbacks: [DS_FLASH, KIMI] });
    expect(spread.reason).toContain("spread: 3 in flight on DeepSeek V4 Flash, 1 here");
  });

  it("never crosses tiers, never overrides a pin, and skips a much worse model", () => {
    // Escalated (frontier) dispatches spread among the frontier models only.
    const r = chooseModel({ role: "rework", attempt: 2, promptChars: 200, stats: [], inFlight: { [KIMI]: 2 } });
    expect(r.tier).toBe("frontier");
    expect(r.model).not.toBe(KIMI);
    expect(build({ pin: GLM, inFlight: { [GLM]: 9 } }).model).toBe(GLM);
    // GLM Flash at 1/10 is worth < half of DS Flash at 9/10: load stays on DS Flash.
    expect(build({ stats: [stat(DS_FLASH, 10, 9), stat(GLM_FLASH, 10, 1)], inFlight: { [DS_FLASH]: 4 } }).model).toBe(DS_FLASH);
    // No load: unchanged choice.
    expect(build({ inFlight: {} }).model).toBe(DS_FLASH);
  });

  it("the floor moves exactly as without the spread", () => {
    const a = route({ role: "builder", attempt: 1, promptChars: 200, stats: [], floor: frontierFloor });
    const b = route({ role: "builder", attempt: 1, promptChars: 200, stats: [], floor: frontierFloor, inFlight: { [a.choice.model]: 5 } });
    expect(b.floor).toEqual(a.floor);
    expect(b.choice.tier).toBe(a.choice.tier);
    expect(b.choice.model).not.toBe(a.choice.model);
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
    expect(build({ pin: "  " }).model).toBe(DS_FLASH);
  });

  it("fallbacks: next best in the same tier, then one tier up; at most 2", () => {
    expect(build().fallbacks).toEqual([GLM_FLASH, KIMI]);
    // GLM-5.3 is slow (up to ~150 s of a 200 s budget): last.
    expect(chooseModel({ role: "rework", attempt: 2, promptChars: 10, stats: [] }).fallbacks).toEqual([DS_PRO, GLM]);
    // Only Qwen (toolLoop: false) is left in the fast tier: the builder starts in frontier.
    const catalog = MODEL_CATALOG.filter((m) => m.id !== GLM_FLASH && m.id !== DS_FLASH);
    const c = build({ catalog });
    expect(c).toMatchObject({ model: KIMI, tier: "frontier" });
    expect(c.fallbacks).toEqual([DS_PRO, GLM]);
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

  it("at the lowest builder tier the floor text has no back-off phrase; above it, it does", () => {
    const low = route({ role: "builder", attempt: 1, promptChars: 10, stats: [] });
    expect(low.choice.reason).toBe("fast tier · no track record yet; lowest cost · floor: fast");
    expect(low.choice.reason).not.toContain("back off");
    expect(route({ role: "builder", attempt: 1, promptChars: 10, stats: [], floor: frontierFloor }).choice.reason).toContain("to back off");
    expect(toRouterFloor(INITIAL_FLOOR).probeIn).toBeNull();
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
        expect(r.choice.fallbacks).toEqual([GLM_FLASH, KIMI]);
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

describe("router: routeRace (best-of-N)", () => {
  const base = { role: "builder" as const, attempt: 1, promptChars: 1000, stats: [] as RouterStats[] };

  it("returns distinct models: the value pick at the floor, then the next best preferring a new vendor", () => {
    const choices = routeRace(base, 3);
    expect(choices.map((c) => c.model)).toEqual([DS_FLASH, GLM_FLASH, KIMI]);
    expect(new Set(choices.map((c) => vendorOf(c.model))).size).toBe(3);
    expect(choices.map((c) => c.reason.slice(0, 8))).toEqual(["race 1/3", "race 2/3", "race 3/3"]);
    expect(choices.every((c) => c.role === "builder")).toBe(true);
  });

  it("each candidate's fallbacks exclude every sibling's model", () => {
    const choices = routeRace(base, 3);
    const ids = choices.map((c) => c.model);
    for (const c of choices) {
      expect(c.fallbacks.some((f) => ids.includes(f))).toBe(false);
      expect(c.fallbacks.length).toBeLessThanOrEqual(2);
    }
  });

  it("a rework race starts at frontier; tiers below are used only when the frontier is exhausted", () => {
    const choices = routeRace({ ...base, role: "rework", attempt: 2 }, 4);
    expect(choices.slice(0, 3).map((c) => c.tier)).toEqual(["frontier", "frontier", "frontier"]);
    expect(new Set(choices.slice(0, 3).map((c) => c.model))).toEqual(new Set([DS_PRO, KIMI, GLM]));
    expect(choices[3]).toMatchObject({ model: DS_FLASH, tier: "fast" });
  });

  it("never probes or explores, whatever the floor counters and dispatch index", () => {
    const floor: FloorState = { tier: "frontier", passStreak: 0, aboveStreak: 99, note: null };
    const choices = routeRace({ ...base, floor, dispatchIndex: EXPLORE_EVERY }, 2);
    expect(choices.map((c) => c.tier)).toEqual(["frontier", "frontier"]);
    expect(choices[0]!.reason).not.toMatch(/probe: trying|exploring least-tried/);
  });

  it("a pin cannot race: one choice; width 1 is route()'s pick; no tool-loop-less model is ever chosen", () => {
    expect(routeRace({ ...base, pin: KIMI }, 3).map((c) => c.model)).toEqual([KIMI]);
    expect(routeRace(base, 1).map((c) => c.model)).toEqual([route(base).choice.model]);
    expect(routeRace(base, 5).map((c) => c.model)).not.toContain(QWEN);
  });

  it("narrows to the distinct models available", () => {
    const tiny: CatalogModel[] = MODEL_CATALOG.filter((m) => m.id === DS_FLASH || m.id === GLM_FLASH);
    expect(routeRace({ ...base, catalog: tiny }, 3).map((c) => c.model)).toEqual([DS_FLASH, GLM_FLASH]);
  });

  it("prefers the better track record within the starting tier", () => {
    const stats = [stat(GLM_FLASH, 10, 10), stat(DS_FLASH, 10, 2)];
    expect(routeRace({ ...base, stats }, 2).map((c) => c.model)).toEqual([GLM_FLASH, DS_FLASH]);
  });
});

import { describe, expect, it } from "vitest";
import { MODEL_CATALOG, type GateScore } from "@queenos/queen-types";
import { EST_BUILD_CREDITS, EST_BUILD_TOKENS, buildCredits, kb, pathRisk, raceWidth, rankCandidates, type RaceCandidate } from "../src/train/race";

const score = (over: Partial<GateScore> = {}): GateScore => ({ review: "approved", satisfied: 4, missing: 0, changedFiles: 2, changedBytes: 3000, checks: 5, ...over });
const cand = (trainId: string, candidate: number, over: Partial<RaceCandidate> = {}): RaceCandidate => ({ trainId, candidate, passed: true, ...over });

describe("raceWidth", () => {
  const race = { reworkWidth: 2, hardWidth: 3 };
  it.each([
    ["a normal BUILD", { action: "BUILD" as const }, 1],
    ["a hard BUILD", { action: "BUILD" as const, difficulty: "hard" as const }, 3],
    ["a REWORK", { action: "REWORK" as const }, 2],
    ["bestOf wins over the defaults", { action: "BUILD" as const, bestOf: 2, difficulty: "hard" as const }, 2],
    ["bestOf on a rework", { action: "REWORK" as const, bestOf: 1 }, 1],
    ["capped by maxRaceWidth", { action: "BUILD" as const, bestOf: 5, maxRaceWidth: 3 }, 3],
    ["capped by free slots", { action: "BUILD" as const, bestOf: 3, slotsFree: 2 }, 2],
    ["never below 1 (no free slots)", { action: "BUILD" as const, bestOf: 3, slotsFree: 0 }, 1],
    ["a pin cannot race", { action: "REWORK" as const, bestOf: 3, modelPin: "@cf/x/y" }, 1],
    ["enough budget", { action: "BUILD" as const, difficulty: "hard" as const, remainingCredits: 900 }, 3],
    ["budget too low → 1", { action: "BUILD" as const, difficulty: "hard" as const, remainingCredits: 899 }, 1],
    ["a rework is priced at frontier", { action: "REWORK" as const, remainingCredits: 1799 }, 1],
    ["no budget check when null", { action: "REWORK" as const, remainingCredits: null }, 2],
  ])("%s", (_name, input, want) => {
    expect(raceWidth({ race, ...input })).toBe(want);
  });

  it("defaults: HiveSettings.race 2/3 and maxRaceWidth 3", () => {
    expect(raceWidth({ action: "REWORK" })).toBe(2);
    expect(raceWidth({ action: "BUILD", bestOf: 5 })).toBe(3);
  });
});

describe("credits", () => {
  it("EST_BUILD_CREDITS covers the dearest builder model of each tier", () => {
    for (const tier of ["fast", "frontier"] as const) {
      const max = Math.max(...MODEL_CATALOG.filter((m) => m.tier === tier && m.roles.includes("builder")).map((m) => m.cost));
      expect(EST_BUILD_CREDITS[tier]).toBeGreaterThanOrEqual((EST_BUILD_TOKENS / 1000) * max);
    }
    expect(EST_BUILD_CREDITS.light).toBeLessThan(EST_BUILD_CREDITS.fast);
  });

  it("buildCredits = tokens / 1000 × catalog cost; null when unknown", () => {
    expect(buildCredits({ inputTokens: 90_000, outputTokens: 10_000 }, "@cf/deepseek-ai/deepseek-v4-flash-0731")).toBe(300);
    expect(buildCredits(undefined, "@cf/deepseek-ai/deepseek-v4-flash-0731")).toBeNull();
    expect(buildCredits({ inputTokens: 1, outputTokens: 1 }, "scripted")).toBeNull();
  });
});

describe("pathRisk", () => {
  it("counts changed paths outside the prediction; generated paths and empty predictions never count", () => {
    expect(pathRisk(["src/a.js", "src/lib/x.js", "src/features/index.js"], ["src/a.js", "src/lib/"])).toBe(0);
    expect(pathRisk(["src/a.js", "src/b.js", "README.md"], ["src/a.js"])).toBe(2);
    expect(pathRisk(["src/ab.js"], ["src/a"])).toBe(1); // a sibling prefix is not a directory
    expect(pathRisk(["src/a.js", "src/b.js"], [])).toBe(0);
    expect(pathRisk(null, ["src/a.js"])).toBe(0);
  });
});

describe("rankCandidates", () => {
  const winnerOf = (cs: RaceCandidate[], predictedPaths: string[] = []) => rankCandidates(cs, { predictedPaths }).winner?.trainId;

  it("1. a passed gate beats a failed one", () => {
    expect(winnerOf([cand("a", 0, { passed: false, score: score() }), cand("b", 1, { score: score({ review: "off" }) })])).toBe("b");
  });
  it("2. reviewer approved beats skipped/off", () => {
    expect(winnerOf([cand("a", 0, { score: score({ review: "skipped", missing: 0 }) }), cand("b", 1, { score: score({ missing: 2 }) })])).toBe("b");
  });
  it("3. fewer missing, then more satisfied", () => {
    expect(winnerOf([cand("a", 0, { score: score({ missing: 1, satisfied: 9 }) }), cand("b", 1, { score: score({ missing: 0, satisfied: 1 }) })])).toBe("b");
    expect(winnerOf([cand("a", 0, { score: score({ satisfied: 3 }) }), cand("b", 1, { score: score({ satisfied: 4 }) })])).toBe("b");
  });
  it("4. builder verified", () => {
    expect(winnerOf([cand("a", 0, { score: score(), verified: false }), cand("b", 1, { score: score(), verified: true })])).toBe("b");
  });
  it("5. fewer claimed paths outside the predicted paths (merge risk) beats a smaller diff", () => {
    const a = cand("a", 0, { score: score({ changedBytes: 100 }), changedPaths: ["src/a.js", "src/other.js"] });
    const b = cand("b", 1, { score: score({ changedBytes: 9000 }), changedPaths: ["src/a.js"] });
    expect(winnerOf([a, b], ["src/a.js"])).toBe("b");
    expect(winnerOf([a, b], [])).toBe("a"); // no prediction: no risk signal
  });
  it("6. smaller changedBytes, 7. fewer credits, 8. lower candidate index", () => {
    expect(winnerOf([cand("a", 0, { score: score({ changedBytes: 5000 }) }), cand("b", 1, { score: score({ changedBytes: 4000 }) })])).toBe("b");
    expect(winnerOf([cand("a", 0, { score: score(), credits: 900 }), cand("b", 1, { score: score(), credits: 300 })])).toBe("b");
    expect(winnerOf([cand("b", 1, { score: score() }), cand("a", 0, { score: score() })])).toBe("a");
  });
  it("a pre-v2 gate (no score) still decides on pass/fail and index", () => {
    expect(winnerOf([cand("x", 2), cand("y", 1), cand("z", 0, { passed: false })])).toBe("y");
  });
  it("is deterministic and records why, on the race and on each loser", () => {
    const cs = [
      cand("a", 0, { score: score({ changedBytes: 10035 }), model: "@cf/deepseek-ai/deepseek-v4-flash-0731" }),
      cand("b", 1, { score: score({ changedBytes: 3174 }), model: "@cf/deepseek-ai/deepseek-v4-pro-0813" }),
      cand("c", 2, { score: score({ review: "skipped" }) }),
    ];
    const r = rankCandidates(cs);
    expect(rankCandidates([...cs].reverse()).ranked.map((c) => c.trainId)).toEqual(r.ranked.map((c) => c.trainId));
    expect(r.ranked.map((c) => c.trainId)).toEqual(["b", "a", "c"]);
    expect(r.reason).toBe("won: reviewer approved (4/0), 3.1 KB vs 9.8 KB; DeepSeek V4 Pro");
    expect(r.lostBecause).toEqual({ a: "3.1 KB vs 9.8 KB", c: "reviewer approved (4/0)" });
    expect(rankCandidates([cs[0]!]).reason).toBe("won: reviewer approved (4/0), only candidate; DeepSeek V4 Flash");
    expect(rankCandidates([]).winner).toBeNull();
  });
  it("kb formats bytes", () => {
    expect([kb(512), kb(3174)]).toEqual(["512 B", "3.1 KB"]);
  });
});

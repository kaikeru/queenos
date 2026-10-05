import { expect, test } from "vitest";
import { MODEL_CATALOG, type ModelStats } from "@queenos/queen-types";
import { TIERS, buildModelBoard, formatDuration, isEscalation, modelLabel, pickLeader, tierClass, tierOf } from "../src/models";

const stat = (model: string, attempts: number, passes: number, avgBuildMs: number | null = 1000, role: ModelStats["role"] = "builder"): ModelStats => ({
  model,
  role,
  attempts,
  passes,
  failures: attempts - passes,
  avgBuildMs,
  updatedAt: 1,
});
const FLASH = "@cf/zai-org/glm-5.3-flash";
const DEEP = "@cf/deepseek-ai/deepseek-v4-flash-0731";
const KIMI = "@cf/moonshotai/kimi-k2.7-code";

test("tier badge mapping: tier lookup, class and labels", () => {
  expect(tierOf(KIMI)).toBe("frontier");
  expect(tierOf(FLASH)).toBe("fast");
  expect(tierOf("@cf/meta/llama-3.2-3b-instruct")).toBe("light");
  expect(tierOf("mystery/model")).toBeNull();
  expect(tierOf(null)).toBeNull();
  expect(tierClass("frontier")).toBe("tier tier--frontier");
  expect(tierClass("light")).toBe("tier tier--light");
  expect(modelLabel(FLASH)).toBe("GLM-5.3 Flash");
  expect(modelLabel("mystery/model")).toBe("mystery/model");
});

test("isEscalation compares tiers and ignores unknown models", () => {
  expect(isEscalation(FLASH, KIMI)).toBe(true);
  expect(isEscalation(FLASH, DEEP)).toBe(false);
  expect(isEscalation(KIMI, FLASH)).toBe(false);
  expect(isEscalation("mystery", KIMI)).toBe(false);
  expect(isEscalation(undefined, KIMI)).toBe(false);
});

test("board has every catalog model once, grouped by tier", () => {
  const board = buildModelBoard([]);
  expect(board.map((g) => g.tier)).toEqual([...TIERS]);
  expect(board.flatMap((g) => g.rows).length).toBe(MODEL_CATALOG.length);
  for (const g of board) for (const r of g.rows) expect(r.model.tier).toBe(g.tier);
});

test("untried rows: catalog models with no data, never leaders", () => {
  const board = buildModelBoard([stat(FLASH, 4, 3)]);
  const rows = board.flatMap((g) => g.rows);
  const flash = rows.find((r) => r.model.id === FLASH)!;
  expect(flash.untried).toBe(false);
  expect(flash.passRate).toBe(0.75);
  const qwen = rows.find((r) => r.model.id === "@cf/qwen/qwen3.8-27b")!;
  expect(qwen).toMatchObject({ untried: true, attempts: 0, passRate: null, avgBuildMs: null, leader: false });
  expect(board.find((g) => g.tier === "frontier")!.rows.some((r) => r.leader)).toBe(false);
});

test("leader selection: best pass rate, ties go to more attempts, then cheaper", () => {
  const leaderOf = (stats: ModelStats[], tier: "fast" | "frontier" = "fast") => buildModelBoard(stats).find((g) => g.tier === tier)!.rows.find((r) => r.leader)?.model.id;
  expect(leaderOf([stat(FLASH, 10, 6), stat(DEEP, 5, 4)])).toBe(DEEP);
  expect(leaderOf([stat(FLASH, 10, 8), stat(DEEP, 5, 4)])).toBe(FLASH); // 0.8 each, more attempts wins
  expect(leaderOf([stat(FLASH, 4, 2), stat("@cf/qwen/qwen3.8-27b", 4, 2)])).toBe("@cf/qwen/qwen3.8-27b"); // cheaper wins the tie
  expect(leaderOf([stat(KIMI, 1, 1)], "frontier")).toBe(KIMI);
  expect(buildModelBoard([stat(FLASH, 3, 2), stat(DEEP, 3, 1)]).flatMap((g) => g.rows).filter((r) => r.leader)).toHaveLength(1);
  expect(pickLeader([])).toBeNull();
});

test("stats from several roles aggregate per model with attempt-weighted time", () => {
  const board = buildModelBoard([stat(FLASH, 2, 2, 1000, "builder"), stat(FLASH, 2, 0, 3000, "rework")]);
  const row = board.flatMap((g) => g.rows).find((r) => r.model.id === FLASH)!;
  expect(row).toMatchObject({ attempts: 4, passes: 2, failures: 2, passRate: 0.5, avgBuildMs: 2000 });
});

test("formatDuration", () => {
  expect(formatDuration(null)).toBe("–");
  expect(formatDuration(450)).toBe("450ms");
  expect(formatDuration(21400)).toBe("21.4s");
});

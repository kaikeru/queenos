import { expect, test } from "vitest";
import { earlierSummary, groupLanes, isFinishedLane, newestFirst, relativeTime } from "../src/lanes";
import type { Lane } from "../src/reducer";

const lane = (letter: string, createdAt: number, status: string, trainStatuses: string[] = []): Lane =>
  ({
    letter,
    prompt: { promptId: letter, namespace: "demo", promptText: letter, status, createdAt },
    cards: [],
    trains: trainStatuses.map((s) => ({ train: { status: s } })),
  }) as unknown as Lane;

test("newestFirst sorts by queue time and breaks ties by arrival order", () => {
  const out = newestFirst([lane("A", 1, "MERGED"), lane("B", 5, "MERGED"), lane("C", 5, "MERGED"), lane("D", 3, "MERGED")]);
  expect(out.map((l) => l.letter)).toEqual(["C", "B", "D", "A"]);
});

test("a newly arriving prompt lands on top and keeps its own letter", () => {
  const before = [lane("A", 1, "MERGED"), lane("B", 2, "QUEUED")];
  const after = newestFirst([...before, lane("C", 3, "QUEUED")]);
  expect(after.map((l) => l.letter)).toEqual(["C", "B", "A"]);
});

test("isFinishedLane needs a terminal prompt and only terminal trains", () => {
  expect(isFinishedLane(lane("A", 1, "MERGED", ["EJECTED", "MERGED"]))).toBe(true);
  expect(isFinishedLane(lane("A", 1, "EJECTED", ["EJECTED"]))).toBe(true);
  expect(isFinishedLane(lane("A", 1, "FAILED"))).toBe(true);
  expect(isFinishedLane(lane("A", 1, "BUILDING", ["BUILDING"]))).toBe(false);
  // Ejected prompt that a rebuild train is still working on.
  expect(isFinishedLane(lane("A", 1, "EJECTED", ["EJECTED", "TESTING"]))).toBe(false);
});

test("groupLanes keeps the newest few and any unfinished lane, collapses older finished ones", () => {
  const lanes = [
    lane("A", 1, "MERGED", ["MERGED"]),
    lane("B", 2, "BUILDING", ["BUILDING"]), // old but still running: stays
    lane("C", 3, "EJECTED", ["EJECTED"]),
    lane("D", 4, "MERGED", ["MERGED"]),
    lane("E", 5, "MERGED", ["MERGED"]),
    lane("F", 6, "MERGED", ["MERGED"]),
  ];
  const { visible, earlier } = groupLanes(lanes, 3);
  expect(visible.map((l) => l.letter)).toEqual(["F", "E", "D", "B"]);
  expect(earlier.map((l) => l.letter)).toEqual(["C", "A"]);
});

test("groupLanes collapses nothing when there are only a few lanes", () => {
  const { visible, earlier } = groupLanes([lane("A", 1, "MERGED", ["MERGED"]), lane("B", 2, "MERGED", ["MERGED"])]);
  expect(visible).toHaveLength(2);
  expect(earlier).toHaveLength(0);
});

test("earlierSummary counts merged and failed", () => {
  expect(earlierSummary([lane("A", 1, "MERGED"), lane("B", 2, "EJECTED"), lane("C", 3, "FAILED")])).toBe("1 merged · 2 failed");
  expect(earlierSummary([lane("A", 1, "MERGED")])).toBe("1 merged");
});

test("relativeTime buckets", () => {
  const now = 10_000_000;
  expect(relativeTime(now - 3000, now)).toBe("just now");
  expect(relativeTime(now - 30_000, now)).toBe("30s ago");
  expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
  expect(relativeTime(now - 3 * 3600_000, now)).toBe("3h ago");
  expect(relativeTime(now - 50 * 3600_000, now)).toBe("2d ago");
  expect(relativeTime(now + 5000, now)).toBe("just now");
});

import { expect, test } from "vitest";
import { relativeTime } from "../src/lanes";

test("relativeTime buckets", () => {
  const now = 10_000_000;
  expect(relativeTime(now - 3000, now)).toBe("just now");
  expect(relativeTime(now - 30_000, now)).toBe("30s ago");
  expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
  expect(relativeTime(now - 3 * 3600_000, now)).toBe("3h ago");
  expect(relativeTime(now - 50 * 3600_000, now)).toBe("2d ago");
  expect(relativeTime(now + 5000, now)).toBe("just now");
});

import { describe, expect, it } from "vitest";
import { metricPoint, writeMetric, type DataPoint } from "./metrics.js";

describe("metricPoint", () => {
  it("lays out indexes, blobs and doubles", () => {
    expect(
      metricPoint({ type: "build", hive: "h", kindOrRole: "BUILDER", model: "m", outcome: "ok", environment: "prod", traceId: "t", itemId: "i", valueMs: 5, tokensIn: 1, tokensOut: 2, credits: 3 }),
    ).toEqual({ indexes: ["h"], blobs: ["build", "h", "BUILDER", "m", "ok", "prod", "t", "i"], doubles: [5, 1, 2, 3, 1] });
  });
  it("defaults blanks and zero, count 1; sanitises non-finite", () => {
    const p = metricPoint({ type: "x", hive: "h", valueMs: Number.NaN, count: 4 });
    expect(p.blobs).toEqual(["x", "h", "", "", "", "", "", ""]);
    expect(p.doubles).toEqual([0, 0, 0, 0, 4]);
  });
  it("clips the index to 96 bytes", () => {
    expect(new TextEncoder().encode(metricPoint({ type: "x", hive: "é".repeat(100) }).indexes[0]!).length).toBeLessThanOrEqual(96);
  });
});

describe("writeMetric", () => {
  it("is a no-op without a binding", () => {
    expect(() => writeMetric(undefined, { type: "x", hive: "h" })).not.toThrow();
  });
  it("writes one point and swallows binding errors", () => {
    const got: DataPoint[] = [];
    writeMetric({ writeDataPoint: (p) => void got.push(p) }, { type: "x", hive: "h" });
    expect(got).toHaveLength(1);
    expect(() =>
      writeMetric(
        {
          writeDataPoint: () => {
            throw new Error("x");
          },
        },
        { type: "x", hive: "h" },
      ),
    ).not.toThrow();
  });
});

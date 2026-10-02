import { describe, expect, it } from "vitest";
import { previewNameFor, workerNameFor } from "../src/source";

describe("names", () => {
  it("derives a DNS-safe preview name from the train id", () => {
    expect(previewNameFor("0a1b2c3d-4e5f-6789-abcd-ef0123456789")).toBe("t-0a1b2c3d4e5f");
    const odd = previewNameFor("Train #42 (spec)");
    expect(odd).toMatch(/^t-[0-9a-f]{12}$/);
    expect(previewNameFor("Train #42 (spec)")).toBe(odd);
    expect(previewNameFor("Train #43 (spec)")).not.toBe(odd);
    expect(previewNameFor("x".repeat(500)).length).toBeLessThanOrEqual(14);
  });

  it("derives the parent worker name <hive>-app, lowercase, <= 63 chars", () => {
    expect(workerNameFor("My Hive")).toBe("my-hive-app");
    expect(workerNameFor("queenos")).toBe("queenos-app");
    expect(workerNameFor("A".repeat(200)).length).toBeLessThanOrEqual(54);
    expect(workerNameFor("!!!")).toMatch(/^h[0-9a-f]{8}-app$/);
  });
});

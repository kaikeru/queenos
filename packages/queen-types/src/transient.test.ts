import { describe, expect, it } from "vitest";
import { DeployResultSchema, TrainResultSchema, isTransientError, jitteredBackoffMs, retryTransient } from "./index";

describe("isTransientError", () => {
  it("recognises the live 503s (isomorphic-git HttpError, re-serialised by Workflows) and other 5xx/429", () => {
    expect(isTransientError(new Error("HttpError: HTTP Error: 503 Service Unavailable"))).toBe(true);
    expect(isTransientError(new Error("HTTP Error: 502 Bad Gateway"))).toBe(true);
    expect(isTransientError(new Error("PUT /accounts/x/workers/scripts/y failed (HTTP 503): upstream"))).toBe(true);
    expect(isTransientError(new Error("Too Many Requests"))).toBe(true);
    expect(isTransientError(Object.assign(new Error("HTTP Error"), { name: "HttpError", data: { statusCode: 504 } }))).toBe(true);
    expect(isTransientError(Object.assign(new Error("x"), { retryable: true }))).toBe(true);
    expect(isTransientError("fetch failed")).toBe(true);
  });
  it("leaves change-caused and permanent errors alone", () => {
    expect(isTransientError(new Error("HTTP Error: 404 Not Found"))).toBe(false);
    expect(isTransientError(new Error("Uncaught SyntaxError: Unexpected token"))).toBe(false);
    expect(isTransientError(Object.assign(new Error("HTTP 503"), { retryable: false }))).toBe(false);
    expect(isTransientError(new Error("UNAVAILABLE: ARTIFACTS binding is not configured"))).toBe(false);
    expect(isTransientError(null)).toBe(false);
  });
});

describe("jitteredBackoffMs / retryTransient", () => {
  it("full jitter under an exponential cap", () => {
    expect(jitteredBackoffMs(1, 1000, 8000, 0.5)).toBe(500);
    expect(jitteredBackoffMs(3, 1000, 8000, 0.999)).toBe(3996);
    expect(jitteredBackoffMs(10, 1000, 8000, 0.999)).toBe(7992);
    expect(jitteredBackoffMs(2, 1000, 8000, 0)).toBe(0);
  });
  it("retries a transient error, then succeeds", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const r = await retryTransient(
      async () => {
        if (++n < 3) throw new Error("HTTP Error: 503 Service Unavailable");
        return "ok";
      },
      { attempts: 3, baseMs: 100, maxMs: 1000, sleep: async (ms) => sleeps.push(ms), random: () => 0.5 },
    );
    expect(r).toBe("ok");
    expect(sleeps).toEqual([50, 100]);
  });
  it("throws a permanent error at once and a transient one after the last attempt", async () => {
    let n = 0;
    const opts = { attempts: 3, baseMs: 1, maxMs: 1, sleep: async () => undefined };
    await expect(retryTransient(async () => { n++; throw new Error("bad module"); }, opts)).rejects.toThrow("bad module");
    expect(n).toBe(1);
    n = 0;
    await expect(retryTransient(async () => { n++; throw new Error("HTTP Error: 503"); }, opts)).rejects.toThrow("503");
    expect(n).toBe(3);
  });
});

describe("infra fields", () => {
  it("TrainResult.cause and DeployResult.retryable are optional", () => {
    expect(TrainResultSchema.parse({ trainId: "t", passed: false, summary: "s", cause: "infra" }).cause).toBe("infra");
    expect(TrainResultSchema.parse({ trainId: "t", passed: false, summary: "s" }).cause).toBeUndefined();
    const d = { commandId: "c", op: "DEPLOY", environment: "preview", ok: false } as const;
    expect(DeployResultSchema.parse({ ...d, retryable: true }).retryable).toBe(true);
    expect(DeployResultSchema.parse(d).retryable).toBeUndefined();
  });
});

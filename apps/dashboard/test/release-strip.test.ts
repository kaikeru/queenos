import { describe, expect, it, vi } from "vitest";
import type { Release } from "@queenos/queen-types";
import { GUARDRAIL_MAX } from "@queenos/queen-types";
import { guardrailPatch, isSimulation, parseGuardrail } from "../src/homeLogic";
import { prodUrlOf, releaseStrip, shipper } from "../src/releases";
import { ApiError } from "../src/api";
import { isRetryable, retryDelayMs, withRetry } from "../src/retry";

const rel = (o: Partial<Release>): Release =>
  ({ releaseId: "r1", hive: "h", headSha: "a".repeat(40), trainIds: [], phase: "STAGING", canaryPercent: null, stagingUrl: null, prodUrl: null, candidateVersionId: null, stableVersionId: null, tappedBy: null, tappedAt: null, summary: null, createdAt: 1, updatedAt: 1, ...o }) as Release;
const st = (releases: Release[], deployments: Record<string, unknown> = {}) =>
  ({ releases: Object.fromEntries(releases.map((r) => [r.releaseId, r])), releaseOrder: releases.map((r) => r.releaseId), deployments, canaryPeak: {} }) as never;

describe("release strip", () => {
  it("is null with no release", () => expect(releaseStrip(st([]))).toBeNull());
  it("shows the timeline and keeps the prod link while a release is in flight", () => {
    const s = releaseStrip(st([rel({ phase: "CANARY", canaryPercent: 10, prodUrl: "https://p" })]))!;
    expect(s.steps.find((x) => x.state === "now")?.label).toBe("CANARY 10%");
    expect(s.prodUrl).toBe("https://p");
  });
  it("falls back to an earlier release's prod URL when the newest has none", () => {
    const old = rel({ releaseId: "r0", phase: "SHIPPED", prodUrl: "https://old", createdAt: 1 });
    const cur = rel({ releaseId: "r1", phase: "STAGING", createdAt: 2 });
    expect(releaseStrip(st([cur, old]))!.prodUrl).toBe("https://old");
    expect(releaseStrip(st([rel({ phase: "ROLLED_BACK" })], { d1: { deploymentId: "d1", environment: "prod", status: "LIVE", url: "https://dep", updatedAt: 5 } }))!.prodUrl).toBe("https://dep");
    expect(releaseStrip(st([rel({ phase: "STAGING" })]))!.prodUrl).toBeNull();
  });
  it("distinguishes auto-ship from a human tap and links prod when shipped", () => {
    expect(shipper(rel({ tappedBy: "queen:autonomous" }))?.kind).toBe("auto");
    expect(shipper(rel({ tappedBy: "kyle@x.com" }))?.kind).toBe("human");
    expect(shipper(rel({}))).toBeNull();
    const s = releaseStrip(st([rel({ phase: "SHIPPED", tappedBy: "queen:autonomous", prodUrl: "https://prod" })]))!;
    expect(s.prodUrl).toBe("https://prod");
    expect(s.shipper?.kind).toBe("auto");
  });
  it("falls back to a prod deployment URL", () => {
    const dep = { d1: { deploymentId: "d1", environment: "prod", status: "LIVE", url: "https://dep", updatedAt: 5 } };
    expect(prodUrlOf(st([rel({ phase: "SHIPPED" })], dep), rel({ phase: "SHIPPED" }))).toBe("https://dep");
    expect(prodUrlOf(st([rel({})]))).toBeNull();
  });
});

describe("sim badge", () => {
  it("shows for sim or mock only", () => {
    expect(isSimulation({ mode: "sim" }, false)).toBe(true);
    expect(isSimulation({ mode: "live" }, false)).toBe(false);
    expect(isSimulation({}, false)).toBe(false);
    expect(isSimulation(null, false)).toBe(false);
    expect(isSimulation({ mode: "live" }, true)).toBe(true);
  });
});

describe("guardrails form", () => {
  it("validates ranges from GUARDRAIL_MAX", () => {
    expect(parseGuardrail("maxChildrenPerItem", "24")).toEqual({ value: 24 });
    expect("error" in parseGuardrail("maxChildrenPerItem", "25")).toBe(true);
    expect("error" in parseGuardrail("maxActiveTrains", "0")).toBe(true);
    expect("error" in parseGuardrail("maxActiveTrains", "1.5")).toBe(true);
    expect(parseGuardrail("maxActiveTrains", String(GUARDRAIL_MAX.maxActiveTrains))).toEqual({ value: 256 });
  });
  it("patches only changed, valid fields", () => {
    const cur = { maxChildrenPerItem: 8, maxActiveTrains: 24 };
    expect(guardrailPatch(cur, { maxChildrenPerItem: "24", maxActiveTrains: "24" })).toEqual({ guardrails: { maxChildrenPerItem: 24 } });
    expect(guardrailPatch(cur, { maxChildrenPerItem: "8", maxActiveTrains: "24" })).toBeNull();
    expect(guardrailPatch(cur, { maxChildrenPerItem: "99", maxActiveTrains: "30" })).toBeNull();
  });
});

describe("retry", () => {
  it("retries 5xx and network errors only", () => {
    expect(isRetryable(new ApiError("x", 502))).toBe(true);
    expect(isRetryable(new ApiError("x", 0))).toBe(true);
    expect(isRetryable(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryable(new ApiError("x", 404))).toBe(false);
    expect(isRetryable(new ApiError("x", 401))).toBe(false);
    expect([1, 2, 3].map(retryDelayMs)).toEqual([400, 800, 1600]);
  });
  it("succeeds after transient failures, and gives up after 3 tries", async () => {
    const wait = vi.fn(async () => {});
    const f = vi.fn().mockRejectedValueOnce(new ApiError("x", 502)).mockRejectedValueOnce(new ApiError("x", 503)).mockResolvedValue("ok");
    expect(await withRetry(f, { wait })).toBe("ok");
    expect(wait.mock.calls.map((c) => c[0])).toEqual([400, 800]);
    const bad = vi.fn().mockRejectedValue(new ApiError("x", 502));
    await expect(withRetry(bad, { wait })).rejects.toThrow();
    expect(bad).toHaveBeenCalledTimes(3);
    const nf = vi.fn().mockRejectedValue(new ApiError("x", 404));
    await expect(withRetry(nf, { wait })).rejects.toThrow();
    expect(nf).toHaveBeenCalledTimes(1);
  });
});

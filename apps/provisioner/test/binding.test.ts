import { describe, expect, it } from "vitest";
import { BindingArtifactsPort, forkJitterMs } from "../src/ports";
import { artifactsError } from "./fakes";

/** Minimal fake of the Artifacts binding, recording calls and disposals. */
function fakeArtifacts(script: { forkErrors?: string[]; forkErrorsByTarget?: Record<string, string>; infoRemote?: string; getErrors?: Record<string, string[]>; head?: string }) {
  const calls: string[] = [];
  let disposed = 0;
  const forkErrors = [...(script.forkErrors ?? [])];
  const binding = {
    async get(name: string) {
      calls.push(`get:${name}`);
      const err = script.getErrors?.[name]?.shift();
      if (err) throw artifactsError(err);
      return {
        async fork(target: string, opts: { defaultBranchOnly?: boolean }) {
          calls.push(`fork:${name}->${target}:${opts.defaultBranchOnly}`);
          const e = script.forkErrorsByTarget?.[target] ?? forkErrors.shift();
          if (e) throw artifactsError(e);
          return { name: target };
        },
        async log(opts: { ref?: string; limit?: number }) {
          calls.push(`log:${name}:${opts.ref}:${opts.limit}`);
          return script.head ? [{ hash: script.head }] : [];
        },
        async info() {
          return { remote: `https://x.artifacts/git/${name}.git` };
        },
        async createToken(scope: string, ttl: number) {
          calls.push(`token:${name}:${scope}:${ttl}`);
          return { plaintext: "art_v1_SECRET?expires=123" };
        },
        [Symbol.dispose]() {
          disposed++;
        },
      };
    },
    async delete(name: string) {
      calls.push(`delete:${name}`);
      return true;
    },
  };
  return { binding: binding as unknown as Artifacts, calls, disposed: () => disposed };
}

const noSleep = async () => {};
const ok = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
const opts = { sleep: noSleep, fetch: ok, maxJitterMs: 0 };

describe("BindingArtifactsPort", () => {
  it("forks with the real API, reads the base SHA via log, and disposes handles", async () => {
    const f = fakeArtifacts({ head: "abc123" });
    const p = new BindingArtifactsPort(f.binding, opts);
    expect(await p.forkTrain("hive", "hive-train-1")).toEqual({ artifactRepo: "hive-train-1", baseSha: "abc123" });
    expect(f.calls).toEqual(["get:hive", "fork:hive->hive-train-1:true", "get:hive-train-1", "log:hive-train-1:main:1", "token:hive-train-1:read:60"]);
    expect(f.disposed()).toBe(2);
  });

  it("retries FORK_IN_PROGRESS and reuses an existing fork (ALREADY_EXISTS)", async () => {
    const f = fakeArtifacts({
      head: "abc",
      forkErrors: ["FORK_IN_PROGRESS", "ALREADY_EXISTS"],
      getErrors: { "hive-train-2": ["FORK_IN_PROGRESS", "FORK_IN_PROGRESS"] },
    });
    const p = new BindingArtifactsPort(f.binding, opts);
    expect((await p.forkTrain("hive", "hive-train-2")).baseSha).toBe("abc");
    expect(f.calls.filter((c) => c.startsWith("fork:"))).toHaveLength(2);
    expect(f.calls.filter((c) => c === "get:hive-train-2")).toHaveLength(3);
  });

  it("does not retry other errors, and gives up after the attempt budget", async () => {
    const bad = fakeArtifacts({ forkErrors: ["INVALID_REPO_NAME"] });
    await expect(new BindingArtifactsPort(bad.binding, opts).forkTrain("hive", "x")).rejects.toThrow("INVALID_REPO_NAME");
    const stuck = fakeArtifacts({ forkErrors: Array(10).fill("FORK_IN_PROGRESS") });
    await expect(new BindingArtifactsPort(stuck.binding, { ...opts, attempts: 3 }).forkTrain("hive", "x")).rejects.toThrow("FORK_IN_PROGRESS");
  });

  it("fails when the fork has no main branch", async () => {
    const f = fakeArtifacts({});
    await expect(new BindingArtifactsPort(f.binding, opts).forkTrain("hive", "x")).rejects.toThrow(/has no main branch/);
  });

  it("deletes repos and reports a missing binding as UNAVAILABLE", async () => {
    const f = fakeArtifacts({});
    expect(await new BindingArtifactsPort(f.binding).deleteRepo("hive-train-1")).toBe(true);
    await expect(new BindingArtifactsPort(undefined).forkTrain("a", "b")).rejects.toThrow(/^UNAVAILABLE: /);
  });

  it("staggers forks with a deterministic per-name jitter in 0..3s", async () => {
    expect(forkJitterMs("a-train-1", 3000)).toBe(forkJitterMs("a-train-1", 3000));
    const js = new Set(Array.from({ length: 12 }, (_, i) => forkJitterMs(`demo-train-${i}`, 3000)));
    expect(js.size).toBeGreaterThan(6);
    for (const j of js) expect(j).toBeLessThanOrEqual(3000);
    const sleeps: number[] = [];
    const f = fakeArtifacts({ head: "abc" });
    await new BindingArtifactsPort(f.binding, { ...opts, maxJitterMs: 3000, sleep: async (ms) => void sleeps.push(ms) }).forkTrain("hive", "hive-train-9");
    expect(sleeps[0]).toBe(forkJitterMs("hive-train-9", 3000));
  });

  it("retries INTERNAL_ERROR under a new name, deleting the ghost, and returns the real name", async () => {
    const f = fakeArtifacts({ head: "abc", forkErrors: ["INTERNAL_ERROR", "INTERNAL_ERROR"] });
    const r = await new BindingArtifactsPort(f.binding, opts).forkTrain("hive", "t");
    expect(r).toEqual({ artifactRepo: "t-r3", baseSha: "abc" });
    expect(f.calls.filter((c) => c.startsWith("fork:"))).toEqual(["fork:hive->t:true", "fork:hive->t-r2:true", "fork:hive->t-r3:true"]);
    expect(f.calls).toContain("delete:t");
    expect(f.calls).toContain("delete:t-r2");
  });

  it("treats NOT_FOUND on the fork as a ghost name and moves to a new one", async () => {
    const f = fakeArtifacts({ head: "abc", forkErrors: ["INTERNAL_ERROR", "NOT_FOUND"] });
    expect((await new BindingArtifactsPort(f.binding, opts).forkTrain("hive", "t")).artifactRepo).toBe("t-r3");
  });

  it("does not mistake a missing source for a ghost", async () => {
    const f = fakeArtifacts({ getErrors: { hive: ["NOT_FOUND"] } });
    await expect(new BindingArtifactsPort(f.binding, opts).forkTrain("hive", "t")).rejects.toThrow("NOT_FOUND");
    expect(f.calls.some((c) => c.startsWith("delete:"))).toBe(false);
  });

  it("gives up after maxForks names", async () => {
    const f = fakeArtifacts({ forkErrors: Array(10).fill("INTERNAL_ERROR") });
    await expect(new BindingArtifactsPort(f.binding, { ...opts, maxForks: 2 }).forkTrain("hive", "t")).rejects.toThrow("INTERNAL_ERROR");
    expect(f.calls.filter((c) => c.startsWith("fork:"))).toHaveLength(2);
  });

  it("probes with Basic auth (token minus ?expires=) and accepts a readable fork", async () => {
    const seen: { url: string; auth: string }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: (init.headers as Record<string, string>).authorization! });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const f = fakeArtifacts({ head: "abc" });
    await new BindingArtifactsPort(f.binding, { ...opts, fetch: fetchFn }).forkTrain("hive", "t");
    expect(seen).toEqual([{ url: "https://x.artifacts/git/t.git/info/refs?service=git-upload-pack", auth: `Basic ${btoa("x:art_v1_SECRET")}` }]);
  });

  it("re-forks under a new name when the probe keeps returning 503, and waits up to ~20s", async () => {
    const sleeps: number[] = [];
    const fetchFn = (async (url: string) => new Response("", { status: url.includes("/t.git/") ? 503 : 200 })) as unknown as typeof fetch;
    const f = fakeArtifacts({ head: "abc" });
    const r = await new BindingArtifactsPort(f.binding, { ...opts, fetch: fetchFn, sleep: async (ms) => void sleeps.push(ms) }).forkTrain("hive", "t");
    expect(r.artifactRepo).toBe("t-r2");
    expect(f.calls).toContain("delete:t");
    expect(sleeps.slice(0, 4).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(7000);
    expect(sleeps.filter((m) => m <= 4000).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30_000);
  });

  it("accepts a fork whose 503 clears within the probe window", async () => {
    let n = 0;
    const fetchFn = (async () => new Response("", { status: n++ < 2 ? 503 : 200 })) as unknown as typeof fetch;
    const f = fakeArtifacts({ head: "abc" });
    expect((await new BindingArtifactsPort(f.binding, { ...opts, fetch: fetchFn }).forkTrain("hive", "t")).artifactRepo).toBe("t");
    expect(f.calls.some((c) => c.startsWith("delete:"))).toBe(false);
  });
});

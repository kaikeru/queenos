import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/app";

// A fresh DO per test: the registry is a single named instance in production.
function registry() {
  const ns = (env as unknown as Bindings).REGISTRY;
  return ns.get(ns.newUniqueId());
}

/** Resolve to the rejection message (an RPC promise rejected inside `expect` leaks as unhandled). */
async function failure(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => "no error",
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );
}

const base = { hive: "demo-hive", name: "Demo", description: "A demo", createdBy: "a@example.org" };

describe("HiveRegistry", () => {
  it("registers a project in ONBOARDING with empty urls", async () => {
    const r = registry();
    const p = await r.register(base);
    expect(p).toMatchObject({ ...base, status: "ONBOARDING", urls: { prod: null, staging: null, preview: null } });
    expect(await r.get("demo-hive")).toEqual(p);
    expect(await r.get("missing")).toBeNull();
  });

  it("is idempotent per hive for the same creator", async () => {
    const r = registry();
    const a = await r.register(base);
    const b = await r.register({ ...base, name: "Renamed" });
    expect(b).toEqual(a);
    expect(await r.list()).toHaveLength(1);
  });

  it("rejects a different creator with CONFLICT", async () => {
    const r = registry();
    await r.register(base);
    expect(await failure(r.register({ ...base, createdBy: "b@example.org" }))).toMatch(/^CONFLICT/);
  });

  it("rejects an invalid slug", async () => {
    expect(await failure(registry().register({ ...base, hive: "Bad Slug" }))).toMatch(/^INVALID/);
  });

  it("updates status, name, description and merges urls", async () => {
    const r = registry();
    await r.register(base);
    const u1 = await r.update("demo-hive", { status: "ACTIVE", urls: { preview: "https://p.example" } });
    expect(u1.status).toBe("ACTIVE");
    expect(u1.urls).toEqual({ prod: null, staging: null, preview: "https://p.example" });
    const u2 = await r.update("demo-hive", { name: "N2", urls: { prod: "https://prod.example" } });
    expect(u2.name).toBe("N2");
    expect(u2.urls).toEqual({ prod: "https://prod.example", staging: null, preview: "https://p.example" });
    expect(u2.updatedAt).toBeGreaterThanOrEqual(u1.updatedAt);
    expect(await failure(r.update("nope-nope", { status: "FAILED" }))).toMatch(/^NOT_FOUND/);
  });

  it("lists newest first", async () => {
    const r = registry();
    await r.register({ ...base, hive: "aaa-one" });
    await new Promise((res) => setTimeout(res, 5));
    await r.register({ ...base, hive: "bbb-two" });
    expect((await r.list()).map((p) => p.hive)).toEqual(["bbb-two", "aaa-one"]);
  });
});

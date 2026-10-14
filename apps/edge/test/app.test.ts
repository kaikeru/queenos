import type { Bindings } from "../src/app";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { fakeBindings, freshVerifier, goodClaims, makeKey, sign, type TestKey } from "./helpers";

async function ctx() {
  const key: TestKey = await makeKey("k1");
  const { verifier } = freshVerifier(() => [key]);
  const app = createApp(verifier);
  const { env, seen } = fakeBindings();
  const token = await sign(key, goodClaims());
  const call = (path: string, init: RequestInit = {}, e = env, tok: string | null = token) => {
    const headers = new Headers(init.headers);
    if (tok) headers.set("cf-access-jwt-assertion", tok);
    return app.request(`https://queenos.example.com${path}`, { ...init, headers }, e);
  };
  return { app, env, seen, key, token, call };
}

const GOOD_BODY = { accountId: "0123456789abcdef0123456789abcdef", apiToken: "cf-secret-token-0123456789-abcdef" };

describe("auth", () => {
  it("leaves /health open", async () => {
    const { call } = await ctx();
    expect((await call("/health", {}, undefined, null)).status).toBe(200);
  });

  it("requires a valid token on every other route", async () => {
    const { call } = await ctx();
    const routes: [string, string][] = [
      ["GET", "/api/me"],
      ["GET", "/api/projects"],
      ["GET", "/api/vault/token-template"],
      ["POST", "/api/vault/demo-hive/cloudflare"],
      ["GET", "/api/vault/demo-hive/status"],
      ["POST", "/api/genesis"],
      ["GET", "/api/genesis/demo-hive"],
      ["GET", "/hives/demo/state"],
      ["GET", "/"],
      ["GET", "/some/spa/route"],
    ];
    for (const [method, path] of routes) {
      const r = await call(path, { method }, undefined, null);
      expect(r.status, `${method} ${path}`).toBe(401);
      const bad = await call(path, { method }, undefined, "a.b.c");
      expect(bad.status, `${method} ${path} bad`).toBe(401);
    }
  });

  it("accepts the CF_Authorization cookie", async () => {
    const { app, env, token } = await ctx();
    const r = await app.request("https://x/api/me", { headers: { cookie: `CF_Authorization=${token}` } }, env);
    expect(await r.json()).toEqual({ email: "owner@example.org" });
  });

  it("returns 403 for a foreign email domain", async () => {
    const { key, call } = await ctx();
    const t = await sign(key, goodClaims({ email: "x@evil.com" }));
    expect((await call("/api/me", {}, undefined, t)).status).toBe(403);
  });

  it("fails closed with 503 when ACCESS_AUD is empty", async () => {
    const { env, call } = await ctx();
    expect((await call("/api/me", {}, { ...env, ACCESS_AUD: "" })).status).toBe(503);
    expect((await call("/health", {}, { ...env, ACCESS_AUD: "" })).status).toBe(200);
  });

  it("dev mode bypasses verification with DEV_USER_EMAIL, on localhost only", async () => {
    const { app, env, call } = await ctx();
    const dev = { ...env, ACCESS_MODE: "dev", DEV_USER_EMAIL: "Dev@example.org" };
    const local = (e: Partial<typeof dev> & typeof env) => app.request("http://localhost:8787/api/me", {}, e);
    expect(await (await local(dev)).json()).toEqual({ email: "dev@example.org" });
    expect((await local({ ...dev, DEV_USER_EMAIL: undefined })).status).toBe(503);
    // An accidentally deployed dev build must not bypass Access on the real domain.
    expect((await call("/api/me", {}, dev, null)).status).toBe(403);
  });
});

describe("routes", () => {
  it("GET /api/me", async () => {
    const { call } = await ctx();
    expect(await (await call("/api/me")).json()).toEqual({ email: "owner@example.org" });
  });

  it("GET /api/projects lists the registry", async () => {
    const { call, env } = await ctx();
    expect(await (await call("/api/projects")).json()).toEqual([]);
    const reg = (env as unknown as Bindings).REGISTRY.get((env as unknown as Bindings).REGISTRY.idFromName("registry"));
    await reg.register({ hive: "my-hive", name: "My", description: "d", createdBy: "owner@example.org" });
    const list = (await (await call("/api/projects")).json()) as { hive: string; status: string }[];
    expect(list.map((p) => [p.hive, p.status])).toEqual([["my-hive", "ONBOARDING"]]);
  });

  it("unknown /api routes 404 as JSON", async () => {
    const { call } = await ctx();
    expect((await call("/api/nope")).status).toBe(404);
  });

  it("falls back to the SPA assets for other paths", async () => {
    const { call, seen } = await ctx();
    const r = await call("/projects/demo");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("spa");
    expect(seen.assets).toHaveLength(1);
  });
});

describe("vault routes", () => {
  it("connects Cloudflare, passing the verified email", async () => {
    const { call, seen } = await ctx();
    const r = await call("/api/vault/demo-hive/cloudflare", { method: "POST", body: JSON.stringify(GOOD_BODY) });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain(GOOD_BODY.apiToken);
    expect(JSON.parse(text)).toMatchObject({ hive: "demo-hive", connected: true });
    expect(seen.vault[0]).toEqual(["connect", "demo-hive", GOOD_BODY, "owner@example.org"]);
  });

  it("validates the body and never echoes the token", async () => {
    const { call, seen } = await ctx();
    const bad = { accountId: "nope", apiToken: "super-secret-short" };
    const r = await call("/api/vault/demo-hive/cloudflare", { method: "POST", body: JSON.stringify(bad) });
    expect(r.status).toBe(400);
    const text = await r.text();
    expect(text).not.toContain("super-secret-short");
    expect(text).not.toContain("nope");
    expect(seen.vault).toHaveLength(0);
    expect((await call("/api/vault/demo-hive/cloudflare", { method: "POST", body: "{not json" })).status).toBe(400);
    expect((await call("/api/vault/Bad_Hive/cloudflare", { method: "POST", body: JSON.stringify(GOOD_BODY) })).status).toBe(400);
  });

  it("maps vault failures to 502 without leaking details, and INVALID to 400", async () => {
    const { call, env } = await ctx();
    const boom = {
      ...env,
      VAULT: { ...env.VAULT, connectCloudflare: async () => { throw new Error(`down ${GOOD_BODY.apiToken}`); } },
    };
    const r = await call("/api/vault/demo-hive/cloudflare", { method: "POST", body: JSON.stringify(GOOD_BODY) }, boom);
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain(GOOD_BODY.apiToken);
    const inv = {
      ...env,
      VAULT: { ...env.VAULT, connectCloudflare: async () => { throw new Error("INVALID: token inactive"); } },
    };
    expect((await call("/api/vault/demo-hive/cloudflare", { method: "POST", body: JSON.stringify(GOOD_BODY) }, inv)).status).toBe(400);
  });

  it("status and token-template", async () => {
    const { call } = await ctx();
    expect(await (await call("/api/vault/demo-hive/status")).json()).toMatchObject({ hive: "demo-hive", connected: false });
    expect(await (await call("/api/vault/token-template")).json()).toHaveProperty("url");
    expect((await call("/api/vault/Bad_Hive/status")).status).toBe(400);
  });
});

describe("forwarding", () => {
  it("forwards /api/genesis unchanged with x-queen-user, stripping spoofing", async () => {
    const { call, seen } = await ctx();
    const r = await call("/api/genesis/demo-hive/messages?x=1", {
      method: "POST",
      headers: { "x-queen-user": "admin@example.org", cookie: "CF_Authorization=zzz", "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(await r.json()).toEqual({ from: "genesis", path: "/api/genesis/demo-hive/messages", user: "owner@example.org" });
    const fwd = seen.genesis[0]!;
    expect(fwd.method).toBe("POST");
    expect(new URL(fwd.url).search).toBe("?x=1");
    expect(await fwd.json()).toEqual({ text: "hello" });
    expect(fwd.headers.get("x-queen-user")).toBe("owner@example.org");
    expect(fwd.headers.get("cookie")).toBeNull();
    expect(fwd.headers.get("cf-access-jwt-assertion")).toBeNull();
    const r2 = await call("/api/genesis", { method: "POST", body: "{}" });
    expect(((await r2.json()) as { path: string }).path).toBe("/api/genesis");
  });

  it("forwards /hives/* to the Queen with x-queen-user and no spoofing", async () => {
    const { call, seen } = await ctx();
    const r = await call("/hives/demo/room", { headers: { "x-queen-user": "evil@x.com", upgrade: "websocket" } });
    expect(await r.json()).toEqual({ from: "queen", path: "/hives/demo/room", user: "owner@example.org" });
    expect(seen.queen[0]!.headers.get("upgrade")).toBe("websocket");
    expect(seen.genesis).toHaveLength(0);
  });

  it("passes a WebSocket upgrade response through untouched", async () => {
    const { call, env } = await ctx();
    const pair = new WebSocketPair();
    const e = {
      ...env,
      QUEEN: { fetch: async () => new Response(null, { status: 101, webSocket: pair[0] }) },
    };
    const r = await call("/hives/demo/room", { headers: { upgrade: "websocket" } }, e);
    expect(r.status).toBe(101);
    expect(r.webSocket).toBeTruthy();
  });
});

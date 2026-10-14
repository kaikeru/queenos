import { env as testEnv, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/app";
import { createApp } from "../src/app";
import { hashToken } from "../src/gittokens";
import { migrateGitTokens } from "../src/registry";
import { fakeBindings, freshVerifier, goodClaims, makeKey, sign } from "./helpers";

const HOST = "https://queenos.kaikeru.com";

async function ctx(overrides: Partial<Bindings> = {}) {
  const key = await makeKey("k1");
  const { verifier } = freshVerifier(() => [key]);
  const app = createApp(verifier);
  // A fresh registry DO per test.
  const ns = (testEnv as unknown as Bindings).REGISTRY;
  const { env, seen } = fakeBindings({ REGISTRY: ns, ...overrides });
  const reg = env.REGISTRY.get(env.REGISTRY.newUniqueId());
  // Route every idFromName("registry") to this test's DO.
  const e2 = { ...env, REGISTRY: { ...env.REGISTRY, idFromName: () => "registry", get: () => reg } } as unknown as Bindings;
  const access = await sign(key, goodClaims());
  const api = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("cf-access-jwt-assertion", access);
    return app.request(`${HOST}${path}`, { ...init, headers }, e2);
  };
  const git = (path: string, init: RequestInit = {}) => app.request(`${HOST}${path}`, init, e2);
  const mint = async (body: unknown = {}) => {
    const r = await api("/api/git-tokens", { method: "POST", body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> & { token: string; id: string } };
  };
  return { app, env: e2, seen, key, access, api, git, mint, reg };
}

const basic = (pw: string, user = "anything") => `Basic ${btoa(`${user}:${pw}`)}`;
const REFS = "/git/demo-hive.git/info/refs?service=git-upload-pack";

describe("git auth", () => {
  it("challenges with 401 and WWW-Authenticate, without touching the proxy", async () => {
    const { git, seen } = await ctx();
    const r = await git(REFS);
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe('Basic realm="QueenOS"');
    expect(seen.git).toHaveLength(0);
  });

  it("accepts a Basic password and a Bearer token, and sets the user and scopes", async () => {
    const { git, mint, seen } = await ctx();
    const { json } = await mint({ scopes: ["read"] });
    const a = await git(REFS, { headers: { authorization: basic(json.token) } });
    expect(a.status).toBe(200);
    const b = await git(REFS, { headers: { authorization: `Bearer ${json.token}` } });
    expect(b.status).toBe(200);
    for (const s of seen.git) {
      expect(s.req.headers.get("x-queen-user")).toBe("owner@kaikeru.com");
      expect(s.req.headers.get("x-queen-scopes")).toBe("read");
    }
    expect(seen.git).toHaveLength(2);
  });

  it("forwards path, query, git headers and the streamed body unchanged; response streams back", async () => {
    const { git, mint, seen } = await ctx();
    const { json } = await mint();
    const r = await git("/git/demo-hive/t/train-1.git/git-upload-pack?x=1", {
      method: "POST",
      headers: {
        authorization: basic(json.token),
        "content-type": "application/x-git-upload-pack-request",
        "content-encoding": "gzip",
        "git-protocol": "version=2",
        accept: "application/x-git-upload-pack-result",
      },
      body: new Blob(["0014command=ls-refs\n"]).stream(),
      // @ts-expect-error duplex is required for streamed request bodies
      duplex: "half",
    });
    expect(await r.text()).toBe("git-says:/git/demo-hive/t/train-1.git/git-upload-pack?x=1");
    expect(r.headers.get("x-from")).toBe("git");
    const s = seen.git[0]!;
    expect(s.req.method).toBe("POST");
    expect(s.body).toBe("0014command=ls-refs\n");
    expect(s.req.headers.get("content-type")).toBe("application/x-git-upload-pack-request");
    expect(s.req.headers.get("content-encoding")).toBe("gzip");
    expect(s.req.headers.get("git-protocol")).toBe("version=2");
    expect(s.req.headers.get("accept")).toBe("application/x-git-upload-pack-result");
    expect(s.req.headers.get("x-queen-scopes")).toBe("read,push");
  });

  it("strips client x-queen-*, authorization and cookie", async () => {
    const { git, mint, seen } = await ctx();
    const { json } = await mint({ scopes: ["read"] });
    await git(REFS, {
      headers: {
        authorization: basic(json.token),
        "x-queen-user": "evil@kaikeru.com",
        "x-queen-scopes": "read,push",
        cookie: "CF_Authorization=abc",
      },
    });
    const h = seen.git[0]!.req.headers;
    expect(h.get("x-queen-user")).toBe("owner@kaikeru.com");
    expect(h.get("x-queen-scopes")).toBe("read");
    expect(h.get("authorization")).toBeNull();
    expect(h.get("cookie")).toBeNull();
  });

  it("rejects an unknown token, a wrong prefix and a malformed header", async () => {
    const { git, seen } = await ctx();
    for (const authorization of [basic("qgt_nope"), basic("hunter2"), "Bearer qgt_nope", "Basic !!!", "Digest x"]) {
      const r = await git(REFS, { headers: { authorization } });
      expect(r.status, authorization).toBe(401);
      expect(r.headers.get("www-authenticate")).toBe('Basic realm="QueenOS"');
    }
    expect(seen.git).toHaveLength(0);
  });

  it("rejects a revoked token immediately", async () => {
    const { git, mint, api } = await ctx();
    const { json } = await mint();
    expect((await git(REFS, { headers: { authorization: basic(json.token) } })).status).toBe(200);
    expect((await api(`/api/git-tokens/${json.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await git(REFS, { headers: { authorization: basic(json.token) } })).status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const { git, reg } = await ctx();
    const token = "qgt_expiredexpiredexpiredexpired";
    await reg.mintGitToken({ id: "x1", hash: await hashToken(token), email: "a@kaikeru.com", scopes: ["read"], label: null, ttlMs: -1000 });
    expect((await git(REFS, { headers: { authorization: basic(token) } })).status).toBe(401);
  });

  it("accepts a cf-access-token Access JWT, and rejects a bad one", async () => {
    const { git, access, seen, key } = await ctx();
    const ok = await git(REFS, { headers: { "cf-access-token": access } });
    expect(ok.status).toBe(200);
    expect(seen.git[0]!.req.headers.get("x-queen-user")).toBe("owner@kaikeru.com");
    expect(seen.git[0]!.req.headers.get("cf-access-token")).toBeNull();
    expect((await git(REFS, { headers: { "cf-access-token": "a.b.c" } })).status).toBe(401);
    const foreign = await sign(key, goodClaims({ email: "x@evil.com" }));
    expect((await git(REFS, { headers: { "cf-access-token": foreign } })).status).toBe(401);
  });

  it("rate limits repeated failures per IP, then 429s even a good token from that IP", async () => {
    const { git, mint } = await ctx();
    const { json } = await mint();
    const ip = { "cf-connecting-ip": "203.0.113.9" };
    for (let i = 0; i < 10; i++) {
      const r = await git(REFS, { headers: { ...ip, authorization: basic(`qgt_bad${i}`) } });
      expect(r.status).toBe(401);
    }
    const blocked = await git(REFS, { headers: { ...ip, authorization: basic(json.token) } });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another IP is unaffected.
    const other = await git(REFS, { headers: { "cf-connecting-ip": "198.51.100.1", authorization: basic(json.token) } });
    expect(other.status).toBe(200);
  });

  it("does not count the credential-less first probe as a failure", async () => {
    const { git, mint } = await ctx();
    const { json } = await mint();
    const ip = { "cf-connecting-ip": "203.0.113.7" };
    for (let i = 0; i < 20; i++) expect((await git(REFS, { headers: ip })).status).toBe(401);
    expect((await git(REFS, { headers: { ...ip, authorization: basic(json.token) } })).status).toBe(200);
  });
});

describe("git tokens API", () => {
  it("mints once, lists without secrets, stores only the hash", async () => {
    const { mint, api } = await ctx();
    const { status, json } = await mint({ label: "laptop" });
    expect(status).toBe(201);
    expect(json.token).toMatch(/^qgt_[a-z2-7]{52}$/);
    expect(json).toMatchObject({ email: "owner@kaikeru.com", scopes: ["read", "push"], label: "laptop", lastUsedAt: null, revokedAt: null });
    expect((json.expiresAt as number) - (json.createdAt as number)).toBe(30 * 86_400_000);

    const list = (await (await api("/api/git-tokens")).json()) as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("token");
    expect(JSON.stringify(list)).not.toContain(json.token);
  });

  it("stores the hash, not the token, in SQLite", async () => {
    const ns = (testEnv as unknown as Bindings).REGISTRY;
    const stub = ns.get(ns.newUniqueId());
    const token = "qgt_storagechecktoken";
    const hash = await hashToken(token);
    await stub.mintGitToken({ id: "s1", hash, email: "a@kaikeru.com", scopes: ["read"], label: null, ttlMs: 1000 });
    await runInDurableObject(stub, (_i, state) => {
      const rows = state.storage.sql.exec("SELECT * FROM git_tokens").toArray();
      expect(JSON.stringify(rows)).not.toContain(token);
      expect(rows[0]).toMatchObject({ hash });
    });
  });

  it("lists and revokes only the caller's own tokens, and validates input", async () => {
    const { mint, api, reg } = await ctx();
    const { json } = await mint();
    await reg.mintGitToken({ id: "other", hash: "h", email: "other@kaikeru.com", scopes: ["read"], label: null, ttlMs: 1000 });
    expect(((await (await api("/api/git-tokens")).json()) as unknown[]).length).toBe(1);
    expect((await api("/api/git-tokens/other", { method: "DELETE" })).status).toBe(404);
    expect((await api(`/api/git-tokens/${json.id}`, { method: "DELETE" })).status).toBe(200);
    const list = (await (await api("/api/git-tokens")).json()) as { revokedAt: number | null }[];
    expect(list[0]!.revokedAt).not.toBeNull();
    expect((await mint({ scopes: ["admin"] })).status).toBe(400);
    expect((await mint({ ttlDays: 91 })).status).toBe(400);
  });

  it("is Access-only: a git token does not open /api/git-tokens", async () => {
    const { app, env, mint } = await ctx();
    const { json } = await mint();
    for (const [method, path] of [["POST", "/api/git-tokens"], ["GET", "/api/git-tokens"], ["DELETE", `/api/git-tokens/${json.id}`]] as const) {
      expect((await app.request(`${HOST}${path}`, { method }, env)).status, path).toBe(401);
      const r = await app.request(`${HOST}${path}`, { method, headers: { authorization: `Bearer ${json.token}` } }, env);
      expect(r.status, path).toBe(401);
    }
  });
});

describe("agent identity on git tokens", () => {
  const AGENT = { name: "claude-code", model: "claude-opus-4" };

  it("mints with an agent and lists it; without an agent it is null", async () => {
    const { mint, api } = await ctx();
    const a = await mint({ label: "bot", agent: AGENT });
    expect(a.status).toBe(201);
    expect(a.json.agent).toEqual(AGENT);
    const b = await mint({ agent: { name: "codex" } });
    expect(b.json.agent).toEqual({ name: "codex", model: null });
    const c = await mint({});
    expect(c.json.agent).toBeNull();
    const list = (await (await api("/api/git-tokens")).json()) as { id: string; agent: unknown }[];
    const byId = new Map(list.map((t) => [t.id, t.agent]));
    expect(byId.get(a.json.id)).toEqual(AGENT);
    expect(byId.get(b.json.id)).toEqual({ name: "codex", model: null });
    expect(byId.get(c.json.id)).toBeNull();
  });

  it("rejects bad agent names and models with 400", async () => {
    const { mint } = await ctx();
    for (const agent of [
      { name: "bad!" },
      { name: ".x" },
      { name: "" },
      { name: "a b" },
      { name: "ok", model: "" },
      { name: "ok", model: "x".repeat(500) },
      { name: "ok", model: "bad\nmodel" },
      { name: "ok", model: null },
      { model: "claude" },
      "claude-code",
    ]) {
      expect((await mint({ agent })).status, JSON.stringify(agent)).toBe(400);
    }
  });

  it("forwards x-queen-agent and x-queen-agent-model for an agent token", async () => {
    const { git, mint, seen } = await ctx();
    const { json } = await mint({ agent: AGENT });
    expect((await git(REFS, { headers: { authorization: basic(json.token) } })).status).toBe(200);
    const h = seen.git[0]!.req.headers;
    expect(h.get("x-queen-agent")).toBe("claude-code");
    expect(h.get("x-queen-agent-model")).toBe("claude-opus-4");
    expect(h.get("x-queen-user")).toBe("owner@kaikeru.com");
  });

  it("omits the model header when the agent token has no model", async () => {
    const { git, mint, seen } = await ctx();
    const { json } = await mint({ agent: { name: "codex" } });
    await git(REFS, { headers: { authorization: basic(json.token) } });
    const h = seen.git[0]!.req.headers;
    expect(h.get("x-queen-agent")).toBe("codex");
    expect(h.has("x-queen-agent-model")).toBe(false);
  });

  it("a human token never forwards agent headers, even if the client supplies them", async () => {
    const { git, mint, seen } = await ctx();
    const { json } = await mint();
    await git(REFS, {
      headers: { authorization: basic(json.token), "x-queen-agent": "evil", "x-queen-agent-model": "gpt-9" },
    });
    const h = seen.git[0]!.req.headers;
    expect(h.has("x-queen-agent")).toBe(false);
    expect(h.has("x-queen-agent-model")).toBe(false);
  });

  it("an agent token overrides client-supplied agent headers", async () => {
    const { git, mint, seen } = await ctx();
    const { json } = await mint({ agent: { name: "codex" } });
    await git(REFS, {
      headers: { authorization: basic(json.token), "x-queen-agent": "evil", "x-queen-agent-model": "gpt-9" },
    });
    const h = seen.git[0]!.req.headers;
    expect(h.get("x-queen-agent")).toBe("codex");
    expect(h.has("x-queen-agent-model")).toBe(false);
  });

  it("strips client-supplied agent headers on the Access JWT path", async () => {
    const { git, access, seen } = await ctx();
    await git(REFS, { headers: { "cf-access-token": access, "x-queen-agent": "evil", "x-queen-agent-model": "gpt-9" } });
    const h = seen.git[0]!.req.headers;
    expect(h.get("x-queen-user")).toBe("owner@kaikeru.com");
    expect(h.has("x-queen-agent")).toBe(false);
    expect(h.has("x-queen-agent-model")).toBe(false);
  });

  it("strips client-supplied agent headers in dev mode", async () => {
    const { app, env, seen } = await ctx({ ACCESS_MODE: "dev", DEV_USER_EMAIL: "dev@kaikeru.com" });
    await app.request("http://localhost:8787" + REFS, { headers: { "x-queen-agent": "evil", "x-queen-agent-model": "gpt-9" } }, env);
    const h = seen.git[0]!.req.headers;
    expect(h.has("x-queen-agent")).toBe(false);
    expect(h.has("x-queen-agent-model")).toBe(false);
  });

  it("strips client-supplied agent headers on the /hives/* proxy", async () => {
    const { api, seen } = await ctx();
    await api("/hives/demo/items", { headers: { "x-queen-agent": "evil", "x-queen-agent-model": "gpt-9" } });
    const h = seen.queen[0]!.headers;
    expect(h.get("x-queen-user")).toBe("owner@kaikeru.com");
    expect(h.has("x-queen-agent")).toBe(false);
    expect(h.has("x-queen-agent-model")).toBe(false);
  });

  it("authGitToken returns the agent (or null) and rejects a revoked agent token", async () => {
    const { reg, mint, api } = await ctx();
    const a = await mint({ agent: AGENT });
    const h = await hashToken(a.json.token);
    expect(await reg.authGitToken(h)).toMatchObject({ email: "owner@kaikeru.com", agent: AGENT });
    await api(`/api/git-tokens/${a.json.id}`, { method: "DELETE" });
    expect(await reg.authGitToken(h)).toBeNull();
  });

  it("migrates a git_tokens table created before agent columns existed", async () => {
    const ns = (testEnv as unknown as Bindings).REGISTRY;
    const stub = ns.get(ns.newUniqueId());
    // First construction creates the current table; replace it with the OLD schema and a legacy row,
    // then re-run the constructor's migration via a fresh instance.
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE git_tokens");
      sql.exec(`CREATE TABLE git_tokens (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL, label TEXT,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER)`);
      sql.exec("INSERT INTO git_tokens (id, email, hash, scopes, label, created_at, expires_at) VALUES ('old1', 'a@kaikeru.com', 'oldhash', 'read', NULL, 1, ?)", Date.now() + 1e9);
      expect(sql.exec("PRAGMA table_info(git_tokens)").toArray().map((c) => c.name)).not.toContain("agent_name");
      migrateGitTokens(sql);
      migrateGitTokens(sql); // idempotent
      const cols = sql.exec("PRAGMA table_info(git_tokens)").toArray().map((c) => c.name);
      expect(cols).toContain("agent_name");
      expect(cols).toContain("agent_model");
    });
    const list = await stub.listGitTokens("a@kaikeru.com");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "old1", agent: null });
    expect(await stub.authGitToken("oldhash")).toMatchObject({ email: "a@kaikeru.com", agent: null });
    const minted = await stub.mintGitToken({ id: "n1", hash: "h2", email: "a@kaikeru.com", scopes: ["push"], label: null, ttlMs: 1000, agent: { name: "codex", model: null } });
    expect(minted.agent).toEqual({ name: "codex", model: null });
  });
});

describe("git in dev mode", () => {
  it("bypasses auth on localhost only", async () => {
    const { app, env, seen } = await ctx({ ACCESS_MODE: "dev", DEV_USER_EMAIL: "Dev@kaikeru.com" });
    const ok = await app.request("http://localhost:8787" + REFS, {}, env);
    expect(ok.status).toBe(200);
    expect(seen.git[0]!.req.headers.get("x-queen-user")).toBe("dev@kaikeru.com");
    expect(seen.git[0]!.req.headers.get("x-queen-scopes")).toBe("read,push");
    expect((await app.request(HOST + REFS, {}, env)).status).toBe(403);
  });
});

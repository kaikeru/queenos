import { env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/app";
import { createApp } from "../src/app";
import { hashToken } from "../src/gittokens";
import { fakeBindings, freshVerifier, goodClaims, makeKey, sign } from "./helpers";

const HOST = "https://queenos.example.com";

async function ctx(overrides: Partial<Bindings> = {}, host = HOST) {
  const key = await makeKey("k1");
  const { verifier } = freshVerifier(() => [key]);
  const app = createApp(verifier);
  const ns = (testEnv as unknown as Bindings).REGISTRY;
  const { env, seen } = fakeBindings({ REGISTRY: ns, ...overrides });
  const reg = env.REGISTRY.get(env.REGISTRY.newUniqueId());
  const e2 = { ...env, REGISTRY: { ...env.REGISTRY, idFromName: () => "registry", get: () => reg } } as unknown as Bindings;
  const access = await sign(key, goodClaims());
  const api = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("cf-access-jwt-assertion", access);
    return app.request(`${HOST}${path}`, { ...init, headers }, e2);
  };
  const mcp = (path: string, init: RequestInit = {}) => app.request(`${host}${path}`, init, e2);
  const mint = async (body: unknown = {}) => {
    const r = await api("/api/git-tokens", { method: "POST", body: JSON.stringify(body) });
    return (await r.json()) as { token: string; id: string };
  };
  return { seen, api, mcp, mint, access, reg };
}

const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
const post = (headers: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: INIT });

describe("/mcp", () => {
  it("no credential: 401 JSON with WWW-Authenticate Bearer; nothing forwarded", async () => {
    const { mcp, seen } = await ctx();
    const r = await mcp("/mcp", post({}));
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe('Bearer realm="QueenOS"');
    expect(await r.json()).toEqual({ error: "unauthorized" });
    expect(seen.mcp).toEqual([]);
  });

  it("only a Bearer qgt_ token: Basic, an Access JWT and a non-qgt Bearer are 401", async () => {
    const { mcp, mint, access } = await ctx();
    const { token } = await mint();
    expect((await mcp("/mcp", post({ authorization: `Basic ${btoa(`x:${token}`)}` }))).status).toBe(401);
    expect((await mcp("/mcp", post({ "cf-access-token": access }))).status).toBe(401);
    expect((await mcp("/mcp", post({ authorization: "Bearer art_v1_nope" }))).status).toBe(401);
  });

  it("a good push token is forwarded with the owner and the token id; client identity headers and the credential are stripped; the agent binding is ignored", async () => {
    const { mcp, mint, seen } = await ctx();
    const { token, id } = await mint({ agent: { name: "claude-code", model: "claude-opus-4" } });
    const r = await mcp("/mcp", post({
      authorization: `Bearer ${token}`,
      "x-queen-user": "evil@example.org",
      "x-queen-token-id": "forged",
      "x-queen-agent": "forged",
      "x-queen-agent-model": "forged",
      "x-queen-scopes": "read,push",
      cookie: "a=b",
      accept: "application/json, text/event-stream",
      "mcp-session-id": "sess-1",
    }));
    expect(r.status).toBe(200);
    expect(r.headers.get("x-from")).toBe("mcp");
    expect(r.headers.get("mcp-session-id")).toBe("sess-1");
    const s = seen.mcp[0]!;
    expect(new URL(s.req.url).pathname).toBe("/mcp");
    expect(s.body).toBe(INIT);
    const h = s.req.headers;
    expect(h.get("x-queen-user")).toBe("owner@example.org");
    expect(h.get("x-queen-token-id")).toBe(id);
    for (const gone of ["authorization", "cookie", "x-queen-agent", "x-queen-agent-model", "x-queen-scopes"]) expect(h.get(gone), gone).toBeNull();
    expect(h.get("accept")).toBe("application/json, text/event-stream");
    expect(h.get("mcp-session-id")).toBe("sess-1");
    expect((await mcp("/mcp/sse", { method: "GET", headers: { authorization: `Bearer ${token}` } })).status).toBe(200); // /mcp/* too
  });

  it("strips the Access credentials too: cf-access-token and cf-access-jwt-assertion never reach queenos-mcp", async () => {
    const { mcp, mint, seen, access } = await ctx();
    const { token } = await mint();
    const r = await mcp("/mcp", post({ authorization: `Bearer ${token}`, "cf-access-token": access, "cf-access-jwt-assertion": access }));
    expect(r.status).toBe(200);
    const h = seen.mcp[0]!.req.headers;
    for (const gone of ["authorization", "cf-access-token", "cf-access-jwt-assertion"]) expect(h.get(gone), gone).toBeNull();
  });

  it("a read-only token is 403 (an attempt writes code)", async () => {
    const { mcp, mint } = await ctx();
    const { token } = await mint({ scopes: ["read"] });
    const r = await mcp("/mcp", post({ authorization: `Bearer ${token}` }));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "token lacks push scope" });
  });

  it("bad tokens count toward the shared failure limit: 429 with retry-after, even for a good token from that IP", async () => {
    const { mcp, mint } = await ctx();
    const { token } = await mint();
    const ip = { "cf-connecting-ip": "203.0.113.7" };
    for (let i = 0; i < 10; i++) expect((await mcp("/mcp", post({ ...ip, authorization: `Bearer qgt_bad${i}` }))).status).toBe(401);
    const blocked = await mcp("/mcp", post({ ...ip, authorization: `Bearer ${token}` }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("a revoked token is 401", async () => {
    const { mcp, mint, api } = await ctx();
    const { token, id } = await mint();
    await api(`/api/git-tokens/${id}`, { method: "DELETE" });
    expect((await mcp("/mcp", post({ authorization: `Bearer ${token}` }))).status).toBe(401);
  });

  it("dev mode: localhost only, owner DEV_USER_EMAIL, token id dev", async () => {
    const dev = { ACCESS_MODE: "dev", DEV_USER_EMAIL: "Dev@Example.org" } as Partial<Bindings>;
    const local = await ctx(dev, "http://localhost:8787");
    expect((await local.mcp("/mcp", post({}))).status).toBe(200);
    expect(local.seen.mcp[0]!.req.headers.get("x-queen-user")).toBe("dev@example.org");
    expect(local.seen.mcp[0]!.req.headers.get("x-queen-token-id")).toBe("dev");
    const remote = await ctx(dev);
    expect((await remote.mcp("/mcp", post({}))).status).toBe(403);
  });

  it("dev mode ignores a forged x-queen-user and x-queen-token-id from the client", async () => {
    const dev = { ACCESS_MODE: "dev", DEV_USER_EMAIL: "dev@example.org" } as Partial<Bindings>;
    const local = await ctx(dev, "http://localhost:8787");
    const r = await local.mcp("/mcp", post({ "x-queen-user": "evil@example.org", "x-queen-token-id": "forged", "x-queen-agent": "forged" }));
    expect(r.status).toBe(200);
    const h = local.seen.mcp[0]!.req.headers;
    expect(h.get("x-queen-user")).toBe("dev@example.org");
    expect(h.get("x-queen-token-id")).toBe("dev");
    expect(h.get("x-queen-agent")).toBeNull();
  });
});

describe("/git header hygiene", () => {
  it("strips a client-supplied x-queen-token-id (the git door never sets one) and forged identity", async () => {
    const { mcp, mint, seen } = await ctx();
    const { token } = await mint();
    const r = await mcp("/git/demo-hive.git/info/refs?service=git-upload-pack", {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, "x-queen-token-id": "forged", "x-queen-user": "evil@example.org" },
    });
    expect(r.status).toBe(200);
    const h = seen.git[0]!.req.headers;
    expect(h.get("x-queen-token-id")).toBeNull();
    expect(h.get("x-queen-user")).toBe("owner@example.org");
    expect(h.get("authorization")).toBeNull();
  });
});

describe("HiveRegistry.authGitToken", () => {
  it("returns the token id (never the hash or the secret)", async () => {
    const { mint, reg } = await ctx();
    const { token, id } = await mint();
    const found = await reg.authGitToken(await hashToken(token));
    expect(found).toMatchObject({ id, email: "owner@example.org", scopes: ["read", "push"], agent: null });
    expect(JSON.stringify(found)).not.toContain(token);
  });
});

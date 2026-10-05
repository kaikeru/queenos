import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { METRIC_TEMPLATE_NAMES, buildQuery, sqlString } from "../src/metrics";
import { fakeBindings, freshVerifier, goodClaims, makeKey, sign } from "./helpers";

async function setup(upstream: (url: string, init: RequestInit) => Promise<Response>, over: Record<string, string | undefined> = {}) {
  const key = await makeKey("k1");
  const { verifier } = freshVerifier(() => [key]);
  const calls: { url: string; init: RequestInit }[] = [];
  const app = createApp(verifier, async (url, init) => {
    calls.push({ url, init });
    return upstream(url, init);
  });
  const { env, seen } = fakeBindings({ ACCOUNT_ID: "acct1", ANALYTICS_API_TOKEN: "secret-token", ...over });
  const token = await sign(key, goodClaims());
  const call = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("cf-access-jwt-assertion", token);
    return app.request(`https://queenos.kaikeru.com${path}`, { ...init, headers }, env);
  };
  return { call, calls, seen };
}

const ok = async () => Response.json({ meta: [], data: [{ t: "2026-10-05 00:00:00", builds: 3 }], rows: 1 });

describe("GET /api/metrics/:hive", () => {
  it("runs an allowlisted template against the AE SQL API with the bearer token", async () => {
    const { call, calls } = await setup(ok);
    const res = await call("/api/metrics/demo?q=concurrency&window=7d");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ source: "ae", hive: "demo", template: "concurrency", window: "7d", rows: [{ builds: 3 }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct1/analytics_engine/sql");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer secret-token");
    const sql = String(calls[0]!.init.body);
    expect(sql).toContain("FROM queenos_events");
    expect(sql).toContain("index1 = 'demo'");
    expect(sql).toContain("INTERVAL '7' DAY");
    expect(sql).toMatch(/FORMAT JSON$/);
  });

  it("every template is reachable, filtered to the hive and the window", async () => {
    const { call, calls } = await setup(ok);
    for (const q of METRIC_TEMPLATE_NAMES) expect((await call(`/api/metrics/demo?q=${q}`)).status).toBe(200);
    expect(calls).toHaveLength(METRIC_TEMPLATE_NAMES.length);
    for (const c of calls) {
      expect(String(c.init.body)).toContain("index1 = 'demo' AND timestamp > NOW() - INTERVAL '24' HOUR");
    }
  });

  it("rejects an unknown template with 400 and never calls upstream", async () => {
    const { call, calls } = await setup(ok);
    for (const q of ["", "nope", "constructor", "__proto__", "toString", "concurrency; DROP TABLE x"]) {
      const res = await call(`/api/metrics/demo?q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(400);
    }
    expect((await call("/api/metrics/demo")).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("accepts no raw SQL: extra params, bodies and a bad window are refused", async () => {
    const { call, calls } = await setup(ok);
    expect((await call("/api/metrics/demo?q=concurrency&sql=SELECT%201")).status).toBe(400);
    expect((await call("/api/metrics/demo?q=concurrency&query=SELECT%201")).status).toBe(400);
    expect((await call("/api/metrics/demo?q=concurrency&window=1h%27%20OR%201=1")).status).toBe(400);
    expect((await call("/api/metrics/demo?q=concurrency&window=90d")).status).toBe(400);
    const post = await call("/api/metrics/demo?q=concurrency", { method: "POST", body: "SELECT 1" });
    expect(post.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("validates the hive slug, so a hive cannot smuggle SQL", async () => {
    const { call, calls } = await setup(ok);
    for (const h of ["demo'%20OR%20'1'='1", "a;b", "DEMO", "demo%5C"]) {
      expect((await call(`/api/metrics/${h}?q=concurrency`)).status, h).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("escapes bound values as string literals", () => {
    expect(sqlString("o'brien")).toBe("'o''brien'");
    expect(sqlString("a\\' OR 1=1 --")).toBe("'a\\\\'' OR 1=1 --'");
    expect(sqlString("x\n\u0000y")).toBe("'xy'");
    // Even a hostile hive (bypassing the slug check) stays inside its literal.
    const sql = buildQuery("concurrency", "x' OR '1'='1", "24h");
    expect(sql).toContain("index1 = 'x'' OR ''1''=''1'");
  });

  it("returns 503 without the secret or the account id", async () => {
    for (const over of [{ ANALYTICS_API_TOKEN: undefined }, { ACCOUNT_ID: undefined }]) {
      const { call, calls } = await setup(ok, over);
      expect((await call("/api/metrics/demo?q=concurrency")).status).toBe(503);
      expect(calls).toHaveLength(0);
    }
  });

  it("returns 503 on an upstream error, a bad body or a network failure, without leaking the token", async () => {
    const cases = [
      async () => new Response("denied", { status: 403 }),
      async () => new Response("not json", { status: 200 }),
      async () => Response.json({ nope: true }),
      async () => {
        throw new Error("boom secret-token");
      },
    ];
    for (const up of cases) {
      const { call } = await setup(up);
      const res = await call("/api/metrics/demo?q=concurrency");
      expect(res.status).toBe(503);
      expect(await res.text()).not.toContain("secret-token");
    }
  });

  it("still requires Access auth", async () => {
    const { call } = await setup(ok);
    const app = createApp();
    const res = await app.request("https://queenos.kaikeru.com/api/metrics/demo?q=concurrency", {}, fakeBindings().env);
    expect(res.status).toBe(401);
    expect(call).toBeTypeOf("function");
  });
});

import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { fakeBindings, freshVerifier, goodClaims, makeKey, sign } from "./helpers";

async function setup() {
  const key = await makeKey("k1");
  const { verifier } = freshVerifier(() => [key]);
  const app = createApp(verifier);
  const { env, seen } = fakeBindings();
  const token = await sign(key, goodClaims());
  const call = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("cf-access-jwt-assertion", token);
    return app.request(`https://queenos.kaikeru.com${path}`, { ...init, headers }, env);
  };
  return { call, seen };
}

const json = { "content-type": "application/json" };

describe("v2 Queen routes through the edge", () => {
  const userRoutes: [string, string, string][] = [
    ["PATCH", "/hives/demo/settings", "settings"],
    ["POST", "/hives/demo/escalations/e1/resolve", "resolve"],
    ["POST", "/hives/demo/items", "file"],
    ["POST", "/hives/demo/items/i1/actions", "actions"],
    ["POST", "/hives/demo/releases/r1/tap", "tap"],
  ];

  it.each(userRoutes)("%s %s forwards with the verified user, stripping a spoofed one", async (method, path) => {
    const { call, seen } = await setup();
    const res = await call(path, {
      method,
      headers: { ...json, "x-queen-user": "evil@attacker.com", cookie: "a=b" },
      body: JSON.stringify({ x: 1 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ from: "queen", path, user: "kyle@kaikeru.com" });
    expect(seen.queen).toHaveLength(1);
    const fwd = seen.queen[0]!;
    expect(fwd.method).toBe(method);
    expect(fwd.headers.get("x-queen-user")).toBe("kyle@kaikeru.com");
    expect(fwd.headers.get("cookie")).toBeNull();
    expect(fwd.headers.get("cf-access-jwt-assertion")).toBeNull();
    expect(await fwd.json()).toEqual({ x: 1 });
  });

  it("sets the user even when the client sends several spoofed values", async () => {
    const { call, seen } = await setup();
    const h = new Headers({ ...json });
    h.append("x-queen-user", "a@x.com");
    h.append("X-Queen-User", "b@x.com");
    await call("/hives/demo/items", { method: "POST", headers: h, body: "{}" });
    expect(seen.queen[0]!.headers.get("x-queen-user")).toBe("kyle@kaikeru.com");
  });

  it.each([
    "/hives/demo/items/i1",
    "/hives/demo/events?typePrefix=queue&limit=50",
    "/hives/demo/traces/0123456789abcdef0123456789abcdef",
    "/hives/demo/metrics?window=24h",
    "/hives/demo/queue",
  ])("GET %s reaches the Queen with the query intact", async (path) => {
    const { call, seen } = await setup();
    const res = await call(path);
    expect(res.status).toBe(200);
    expect(seen.queen).toHaveLength(1);
    const u = new URL(seen.queen[0]!.url);
    expect(u.pathname + u.search).toBe(path);
    expect(seen.queen[0]!.headers.get("x-queen-user")).toBe("kyle@kaikeru.com");
  });

  it("routes the merge-result webhook like build-result, keeping the bearer token", async () => {
    const { call, seen } = await setup();
    for (const hook of ["build-result", "merge-result"]) {
      const res = await call(`/hives/demo/internal/webhook/${hook}`, {
        method: "POST",
        headers: { ...json, authorization: "Bearer internal-token" },
        body: JSON.stringify({ commandId: "c1" }),
      });
      expect(res.status).toBe(200);
    }
    expect(seen.queen.map((r) => new URL(r.url).pathname)).toEqual([
      "/hives/demo/internal/webhook/build-result",
      "/hives/demo/internal/webhook/merge-result",
    ]);
    for (const r of seen.queen) expect(r.headers.get("authorization")).toBe("Bearer internal-token");
  });

  it("/api/metrics is not forwarded to the Queen", async () => {
    const { call, seen } = await setup();
    await call("/api/metrics/demo?q=nope");
    expect(seen.queen).toHaveLength(0);
  });
});

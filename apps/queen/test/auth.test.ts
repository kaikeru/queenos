import { exports } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requireInternalAuth, safeEqual, type AuthBindings } from "../src/auth";

const worker = exports.default;
const hive = () => `hive-${crypto.randomUUID().slice(0, 8)}`;
const TOKEN = "test-internal-token";

const scribe = { trainId: "t1", summary: "s" };
const routes: Array<[string, string, unknown]> = [
  ["/internal/webhook/train-result", "POST", { trainId: "t1", status: "PASSED" }],
  ["/internal/webhook/build-result", "POST", {}],
  ["/internal/webhook/land-result", "POST", {}],
  ["/internal/webhook/provision-result", "POST", {}],
  ["/internal/webhook/deploy-result", "POST", {}],
  ["/internal/webhook/sentinel-verdict", "POST", {}],
  ["/trains/t1/result", "POST", {}],
  ["/audit", "POST", {}],
  ["/scribe", "POST", scribe],
];

function call(path: string, body: unknown, token?: string) {
  return worker.fetch(`http://queen.test/hives/${hive()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: token }) },
    body: JSON.stringify(body),
  });
}

describe("internal route auth", () => {
  for (const [path, , body] of routes) {
    it(`${path}: 401 without a token`, async () => {
      const res = await call(path, body);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
    });
    it(`${path}: 401 with a wrong token`, async () => {
      expect((await call(path, body, "Bearer nope")).status).toBe(401);
      expect((await call(path, body, "Basic " + TOKEN)).status).toBe(401);
    });
    it(`${path}: passes auth with the right token (reaches validation)`, async () => {
      const res = await call(path, body, `Bearer ${TOKEN}`);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(503);
    });
  }

  it("returns 201 for a valid audit event with the right token", async () => {
    const ns = hive();
    const sub = await worker.fetch(`http://queen.test/hives/${ns}/prompts`, {
      method: "POST", // /prompts stays open: no token
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ namespace: ns, promptText: "x" }),
    });
    expect(sub.status).toBe(201);
    const { promptRun } = await sub.json<{ promptRun: { promptId: string } }>();
    const audit = { promptId: promptRun.promptId, droneRole: "POLICY", status: "RUNNING" };
    const send = (authorization?: string) =>
      worker.fetch(`http://queen.test/hives/${ns}/audit`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
        body: JSON.stringify(audit),
      });
    expect((await send()).status).toBe(401);
    expect((await send("Bearer wrong")).status).toBe(401);
    expect((await send(`Bearer ${TOKEN}`)).status).toBe(201);
  });

  it("leaves /health and /snapshot open", async () => {
    expect((await worker.fetch("http://queen.test/health")).status).toBe(200);
    expect((await worker.fetch(`http://queen.test/hives/${hive()}/snapshot`)).status).toBe(200);
  });
});

describe("requireInternalAuth config modes", () => {
  const app = new Hono<{ Bindings: AuthBindings }>();
  app.use("*", requireInternalAuth);
  app.post("/x", (c) => c.json({ ok: true }));
  const run = (env: AuthBindings, token?: string) =>
    app.request("/x", { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} }, env);

  it("503 when the secret is unset (fail closed)", async () => {
    expect((await run({})).status).toBe(503);
    expect((await run({}, "anything")).status).toBe(503);
  });
  it("2xx with the correct token; 401 otherwise", async () => {
    expect((await run({ QUEEN_INTERNAL_TOKEN: "s3" }, "s3")).status).toBe(200);
    expect((await run({ QUEEN_INTERNAL_TOKEN: "s3" }, "s4")).status).toBe(401);
    expect((await run({ QUEEN_INTERNAL_TOKEN: "s3" })).status).toBe(401);
  });
  it('QUEEN_INTERNAL_AUTH="disabled" bypasses auth', async () => {
    expect((await run({ QUEEN_INTERNAL_AUTH: "disabled" })).status).toBe(200);
  });
  it("only the exact value 'disabled' bypasses", async () => {
    expect((await run({ QUEEN_INTERNAL_AUTH: "true", QUEEN_INTERNAL_TOKEN: "s" })).status).toBe(401);
  });
});

describe("safeEqual", () => {
  it("compares strings of any length", async () => {
    expect(await safeEqual("abc", "abc")).toBe(true);
    expect(await safeEqual("abc", "abd")).toBe(false);
    expect(await safeEqual("abc", "abcd")).toBe(false);
    expect(await safeEqual("", "")).toBe(true);
  });
});

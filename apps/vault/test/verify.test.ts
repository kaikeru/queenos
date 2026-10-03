import { describe, expect, it } from "vitest";
import { CHECK_SUBDOMAIN, CHECK_TOKEN, CHECK_WRITE, redact, verifyCloudflare } from "../src/verify";
import { ACCOUNT, FakeCloudflare, TOKEN } from "./fakes";

const creds = { accountId: ACCOUNT, apiToken: TOKEN };

describe("verifyCloudflare", () => {
  it("verifies the account token, runs the write probe on <hive>-app, reads the subdomain", async () => {
    const cf = new FakeCloudflare();
    const r = await verifyCloudflare("acme", creds, cf.fetch);
    expect(r.ok).toBe(true);
    expect(r.checks).toEqual([
      { name: CHECK_TOKEN, ok: true, detail: `account token is active for account ${ACCOUNT}` },
      { name: CHECK_WRITE, ok: true, detail: "created Worker acme-app" },
      { name: CHECK_SUBDOMAIN, ok: true, detail: "kaikeru.workers.dev" },
    ]);
    expect(cf.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /accounts/${ACCOUNT}/tokens/verify`,
      `GET /accounts/${ACCOUNT}/workers/workers/acme-app`,
      `POST /accounts/${ACCOUNT}/workers/workers`,
      `GET /accounts/${ACCOUNT}/workers/subdomain`,
    ]);
    expect(JSON.parse(cf.calls[2]!.body!)).toMatchObject({ name: "acme-app", subdomain: { enabled: true, previews_enabled: true } });
    // The token travels only in the Authorization header.
    for (const c of cf.calls) {
      expect(c.auth).toBe(`Bearer ${TOKEN}`);
      expect(c.path).not.toContain(TOKEN);
      expect(c.body ?? "").not.toContain(TOKEN);
    }
  });

  it("an existing parent Worker passes the probe without re-creating it", async () => {
    const r = await verifyCloudflare("acme", creds, new FakeCloudflare({ workerExists: true }).fetch);
    expect(r.checks[1]).toEqual({ name: CHECK_WRITE, ok: true, detail: "Worker acme-app already exists" });
  });

  it("falls back to /user/tokens/verify for a user token", async () => {
    const cf = new FakeCloudflare({ accountVerify: 401, userVerify: 200 });
    const r = await verifyCloudflare("acme", creds, cf.fetch);
    expect(r.ok).toBe(true);
    expect(r.checks[0]).toEqual({ name: CHECK_TOKEN, ok: true, detail: "user token is active" });
  });

  it("a rejected token fails without a write probe", async () => {
    const cf = new FakeCloudflare({ accountVerify: 401, userVerify: 401 });
    const r = await verifyCloudflare("acme", creds, cf.fetch);
    expect(r.ok).toBe(false);
    expect(r.checks[0]).toMatchObject({ name: CHECK_TOKEN, ok: false });
    expect(r.checks[0]!.detail).toMatch(/rejected the token for account/);
    expect(r.checks[1]).toEqual({ name: CHECK_WRITE, ok: false, detail: "skipped: the token is not active" });
    expect(cf.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("an inactive token fails", async () => {
    const r = await verifyCloudflare("acme", creds, new FakeCloudflare({ tokenStatus: "disabled" }).fetch);
    expect(r.ok).toBe(false);
    expect(r.checks[0]).toEqual({ name: CHECK_TOKEN, ok: false, detail: 'token status is "disabled"' });
  });

  it("a token without Workers Scripts: Edit fails the write probe", async () => {
    const r = await verifyCloudflare("acme", creds, new FakeCloudflare({ write: 403 }).fetch);
    expect(r.ok).toBe(false);
    expect(r.checks).toHaveLength(2);
    expect(r.checks[1]).toMatchObject({ name: CHECK_WRITE, ok: false });
    expect(r.checks[1]!.detail).toMatch(/^missing "Workers Scripts: Edit" on account 0123456789abcdef0123456789abcdef \(/);
  });

  it("a missing workers.dev subdomain is reported but not fatal", async () => {
    const r = await verifyCloudflare("acme", creds, new FakeCloudflare({ subdomain: null }).fetch);
    expect(r.ok).toBe(true);
    expect(r.checks[2]).toMatchObject({ name: CHECK_SUBDOMAIN, ok: false });
  });

  it("redacts Cloudflare error text that echoes the token", async () => {
    for (const opts of [{ accountVerify: 403, userVerify: 403 }, { write: 403 }, { subdomain: null }]) {
      const r = await verifyCloudflare("acme", creds, new FakeCloudflare({ ...opts, echoToken: true }).fetch);
      const text = JSON.stringify(r);
      expect(text).toContain("[redacted]");
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(TOKEN.slice(0, 20));
      for (const c of r.checks) expect((c.detail ?? "").length).toBeLessThanOrEqual(300);
    }
  });

  it("a network failure is a failed check, not a throw", async () => {
    const r = await verifyCloudflare("acme", creds, async () => {
      throw new Error(`socket closed while sending Bearer ${TOKEN}`);
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});

describe("redact", () => {
  it("removes the token, bearer values and long credential-like runs, keeping allow-listed ids", () => {
    const s = redact(`a ${TOKEN} b Bearer xyz.123 c ${"Q".repeat(40)} d ${ACCOUNT} e acme-app`, TOKEN, [ACCOUNT]);
    expect(s).toBe(`a [redacted] b Bearer [redacted] c [redacted] d ${ACCOUNT} e acme-app`);
    expect(redact("ab ".repeat(200), "t")).toHaveLength(300);
  });
});

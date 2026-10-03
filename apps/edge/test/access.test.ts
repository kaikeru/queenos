import { describe, expect, it } from "vitest";
import { AccessError, extractToken } from "../src/access";
import { AUD, ISS, TEAM, freshVerifier, goodClaims, makeKey, sign } from "./helpers";

const cfg = { team: TEAM, aud: AUD, allowedEmailDomains: ["kaikeru.com"] };

async function setup() {
  const key = await makeKey("k1");
  const { verifier, calls } = freshVerifier(() => [key]);
  return { key, verifier, calls };
}

async function reject(p: Promise<unknown>): Promise<AccessError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AccessError);
    return e as AccessError;
  }
  throw new Error("expected rejection");
}

describe("Access JWT verification", () => {
  it("accepts a valid token and lowercases the email", async () => {
    const { key, verifier } = await setup();
    const t = await sign(key, goodClaims({ email: "Kyle@Kaikeru.com" }));
    expect(await verifier.verify(t, cfg)).toEqual({ email: "kyle@kaikeru.com" });
  });

  it("accepts aud as a plain string", async () => {
    const { key, verifier } = await setup();
    expect((await verifier.verify(await sign(key, goodClaims({ aud: AUD })), cfg)).email).toBe("kyle@kaikeru.com");
  });

  it("rejects an expired token (beyond skew)", async () => {
    const { key, verifier } = await setup();
    const exp = Math.floor(Date.now() / 1000) - 600;
    const e = await reject(verifier.verify(await sign(key, goodClaims({ exp })), cfg));
    expect(e.status).toBe(401);
    expect(e.reason).toMatch(/expired/);
  });

  it("tolerates small clock skew on exp", async () => {
    const { key, verifier } = await setup();
    const exp = Math.floor(Date.now() / 1000) - 10;
    await expect(verifier.verify(await sign(key, goodClaims({ exp })), cfg)).resolves.toBeTruthy();
  });

  it("rejects a token that is not yet valid", async () => {
    const { key, verifier } = await setup();
    const nbf = Math.floor(Date.now() / 1000) + 600;
    expect((await reject(verifier.verify(await sign(key, goodClaims({ nbf })), cfg))).reason).toMatch(/not yet/);
  });

  it("rejects the wrong audience", async () => {
    const { key, verifier } = await setup();
    expect((await reject(verifier.verify(await sign(key, goodClaims({ aud: ["other"] })), cfg))).reason).toBe("bad audience");
  });

  it("rejects the wrong issuer", async () => {
    const { key, verifier } = await setup();
    const t = await sign(key, goodClaims({ iss: "https://evil.cloudflareaccess.com" }));
    expect((await reject(verifier.verify(t, cfg))).reason).toBe("bad issuer");
    expect(ISS).toContain(TEAM);
  });

  it("rejects an email outside the allowed domains with 403", async () => {
    const { key, verifier } = await setup();
    const e = await reject(verifier.verify(await sign(key, goodClaims({ email: "a@evil.com" })), cfg));
    expect(e.status).toBe(403);
    const e2 = await reject(verifier.verify(await sign(key, goodClaims({ email: "a@sub.kaikeru.com" })), cfg));
    expect(e2.status).toBe(403);
    const e3 = await reject(verifier.verify(await sign(key, goodClaims({ email: undefined })), cfg));
    expect(e3.status).toBe(403);
  });

  it("rejects a bad signature", async () => {
    const { key, verifier } = await setup();
    const other = await makeKey("k1"); // same kid, different key
    const t = await sign(other, goodClaims());
    expect((await reject(verifier.verify(t, cfg))).reason).toBe("bad signature");
    const good = await sign(key, goodClaims());
    const tampered = good.slice(0, -4) + (good.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect((await reject(verifier.verify(tampered, cfg))).status).toBe(401);
  });

  it("rejects malformed tokens and alg none", async () => {
    const { verifier } = await setup();
    expect((await reject(verifier.verify("not-a-jwt", cfg))).status).toBe(401);
    const none = `${btoa(JSON.stringify({ alg: "none", kid: "k1" }))}.${btoa("{}")}.`;
    expect((await reject(verifier.verify(none, cfg))).status).toBe(401);
  });

  it("refetches the JWKS on an unknown kid (rate limited)", async () => {
    const k1 = await makeKey("k1");
    const k2 = await makeKey("k2");
    let keys = [k1];
    let t = 1_000_000_000_000;
    const { verifier, calls } = freshVerifier(() => keys, () => t);
    const c = (over = {}) => goodClaims(over, t);
    await verifier.verify(await sign(k1, c()), cfg);
    expect(calls).toHaveLength(1);
    await verifier.verify(await sign(k1, c()), cfg); // cached
    expect(calls).toHaveLength(1);

    // k2 appears (key rotation) but we are inside the cooldown: no refetch.
    keys = [k1, k2];
    t += 1000;
    expect((await reject(verifier.verify(await sign(k2, c()), cfg))).reason).toBe("unknown key id");
    expect(calls).toHaveLength(1);

    // After the cooldown the unknown kid triggers a refetch and succeeds.
    t += 60_000;
    await verifier.verify(await sign(k2, c()), cfg);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe("https://kaikeru.cloudflareaccess.com/cdn-cgi/access/certs");
  });

  it("refetches after the TTL", async () => {
    const k1 = await makeKey("k1");
    let t = 1_000_000_000_000;
    const { verifier, calls } = freshVerifier(() => [k1], () => t);
    await verifier.verify(await sign(k1, goodClaims({}, t)), cfg);
    t += 11 * 60_000;
    await verifier.verify(await sign(k1, goodClaims({}, t)), cfg);
    expect(calls).toHaveLength(2);
  });

  it("returns 503 when the JWKS endpoint fails", async () => {
    const { createVerifier } = await import("../src/access");
    const key = await makeKey("k1");
    const v = createVerifier({ fetcher: async () => new Response("<html>error</html>", { status: 500 }) });
    expect((await reject(v.verify(await sign(key, goodClaims()), cfg))).status).toBe(503);
  });
});

describe("extractToken", () => {
  it("prefers the header, falls back to the cookie", () => {
    expect(extractToken(new Request("https://x/", { headers: { "cf-access-jwt-assertion": "h", cookie: "CF_Authorization=c" } }))).toBe("h");
    expect(extractToken(new Request("https://x/", { headers: { cookie: "a=1; CF_Authorization=c.d.e" } }))).toBe("c.d.e");
    expect(extractToken(new Request("https://x/"))).toBeNull();
  });
});

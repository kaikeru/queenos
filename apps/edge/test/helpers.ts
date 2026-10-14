import { env } from "cloudflare:test";
import type { Bindings, VaultPort } from "../src/app";
import { createVerifier } from "../src/access";

export const TEAM = "example";
export const AUD = "test-aud";
export const ISS = `https://${TEAM}.cloudflareaccess.com`;

const enc = new TextEncoder();
function b64url(bytes: Uint8Array | string): string {
  const u = typeof bytes === "string" ? enc.encode(bytes) : bytes;
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: JsonWebKey & { kid: string };
}

export async function makeKey(kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

export async function sign(
  key: TestKey,
  claims: Record<string, unknown>,
  opts: { kid?: string } = {},
): Promise<string> {
  const h = b64url(JSON.stringify({ alg: "RS256", kid: opts.kid ?? key.kid, typ: "JWT" }));
  const p = b64url(JSON.stringify(claims));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, enc.encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}

export function goodClaims(over: Record<string, unknown> = {}, nowMs = Date.now()): Record<string, unknown> {
  const now = Math.floor(nowMs / 1000);
  return { iss: ISS, aud: [AUD], email: "owner@example.org", sub: "u1", iat: now, nbf: now - 5, exp: now + 3600, ...over };
}

/** A fetcher serving a fake JWKS; counts calls. */
export function fakeJwks(getKeys: () => TestKey[]) {
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    return Response.json({ keys: getKeys().map((k) => k.jwk) });
  };
  return { fetcher, calls };
}

export function freshVerifier(getKeys: () => TestKey[], now?: () => number) {
  const j = fakeJwks(getKeys);
  return { verifier: createVerifier({ fetcher: j.fetcher, now }), calls: j.calls };
}

export interface Seen {
  vault: unknown[][];
  genesis: Request[];
  queen: Request[];
  assets: Request[];
  git: { req: Request; body: string }[];
  mcp: { req: Request; body: string }[];
}

export function fakeBindings(overrides: Partial<Bindings> = {}): { env: Bindings; seen: Seen } {
  const seen: Seen = { vault: [], genesis: [], queen: [], assets: [], git: [], mcp: [] };
  const vault: VaultPort = {
    async connectCloudflare(hive, creds, email) {
      seen.vault.push(["connect", hive, creds, email]);
      return { hive, secret: "cloudflare", connected: true, accountId: creds.accountId, verifiedAt: 1, checks: [] };
    },
    async status(hive) {
      seen.vault.push(["status", hive]);
      return { hive, secret: "cloudflare", connected: false, accountId: null, verifiedAt: null, checks: [] };
    },
    async tokenTemplateUrl() {
      return { url: "https://dash.cloudflare.com/profile/api-tokens?template" };
    },
  };
  const env: Bindings = {
    ACCESS_TEAM: TEAM,
    ALLOWED_EMAIL_DOMAINS: "example.org",
    ACCESS_AUD: AUD,
    REGISTRY: (env_ as unknown as Bindings).REGISTRY,
    VAULT: vault,
    GENESIS: {
      async fetch(req) {
        seen.genesis.push(req);
        return Response.json({ from: "genesis", path: new URL(req.url).pathname, user: req.headers.get("x-queen-user") });
      },
    },
    QUEEN: {
      async fetch(req) {
        seen.queen.push(req);
        return Response.json({ from: "queen", path: new URL(req.url).pathname, user: req.headers.get("x-queen-user") });
      },
    },
    GIT: {
      async fetch(req) {
        seen.git.push({ req, body: await req.clone().text() });
        return new Response("git-says:" + new URL(req.url).pathname + new URL(req.url).search, {
          status: 200,
          headers: { "content-type": "application/x-git-upload-pack-advertisement", "x-from": "git" },
        });
      },
    },
    MCP: {
      async fetch(req) {
        seen.mcp.push({ req, body: await req.clone().text() });
        return new Response("event: message\ndata: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream", "x-from": "mcp", "mcp-session-id": "sess-1" } });
      },
    },
    ASSETS: {
      async fetch(req) {
        seen.assets.push(req);
        return new Response("<html>spa</html>", { headers: { "content-type": "text/html" } });
      },
    },
    ...overrides,
  };
  return { env, seen };
}
const env_ = env;

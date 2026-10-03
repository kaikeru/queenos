/**
 * Cloudflare Access JWT verification (RS256, Web Crypto only).
 * Keys come from https://<team>.cloudflareaccess.com/cdn-cgi/access/certs, are
 * cached in module scope, and are refetched (rate limited) on an unknown `kid`.
 */

export type Fetcher_ = (url: string) => Promise<Response>;

export class AccessError extends Error {
  constructor(
    readonly status: 401 | 403 | 503,
    readonly reason: string,
  ) {
    super(reason);
  }
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  n?: string;
  e?: string;
}

export interface VerifyConfig {
  team: string;
  aud: string;
  allowedEmailDomains: string[];
}

export interface VerifierOptions {
  fetcher?: Fetcher_;
  now?: () => number;
  /** Cache lifetime for the whole key set. */
  ttlMs?: number;
  /** Minimum gap between refetches triggered by unknown kids. */
  refetchCooldownMs?: number;
  /** Clock skew tolerance for exp/nbf. */
  skewSec?: number;
}

const decoder = new TextDecoder();

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function parseJson(part: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(decoder.decode(b64urlToBytes(part)));
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new AccessError(401, "malformed token");
}

export function createVerifier(opts: VerifierOptions = {}) {
  const fetcher: Fetcher_ = opts.fetcher ?? ((url) => fetch(url));
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? 10 * 60_000;
  const cooldownMs = opts.refetchCooldownMs ?? 30_000;
  const skew = opts.skewSec ?? 60;

  // team -> cached key set
  const caches = new Map<string, { keys: Map<string, CryptoKey>; fetchedAt: number }>();

  async function load(team: string): Promise<{ keys: Map<string, CryptoKey>; fetchedAt: number }> {
    let res: Response;
    try {
      res = await fetcher(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
    } catch {
      throw new AccessError(503, "jwks unavailable");
    }
    if (!res.ok) throw new AccessError(503, "jwks unavailable");
    let body: { keys?: Jwk[] };
    try {
      body = (await res.json()) as { keys?: Jwk[] };
    } catch {
      throw new AccessError(503, "jwks invalid");
    }
    const keys = new Map<string, CryptoKey>();
    for (const jwk of body.keys ?? []) {
      if (!jwk.kid || jwk.kty !== "RSA") continue;
      try {
        const key = await crypto.subtle.importKey(
          "jwk",
          { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );
        keys.set(jwk.kid, key);
      } catch {
        // skip unusable key
      }
    }
    if (keys.size === 0) throw new AccessError(503, "jwks empty");
    const entry = { keys, fetchedAt: now() };
    caches.set(team, entry);
    return entry;
  }

  async function getKey(team: string, kid: string): Promise<CryptoKey> {
    let entry = caches.get(team);
    const t = now();
    if (!entry || t - entry.fetchedAt > ttlMs) entry = await load(team);
    let key = entry.keys.get(kid);
    if (!key && t - entry.fetchedAt >= cooldownMs) {
      entry = await load(team);
      key = entry.keys.get(kid);
    }
    if (!key) throw new AccessError(401, "unknown key id");
    return key;
  }

  /** Returns the verified, lowercased email or throws AccessError. */
  async function verify(token: string, cfg: VerifyConfig): Promise<{ email: string }> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new AccessError(401, "malformed token");
    const [h, p, s] = parts as [string, string, string];
    const header = parseJson(h);
    if (header.alg !== "RS256" || typeof header.kid !== "string") throw new AccessError(401, "unsupported token");

    const key = await getKey(cfg.team, header.kid);
    let sig: Uint8Array<ArrayBuffer>;
    try {
      sig = b64urlToBytes(s);
    } catch {
      throw new AccessError(401, "malformed token");
    }
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      sig,
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) throw new AccessError(401, "bad signature");

    const claims = parseJson(p);
    const nowSec = Math.floor(now() / 1000);
    if (claims.iss !== `https://${cfg.team}.cloudflareaccess.com`) throw new AccessError(401, "bad issuer");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!cfg.aud || !aud.includes(cfg.aud)) throw new AccessError(401, "bad audience");
    if (typeof claims.exp !== "number" || claims.exp + skew < nowSec) throw new AccessError(401, "token expired");
    if (typeof claims.nbf === "number" && claims.nbf - skew > nowSec) throw new AccessError(401, "token not yet valid");

    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    const domain = email.includes("@") ? email.slice(email.lastIndexOf("@") + 1) : "";
    if (!domain || !cfg.allowedEmailDomains.includes(domain)) throw new AccessError(403, "email domain not allowed");
    return { email };
  }

  return { verify };
}

export type Verifier = ReturnType<typeof createVerifier>;

/** Token from the Access header, falling back to the CF_Authorization cookie. */
export function extractToken(req: Request): string | null {
  const h = req.headers.get("cf-access-jwt-assertion");
  if (h) return h;
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === "CF_Authorization") return part.slice(i + 1).trim() || null;
  }
  return null;
}

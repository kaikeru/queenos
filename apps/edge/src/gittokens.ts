/** QueenOS git tokens: generation, hashing and Authorization parsing. Web Crypto only; never log tokens. */

export const TOKEN_PREFIX = "qgt_";
export const DEFAULT_TTL_DAYS = 30;
export type GitScope = "read" | "push";
export const ALL_SCOPES: GitScope[] = ["read", "push"];

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** `qgt_<32 random bytes, base32>`. */
export function generateToken(): string {
  return TOKEN_PREFIX + base32(crypto.getRandomValues(new Uint8Array(32)));
}

export function newTokenId(): string {
  return base32(crypto.getRandomValues(new Uint8Array(10)));
}

/** SHA-256 hex. Tokens carry 256 bits of entropy, so a bare hash with an indexed lookup is sufficient. */
export async function hashToken(token: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  let s = "";
  for (const b of d) s += b.toString(16).padStart(2, "0");
  return s;
}

/** The credential from `Authorization`: a Basic password (any username) or a Bearer token. */
export function extractGitCredential(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const sp = h.indexOf(" ");
  if (sp < 0) return null;
  const scheme = h.slice(0, sp).toLowerCase();
  const rest = h.slice(sp + 1).trim();
  if (scheme === "bearer") return rest || null;
  if (scheme === "basic") {
    let decoded: string;
    try {
      decoded = new TextDecoder().decode(Uint8Array.from(atob(rest), (c) => c.charCodeAt(0)));
    } catch {
      return null;
    }
    const i = decoded.indexOf(":");
    const pw = i < 0 ? decoded : decoded.slice(i + 1);
    return pw || null;
  }
  return null;
}

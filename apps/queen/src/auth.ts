/**
 * Shared-secret auth for machine-only HTTP routes (`/internal/*`, `/audit`,
 * `/scribe`, `/trains/:id/result`). Drones and gatekeepers normally reach the
 * Queen over DO RPC, which is not exposed to the internet and needs no token;
 * this guards the HTTP fallbacks.
 *
 * - `Authorization: Bearer <QUEEN_INTERNAL_TOKEN>` (a wrangler secret).
 * - Secret unset and `QUEEN_INTERNAL_AUTH !== "disabled"` -> 503 (fail closed).
 * - `QUEEN_INTERNAL_AUTH="disabled"` is only set in the `sim` env (local demo).
 * - Comparison is constant-time: both sides are hashed with SHA-256 (so lengths
 *   are equal and nothing about the secret's length leaks), then XOR-compared.
 */
import type { MiddlewareHandler } from "hono";

export interface AuthBindings {
  QUEEN_INTERNAL_TOKEN?: string;
  QUEEN_INTERNAL_AUTH?: string;
}

const encoder = new TextEncoder();

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s)));
}

/** Constant-time string equality over SHA-256 digests. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  let diff = da.length ^ db.length;
  for (let i = 0; i < da.length; i++) diff |= da[i]! ^ (db[i] ?? 0);
  return diff === 0;
}

export const requireInternalAuth: MiddlewareHandler<{ Bindings: AuthBindings }> = async (c, next) => {
  if (c.env.QUEEN_INTERNAL_AUTH === "disabled") return next();
  const secret = c.env.QUEEN_INTERNAL_TOKEN;
  if (!secret) {
    return c.json({ error: { code: "UNAVAILABLE", message: "internal auth is not configured (QUEEN_INTERNAL_TOKEN)" } }, 503);
  }
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  // Always run the comparison, even with no/garbled header, to keep timing uniform.
  const ok = await safeEqual(match?.[1]?.trim() ?? "", secret);
  if (!match || !ok) {
    return c.json({ error: { code: "UNAUTHORIZED", message: "missing or invalid bearer token" } }, 401, {
      "www-authenticate": 'Bearer realm="queen-internal"',
    });
  }
  return next();
};

export const SIM_USER = "sim@localhost";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Identity for user routes (tap to ship). Production: only the edge's verified
 * `x-queen-user` counts. Sim only (`QUEEN_INTERNAL_AUTH="disabled"`, set solely in
 * wrangler env.sim, AND a localhost request), a missing header defaults to
 * `sim@localhost` so the dashboard works against a queen-only `dev:sim`.
 */
export function resolveUser(env: object, requestUrl: string, header: string | undefined): string | undefined {
  const given = header?.trim();
  if (given) return given;
  // An explicitly sent blank header is still a missing identity, but only the sim may default it.
  const sim = (env as AuthBindings).QUEEN_INTERNAL_AUTH === "disabled" && LOCAL_HOSTS.has(new URL(requestUrl).hostname);
  return sim ? SIM_USER : undefined;
}

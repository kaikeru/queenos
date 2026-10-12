import { Hono } from "hono";
import type { Context } from "hono";
import {
  ConnectCloudflareSchema,
  GitTokenMintRequestSchema,
  type GitTokenAgent,
  HiveSlugSchema,
  type Project,
  type VaultStatus,
} from "@queenos/queen-types";
import { AccessError, createVerifier, extractToken, type Verifier } from "./access";
import {
  DEFAULT_WINDOW,
  METRIC_TEMPLATE_NAMES,
  METRIC_WINDOWS,
  buildQuery,
  isTemplate,
  isWindow,
  runQuery,
  type Fetcher,
} from "./metrics";
import type { HiveRegistry } from "./registry";
import {
  ALL_SCOPES,
  DEFAULT_TTL_DAYS,
  TOKEN_PREFIX,
  extractGitCredential,
  generateToken,
  hashToken,
  newTokenId,
} from "./gittokens";

/** Vault RPC surface (apps/vault WorkerEntrypoint VaultWriter). */
export interface VaultPort {
  connectCloudflare(
    hive: string,
    creds: { accountId: string; apiToken: string },
    userEmail: string,
  ): Promise<VaultStatus>;
  status(hive: string): Promise<VaultStatus>;
  tokenTemplateUrl(): Promise<{ url: string }>;
}

/** Registry RPC surface, as seen through the DO stub. */
export type RegistryPort = Pick<HiveRegistry, 
  | "list"
  | "get"
  | "register"
  | "update"
  | "mintGitToken"
  | "listGitTokens"
  | "revokeGitToken"
  | "authGitToken"
  | "gitAuthBlocked"
  | "gitAuthFailed"
>;

export interface Bindings {
  ACCESS_TEAM: string;
  ALLOWED_EMAIL_DOMAINS: string;
  ACCESS_AUD: string;
  ACCESS_MODE?: string;
  DEV_USER_EMAIL?: string;
  REGISTRY: DurableObjectNamespace<HiveRegistry>;
  VAULT: VaultPort;
  GENESIS: { fetch(req: Request): Promise<Response> };
  QUEEN: { fetch(req: Request): Promise<Response> };
  /** The git proxy Worker (queenos-git): the only thing /git/* is forwarded to. */
  GIT: { fetch(req: Request): Promise<Response> };
  /** The MCP server Worker (queenos-mcp): the only thing /mcp is forwarded to. */
  MCP: { fetch(req: Request): Promise<Response> };
  /** Cloudflare account id (a var) and the Account Analytics Read token (a secret) for the AE SQL API. */
  ACCOUNT_ID?: string;
  ANALYTICS_API_TOKEN?: string;
  ASSETS?: { fetch(req: Request): Promise<Response> };
}

type AppEnv = { Bindings: Bindings; Variables: { email: string } };
type Ctx = Context<AppEnv>;

const defaultVerifier = createVerifier();

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Client copies of the identity headers the edge sets, plus credentials: removed on every forwarded path. */
const IDENTITY_HEADERS = ["x-queen-user", "x-queen-token-id", "x-queen-scopes", "x-queen-agent", "x-queen-agent-model", "authorization", "cookie", "cf-access-token", "cf-access-jwt-assertion"];

export function createApp(verifier: Verifier = defaultVerifier, fetcher: Fetcher = (url, init) => fetch(url, init)) {
  const app = new Hono<AppEnv>();

  const registry = (c: Ctx) => c.env.REGISTRY.get(c.env.REGISTRY.idFromName("registry"));

  app.get("/health", (c) => c.json({ ok: true, service: "edge" }));

  // ---- Git front door: BEFORE the Access middleware (stock git cannot pass Access). ----
  // Authenticated by a QueenOS git token (Basic password or Bearer) or a cf-access-token Access JWT.
  app.all("/git/*", async (c) => {
    const env = c.env;
    const challenge = () =>
      new Response("QueenOS: authentication required (use a git token from the dashboard as the password)\n", {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="QueenOS"', "content-type": "text/plain" },
      });

    let identity: { email: string; scopes: string[]; agent?: GitTokenAgent | null } | null = null;
    if (env.ACCESS_MODE === "dev") {
      // Same localhost-only bypass as the Access middleware below; never reachable on a real host.
      if (!LOCAL_HOSTS.has(new URL(c.req.url).hostname)) return c.json({ error: "dev mode is localhost-only" }, 403);
      if (!env.DEV_USER_EMAIL) return c.json({ error: "dev mode misconfigured" }, 503);
      identity = { email: env.DEV_USER_EMAIL.toLowerCase(), scopes: [...ALL_SCOPES] };
    } else {
      const reg = registry(c);
      const credential = extractGitCredential(c.req.raw);
      const accessJwt = c.req.header("cf-access-token") ?? null;
      if (!credential && !accessJwt) return challenge(); // git's unauthenticated first probe: not a failure

      const ip = c.req.header("cf-connecting-ip") ?? "unknown";
      // Only a short prefix of the presented credential is used as a key, never the whole thing.
      const keys = [`ip:${ip}`];
      if (credential) keys.push(`tok:${credential.slice(0, TOKEN_PREFIX.length + 6)}`);
      const wait = await reg.gitAuthBlocked(keys);
      if (wait > 0) {
        return new Response("QueenOS: too many failed authentication attempts\n", {
          status: 429,
          headers: { "retry-after": String(wait), "content-type": "text/plain" },
        });
      }

      if (credential?.startsWith(TOKEN_PREFIX)) {
        identity = await reg.authGitToken(await hashToken(credential));
      } else if (accessJwt) {
        if (!env.ACCESS_AUD) return c.json({ error: "access not configured" }, 503);
        try {
          const { email } = await verifier.verify(accessJwt, {
            team: env.ACCESS_TEAM,
            aud: env.ACCESS_AUD,
            allowedEmailDomains: env.ALLOWED_EMAIL_DOMAINS.split(",")
              .map((d) => d.trim().toLowerCase())
              .filter(Boolean),
          });
          identity = { email, scopes: [...ALL_SCOPES] };
        } catch (e) {
          if (e instanceof AccessError && e.status === 503) return c.json({ error: "auth unavailable" }, 503);
        }
      }
      if (!identity) {
        await reg.gitAuthFailed(keys);
        return challenge();
      }
    }

    const headers = new Headers(c.req.raw.headers);
    // Client-supplied identity headers are removed on every path (token, Access JWT, dev mode);
    // only what the edge itself authenticated is set below.
    for (const h of IDENTITY_HEADERS) headers.delete(h);
    headers.set("x-queen-user", identity.email);
    headers.set("x-queen-scopes", identity.scopes.join(","));
    // Only a token bound to an agent carries one; Access JWT and dev identities never do.
    if (identity.agent) {
      headers.set("x-queen-agent", identity.agent.name);
      if (identity.agent.model) headers.set("x-queen-agent-model", identity.agent.model);
    }
    // Method, path, query and the streamed body are forwarded unchanged; the response streams back as-is.
    return env.GIT.fetch(new Request(c.req.raw, { headers }));
  });

  // ---- MCP front door (docs/superpowers/specs/2026-10-12-queenos-mcp-design.md §4.1): BEFORE the Access middleware. ----
  // Credential: `Authorization: Bearer qgt_…` only (agents' MCP configs send a header; no Basic, no Access JWT). Same
  // failure rate limit as /git. The token's agent binding is ignored here: identity comes from init_agent. The token
  // never reaches queenos-mcp.
  const mcp = async (c: Ctx) => {
    const env = c.env;
    const unauthorized = () => c.json({ error: "unauthorized" }, 401, { "www-authenticate": 'Bearer realm="QueenOS"' });
    let identity: { email: string; scopes: string[]; id: string };
    if (env.ACCESS_MODE === "dev") {
      if (!LOCAL_HOSTS.has(new URL(c.req.url).hostname)) return c.json({ error: "dev mode is localhost-only" }, 403);
      if (!env.DEV_USER_EMAIL) return c.json({ error: "dev mode misconfigured" }, 503);
      identity = { email: env.DEV_USER_EMAIL.toLowerCase(), scopes: [...ALL_SCOPES], id: "dev" };
    } else {
      const credential = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? null;
      if (!credential) return unauthorized();
      const reg = registry(c);
      const ip = c.req.header("cf-connecting-ip") ?? "unknown";
      const keys = [`ip:${ip}`, `tok:${credential.slice(0, TOKEN_PREFIX.length + 6)}`];
      const wait = await reg.gitAuthBlocked(keys);
      if (wait > 0) return c.json({ error: "too many failed authentication attempts" }, 429, { "retry-after": String(wait) });
      const found = credential.startsWith(TOKEN_PREFIX) ? await reg.authGitToken(await hashToken(credential)) : null;
      if (!found) {
        await reg.gitAuthFailed(keys);
        return unauthorized();
      }
      identity = { email: found.email, scopes: found.scopes, id: found.id };
    }
    if (!identity.scopes.includes("push")) return c.json({ error: "token lacks push scope" }, 403);
    const headers = new Headers(c.req.raw.headers);
    for (const h of IDENTITY_HEADERS) headers.delete(h);
    headers.set("x-queen-user", identity.email);
    headers.set("x-queen-token-id", identity.id);
    // Method, path, query and the (streamed) body unchanged; the SSE response streams back as-is.
    return env.MCP.fetch(new Request(c.req.raw, { headers }));
  };
  app.all("/mcp", mcp);
  app.all("/mcp/*", mcp);

  // Access JWT verification for everything else.
  app.use("*", async (c, next) => {
    const env = c.env;
    if (env.ACCESS_MODE === "dev") {
      // env.dev shares the production Worker name (for the local dev registry), so an accidental
      // `wrangler deploy --env dev` must not turn into an auth bypass on the real domain.
      if (!LOCAL_HOSTS.has(new URL(c.req.url).hostname)) return c.json({ error: "dev mode is localhost-only" }, 403);
      if (!env.DEV_USER_EMAIL) return c.json({ error: "dev mode misconfigured" }, 503);
      c.set("email", env.DEV_USER_EMAIL.toLowerCase());
      return next();
    }
    if (!env.ACCESS_AUD) return c.json({ error: "access not configured" }, 503);
    const token = extractToken(c.req.raw);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    try {
      const { email } = await verifier.verify(token, {
        team: env.ACCESS_TEAM,
        aud: env.ACCESS_AUD,
        allowedEmailDomains: env.ALLOWED_EMAIL_DOMAINS.split(",")
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean),
      });
      c.set("email", email);
    } catch (e) {
      if (e instanceof AccessError) {
        return c.json({ error: e.status === 503 ? "auth unavailable" : e.status === 403 ? "forbidden" : "unauthorized" }, e.status);
      }
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });

  app.get("/api/me", (c) => c.json({ email: c.get("email") }));

  app.get("/api/projects", async (c) => c.json((await registry(c).list()) satisfies Project[]));

  // ---- Git tokens (behind Access). The secret is returned once, at mint; only its hash is stored. ----
  app.post("/api/git-tokens", async (c) => {
    let body: unknown = {};
    const raw = await c.req.text();
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        return c.json({ error: "invalid json" }, 400);
      }
    }
    const parsed = GitTokenMintRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    const token = generateToken();
    const info = await registry(c).mintGitToken({
      id: newTokenId(),
      hash: await hashToken(token),
      email: c.get("email"),
      scopes: [...new Set(parsed.data.scopes ?? ALL_SCOPES)],
      label: parsed.data.label ?? null,
      ttlMs: (parsed.data.ttlDays ?? DEFAULT_TTL_DAYS) * 86_400_000,
      agent: parsed.data.agent ? { name: parsed.data.agent.name, model: parsed.data.agent.model ?? null } : null,
    });
    return c.json({ ...info, token }, 201);
  });

  app.get("/api/git-tokens", async (c) => c.json(await registry(c).listGitTokens(c.get("email"))));

  app.delete("/api/git-tokens/:id", async (c) => {
    const ok = await registry(c).revokeGitToken(c.req.param("id"), c.get("email"));
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  // ---- Vault (write-only from the browser). Never log request bodies here. ----
  app.get("/api/vault/token-template", async (c) => {
    try {
      return c.json(await c.env.VAULT.tokenTemplateUrl());
    } catch {
      return c.json({ error: "vault unavailable" }, 502);
    }
  });

  app.post("/api/vault/:hive/cloudflare", async (c) => {
    const hive = HiveSlugSchema.safeParse(c.req.param("hive"));
    if (!hive.success) return c.json({ error: "invalid hive" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const parsed = ConnectCloudflareSchema.safeParse(body);
    if (!parsed.success) {
      // Field names and codes only: never echo submitted values.
      return c.json(
        { error: "invalid body", fields: parsed.error.issues.map((i) => ({ path: i.path.join("."), code: i.code })) },
        400,
      );
    }
    try {
      return c.json(await c.env.VAULT.connectCloudflare(hive.data, parsed.data, c.get("email")));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      // Log only the hive and error name, never the message or body.
      console.warn(`vault connect failed hive=${hive.data} err=${e instanceof Error ? e.name : "unknown"}`);
      if (/^(INVALID|BAD_REQUEST)/.test(msg)) return c.json({ error: "vault rejected the credentials" }, 400);
      return c.json({ error: "vault unavailable" }, 502);
    }
  });

  app.get("/api/vault/:hive/status", async (c) => {
    const hive = HiveSlugSchema.safeParse(c.req.param("hive"));
    if (!hive.success) return c.json({ error: "invalid hive" }, 400);
    try {
      return c.json(await c.env.VAULT.status(hive.data));
    } catch {
      return c.json({ error: "vault unavailable" }, 502);
    }
  });

  // ---- Analytics Engine metrics: allowlisted templates only, never client SQL ----
  app.get("/api/metrics/:hive", async (c) => {
    const hive = HiveSlugSchema.safeParse(c.req.param("hive"));
    if (!hive.success) return c.json({ error: "invalid hive" }, 400);
    const params = new URL(c.req.url).searchParams;
    for (const key of params.keys()) {
      if (key !== "q" && key !== "window") return c.json({ error: `unknown parameter "${key}"` }, 400);
    }
    const q = params.get("q") ?? "";
    if (!isTemplate(q)) return c.json({ error: "unknown metric template", templates: METRIC_TEMPLATE_NAMES }, 400);
    const window = params.get("window") ?? DEFAULT_WINDOW;
    if (!isWindow(window)) return c.json({ error: "unknown window", windows: METRIC_WINDOWS }, 400);
    // No secret or account: the dashboard falls back to the Queen's rollups.
    if (!c.env.ANALYTICS_API_TOKEN || !c.env.ACCOUNT_ID) return c.json({ error: "analytics not configured" }, 503);
    try {
      const rows = await runQuery(c.env, buildQuery(q, hive.data, window), fetcher);
      return c.json({ source: "ae", hive: hive.data, template: q, window, rows });
    } catch (e) {
      console.warn(`analytics query failed template=${q} err=${e instanceof Error ? e.name : "unknown"}`);
      return c.json({ error: "analytics unavailable" }, 503);
    }
  });

  // ---- Forwarding to internal Workers over service bindings ----
  const forward = (target: "GENESIS" | "QUEEN") => (c: Ctx) => {
    const headers = new Headers(c.req.raw.headers);
    headers.delete("x-queen-user"); // never trust a client-supplied identity
    headers.delete("x-queen-agent"); // agent identity is only ever set by the /git/* front door
    headers.delete("x-queen-agent-model");
    headers.delete("x-queen-scopes");
    headers.delete("cookie");
    headers.delete("cf-access-jwt-assertion");
    headers.set("x-queen-user", c.get("email"));
    return c.env[target].fetch(new Request(c.req.raw, { headers }));
  };

  app.all("/api/genesis", forward("GENESIS"));
  app.all("/api/genesis/*", forward("GENESIS"));
  // Every Queen route goes through here: the v2 user routes (PATCH settings, escalation resolve,
  // POST items and item actions, tap) and reads (items, events, traces, metrics, queue), and the
  // internal webhooks (build-result, merge-result, ...), which carry their own bearer token.
  app.all("/hives/*", forward("QUEEN"));

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  // Dashboard SPA (normally served by Static Assets before reaching the Worker).
  app.all("*", (c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text("Not found", 404)));

  return app;
}

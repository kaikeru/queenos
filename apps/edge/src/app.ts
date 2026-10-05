import { Hono } from "hono";
import type { Context } from "hono";
import {
  ConnectCloudflareSchema,
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
export type RegistryPort = Pick<HiveRegistry, "list" | "get" | "register" | "update">;

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
  /** Cloudflare account id (a var) and the Account Analytics Read token (a secret) for the AE SQL API. */
  ACCOUNT_ID?: string;
  ANALYTICS_API_TOKEN?: string;
  ASSETS?: { fetch(req: Request): Promise<Response> };
}

type AppEnv = { Bindings: Bindings; Variables: { email: string } };
type Ctx = Context<AppEnv>;

const defaultVerifier = createVerifier();

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function createApp(verifier: Verifier = defaultVerifier, fetcher: Fetcher = (url, init) => fetch(url, init)) {
  const app = new Hono<AppEnv>();

  app.get("/health", (c) => c.json({ ok: true, service: "edge" }));

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

  const registry = (c: Ctx) => c.env.REGISTRY.get(c.env.REGISTRY.idFromName("registry"));

  app.get("/api/me", (c) => c.json({ email: c.get("email") }));

  app.get("/api/projects", async (c) => c.json((await registry(c).list()) satisfies Project[]));

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

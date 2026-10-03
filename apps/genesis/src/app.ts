/**
 * The HTTP surface the edge forwards to (this Worker is not publicly routable:
 * workers_dev false, no routes). The edge verifies the Access JWT and sets
 * `x-queen-user`; requests without it are rejected.
 */
import { Hono } from "hono";
import { ConfirmCharterSchema, GenesisMessageSchema, HiveSlugSchema, StartGenesisSchema } from "@queenos/queen-types";
import type { GenesisNode } from "./node";

type Stub = DurableObjectStub<GenesisNode>;
type Vars = { Variables: { user: string } };

const STATUS: Record<string, 400 | 404 | 409 | 502> = { INVALID_INPUT: 400, NOT_FOUND: 404, CONFLICT: 409, UNAVAILABLE: 502 };

/** Map "CODE: message" errors (they survive DO RPC as message text) to a JSON response. */
export function errorResponse(e: unknown): Response {
  const m = String((e as Error)?.message ?? e);
  const code = /^([A-Z_]+): /.exec(m)?.[1];
  const status = code ? STATUS[code] : undefined;
  if (!status) return Response.json({ error: "INTERNAL", message: "internal error" }, { status: 500 });
  return Response.json({ error: code, message: m.slice(code!.length + 2) }, { status });
}

export function createApp(env: () => Env) {
  const app = new Hono<Vars>();
  const stub = (hive: string): Stub => {
    const ns = env().GENESIS;
    return ns.get(ns.idFromName(hive)) as unknown as Stub;
  };

  app.get("/health", (c) => c.json({ ok: true, service: "genesis" }));

  app.use("/api/*", async (c, next) => {
    const user = c.req.header("x-queen-user")?.trim();
    if (!user) return c.json({ error: "UNAUTHORIZED", message: "missing x-queen-user" }, 401);
    c.set("user", user);
    await next();
  });

  app.onError((e) => errorResponse(e));

  const body = async (c: { req: { json(): Promise<unknown> } }) => {
    try {
      return await c.req.json();
    } catch {
      throw new Error("INVALID_INPUT: body must be JSON");
    }
  };
  const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }) =>
    `INVALID_INPUT: ${e.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
  const hiveParam = (raw: string) => {
    const p = HiveSlugSchema.safeParse(raw);
    if (!p.success) throw new Error("INVALID_INPUT: bad hive slug");
    return p.data;
  };

  app.post("/api/genesis", async (c) => {
    const p = StartGenesisSchema.safeParse(await body(c));
    if (!p.success) throw new Error(issues(p.error));
    return c.json(await stub(p.data.hive).start({ ...p.data, createdBy: c.get("user") }));
  });
  app.get("/api/genesis/:hive", async (c) => c.json(await stub(hiveParam(c.req.param("hive"))).getState()));
  app.post("/api/genesis/:hive/messages", async (c) => {
    const p = GenesisMessageSchema.safeParse(await body(c));
    if (!p.success) throw new Error(issues(p.error));
    return c.json(await stub(hiveParam(c.req.param("hive"))).postMessage(p.data));
  });
  app.put("/api/genesis/:hive/charter", async (c) => {
    const p = ConfirmCharterSchema.safeParse(await body(c));
    if (!p.success) throw new Error(issues(p.error));
    return c.json(await stub(hiveParam(c.req.param("hive"))).putCharter(p.data));
  });
  app.post("/api/genesis/:hive/launch", async (c) => c.json(await stub(hiveParam(c.req.param("hive"))).launch()));

  return app;
}

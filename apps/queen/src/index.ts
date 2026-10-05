import { Hono, type Context } from "hono";
import {
  AppendAuditSchema,
  BuildResultSchema,
  DeployResultSchema,
  LandResultSchema,
  ProvisionResultSchema,
  ScribeSummarySchema,
  SentinelVerdictSchema,
  SubmitPromptSchema,
  TapToShipSchema,
  TrainResultSchema,
} from "@queenos/queen-types";
import { requireInternalAuth, resolveUser } from "./auth";
import { QueenError, asQueenError, parseOrThrow } from "./errors";
import { DEFAULT_HIVE, HIVE_HEADER, USER_HEADER, assertNamespace } from "./queen-node";

export { QueenNode } from "./queen-node";

/**
 * Routing: one QueenNode per hive, `idFromName(namespace)`.
 * - `/hives/:namespace/...` names the hive in the path (canonical).
 * - The same routes at the root resolve the hive from the `x-queen-hive`
 *   header or `?namespace=`; `POST /prompts` falls back to the body's
 *   namespace; everything else falls back to the "queen" hive.
 */
type HiveEnv = { Bindings: Env; Variables: { hive: string | null } };
type HiveContext = Context<HiveEnv>;

const app = new Hono<HiveEnv>();

app.onError((err, c) => {
  const q = asQueenError(err);
  if (q) return c.json({ error: { code: q.code, message: q.detail } }, q.status);
  console.error("queen: unhandled error", err);
  return c.json({ error: { code: "INTERNAL", message: "internal error" } }, 500);
});

app.get("/health", (c) => c.json({ ok: true, service: "queen" }));

const hive = new Hono<HiveEnv>();

hive.use("*", async (c, next) => {
  const explicit = c.req.param("namespace") ?? c.req.header(HIVE_HEADER) ?? c.req.query("namespace") ?? null;
  if (explicit !== null) assertNamespace(explicit);
  c.set("hive", explicit);
  await next();
});

function stub(c: HiveContext, namespace: string) {
  return c.env.QUEEN_NODE.get(c.env.QUEEN_NODE.idFromName(namespace));
}

function hiveOf(c: HiveContext): string {
  return c.get("hive") ?? DEFAULT_HIVE;
}

async function body(c: HiveContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new QueenError("INVALID_INPUT", "body must be JSON");
  }
}

function upgrade(c: HiveContext): Promise<Response> | Response {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }
  const namespace = hiveOf(c);
  const req = new Request(c.req.raw);
  req.headers.set(HIVE_HEADER, namespace);
  return stub(c, namespace).fetch(req);
}

// War Room WebSocket. `/ws` is kept as an alias of `/room`.
hive.get("/room", upgrade);
hive.get("/ws", upgrade);

hive.post("/prompts", async (c) => {
  const prompt = parseOrThrow(SubmitPromptSchema, await body(c), "prompt");
  const namespace = c.get("hive") ?? prompt.namespace;
  if (prompt.namespace !== namespace) {
    throw new QueenError("INVALID_INPUT", `prompt namespace "${prompt.namespace}" does not match hive "${namespace}"`);
  }
  assertNamespace(namespace);
  const promptRun = await stub(c, namespace).submitPrompt(prompt);
  return c.json({ promptRun }, 201);
});

// Tap to ship: a USER route. The edge verifies Cloudflare Access and sets
// x-queen-user (stripping any client-supplied value); it is not behind the
// internal bearer token. 401 without a user, 409 outside AWAITING_TAP. Only the
// localhost sim env defaults a missing user (resolveUser).
hive.post("/releases/:releaseId/tap", async (c) => {
  const user = resolveUser(c.env, c.req.url, c.req.header(USER_HEADER));
  if (!user) {
    return c.json({ error: { code: "UNAUTHORIZED", message: `missing ${USER_HEADER} (sign in through Cloudflare Access)` } }, 401);
  }
  const releaseId = c.req.param("releaseId");
  // The dashboard sends `{releaseId}`; the body is optional, but must agree with the path.
  const raw = await c.req.text();
  if (raw.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new QueenError("INVALID_INPUT", "body must be JSON");
    }
    const tap = TapToShipSchema.partial().safeParse(parsed);
    if (!tap.success) throw QueenError.invalid("tap", tap.error.issues);
    if (tap.data.releaseId !== undefined && tap.data.releaseId !== releaseId) {
      throw new QueenError("INVALID_INPUT", "releaseId in body does not match the path");
    }
  }
  return c.json(await stub(c, hiveOf(c)).tapRelease({ releaseId, user }));
});

// Machine-only routes: shared bearer secret (src/auth.ts). POST /prompts and the
// WebSocket room stay open for the dashboard (see README: needs auth post-hackathon).
for (const path of ["/internal/*", "/trains/*", "/audit", "/scribe"]) hive.use(path, requireInternalAuth);

// Gatekeeper verdict (pass/fail + Scribe summary <= 500 chars).
hive.post("/internal/webhook/train-result", async (c) => {
  const result = parseOrThrow(TrainResultSchema, await body(c), "train result");
  return c.json(await stub(c, hiveOf(c)).reportTrainResult(result));
});

// Alias: the train id comes from the path.
hive.post("/trains/:id/result", async (c) => {
  const raw = await body(c);
  const id = c.req.param("id");
  const withId = typeof raw === "object" && raw !== null ? { trainId: id, ...raw } : raw;
  const result = parseOrThrow(TrainResultSchema, withId, "train result");
  if (result.trainId !== id) throw new QueenError("INVALID_INPUT", "trainId in body does not match the path");
  return c.json(await stub(c, hiveOf(c)).reportTrainResult(result));
});

// Builder pushed the train head to its fork; successors can fork from it.
hive.post("/internal/webhook/build-result", async (c) => {
  const result = parseOrThrow(BuildResultSchema, await body(c), "build result");
  return c.json(await stub(c, hiveOf(c)).reportBuildResult(result));
});

// Lander pushed the train head to hive main (or failed to).
hive.post("/internal/webhook/land-result", async (c) => {
  const result = parseOrThrow(LandResultSchema, await body(c), "land result");
  return c.json(await stub(c, hiveOf(c)).reportLandResult(result));
});

// Provisioner reports a FORK / DELETE outcome (idempotent by commandId).
hive.post("/internal/webhook/provision-result", async (c) => {
  const result = parseOrThrow(ProvisionResultSchema, await body(c), "provision result");
  return c.json(await stub(c, hiveOf(c)).reportProvisionResult(result));
});

// Herald reports a DEPLOY / TEARDOWN / ROLLBACK outcome (preview -> trains,
// staging / canary -> releases; idempotent by commandId).
hive.post("/internal/webhook/deploy-result", async (c) => {
  const result = parseOrThrow(DeployResultSchema, await body(c), "deploy result");
  return c.json(await stub(c, hiveOf(c)).reportDeployResult(result));
});

// Sentinel reports a staging / canary health verdict (idempotent by commandId).
hive.post("/internal/webhook/sentinel-verdict", async (c) => {
  const verdict = parseOrThrow(SentinelVerdictSchema, await body(c), "sentinel verdict");
  return c.json(await stub(c, hiveOf(c)).reportSentinelVerdict(verdict));
});

hive.post("/audit", async (c) => {
  const audit = parseOrThrow(AppendAuditSchema, await body(c), "audit event");
  return c.json({ event: await stub(c, hiveOf(c)).appendAudit(audit) }, 201);
});

hive.post("/scribe", async (c) => {
  const summary = parseOrThrow(ScribeSummarySchema, await body(c), "scribe summary");
  return c.json(await stub(c, hiveOf(c)).recordScribeSummary(summary));
});

hive.get("/snapshot", async (c) => c.json(await stub(c, hiveOf(c)).getSnapshot()));

app.route("/hives/:namespace", hive);
app.route("/", hive);

export default app;

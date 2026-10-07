import { Hono, type Context } from "hono";
import {
  AppendAuditSchema,
  AppendAuditsSchema,
  BuildResultSchema,
  DeployResultSchema,
  EventQuerySchema,
  GitAbortedSchema,
  GitPushIntentSchema,
  GitPushedSchema,
  LandResultSchema,
  NotesRefSchema,
  MergeResultSchema,
  OracleResultSchema,
  ProvisionResultSchema,
  ScribeSummarySchema,
  SentinelVerdictSchema,
  SubmitPromptSchema,
  TapToShipSchema,
  TrainResultSchema,
  type EventQueryInput,
  type FileWorkItemInput,
  type UpdateHiveSettings,
  type WorkAction,
} from "@queenos/queen-types";
import { requireInternalAuth, resolveUser } from "./auth";
import { QueenError, asQueenError, parseOrThrow } from "./errors";
import { DEFAULT_HIVE, HIVE_HEADER, USER_HEADER, assertNamespace } from "./queen-node";

export { QueenNode } from "./queen-node";
export { SwarmGovernor } from "./scale/governor";

/**
 * Routing: one QueenNode per hive, `idFromName(namespace)`.
 * - `/hives/:namespace/...` names the hive in the path (canonical).
 * - The same routes at the root resolve the hive from the `x-queen-hive`
 *   header or `?namespace=`; `POST /prompts` falls back to the body's
 *   namespace; everything else falls back to the "queen" hive.
 *
 * Route classes (v2 design §3.6):
 * - open: `POST /prompts`, the WebSocket room and every GET (the edge's Access
 *   check covers them in production);
 * - user (`x-queen-user`, set by the edge after Access): tap, items, item
 *   actions, settings, escalation resolve;
 * - internal (bearer token): `/internal/*`, `/trains/*`, `/audit`, `/scribe`.
 *
 * The git proxy (apps/git) calls `gitIntent` / `gitPushed` / `gitAborted` / `notesFor` over DO RPC; the
 * `/internal/git/*` routes are the same calls over HTTP (curl, debugging).
 */
type HiveEnv = { Bindings: Env; Variables: { hive: string | null } };
type HiveContext = Context<HiveEnv>;

/** A user route without an Access-verified user (401). */
class UnauthorizedError extends Error {}

const app = new Hono<HiveEnv>();

app.onError((err, c) => {
  if (err instanceof UnauthorizedError) {
    return c.json({ error: { code: "UNAUTHORIZED", message: `missing ${USER_HEADER} (sign in through Cloudflare Access)` } }, 401);
  }
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

/** The Access-verified user of a user route, or a 401 (only the localhost sim defaults one). */
function userOf(c: HiveContext): string {
  const user = resolveUser(c.env, c.req.url, c.req.header(USER_HEADER));
  if (!user) throw new UnauthorizedError();
  return user;
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

// Open (as in v1): returns {item, promptRun}; promptRun is synthesized from the item, so v1 clients still work.
hive.post("/prompts", async (c) => {
  const prompt = parseOrThrow(SubmitPromptSchema, await body(c), "prompt");
  const namespace = c.get("hive") ?? prompt.namespace;
  if (prompt.namespace !== namespace) {
    throw new QueenError("INVALID_INPUT", `prompt namespace "${prompt.namespace}" does not match hive "${namespace}"`);
  }
  assertNamespace(namespace);
  const user = c.req.header(USER_HEADER)?.trim();
  const res = await stub(c, namespace).submitWork({ ...prompt, ...(user ? { user } : {}) });
  return c.json(res, 201);
});

// Tap to ship: a USER route. The edge verifies Cloudflare Access and sets
// x-queen-user (stripping any client-supplied value); it is not behind the
// internal bearer token. 401 without a user, 409 outside AWAITING_TAP. Only the
// localhost sim env defaults a missing user (resolveUser).
hive.post("/releases/:releaseId/tap", async (c) => {
  const user = userOf(c);
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

// ── v2 user routes (x-queen-user) ───────────────────────────────────────

hive.post("/items", async (c) => {
  const user = userOf(c);
  const item = (await body(c)) as FileWorkItemInput;
  return c.json(await stub(c, hiveOf(c)).fileWorkItem({ hive: hiveOf(c), user, item }), 201);
});

hive.post("/items/:id/actions", async (c) => {
  const user = userOf(c);
  const action = (await body(c)) as WorkAction;
  return c.json(await stub(c, hiveOf(c)).workAction({ hive: hiveOf(c), itemId: c.req.param("id"), user, action }));
});

hive.patch("/settings", async (c) => {
  const user = userOf(c);
  const patch = (await body(c)) as UpdateHiveSettings;
  return c.json(await stub(c, hiveOf(c)).updateSettings({ hive: hiveOf(c), user, patch }));
});

hive.post("/escalations/:id/resolve", async (c) => {
  const user = userOf(c);
  const action = await body(c);
  return c.json(await stub(c, hiveOf(c)).resolveEscalation({ hive: hiveOf(c), escalationId: c.req.param("id"), user, action }));
});

// ── v2 open reads ───────────────────────────────────────────────────────

hive.get("/items/:id", async (c) => c.json(await stub(c, hiveOf(c)).getItemDetail(c.req.param("id"))));

hive.get("/events", async (c) => {
  const q = c.req.query();
  const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));
  const query: EventQueryInput = {
    ...(q.trace ? { traceId: q.trace } : {}),
    ...(q.item ? { itemId: q.item } : {}),
    ...(q.release ? { releaseId: q.release } : {}),
    ...(q.type ? { typePrefix: q.type } : {}),
    ...(num(q.before) !== undefined ? { before: num(q.before) } : {}),
    ...(num(q.limit) !== undefined ? { limit: num(q.limit) } : {}),
  };
  const parsed = parseOrThrow(EventQuerySchema, query, "event query");
  return c.json({ events: await stub(c, hiveOf(c)).queryEvents(parsed) });
});

hive.get("/traces/:traceId", async (c) => c.json(await stub(c, hiveOf(c)).getTrace(c.req.param("traceId"))));

hive.get("/metrics", async (c) => {
  const w = c.req.query("window") ?? "24h";
  if (w !== "24h" && w !== "7d") throw new QueenError("INVALID_INPUT", "window must be 24h or 7d");
  return c.json(await stub(c, hiveOf(c)).getMetrics(w));
});

hive.get("/queue", async (c) => c.json(await stub(c, hiveOf(c)).getQueue()));

hive.get("/snapshot", async (c) => c.json(await stub(c, hiveOf(c)).getSnapshot()));

// ── internal (bearer) ───────────────────────────────────────────────────

// Machine-only routes: shared bearer secret (src/auth.ts).
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

// Builder pushed the train head to its fork.
hive.post("/internal/webhook/build-result", async (c) => {
  const result = parseOrThrow(BuildResultSchema, await body(c), "build result");
  return c.json(await stub(c, hiveOf(c)).reportBuildResult(result));
});

// The MERGE drone's report for a merge-queue car.
hive.post("/internal/webhook/merge-result", async (c) => {
  const result = parseOrThrow(MergeResultSchema, await body(c), "merge result");
  return c.json(await stub(c, hiveOf(c)).reportMergeResult(result));
});

// The Oracle's DECOMPOSE / TRIAGE answer (idempotent by commandId).
hive.post("/internal/webhook/oracle-result", async (c) => {
  const result = parseOrThrow(OracleResultSchema, await body(c), "oracle result");
  return c.json(await stub(c, hiveOf(c)).reportOracleResult(result));
});

// Lander pushed the head to hive main (or failed to).
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

// Git intake (human-push design rev 2): the proxy's pre-receive decision, the landed push, an aborted push.
// The hive must match the path / header hive.
function sameHive(c: HiveContext, named: string): string {
  const h = c.get("hive");
  if (h !== null && h !== named) throw new QueenError("INVALID_INPUT", `hive "${named}" in body does not match "${h}"`);
  assertNamespace(named);
  return named;
}

hive.post("/internal/git/intent", async (c) => {
  const intent = parseOrThrow(GitPushIntentSchema, await body(c), "push intent");
  return c.json(await stub(c, sameHive(c, intent.hive)).gitIntent(intent));
});

hive.post("/internal/git/pushed", async (c) => {
  const pushed = parseOrThrow(GitPushedSchema, await body(c), "push");
  return c.json(await stub(c, sameHive(c, pushed.hive)).gitPushed(pushed));
});

hive.post("/internal/git/aborted", async (c) => {
  const aborted = parseOrThrow(GitAbortedSchema, await body(c), "push abort");
  return c.json(await stub(c, sameHive(c, aborted.hive)).gitAborted(aborted));
});

// The v1 notes projection of one ref (refs/notes/verdict | review | provenance).
hive.get("/internal/git/notes", async (c) => {
  const ref = parseOrThrow(NotesRefSchema, c.req.query("ref") ?? "refs/notes/verdict", "notes ref");
  return c.json(await stub(c, hiveOf(c)).notesFor(hiveOf(c), ref));
});

hive.post("/audit", async (c) => {
  const audit = parseOrThrow(AppendAuditSchema, await body(c), "audit event");
  return c.json({ event: await stub(c, hiveOf(c)).appendAudit(audit) }, 201);
});

hive.post("/audits", async (c) => {
  const audits = parseOrThrow(AppendAuditsSchema, await body(c), "audit events");
  return c.json({ events: await stub(c, hiveOf(c)).appendAudits(audits) }, 201);
});

hive.post("/scribe", async (c) => {
  const summary = parseOrThrow(ScribeSummarySchema, await body(c), "scribe summary");
  return c.json(await stub(c, hiveOf(c)).recordScribeSummary(summary));
});

app.route("/hives/:namespace", hive);
app.route("/", hive);

export default app;

import {
  EscalationSchema,
  HiveStatusSchema,
  HourlyMetricSchema,
  MergeTrainSchema,
  ProjectSchema,
  QueenEventSchema,
  RaceSchema,
  ReleaseSchema,
  TraceViewSchema,
  VaultStatusSchema,
  WizardStateSchema,
  WorkItemSchema,
  type Charter,
  type Escalation,
  type EventQueryInput,
  type FileWorkItemInput,
  type HiveStatus,
  type HourlyMetric,
  type MergeTrain,
  type Project,
  type QueenEvent,
  type Race,
  type Release,
  type ResolveEscalation,
  type TraceView,
  type UpdateHiveSettings,
  type VaultStatus,
  type WizardState,
  type WorkAction,
  type WorkItem,
} from "@queenos/queen-types";

export const AUTH_MESSAGE = "Not signed in: reload to sign in with Cloudflare Access";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export const isAuthError = (e: unknown): boolean => e instanceof ApiError && e.isAuth;

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError && e.isAuth) return AUTH_MESSAGE;
  return e instanceof Error ? e.message : String(e);
}

interface Parser<T> {
  parse(v: unknown): T;
}

async function request<T>(method: string, path: string, parser: Parser<T>, body?: unknown, credentials: RequestCredentials = "same-origin"): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials,
      headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError("Could not reach the server. Check your connection and retry.", 0);
  }
  if (res.status === 401 || res.status === 403) throw new ApiError(AUTH_MESSAGE, res.status);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body (e.g. an Access login page)
    if (res.ok) throw new ApiError("Unexpected response from the server. Reload to sign in again.", res.status);
  }
  if (!res.ok) {
    const o = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
    const msg = typeof o.error === "string" ? o.error : typeof o.message === "string" ? o.message : `Request failed (${res.status})`;
    throw new ApiError(msg, res.status, json);
  }
  try {
    return parser.parse(json);
  } catch {
    throw new ApiError("The server returned an unexpected response.", res.status, json);
  }
}

const enc = encodeURIComponent;
const MeParser: Parser<{ email: string }> = {
  parse(v) {
    const e = (v as { email?: unknown } | null)?.email;
    if (typeof e !== "string") throw new Error("bad me");
    return { email: e };
  },
};
const UrlParser: Parser<{ url: string }> = {
  parse(v) {
    const u = (v as { url?: unknown } | null)?.url;
    if (typeof u !== "string") throw new Error("bad url");
    return { url: u };
  },
};
const ProjectsParser: Parser<Project[]> = { parse: (v) => ProjectSchema.array().parse(v) };

const AnyParser: Parser<unknown> = { parse: (v) => v };

// ── v2 REST: items, events, traces, metrics, queue (design §3.6) ──────────

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const arr = <T>(schema: { parse(v: unknown): T }, v: unknown): T[] => (v === undefined || v === null ? [] : parseArray(schema, v));
function parseArray<T>(schema: { parse(v: unknown): T }, v: unknown): T[] {
  if (!Array.isArray(v)) throw new Error("expected an array");
  return v.map((x) => schema.parse(x));
}

/** GET /hives/:hive/items/:id */
export interface ItemDetail {
  item: WorkItem;
  children: WorkItem[];
  trains: MergeTrain[];
  races: Race[];
  release: Release | null;
  escalations: Escalation[];
}
const ItemDetailParser: Parser<ItemDetail> = {
  parse(v) {
    const o = obj(v);
    return {
      item: WorkItemSchema.parse(o.item),
      children: arr(WorkItemSchema, o.children),
      trains: arr(MergeTrainSchema, o.trains),
      races: arr(RaceSchema, o.races),
      release: o.release ? ReleaseSchema.parse(o.release) : null,
      escalations: arr(EscalationSchema, o.escalations),
    };
  },
};
const WorkItemParser: Parser<WorkItem> = { parse: (v) => WorkItemSchema.parse("item" in obj(v) ? obj(v).item : v) };

/** GET /hives/:hive/events: a bare array or `{events}`. */
const EventsParser: Parser<QueenEvent[]> = { parse: (v) => arr(QueenEventSchema, Array.isArray(v) ? v : obj(v).events) };

/** GET /hives/:hive/metrics?window=24h|7d: hourly rollups plus the current HiveStatus. */
export interface MetricsView {
  rollups: HourlyMetric[];
  hive: HiveStatus | null;
  /** Where the numbers came from (the edge labels AE vs the Queen's rollups). */
  source: string;
}
export type MetricsWindow = "24h" | "7d";
const MetricsParser: Parser<MetricsView> = {
  parse(v) {
    const o = obj(v);
    const hive = o.hive ?? o.status;
    return {
      rollups: arr(HourlyMetricSchema, o.rollups),
      hive: hive ? HiveStatusSchema.parse(hive) : null,
      source: typeof o.source === "string" ? o.source : "rollups",
    };
  },
};

/** GET /hives/:hive/queue: active cars, passed builds waiting to board, the last 20 conflicts and bisects. */
export interface QueueView {
  cars: MergeTrain[];
  waiting: MergeTrain[];
  conflicts: QueenEvent[];
  bisects: QueenEvent[];
}
const QueueParser: Parser<QueueView> = {
  parse(v) {
    const o = obj(v);
    return {
      cars: arr(MergeTrainSchema, o.cars),
      waiting: arr(MergeTrainSchema, o.waiting),
      conflicts: arr(QueenEventSchema, o.conflicts),
      bisects: arr(QueenEventSchema, o.bisects),
    };
  },
};

/** Query string for GET /hives/:hive/events (the Queen's `?trace=&item=&release=&type=&before=&limit=`). */
export function eventsQuery(q: EventQueryInput = {}): string {
  const p = new URLSearchParams();
  if (q.traceId) p.set("trace", q.traceId);
  if (q.itemId) p.set("item", q.itemId);
  if (q.releaseId) p.set("release", q.releaseId);
  if (q.typePrefix) p.set("type", q.typePrefix);
  if (q.before !== undefined) p.set("before", String(q.before));
  if (q.limit !== undefined) p.set("limit", String(q.limit));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const api = {
  /** The edge adds the signed-in user's identity; we only need to send the cookie. */
  tapRelease: (hive: string, releaseId: string) =>
    request("POST", `/hives/${enc(hive)}/releases/${enc(releaseId)}/tap`, AnyParser, { releaseId }, "include"),
  // v2: REST drill-downs. Live state arrives over the WebSocket; these fetch history and detail.
  item: (hive: string, itemId: string): Promise<ItemDetail> => request("GET", `/hives/${enc(hive)}/items/${enc(itemId)}`, ItemDetailParser),
  fileItem: (hive: string, body: FileWorkItemInput): Promise<WorkItem> =>
    request("POST", `/hives/${enc(hive)}/items`, WorkItemParser, body, "include"),
  itemAction: (hive: string, itemId: string, action: WorkAction) =>
    request("POST", `/hives/${enc(hive)}/items/${enc(itemId)}/actions`, AnyParser, action, "include"),
  events: (hive: string, query: EventQueryInput = {}): Promise<QueenEvent[]> =>
    request("GET", `/hives/${enc(hive)}/events${eventsQuery(query)}`, EventsParser),
  trace: (hive: string, traceId: string): Promise<TraceView> => request("GET", `/hives/${enc(hive)}/traces/${enc(traceId)}`, TraceViewSchema),
  metrics: (hive: string, window: MetricsWindow = "24h"): Promise<MetricsView> =>
    request("GET", `/hives/${enc(hive)}/metrics?window=${window}`, MetricsParser),
  queue: (hive: string): Promise<QueueView> => request("GET", `/hives/${enc(hive)}/queue`, QueueParser),
  resolveEscalation: (hive: string, escalationId: string, body: ResolveEscalation) =>
    request("POST", `/hives/${enc(hive)}/escalations/${enc(escalationId)}/resolve`, AnyParser, body, "include"),
  updateSettings: (hive: string, body: UpdateHiveSettings) => request("PATCH", `/hives/${enc(hive)}/settings`, AnyParser, body, "include"),
  me: () => request("GET", "/api/me", MeParser),
  projects: () => request("GET", "/api/projects", ProjectsParser),
  startGenesis: (hive: string, name: string) => request("POST", "/api/genesis", WizardStateSchema, { hive, name }),
  wizard: (hive: string) => request("GET", `/api/genesis/${enc(hive)}`, WizardStateSchema),
  sendMessage: (hive: string, text: string) => request("POST", `/api/genesis/${enc(hive)}/messages`, WizardStateSchema, { text }),
  confirmCharter: (hive: string, charter: Charter): Promise<WizardState> =>
    request("PUT", `/api/genesis/${enc(hive)}/charter`, WizardStateSchema, { charter }),
  tokenTemplate: () => request("GET", "/api/vault/token-template", UrlParser),
  connectCloudflare: (hive: string, accountId: string, apiToken: string): Promise<VaultStatus> =>
    request("POST", `/api/vault/${enc(hive)}/cloudflare`, VaultStatusSchema, { accountId, apiToken }),
  launch: (hive: string) => request("POST", `/api/genesis/${enc(hive)}/launch`, WizardStateSchema),
};

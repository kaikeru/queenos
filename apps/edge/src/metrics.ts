/**
 * Analytics Engine reader (v2 design §2.8, §5.5): GET /api/metrics/:hive?q=<template>&window=<enum>.
 *
 * The client only ever picks a template NAME and a window from fixed enums. The SQL text is
 * built here from the template; the hive (validated slug) is the only free input and is
 * escaped as a string literal. AE's SQL API has no bound parameters, so escaping is the binding.
 * Dataset `queenos_events` layout (hive-kit `metricPoint`): index1 = hive; blob1..8 = type,
 * hive, kind_or_role, model, outcome, environment, trace_id, item_id; double1..5 = value_ms,
 * tokens_in, tokens_out, credits, count. Counts are weighted by `_sample_interval`.
 */

export const DATASET = "queenos_events";

export const METRIC_WINDOWS = ["1h", "6h", "24h", "7d", "30d"] as const;
export type MetricWindow = (typeof METRIC_WINDOWS)[number];
export const DEFAULT_WINDOW: MetricWindow = "24h";

/** window -> [lookback interval, bucket interval]; interval literals are fixed text, never client input. */
const WINDOW_SQL: Record<MetricWindow, { lookback: string; bucket: string }> = {
  "1h": { lookback: "INTERVAL '1' HOUR", bucket: "INTERVAL '5' MINUTE" },
  "6h": { lookback: "INTERVAL '6' HOUR", bucket: "INTERVAL '15' MINUTE" },
  "24h": { lookback: "INTERVAL '24' HOUR", bucket: "INTERVAL '1' HOUR" },
  "7d": { lookback: "INTERVAL '7' DAY", bucket: "INTERVAL '6' HOUR" },
  "30d": { lookback: "INTERVAL '30' DAY", bucket: "INTERVAL '1' DAY" },
};

/** Escape a value as an AE SQL string literal (single quotes doubled, backslashes doubled, no control chars). */
export function sqlString(value: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "");
  return `'${clean.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

interface Scope {
  hive: string;
  lookback: string;
  bucket: string;
}

/** Every template filters to the hive (index1, the sampling key) and the window. */
const where = (s: Scope, extra?: string) =>
  `index1 = ${sqlString(s.hive)} AND timestamp > NOW() - ${s.lookback}${extra ? ` AND ${extra}` : ""}`;
const ts = (s: Scope) => `toStartOfInterval(timestamp, ${s.bucket}) AS t`;

export const METRIC_TEMPLATES = {
  /** Build attempts started per bucket: the concurrency profile. */
  concurrency: (s) =>
    `SELECT ${ts(s)}, sum(_sample_interval) AS builds FROM ${DATASET} WHERE ${where(s, "blob1 = 'drone.build'")} GROUP BY t ORDER BY t`,
  /** Items filed, landed and shipped per bucket. */
  throughput: (s) =>
    `SELECT ${ts(s)}, blob1 AS type, blob5 AS outcome, sum(_sample_interval) AS items FROM ${DATASET} WHERE ${where(s, "(blob1 = 'item.filed' OR (blob1 = 'item.status' AND blob5 IN ('LANDED', 'SHIPPED')))")} GROUP BY t, type, outcome ORDER BY t`,
  /** Merge-queue wait (pass to land), p50/p90 per bucket. */
  queue_wait: (s) =>
    `SELECT ${ts(s)}, quantileExactWeighted(0.5)(double1, _sample_interval) AS p50_ms, quantileExactWeighted(0.9)(double1, _sample_interval) AS p90_ms, sum(_sample_interval) AS cars FROM ${DATASET} WHERE ${where(s, "blob1 = 'queue.landed'")} GROUP BY t ORDER BY t`,
  /** Queue conflicts and bisects per bucket. */
  conflicts_bisects: (s) =>
    `SELECT ${ts(s)}, blob1 AS type, sum(_sample_interval) AS events FROM ${DATASET} WHERE ${where(s, "blob1 IN ('queue.conflict', 'queue.bisect')")} GROUP BY t, type ORDER BY t`,
  /** Gate verdicts by outcome per bucket. */
  gate_verdicts: (s) =>
    `SELECT ${ts(s)}, blob5 AS outcome, sum(_sample_interval) AS verdicts FROM ${DATASET} WHERE ${where(s, "blob1 = 'gate.verdict'")} GROUP BY t, outcome ORDER BY t`,
  /** Builds by model: attempts, outcome, latency, tokens and credits. */
  builds_by_model: (s) =>
    `SELECT blob4 AS model, blob5 AS outcome, sum(_sample_interval) AS builds, quantileExactWeighted(0.5)(double1, _sample_interval) AS p50_ms, sum(_sample_interval * double2) AS tokens_in, sum(_sample_interval * double3) AS tokens_out, sum(_sample_interval * double4) AS credits FROM ${DATASET} WHERE ${where(s, "blob1 = 'drone.build'")} GROUP BY model, outcome ORDER BY builds DESC LIMIT 100`,
  /** Race wins by model. */
  race_wins: (s) =>
    `SELECT blob4 AS model, sum(_sample_interval) AS wins FROM ${DATASET} WHERE ${where(s, "blob1 = 'race.decided'")} GROUP BY model ORDER BY wins DESC LIMIT 50`,
  /** Credits spent per bucket. */
  credits: (s) =>
    `SELECT ${ts(s)}, sum(_sample_interval * double4) AS credits FROM ${DATASET} WHERE ${where(s)} GROUP BY t ORDER BY t`,
  /** Sentinel p99 (max over the windows) and requests per bucket and environment. */
  sentinel_p99: (s) =>
    `SELECT ${ts(s)}, blob6 AS environment, max(double1) AS p99_ms, sum(_sample_interval * double5) AS requests FROM ${DATASET} WHERE ${where(s, "blob1 = 'sentinel.window'")} GROUP BY t, environment ORDER BY t`,
} satisfies Record<string, (s: Scope) => string>;

export type MetricTemplate = keyof typeof METRIC_TEMPLATES;
export const METRIC_TEMPLATE_NAMES = Object.keys(METRIC_TEMPLATES) as MetricTemplate[];

export function isTemplate(name: string): name is MetricTemplate {
  return Object.prototype.hasOwnProperty.call(METRIC_TEMPLATES, name);
}

export function isWindow(w: string): w is MetricWindow {
  return (METRIC_WINDOWS as readonly string[]).includes(w);
}

/** Build the SQL for an allowlisted template. `hive` must already be a validated slug. */
export function buildQuery(template: MetricTemplate, hive: string, window: MetricWindow): string {
  const w = WINDOW_SQL[window];
  return `${METRIC_TEMPLATES[template]({ hive, ...w })} FORMAT JSON`;
}

export interface AnalyticsEnv {
  ACCOUNT_ID?: string;
  ANALYTICS_API_TOKEN?: string;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** POST the SQL to the AE SQL API. Throws on any failure (the caller turns it into 503). */
export async function runQuery(env: AnalyticsEnv, sql: string, fetcher: Fetcher): Promise<unknown[]> {
  const res = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.ACCOUNT_ID ?? "")}/analytics_engine/sql`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.ANALYTICS_API_TOKEN}` },
    body: sql,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`analytics upstream ${res.status}`);
  const json = (await res.json()) as { data?: unknown };
  if (!json || !Array.isArray(json.data)) throw new Error("analytics upstream: bad shape");
  return json.data;
}

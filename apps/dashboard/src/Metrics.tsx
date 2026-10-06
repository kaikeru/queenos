import { useEffect, useRef, useState } from "react";
import type { HiveStatus, HourlyMetric, QueenEvent } from "@queenos/queen-types";
import { api, type MetricsView, type MetricsWindow } from "./api";
import { ErrorNotice } from "./shell";
import { useResource } from "./hooks";
import { fmtDuration } from "./TraceView";
import type { State } from "./reducer";
import "./obs.css";

const HOUR = 3_600_000;

// ── pure data shaping (unit-tested) ───────────────────────────────────────

export interface Bucket {
  /** Epoch ms of the bucket start. */
  ts: number;
}
export type Agg = "count" | "sum" | "max" | "mean";

/** `hours / stepHours` buckets ending with the hour that contains `now`. */
export function windowBuckets(now: number, hours: number, stepHours = 1): Bucket[] {
  const end = Math.floor(now / HOUR) * HOUR + HOUR;
  const n = Math.ceil(hours / stepHours);
  const stepMs = stepHours * HOUR;
  return Array.from({ length: n }, (_, i) => ({ ts: end - (n - i) * stepMs }));
}

/**
 * One value per bucket from the hourly rollups named in `names` (the Queen
 * writes `items_landed`; older fixtures say `item_landed`, so both are accepted).
 * count/sum add the rows; max takes the peak; mean is sum/count. Buckets with no
 * rows are 0 for count/sum and null (a line gap) for max/mean.
 */
export function seriesOf(rollups: readonly HourlyMetric[], names: readonly string[], buckets: readonly Bucket[], stepMs: number, agg: Agg): (number | null)[] {
  const acc = buckets.map(() => ({ count: 0, sum: 0, max: null as number | null, rows: 0 }));
  const start = buckets[0]?.ts ?? 0;
  for (const r of rollups) {
    if (!names.includes(r.name)) continue;
    const i = Math.floor((r.bucket - start) / stepMs);
    const a = acc[i];
    if (!a || i < 0) continue;
    a.count += r.count;
    a.sum += r.sum;
    a.max = a.max === null ? r.max : Math.max(a.max, r.max);
    a.rows += 1;
  }
  return acc.map((a) => {
    switch (agg) {
      case "count": return a.count;
      case "sum": return a.sum;
      case "max": return a.max;
      case "mean": return a.count > 0 ? a.sum / a.count : null;
    }
  });
}

/** Counts of a rollup by one label (e.g. gate_verdicts by outcome), largest first. */
export function totalsByLabel(rollups: readonly HourlyMetric[], name: string, label: string): [string, number][] {
  const m = new Map<string, number>();
  for (const r of rollups) if (r.name === name) m.set(r.labels[label] ?? "unknown", (m.get(r.labels[label] ?? "unknown") ?? 0) + r.count);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Fallback for the gate chart when the source has no gate rollups: the live event stream. */
export function gateTotalsFromEvents(events: readonly QueenEvent[]): [string, number][] {
  const m = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "gate.verdict") continue;
    const o = typeof e.data?.outcome === "string" ? e.data.outcome : typeof e.data?.verdict === "string" ? e.data.verdict : "unknown";
    m.set(o, (m.get(o) ?? 0) + 1);
  }
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** A round axis maximum (1, 2, 5 x 10^n) at or above `v`. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

export type SourceKind = "ae" | "rollups";
export function sourceKind(source: string): SourceKind {
  return /analytics|\bae\b/i.test(source) ? "ae" : "rollups";
}

export interface Budget {
  allowed: number;
  failed: number;
  remaining: number;
  /** 0..1 of the allowed failures already used. */
  usedFraction: number;
  level: "ok" | "low" | "exhausted";
}
export function errorBudget(slo: HiveStatus["slo"]): Budget {
  const allowed = Math.floor((1 - slo.target) * slo.window + 1e-9);
  const remaining = slo.errorBudgetRemaining;
  return {
    allowed,
    failed: slo.failed,
    remaining,
    usedFraction: allowed > 0 ? Math.min(1, slo.failed / allowed) : slo.failed > 0 ? 1 : 0,
    level: slo.exhausted || remaining < 0 ? "exhausted" : remaining <= 1 ? "low" : "ok",
  };
}

const num = (n: number) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : Number.isInteger(n) ? String(n) : n.toFixed(1));
const pct = (n: number | null | undefined) => (n === null || n === undefined ? "-" : `${Math.round(n * 100)}%`);

// ── chart ─────────────────────────────────────────────────────────────────

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
}
interface ChartProps {
  title: string;
  sub?: string;
  kind: "line" | "bars";
  series: ChartSeries[];
  buckets: Bucket[];
  /** values[s][i]: series s at bucket i. */
  values: (number | null)[][];
  stepMs: number;
  fmt?: (n: number) => string;
  /** A labelled horizontal reference (e.g. the slot cap). */
  ref?: { value: number; label: string };
}

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(Math.max(220, Math.floor(el.clientWidth))));
    ro.observe(el);
    setW(Math.max(220, Math.floor(el.clientWidth)));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const pad2 = (n: number) => String(n).padStart(2, "0");
function tickLabel(ts: number, stepMs: number, hours: number): string {
  const d = new Date(ts);
  return hours > 24 ? `${d.toLocaleDateString([], { weekday: "short" })} ${pad2(d.getHours())}h` : `${pad2(d.getHours())}:00`;
}
const fullLabel = (ts: number, stepMs: number) => `${new Date(ts).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })}${stepMs > HOUR ? ` (+${stepMs / HOUR}h)` : ""}`;

/** Bar with a 4px rounded data end and a square baseline. */
export function barPath(x: number, y: number, w: number, h: number, r = 4): string {
  const rr = Math.min(r, w / 2, h);
  if (h <= 0) return "";
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function Chart(props: ChartProps) {
  const { title, sub, kind, series, buckets, values, stepMs } = props;
  const fmt = props.fmt ?? num;
  const [wrap, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const H = 170, L = 38, R = 12, T = 10, B = 22;
  const plotW = Math.max(width - L - R, 50), plotH = H - T - B;
  const n = buckets.length;
  const all = values.flat().filter((v): v is number => v !== null);
  const max = niceMax(Math.max(0, props.ref?.value ?? 0, ...all));
  const y = (v: number) => T + plotH - (v / max) * plotH;
  const colW = plotW / Math.max(n, 1);
  const x = (i: number) => L + colW * (i + 0.5);
  const hours = (n * stepMs) / HOUR;
  const labelEvery = Math.max(1, Math.round(n / (width < 420 ? 3 : 6)));
  const empty = all.length === 0 || all.every((v) => v === 0);

  // Bars: capped at 24px, 2px surface gap between neighbours in a group.
  const k = series.length;
  const groupW = Math.min(colW * 0.8, 24 * k + 2 * (k - 1));
  const barW = Math.max((groupW - 2 * (k - 1)) / k, 1);

  const pathFor = (vals: (number | null)[]) => {
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const areaFor = (vals: (number | null)[]) => {
    // One wash per contiguous run.
    const runs: number[][] = [];
    vals.forEach((v, i) => (v === null ? runs.push([]) : (runs.at(-1)?.length === undefined || runs.length === 0 ? runs.push([i]) : runs.at(-1)!.push(i))));
    return runs.filter((r) => r.length > 1).map((r) => `M${x(r[0]!)},${T + plotH}${r.map((i) => `L${x(i).toFixed(1)},${y(vals[i]!).toFixed(1)}`).join("")}L${x(r.at(-1)!)},${T + plotH}Z`).join("");
  };

  const hx = hover === null ? 0 : x(hover);
  const ticks = [0, max / 2, max];

  return (
    <figure className="ch panel" style={{ margin: 0 }} aria-label={title}>
      <div>
        <h3>{title}</h3>
        {sub && <p className="obs__sub">{sub}</p>}
      </div>
      {series.length > 1 && (
        <div className="ch-legend">
          {series.map((s) => (
            <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>
          ))}
        </div>
      )}
      <div className="ch__plot" ref={wrap}>
        {empty ? (
          <p className="obs__empty">No data in this window.</p>
        ) : (
          <svg width={width} height={H} role="img" aria-label={`${title}: ${series.map((s) => s.label).join(", ")}`} onMouseLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <g key={t}>
                <line className={t === 0 ? "axis" : "grid"} x1={L} x2={L + plotW} y1={y(t)} y2={y(t)} />
                <text x={L - 6} y={y(t) + 4} textAnchor="end">{fmt(t)}</text>
              </g>
            ))}
            {buckets.map((b, i) =>
              i % labelEvery === 0 ? (
                <text key={b.ts} x={x(i)} y={H - 6} textAnchor="middle">{tickLabel(b.ts, stepMs, hours)}</text>
              ) : null,
            )}
            {props.ref && (
              <g>
                <line className="cross" x1={L} x2={L + plotW} y1={y(props.ref.value)} y2={y(props.ref.value)} />
                <text x={L + plotW} y={y(props.ref.value) - 4} textAnchor="end">{props.ref.label}</text>
              </g>
            )}
            {hover !== null && <line className="cross" x1={hx} x2={hx} y1={T} y2={T + plotH} />}
            {kind === "bars" &&
              series.map((s, si) =>
                values[si]!.map((v, i) =>
                  v && v > 0 ? (
                    <path key={`${s.key}${i}`} d={barPath(x(i) - groupW / 2 + si * (barW + 2), y(v), barW, T + plotH - y(v))} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.55} />
                  ) : null,
                ),
              )}
            {kind === "line" &&
              series.map((s, si) => {
                const vals = values[si]!;
                const last = vals.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0).at(-1);
                return (
                  <g key={s.key}>
                    {series.length === 1 && <path d={areaFor(vals)} fill={s.color} opacity={0.1} />}
                    <path d={pathFor(vals)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                    {last !== undefined && <circle cx={x(last)} cy={y(vals[last]!)} r={4} fill={s.color} stroke="var(--panel)" strokeWidth={2} />}
                    {hover !== null && vals[hover] !== null && <circle cx={x(hover)} cy={y(vals[hover]!)} r={4} fill={s.color} stroke="var(--panel)" strokeWidth={2} />}
                  </g>
                );
              })}
            {buckets.map((b, i) => (
              <rect key={b.ts} x={L + colW * i} y={T} width={colW} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} onMouseMove={() => setHover(i)} onTouchStart={() => setHover(i)} />
            ))}
          </svg>
        )}
        {hover !== null && !empty && (
          <div className={`ch__tip${hx > width * 0.6 ? " ch__tip--left" : ""}`} style={{ left: hx }} role="status">
            <div style={{ color: "var(--dim)" }}>{fullLabel(buckets[hover]!.ts, stepMs)}</div>
            {series.map((s, si) => (
              <div key={s.key}><i style={{ background: s.color }} />{s.label}: {values[si]![hover] === null ? "-" : fmt(values[si]![hover]!)}</div>
            ))}
          </div>
        )}
      </div>
      <details>
        <summary>Table view</summary>
        <div className="tablewrap">
          <table>
            <thead><tr><th>Time</th>{series.map((s) => <th key={s.key}>{s.label}</th>)}</tr></thead>
            <tbody>
              {buckets.map((b, i) => (
                <tr key={b.ts}><td>{fullLabel(b.ts, stepMs)}</td>{series.map((s, si) => <td key={s.key}>{values[si]![i] === null ? "-" : fmt(values[si]![i]!)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

// ── page ──────────────────────────────────────────────────────────────────

const C1 = "var(--s1)", C2 = "var(--s2)", C3 = "var(--s3)";

function Tile(props: { label: string; value: string; note?: string }) {
  return (
    <div className="mt-tile">
      <dt>{props.label}</dt>
      <dd>{props.value}{props.note && <small>{props.note}</small>}</dd>
    </div>
  );
}

function Meter({ label, value, fraction, level, note }: { label: string; value: string; fraction: number; level: "ok" | "warn" | "bad"; note?: string }) {
  const icon = level === "ok" ? "✓" : level === "warn" ? "!" : "✗";
  return (
    <div>
      <div className="row"><span>{label}</span><span>{icon} {value}</span></div>
      <div className={`meter${level === "ok" ? "" : ` meter--${level}`}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
        <div style={{ width: `${Math.max(fraction * 100, 2)}%` }} />
      </div>
      {note && <p className="obs__sub" style={{ marginTop: 4 }}>{note}</p>}
    </div>
  );
}

export function MetricsBoard(props: { data: MetricsView; window: MetricsWindow; events: readonly QueenEvent[]; now: number }) {
  const { data, window: win, now } = props;
  const hours = win === "7d" ? 168 : 24;
  const stepHours = win === "7d" ? 6 : 1;
  const stepMs = stepHours * HOUR;
  const buckets = windowBuckets(now, hours, stepHours);
  const r = data.rollups;
  const per = stepHours === 1 ? "hour" : `${stepHours} h`;
  const h = data.hive;
  const conc = h?.concurrency;

  const gateRollup = totalsByLabel(r, "gate_verdicts", "outcome");
  const gates = gateRollup.length ? gateRollup : gateTotalsFromEvents(props.events);
  const gatesFromEvents = gateRollup.length === 0 && gates.length > 0;
  const gateMax = Math.max(1, ...gates.map((g) => g[1]));
  const budget = h ? errorBudget(h.slo) : null;
  const kind = sourceKind(data.source);

  return (
    <>
      {h && (
        <dl className="mt-tiles" style={{ margin: 0 }}>
          <Tile label="ACTIVE BUILDS" value={String(conc?.activeBuilds ?? "-")} note={conc ? `of ${conc.leasedSlots} leased slots` : undefined} />
          <Tile label="QUEUE DEPTH" value={String(conc?.queueDepth ?? "-")} note={conc ? `${conc.waitingToBoard} waiting to board` : undefined} />
          <Tile label="LANDED 24H" value={String(h.throughput.landed24h)} />
          <Tile label="SHIPPED 24H" value={String(h.throughput.shipped24h)} />
          <Tile label="LEAD TIME P50" value={h.throughput.leadTimeP50Ms === null ? "-" : fmtDuration(h.throughput.leadTimeP50Ms)} />
          <Tile label="FIRST-TRY PASS" value={pct(h.throughput.firstTryPassRate)} />
          <Tile label="QUEUE WAIT P50" value={conc?.queueWaitP50Ms == null ? "-" : fmtDuration(conc.queueWaitP50Ms)} />
        </dl>
      )}
      <div className="mt-grid">
        <Chart
          title="Concurrency" sub="Peak active builds per hour" kind="line" buckets={buckets} stepMs={stepMs}
          series={[{ key: "builds", label: "Active builds (peak)", color: C1 }]}
          values={[seriesOf(r, ["active_builds"], buckets, stepMs, "max")]}
          ref={conc ? { value: conc.leasedSlots, label: `${conc.leasedSlots} slots` } : undefined}
        />
        <Chart
          title="Throughput" sub={`Items landed and shipped per ${per}`} kind="bars" buckets={buckets} stepMs={stepMs}
          series={[{ key: "landed", label: "Landed", color: C1 }, { key: "shipped", label: "Shipped", color: C2 }]}
          values={[seriesOf(r, ["items_landed", "item_landed"], buckets, stepMs, "count"), seriesOf(r, ["items_shipped", "item_shipped"], buckets, stepMs, "count")]}
        />
        <Chart
          title="Queue wait" sub={`Mean time from pass to land per ${per}`} kind="line" buckets={buckets} stepMs={stepMs}
          series={[{ key: "wait", label: "Mean wait", color: C3 }]} fmt={fmtDuration}
          values={[seriesOf(r, ["queue_wait_ms"], buckets, stepMs, "mean")]}
        />
        <Chart
          title="Conflicts and bisects" sub={`Merge-queue conflicts and bisect splits per ${per}`} kind="bars" buckets={buckets} stepMs={stepMs}
          series={[{ key: "conflicts", label: "Conflicts", color: C2 }, { key: "bisects", label: "Bisects", color: C1 }]}
          values={[seriesOf(r, ["queue_conflicts"], buckets, stepMs, "count"), seriesOf(r, ["queue_bisects"], buckets, stepMs, "count")]}
        />
        <figure className="ch panel" style={{ margin: 0 }} aria-label="Gate verdicts">
          <div>
            <h3>Gate verdicts</h3>
            <p className="obs__sub">{gatesFromEvents ? "From the live event stream (no gate rollups in this source)" : "Gatekeeper outcomes in the window"}</p>
          </div>
          {gates.length === 0 ? (
            <p className="obs__empty">No gate verdicts yet.</p>
          ) : (
            gates.slice(0, 8).map(([outcome, count]) => {
              const bad = /fail|reject|block|deny/i.test(outcome);
              return (
                <div className="gate-row" key={outcome}>
                  <span>{bad ? "✗" : "✓"} {outcome}</span>
                  <div className="gate-bar"><div style={{ width: `${(count / gateMax) * 100}%`, background: bad ? "var(--red)" : "var(--green)" }} /></div>
                  <span>{count}</span>
                </div>
              );
            })
          )}
        </figure>
        <section className="ch panel" aria-label="Error budget">
          <div>
            <h3>Error budget</h3>
            <p className="obs__sub">Change-success SLO over the last {h?.slo.window ?? "-"} terminal releases</p>
          </div>
          {h && budget ? (
            <div className="mt-meters">
              <Meter
                label="Failures allowed" level={budget.level === "ok" ? "ok" : budget.level === "low" ? "warn" : "bad"} fraction={budget.usedFraction}
                value={budget.level === "exhausted" ? "exhausted" : `${budget.remaining} left`}
                note={`${budget.failed} failed of ${h.slo.attempted} attempted · target ${pct(h.slo.target)} · ${budget.allowed} failures allowed`}
              />
              <Meter
                label="Credits today" level={h.budget.creditsUsed >= h.budget.creditsLimit ? "bad" : h.budget.creditsUsed / h.budget.creditsLimit > 0.8 ? "warn" : "ok"}
                fraction={h.budget.creditsLimit ? Math.min(1, h.budget.creditsUsed / h.budget.creditsLimit) : 0}
                value={`${num(h.budget.creditsUsed)} / ${num(h.budget.creditsLimit)}`}
              />
              <Meter
                label="Dispatches today" level={h.budget.dispatches >= h.budget.dispatchLimit ? "bad" : h.budget.dispatches / h.budget.dispatchLimit > 0.8 ? "warn" : "ok"}
                fraction={h.budget.dispatchLimit ? Math.min(1, h.budget.dispatches / h.budget.dispatchLimit) : 0}
                value={`${h.budget.dispatches} / ${h.budget.dispatchLimit}`}
              />
            </div>
          ) : (
            <p className="obs__empty">No hive status in this response.</p>
          )}
        </section>
      </div>
      <p className="obs__sub">
        Source: <span className={`mt-source mt-source--${kind}`} title={data.source}>{kind === "ae" ? "Analytics Engine via the edge" : "Queen hourly rollups"}</span>{" "}
        {kind === "rollups" && "(fallback when Analytics Engine is not available, e.g. sim)"} · {data.source}
      </p>
    </>
  );
}

export function Metrics(props: { hive: string; state: State }) {
  const { hive, state } = props;
  const [win, setWin] = useState<MetricsWindow>("24h");
  const res = useResource(() => api.metrics(hive, win), `${hive}:${win}`);
  const reload = res.reload;
  useEffect(() => {
    const t = setInterval(reload, 30_000);
    return () => clearInterval(t);
  }, [reload]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setNow(Date.now()), [res.data]);

  return (
    <div className="obs">
      <div className="obs__head">
        <div className="grow">
          <h2>Metrics</h2>
          <p className="obs__sub">{hive} · last {win}</p>
        </div>
        <div className="seg" role="group" aria-label="Window">
          {(["24h", "7d"] as const).map((w) => (
            <button key={w} type="button" aria-pressed={win === w} onClick={() => setWin(w)}>{w}</button>
          ))}
        </div>
      </div>
      <ErrorNotice error={res.error} onRetry={res.reload} />
      {!res.data && !res.error && <p className="obs__empty">Loading metrics…</p>}
      {res.data && <MetricsBoard data={res.data} window={win} events={state.events} now={now} />}
    </div>
  );
}

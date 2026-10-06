import { useEffect, useMemo, useState } from "react";
import type { QueenEvent, Span, SpanKind, TraceView as TraceViewData } from "@queenos/queen-types";
import { api } from "./api";
import { ErrorNotice } from "./shell";
import { useResource } from "./hooks";
import { Link } from "./router";
import { hrefFor } from "./route";
import type { State } from "./reducer";
import "./obs.css";

/** Bar color per span kind (dataviz categorical slots, fixed order); the kind label is the second channel. */
export const KIND_COLOR: Record<SpanKind, string> = {
  item: "var(--s1)",
  train: "var(--s2)",
  car: "var(--s3)",
  command: "var(--s4)",
  gate: "var(--s5)",
  release: "var(--s6)",
};
const KINDS = Object.keys(KIND_COLOR) as SpanKind[];

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  const s = Math.abs(ms) / 1000;
  if (s < 1) return `${Math.round(ms)}ms`;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

const BAD_OUTCOME = /fail|reject|eject|error|rolled|cancel|conflict|timeout|denied/i;
export const isBadOutcome = (o: string | null): boolean => !!o && BAD_OUTCOME.test(o);

export interface TraceRow {
  span: Span;
  depth: number;
  /** Position inside the trace window, as percentages. */
  leftPct: number;
  widthPct: number;
  offsetMs: number;
  durMs: number;
  running: boolean;
  bad: boolean;
  /** A car span: recorded in every member's trace with the same span id. */
  shared: boolean;
}
export interface TraceLayout {
  rows: TraceRow[];
  t0: number;
  totalMs: number;
}

const MIN_BAR_PCT = 0.5;

/** Flatten the span tree depth-first (siblings by start time) and place each span on one shared time axis. */
export function layoutTrace(spans: readonly Span[], now: number): TraceLayout {
  if (!spans.length) return { rows: [], t0: now, totalMs: 1000 };
  const ids = new Set(spans.map((s) => s.spanId));
  const kids = new Map<string | null, Span[]>();
  for (const s of spans) {
    const key = s.parentSpanId && s.parentSpanId !== s.spanId && ids.has(s.parentSpanId) ? s.parentSpanId : null;
    const l = kids.get(key);
    if (l) l.push(s);
    else kids.set(key, [s]);
  }
  for (const l of kids.values()) l.sort((a, b) => a.startTs - b.startTs || a.spanId.localeCompare(b.spanId));
  const t0 = Math.min(...spans.map((s) => s.startTs));
  const endOf = (s: Span) => Math.max(s.endTs ?? now, s.startTs);
  const t1 = Math.max(...spans.map(endOf));
  const totalMs = Math.max(t1 - t0, 1000);
  const rows: TraceRow[] = [];
  const seen = new Set<string>();
  const walk = (s: Span, depth: number) => {
    if (seen.has(s.spanId)) return;
    seen.add(s.spanId);
    const durMs = endOf(s) - s.startTs;
    rows.push({
      span: s,
      depth,
      leftPct: ((s.startTs - t0) / totalMs) * 100,
      widthPct: Math.max((durMs / totalMs) * 100, MIN_BAR_PCT),
      offsetMs: s.startTs - t0,
      durMs,
      running: s.endTs === null,
      bad: isBadOutcome(s.outcome),
      shared: s.kind === "car",
    });
    for (const c of kids.get(s.spanId) ?? []) walk(c, depth + 1);
  };
  for (const r of kids.get(null) ?? []) walk(r, 0);
  return { rows, t0, totalMs };
}

const STEPS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 86400];
/** Axis tick offsets (ms from the start) giving at most `max` ticks. */
export function axisTicks(totalMs: number, max = 6): number[] {
  const step = (STEPS_S.find((s) => (totalMs / 1000 / s) <= max) ?? 86400) * 1000;
  const out: number[] = [];
  for (let t = 0; t <= totalMs; t += step) out.push(t);
  return out;
}

/** Span ids that more than one row of this trace's view could share: events of the span, plus car members. */
export function eventsForSpan(events: readonly QueenEvent[], spanId: string): QueenEvent[] {
  return events.filter((e) => e.spanId === spanId).sort((a, b) => a.seq - b.seq);
}
export function carMembers(events: readonly QueenEvent[]): string[] {
  const out = new Set<string>();
  for (const e of events) {
    const m = e.data?.members;
    if (Array.isArray(m)) for (const x of m) if (typeof x === "string") out.add(x);
  }
  return [...out];
}

const short = (id: string) => id.slice(0, 8);

function Bar({ r, color }: { r: TraceRow; color: string }) {
  return (
    <svg height="22" aria-hidden="true">
      <rect x={`${r.leftPct}%`} y="4" width={`${Math.min(r.widthPct, 100 - r.leftPct)}%`} height="14" rx="4" fill={color} opacity={r.running ? 0.75 : 1} />
      {r.running && <circle cx={`${Math.min(r.leftPct + r.widthPct, 99)}%`} cy="11" r="4" fill={color} stroke="var(--panel)" strokeWidth="2" />}
    </svg>
  );
}

/** The waterfall plus the span panel, for an already-loaded trace (pure of fetching, so it is testable). */
export function TraceWaterfall(props: { view: TraceViewData; hive: string; now: number }) {
  const { view, hive, now } = props;
  const layout = useMemo(() => layoutTrace(view.spans, now), [view.spans, now]);
  const [selected, setSelected] = useState<string | null>(null);
  const sel = layout.rows.find((r) => r.span.spanId === selected) ?? null;
  const ticks = axisTicks(layout.totalMs);
  const usedKinds = KINDS.filter((k) => layout.rows.some((r) => r.span.kind === k));
  const shared = layout.rows.filter((r) => r.shared);

  return (
    <div className="tr-body">
      <section className="panel" aria-label="Span waterfall">
        <div className="tr-legend" style={{ marginBottom: 10 }}>
          {usedKinds.map((k) => (
            <span key={k}><i style={{ background: KIND_COLOR[k] }} />{k}</span>
          ))}
          <span>total {fmtDuration(layout.totalMs)}</span>
          {shared.length > 0 && <span>{shared.length} car span{shared.length === 1 ? "" : "s"} shared with member traces</span>}
        </div>
        {layout.rows.length === 0 ? (
          <p className="obs__empty">No spans yet for this trace.</p>
        ) : (
          <div className="tr-wf" role="list">
            <div className="tr-axis" aria-hidden="true">
              <span />
              <svg height="18">
                {ticks.map((t) => (
                  <text key={t} x={`${(t / layout.totalMs) * 100}%`} y="13" textAnchor={t === 0 ? "start" : "middle"} fill="currentColor" style={{ font: "11px var(--mono)" }}>
                    {t === 0 ? "0s" : fmtDuration(t)}
                  </text>
                ))}
              </svg>
            </div>
            {layout.rows.map((r) => (
              <button
                key={r.span.spanId}
                role="listitem"
                type="button"
                className="tr-row"
                aria-pressed={selected === r.span.spanId}
                onClick={() => setSelected(selected === r.span.spanId ? null : r.span.spanId)}
                title={`${r.span.name} · ${fmtDuration(r.durMs)}${r.span.outcome ? ` · ${r.span.outcome}` : ""}`}
              >
                <span className="tr-row__label" style={{ paddingLeft: Math.min(r.depth, 6) * 10 }}>
                  <span className="kind">{r.span.kind.toUpperCase()}</span>
                  <span className="name">{r.span.name}</span>
                  {r.shared && <span className="kind" title="Shared car span">⚡</span>}
                  {r.bad ? <span className="bad" aria-label="failed">✗</span> : r.span.outcome ? <span className="okmark" aria-label="ok">✓</span> : null}
                </span>
                <span style={{ position: "relative" }}>
                  <Bar r={r} color={KIND_COLOR[r.span.kind]} />
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
      <aside className="panel tr-side" aria-label="Span details">
        {sel ? <SpanPanel row={sel} view={view} hive={hive} /> : <p className="obs__empty">Select a span to see its commands, outcome and events.</p>}
        {view.links.length > 0 && (
          <div>
            <div className="eyebrow">LINKED TRACES</div>
            <div className="tr-links">
              {view.links.map((id) => (
                <Link key={id} to={hrefFor.trace(hive, id)} title={id}>{short(id)}</Link>
              ))}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

function SpanPanel({ row, view, hive }: { row: TraceRow; view: TraceViewData; hive: string }) {
  const { span } = row;
  const evs = eventsForSpan(view.events, span.spanId);
  const members = row.shared ? carMembers(evs) : [];
  const first = evs[0];
  const commandId = evs.find((e) => e.commandId)?.commandId ?? null;
  const itemId = evs.find((e) => e.itemId)?.itemId ?? null;
  return (
    <>
      <h3>{span.name}</h3>
      <dl>
        <dt>KIND</dt><dd>{span.kind}</dd>
        <dt>OUTCOME</dt><dd>{span.outcome ?? (row.running ? "running" : "-")}</dd>
        <dt>START</dt><dd>+{fmtDuration(row.offsetMs)}</dd>
        <dt>DURATION</dt><dd>{fmtDuration(row.durMs)}{row.running ? " (running)" : ""}</dd>
        <dt>SPAN</dt><dd><code>{span.spanId}</code></dd>
        {span.parentSpanId && <><dt>PARENT</dt><dd><code>{span.parentSpanId}</code></dd></>}
        {commandId && <><dt>COMMAND</dt><dd><code>{commandId}</code></dd></>}
        {first && <><dt>ACTOR</dt><dd>{first.actor}</dd></>}
        {itemId && <><dt>ITEM</dt><dd><Link to={hrefFor.item(hive, itemId)}>{itemId}</Link></dd></>}
      </dl>
      {row.shared && (
        <p className="car-note">
          ⚡ One car, many traces: this span has the same id in each member build&apos;s trace.
          {members.length > 0 && <> Members: {members.join(", ")}.</>}
        </p>
      )}
      <div className="eyebrow" style={{ marginBottom: 0 }}>EVENTS ({evs.length})</div>
      <ol>
        {evs.map((e) => (
          <li key={e.eventId}>
            <b>{e.type}</b> <time>+{fmtDuration(e.ts - (view.spans.length ? Math.min(...view.spans.map((s) => s.startTs)) : e.ts))}</time>
            <div>{e.summary}</div>
            {e.gitNotesPayload && <code>ledger: {JSON.stringify(e.gitNotesPayload).slice(0, 160)}</code>}
          </li>
        ))}
      </ol>
      <p className="obs__sub">Workers Logs: filter <code>trace_id = {view.traceId}</code></p>
    </>
  );
}

export function TraceView(props: { hive: string; traceId: string; state: State }) {
  const { hive, traceId, state } = props;
  // Re-fetch when new events for this trace arrive over the socket; the old view stays up meanwhile.
  const live = useMemo(() => state.events.filter((e) => e.traceId === traceId).length, [state.events, traceId]);
  const res = useResource(() => api.trace(hive, traceId), `${hive}:${traceId}:${live}`);
  const view = res.data && res.data.traceId === traceId ? res.data : null;
  const running = !!view?.spans.some((s) => s.endTs === null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  return (
    <div className="obs">
      <div className="obs__head">
        <div className="grow">
          <h2>Trace <code>{short(traceId)}…</code></h2>
          <p className="obs__sub">{traceId}</p>
        </div>
        <Link className="btn" to={`${hrefFor.events(hive)}?trace=${traceId}`}>Events</Link>
      </div>
      <ErrorNotice error={res.error} onRetry={res.reload} />
      {!view && !res.error && <p className="obs__empty">Loading trace…</p>}
      {view && <TraceWaterfall view={view} hive={hive} now={now} />}
    </div>
  );
}

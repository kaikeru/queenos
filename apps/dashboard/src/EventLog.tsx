import { useEffect, useMemo, useRef, useState } from "react";
import { EventTypeSchema, type EventSeverity, type QueenEvent } from "@queenos/queen-types";
import { api } from "./api";
import { ErrorNotice } from "./shell";
import { Link } from "./router";
import { hrefFor } from "./route";
import type { State } from "./reducer";
import "./obs.css";

export const PAGE_SIZE = 100;
const SEV_RANK: Record<EventSeverity, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface EventFilters {
  /** A type prefix (`queue`) or an exact type (`queue.conflict`), as the Queen's `?type=` takes. */
  type: string;
  item: string;
  trace: string;
  release: string;
  /** Client-side: hide events below this severity. */
  minSeverity: EventSeverity;
}
export const NO_FILTERS: EventFilters = { type: "", item: "", trace: "", release: "", minSeverity: "debug" };

/** Event type groups (the dotted prefix) with their members, for the type select. */
export const TYPE_GROUPS: { prefix: string; types: string[] }[] = (() => {
  const g = new Map<string, string[]>();
  for (const t of EventTypeSchema.options) {
    const p = t.split(".")[0]!;
    g.set(p, [...(g.get(p) ?? []), t]);
  }
  return [...g].map(([prefix, types]) => ({ prefix, types }));
})();

/** Same rule as the Queen: `type = prefix` or `type LIKE prefix || '.%'`. */
export const matchesType = (type: string, prefix: string): boolean => !prefix || type === prefix || type.startsWith(`${prefix}.`);

export function matchesFilters(e: QueenEvent, f: EventFilters): boolean {
  return (
    matchesType(e.type, f.type) &&
    (!f.item || e.itemId === f.item) &&
    (!f.trace || e.traceId === f.trace) &&
    (!f.release || e.releaseId === f.release) &&
    SEV_RANK[e.severity] >= SEV_RANK[f.minSeverity]
  );
}

/** Filters from `?type=&item=&trace=&release=` (the trace page links here). */
export function filtersFromSearch(search: string): EventFilters {
  const p = new URLSearchParams(search);
  return { ...NO_FILTERS, type: p.get("type") ?? "", item: p.get("item") ?? "", trace: p.get("trace") ?? "", release: p.get("release") ?? "" };
}

/**
 * The visible list, newest first: fetched pages plus live events that arrived
 * after the newest fetched row (older live events are left to paging, so the
 * `before` cursor never skips rows). Deduped by event id.
 */
export function mergeEvents(fetched: readonly QueenEvent[], live: readonly QueenEvent[], f: EventFilters, loaded = true): QueenEvent[] {
  const maxSeq = fetched.reduce((m, e) => Math.max(m, e.seq), 0);
  const seen = new Set<string>();
  const out: QueenEvent[] = [];
  const add = (e: QueenEvent) => {
    if (seen.has(e.eventId) || !matchesFilters(e, f)) return;
    seen.add(e.eventId);
    out.push(e);
  };
  if (loaded) for (const e of live) if (e.seq > maxSeq) add(e);
  for (const e of fetched) add(e);
  return out.sort((a, b) => b.seq - a.seq);
}

const query = (f: EventFilters, before?: number) => ({
  ...(f.type ? { typePrefix: f.type } : {}),
  ...(f.item ? { itemId: f.item } : {}),
  ...(f.trace ? { traceId: f.trace } : {}),
  ...(f.release ? { releaseId: f.release } : {}),
  ...(before !== undefined ? { before } : {}),
  limit: PAGE_SIZE,
});

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour12: false });
const isTraceId = (s: string) => /^[0-9a-f]{32}$/.test(s);

export function EventRow({ e, hive, fresh }: { e: QueenEvent; hive: string; fresh?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`ev ev--${e.severity}${fresh ? " ev--new" : ""}`} data-seq={e.seq}>
      <time dateTime={new Date(e.ts).toISOString()} title={new Date(e.ts).toLocaleString()}>{clock(e.ts)}</time>
      <i className="ev__dot" aria-hidden="true" />
      <span className="ev__type"><span className="sr-only">{e.severity} </span>{e.type}</span>
      <button type="button" className="ev__sum" style={{ all: "unset", cursor: "pointer", fontFamily: "var(--sans)", overflowWrap: "anywhere" }} aria-expanded={open} onClick={() => setOpen(!open)}>
        {e.summary}
      </button>
      <div className="ev__meta">
        <span>{e.actor}</span>
        {e.itemId && <Link to={hrefFor.item(hive, e.itemId)}>item {e.itemId}</Link>}
        {e.trainId && <span>train {e.trainId}</span>}
        {e.releaseId && <span>release {e.releaseId}</span>}
        {e.traceId && isTraceId(e.traceId) && <Link to={hrefFor.trace(hive, e.traceId)}>trace {e.traceId.slice(0, 8)}</Link>}
        <span>#{e.seq}</span>
      </div>
      {open && <pre className="ev__more">{JSON.stringify({ commandId: e.commandId, spanId: e.spanId, data: e.data, ledger: e.gitNotesPayload ?? undefined }, null, 2)}</pre>}
    </div>
  );
}

export function EventRows(props: { events: readonly QueenEvent[]; hive: string; freshAfter?: number }) {
  if (!props.events.length) return <p className="obs__empty">No events match these filters.</p>;
  return (
    <div className="ev-list" role="list" aria-label="Events, newest first">
      {props.events.map((e) => (
        <EventRow key={e.eventId} e={e} hive={props.hive} fresh={props.freshAfter !== undefined && e.seq > props.freshAfter} />
      ))}
    </div>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function EventLog(props: { hive: string; state: State }) {
  const { hive, state } = props;
  const [draft, setDraft] = useState<EventFilters>(() => (typeof window === "undefined" ? NO_FILTERS : filtersFromSearch(window.location.search)));
  const f = useDebounced(draft, 300);
  const [fetched, setFetched] = useState<QueenEvent[] | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const mounted = useRef(Date.now());
  const initialMax = useRef<number | null>(null);

  const { type, item, trace, release } = f;
  useEffect(() => {
    let live = true;
    setBusy(true);
    api.events(hive, query(f)).then(
      (rows) => {
        if (!live) return;
        setFetched(rows);
        setExhausted(rows.length < PAGE_SIZE);
        setError(null);
        setBusy(false);
        initialMax.current ??= rows.reduce((m, e) => Math.max(m, e.seq), 0);
      },
      (e: unknown) => {
        if (!live) return;
        setError(e);
        setBusy(false);
      },
    );
    return () => {
      live = false;
    };
    // minSeverity is client-side only, so it is not a refetch key.
  }, [hive, type, item, trace, release, tick]);

  const older = async () => {
    if (!fetched?.length) return;
    setBusy(true);
    try {
      const before = Math.min(...fetched.map((e) => e.seq));
      const rows = await api.events(hive, query(f, before));
      setFetched((cur) => [...(cur ?? []), ...rows]);
      setExhausted(rows.length < PAGE_SIZE);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const events = useMemo(() => mergeEvents(fetched ?? [], state.events, f, fetched !== null), [fetched, state.events, f]);
  const set = (patch: Partial<EventFilters>) => setDraft((d) => ({ ...d, ...patch }));
  const active = Object.entries(draft).some(([k, v]) => v !== NO_FILTERS[k as keyof EventFilters]);

  return (
    <div className="obs">
      <div className="obs__head">
        <div className="grow">
          <h2>Event log</h2>
          <p className="obs__sub">{events.length} shown · live from the Queen{state.events.length ? "" : " (waiting for events)"}</p>
        </div>
        <button className="btn" type="button" onClick={() => setTick((t) => t + 1)} disabled={busy}>Refresh</button>
      </div>
      <form className="ev-filters panel" role="search" aria-label="Filter events" onSubmit={(e) => e.preventDefault()}>
        <label>
          TYPE
          <select value={draft.type} onChange={(e) => set({ type: e.target.value })}>
            <option value="">all types</option>
            {TYPE_GROUPS.map((g) => (
              <optgroup key={g.prefix} label={g.prefix}>
                <option value={g.prefix}>{g.prefix}.*</option>
                {g.types.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          SEVERITY
          <select value={draft.minSeverity} onChange={(e) => set({ minSeverity: e.target.value as EventSeverity })}>
            <option value="debug">all</option>
            <option value="info">info+</option>
            <option value="warn">warn+</option>
            <option value="error">error</option>
          </select>
        </label>
        <label>ITEM<input value={draft.item} onChange={(e) => set({ item: e.target.value.trim() })} placeholder="item id" /></label>
        <label>TRACE<input value={draft.trace} onChange={(e) => set({ trace: e.target.value.trim() })} placeholder="32-hex trace id" /></label>
        <label>RELEASE<input value={draft.release} onChange={(e) => set({ release: e.target.value.trim() })} placeholder="release id" /></label>
        {active && <button className="btn" type="button" onClick={() => setDraft(NO_FILTERS)}>Clear</button>}
      </form>
      <ErrorNotice error={error} onRetry={() => setTick((t) => t + 1)} />
      <div className="panel">
        {fetched === null && !error ? <p className="obs__empty">Loading events…</p> : <EventRows events={events} hive={hive} freshAfter={initialMax.current ?? undefined} />}
        {fetched !== null && fetched.length > 0 && (
          <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center" }}>
            <button className="btn" type="button" onClick={older} disabled={busy || exhausted}>{exhausted ? "No older events" : busy ? "Loading…" : "Load older"}</button>
            <span className="obs__sub">since {new Date(mounted.current).toLocaleTimeString([], { hour12: false })} live</span>
          </div>
        )}
      </div>
    </div>
  );
}

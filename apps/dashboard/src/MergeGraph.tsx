/**
 * The merge-train graph (layout in mergeGraph.ts): main as a trunk, each BUILD
 * train a branch forking off it, each merge-queue car a node its members'
 * branches converge into, landing back on main. Inline SVG, no dependencies.
 * Clicking a car or a branch opens its payload panel (a bottom sheet on phones).
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { MergeTrain, QueenEvent } from "@queenos/queen-types";

import { api } from "./api";
import { useNow } from "./components";
import { durationText } from "./homeLogic";
import { mergeGraph, type BranchView, type CarView, type GraphEdge, type GraphNode, type MergeGraphLayout } from "./mergeGraph";
import { modelLabel } from "./models";
import type { State } from "./reducer";
import { hrefFor } from "./route";
import { Link } from "./router";
import { whoOf } from "./raceStatus";
import { itemIdOf, queueRail, recentBisects } from "./swarm";
import { isPushed, originBadge } from "./origin";
import { OriginChip } from "./shell";
import "./mergeGraph.css";

export type GraphSelection = { kind: "car" | "branch"; id: string } | null;

const short = (s?: string | null) => (s ? s.slice(0, 7) : "–");
const kb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });

const EDGE_ORDER: GraphEdge["kind"][] = ["main", "rework", "reboard", "fork", "branch", "board", "merge", "stack", "car", "bisect", "land"];

function activate(fn: () => void) {
  return {
    onClick: fn,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fn();
      }
    },
  };
}

// ── svg pieces ────────────────────────────────────────────────────────────

const Edges = memo(function Edges({ edges, onPick }: { edges: GraphEdge[]; onPick: (e: GraphEdge) => void }) {
  const sorted = useMemo(() => [...edges].sort((a, b) => EDGE_ORDER.indexOf(a.kind) - EDGE_ORDER.indexOf(b.kind)), [edges]);
  return (
    <g className="mg-edges">
      {sorted.map((e) => {
        const cls = `mg-e mg-e--${e.kind} mg-t--${e.tone}${e.dashed ? " mg-e--dashed" : ""}${e.faded ? " mg-e--faded" : ""}`;
        const pickable = e.kind !== "main" && e.trainId;
        return (
          <g key={e.id} data-edge={e.kind} data-train={e.trainId ?? undefined}>
            {pickable && <path className="mg-hit" d={e.d} onClick={() => onPick(e)} />}
            <path className={cls} d={e.d} {...(e.kind === "fork" && !e.dashed ? { pathLength: 1 } : {})} />
          </g>
        );
      })}
    </g>
  );
});

function CarNode({ car, selected, highlighted, onPick }: { car: CarView; selected: boolean; highlighted: boolean; onPick: () => void }) {
  const badges = [car.fastForward ? "⚡" : "", car.infraRetries ? `↻${car.infraRetries}` : "", car.bisectOf ? "✂" : ""].filter(Boolean).join(" ");
  const tip = `${car.label}${car.label !== car.kLabel ? ` (${car.kLabel})` : ""} · ${car.phase} · ${car.members.length} member${car.members.length === 1 ? "" : "s"}${car.fastForward ? " · fast-forward" : ""}${car.infraRetries ? ` · ${car.infraRetries} infra retr${car.infraRetries === 1 ? "y" : "ies"}` : ""}${car.reason ? ` · ${car.reason}` : ""}`;
  return (
    <g
      className={`mg-car mg-t--${car.tone}${selected ? " is-selected" : ""}${highlighted ? " is-highlighted" : ""}`}
      style={{ transform: `translate(${car.x}px, ${car.y}px)` }}
      role="button"
      tabIndex={0}
      aria-label={tip}
      data-car={car.label}
      {...activate(onPick)}
    >
      <title>{tip}</title>
      {(selected || highlighted) && <circle className="mg-car__ring" r={13} />}
      <path key={car.tone} className="mg-car__diamond" d="M0 -8L8 0L0 8L-8 0Z" />
      <text className="mg-car__label" x={10} y={-8}>
        {car.label}
        {badges && <tspan className="mg-car__badge"> {badges}</tspan>}
      </text>
    </g>
  );
}

function NodeGlyph({ n, onPickCar, onPickBranch }: { n: GraphNode; onPickCar: (id: string) => void; onPickBranch: (id: string) => void }) {
  switch (n.kind) {
    case "main":
      return (
        <g className="mg-main" style={{ transform: `translate(${n.x}px, ${n.y}px)` }} data-sha={n.sha}>
          <title>{`main@${short(n.sha)} · landed ${clock(n.at)}`}</title>
          <circle r={5} />
          {n.labelRow >= 0 && (
            <text className="mg-main__sha" y={n.labelRow === 0 ? -10 : -21} textAnchor="middle">
              {short(n.sha)}
            </text>
          )}
        </g>
      );
    case "conflict":
      return (
        <g className="mg-conflict" style={{ transform: `translate(${n.x}px, ${n.y}px)` }} role="button" tabIndex={0} aria-label={`conflict: ${n.paths.join(", ")}`} {...activate(() => (n.carId ? onPickCar(n.carId) : onPickBranch(n.trainId)))}>
          <title>{`⚠ merge conflict${n.paths.length ? ` on ${n.paths.join(", ")}` : ""}\n${n.summary}`}</title>
          <path d="M0 -7.5L7.5 5.5H-7.5Z" />
          <text y={4} textAnchor="middle">!</text>
        </g>
      );
    case "end":
      return (
        <g className={`mg-end mg-t--${n.tone}`} style={{ transform: `translate(${n.x}px, ${n.y}px)` }}>
          <path d="M-3 -3L3 3M3 -3L-3 3" />
        </g>
      );
    case "stub":
      return (
        <g className="mg-stub" style={{ transform: `translate(${n.x}px, ${n.y}px)` }}>
          <title>{n.detail}</title>
          <circle r={4} />
          <text x={-6} y={-10}>{n.label}</text>
        </g>
      );
    default:
      return null;
  }
}

function BranchLabels({ branches, selected, charW }: { branches: BranchView[]; selected: string | null; charW: number }) {
  return (
    <g className="mg-labels">
      {branches.map((b) => (
        <g key={b.trainId} className={`mg-blabel mg-t--${b.tone}${b.loser ? " mg-e--faded" : ""}${selected === b.trainId ? " is-selected" : ""}`}>
          {b.label && (
            <rect className="mg-blabel__bg" x={b.x0 + 3} y={b.y - 6} width={b.label.length * charW + 6} height={12} rx={3} />
          )}
          {b.label && (
            <text x={b.x0 + 6} y={b.y + 3.5}>
              <title>{`${b.title}${b.model ? ` · ${modelLabel(b.model)}` : ""} · ${b.tone}${b.approx ? " (time approximate)" : ""}`}</title>
              {b.label}
            </text>
          )}
          {b.infraRetries > 0 && (
            <text className="mg-blabel__retry" x={b.x1 + 4} y={b.y + 3.5}>{`↻${b.infraRetries}`}</text>
          )}
          {b.alive && b.carIds.length === 0 && <circle className="mg-head" cx={b.x1} cy={b.y} r={2.6} />}
        </g>
      ))}
    </g>
  );
}

function Svg({ layout, sel, highlight, onPick }: { layout: MergeGraphLayout; sel: GraphSelection; highlight: string | null; onPick: (s: GraphSelection) => void }) {
  const pickEdge = useCallback(
    (e: GraphEdge) => {
      if (!e.trainId) return;
      const isCar = layout.cars.some((c) => c.trainId === e.trainId) && e.kind !== "board";
      onPick({ kind: isCar ? "car" : "branch", id: e.trainId });
    },
    [layout.cars, onPick],
  );
  const bottom = layout.height - 8;
  return (
    <svg className="mg-svg" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={`Merge-train graph: ${layout.cars.length} cars, ${layout.liveBranches} live branches`}>
      <g className="mg-grid">
        {layout.ticks.map((t) => (
          <g key={t.at}>
            <line x1={t.x} x2={t.x} y1={layout.mainY + 8} y2={bottom - 12} />
            <text x={t.x} y={bottom} textAnchor="middle">{t.label}</text>
          </g>
        ))}
        {layout.breaks.map((b) => (
          <g key={b.x} className="mg-break" style={{ transform: `translate(${b.x}px, 0)` }}>
            <title>{`${durationText(b.ms)} idle, compressed`}</title>
            <text y={layout.mainY + 4} textAnchor="middle">≈</text>
            <text className="mg-break__ms" y={layout.mainY + 16} textAnchor="middle">{durationText(b.ms)}</text>
          </g>
        ))}
      </g>
      <text className="mg-trunk-label" x={8} y={layout.mainY + 4}>main</text>
      <Edges edges={layout.edges} onPick={pickEdge} />
      <g className="mg-races">
        {layout.races.map((r) => (
          <g key={r.raceId} className={`mg-race${r.decided ? " is-decided" : ""}`}>
            <title>{`best-of-${r.width} race`}</title>
            <path d={`M${r.x + 4} ${r.y0 - 5}H${r.x}V${r.y1 + 5}H${r.x + 4}`} />
            <text x={r.x - 3} y={(r.y0 + r.y1) / 2 + 3.5} textAnchor="end">{`×${r.width}`}</text>
          </g>
        ))}
      </g>
      <BranchLabels branches={layout.branches} selected={sel?.kind === "branch" ? sel.id : null} charW={layout.charW} />
      <g className="mg-nodes">
        {layout.nodes.map((n) => (n.kind === "car" ? null : <NodeGlyph key={n.id} n={n} onPickCar={(id) => onPick({ kind: "car", id })} onPickBranch={(id) => onPick({ kind: "branch", id })} />))}
        {layout.cars.map((c) => (
          <CarNode key={c.trainId} car={c} selected={sel?.kind === "car" && sel.id === c.trainId} highlighted={highlight === c.trainId} onPick={() => onPick({ kind: "car", id: c.trainId })} />
        ))}
      </g>
    </svg>
  );
}

// ── payload panel ─────────────────────────────────────────────────────────

function Score({ t }: { t: MergeTrain }) {
  const s = t.score;
  if (!s) return <span className="mg-dim">no gate score yet</span>;
  return (
    <span className="mg-score">
      <b className={s.review === "approved" ? "v--ok" : "v--na"}>{s.review}</b> · ✓{s.satisfied} ✗{s.missing} · {s.checks} check{s.checks === 1 ? "" : "s"}
    </span>
  );
}

function Paths({ paths }: { paths: string[] }) {
  if (!paths.length) return null;
  const shown = paths.slice(0, 4);
  return (
    <div className="mg-paths" title={paths.join("\n")}>
      {shown.map((p) => <code key={p}>{p}</code>)}
      {paths.length > shown.length && <span className="mg-dim">+{paths.length - shown.length}</span>}
    </div>
  );
}

function MemberRow({ state, hive, id, n, conflict }: { state: State; hive: string; id: string; n: number; conflict?: CarView["conflicts"][number] }) {
  const t = state.trains[id];
  if (!t) return <li className="mg-member"><span className="mg-member__n">{n}</span><span className="mg-dim">{id} (not in view)</span></li>;
  const itemId = itemIdOf(t) ?? null;
  const title = (itemId && state.items[itemId]?.title) || id;
  return (
    <li className={`mg-member${conflict ? " is-conflict" : ""}`}>
      <span className="mg-member__n">{conflict ? "⚠" : n}</span>
      <div className="mg-member__body">
        <div className="mg-member__title">
          {itemId ? <Link to={hrefFor.item(hive, itemId)}>{title}</Link> : <span>{title}</span>}
        </div>
        <div className="mg-member__meta">
          {isPushed(t) && <OriginChip badge={originBadge(t.origin, t.attemptId)} />}
          {t.model && <span>{modelLabel(t.model)}</span>}
          {t.score && <span>{kb(t.score.changedBytes)} · {t.score.changedFiles} file{t.score.changedFiles === 1 ? "" : "s"}</span>}
          <Score t={t} />
        </div>
        <Paths paths={t.changedPaths ?? []} />
        {conflict && <div className="mg-member__conflict">conflict ({conflict.kind}){conflict.paths.length ? `: ${conflict.paths.join(", ")}` : ""}</div>}
      </div>
    </li>
  );
}

function CarPanel({ car, layout, state, hive }: { car: CarView; layout: MergeGraphLayout; state: State; hive: string }) {
  const labelOf = (id: string | null) => (id ? (layout.cars.find((c) => c.trainId === id)?.label ?? id.slice(0, 8)) : "main");
  const firstMember = car.members.map((id) => state.trains[id]).find((t) => t?.traceId);
  const traceId = car.traceId ?? firstMember?.traceId ?? null;
  const merged = car.members.filter((m) => !car.conflicts.some((c) => c.trainId === m));
  return (
    <>
      <header className="mg-panel__head">
        <b className={`mg-pill mg-t--${car.tone}`}>◆ {car.label}</b>
        {car.label !== car.kLabel && <span className="mg-dim">{car.kLabel}</span>}
        <span className={`mg-phase mg-t--${car.tone}`}>{car.phase}</span>
        {car.fastForward && <span className="mg-badge" title="One member, its tree was already gated: the car gate was skipped">⚡ fast-forward</span>}
        {car.infraRetries > 0 && <span className="mg-badge" title="Infrastructure retries (no blame, no attempt charged)">↻ {car.infraRetries}</span>}
      </header>
      <dl className="mg-kv">
        <dt>sha</dt>
        <dd><code>{short(car.baseSha)}</code> → <code>{short(car.headSha)}</code> → <code className={car.landedSha ? "v--ok" : "mg-dim"}>{car.landedSha ? short(car.landedSha) : "not landed"}</code></dd>
        <dt>stacked on</dt>
        <dd>{labelOf(car.predecessor)}</dd>
        <dt>formed</dt>
        <dd>{clock(car.createdAt)}{car.endedAt != null && <> · ended {car.approx ? "~" : ""}{clock(car.endedAt)} ({durationText(car.endedAt - car.createdAt)})</>}</dd>
        {car.reason && (<><dt>{car.tone === "superseded" ? "superseded" : "reason"}</dt><dd className={car.tone === "superseded" ? "mg-dim" : "v--bad"}>{car.reason}</dd></>)}
        {car.bisectOf && (<><dt>bisect</dt><dd>✂ half of {labelOf(car.bisectOf)}{car.culprit ? " · culprit half" : ""}</dd></>)}
        {car.halves.length > 0 && (
          <><dt>halves</dt><dd>✂ {car.halves.map((h) => { const hc = layout.cars.find((c) => c.trainId === h); return <span key={h} className={`mg-pill mg-t--${hc?.tone ?? "merging"}`}>{labelOf(h)} {hc ? hc.phase.toLowerCase() : ""}</span>; })}</dd></>
        )}
        {traceId && (<><dt>trace</dt><dd><Link to={hrefFor.trace(hive, traceId)}>{traceId.slice(0, 8)} ▸</Link>{!car.traceId && <span className="mg-dim"> (first member)</span>}</dd></>)}
      </dl>
      <p className="mg-panel__sub">MEMBERS · merge order ({merged.length}{car.conflicts.length ? ` + ${car.conflicts.length} conflict` : ""})</p>
      <ol className="mg-members">
        {merged.map((id, i) => <MemberRow key={id} state={state} hive={hive} id={id} n={i + 1} />)}
        {car.conflicts.map((c) => <MemberRow key={c.trainId} state={state} hive={hive} id={c.trainId} n={0} conflict={c} />)}
      </ol>
    </>
  );
}

function BranchPanel({ b, layout, state, hive, onPick }: { b: BranchView; layout: MergeGraphLayout; state: State; hive: string; onPick: (s: GraphSelection) => void }) {
  const t = state.trains[b.trainId];
  const race = b.raceId ? state.races[b.raceId] : undefined;
  return (
    <>
      <header className="mg-panel__head">
        <b className={`mg-pill mg-t--${b.tone}`}>{b.winner ? "★ " : ""}{b.rework ? "↺ " : ""}branch</b>
        <span className={`mg-phase mg-t--${b.tone}`}>{b.tone}</span>
      </header>
      <div className="mg-member__title mg-panel__title">
        {b.itemId ? <Link to={hrefFor.item(hive, b.itemId)}>{b.title} ▸</Link> : b.title}
      </div>
      <dl className="mg-kv">
        <dt>origin</dt><dd><OriginChip badge={originBadge(t?.origin, t?.attemptId)} /></dd>
        {b.model && (<><dt>model</dt><dd>{modelLabel(b.model)}</dd></>)}
        <dt>forked</dt>
        <dd>{b.clippedLeft ? "before this window" : b.forkSha ? <>from main@<code>{short(b.forkSha)}</code></> : <>from main{t?.baseSha ? <> (<code>{short(t.baseSha)}</code>)</> : null}</>}{t && <> · {clock(t.createdAt)}</>}</dd>
        {t?.score && (<><dt>diff</dt><dd>{kb(t.score.changedBytes)} · {t.score.changedFiles} files</dd></>)}
        {t && (<><dt>gate</dt><dd><Score t={t} /></dd></>)}
        {race && (<><dt>race</dt><dd>best-of-{race.width} · candidate {b.candidate ?? "?"}{b.winner ? " · ★ won" : b.loser ? " · lost" : ""}{race.reason ? <div className="mg-dim">{race.reason}</div> : null}</dd></>)}
        {t?.conflict && (<><dt>conflict</dt><dd className="v--bad">{t.conflict.kind}: {t.conflict.paths.join(", ")}</dd></>)}
        {t?.reason && (<><dt>reason</dt><dd className="mg-dim">{t.reason}</dd></>)}
        {b.infraRetries > 0 && (<><dt>infra</dt><dd>↻ {b.infraRetries} retr{b.infraRetries === 1 ? "y" : "ies"}</dd></>)}
        {b.carIds.length > 0 && (
          <><dt>cars</dt><dd>{b.carIds.map((id) => { const c = layout.cars.find((x) => x.trainId === id); return <button key={id} type="button" className={`mg-pill mg-t--${c?.tone ?? "merging"}`} onClick={() => onPick({ kind: "car", id })}>◆ {c?.label ?? id.slice(0, 8)}</button>; })}</dd></>
        )}
        {t?.traceId && (<><dt>trace</dt><dd><Link to={hrefFor.trace(hive, t.traceId)}>{t.traceId.slice(0, 8)} ▸</Link></dd></>)}
      </dl>
      <Paths paths={t?.changedPaths ?? []} />
    </>
  );
}

function Panel({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <aside className="mg-panel" aria-label="Car payload">
      <button type="button" className="mg-panel__close" aria-label="Close" onClick={onClose}>×</button>
      {children}
    </aside>
  );
}

// ── the component ─────────────────────────────────────────────────────────

export interface MergeGraphProps {
  state: State;
  hive: string;
  /** Window: 30 min on the status home, 24 h on the queue page. */
  spanMs: number;
  density?: "compact" | "full";
  /** A car to ring and scroll into view (the queue table's selected row). */
  highlight?: string | null;
  /** Fixed clock (tests); live otherwise. */
  now?: number;
  /** A header drawn from the layout (e.g. "N landed" counted over the same window as the graph). */
  head?: (layout: MergeGraphLayout) => ReactNode;
}

export function MergeGraph({ state, hive, spanMs, density = "full", highlight = null, now: fixedNow, head }: MergeGraphProps) {
  const liveNow = useNow(density === "compact" ? 5000 : 10_000);
  const now = fixedNow ?? liveNow;
  const { trains, trainOrder, items, races, landed, trainTimes } = state;
  // The snapshot carries only the newest events: load the queue and train history once, so a reload still
  // knows when each car formed, stacked, landed or was ejected.
  const [history, setHistory] = useState<QueenEvent[]>([]);
  useEffect(() => {
    let live = true;
    Promise.all([api.events(hive, { typePrefix: "queue", limit: 500 }), api.events(hive, { typePrefix: "train", limit: 500 })])
      .then(([q, t]) => live && setHistory([...q, ...t]))
      .catch(() => undefined); // live frames still draw the graph
    return () => {
      live = false;
    };
  }, [hive]);
  const events = useMemo(() => {
    if (!history.length) return state.events;
    const seen = new Set(state.events.map((e) => e.eventId));
    return [...history.filter((e) => !seen.has(e.eventId)), ...state.events].sort((a, b) => a.seq - b.seq);
  }, [history, state.events]);
  // The newest moment the state knows about: a fresh frame moves the right edge at once, between clock ticks.
  const latest = useMemo(() => {
    let m = 0;
    for (const id of trainOrder) m = Math.max(m, trains[id]?.createdAt ?? 0, trainTimes[id]?.phaseAt ?? 0);
    return m;
  }, [trains, trainOrder, trainTimes]);
  const frameNow = fixedNow ?? Math.max(now, latest);
  const box = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setBoxW(Math.floor(el.clientWidth / 40) * 40)); // coarse: no relayout per pixel
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const layout = useMemo(
    () => mergeGraph({ trains, trainOrder, items, races, events, landed, trainTimes }, { now: frameNow, spanMs, density, fitWidth: boxW }),
    [trains, trainOrder, items, races, events, landed, trainTimes, frameNow, spanMs, density, boxW],
  );
  const [sel, setSel] = useState<GraphSelection>(null);
  const close = useCallback(() => setSel(null), []);
  const atRight = useRef(true);

  // Stick to the right edge (now) while the viewer is there.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && atRight.current) el.scrollLeft = el.scrollWidth;
  }, [layout.width]);
  const onScroll = () => {
    const el = box.current;
    if (el) atRight.current = el.scrollLeft + el.clientWidth >= el.scrollWidth - 24;
  };
  // Bring a highlighted car into view.
  useEffect(() => {
    const el = box.current;
    const car = highlight ? layout.cars.find((c) => c.trainId === highlight) : undefined;
    if (!el || !car) return;
    el.scrollTo({ left: Math.max(0, car.x - el.clientWidth / 2), behavior: "smooth" });
    atRight.current = false;
  }, [highlight]);

  const selCar = sel?.kind === "car" ? layout.cars.find((c) => c.trainId === sel.id) : undefined;
  const selBranch = sel?.kind === "branch" ? layout.branches.find((b) => b.trainId === sel.id) : undefined;
  const empty = layout.cars.length === 0 && layout.branches.length === 0;

  return (
    <>
    {head?.(layout)}
    <div className={`mg mg--${density}`}>
      <div className="mg-box" ref={box} onScroll={onScroll}>
        {empty ? <p className="floor__empty mg-empty">No branches or cars in this window yet.</p> : <Svg layout={layout} sel={sel} highlight={highlight} onPick={setSel} />}
      </div>
      <Legend layout={layout} />
      {selCar && <Panel onClose={close}><CarPanel car={selCar} layout={layout} state={state} hive={hive} /></Panel>}
      {selBranch && <Panel onClose={close}><BranchPanel b={selBranch} layout={layout} state={state} hive={hive} onPick={setSel} /></Panel>}
    </div>
    </>
  );
}

function Legend({ layout }: { layout: MergeGraphLayout }) {
  return (
    <div className="mg-legend" aria-hidden="true">
      {(["building", "deploying", "gating", "passed", "racing", "merged", "ejected"] as const).map((t) => (
        <span key={t} className={`mg-key mg-t--${t}`}><i />{t}</span>
      ))}
      <span className="mg-key"><b className="mg-glyph">◆</b>car</span>
      <span className="mg-key"><b className="mg-glyph">⚡</b>fast-forward</span>
      <span className="mg-key"><b className="mg-glyph mg-glyph--warn">⚠</b>conflict</span>
      <span className="mg-key"><b className="mg-glyph">✂</b>bisect</span>
      <span className="mg-key"><b className="mg-glyph">↻</b>infra retry</span>
      {layout.breaks.length > 0 && <span className="mg-key"><b className="mg-glyph">≈</b>idle time compressed</span>}
    </div>
  );
}

export const STRIP_SPAN_MS = 30 * 60_000;

/**
 * The home's MERGE TREE panel (dashboard redesign §3.2 item 3): the last 30 minutes of the graph (always drawn, the demo's
 * talking point), the newest commit on main, and a CARS sub-section with the current train ("No cars in line" when empty).
 * "N landed" counts landings inside the same 30-minute window the graph draws (not the session's total).
 */
export function MergeTreePanel({ state, hive, now }: { state: State; hive: string; now?: number }) {
  const rail = useMemo(() => queueRail(state), [state]);
  const bisected = useMemo(() => new Set(recentBisects(state, 5).map((b) => b.trainId)), [state]);
  const main = rail.main;
  return (
    <section className="panel mtree" aria-label="Merge tree">
      <MergeGraph
        state={state}
        hive={hive}
        spanMs={STRIP_SPAN_MS}
        density="compact"
        now={now}
        head={(l) => (
          <div className="mtree__head">
            <h3 className="eyebrow">MERGE TREE</h3>
            {main && <code key={main.sha} className="mtree__landed" title={`train ${main.trainId}`}>main ← {main.sha.slice(0, 7)}</code>}
            <Link to={hrefFor.queue(hive)} className="mq__meta">{l.landedInWindow} landed in 30 min · queue page ▸</Link>
          </div>
        )}
      />
      <div className="mtree__cars" aria-label="Cars">
        <p className="eyebrow">CARS</p>
        {rail.cars.length === 0 ? (
          <p className="mtree__empty sh-muted">No cars in line</p>
        ) : (
          <ul className="mtree__list">
            {rail.cars.map((c) => (
              <li key={c.train.trainId} className={`mtree__car mtree__car--${c.phase.toLowerCase()}${bisected.has(c.train.trainId) ? " mtree__car--bisect" : ""}`}>
                <b className="mtree__car-label">{c.label}</b>
                <span className="chip chip--sm mtree__phase">{c.phase.toLowerCase()}</span>
                <span className="mtree__members">
                  {c.members.map((m) => {
                    const t = state.trains[m.trainId];
                    const who = t ? whoOf(t).who : m.title;
                    return m.itemId ? <Link key={m.trainId} to={hrefFor.item(hive, m.itemId)} title={m.title}>{who}</Link> : <span key={m.trainId} title={m.title}>{who}</span>;
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

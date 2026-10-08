import { Fragment, useMemo, useState } from "react";

import { MergeGraph } from "./MergeGraph.tsx";
import type { MergeTrain } from "@queenos/queen-types";
import { useNow } from "./components";
import { Link } from "./router";
import { hrefFor } from "./route";
import type { State } from "./reducer";
import { isQueueTrain } from "./swarm";
import { isPushed, originBadge } from "./origin";
import { OriginChip } from "./shell";
import "./swarm.css";

const DAY = 24 * 3600_000;
const short = (s?: string | null) => (s ? s.slice(0, 7) : "-");
const dur = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

function verdict(t: MergeTrain): { text: string; cls: string } {
  if (t.status === "EJECTED") return { text: t.reason ?? "failed", cls: "v--bad" };
  if (t.score) return { text: `${t.score.review} · ${t.score.checks} checks`, cls: "v--ok" };
  return { text: t.status === "MERGED" ? "passed" : "pending", cls: "v--na" };
}

/** Bisect compositions recorded on `queue.bisect` events for this car. */
function halvesFor(state: State, carId: string): string[][] {
  const e = state.events.find((x) => x.type === "queue.bisect" && x.trainId === carId);
  const h = e?.data?.halves;
  return Array.isArray(h) ? h.map((x) => (Array.isArray(x) ? x.filter((y): y is string => typeof y === "string") : [])) : [];
}

function CarDetail({ car, state, hive }: { car: MergeTrain; state: State; hive: string }) {
  const halves = halvesFor(state, car.trainId);
  const names = (ids: string[]) => ids.map((id) => state.trains[id]?.trainId ?? id).join(", ");
  return (
    <dl>
      <dt>merged order</dt>
      <dd>
        {(car.members ?? []).length === 0
          ? "-"
          : (car.members ?? []).map((id, i) => (
              <Fragment key={id}>
                {i > 0 && " → "}
                {id} <OriginChip badge={originBadge(state.trains[id]?.origin)} />
              </Fragment>
            ))}
      </dd>
      <dt>conflicts</dt>
      <dd>
        {car.conflict ? `${car.conflict.kind}: ${car.conflict.paths.join(", ")} (${car.conflict.summary})` : "none"}
      </dd>
      {car.reason && (<><dt>reason</dt><dd>{car.reason}</dd></>)}
      {car.traceId && (<><dt>trace</dt><dd><a href={hrefFor.trace(hive, car.traceId)}>{car.traceId.slice(0, 8)} ▸</a></dd></>)}
      {halves.length > 0 && (
        <>
          <dt>bisect</dt>
          <dd>
            <ul className="qtree">
              {halves.map((h, i) => <li key={i}>half {i + 1}: [{names(h)}]</li>)}
            </ul>
          </dd>
        </>
      )}
    </dl>
  );
}

export function QueuePage({ hive, state }: { hive: string; state: State }) {
  const now = useNow(10_000);
  const [open, setOpen] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const { trains, trainOrder } = state;
  const cars = useMemo(() => {
    const all = trainOrder.map((id) => trains[id]!).filter(isQueueTrain).sort((a, b) => a.createdAt - b.createdAt || a.trainId.localeCompare(b.trainId));
    return all.map((t, i) => ({ t, label: `K${i + 1}` })).reverse();
  }, [trains, trainOrder]);
  const recent = cars.filter(({ t }) => now - t.createdAt <= DAY || (t.status !== "MERGED" && t.status !== "EJECTED"));

  return (
    <div className="qpage">
        <Link to={hrefFor.status(hive)} className="mq__meta">◂ {hive} / merge queue</Link>
        <section className="mq" aria-label="Merge train graph">
          <MergeGraph
            state={state}
            hive={hive}
            spanMs={DAY}
            density="full"
            highlight={highlight}
            head={(l) => <div className="mq__head"><h3 className="eyebrow">MERGE TRAIN · LAST 24H</h3><span className="mq__meta">{l.landedInWindow} landed in 24h · tap a car for its payload</span></div>}
          />
        </section>
        <section className="mq" aria-label="Cars, last 24 hours">
          <div className="mq__head"><h3 className="eyebrow">CARS · LAST 24H</h3><span className="mq__meta">{recent.length} cars</span></div>
          {recent.length === 0 ? (
            <p className="floor__empty">No cars yet.</p>
          ) : (
            <div className="qtable-wrap">
              <table className="qtable">
                <thead>
                  <tr><th>car</th><th>members</th><th>base → head</th><th>merge</th><th>gate</th><th>fast path</th><th>landed</th><th>wait</th></tr>
                </thead>
                <tbody>
                  {recent.map(({ t, label }) => {
                    const v = verdict(t);
                    const isOpen = open === t.trainId;
                    return (
                      <Fragment key={t.trainId}>
                        <tr className={`qrow${highlight === t.trainId ? " is-highlighted" : ""}`} onClick={() => setHighlight(t.trainId)}>
                          <td>
                            <button className="linkish" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : t.trainId)}>{isOpen ? "▾" : "▸"} {label}</button>
                          </td>
                          <td>
                            {(t.members ?? []).length}{" "}
                            {(t.members ?? []).map((m) => state.trains[m]).filter(isPushed).map((m) => <OriginChip key={m!.trainId} badge={originBadge(m!.origin)} />)}
                          </td>
                          <td>{short(t.baseSha)} → {short(t.headSha)}</td>
                          <td>{t.status}</td>
                          <td className={v.cls}>{v.text}</td>
                          <td>{(t.members ?? []).length === 1 && t.score?.checks === 0 ? "⚡ yes" : "no"}</td>
                          <td>{short(t.landedSha)}</td>
                          <td>{t.status === "MERGED" || t.status === "EJECTED" ? "-" : dur(Math.max(0, now - t.createdAt))}</td>
                        </tr>
                        {isOpen && (
                          <tr className="qdetail"><td colSpan={8}><CarDetail car={t} state={state} hive={hive} /></td></tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
  );
}

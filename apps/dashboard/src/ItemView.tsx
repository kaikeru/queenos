import { useMemo, useState } from "react";
import type { MergeTrain, QueenEvent, WorkItem } from "@queenos/queen-types";
import { MemoryRecall } from "./components";
import { api, errorMessage, type ItemDetail } from "./api";
import { useResource } from "./hooks";
import { attemptsOf, durationText, gateText, liveTrainsOf, validItemActions, type Attempt } from "./homeLogic";
import { relativeTime } from "./lanes";
import type { State } from "./reducer";
import { hrefFor } from "./route";
import { Link } from "./router";
import { ErrorNotice, ItemChip, OriginChip } from "./shell";
import { itemOrigin, originBadge } from "./origin";
import { itemSubState } from "./swarm";

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });

export function ItemView({ hive, itemId, state }: { hive: string; itemId: string; state: State }) {
  const live = state.items[itemId] ?? null;
  // Refetch whenever the live item changes (status, attempts, updatedAt) so the page tracks the swarm.
  const stamp = `${live?.status ?? ""}:${live?.updatedAt ?? 0}:${live?.attempts ?? 0}`;
  const detail = useResource(() => api.item(hive, itemId), `${hive}/${itemId}/${stamp}`);
  const events = useResource(() => api.events(hive, { itemId, limit: 40 }), `${hive}/${itemId}/events/${stamp}`);

  const d: ItemDetail | null = detail.data;
  const item: WorkItem | null = live ?? d?.item ?? null;
  const trains = useMemo<MergeTrain[]>(() => (d?.trains.length ? d.trains : liveTrainsOf(state.trains, state.trainOrder, itemId)), [d, state.trains, state.trainOrder, itemId]);
  const attempts = useMemo(() => attemptsOf(trains, d?.races ?? Object.values(state.races).filter((r) => r.itemId === itemId)), [trains, d, state.races, itemId]);

  if (!item) {
    if (detail.error) return <ErrorNotice error={detail.error} onRetry={detail.reload} />;
    return <p className="sh-muted">Loading item…</p>;
  }
  const sub = itemSubState(state, item);
  const parent = item.parentId ? (state.items[item.parentId] ?? null) : null;
  const children = d?.children ?? Object.values(state.items).filter((i) => i.parentId === item.itemId);
  const release = d?.release ?? (item.releaseId ? (state.releases[item.releaseId] ?? null) : null);
  const escs = (d?.escalations ?? Object.values(state.escalations).filter((e) => e.subject.id === item.itemId)).filter((e) => e.status === "OPEN");
  const memories = [...trains].reverse().find((t) => t.memories?.length)?.memories ?? [];
  const claims = trains.filter((t) => t.status !== "EJECTED" && t.status !== "MERGED").flatMap((t) => t.changedPaths ?? []);
  const conflictPaths = new Set(trains.flatMap((t) => (t.conflict ? t.conflict.paths : [])));

  return (
    <div className="item">
      <section className="panel item__head">
        <p className="sh-muted"><Link to={hrefFor.status(hive)}>◂ {hive}</Link> / {item.kind} #{item.itemId}</p>
        <h2>{item.title}</h2>
        <p className="item__badges">
          <span className="chip">P{item.priority}</span> <ItemChip status={item.status} sub={sub} /> <OriginChip badge={itemOrigin(item, trains)} />
          {item.difficulty === "hard" && <span className="chip">HARD</span>}
          {item.bestOf && <span className="chip">best-of-{item.bestOf}</span>}
          <Link className="sh-link" to={hrefFor.trace(hive, item.traceId)}>trace {item.traceId.slice(0, 8)}… ▸</Link>
        </p>
        {item.body && <p className="item__body">{item.body}</p>}
        <dl className="item__meta">
          <div><dt>source</dt><dd>{item.source.kind} · {item.source.actor}{parent ? <> (goal <Link to={hrefFor.item(hive, parent.itemId)}>"{parent.title}"</Link>)</> : null}</dd></div>
          <div>
            <dt>depends on</dt>
            <dd>
              {item.dependsOn.length
                ? item.dependsOn.map((id, i) => (
                    <span key={id}>{i > 0 && ", "}<Link to={hrefFor.item(hive, id)}>{state.items[id]?.title ?? id}</Link></span>
                  ))
                : "–"}
            </dd>
          </div>
          <div><dt>paths</dt><dd>{item.paths.length ? `${item.paths.join(" · ")} (predicted)` : "unknown"}</dd></div>
          <div>
            <dt>claims</dt>
            <dd>
              {claims.length
                ? [...new Set(claims)].map((p) => <code key={p} className={conflictPaths.has(p) ? "item__conflict" : ""}>{p}{conflictPaths.has(p) ? " (conflict)" : ""} </code>)
                : "–"}
            </dd>
          </div>
          <div><dt>attempts</dt><dd>{item.attempts} gate · {item.conflicts} conflict reworks</dd></div>
          {item.waitReason && <div><dt>waiting</dt><dd>{item.waitReason}</dd></div>}
          {item.blockedReason && <div><dt>blocked</dt><dd>{item.blockedReason}</dd></div>}
          {item.duplicateOf && <div><dt>duplicate of</dt><dd><Link to={hrefFor.item(hive, item.duplicateOf)}>{state.items[item.duplicateOf]?.title ?? item.duplicateOf}</Link></dd></div>}
        </dl>
        {item.acceptance.length > 0 && (
          <div className="item__acc">
            <p className="eyebrow">ACCEPTANCE</p>
            <ul>{item.acceptance.map((a, i) => <li key={i}>☐ {a}</li>)}</ul>
          </div>
        )}
        <ItemActions hive={hive} item={item} onDone={() => detail.reload()} />
        {escs.map((e) => (
          <p key={e.escalationId} className="sh-err">⚠ {e.reason}: {e.summary} <Link to={hrefFor.status(hive)}>resolve on status ▸</Link></p>
        ))}
        {memories.length > 0 && <MemoryRecall memories={memories} />}
      </section>

      {Boolean(detail.error) && !d && <ErrorNotice error={detail.error} onRetry={detail.reload} />}

      {children.length > 0 && (
        <section className="panel">
          <p className="eyebrow">SUB-ITEMS ({children.length})</p>
          <ul className="sh-tree">
            {children.map((c) => (
              <li key={c.itemId} className="sh-row">
                <span className={`sh-kind sh-kind--${c.kind}`}>{c.kind}</span>
                <Link className="sh-row__title" to={hrefFor.item(hive, c.itemId)}>{c.title}</Link>
                <ItemChip status={state.items[c.itemId]?.status ?? c.status} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel">
        <p className="eyebrow">ATTEMPTS ({attempts.length})</p>
        {attempts.length === 0 ? <p className="sh-muted">No build has started yet.</p> : <ul className="item__attempts">{attempts.map((a) => <AttemptRow key={a.train.trainId} a={a} state={state} />)}</ul>}
      </section>

      <section className="panel">
        <p className="eyebrow">RELEASE</p>
        {release ? (
          <p>
            <b>{release.releaseId.slice(0, 8)}</b> · {release.phase}
            {release.canaryPercent != null && ` · canary ${release.canaryPercent}%`}
            {release.prodUrl && <> · <a href={release.prodUrl} target="_blank" rel="noreferrer">prod ▸</a></>}{" "}
            <Link className="sh-link" to={hrefFor.lanes(hive)}>lanes ▸</Link>
          </p>
        ) : (
          <p className="sh-muted">none yet</p>
        )}
      </section>

      <section className="panel">
        <p className="eyebrow">EVENTS (ITEM)</p>
        {events.data && events.data.length > 0 ? (
          <ol className="item__events">
            {events.data.slice(0, 12).map((e: QueenEvent) => (
              <li key={e.eventId}><time>{clock(e.ts)}</time> <b>{e.type}</b> <span className="sh-muted">{e.summary}</span></li>
            ))}
          </ol>
        ) : (
          <p className="sh-muted">{events.loading ? "Loading…" : "No events."}</p>
        )}
        <p><Link className="sh-link" to={hrefFor.events(hive)}>all events ▸</Link></p>
      </section>
    </div>
  );
}

function ItemActions({ hive, item, onDone }: { hive: string; item: WorkItem; onDone: () => void }) {
  const actions = validItemActions(item);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (actions.length === 0) return null;
  const run = async (action: (typeof actions)[number]) => {
    setBusy(action);
    setErr(null);
    try {
      await api.itemAction(hive, item.itemId, { action });
      onDone();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="item__actions">
      {actions.map((a) => (
        <button key={a} type="button" className={`btn${a === "cancel" ? " btn--danger" : " btn--primary"}`} disabled={busy !== null} onClick={() => void run(a)}>
          {busy === a ? "…" : a === "not_duplicate" ? "Not a duplicate" : a === "retry" ? "Retry" : "Cancel item"}
        </button>
      ))}
      {err && <span className="sh-err" role="alert">{err}</span>}
    </div>
  );
}

function AttemptRow({ a, state }: { a: Attempt; state: State }) {
  const t = state.trains[a.train.trainId] ?? a.train;
  const gate = gateText(t);
  const car = t.carId ? state.trains[t.carId] : null;
  const verdict = t.raceOutcome ?? null;
  return (
    <li className={`item__attempt${a.winner ? " item__attempt--winner" : ""}`}>
      <p>
        <b>#{a.n} {a.kind}{a.kind === "RACE" ? ` c${(t.candidate ?? 0) + 1}` : ""}</b> <OriginChip badge={originBadge(t.origin)} />{" "}
        {(t.origin?.kind ?? "drone") === "drone" && <span className="sh-muted">{t.model ?? "model pending"} </span>}
        <span className={`chip chip--${t.status.toLowerCase()}`}>{t.phase ?? t.status}</span>
        {a.winner && <span className="item__star" title={a.race?.reason ?? "winner"}> ★ winner</span>}
        {verdict && !a.winner && <span className="sh-muted"> {verdict}</span>}
      </p>
      <p className="sh-muted">
        {gate ? `${gate}${t.score?.review === "approved" ? " · reviewed" : ""}` : "no gate result yet"}
        {car ? ` · boarded car ${car.trainId.slice(0, 6)}` : ""}
        {t.landedSha ? ` · landed ${t.landedSha.slice(0, 7)}` : ""}
        {t.status === "BUILDING" || t.status === "TESTING" ? ` · ${durationText(Date.now() - t.createdAt)}` : ` · ${relativeTime(t.createdAt, Date.now())}`}
      </p>
      {t.conflict && <p className="item__conflict">⚡ conflict on {t.conflict.paths.join(", ") || "paths"} ({t.conflict.kind}): {t.conflict.summary}</p>}
      {t.waitForCarSeq != null && <p className="sh-muted">waiting for car K{t.waitForCarSeq} before re-forking main</p>}
      {t.status === "EJECTED" && (t.summary || t.reason) && <p className="item__summary">{t.summary ?? t.reason}</p>}
      {a.winner && a.race?.reason && <p className="sh-muted">ranking: {a.race.reason}</p>}
    </li>
  );
}

import { useEffect, useMemo, useState } from "react";
import { TERMINAL_WORK_STATUSES, type WorkItem } from "@queenos/queen-types";

import { api, errorMessage } from "./api";
import { useNow } from "./components";
import { useResource } from "./hooks";
import { isExternal, validItemActions } from "./homeLogic";
import { itemOrigin } from "./origin";
import { CopyButton } from "./PushCode";
import { RaceCard } from "./RaceCard";
import { entryState } from "./raceLogic";
import { cardItems, cardSummary, pushCommand, rootOf, withDetail } from "./raceStatus";
import type { State } from "./reducer";
import { hrefFor } from "./route";
import { Link } from "./router";
import { ErrorNotice, OriginChip } from "./shell";
import { raceView } from "./swarm";

/**
 * The goal page (spec §4): `/items/<id>` resolves `<id>` to its root and shows the root's header, one race card per
 * child (one for a loose item), and the release line. A child id highlights and scrolls to its card.
 */
export function GoalPage({ hive, itemId, state, now: nowProp }: { hive: string; itemId: string; state: State; now?: number }) {
  const tick = useNow(1000);
  const now = nowProp ?? tick;
  const known = rootOf(state.items, itemId);
  // A deep link to an item the live state does not hold: fetch it to learn its root.
  const asked = useResource(() => (known ? Promise.resolve(null) : api.item(hive, itemId)), `${hive}/${itemId}/${known ? "live" : "rest"}`);
  const rootId = known?.itemId ?? asked.data?.item.rootId ?? null;
  const live = rootId ? (state.items[rootId] ?? null) : null;
  const detail = useResource(() => (rootId ? api.item(hive, rootId) : Promise.resolve(null)), `${hive}/${rootId ?? "-"}/${live?.status ?? ""}:${live?.updatedAt ?? 0}`);
  const slice = useMemo(() => withDetail(state, detail.data ?? asked.data), [state, detail.data, asked.data]);
  const root = rootId ? (slice.items[rootId] ?? null) : null;
  const cards = useMemo(() => (root ? cardItems(slice, root).map((i) => cardSummary(slice, i, now)) : []), [slice, root, now]);

  useEffect(() => {
    if (itemId !== rootId) document.getElementById(`card-${itemId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [itemId, rootId, cards.length]);

  if (!root) {
    const error = asked.error ?? detail.error;
    if (error) return <ErrorNotice error={error} onRetry={() => { asked.reload(); detail.reload(); }} />;
    return (
      <div className="gp" aria-busy="true">
        <div className="skel skel--card" />
        <div className="skel skel--card" />
      </div>
    );
  }

  const reload = () => detail.reload();
  const trains = cards.flatMap((c) => c.trains);
  const releaseId = [root, ...cards.map((c) => c.item)].map((i) => i.releaseId).find(Boolean) ?? null;
  const release = (releaseId ? state.releases[releaseId] : null) ?? detail.data?.release ?? null;
  const ids = new Set([root.itemId, ...cards.map((c) => c.item.itemId)]);
  const escs = Object.values(state.escalations).filter((e) => e.status === "OPEN" && ids.has(e.subject.id));
  const open = root.status !== "LANDED" && !(TERMINAL_WORK_STATUSES as readonly string[]).includes(root.status);

  return (
    <div className="gp">
      <section className="panel gp__head">
        <p className="gp__crumbs">
          <Link to={hrefFor.status(hive)}>◂ {hive}</Link> / {root.kind} “{root.title}”
          <Link className="sh-link gp__trace" to={hrefFor.trace(hive, root.traceId)}>trace ▸</Link>
        </p>
        <h2 className="gp__title">{root.title}</h2>
        {root.body && <p className="gp__body">{root.body}</p>}
        <p className="gp__chips">
          <OriginChip badge={itemOrigin(root, trains)} />
          {root.judge === "human" ? <span className="chip" title="A human picks the winner">you pick</span> : <span className="chip">auto judge</span>}
          <span className="chip">P{root.priority}</span>
        </p>
        {root.acceptance.length > 0 && <ul className="gp__acc">{root.acceptance.map((a, i) => <li key={i}>☐ {a}</li>)}</ul>}
        {isExternal(state.hive) && open && (
          <div className="gp__push push__cmd" aria-label="Push command">
            <pre><code>$ {pushCommand(root)}</code></pre>
            <CopyButton text={pushCommand(root)} label="Copy push command" />
          </div>
        )}
        <ItemActions hive={hive} item={root} onDone={reload} />
        {escs.map((e) => (
          <p key={e.escalationId} className="gp__esc sh-err">⚠ {e.reason}: {e.summary} <Link to={hrefFor.status(hive)}>resolve on status ▸</Link></p>
        ))}
      </section>

      {Boolean(detail.error) && !detail.data && <ErrorNotice error={detail.error} onRetry={reload} />}

      <div className="gp__cards">
        {cards.map((c) => {
          const entries = c.race && entryState(c.race, now)?.kind === "open" ? raceView(slice, c.race.raceId, now) : null;
          return <RaceCard key={c.item.itemId} hive={hive} card={c} entries={entries} highlight={c.item.itemId === itemId && itemId !== root.itemId} now={now} onChanged={reload} />;
        })}
      </div>

      <section className="panel gp__release" aria-label="Release">
        <p className="eyebrow">RELEASE</p>
        {release ? (
          <p>
            <code>{release.releaseId.slice(0, 8)}</code> · {release.phase.toLowerCase()}
            {release.canaryPercent != null && ` · canary ${release.canaryPercent}%`}
            {release.prodUrl && <> · <a href={release.prodUrl} target="_blank" rel="noreferrer">prod ▸</a></>}
          </p>
        ) : (
          <p className="sh-muted">none yet</p>
        )}
      </section>
    </div>
  );
}

/** Retry / Cancel / Not a duplicate, only where valid for the root's status (moved from ItemView). */
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
    <div className="gp__actions">
      {actions.map((a) => (
        <button key={a} type="button" className={`btn${a === "cancel" ? " btn--danger" : " btn--primary"}`} disabled={busy !== null} onClick={() => void run(a)}>
          {busy === a ? "…" : a === "not_duplicate" ? "Not a duplicate" : a === "retry" ? "Retry" : "Cancel"}
        </button>
      ))}
      {err && <span className="sh-err" role="alert">{err}</span>}
    </div>
  );
}

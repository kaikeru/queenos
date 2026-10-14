import { useState } from "react";
import type { QueenEvent } from "@queenos/queen-types";

import { api } from "./api";
import { MemoryRecall } from "./components";
import { useResource } from "./hooks";
import { attemptsOf, durationText, gateText, type Attempt } from "./homeLogic";
import { relativeTime } from "./lanes";
import { RaceEntries } from "./RaceEntries";
import { CandidateActions, RejectAll } from "./RacePick";
import { attemptLabel, candChipClass, raceChipClass, type CardSummary } from "./raceStatus";
import type { RaceView } from "./swarm";

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });

/**
 * One race card on the goal page (spec §4.3): the item's title and race chip, one row per contributor's current head
 * (verdict chip, preview link, Pick / Reject while PICKING), Reject all / End entries now, and collapsed details.
 */
export function RaceCard({ hive, card, entries, highlight = false, now, onChanged }: { hive: string; card: CardSummary; entries: RaceView | null; highlight?: boolean; now: number; onChanged?: () => void }) {
  const { item, race, status, heads } = card;
  const [open, setOpen] = useState(false);
  // An external item no one pushed to yet (or a race whose entries have not arrived): say where agents push.
  const waiting = heads.length === 0 && (status.kind === "awaiting" || status.kind === "racing");
  return (
    <section id={`card-${item.itemId}`} className={`panel rc rc--${status.tone}${highlight ? " rc--highlight" : ""}`} aria-label={`Race for ${item.title}`} data-item={item.itemId}>
      <header className="rc__head">
        <h3 className="rc__title">▸ {item.title}</h3>
        <span className={raceChipClass(status)}>{status.text}</span>
      </header>
      {heads.length > 0 && (
        <ul className="rc__rows">
          {heads.map((h) => (
            <li key={h.train.trainId} className={`cand cand--${h.status.kind}`}>
              <span className="cand__who" title={h.origin.title}>{h.who}</span>
              {h.claim && <span className="cand__claim sh-muted">claims {h.claim}</span>}
              <span className={candChipClass(h.status)}>{h.status.text}</span>
              {h.previewUrl && <a className="cand__preview sh-link" href={h.previewUrl} target="_blank" rel="noreferrer">preview ▸</a>}
              {h.pickable && race && <CandidateActions hive={hive} raceId={race.raceId} trainId={h.train.trainId} tag={h.tag} compact onChanged={onChanged} />}
            </li>
          ))}
        </ul>
      )}
      {waiting && (
        <p className="rc__empty sh-muted">
          No candidates yet. Agents push to <code>{`item/${item.itemId}/<your-agent-name>`}</code>
        </p>
      )}
      <div className="rc__actions">
        {race?.state === "PICKING" && <RejectAll hive={hive} raceId={race.raceId} onChanged={onChanged} />}
        {entries && <RaceEntries hive={hive} view={entries} now={now} onChanged={onChanged} />}
      </div>
      <details className="rc__details" onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>details (claims, history, memories, events)</summary>
        {open && <CardDetails hive={hive} card={card} now={now} />}
      </details>
    </section>
  );
}

/** Claims and conflicts, attempt history (old heads and older races too), memories, the last 12 events. Mounted when opened. */
function CardDetails({ hive, card, now }: { hive: string; card: CardSummary; now: number }) {
  const { item, race, olderRaces, trains, old } = card;
  const events = useResource(() => api.events(hive, { itemId: item.itemId, limit: 12 }), `${hive}/${item.itemId}/events/${item.updatedAt}`);
  const races = race ? [race, ...olderRaces] : olderRaces;
  const attempts = attemptsOf(trains, races);
  const oldIds = new Set(old.map((t) => t.trainId));
  const claims = [...new Set(trains.filter((t) => t.status !== "EJECTED" && t.status !== "MERGED").flatMap((t) => t.changedPaths ?? []))];
  const conflicts = new Set(trains.flatMap((t) => (t.conflict ? t.conflict.paths : [])));
  const memories = [...trains].reverse().find((t) => t.memories?.length)?.memories ?? [];
  return (
    <div className="rc__more">
      <p className="rc__claims">
        <b>claims</b>{" "}
        {claims.length ? claims.map((p) => <code key={p} className={conflicts.has(p) ? "item__conflict" : ""}>{p}{conflicts.has(p) ? " (conflict)" : ""} </code>) : <span className="sh-muted">none</span>}
      </p>
      {olderRaces.length > 0 && (
        <p className="rc__races sh-muted">earlier races: {olderRaces.map((r) => `${r.raceId.slice(0, 6)} ${r.state.toLowerCase()}`).join(" · ")}</p>
      )}
      {attempts.length === 0 ? <p className="sh-muted">No attempts yet.</p> : <ul className="rc__history">{attempts.map((a) => <AttemptRow key={a.train.trainId} a={a} old={oldIds.has(a.train.trainId)} now={now} />)}</ul>}
      {memories.length > 0 && <MemoryRecall memories={memories} />}
      {events.data && events.data.length > 0 ? (
        <ol className="rc__events">
          {events.data.slice(0, 12).map((e: QueenEvent) => (
            <li key={e.eventId}><time>{clock(e.ts)}</time> <b>{e.type}</b> <span className="sh-muted">{e.summary}</span></li>
          ))}
        </ol>
      ) : (
        <p className="sh-muted">{events.loading ? "…" : "No events."}</p>
      )}
    </div>
  );
}

/** One attempt. A race train's label comes from `candidateStatus`, never from the train status alone. */
function AttemptRow({ a, old, now }: { a: Attempt; old: boolean; now: number }) {
  const t = a.train;
  const label = attemptLabel(t, a.race, now, old);
  const gate = gateText(t);
  return (
    <li className={`rc__attempt${old ? " rc__attempt--old" : ""}`}>
      <b>#{a.n} {a.kind.toLowerCase()}</b> <span>{label}</span>
      <span className="sh-muted">
        {gate ? ` · ${gate}` : ""}
        {t.landedSha ? ` · landed ${t.landedSha.slice(0, 7)}` : ""}
        {t.status === "BUILDING" || t.status === "TESTING" ? ` · ${durationText(now - t.createdAt)}` : ` · ${relativeTime(t.createdAt, now)}`}
      </span>
      {t.conflict && <p className="item__conflict">⚡ conflict on {t.conflict.paths.join(", ") || "paths"} ({t.conflict.kind}): {t.conflict.summary}</p>}
    </li>
  );
}

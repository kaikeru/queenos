import { memo, useMemo } from "react";

import { useNow } from "./components";
import type { State } from "./reducer";
import { hrefFor } from "./route";
import { Link } from "./router";
import { floorSummary, swarmFloor, type SwarmGroup, type SwarmTile } from "./swarm";
import "./swarm.css";

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const tipOf = (t: SwarmTile, now: number) =>
  [t.title, t.origin?.text ?? t.model, `${t.group} ${mmss(now - t.startedAt)}`, `forked from main@${t.baseSha.slice(0, 4)}`, t.candidate != null ? `candidate ${t.candidate}${t.outcome ? ` (${t.outcome})` : ""}` : null]
    .filter(Boolean)
    .join(" · ");

/** One tile. Memoised; keyed by trainId inside its phase group, so a phase change remounts it and replays the slide-in. */
const Tile = memo(function Tile({ tile, hive, now }: { tile: SwarmTile; hive: string; now: number }) {
  const cls = `tile tile--${tile.group}${tile.outcome === "WON" ? " tile--winner" : ""}${tile.outcome === "LOST" || tile.outcome === "FAILED" ? " tile--loser" : ""}${tile.origin ? " tile--pushed" : ""}`;
  const tip = tipOf(tile, now);
  return tile.itemId ? <Link to={hrefFor.item(hive, tile.itemId)} className={cls} title={tip} aria-label={tip} /> : <span className={cls} title={tip} />;
});

function GroupTiles({ g, hive, now }: { g: SwarmGroup; hive: string; now: number }) {
  if (g.group !== "racing") return <>{g.tiles.map((t) => <Tile key={t.trainId} tile={t} hive={hive} now={now} />)}</>;
  // Race candidates are outlined together, one box per race.
  const byRace = new Map<string, SwarmTile[]>();
  for (const t of g.tiles) {
    const k = t.raceId ?? t.trainId;
    byRace.set(k, [...(byRace.get(k) ?? []), t]);
  }
  return (
    <>
      {[...byRace].map(([raceId, tiles]) => (
        <span key={raceId} className="frace" title={`race ${raceId}`} data-race={raceId}>
          {tiles.map((t) => <Tile key={t.trainId} tile={t} hive={hive} now={now} />)}
        </span>
      ))}
    </>
  );
}

export function SwarmFloor({ state, hive }: { state: State; hive: string }) {
  const now = useNow(5000);
  const { trains, trainOrder, items, races, events, landed } = state;
  const floor = useMemo(() => swarmFloor({ trains, trainOrder, items, races, events, landed }), [trains, trainOrder, items, races, events, landed]);
  const summary = floorSummary(floor);
  const peak = Math.max(1, ...floor.groups.map((g) => g.count));
  return (
    <section className="floor" aria-label="Swarm floor">
      <div className="floor__head">
        <h3 className="eyebrow">SWARM FLOOR · {floor.total} {floor.total === 1 ? "build" : "builds"} at once</h3>
      </div>
      {summary && <p className="floor__summary">{summary}</p>}
      {floor.total === 0 ? (
        <p className="floor__empty">No builds in flight.</p>
      ) : floor.collapsed ? (
        <div className="bars">
          {floor.groups.filter((g) => g.count > 0).map((g) => (
            <div key={g.group} className={`bar tile--${g.group}`}>
              <span>{g.group}</span>
              <span className="bar__track"><i className="bar__fill" style={{ ["--w" as string]: g.count / peak }} /></span>
              <b>{g.count}</b>
            </div>
          ))}
        </div>
      ) : (
        <div className="floor__groups">
          {floor.groups.filter((g) => g.count > 0).map((g) => (
            <div key={g.group} className="fgroup" data-group={g.group}>
              <span className="fgroup__label">{g.group}<b>{g.count}</b></span>
              <div className="fgroup__tiles"><GroupTiles g={g} hive={hive} now={now} /></div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

import { useMemo } from "react";

import type { State } from "./reducer";
import { hrefFor } from "./route";
import { Link } from "./router";
import { itemIdOf, queueRail, recentBisects, recentConflicts, type CarMember, type QueueCar, type QueueStory, type WaitingBuild } from "./swarm";
import "./swarm.css";

function Chip({ m, hive }: { m: Pick<CarMember, "itemId" | "title" | "trainId">; hive: string }) {
  return m.itemId ? (
    <Link to={hrefFor.item(hive, m.itemId)} className="mchip" title={m.title}>{m.title}</Link>
  ) : (
    <span className="mchip" title={m.title}>{m.title}</span>
  );
}

export function CarCard({ car, hive }: { car: QueueCar; hive: string }) {
  return (
    <div className={`car car--${car.phase.toLowerCase()}`} data-car={car.label}>
      <div className="car__top">
        <b>{car.label}</b>
        <span className="car__phase">{car.phase}</span>
        {car.fastForward && <span className="car__ff" title="Single member, gate skipped">⚡ fast-forward</span>}
      </div>
      <div className="car__members">{car.members.map((m) => <Chip key={m.trainId} m={m} hive={hive} />)}</div>
    </div>
  );
}

export function Rail({ state, hive }: { state: State; hive: string }) {
  const { trains, trainOrder, items, landed } = state;
  const rail = useMemo(() => queueRail({ trains, trainOrder, items, races: state.races, events: state.events, landed }), [trains, trainOrder, items, landed, state.races, state.events]);
  return (
    <>
      <div className="rail" role="list" aria-label="Merge queue rail">
        <div className="rail__main" role="listitem">
          <b>main</b>
          <span>{rail.main ? `@${rail.main.sha.slice(0, 7)}` : "no commits"}</span>
        </div>
        {rail.cars.length === 0 && <span className="rail__empty">queue empty</span>}
        {rail.cars.map((car) => (
          <span key={car.train.trainId} style={{ display: "contents" }} role="listitem">
            <span className="rail__arrow" aria-hidden>◀━</span>
            <CarCard car={car} hive={hive} />
          </span>
        ))}
      </div>
      <Waiting waiting={rail.waiting} hive={hive} />
    </>
  );
}

function Waiting({ waiting, hive }: { waiting: WaitingBuild[]; hive: string }) {
  if (!waiting.length) return null;
  return (
    <div className="mq__waiting">
      <span>waiting to board:</span>
      {waiting.map((w) => <Chip key={w.trainId} m={w} hive={hive} />)}
    </div>
  );
}

/** The item a story is about: its own, else the first member of the failed car. */
function storyItem(state: State, s: QueueStory): string | null {
  if (s.itemId) return s.itemId;
  const members = Array.isArray(s.data?.members) ? (s.data!.members as unknown[]) : [];
  for (const id of members) {
    const t = typeof id === "string" ? state.trains[id] : undefined;
    const item = t ? itemIdOf(t) : undefined;
    if (item) return item;
  }
  return null;
}

export function Story({ story, state, hive }: { story: QueueStory; state: State; hive: string }) {
  const item = storyItem(state, story);
  return (
    <li className={`story story--${story.kind}`}>
      <span className="story__kind">{story.kind === "conflict" ? "⚡ conflict" : "✂ bisect"}</span>
      <span>{story.summary}</span>
      {story.paths.length > 0 && <span className="story__paths">{story.paths.join(", ")}</span>}
      {item && <Link to={hrefFor.item(hive, item)}>item ▸</Link>}
      {story.traceId && <Link to={hrefFor.trace(hive, story.traceId)}>trace ▸</Link>}
    </li>
  );
}

export function MergeQueue({ state, hive }: { state: State; hive: string }) {
  const { trains, trainOrder, items, races, events, landed } = state;
  const stories = useMemo(() => {
    const slice = { trains, trainOrder, items, races, events, landed };
    return [...recentConflicts(slice, 3), ...recentBisects(slice, 3)].sort((a, b) => b.ts - a.ts).slice(0, 6);
  }, [trains, trainOrder, items, races, events, landed]);
  return (
    <section className="mq" aria-label="Merge queue">
      <div className="mq__head">
        <h3 className="eyebrow">MERGE QUEUE</h3>
        <Link to={hrefFor.queue(hive)} className="mq__meta">{landed.length} landed · queue page ▸</Link>
      </div>
      <Rail state={state} hive={hive} />
      {stories.length > 0 && (
        <ul className="stories">
          {stories.map((s) => <Story key={s.key} story={s} state={state} hive={hive} />)}
        </ul>
      )}
    </section>
  );
}

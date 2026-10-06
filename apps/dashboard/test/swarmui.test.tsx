import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { buildSwarmFixture } from "../src/mockQueen";
import { MergeQueue } from "../src/MergeQueue";
import { QueuePage } from "../src/QueuePage";
import { initialState, reducer, type Action, type State } from "../src/reducer";
import { SwarmFloor } from "../src/SwarmFloor";
import { hrefFor } from "../src/route";
import { COLLAPSE_TILES_ABOVE } from "../src/swarm";
import type { MergeTrain } from "@queenos/queen-types";

const NOW = 1_800_000_000_000;
const fx = buildSwarmFixture("demo", NOW);
const load = (trains = fx.trains): State =>
  reducer(initialState, {
    type: "server",
    at: NOW,
    message: { type: "snapshot", promptRuns: [], trains, recentAudit: [], items: fx.items, races: fx.races, escalations: fx.escalations, hive: fx.hive, recentEvents: fx.events },
  } as unknown as Action);

test("floor renders tiles grouped by phase with summary and race box", () => {
  const html = renderToString(<SwarmFloor state={load()} hive="demo" />);
  expect(html).toContain("SWARM FLOOR");
  expect(html).toContain('data-group="building"');
  expect(html).toContain("frace");
  expect(html).toMatch(/building \d+/);
  expect((html.match(/class="tile /g) ?? []).length).toBeGreaterThanOrEqual(30);
  expect(html).not.toContain("bar__fill");
});

test("floor collapses to bars above the threshold", () => {
  const base = fx.trains.find((t) => (t.lane ?? "BUILD") === "BUILD" && t.status !== "EJECTED")!;
  const many: MergeTrain[] = Array.from({ length: COLLAPSE_TILES_ABOVE + 5 }, (_, i) => ({ ...base, trainId: `x${i}`, carId: undefined, raceId: undefined, phase: "BUILDING", status: "BUILDING" }) as MergeTrain);
  const html = renderToString(<SwarmFloor state={load(many)} hive="demo" />);
  expect(html).toContain("bar__fill");
  expect(html).not.toContain('class="tile ');
});

test("rail shows main, cars with phase, fast-forward, waiting and story links", () => {
  const html = renderToString(<MergeQueue state={load()} hive="demo" />);
  expect(html).toContain("main");
  expect(html).toContain("K41");
  expect(html).toContain("LANDING");
  expect(html).toContain("waiting to board");
  expect(html).toContain("conflict");
  expect(html).toContain("bisect");
  expect(html).toContain(hrefFor.item("demo", "s29").replace(/s29$/, ""));
  expect(html).toContain("/traces/");
});

test("empty state renders", () => {
  expect(renderToString(<SwarmFloor state={initialState} hive="demo" />)).toContain("No builds in flight");
  expect(renderToString(<MergeQueue state={initialState} hive="demo" />)).toContain("queue empty");
});

test("queue page lists cars in a table", () => {
  const html = renderToString(<QueuePage hive="demo" state={load()} />);
  expect(html).toContain("CARS");
  expect(html).toContain("<table");
  expect(html).toContain("K1");
});

/** Dashboard redesign U4: the MERGE TREE panel (spec §3.2 item 3). */
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";

import { MergeTreePanel } from "../src/MergeGraph.tsx";
import { buildSwarmFixture } from "../src/mockQueen";
import { initialState, reducer, type Action, type State } from "../src/reducer";

const NOW = 1_800_000_000_000;
const fx = buildSwarmFixture("demo", NOW);
const load = (): State =>
  reducer(initialState, {
    type: "server",
    at: NOW,
    message: { type: "snapshot", promptRuns: [], trains: fx.trains, recentAudit: [], items: fx.items, races: fx.races, escalations: fx.escalations, hive: fx.hive, recentEvents: fx.events },
  } as unknown as Action);

test("no cars: the graph area and CARS say No cars in line", () => {
  const html = renderToString(<MergeTreePanel state={initialState} hive="demo" now={NOW} />);
  expect(html).toContain("MERGE TREE");
  expect(html).toContain("CARS");
  expect(html).toContain("No cars in line");
  expect(html).toContain('class="mg mg--compact"');
});

test("cars: one row per live car with its label, phase and members, linking to the goal page", () => {
  const html = renderToString(<MergeTreePanel state={load()} hive="demo" now={NOW} />);
  expect(html).not.toContain("No cars in line");
  expect(html).toContain("mtree__car--landing");
  expect(html).toMatch(/class="mtree__car-label">K\d+</);
  expect(html).toContain("/p/demo/items/");
  expect(html).toContain("queue page ▸");
});

test("a first loaded render marks nothing as new", () => {
  const html = renderToString(<MergeTreePanel state={load()} hive="demo" now={NOW} />);
  expect(html).not.toContain("mtree__landed--new");
  expect(html).not.toContain("mtree__car--changed");
});

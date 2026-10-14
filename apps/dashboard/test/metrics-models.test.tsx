/** Dashboard redesign U5: the Model Board moved from the lanes page to Metrics (spec §3.6). */
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type { HiveStatus } from "@queenos/queen-types";

import { Metrics } from "../src/Metrics";
import { initialState } from "../src/reducer";
import { HiveFooter } from "../src/shell";

test("Metrics shows the Model Board on swarm hives, not on external ones", () => {
  const swarm = { ...initialState, hive: { settings: { executors: "swarm" } } as unknown as HiveStatus };
  expect(renderToString(<Metrics hive="h" state={swarm} />)).toContain("MODEL BOARD");
  const external = { ...initialState, hive: { settings: { executors: "external" } } as unknown as HiveStatus };
  expect(renderToString(<Metrics hive="h" state={external} />)).not.toContain("MODEL BOARD");
});

test("no Model Board section while the hive is not loaded", () => {
  expect(renderToString(<Metrics hive="h" state={{ ...initialState, hive: null }} />)).not.toContain('id="models"');
});

test("the footer drops the lanes and models links", () => {
  const html = renderToString(<HiveFooter hive="h" />);
  expect(html).not.toContain("lanes");
  expect(html).not.toContain("models");
  expect(html).toContain("metrics ▸");
});

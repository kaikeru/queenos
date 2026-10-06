import { expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import type { HourlyMetric, QueenEvent, Span } from "@queenos/queen-types";
import { axisTicks, carMembers, layoutTrace, TraceWaterfall, fmtDuration } from "../src/TraceView";
import { EventLog, EventRows, filtersFromSearch, matchesType, mergeEvents, NO_FILTERS } from "../src/EventLog";
import { Metrics, MetricsBoard, barPath, errorBudget, niceMax, seriesOf, sourceKind, totalsByLabel, windowBuckets } from "../src/Metrics";
import { TraceView } from "../src/TraceView";
import { initialState } from "../src/reducer";

const sp = (spanId: string, parent: string | null, kind: Span["kind"], s: number, e: number | null, outcome: string | null = null): Span => ({ spanId, parentSpanId: parent, name: `${kind} ${spanId}`, kind, startTs: s, endTs: e, outcome });
const T = "a".repeat(32);
const ev = (seq: number, over: Partial<QueenEvent> = {}): QueenEvent => ({
  seq, eventId: `e${seq}`, ts: 1000 * seq, hive: "h", type: "item.filed", severity: "info", actor: "queen",
  traceId: null, spanId: null, parentSpanId: null, itemId: null, trainId: null, releaseId: null, commandId: null, summary: `ev ${seq}`, data: null, ...over,
});

test("layoutTrace puts parallel builds at the same x and nests children", () => {
  const spans = [
    sp("1111111111111111", null, "item", 0, 100_000, "ok"),
    sp("2222222222222222", "1111111111111111", "train", 10_000, 60_000, "MERGED"),
    sp("3333333333333333", "1111111111111111", "train", 10_000, 80_000, "FAILED"),
    sp("4444444444444444", "3333333333333333", "command", 20_000, null),
  ];
  const l = layoutTrace(spans, 120_000);
  expect(l.rows.map((r) => r.depth)).toEqual([0, 1, 1, 2]);
  expect(l.rows[1]!.leftPct).toBe(l.rows[2]!.leftPct);
  expect(l.rows[2]!.bad).toBe(true);
  expect(l.rows[3]!.running).toBe(true);
  expect(l.totalMs).toBe(120_000);
});

test("layoutTrace tolerates orphans, cycles and empty input", () => {
  expect(layoutTrace([], 5).rows).toEqual([]);
  const l = layoutTrace([sp("aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "item", 0, 5), sp("bbbbbbbbbbbbbbbb", "aaaaaaaaaaaaaaaa", "item", 1, 6)], 10);
  expect(l.rows.length).toBeLessThanOrEqual(2);
  expect(layoutTrace([sp("cccccccccccccccc", "dddddddddddddddd", "car", 0, 5)], 10).rows[0]!.shared).toBe(true);
});

test("axisTicks, fmtDuration, carMembers", () => {
  expect(axisTicks(180_000).length).toBeLessThanOrEqual(7);
  expect(fmtDuration(6000)).toBe("6.0s");
  expect(fmtDuration(125_000)).toBe("2m05s");
  expect(carMembers([ev(1, { data: { members: ["t1", "t2"] } })])).toEqual(["t1", "t2"]);
});

test("TraceWaterfall renders rows, shared car note and links", () => {
  const view = { traceId: T, spans: [sp("1111111111111111", null, "item", 0, 9000, "ok"), sp("5555555555555555", "1111111111111111", "car", 1000, 5000, "landed")], events: [], links: ["b".repeat(32)] };
  const html = renderToString(<TraceWaterfall view={view} hive="h" now={10_000} />);
  expect(html).toContain("item 1111111111111111");
  expect(html).toContain("shared with member traces");
  expect(html).toContain(`/p/h/traces/${"b".repeat(32)}`);
});

test("event filters, merging and paging semantics", () => {
  expect(matchesType("queue.conflict", "queue")).toBe(true);
  expect(matchesType("queue.conflict", "queue.conflict")).toBe(true);
  expect(matchesType("queueX.a", "queue")).toBe(false);
  expect(filtersFromSearch("?trace=abc&type=queue").trace).toBe("abc");
  const fetched = [ev(5), ev(4)];
  const live = [ev(6), ev(5), ev(2), ev(7, { severity: "debug" })];
  expect(mergeEvents(fetched, live, NO_FILTERS).map((e) => e.seq)).toEqual([7, 6, 5, 4]);
  expect(mergeEvents(fetched, live, { ...NO_FILTERS, minSeverity: "info" }).map((e) => e.seq)).toEqual([6, 5, 4]);
  expect(mergeEvents(fetched, live, { ...NO_FILTERS, item: "x" })).toEqual([]);
  expect(mergeEvents([], live, NO_FILTERS, false)).toEqual([]);
});

test("EventRows renders and shows an empty state", () => {
  expect(renderToString(<EventRows events={[ev(1, { itemId: "i1", traceId: T })]} hive="h" />)).toContain("/p/h/items/i1");
  expect(renderToString(<EventRows events={[]} hive="h" />)).toContain("No events match");
});

const HOUR = 3_600_000;
const NOW = 100 * HOUR + 1234;
const row = (name: string, bucket: number, count: number, sum: number, max: number, labels: Record<string, string> = {}): HourlyMetric => ({ bucket, name, labels, count, sum, min: 0, max });

test("windowBuckets and seriesOf aggregate rollups", () => {
  const b = windowBuckets(NOW, 24);
  expect(b).toHaveLength(24);
  expect(b.at(-1)!.ts).toBe(100 * HOUR);
  const rows = [row("items_landed", 100 * HOUR, 3, 3, 1), row("item_landed", 99 * HOUR, 2, 2, 1), row("active_builds", 100 * HOUR, 2, 0, 9), row("active_builds", 100 * HOUR, 1, 0, 4), row("queue_wait_ms", 98 * HOUR, 2, 600, 400), row("items_landed", 10 * HOUR, 9, 9, 1)];
  const landed = seriesOf(rows, ["items_landed", "item_landed"], b, HOUR, "count");
  expect(landed.at(-1)).toBe(3);
  expect(landed.at(-2)).toBe(2);
  expect(landed.reduce<number>((a, v) => a + (v ?? 0), 0)).toBe(5);
  expect(seriesOf(rows, ["active_builds"], b, HOUR, "max").at(-1)).toBe(9);
  expect(seriesOf(rows, ["active_builds"], b, HOUR, "max")[0]).toBeNull();
  expect(seriesOf(rows, ["queue_wait_ms"], b, HOUR, "mean").at(-3)).toBe(300);
  const b7 = windowBuckets(NOW, 168, 6);
  expect(b7).toHaveLength(28);
});

test("helpers: niceMax, totalsByLabel, barPath, sourceKind, errorBudget", () => {
  expect(niceMax(0)).toBe(1);
  expect(niceMax(7)).toBe(10);
  expect(niceMax(130)).toBe(200);
  expect(totalsByLabel([row("gate_verdicts", 0, 2, 2, 1, { outcome: "pass" }), row("gate_verdicts", 1, 1, 1, 1, { outcome: "fail" }), row("gate_verdicts", 2, 3, 3, 1, { outcome: "pass" })], "gate_verdicts", "outcome")).toEqual([["pass", 5], ["fail", 1]]);
  expect(barPath(0, 10, 10, 0)).toBe("");
  expect(sourceKind("Analytics Engine")).toBe("ae");
  expect(sourceKind("mock rollups")).toBe("rollups");
  const slo = { window: 20, attempted: 12, failed: 2, target: 0.9, errorBudgetRemaining: 0, exhausted: false };
  expect(errorBudget(slo)).toMatchObject({ allowed: 2, level: "low", usedFraction: 1 });
  expect(errorBudget({ ...slo, errorBudgetRemaining: -1, exhausted: true }).level).toBe("exhausted");
});

test("MetricsBoard shows the source and charts; gates fall back to events", () => {
  const rows = [row("items_landed", 100 * HOUR, 3, 3, 1), row("active_builds", 100 * HOUR, 1, 0, 6)];
  const gate = ev(1, { type: "gate.verdict", data: { outcome: "pass" } });
  const html = renderToString(<MetricsBoard data={{ rollups: rows, hive: null, source: "Analytics Engine" }} window="24h" events={[gate]} now={NOW} />);
  expect(html).toContain("Analytics Engine via the edge");
  expect(html).toContain("Throughput");
  expect(html).toContain("live event stream");
  const fb = renderToString(<MetricsBoard data={{ rollups: [], hive: null, source: "mock rollups" }} window="7d" events={[]} now={NOW} />);
  expect(fb).toContain("Queen hourly rollups");
  expect(fb).toContain("No data in this window");
});

test("the three views render a loading shell", () => {
  expect(renderToString(<TraceView hive="h" traceId={T} state={initialState} />)).toContain("Loading trace");
  expect(renderToString(<EventLog hive="h" state={initialState} />)).toContain("Event log");
  expect(renderToString(<Metrics hive="h" state={initialState} />)).toContain("Loading metrics");
});

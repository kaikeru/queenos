import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  QueenEventSchema,
  TraceViewSchema,
  spanIdFor,
  traceIdFromUuid,
  type EventDraft,
  type QueenEvent,
} from "@queenos/queen-types";
import type { QueenNode } from "../src/queen-node";
import { appendEvents, draftToEvent, pruneEvents, queryEvents } from "../src/obs/events";
import { eventLogFields, logEvents } from "../src/obs/log";
import { AnalyticsSink, eventToPoint, type DataPoint } from "../src/obs/metrics-sink";
import { activeBuildsDelta, hourBucket, metricsForEvent, queryMetrics, recordMetrics, sloWindowCounts } from "../src/obs/rollup";
import { buildTraceView, spanTree } from "../src/obs/trace-view";

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % HOUR);
const stubFor = (ns: string) => env.QUEEN_NODE.get(env.QUEEN_NODE.idFromName(ns));
const withSql = <T>(fn: (sql: SqlStorage) => T): Promise<T> =>
  runInDurableObject(stubFor(`obs-${crypto.randomUUID().slice(0, 8)}`), (q: QueenNode) => fn(q.sql));

const traceA = traceIdFromUuid("aaaaaaaa-0000-4000-8000-000000000001");
const traceB = traceIdFromUuid("bbbbbbbb-0000-4000-8000-000000000002");
const draft = (o: Partial<EventDraft> = {}): EventDraft => ({ type: "item.filed", actor: "queen", summary: "filed", ...o });
let n = 0;
const ctx = (ts = T0) => ({ hive: "h", ts, newId: () => `ev-${++n}` });

/** A stored-shaped event (no DB) for pure tests. */
const ev = (seq: number, o: Partial<QueenEvent>): QueenEvent => ({
  seq, eventId: `e${seq}`, ts: T0 + seq * 1000, hive: "h", type: "item.status", severity: "info", actor: "queen",
  traceId: traceA, spanId: null, parentSpanId: null, itemId: null, trainId: null, releaseId: null, commandId: null,
  summary: "s", data: null, ...o,
});

describe("events", () => {
  it("maps a draft to a row with defaults and caps", () => {
    const row = draftToEvent(draft({ summary: "x".repeat(900), data: { big: "y".repeat(5000), k: 1 } }), ctx());
    expect(row.severity).toBe("info");
    expect(row.summary.length).toBe(500);
    expect(row.data).toMatchObject({ truncated: true, keys: ["big", "k"] });
    expect(row.traceId).toBeNull();
  });

  it("appends drafts in order and round-trips through the schema", async () => {
    const out = await withSql((sql) => {
      const stored = appendEvents(
        sql,
        [
          draft({ traceId: traceA, spanId: spanIdFor("i1"), itemId: "i1", data: { kind: "feature" } }),
          draft({ type: "drone.audit", droneRole: "BUILDER", auditStatus: "PASSED", gitNotesPayload: null, summary: "BUILDER PASSED" }),
        ],
        ctx(),
      );
      return { stored, read: queryEvents(sql, {}) };
    });
    expect(out.stored.map((e) => e.seq)).toEqual([out.stored[0]!.seq, out.stored[0]!.seq + 1]);
    expect(out.read.map((e) => e.eventId)).toEqual(out.stored.map((e) => e.eventId).reverse());
    for (const e of out.read) QueenEventSchema.parse(e);
    expect(out.read[1]!.data).toEqual({ kind: "feature" });
    expect(out.read[0]!.droneRole).toBe("BUILDER");
  });

  it("is idempotent by eventId", async () => {
    const stored = await withSql((sql) => {
      const c = { hive: "h", ts: T0, newId: () => "same" };
      return [appendEvents(sql, [draft()], c), appendEvents(sql, [draft()], c)];
    });
    expect(stored[0]).toHaveLength(1);
    expect(stored[1]).toHaveLength(0);
  });

  it("queries by trace, item, release, type prefix and cursor", async () => {
    const r = await withSql((sql) => {
      appendEvents(
        sql,
        [
          draft({ traceId: traceA, itemId: "i1" }),
          draft({ type: "queue.car", traceId: traceA }),
          draft({ type: "queue.landed", traceId: traceB, releaseId: "r1" }),
          draft({ type: "queue.merged" }),
          draft({ type: "hive.settings" }),
        ],
        ctx(),
      );
      const all = queryEvents(sql, {});
      return {
        trace: queryEvents(sql, { traceId: traceA }).length,
        item: queryEvents(sql, { itemId: "i1" }).length,
        release: queryEvents(sql, { releaseId: "r1" }).length,
        prefix: queryEvents(sql, { typePrefix: "queue" }).map((e) => e.type),
        exact: queryEvents(sql, { typePrefix: "queue.car" }).length,
        before: queryEvents(sql, { before: all[1]!.seq, limit: 1 }).map((e) => e.seq),
        expectBefore: all[2]!.seq,
      };
    });
    expect(r.trace).toBe(2);
    expect(r.item).toBe(1);
    expect(r.release).toBe(1);
    expect(r.prefix.sort()).toEqual(["queue.car", "queue.landed", "queue.merged"]);
    expect(r.exact).toBe(1);
    expect(r.before).toEqual([r.expectBefore]);
  });

  it("pruneEvents drops old rows, then caps the row count", async () => {
    const r = await withSql((sql) => {
      appendEvents(sql, [draft(), draft()], ctx(T0 - 40 * 24 * HOUR));
      appendEvents(sql, [draft(), draft(), draft(), draft()], ctx(T0));
      const aged = pruneEvents(sql, T0);
      const capped = pruneEvents(sql, T0, { maxRows: 3 });
      const left = queryEvents(sql, {});
      return { aged, capped, left: left.length, again: pruneEvents(sql, T0, { maxRows: 3 }) };
    });
    expect(r).toEqual({ aged: 2, capped: 1, left: 3, again: 0 });
  });
});

describe("rollup", () => {
  const e = (type: QueenEvent["type"], data: Record<string, unknown> | null, ts = T0 + 5) => ({ type, ts, data });

  it("buckets by hour", () => {
    expect(hourBucket(T0 + HOUR - 1)).toBe(T0);
    expect(hourBucket(T0 + HOUR)).toBe(T0 + HOUR);
  });

  it("maps events to deltas", () => {
    const one = (x: ReturnType<typeof e>) => metricsForEvent(x).map((m) => [m.name, m.labels, m.sum]);
    expect(one(e("item.filed", { kind: "feature", source: "user" }))).toEqual([["items_filed", { kind: "feature", source: "user" }, 1]]);
    expect(one(e("item.status", { to: "LANDED", kind: "bug" }))[0]![0]).toBe("items_landed");
    expect(one(e("item.status", { to: "ACTIVE" }))).toEqual([]);
    expect(one(e("gate.verdict", { outcome: "PASSED", attempt: 2 }))).toEqual([["gate_verdicts", { outcome: "PASSED", attempt: "2" }, 1]]);
    expect(one(e("command.result", { action: "BUILD", model: "m", role: "BUILDER", outcome: "ok", ms: 900, credits: 3 })).map((x) => x[0])).toEqual([
      "builds", "build_ms", "credits",
    ]);
    expect(one(e("command.result", { action: "FORK" }))).toEqual([]);
    expect(one(e("queue.landed", { members: ["a", "b"], waitMs: 40 }))).toEqual([
      ["queue_cars", { outcome: "landed", size: "2" }, 1],
      ["queue_wait_ms", {}, 40],
    ]);
    expect(one(e("queue.bisect", { size: 4 })).map((x) => x[0])).toEqual(["queue_bisects", "queue_cars"]);
    expect(one(e("queue.conflict", { kind: "content" }))).toEqual([["queue_conflicts", { kind: "content" }, 1]]);
    expect(one(e("affinity.wait", null))).toEqual([["affinity_waits", {}, 1]]);
    expect(one(e("release.phase", { to: "ROLLED_BACK" }))).toEqual([["releases", { outcome: "ROLLED_BACK" }, 1]]);
    expect(one(e("release.phase", { to: "CANARY" }))).toEqual([]);
    expect(one(e("escalation.opened", { reason: "SENTINEL_FAILED" }))[0]![0]).toBe("escalations");
    expect(one(e("race.started", { width: 3 }))).toEqual([["races", { width: "3" }, 1]]);
    expect(one(e("race.decided", { winnerModel: "m1" }))).toEqual([["race_wins", { model: "m1" }, 1]]);
    expect(one(e("item.filed", null))[0]![1]).toEqual({ kind: "unknown", source: "unknown" });
  });

  it("upserts additively and folds the gauge", async () => {
    const rows = await withSql((sql) => {
      recordMetrics(sql, [e("queue.landed", { size: 2, waitMs: 100 }), e("queue.landed", { size: 2, waitMs: 20 })], { now: T0 + 1, activeBuilds: 4 });
      recordMetrics(sql, [e("queue.landed", { size: 3, waitMs: 300 }, T0 + HOUR + 1)], { now: T0 + 2, activeBuilds: 9 });
      recordMetrics(sql, [], { now: T0 + 3, activeBuilds: 2 });
      return { all: queryMetrics(sql, T0, T0 + 2 * HOUR), wait: queryMetrics(sql, T0, T0 + 2 * HOUR, "queue_wait_ms") };
    });
    const cars2 = rows.all.find((m) => m.name === "queue_cars" && m.labels.size === "2")!;
    expect(cars2).toMatchObject({ bucket: T0, count: 2, sum: 2 });
    expect(rows.wait.map((m) => [m.bucket, m.count, m.sum, m.min, m.max])).toEqual([
      [T0, 2, 120, 20, 100],
      [T0 + HOUR, 1, 300, 300, 300],
    ]);
    const gauge = rows.all.find((m) => m.name === "active_builds")!;
    expect(gauge).toMatchObject({ count: 3, min: 2, max: 9 });
    expect(activeBuildsDelta(T0, 1).name).toBe("active_builds");
  });

  it("counts the SLO window over terminal releases", async () => {
    const counts = await withSql((sql) => {
      const phases = ["SHIPPED", "CANARY", "ROLLED_BACK", "SUPERSEDED", "SHIPPED", "FAILED", "SHIPPED"];
      phases.forEach((phase, i) =>
        sql.exec(
          "INSERT INTO releases (release_id, hive, head_sha, train_ids, phase, created_at, updated_at, seq) VALUES (?, 'h', 'sha', '[]', ?, ?, ?, ?)",
          `r${i}`, phase, T0 + i, T0 + i, i,
        ),
      );
      return { all: sloWindowCounts(sql, 20), last3: sloWindowCounts(sql, 3), none: sloWindowCounts(sql, 0) };
    });
    expect(counts.all).toEqual({ window: 20, attempted: 5, failed: 2 });
    expect(counts.last3).toEqual({ window: 3, attempted: 3, failed: 1 });
    expect(counts.none).toEqual({ window: 0, attempted: 0, failed: 0 });
  });
});

describe("buildTraceView", () => {
  const item = spanIdFor("i1");
  const train = spanIdFor("t1");
  const car = spanIdFor("car1");
  const cmd = spanIdFor("cmd-1");

  it("derives item, train, command, gate and release spans", () => {
    const events = [
      ev(1, { type: "item.filed", spanId: item, summary: "filed" }),
      ev(2, { type: "train.enqueued", spanId: train, parentSpanId: item }),
      ev(3, { type: "command.issued", spanId: cmd, parentSpanId: train, commandId: "cmd-1", data: { action: "BUILD" } }),
      ev(4, { type: "command.result", spanId: cmd, parentSpanId: train, commandId: "cmd-1", data: { outcome: "ok" } }),
      ev(5, { type: "gate.verdict", spanId: spanIdFor("gate:t1:s"), parentSpanId: train, data: { outcome: "PASSED" } }),
      ev(6, { type: "command.issued", spanId: spanIdFor("cmd-2"), parentSpanId: train, commandId: "cmd-2" }),
      ev(7, { type: "item.status", spanId: item, data: { to: "LANDED" } }),
      ev(8, { type: "item.status", traceId: traceB, spanId: item }),
      ev(9, { type: "hive.settings" }),
    ];
    const view = buildTraceView(events, traceA);
    TraceViewSchema.parse(view);
    expect(view.events).toHaveLength(8);
    const by = Object.fromEntries(view.spans.map((s) => [s.spanId, s]));
    expect(by[item]).toMatchObject({ kind: "item", endTs: events[6]!.ts, outcome: "LANDED", parentSpanId: null });
    expect(by[train]).toMatchObject({ kind: "train", parentSpanId: item, endTs: null });
    expect(by[cmd]).toMatchObject({ kind: "command", name: "BUILD cmd-1", startTs: events[2]!.ts, endTs: events[3]!.ts, outcome: "ok" });
    expect(by[spanIdFor("cmd-2")]).toMatchObject({ endTs: null, outcome: null });
    expect(by[spanIdFor("gate:t1:s")]).toMatchObject({ kind: "gate", outcome: "PASSED" });
    const roots = spanTree(view.spans);
    expect(roots.map((r) => r.spanId)).toEqual([item]);
    expect(roots[0]!.children[0]!.children.map((c) => c.kind).sort()).toEqual(["command", "command", "gate"]);
  });

  it("shares a car span across member traces under each member's own parent", () => {
    const trainB = spanIdFor("t2");
    const events = [
      ev(1, { type: "queue.car", traceId: traceA, spanId: car, parentSpanId: train, data: { members: ["t1", "t2"] } }),
      ev(2, { type: "queue.car", traceId: traceB, spanId: car, parentSpanId: trainB }),
      ev(3, { type: "queue.landed", traceId: traceA, spanId: car, parentSpanId: train, data: { size: 2 } }),
      ev(4, { type: "queue.landed", traceId: traceB, spanId: car, parentSpanId: trainB, data: { size: 2 } }),
    ];
    const a = buildTraceView(events, traceA);
    const b = buildTraceView(events, traceB);
    expect(a.spans).toHaveLength(1);
    expect(b.spans).toHaveLength(1);
    expect(a.spans[0]!.spanId).toBe(b.spans[0]!.spanId);
    expect(a.spans[0]).toMatchObject({ kind: "car", parentSpanId: train });
    expect(b.spans[0]).toMatchObject({ kind: "car", parentSpanId: trainB, endTs: events[3]!.ts });
  });

  it("collects valid links and defaults to the first event's trace", () => {
    const view = buildTraceView([ev(1, { traceId: traceB, data: { links: [traceA, "nope", traceB] } })]);
    expect(view.traceId).toBe(traceB);
    expect(view.links).toEqual([traceA]);
    expect(buildTraceView([]).spans).toEqual([]);
  });
});

describe("AnalyticsSink", () => {
  const point = { type: "x", hive: "h" };
  const writer = () => {
    const got: DataPoint[] = [];
    return { got, w: { writeDataPoint: (p: DataPoint) => void got.push(p) } };
  };

  it("is a no-op without a binding", () => {
    const s = new AnalyticsSink(undefined);
    expect(s.write(point)).toBe(false);
    expect(s).toMatchObject({ written: 0, dropped: 0 });
  });

  it("caps at 200 points per invocation, counts drops, resets per invocation", () => {
    const { got, w } = writer();
    const s = new AnalyticsSink(w);
    for (let i = 0; i < 230; i++) s.write(point);
    expect(got).toHaveLength(200);
    expect(s.dropped).toBe(30);
    s.beginInvocation();
    expect(s.write(point)).toBe(true);
    expect(got).toHaveLength(201);
    expect(s.dropped).toBe(30);
  });

  it("counts a throwing binding as a drop and never throws", () => {
    const s = new AnalyticsSink({
      writeDataPoint: () => {
        throw new Error("x");
      },
    });
    expect(() => s.write(point)).not.toThrow();
    expect(s.dropped).toBe(1);
  });

  it("writes one point per notable event with the AE layout", () => {
    const { got, w } = writer();
    const s = new AnalyticsSink(w);
    const events = [
      ev(1, { type: "command.result", itemId: "i1", data: { outcome: "ok", model: "m", role: "BUILDER", ms: 12, credits: 2 } }),
      ev(2, { severity: "debug" }),
    ];
    expect(s.writeEvents(events, "prod")).toBe(1);
    expect(got[0]).toEqual({ indexes: ["h"], blobs: ["command.result", "h", "BUILDER", "m", "ok", "prod", traceA, "i1"], doubles: [12, 0, 0, 2, 1] });
    expect(eventToPoint(events[1]!)).toBeNull();
  });
});

describe("log", () => {
  it("logs warn and error events only, with the trace fields", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvents([ev(1, { severity: "info" }), ev(2, { severity: "warn", spanId: spanIdFor("s"), itemId: "i1" }), ev(3, { severity: "error" })]);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ source: "queen", trace_id: traceA, span_id: spanIdFor("s"), item_id: "i1" });
    expect(eventLogFields(ev(1, {})).event_type).toBe("item.status");
    log.mockRestore();
  });
});

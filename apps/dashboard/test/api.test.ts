import { afterEach, expect, test, vi } from "vitest";
import { api, eventsQuery } from "../src/api";
import { buildSwarmFixture } from "../src/mockQueen";

const fx = buildSwarmFixture("demo", 1_800_000_000_000);

function stub(body: unknown, status = 200) {
  const f = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", f);
  return f;
}
afterEach(() => vi.unstubAllGlobals());

test("eventsQuery maps filters to the Queen's query names", () => {
  expect(eventsQuery()).toBe("");
  expect(eventsQuery({ typePrefix: "queue", before: 40, limit: 50, itemId: "g1-c1" })).toBe("?item=g1-c1&type=queue&before=40&limit=50");
  expect(eventsQuery({ traceId: "a".repeat(32), releaseId: "rel-1" })).toBe(`?trace=${"a".repeat(32)}&release=rel-1`);
});

test("items, events, traces, metrics and queue hit the v2 routes and parse", async () => {
  const f = stub({ item: fx.items[0], children: [fx.items[1]], trains: [fx.trains[0]], races: fx.races, release: null, escalations: fx.escalations });
  const d = await api.item("demo", "g1");
  expect(f).toHaveBeenCalledWith("/hives/demo/items/g1", expect.objectContaining({ method: "GET" }));
  expect(d.children).toHaveLength(1);
  expect(d.release).toBeNull();

  const f2 = stub(fx.events);
  expect(await api.events("demo", { typePrefix: "queue", limit: 20 })).toHaveLength(fx.events.length);
  expect(f2).toHaveBeenCalledWith("/hives/demo/events?type=queue&limit=20", expect.anything());
  stub({ events: fx.events });
  expect(await api.events("demo")).toHaveLength(fx.events.length);

  const f3 = stub({ traceId: "a".repeat(32), spans: [], events: [], links: [] });
  expect((await api.trace("demo", "a".repeat(32))).spans).toEqual([]);
  expect(f3).toHaveBeenCalledWith(`/hives/demo/traces/${"a".repeat(32)}`, expect.anything());

  const f4 = stub({ rollups: [], status: fx.hive });
  const m = await api.metrics("demo", "7d");
  expect(m.hive?.headline).toBe("NEEDS_YOU");
  expect(m.source).toBe("rollups");
  expect(f4).toHaveBeenCalledWith("/hives/demo/metrics?window=7d", expect.anything());

  stub({ cars: [fx.trains.find((t) => t.lane === "QUEUE")], waiting: [], conflicts: fx.events.filter((e) => e.type === "queue.conflict"), bisects: [] });
  const q = await api.queue("demo");
  expect(q.cars).toHaveLength(1);
  expect(q.conflicts).toHaveLength(1);
});

test("writes post JSON with credentials", async () => {
  const f = stub({ ok: true });
  await api.itemAction("demo", "g1-c1", { action: "retry" });
  expect(f).toHaveBeenCalledWith(
    "/hives/demo/items/g1-c1/actions",
    expect.objectContaining({ method: "POST", credentials: "include", body: JSON.stringify({ action: "retry" }) }),
  );
  await api.resolveEscalation("demo", "esc-1", { action: "ship" });
  expect(f).toHaveBeenLastCalledWith("/hives/demo/escalations/esc-1/resolve", expect.objectContaining({ method: "POST" }));
  await api.updateSettings("demo", { autonomy: "paused" });
  expect(f).toHaveBeenLastCalledWith("/hives/demo/settings", expect.objectContaining({ method: "PATCH" }));
});

test("a malformed or failing response becomes an ApiError", async () => {
  stub({ item: { nope: true } });
  await expect(api.item("demo", "x")).rejects.toThrow(/unexpected response/);
  stub({ error: "NOT_FOUND: item x" }, 404);
  await expect(api.item("demo", "x")).rejects.toThrow(/NOT_FOUND/);
});

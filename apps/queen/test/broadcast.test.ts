import { describe, expect, it } from "vitest";
import type { QueenServerMessage, QueenServerUnitMessage } from "@queenos/queen-types";
import { Coalescer, FRAME_INTERVAL_MS, entityKey } from "../src/scale/broadcast";

const train = (trainId: string, status = "BUILDING") => ({ type: "train.updated", train: { trainId, status } }) as unknown as QueenServerUnitMessage;
const item = (itemId: string, status = "READY") => ({ type: "item.updated", item: { itemId, status } }) as unknown as QueenServerUnitMessage;
const event = (eventId: string) => ({ type: "event.appended", event: { eventId } }) as unknown as QueenServerUnitMessage;

function rig(opts: { maxBatch?: number } = {}) {
  const frames: QueenServerMessage[] = [];
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const clock = { t: 10_000 };
  const c = new Coalescer({
    send: (f) => frames.push(f),
    now: () => clock.t,
    schedule: (ms, fn) => {
      const timer = { at: clock.t + ms, fn, live: true };
      timers.push(timer);
      return () => void (timer.live = false);
    },
    ...opts,
  });
  const advance = (ms: number) => {
    clock.t += ms;
    for (const t of timers) {
      if (!t.live || t.at > clock.t) continue;
      t.live = false;
      t.fn();
    }
  };
  return { c, frames, timers, clock, advance };
}
const batch = (f: QueenServerMessage | undefined) => (f as { messages: QueenServerUnitMessage[] }).messages;

describe("entityKey", () => {
  it("keys entity updates and leaves events unkeyed", () => {
    expect(entityKey(train("t1"))).toBe("train:t1");
    expect(entityKey(item("i1"))).toBe("item:i1");
    expect(entityKey({ type: "hive.updated" } as never)).toBe("hive");
    expect(entityKey(event("e1"))).toBeNull();
    expect(entityKey({ type: "error", message: "x" })).toBeNull();
  });
});

describe("Coalescer", () => {
  it("sends the first apply immediately (a lone message bare, several as a batch)", () => {
    const { c, frames } = rig();
    c.push([train("t1")]);
    c.endApply();
    expect(frames).toEqual([train("t1")]);
    const r = rig();
    r.c.push([train("t1"), item("i1")]);
    r.c.endApply();
    expect(r.frames).toEqual([{ type: "batch", messages: [train("t1"), item("i1")] }]);
    expect(r.c.pending).toBe(0);
  });

  it("is last-write-wins per entity within a frame and keeps every event", () => {
    const { c, frames, advance } = rig();
    c.push([train("t0")]);
    c.endApply(); // frame 1
    c.push([train("t1", "BUILDING"), event("e1")]);
    c.endApply();
    c.push([train("t1", "PASSED"), event("e2"), item("i1")]);
    c.endApply();
    expect(c.pending).toBe(4);
    advance(FRAME_INTERVAL_MS);
    expect(batch(frames[1])).toEqual([event("e1"), train("t1", "PASSED"), event("e2"), item("i1")]);
    expect(frames).toHaveLength(2);
  });

  it("sends at most one frame per 100 ms: later applies schedule one timer for the remainder", () => {
    const { c, frames, timers, advance } = rig();
    c.push([train("a")]);
    c.endApply();
    advance(30);
    c.push([train("b")]);
    c.endApply();
    c.push([train("c")]);
    c.endApply();
    expect(frames).toHaveLength(1);
    expect(timers.filter((t) => t.live)).toHaveLength(1);
    advance(69);
    expect(frames).toHaveLength(1);
    advance(1);
    expect(frames).toHaveLength(2);
    expect(batch(frames[1]).map(entityKey)).toEqual(["train:b", "train:c"]);
    expect(c.pending).toBe(0);
  });

  it("the next apply flushes pending messages when the interval has passed even if the timer has not fired", () => {
    const { c, frames, clock } = rig();
    c.push([train("a")]);
    c.endApply();
    clock.t += 10;
    c.push([train("b")]);
    c.endApply(); // pending, timer set
    clock.t += 500; // timer has not run yet
    c.push([train("c")]);
    c.endApply();
    expect(frames).toHaveLength(2);
    expect(batch(frames[1]).map(entityKey)).toEqual(["train:b", "train:c"]);
  });

  it("flush() sends now, cancels the timer and resets the clock", () => {
    const { c, frames, timers, advance } = rig();
    c.push([train("a")]);
    c.endApply();
    c.push([train("b")]);
    c.endApply();
    c.flush();
    expect(frames).toHaveLength(2);
    expect(timers.every((t) => !t.live)).toBe(true);
    advance(200);
    expect(frames).toHaveLength(2);
    c.flush(); // empty: nothing
    expect(frames).toHaveLength(2);
  });

  it("splits a long queue into frames of at most maxBatch", () => {
    const { c, frames } = rig({ maxBatch: 3 });
    c.push(Array.from({ length: 7 }, (_, i) => item(`i${i}`)));
    c.endApply();
    expect(frames.map((f) => (f.type === "batch" ? f.messages.length : 1))).toEqual([3, 3, 1]);
  });

  it("an empty apply sends and schedules nothing", () => {
    const { c, frames, timers } = rig();
    c.endApply();
    expect(frames).toEqual([]);
    expect(timers).toEqual([]);
  });
});

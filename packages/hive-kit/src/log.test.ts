import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTraceparent, spanIdFor, traceparent, traceIdFromUuid } from "@queenos/queen-types";
import { MAX_LOG_VALUE_CHARS, structuredLog, traceFields } from "./log.js";

const traceId = traceIdFromUuid("4e1f9a00-0000-4000-8000-000000000001");
const tp = traceparent(traceId, spanIdFor("train-1"));

afterEach(() => vi.restoreAllMocks());

describe("traceFields", () => {
  it("derives trace, parent and step span ids", () => {
    expect(traceFields({ traceparent: tp }, "cmd-1", "build")).toEqual({
      trace_id: traceId,
      parent_span_id: spanIdFor("train-1"),
      span_id: spanIdFor("cmd-1/build"),
    });
  });
  it("uses the command span when there is no step", () => {
    expect(traceFields({ traceparent: tp }, "cmd-1").span_id).toBe(spanIdFor("cmd-1"));
  });
  it("is empty without a valid trace", () => {
    expect(traceFields(undefined, "c")).toEqual({});
    expect(traceFields({ traceparent: "00-bad" } as never, "c")).toEqual({});
    expect(parseTraceparent(tp)).not.toBeNull();
  });
});

describe("structuredLog", () => {
  it("logs one JSON object", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    structuredLog({ trace_id: traceId, hive: "h", step: "fork", ms: 12, outcome: "ok" });
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({ trace_id: traceId, hive: "h", step: "fork", ms: 12, outcome: "ok" });
  });
  it("clips oversize values and never throws on cycles or bigint", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    structuredLog({ big: "x".repeat(MAX_LOG_VALUE_CHARS * 2), n: 5n });
    const parsed = JSON.parse(log.mock.calls[0]![0] as string);
    expect(parsed.big.length).toBe(MAX_LOG_VALUE_CHARS + 1);
    expect(parsed.n).toBe("5");
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => structuredLog({ hive: "h", cyc })).not.toThrow();
    expect(JSON.parse(log.mock.calls[1]![0] as string).log_error).toBe("unserializable");
  });
  it("never throws when console.log does", () => {
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => structuredLog({ hive: "h" })).not.toThrow();
  });
});

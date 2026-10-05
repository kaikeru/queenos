/**
 * Workers Logs line for an appended event (v2 design §2.6 (b)), so a whole
 * trace can be filtered by `trace_id` across the Queen and every executor.
 * The Queen does not depend on hive-kit's logger; the field names match it.
 */
import type { QueenEvent } from "@queenos/queen-types";

/** The indexed fields of one Queen log line. */
export function eventLogFields(e: QueenEvent): Record<string, unknown> {
  return {
    source: "queen",
    hive: e.hive,
    event_type: e.type,
    severity: e.severity,
    actor: e.actor,
    trace_id: e.traceId,
    span_id: e.spanId,
    parent_span_id: e.parentSpanId,
    item_id: e.itemId,
    train_id: e.trainId,
    release_id: e.releaseId,
    command_id: e.commandId,
    summary: e.summary.slice(0, 200),
  };
}

/** `console.log` one JSON line per warn/error event (info is in the event log; debug never). Never throws. */
export function logEvents(events: readonly QueenEvent[]): void {
  for (const e of events) {
    if (e.severity !== "warn" && e.severity !== "error") continue;
    try {
      console.log(JSON.stringify(eventLogFields(e)));
    } catch {
      /* logging must never break an apply */
    }
  }
}

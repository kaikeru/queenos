/**
 * Structured executor logs (v2 design §2.6 (b)). Every executor logs one JSON
 * object per step with the trace fields, so Workers Logs
 * (`observability.enabled`) can filter a whole trace across Workflows.
 *
 * WP0 seam; WP1.4 implements it.
 */
import type { TraceContext } from "@queenos/queen-types";

/** The indexed fields of one executor log line. */
export interface LogFields {
  trace_id?: string | null;
  span_id?: string | null;
  parent_span_id?: string | null;
  hive?: string;
  command_id?: string;
  step?: string;
  ms?: number;
  outcome?: string;
  [extra: string]: unknown;
}

/**
 * Trace fields for a step: `trace_id` and `parent_span_id` from the command's
 * traceparent, and `span_id = spanIdFor(commandId + "/" + step)`. Empty when
 * the command carries no (valid) trace.
 */
export function traceFields(trace: TraceContext | undefined, commandId: string, step?: string): Pick<LogFields, "trace_id" | "span_id" | "parent_span_id"> {
  void trace;
  void commandId;
  void step;
  throw new Error("not implemented");
}

/** `console.log` one JSON object (never throws; oversize values are clipped). */
export function structuredLog(fields: LogFields): void {
  void fields;
  throw new Error("not implemented");
}

/**
 * Structured executor logs (v2 design §2.6 (b)). Every executor logs one JSON
 * object per step with the trace fields, so Workers Logs
 * (`observability.enabled`) can filter a whole trace across Workflows.
 */
import { parseTraceparent, spanIdFor, type TraceContext } from "@queenos/queen-types";

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
export function traceFields(
  trace: TraceContext | undefined,
  commandId: string,
  step?: string,
): Pick<LogFields, "trace_id" | "span_id" | "parent_span_id"> {
  const parsed = trace ? parseTraceparent(trace.traceparent) : null;
  if (!parsed) return {};
  return {
    trace_id: parsed.traceId,
    span_id: spanIdFor(step === undefined ? commandId : `${commandId}/${step}`),
    parent_span_id: parsed.spanId,
  };
}

/** Longest string value kept in a log line (Workers Logs caps an invocation at 256 KB). */
export const MAX_LOG_VALUE_CHARS = 2000;

function clip(_key: string, value: unknown): unknown {
  if (typeof value === "string" && value.length > MAX_LOG_VALUE_CHARS) return `${value.slice(0, MAX_LOG_VALUE_CHARS)}…`;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message.slice(0, MAX_LOG_VALUE_CHARS) };
  return value;
}

/** `console.log` one JSON object (never throws; oversize values are clipped). */
export function structuredLog(fields: LogFields): void {
  try {
    console.log(JSON.stringify(fields, clip));
  } catch {
    try {
      console.log(JSON.stringify({ hive: fields.hive, trace_id: fields.trace_id, step: fields.step, log_error: "unserializable" }));
    } catch {
      /* logging must never break an executor */
    }
  }
}

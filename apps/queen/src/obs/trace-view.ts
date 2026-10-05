/**
 * Trace view (v2 design §2.7, §5.4): the span tree derived from a trace's
 * events. A command span starts at `command.issued` and ends at
 * `command.result`; item, train, car, gate and release spans run from their
 * first event to their last. A car carries several items, so its events are
 * recorded in each member's trace with the SAME span id (one car, many
 * traces): building each member's view yields the shared span under that
 * member's own parent.
 */
import type { QueenEvent, Span, SpanKind, TraceView } from "@queenos/queen-types";
import { TraceIdSchema } from "@queenos/queen-types";

const TERMINAL_WORDS = new Set([
  "LANDED", "SHIPPED", "FAILED", "CANCELLED", "DUPLICATE", "MERGED", "EJECTED", "SUPERSEDED", "ROLLED_BACK", "PASSED", "REJECTED", "DONE", "ok", "error",
]);

function kindOf(type: string): SpanKind {
  if (type.startsWith("command.")) return "command";
  if (type.startsWith("gate.")) return "gate";
  if (type.startsWith("queue.")) return "car";
  if (type.startsWith("release.") || type.startsWith("sentinel.")) return "release";
  if (type.startsWith("train.") || type.startsWith("race.") || type === "drone.audit") return "train";
  return "item";
}

const outcomeOf = (e: QueenEvent): string | null => {
  const d = e.data ?? {};
  for (const k of ["outcome", "to", "phase", "verdict"]) if (typeof d[k] === "string") return d[k] as string;
  return null;
};

/** Does this event close its span? */
function closes(e: QueenEvent): boolean {
  if (e.type === "command.result" || e.type === "gate.verdict" || e.type === "sentinel.verdict" || e.type === "queue.landed" || e.type === "race.decided") return true;
  const o = outcomeOf(e);
  return o !== null && TERMINAL_WORDS.has(o);
}

function nameOf(kind: SpanKind, first: QueenEvent): string {
  const d = first.data ?? {};
  if (kind === "command") {
    const action = typeof d.action === "string" ? d.action : typeof d.kind === "string" ? d.kind : "command";
    return `${action} ${first.commandId ?? ""}`.trim();
  }
  if (typeof d.name === "string") return d.name.slice(0, 120);
  return first.summary.slice(0, 120);
}

/** Linked trace ids named in any event's `data.links` (a release's items, a bug's cause). */
function linksOf(events: readonly QueenEvent[], self: string): string[] {
  const out = new Set<string>();
  for (const e of events) {
    const l = e.data?.links;
    if (!Array.isArray(l)) continue;
    for (const id of l) if (TraceIdSchema.safeParse(id).success && id !== self) out.add(id as string);
  }
  return [...out];
}

/**
 * Build the view for one trace. `events` may mix traces; only `traceId`'s
 * (default: the first event's) are used. Events without a span id still
 * appear in `events` but form no span.
 */
export function buildTraceView(events: readonly QueenEvent[], traceId?: string): TraceView {
  const id = traceId ?? events.find((e) => e.traceId)?.traceId ?? "";
  const mine = events.filter((e) => e.traceId === id).sort((a, b) => a.seq - b.seq);

  const bySpan = new Map<string, QueenEvent[]>();
  for (const e of mine) {
    if (!e.spanId) continue;
    const list = bySpan.get(e.spanId);
    if (list) list.push(e);
    else bySpan.set(e.spanId, [e]);
  }

  const spans: Span[] = [];
  for (const [spanId, evs] of bySpan) {
    const first = evs[0]!;
    const kind = kindOf(first.type);
    const closer = [...evs].reverse().find(closes);
    // Parent: the first event that names one (a car's first event may be the member-agnostic one).
    const parentSpanId = evs.find((e) => e.parentSpanId)?.parentSpanId ?? null;
    spans.push({
      spanId,
      parentSpanId: parentSpanId === spanId ? null : parentSpanId,
      name: nameOf(kind, first),
      kind,
      startTs: first.ts,
      endTs: closer ? closer.ts : null,
      outcome: closer ? (outcomeOf(closer) ?? (closer.type === "command.result" ? closer.summary.slice(0, 80) : null)) : null,
    });
  }
  spans.sort((a, b) => a.startTs - b.startTs);

  return { traceId: id, spans, events: mine, links: linksOf(mine, id) };
}

export interface SpanNode extends Span {
  children: SpanNode[];
}

/** Nest spans under their parents; spans whose parent is absent from the trace are roots. */
export function spanTree(spans: readonly Span[]): SpanNode[] {
  const nodes = new Map<string, SpanNode>(spans.map((s) => [s.spanId, { ...s, children: [] }]));
  const roots: SpanNode[] = [];
  for (const s of spans) {
    const node = nodes.get(s.spanId)!;
    const parent = s.parentSpanId ? nodes.get(s.parentSpanId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

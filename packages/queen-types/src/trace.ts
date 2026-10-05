import { z } from "zod";

/**
 * Trace model (v2 design §2.6). One W3C-format trace id per goal runs from
 * item → build → merge-queue car → gate → release → Sentinel. Our traces live
 * in the Queen's own `event_log` (platform tracing does not span a Workflow's
 * lifetime), so ids are minted deterministically and synchronously: the pure
 * planners can stamp them without I/O, a clock or randomness.
 */

/** 32 lowercase hex characters (W3C trace-id). */
export const TraceIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
/** 16 lowercase hex characters (W3C parent-id / span id). */
export const SpanIdSchema = z.string().regex(/^[0-9a-f]{16}$/);
/** `00-<traceId>-<spanId>-<flags>` (W3C traceparent, version 00). */
export const TraceparentSchema = z.string().regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
/** Carried as an optional `trace` field in every command and DroneTask (Workflow params). */
export const TraceContextSchema = z.object({
  traceparent: TraceparentSchema,
  tracestate: z.string().max(256).optional(),
});
export type TraceContext = z.infer<typeof TraceContextSchema>;

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const ZERO_SPAN = "0000000000000000";
const ZERO_TRACE = "00000000000000000000000000000000";

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;
const utf8 = new TextEncoder();

/** FNV-1a 64 over the UTF-8 bytes of `key`, as 16 lowercase hex characters (may be all zero). */
export function fnv1a64(key: string): string {
  let h = FNV64_OFFSET;
  for (const byte of utf8.encode(key)) {
    h ^= BigInt(byte);
    h = (h * FNV64_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, "0");
}

/**
 * Deterministic span id for a key (item id, train id, command id, `gate:<trainId>:<sha>`, ...):
 * FNV-1a 64 → 16 hex. Never all-zero (invalid in W3C): that one value maps to `0000000000000001`.
 */
export function spanIdFor(key: string): string {
  const h = fnv1a64(key);
  return h === ZERO_SPAN ? "0000000000000001" : h;
}

/**
 * Trace id for a root item or release: its UUID with the dashes removed, lowercased
 * (the same expression the v8/v9 migrations use in SQL, so backfills match).
 * Ids that are not UUID-shaped (tests, hand-made ids) get a deterministic 32-hex id
 * from two FNV-1a 64 hashes instead, so the result always validates.
 */
export function traceIdFromUuid(uuid: string): string {
  const plain = uuid.replace(/-/g, "").toLowerCase();
  if (HEX32.test(plain) && plain !== ZERO_TRACE) return plain;
  return `${fnv1a64(uuid)}${spanIdFor(`trace:${uuid}`)}`;
}

/** W3C traceparent, sampled (`-01`). */
export function traceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

/** Parse a version-00 traceparent; null when malformed or when either id is all-zero. */
export function parseTraceparent(tp: string): { traceId: string; spanId: string } | null {
  if (!TraceparentSchema.safeParse(tp).success) return null;
  const [, traceId, spanId] = tp.split("-") as [string, string, string, string];
  if (!HEX32.test(traceId) || !HEX16.test(spanId) || traceId === ZERO_TRACE || spanId === ZERO_SPAN) return null;
  return { traceId, spanId };
}

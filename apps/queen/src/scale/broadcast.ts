/**
 * Coalesced broadcast (v2 design §4.3, item 2). Messages queue per apply and
 * are flushed as one `batch` frame at the end of an apply if ≥ 100 ms have
 * passed since the last frame; otherwise a timer is scheduled for the
 * remainder (the DO stays resident while it is pending), and any later apply
 * flushes first. Per-entity dedupe: the last `train.updated` per train (and
 * the last item/race/escalation/release/hive update per id) wins inside a frame.
 *
 * WP0 seam; WP1.13 implements it, WP2.1 wires it into QueenNode.apply().
 */
import type { QueenServerMessage, QueenServerUnitMessage } from "@queenos/queen-types";

/** Minimum gap between frames. */
export const FRAME_INTERVAL_MS = 100;

export interface CoalescerOptions {
  /** Sends one frame to every socket (QueenNode.broadcast). */
  send: (frame: QueenServerMessage) => void;
  now: () => number;
  /** Schedules a flush (setTimeout in the DO; a fake in tests). Returns a cancel function. */
  schedule: (ms: number, fn: () => void) => () => void;
  /** Default FRAME_INTERVAL_MS. */
  intervalMs?: number;
  /** Default MAX_BATCH_MESSAGES (200); a longer queue is sent as several frames. */
  maxBatch?: number;
}

/** The dedupe key of a message, or null when every copy must be kept (events, errors, verdicts). */
export function entityKey(m: QueenServerUnitMessage): string | null {
  void m;
  throw new Error("not implemented");
}

export class Coalescer {
  constructor(readonly options: CoalescerOptions) {}

  /** Queue the messages of one apply. */
  push(messages: readonly QueenServerUnitMessage[]): void {
    void messages;
    throw new Error("not implemented");
  }

  /** End of an apply: send a frame now if the interval has passed, else schedule one. */
  endApply(): void {
    throw new Error("not implemented");
  }

  /** Send everything queued now (one `batch` frame; a single message may be sent bare). */
  flush(): void {
    throw new Error("not implemented");
  }

  /** Messages queued and not yet sent. */
  get pending(): number {
    throw new Error("not implemented");
  }
}

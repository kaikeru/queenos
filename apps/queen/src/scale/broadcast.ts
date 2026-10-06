/**
 * Coalesced broadcast (v2 design §4.3, item 2). Messages queue per apply and
 * are flushed as one `batch` frame (at most maxBatch messages; a longer backlog drains one frame per interval) at the end of an apply if ≥ 100 ms have
 * passed since the last frame; otherwise a timer is scheduled for the
 * remainder (the DO stays resident while it is pending), and any later apply
 * flushes first. Per-entity dedupe: the last `train.updated` per train (and
 * the last item/race/escalation/release/hive update per id) wins inside a frame.
 *
 * WP0 seam; WP1.13 implements it, WP2.1 wires it into QueenNode.apply().
 */
import { MAX_BATCH_MESSAGES, type QueenServerMessage, type QueenServerUnitMessage } from "@queenos/queen-types";

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
  /** Default MAX_BATCH_MESSAGES (200); a longer backlog drains one frame per interval. */
  maxBatch?: number;
}

/** The dedupe key of a message, or null when every copy must be kept (events, errors, verdicts). */
export function entityKey(m: QueenServerUnitMessage): string | null {
  switch (m.type) {
    case "train.updated":
      return `train:${m.train.trainId}`;
    case "prompt.updated":
      return `prompt:${m.promptRun.promptId}`;
    case "deployment.updated":
      return `deployment:${m.deployment.deploymentId}`;
    case "release.updated":
      return `release:${m.release.releaseId}`;
    case "item.updated":
      return `item:${m.item.itemId}`;
    case "race.updated":
      return `race:${m.race.raceId}`;
    case "escalation.updated":
      return `escalation:${m.escalation.escalationId}`;
    case "hive.updated":
      return "hive";
    case "models.updated":
      return "models";
    default:
      return null;
  }
}

export class Coalescer {
  private queue = new Map<string, QueenServerUnitMessage>();
  private unkeyed = 0;
  private lastFrameAt: number | null = null;
  private cancel: (() => void) | null = null;

  constructor(readonly options: CoalescerOptions) {}

  /** Queue the messages of one apply. */
  push(messages: readonly QueenServerUnitMessage[]): void {
    for (const m of messages) {
      const key = entityKey(m) ?? `#${this.unkeyed++}`;
      // Last write wins, and the survivor takes the latest position.
      this.queue.delete(key);
      this.queue.set(key, m);
    }
  }

  /** End of an apply: send a frame now if the interval has passed, else schedule one. */
  endApply(): void {
    if (this.queue.size === 0) return;
    const interval = this.options.intervalMs ?? FRAME_INTERVAL_MS;
    const elapsed = this.lastFrameAt === null ? Infinity : this.options.now() - this.lastFrameAt;
    if (elapsed >= interval) {
      this.flush();
    } else if (!this.cancel) {
      this.cancel = this.options.schedule(interval - elapsed, () => {
        this.cancel = null;
        this.flush();
      });
    }
  }

  /**
   * Send one frame now (up to maxBatch messages, oldest first; a single message may be sent bare).
   * A longer backlog is not sent back to back: the rest stays queued (last write still wins per
   * entity) and goes out on a timer one interval later, one frame per tick, so the >= interval gap
   * holds between every pair of frames, not just between flushes.
   */
  flush(): void {
    this.cancel?.();
    this.cancel = null;
    if (this.queue.size === 0) return;
    const max = this.options.maxBatch ?? MAX_BATCH_MESSAGES;
    const chunk: QueenServerUnitMessage[] = [];
    for (const [key, m] of this.queue) {
      if (chunk.length >= max) break;
      chunk.push(m);
      this.queue.delete(key);
    }
    this.lastFrameAt = this.options.now();
    this.options.send(chunk.length === 1 ? chunk[0]! : { type: "batch", messages: chunk });
    if (this.queue.size > 0) {
      const interval = this.options.intervalMs ?? FRAME_INTERVAL_MS;
      this.cancel = this.options.schedule(interval, () => {
        this.cancel = null;
        this.flush();
      });
    }
  }

  /** Messages queued and not yet sent. */
  get pending(): number {
    return this.queue.size;
  }
}

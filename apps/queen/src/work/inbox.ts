/**
 * Inbox intake (docs/human-push-design.md §2, §6.2; T1). Pure: no I/O, no clock
 * (callers pass `now`), no randomness. Every change arrives as a Submission;
 * this module decides what one becomes (a new item, a race entry, a reopened
 * item, a superseded train, or an ignored push). The Queen applies the decision
 * through db.ts (`insertSubmission`, `upsertInbox`, ...) and the planners.
 *
 * T0 seam: the contracts and signatures are fixed here; the bodies are T1's.
 */
import type {
  Guardrails,
  Submission,
  SubmissionTarget,
  SubmitDisposition,
  SubmitOutcomeKind,
  WorkItemInbox,
} from "@queenos/queen-types";
import type { InboxRecord, SubmissionRecord } from "../db";
import type { RaceRecord, WorkItemRecord } from "../records";

/** Thrown by every seam until T1 lands. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`not implemented: ${what} (human-push design T1)`);
    this.name = "NotImplementedError";
  }
}

/**
 * The inbox handle for `email` (§15 Q5): the local part stripped to `[a-z0-9]`, at most 24 chars;
 * on a collision (`taken`), 4 hex chars of a hash replace the tail.
 */
export function handleFor(email: string, taken: (handle: string) => boolean): string {
  void email;
  void taken;
  throw new NotImplementedError("handleFor");
}

/** What intake knows when a submission arrives (all read inside the Queen's transaction). */
export interface IntakeContext {
  now: number;
  guardrails: Guardrails;
  paused: boolean;
  /** The inbox the push landed in (null: unknown inbox). Drone submissions: null. */
  inbox: InboxRecord | null;
  /** An earlier submission of the same (repo, headSha): ignored:duplicate. */
  duplicate: SubmissionRecord | null;
  /** Earlier submissions of the same headSha in any repo (a Queen-written head: ignored:own-push). */
  sameHead: SubmissionRecord[];
  /** The latest applied submission on (repo, ref): the supersede key. */
  previousOnRef: SubmissionRecord | null;
  /** The item a target or the previous submission on this ref points at, and its race (if any). */
  item: WorkItemRecord | null;
  race: RaceRecord | null;
  /** For a `goal` target: the goal and its children. */
  goal: { item: WorkItemRecord; children: WorkItemRecord[] } | null;
  /** The contributor's open inbox items and pushes in the last hour (caps). */
  openItems: number;
  pushesLastHour: number;
}

/** What intake decided. `applied` decisions carry what to do; the rest are ignored with a reason. */
export type IntakeDecision =
  | { outcome: Exclude<SubmitOutcomeKind, "applied">; note?: string }
  | {
      outcome: "applied";
      disposition: SubmitDisposition;
      /** New item to file (filed / late-new-item / goal fan-in), or the item to link. */
      file?: { title: string; body: string; acceptance: string[]; parentId: string | null; inbox: WorkItemInbox | null };
      itemId?: string;
      /** Race to enter (joined-race), or the train to eject first (superseded). */
      raceId?: string;
      supersedeTrainId?: string;
    };

/** Decide one submission (§6.2 table, plus "the item is the inbox": targeted submissions join that item's race). */
export function decideIntake(sub: Submission, ctx: IntakeContext): IntakeDecision {
  void sub;
  void ctx;
  throw new NotImplementedError("decideIntake");
}

/** Resolve a target (§2.1): `item` as is; `goal` to its single child, else a new child of the goal. */
export function resolveTarget(target: SubmissionTarget, goal: IntakeContext["goal"]): { itemId: string } | { fileUnder: string } | null {
  void target;
  void goal;
  throw new NotImplementedError("resolveTarget");
}

/** An unsolicited submission's item fields: title = head subject, body = message, acceptance = `- ` lines under `Acceptance:`. */
export function itemFromMessage(title: string | undefined, message: string | undefined): { title: string; body: string; acceptance: string[] } {
  void title;
  void message;
  throw new NotImplementedError("itemFromMessage");
}

/**
 * Git intake (docs/human-push-design.md rev 2 §2, §4.3, §4.4, §6.2; T1). Pure: no I/O, no clock (callers
 * pass what they read), no randomness (callers pass ids). Every change arrives as a Submission; this module
 * decides what a push becomes:
 *
 * - `decideIntent`: the pre-receive decision for the git proxy's `gitIntent` (state rules only: dedupe,
 *   caps, unknown targets, `main`). Nothing is forked when it refuses.
 * - `decideIntake`: what an accepted push that landed in its train fork (`gitPushed`) becomes: a new item
 *   (`filed`, uncorrelated: "already won", no race), a race entry (`joined-race`), a reopened item, a
 *   superseded train, or a follow-up item (`late-new-item`).
 *
 * The Queen applies the decisions through the planners (TrainPlanner pre-forked trains, WorkPlanner
 * `fileSubmission` / `adoptSubmission`) and records every outcome in the v14 `submissions` table.
 */
import {
  parseSubmissionTrailers,
  targetFromRef,
  type Guardrails,
  type SubmissionOrigin,
  type SubmissionTarget,
  type SubmissionTrailers,
  type SubmitDisposition,
  type SubmitOutcomeKind,
  type WorkStatus,
} from "@queenos/queen-types";
import type { SubmissionRecord } from "../db";

/** Kept for the T0 seam; rev 2 throws it nowhere. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`not implemented: ${what} (human-push design T1)`);
    this.name = "NotImplementedError";
  }
}

const MAX_TITLE = 120;
const MAX_BODY = 4000;
const MAX_MESSAGE = 200;
const MAX_MESSAGES = 5;

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** The first 7 hex characters of a sha (push-output style). */
export function short(sha: string | null | undefined): string {
  return (sha ?? "").slice(0, 7);
}

/** At most 5 `remote:` lines of at most 200 characters each (GitIntakeDecision / GitPushedResult). */
export function remoteLines(lines: readonly (string | null | undefined | false)[]): string[] {
  return lines
    .filter((l): l is string => typeof l === "string" && l.trim() !== "")
    .map((l) => clip(l.replace(/[\r\n]+/g, " "), MAX_MESSAGE))
    .slice(0, MAX_MESSAGES);
}

/**
 * The WorkItemInbox `handle` for `email` (§15 Q5): the local part stripped to `[a-z0-9]`, at most 24 chars;
 * when `taken`, 4 hex chars of a hash replace the tail. Rev 2 has no inbox repos: the handle is display only.
 */
export function handleFor(email: string, taken: (handle: string) => boolean = () => false): string {
  const local = (email.split("@")[0] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24) || "user";
  if (!taken(local)) return local;
  let h = 2166136261;
  for (let i = 0; i < email.length; i++) h = Math.imul(h ^ email.charCodeAt(i), 16777619);
  const tag = (h >>> 0).toString(16).padStart(8, "0").slice(0, 4);
  return `${local.slice(0, 20)}${tag}`;
}

/** URL-ish slug of a title (`goal/<slug>` addressing): lowercase `[a-z0-9-]`, ≤ 64. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

const TRAILER_LINE = /^\s*queen(?:-[a-z]+)*\s*:/i;

/**
 * An uncorrelated submission's item fields (§6.2): title = head subject, body = the message without its
 * subject and without `Queen*` trailer lines, acceptance = the `- ` lines under an `Acceptance:` line
 * (≤ 8 of ≤ 200 chars).
 */
export function itemFromMessage(title: string | undefined, message: string | undefined): { title: string; body: string; acceptance: string[] } {
  const lines = (message ?? "").replace(/\r/g, "").split("\n");
  const subject = (title ?? "").replace(/\s+/g, " ").trim() || (lines.find((l) => l.trim()) ?? "").replace(/\s+/g, " ").trim() || "untitled push";
  const first = lines.findIndex((l) => l.trim() !== "");
  const rest = (first >= 0 ? lines.slice(first + 1) : []).filter((l) => !TRAILER_LINE.test(l));
  const acceptance: string[] = [];
  const at = rest.findIndex((l) => /^\s*acceptance(?: criteria)?\s*:\s*$/i.test(l));
  if (at >= 0) {
    for (const l of rest.slice(at + 1)) {
      const m = /^\s*[-*]\s+(.+?)\s*$/.exec(l);
      if (!m) {
        if (l.trim() === "") continue;
        break;
      }
      if (acceptance.length < 8) acceptance.push(clip(m[1]!, 200));
    }
  }
  return { title: clip(subject, MAX_TITLE), body: clip(rest.join("\n").trim(), MAX_BODY), acceptance };
}

/**
 * The head commit's trailers: `parseSubmissionTrailers(message)`, overlaid with the proxy's parsed
 * `trailers` (keys lowercased; the proxy's copy wins on a clash). Information only, never authority:
 * `Queen: rework` asks for a handoff, `Queen-Item` addresses an item, `Queen-Origin: agent:<name>` is a claim
 * within the token owner's accountability.
 */
export function trailersOf(message: string, extra: Record<string, string> = {}): SubmissionTrailers {
  const fromMessage = parseSubmissionTrailers(message);
  const raw: Record<string, string> = { ...fromMessage.raw };
  for (const [k, v] of Object.entries(extra)) if (/^queen(?:-[a-z]+)*$/i.test(k) && typeof v === "string") raw[k.toLowerCase()] = v.trim();
  const out: SubmissionTrailers = { rework: /^rework$/i.test(raw["queen"] ?? ""), raw };
  const item = raw["queen-item"];
  if (item && /^[A-Za-z0-9_-]{1,64}$/.test(item)) out.itemId = item;
  const agent = /^agent:([A-Za-z0-9._-]{1,64})$/i.exec(raw["queen-origin"] ?? "");
  if (agent) out.agent = agent[1]!;
  return out;
}

/** Whose code: the token owner, or an agent acting for them (`Queen-Origin: agent:<name>`). */
export function originOf(user: string, trailers: Pick<SubmissionTrailers, "agent">): SubmissionOrigin {
  return trailers.agent ? { kind: "agent", id: clip(`${trailers.agent}@${user}`, 320) } : { kind: "human", id: user };
}

// ── what intake knows about items ───────────────────────────────────────

/** An item as intake sees it (read inside the Queen's decision). */
export interface IntakeItem {
  itemId: string;
  kind: "goal" | "feature" | "bug" | "chore";
  status: WorkStatus;
  title: string;
  parentId: string | null;
  /** Its RACING race (a submission can join it), or null. */
  racing: { raceId: string; entryClosesAt: number | null } | null;
  /** Some train of the item passed, won its race, boarded a car or landed: its code is decided (late entry). */
  decided: boolean;
  /** An active BUILD train that is not a race candidate (joining one is post-Oct 14: late entry). */
  activeNonRace: boolean;
}

/** Look items and goals up (pure callers pass maps; the Queen passes SQL-backed lookups). */
export interface IntakeLookup {
  item(itemId: string): IntakeItem | null;
  /** A goal by item id or title slug, with its children (non-goal items). */
  goal(slug: string): { goal: IntakeItem; children: IntakeItem[] } | null;
}

/** A target resolved (§2.1, §4.4): an item, or "file a new item under this goal". */
export type ResolvedTarget = { itemId: string } | { fileUnder: string };

/**
 * Resolve a target: `item` as is (a goal named by `item/<id>` resolves as a goal); `goal` to its single
 * child, else a new child of the goal (no guessing). Null: unknown.
 */
export function resolveTarget(target: SubmissionTarget, lookup: IntakeLookup): ResolvedTarget | null {
  if (target.kind === "item") {
    const item = lookup.item(target.itemId);
    if (!item) return null;
    if (item.kind !== "goal") return { itemId: item.itemId };
    return resolveGoal(lookup.goal(item.itemId));
  }
  return resolveGoal(lookup.goal(target.goal));
}

function resolveGoal(g: { goal: IntakeItem; children: IntakeItem[] } | null): ResolvedTarget | null {
  if (!g) return null;
  return g.children.length === 1 ? { itemId: g.children[0]!.itemId } : { fileUnder: g.goal.itemId };
}

const LATE_STATUSES: ReadonlySet<WorkStatus> = new Set(["LANDED", "SHIPPED", "CANCELLED", "DUPLICATE"]);

/** Why a correlated submission to `item` cannot enter it (late entry, §2.5), or null when it can. */
export function lateReason(item: IntakeItem, now: number): string | null {
  if (LATE_STATUSES.has(item.status)) return `item ${item.itemId} is ${item.status.toLowerCase()}`;
  if (item.decided) return `item ${item.itemId} already decided`;
  if (item.racing) {
    if (item.racing.entryClosesAt !== null && now >= item.racing.entryClosesAt) return `item ${item.itemId}'s race is closed to entries`;
    return null;
  }
  if (item.status === "ACTIVE" || item.activeNonRace) return `item ${item.itemId} is already being built`;
  return null;
}

// ── gitIntent: the pre-receive decision ────────────────────────────────

export interface IntentInput {
  ref: string;
  newSha: string;
  /** The token owner (from the edge): the contributor caps and the supersede key are per email. */
  user: string;
}

/** A recorded submission plus what became of its train. */
export interface PriorSubmission {
  submission: SubmissionRecord;
  /** Its train is still active (not MERGED / EJECTED). */
  trainActive: boolean;
  /** Its train boarded a car, is LANDING or MERGED, or won/passed its race. */
  trainBoarded: boolean;
}

export interface IntentContext {
  now: number;
  guardrails: Guardrails;
  paused: boolean;
  budgetExhausted: boolean;
  /** Every applied or pending submission of `newSha` in this hive (the dedupe key is the head sha). */
  sameHead: SubmissionRecord[];
  /** The contributor's latest applied or pending submission on `ref` (the supersede key). */
  previousOnRef: PriorSubmission | null;
  lookup: IntakeLookup;
  /** The contributor's open pushed items, and their applied / pending pushes in the last hour. */
  openItems: number;
  pushesLastHour: number;
  /** Non-terminal items in the hive (maxOpenItems). */
  hiveOpenItems: number;
}

export type IntentDecision =
  | { verdict: "refuse"; outcome: Extract<SubmitOutcomeKind, `refused:${string}`>; reason: string; messages: string[] }
  | {
      verdict: "accept";
      /** The item the train is provisionally for (an existing item), or null: intake files one at gitPushed. */
      itemId: string | null;
      /** Pending intents of the same (user, ref) that this push replaces (a proxy that died, or a retry). */
      supersedeIntents: string[];
      messages: string[];
    };

function refuse(outcome: Extract<SubmitOutcomeKind, `refused:${string}`>, reason: string): IntentDecision {
  const r = clip(reason, MAX_MESSAGE);
  return { verdict: "refuse", outcome, reason: r, messages: remoteLines([`push refused: ${r}`]) };
}

/**
 * The pre-receive state rules (§4.3 "Queen" table): duplicate head, unknown `item/<id>` / `goal/<slug>`,
 * hourly and open-item caps (checked before the fork, so a flood costs no Artifacts operations), `main`.
 * A pause or a spent budget never refuses: the push is accepted and its item waits READY.
 */
export function decideIntent(input: IntentInput, ctx: IntentContext): IntentDecision {
  if (input.ref === "refs/heads/main") return refuse("refused:rule", "pushes to main are refused (the lander owns main)");
  const supersedeIntents: string[] = [];
  for (const s of ctx.sameHead) {
    if (s.outcome === "applied") return refuse("refused:duplicate", `already submitted as item ${s.itemId ?? "?"} (train ${s.trainId ?? "?"})`);
    if (s.outcome !== "pending") continue;
    // A retry of the same push (the proxy died after gitIntent): replace the stale intent.
    if (s.originId === input.user && s.ref === input.ref && s.trainId) supersedeIntents.push(s.trainId);
    else return refuse("refused:duplicate", `${short(input.newSha)} is already being submitted (train ${s.trainId ?? "?"})`);
  }
  const prev = ctx.previousOnRef;
  if (prev?.submission.outcome === "pending" && prev.submission.trainId && !supersedeIntents.includes(prev.submission.trainId)) {
    supersedeIntents.push(prev.submission.trainId);
  }

  const target = targetFromRef(input.ref);
  let itemId: string | null = null;
  let filesNew = target === null;
  if (target) {
    const resolved = resolveTarget(target, ctx.lookup);
    if (!resolved) {
      return refuse("refused:unknown-item", target.kind === "item" ? `no item ${target.itemId} in this hive` : `no goal ${target.goal} in this hive`);
    }
    if ("itemId" in resolved) {
      const item = ctx.lookup.item(resolved.itemId)!;
      itemId = item.itemId;
      filesNew = lateReason(item, ctx.now) !== null;
    } else {
      filesNew = true;
    }
  }
  // A re-push of a submission still in flight replaces it (same item); after boarding it files a follow-up.
  if (prev?.submission.outcome === "applied" && prev.submission.itemId) {
    const item = ctx.lookup.item(prev.submission.itemId);
    if (item && !prev.trainBoarded && !LATE_STATUSES.has(item.status)) {
      itemId = item.itemId;
      filesNew = false;
    } else {
      filesNew = true;
    }
  }

  const g = ctx.guardrails;
  if (ctx.pushesLastHour >= g.maxInboxPushesPerHour) {
    return refuse("refused:over-cap", `over cap: ${ctx.pushesLastHour} pushes in the last hour (max ${g.maxInboxPushesPerHour}); wait`);
  }
  if (filesNew && ctx.openItems >= g.maxInboxOpenPerContributor) {
    return refuse("refused:over-cap", `over cap: ${ctx.openItems} open items; wait for a verdict`);
  }
  if (filesNew && ctx.hiveOpenItems >= g.maxOpenItems) {
    return refuse("refused:over-cap", `over cap: the hive has ${ctx.hiveOpenItems} open items (maxOpenItems ${g.maxOpenItems})`);
  }
  return {
    verdict: "accept",
    itemId,
    supersedeIntents,
    messages: remoteLines([ctx.paused ? "queued: hive paused (your submission waits until it resumes)" : null, ctx.budgetExhausted ? "queued: today's budget is spent" : null]),
  };
}

// ── gitPushed: what a landed push becomes ──────────────────────────────

export interface IntakeInput {
  ref: string;
  headSha: string;
  title: string;
  message: string;
  trailers: SubmissionTrailers;
  /** The pre-allocated item id of the intent (used when intake files a new item). */
  newItemId: string;
}

export interface IntakeContext {
  now: number;
  lookup: IntakeLookup;
  /** The contributor's previous APPLIED submission on this ref (not this push), and its train. */
  previousOnRef: PriorSubmission | null;
}

/** Fields of a new item intake files (kind `feature`, READY, skipping TRIAGE; `paths: []`). */
export interface FileSpec {
  itemId: string;
  title: string;
  body: string;
  acceptance: string[];
  parentId: string | null;
}

export interface IntakePlan {
  disposition: SubmitDisposition;
  /** The item the pushed train belongs to. */
  itemId: string;
  /** A new item to file first (filed / late-new-item / a goal with ≠ 1 child). */
  file?: FileSpec;
  /** FAILED → READY with attempts + 1 (a re-push to a failed item). */
  reopen: boolean;
  /** Correlated: the train enters the item's race (`join`: that RACING race; `create`: a new width-1 race). */
  race: { join: string } | { create: true } | null;
  /** The contributor's previous train on this ref, ejected first (no attempt charged). */
  supersedeTrainId?: string;
  /** `remote:` lines for the push output. */
  messages: string[];
}

function followUp(item: IntakeItem, input: IntakeInput, why: string): IntakePlan {
  const text = itemFromMessage(input.title, input.message);
  const title = clip(`${clip(item.title, MAX_TITLE - 12)} (follow-up)`, MAX_TITLE);
  return {
    disposition: "late-new-item",
    itemId: input.newItemId,
    file: { itemId: input.newItemId, title, body: clip([text.title, text.body].filter(Boolean).join("\n\n"), MAX_BODY), acceptance: text.acceptance, parentId: item.parentId },
    reopen: false,
    race: null,
    messages: remoteLines([`${why}; filed follow-up item ${input.newItemId}`]),
  };
}

function fileNew(input: IntakeInput, parentId: string | null, note?: string): IntakePlan {
  const text = itemFromMessage(input.title, input.message);
  return {
    disposition: "filed",
    itemId: input.newItemId,
    file: { itemId: input.newItemId, title: text.title, body: text.body, acceptance: text.acceptance, parentId },
    reopen: false,
    race: null,
    messages: remoteLines([note, `submission received → item ${input.newItemId} "${clip(text.title, 80)}" (new item, fully gated)`]),
  };
}

/** A submission entering an existing item: its race, a new width-1 race (its next attempt), or the item's own slot. */
function enter(item: IntakeItem, input: IntakeInput, now: number, correlated: boolean, previous?: PriorSubmission): IntakePlan {
  const supersede = previous && previous.trainActive && previous.submission.trainId ? previous.submission.trainId : undefined;
  if (supersede) {
    // The contributor's own train is the item's active build: it is replaced, not raced (no attempt charged).
    return {
      disposition: "superseded",
      itemId: item.itemId,
      reopen: item.status === "FAILED",
      race: item.racing ? { join: item.racing.raceId } : null,
      supersedeTrainId: supersede,
      messages: remoteLines([
        `replaces your earlier push ${short(previous!.submission.headSha)} (train ${supersede})`,
        `submission received → item ${item.itemId} "${clip(item.title, 80)}"`,
      ]),
    };
  }
  const late = lateReason(item, now);
  if (late) return followUp(item, input, late);
  const reopen = item.status === "FAILED";
  const race: IntakePlan["race"] = item.racing ? { join: item.racing.raceId } : correlated ? { create: true } : null;
  const disposition: SubmitDisposition = reopen && (previous || !correlated) ? "reopened" : correlated ? "joined-race" : "reopened";
  return {
    disposition,
    itemId: item.itemId,
    reopen,
    race,
    messages: remoteLines([`submission received → item ${item.itemId} "${clip(item.title, 80)}"${race ? " (joined its race)" : reopen ? " (reopened)" : ""}`]),
  };
}

/**
 * Decide one landed push (§6.2 table, §2.5, §4.4):
 * 1. A re-push of the contributor's branch: before boarding it supersedes the earlier train (same item);
 *    after boarding (or once the item landed) it files a follow-up item; a FAILED item is reopened.
 * 2. Correlated (`item/<id>`, `goal/<slug>`, or a `Queen-Item` trailer on another branch): enter that
 *    item's race (created lazily at width 1), or a follow-up item when late. An unknown `Queen-Item`
 *    files a new item and says so.
 * 3. Uncorrelated: a new `feature` item, "already won" (no race record), fully gated.
 */
export function decideIntake(input: IntakeInput, ctx: IntakeContext): IntakePlan {
  const prev = ctx.previousOnRef;
  const branchTarget = targetFromRef(input.ref);
  if (prev?.submission.itemId) {
    const item = ctx.lookup.item(prev.submission.itemId);
    if (item) {
      if (prev.trainBoarded || LATE_STATUSES.has(item.status)) {
        return followUp(item, input, `your earlier push ${short(prev.submission.headSha)} already ${LATE_STATUSES.has(item.status) ? item.status.toLowerCase() : "boarded a car"}`);
      }
      return enter(item, input, ctx.now, prev.submission.target !== null || branchTarget !== null, prev);
    }
  }
  let note: string | undefined;
  let target = branchTarget;
  if (!target && input.trailers.itemId) target = { kind: "item", itemId: input.trailers.itemId };
  if (target) {
    const resolved = resolveTarget(target, ctx.lookup);
    if (!resolved) {
      if (branchTarget) note = `${branchTarget.kind === "item" ? `item ${branchTarget.itemId}` : `goal ${branchTarget.goal}`} no longer exists; filed a new item`;
      else note = `Queen-Item ${input.trailers.itemId} not found; filed a new item`;
      return fileNew(input, null, note);
    }
    if ("fileUnder" in resolved) return fileNew(input, resolved.fileUnder);
    return enter(ctx.lookup.item(resolved.itemId)!, input, ctx.now, true);
  }
  return fileNew(input, null);
}

/** The verdict-note pointer every accepted push prints. */
export const NOTES_HINT = "git fetch origin '+refs/notes/*:refs/notes/*' && git log --notes=verdict -1";

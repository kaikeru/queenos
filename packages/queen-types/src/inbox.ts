import { z } from "zod";
import { BuildUsageSchema } from "./train.js";
import { FollowUpSchema } from "./work.js";

/**
 * The inbox and unified intake (docs/human-push-design.md §2, §5). Every change
 * arrives as a Submission ("here's code, vet it"): drone-written code from a
 * train fork the Queen asked for, or a human's (or their agent's) `git push` to
 * their persistent inbox fork `<hive>-in-<handle>`. Provenance is metadata only,
 * never a separate code path.
 */

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const BranchRef = z.string().regex(/^refs\/heads\/.+/);

/** An inbox handle: the owner's email local part, stripped to `[a-z0-9]`, ≤ 24 chars (§15 Q5). */
export const InboxHandleSchema = z.string().regex(/^[a-z0-9]{1,24}$/);

export const SubmissionOriginKindSchema = z.enum(["drone", "human", "agent"]);
export type SubmissionOriginKind = z.infer<typeof SubmissionOriginKindSchema>;

export const SubmissionOriginSchema = z.object({
  kind: SubmissionOriginKindSchema,
  /** drone: drone Workflow instance id; human: Access email; agent: "<name>@<owner email>". */
  id: z.string().min(1).max(320),
});
export type SubmissionOrigin = z.infer<typeof SubmissionOriginSchema>;

/** Metadata only (races, rework counts, router stats, Model Board). Never a code path. */
export const SubmissionProvenanceSchema = z
  .object({
    trainId: z.string(),
    raceId: z.string().nullable(),
    candidate: z.number().int().min(0),
    attempt: z.number().int().min(0),
    action: z.enum(["BUILD", "REWORK", "PIN"]),
    /** Absent for human code: the router counts catalog models only, so human code never moves the floor. */
    model: z.string(),
    failedModels: z.array(z.string()).max(5),
    usage: BuildUsageSchema,
    verified: z.boolean(),
    buildMs: z.number().int().min(0),
    followUps: z.array(FollowUpSchema).max(5),
    /** Inbox origin: the push event id (day1 row 8b) and the head commit's trailers. */
    eventId: z.string(),
    trailers: z.record(z.string(), z.string()),
  })
  .partial();
export type SubmissionProvenance = z.infer<typeof SubmissionProvenanceSchema>;

/**
 * A submission need not be correlated. Absent `target` and `itemId`: uncorrelated (disposition `filed`).
 * What a submission addresses (user decision 2026-10-07: "the item is the competition, and the item is
 * the inbox"). Every submission that targets an item enters THAT item's race as a candidate.
 * - `item`: branch `item/<itemId>`, or a `Queen-Item: <itemId>` trailer.
 * - `goal`: branch `goal/<goal>` (`goal` = the goal's item id or title slug). The Queen resolves it to the
 *   goal's single child item when it has exactly one; otherwise it files a new item under that goal (no guessing).
 * Absent: unsolicited; intake files a new item.
 */
export const SubmissionTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("item"), itemId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("goal"), goal: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }),
]);
export type SubmissionTarget = z.infer<typeof SubmissionTargetSchema>;

export const SubmissionSchema = z.object({
  hive: z.string().min(1),
  /** The fork the code is in: a train fork (drone) or an inbox fork. */
  repo: z.string().min(1),
  ref: BranchRef,
  headSha: Sha,
  /** Merge base with hive main (gate diff base); the PIN drone fills it for inbox code. */
  baseSha: Sha.optional(),
  origin: SubmissionOriginSchema,
  /** Solicited (or targeted with Queen-Item / item/<id>): link. Absent: intake files an item. */
  itemId: z.string().max(64).optional(),
  /** What an external submission addressed (branch name or trailer); the Queen resolves it to `itemId`. */
  target: SubmissionTargetSchema.optional(),
  /** Head commit subject (≤120) and message (≤4000): the intent of unsolicited code. */
  title: z.string().max(120).optional(),
  message: z.string().max(4000).optional(),
  changedPaths: z.array(z.string().max(200)).max(200).optional(),
  provenance: SubmissionProvenanceSchema.default({}),
});
export type Submission = z.infer<typeof SubmissionSchema>;
export type SubmissionInput = z.input<typeof SubmissionSchema>;

/**
 * @deprecated Rev 1 (per-contributor inbox forks). Rev 2 uses the git proxy and one fork per push; kept exported
 * so nothing breaks, unused (human-push design §5).
 * A contributor's inbox (row of `inboxes`; `openItems` is counted, not stored). */
export const InboxSchema = z.object({
  hive: z.string(),
  /** The owner (Access email): the accountable contributor, never the commit author. */
  email: z.string(),
  handle: InboxHandleSchema,
  repo: z.string(),
  createdAt: z.number().int(),
  revokedAt: z.number().int().nullable(),
  openItems: z.number().int().min(0),
});
export type Inbox = z.infer<typeof InboxSchema>;

/**
 * @deprecated Rev 1; unused in rev 2 (see {@link InboxSchema}).
 * The edge's `POST /api/hives/:hive/inbox` response. Carries a token: never stored, logged or broadcast. */
export const InboxOpenResultSchema = z.object({
  handle: z.string(),
  repo: z.string(),
  remote: z.string().url(),
  username: z.literal("queen"),
  /** The write token with `?expires=` stripped (Basic auth password). */
  password: z.string(),
  /** ISO 8601. */
  expiresAt: z.string(),
  /** Inbox `main` after the fast-forward to hive main. */
  mainSha: z.string(),
});
export type InboxOpenResult = z.infer<typeof InboxOpenResultSchema>;

export const SubmitOutcomeKindSchema = z.enum([
  "applied",
  "ignored:duplicate",
  "ignored:own-push",
  "ignored:inbox-main",
  "ignored:unknown-inbox",
  "ignored:revoked",
  "ignored:over-cap",
  "ignored:paused",
  // v2 (git proxy): refused at push time, or the intake aborted. `ignored:inbox-main|unknown-inbox|revoked`
  // above stay for old rows and are unused.
  "refused:duplicate",
  "refused:over-cap",
  "refused:unknown-item",
  "refused:rule",
  "aborted:transient",
  // v2 (T1): an accepted `gitIntent` whose `gitPushed` has not arrived yet (becomes `applied` or `aborted:transient`).
  "pending",
]);
export type SubmitOutcomeKind = z.infer<typeof SubmitOutcomeKindSchema>;

/**
 * What an applied submission became.
 * - `filed`: uncorrelated (no target). It has already "won": a new item with NO race record, whose one
 *   train goes straight to gate → car → land. Won means no competition, not no vetting: every gate
 *   (policy, security, smoke, reviewer) still runs.
 * - `joined-race`: correlated; it entered the targeted item's race as a candidate (a race record is created
 *   lazily, width 1, if the item had none).
 * - `reopened`: a re-push to a FAILED inbox item. `superseded`: a re-push replaced a train not yet in a car.
 * - `late-new-item`: it targeted an item whose race was already decided
 * (entry closed) or whose code is already in a car / landed, so it was filed as a new follow-up item
 * (never silently dropped, never rejected).
 */
export const SubmitDispositionSchema = z.enum(["filed", "joined-race", "reopened", "superseded", "late-new-item"]);
export type SubmitDisposition = z.infer<typeof SubmitDispositionSchema>;

/** The Queen's answer to `submit(Submission)`. */
export const SubmitOutcomeSchema = z.object({
  outcome: SubmitOutcomeKindSchema,
  /** With `applied`. */
  disposition: SubmitDispositionSchema.optional(),
  itemId: z.string().optional(),
  trainId: z.string().optional(),
});
export type SubmitOutcome = z.infer<typeof SubmitOutcomeSchema>;

// ── naming ──────────────────────────────────────────────────────────────

/** `<hive>-in-<handle>`: the only repo names `InboxKeys` mints tokens for (§4, §8). */
export function inboxRepoName(hive: string, handle: string): string {
  return `${hive}-in-${handle}`;
}

/** Any inbox repo name (the handle has no `-`, so the last `-in-` splits it unambiguously). */
export const INBOX_REPO_RE = /^(.+)-in-([a-z0-9]{1,24})$/;

/** `{hive, handle}` of an inbox repo name, or null for any other repo (a hive or a train fork). */
export function parseInboxRepo(repo: string): { hive: string; handle: string } | null {
  const m = INBOX_REPO_RE.exec(repo);
  return m ? { hive: m[1]!, handle: m[2]! } : null;
}

// ── head-commit trailers (§3.4) ─────────────────────────────────────────

/** What the head commit's trailers ask for. */
export interface SubmissionTrailers {
  /** `Queen: rework`: hand off to the swarm automatically on a reject. */
  rework: boolean;
  /** `Queen-Item: <itemId>`: target an existing item. */
  itemId?: string;
  /** `Queen-Origin: agent:<name>`: an agent wrote this (a claim within the inbox owner's accountability). */
  agent?: string;
  /** Every `Queen*` trailer, keys lowercased (Submission `provenance.trailers`). */
  raw: Record<string, string>;
}

/** `Queen`, `Queen-Item`, `Queen-Replies-To`, ... (any number of `-segment`s), a colon, a value. */
export const TRAILER_RE = /^(queen(?:-[a-z]+)*)\s*:\s*(.+?)\s*$/i;

/**
 * Parse the `Queen`, `Queen-Item` and `Queen-Origin` trailers of a commit message (case-insensitive keys,
 * any line of the message; the last occurrence wins). Pure; shared by the gatekeepers and the Queen.
 */
export function parseSubmissionTrailers(message: string): SubmissionTrailers {
  const raw: Record<string, string> = {};
  for (const line of message.split("\n")) {
    const m = TRAILER_RE.exec(line.trim());
    if (m) raw[m[1]!.toLowerCase()] = m[2]!;
  }
  const out: SubmissionTrailers = { rework: /^rework$/i.test(raw["queen"] ?? ""), raw };
  const item = raw["queen-item"];
  if (item && /^[A-Za-z0-9_-]{1,64}$/.test(item)) out.itemId = item;
  const agent = /^agent:([A-Za-z0-9._-]{1,64})$/i.exec(raw["queen-origin"] ?? "");
  if (agent) out.agent = agent[1]!;
  return out;
}

/** The target a branch name expresses (`item/<itemId>` or `goal/<goal>`), or null (unsolicited). */
export function targetFromRef(ref: string): SubmissionTarget | null {
  const m = /^refs\/heads\/(item|goal)\/([A-Za-z0-9_-]{1,64})$/.exec(ref);
  if (!m) return null;
  return m[1] === "item" ? { kind: "item", itemId: m[2]! } : { kind: "goal", goal: m[2]! };
}

/** The item a branch named `item/<itemId>` targets, or null. */
export function itemIdFromRef(ref: string): string | null {
  const m = /^refs\/heads\/item\/([A-Za-z0-9_-]{1,64})$/.exec(ref);
  return m ? m[1]! : null;
}

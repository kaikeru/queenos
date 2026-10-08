import { z } from "zod";
import { HiveSlugSchema } from "./onboarding.js";
import { SubmitDispositionSchema } from "./inbox.js";
import { NotesRefSchema } from "./notes.js";

/**
 * Git intake contracts (docs/human-push-design.md §5): the git proxy Worker (`apps/git`) talks to the Queen
 * over DO RPC with these shapes: `gitIntent` -> GitIntakeDecision, `gitPushed` -> GitPushedResult,
 * `gitAborted`, `notesFor` -> NotesProjection. Identity (`user`) comes from the edge, never the client.
 */

const Sha40 = z.string().regex(/^[0-9a-f]{40}$/);

/** `gitIntent(intent)`: a push the proxy has parsed but not yet forwarded. */
export const GitPushIntentSchema = z.object({
  hive: HiveSlugSchema,
  user: z.string().email(),
  ref: z.string().regex(/^refs\/heads\/.+/),
  oldSha: Sha40,
  newSha: Sha40,
});
export type GitPushIntent = z.infer<typeof GitPushIntentSchema>;

export const GitIntakeDecisionSchema = z.discriminatedUnion("verdict", [
  z.object({
    verdict: z.literal("accept"),
    trainId: z.string(),
    /** The pre-forked train repo, `<hive>-train-<12hex>`. */
    repo: z.string(),
    messages: z.array(z.string().max(200)).max(5),
  }),
  z.object({
    verdict: z.literal("refuse"),
    reason: z.string().max(200),
    messages: z.array(z.string().max(200)).max(5),
  }),
]);
export type GitIntakeDecision = z.infer<typeof GitIntakeDecisionSchema>;

/** `gitPushed(...)`: the push landed in the train fork; the proxy has read the head commit. */
export const GitPushedSchema = z.object({
  hive: HiveSlugSchema,
  trainId: z.string(),
  repo: z.string(),
  ref: z.string(),
  headSha: Sha40,
  /** Hive main at fork time (the gate computes the merge base). */
  baseSha: Sha40,
  title: z.string().max(120),
  message: z.string().max(4000),
  trailers: z.record(z.string(), z.string()),
});
export type GitPushed = z.infer<typeof GitPushedSchema>;

export const GitPushedResultSchema = z.object({
  disposition: SubmitDispositionSchema,
  itemId: z.string(),
  messages: z.array(z.string().max(200)).max(5),
});
export type GitPushedResult = z.infer<typeof GitPushedResultSchema>;

/** `gitAborted(...)`: the push failed after intent (fork, upstream or size trouble); the Queen cleans up. Not in the doc's snippet: shape chosen in T0b. */
export const GitAbortedSchema = z.object({
  hive: HiveSlugSchema,
  trainId: z.string(),
  reason: z.string().max(200),
});
export type GitAborted = z.infer<typeof GitAbortedSchema>;

/** A git token as listed (never carries the secret). */
export const GitTokenSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  scopes: z.array(z.enum(["read", "push"])).min(1),
  /** The minter's note (e.g. "laptop"); null when none was given. Optional: older edges omitted it. */
  label: z.string().max(80).nullable().optional(),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  lastUsedAt: z.number().int().nullable(),
  revokedAt: z.number().int().nullable(),
});
export type GitToken = z.infer<typeof GitTokenSchema>;

/** Shown once at mint; never stored (only its hash is). */
export const GitTokenMintResultSchema = GitTokenSchema.extend({ token: z.string() });
export type GitTokenMintResult = z.infer<typeof GitTokenMintResultSchema>;

/** `notesFor(hive, ref)`: the ledger projection the proxy turns into a notes commit. */
export const NotesProjectionSchema = z.object({
  ref: NotesRefSchema,
  /** Ledger version: the cache key. */
  version: z.number().int(),
  notes: z.array(z.object({ sha: Sha40, text: z.string().max(8000) })).max(1000),
});
export type NotesProjection = z.infer<typeof NotesProjectionSchema>;

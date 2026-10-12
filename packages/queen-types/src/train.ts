import { z } from "zod";
import { ENTRY_WINDOW_MAX_MS, FollowUpSchema, PrioritySchema, RaceJudgeSchema } from "./work.js";

export const TrainStateSchema = z.enum(["BUILDING", "TESTING", "MERGED", "EJECTED"]);
export type TrainState = z.infer<typeof TrainStateSchema>;

/**
 * Queen-internal train lifecycle, exposed so the War Room can show *why* a
 * train is BUILDING or TESTING. `status` is derived from it:
 * WAITING_PARENT/BUILDING -> BUILDING; DEPLOYING/TESTING/PASSED/LANDING -> TESTING.
 *
 * DEPLOYING: the builder pushed and the Herald is deploying the train head to
 * its per-train Worker Preview. Gatekeepers wait for TESTING, then smoke-test
 * `MergeTrain.previewUrl`.
 */
export const TrainPhaseSchema = z.enum([
  "WAITING_PARENT",
  "BUILDING",
  "DEPLOYING",
  "TESTING",
  "PASSED",
  "LANDING",
  "MERGED",
  "EJECTED",
]);
export type TrainPhase = z.infer<typeof TrainPhaseSchema>;

/** Input: a user submits a prompt into a namespace. */
export const SubmitPromptSchema = z.object({
  namespace: z.string().min(1),
  promptText: z.string().min(1),
  /**
   * v2: file one `goal` item and let the Oracle decompose it. Absent = false
   * (v1 semantics: one `feature` item), so old payloads parse unchanged.
   */
  decompose: z.boolean().optional(),
  /** v2: explicit race width (best-of-N) for the filed item(s). */
  bestOf: z.number().int().min(1).max(5).optional(),
  /** v2: item priority (0..3 = P0..P3; default 2). */
  priority: PrioritySchema.optional(),
  /** `human` ("you pick"): a race of the filed item waits for a human pick (§10.2). Inert until T9a. */
  judge: RaceJudgeSchema.optional(),
  /**
   * MCP `create_goal` (external hives): the entry window of the race the filed item's first push opens, instead of
   * `settings.race.entryWindowMs`. Stored on the item (goal and its child).
   */
  entryWindowMs: z.number().int().min(0).max(ENTRY_WINDOW_MAX_MS).optional(),
});
export type SubmitPrompt = z.infer<typeof SubmitPromptSchema>;

/**
 * Scribe compaction (<= 2 sentences). The Queen never sees raw logs,
 * only these summaries.
 */
export const ScribeSummarySchema = z.object({
  promptId: z.string().min(1).optional(),
  trainId: z.string().min(1).optional(),
  summary: z.string().max(500),
});
export type ScribeSummary = z.infer<typeof ScribeSummarySchema>;

/**
 * v2: how well a gated change scored (race ranking, §2.3.6). Cars report
 * `review: "skipped"` (the integration gate has no reviewer).
 */
export const GateScoreSchema = z.object({
  review: z.enum(["approved", "skipped", "off"]),
  /** Acceptance criteria the reviewer found satisfied / missing. */
  satisfied: z.number().int().min(0),
  missing: z.number().int().min(0),
  changedFiles: z.number().int().min(0),
  changedBytes: z.number().int().min(0),
  /** Gate checks run. */
  checks: z.number().int().min(0),
});
export type GateScore = z.infer<typeof GateScoreSchema>;

/** A drone or gatekeeper reporting a train's TESTING outcome. */
export const TrainResultSchema = z.object({
  trainId: z.string().min(1),
  passed: z.boolean(),
  /** Scribe's <=2-sentence compaction. */
  summary: z.string().max(500),
  commitSha: z.string().min(1).optional(),
  /** v2: the gate's score (absent from pre-v2 gatekeepers: the Queen decides on pass/fail alone). */
  score: GateScoreSchema.optional(),
  /** v2: findings in paths outside the diff, filed as bugs (they do not fail the gate). */
  followUps: z.array(FollowUpSchema).max(3).optional(),
  /**
   * v2: a builder drone that could not run for infrastructure reasons (Workers AI rate limits that outlasted
   * every retry). Not a verdict: the Queen re-dispatches the drone (no rework, no model failure, the router
   * floor untouched). Only with `passed: false`.
   * Gatekeepers send it too (no `commandId`) when the GATE itself could not run (Artifacts / Cloudflare
   * 5xx, 429): the train is in TESTING, so the Queen re-deploys the preview after a backoff and the
   * gatekeeper re-gates; past the infra-retry cap the item gets EXECUTOR_LOST, never REWORK_EXHAUSTED.
   */
  cause: z.literal("infra").optional(),
  /** The reporting drone's Workflow instance id. With `cause`, a report from a superseded attempt is ignored. */
  commandId: z.string().min(1).max(200).optional(),
  /**
   * Gatekeepers: the Queen-started gate that judged it (`GateCommand.commandId`). A report naming another gate
   * than the train's current one (a replaced gate, re-dispatched by the watchdog) is ignored as stale. Absent
   * (a push-triggered gate, an older gatekeeper): accepted as before.
   */
  gateId: z.string().min(1).max(200).optional(),
  /**
   * Gatekeepers, BUILD lane: every path the train changed against its diff base (`changedBetween(baseSha, head)`:
   * added, modified and deleted), sorted, capped at 200. The Queen widens the item's path claims with it.
   */
  changedPaths: z.array(z.string().max(200)).max(200).optional(),
});
export type TrainResult = z.infer<typeof TrainResultSchema>;

/** Token usage of one build. The tool-loop agent re-sends its transcript every step, so input dominates. */
export const BuildUsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  /** Tool-loop steps (model calls) for the agent harness; absent for single-shot builds. */
  steps: z.number().int().min(0).optional(),
});
export type BuildUsage = z.infer<typeof BuildUsageSchema>;

/** A builder drone reporting that it pushed the train head to its fork. */
export const BuildResultSchema = z.object({
  trainId: z.string().min(1),
  headSha: z.string().min(1),
  /** Model that actually produced the change set (after any fallbacks). */
  model: z.string().optional(),
  /** Models tried before `model` that failed to produce a valid change set. */
  failedModels: z.array(z.string()).max(5).optional(),
  /** Wall time of generation + commit + push. */
  buildMs: z.number().int().min(0).optional(),
  /** LLM tokens spent on the whole build, across every model tried (absent for scripted drones). */
  usage: BuildUsageSchema.optional(),
  /** v2: the builder's own `verify` tool passed. */
  verified: z.boolean().optional(),
  /** v2: out-of-scope problems the builder noticed (never its own unfinished work). */
  followUps: z.array(FollowUpSchema).max(5).optional(),
  /** v2: paths changed vs the fork base; they widen the item's path claims. */
  changedPaths: z.array(z.string().max(200)).max(200).optional(),
});
export type BuildResult = z.infer<typeof BuildResultSchema>;

/**
 * A lander drone reporting the outcome of pushing a train head to the hive's
 * main branch. There is no merge API in Artifacts, so landing is a git push.
 */
export const LandResultSchema = z
  .object({
    trainId: z.string().min(1),
    landed: z.boolean(),
    /** The hive main SHA after the push. Required when `landed` is true. */
    mainSha: z.string().min(1).optional(),
    /** Scribe's <=2-sentence compaction. */
    summary: z.string().max(500).default(""),
    /** With `landed: false`: a transient infrastructure error outlasted the drone's retries; the Queen re-dispatches the lander (not a non-fast-forward). */
    cause: z.literal("infra").optional(),
    /** The reporting drone's Workflow instance id; with `cause`, a report from a superseded attempt is ignored. */
    commandId: z.string().min(1).optional(),
  })
  .refine((r) => !r.landed || r.mainSha !== undefined, {
    message: "mainSha is required when landed is true",
    path: ["mainSha"],
  });
export type LandResult = z.infer<typeof LandResultSchema>;
export type LandResultInput = z.input<typeof LandResultSchema>;

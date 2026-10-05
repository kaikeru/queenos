import { z } from "zod";
import { DeploymentSchema } from "./executors.js";
import { ReleaseSchema, SentinelVerdictSchema } from "./releases.js";
import { ModelStatsSchema, RouterFloorSchema } from "./models.js";
import { AuditEventSchema, MergeTrainSchema, PromptRunSchema } from "./state.js";
import { SubmitPromptSchema } from "./train.js";
import { EscalationSchema, HiveStatusSchema } from "./autonomy.js";
import { QueenEventSchema } from "./observability.js";
import { RaceSchema, WorkItemSchema } from "./work.js";

/** Max messages in one coalesced `batch` frame (§4.3). */
export const MAX_BATCH_MESSAGES = 200;

/**
 * Every server message except `batch`. A `batch` frame carries these (never a
 * nested batch), so the union stays non-recursive.
 */
export const QueenServerUnitMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    promptRuns: z.array(PromptRunSchema),
    trains: z.array(MergeTrainSchema),
    recentAudit: z.array(AuditEventSchema),
    /**
     * Per-train previews and (from P3) per-environment rows. Optional so older
     * Queens and hand-built snapshots stay valid; treat a missing value as [].
     */
    deployments: z.array(DeploymentSchema).optional(),
    /** Recent releases, newest first (P3). Optional for the same reason. */
    releases: z.array(ReleaseSchema).optional(),
    /** Model router track record (optional for back-compat). */
    modelStats: z.array(ModelStatsSchema).optional(),
    routerFloor: RouterFloorSchema.optional(),
    /** Latest Sentinel verdict per (release, environment) for the snapshot's releases. Optional for back-compat. */
    verdicts: z.array(SentinelVerdictSchema).optional(),
    // v2 (optional; absent from v1 Queens).
    /** Non-terminal work items plus recent terminal ones. */
    items: z.array(WorkItemSchema).optional(),
    /** Open escalations plus recently resolved ones. */
    escalations: z.array(EscalationSchema).optional(),
    races: z.array(RaceSchema).optional(),
    hive: HiveStatusSchema.optional(),
    /** The last 50 info+ events, oldest first. */
    recentEvents: z.array(QueenEventSchema).optional(),
  }),
  z.object({ type: z.literal("prompt.updated"), promptRun: PromptRunSchema }),
  z.object({ type: z.literal("train.updated"), train: MergeTrainSchema }),
  z.object({ type: z.literal("audit.appended"), event: AuditEventSchema }),
  z.object({ type: z.literal("deployment.updated"), deployment: DeploymentSchema }),
  z.object({ type: z.literal("release.updated"), release: ReleaseSchema }),
  z.object({ type: z.literal("models.updated"), stats: z.array(ModelStatsSchema), floor: RouterFloorSchema.optional() }),
  z.object({ type: z.literal("sentinel.verdict"), verdict: SentinelVerdictSchema }),
  z.object({ type: z.literal("error"), message: z.string(), code: z.string().optional() }),
  /** Reply to a JSON `{"type":"ping"}`. (The literal string "ping" is auto-answered with "pong".) */
  z.object({ type: z.literal("pong") }),
  // v2 deltas. Merge-queue cars travel as ordinary train.updated messages with lane "QUEUE".
  z.object({ type: z.literal("item.updated"), item: WorkItemSchema }),
  z.object({ type: z.literal("race.updated"), race: RaceSchema }),
  z.object({ type: z.literal("escalation.updated"), escalation: EscalationSchema }),
  z.object({ type: z.literal("hive.updated"), hive: HiveStatusSchema }),
  z.object({ type: z.literal("event.appended"), event: QueenEventSchema }),
]);
export type QueenServerUnitMessage = z.infer<typeof QueenServerUnitMessageSchema>;

/**
 * Server -> client messages (Queen to War Room). v2 adds `batch`: the Queen
 * coalesces broadcasts into one frame per <= 100 ms, applied atomically by the
 * client. (v1 dashboards fail to parse it and show the "updated, reload" banner.)
 */
export const QueenServerMessageSchema = z.discriminatedUnion("type", [
  ...QueenServerUnitMessageSchema.options,
  z.object({ type: z.literal("batch"), messages: z.array(QueenServerUnitMessageSchema).max(MAX_BATCH_MESSAGES) }),
]);
export type QueenServerMessage = z.infer<typeof QueenServerMessageSchema>;

/** Client -> server messages (War Room to Queen). */
export const QueenClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), namespace: z.string().min(1).optional() }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("submit_prompt"), prompt: SubmitPromptSchema }),
]);
export type QueenClientMessage = z.infer<typeof QueenClientMessageSchema>;

/**
 * @deprecated Generic envelope. Use QueenServerMessageSchema /
 * QueenClientMessageSchema instead.
 */
export const QueenMessageSchema = z.object({
  type: z.string().min(1),
  payload: z.unknown(),
});
/** @deprecated See QueenMessageSchema. */
export type QueenMessage = z.infer<typeof QueenMessageSchema>;

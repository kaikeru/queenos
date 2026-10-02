import { z } from "zod";
import { AuditEventSchema, MergeTrainSchema, PromptRunSchema } from "./state.js";
import { SubmitPromptSchema } from "./train.js";

/** Server -> client messages (Queen to War Room). */
export const QueenServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    promptRuns: z.array(PromptRunSchema),
    trains: z.array(MergeTrainSchema),
    recentAudit: z.array(AuditEventSchema),
  }),
  z.object({ type: z.literal("prompt.updated"), promptRun: PromptRunSchema }),
  z.object({ type: z.literal("train.updated"), train: MergeTrainSchema }),
  z.object({ type: z.literal("audit.appended"), event: AuditEventSchema }),
  z.object({ type: z.literal("error"), message: z.string(), code: z.string().optional() }),
  /** Reply to a JSON `{"type":"ping"}`. (The literal string "ping" is auto-answered with "pong".) */
  z.object({ type: z.literal("pong") }),
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

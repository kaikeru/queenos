import { z } from "zod";

/**
 * Cognitive ledger entry stored in Git Notes.
 * `discardedPaths` is an addition to the spec's verbatim schema: the spec
 * mentions "discarded paths" in the ledger, so we record them here.
 */
export const GitNotesPayloadSchema = z.object({
  taskPrompt: z.string(),
  model: z.string(),
  temperature: z.number(),
  reasoningSteps: z.array(z.string()),
  result: z.enum(["success", "failure"]),
  executionTimeMs: z.number(),
  discardedPaths: z.array(z.string()).default([]),
});
export type GitNotesPayload = z.infer<typeof GitNotesPayloadSchema>;

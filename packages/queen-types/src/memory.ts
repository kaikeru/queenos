import { z } from "zod";

/**
 * Hive memory: the Cognitive Ledger made recallable.
 *
 * Write side: the gatekeepers index one memory per gate verdict (the prompt,
 * what the builder reasoned, and how the gate judged it) into the Vectorize
 * index `queenos-memory`. Read side: the Provisioner recalls the closest
 * memories for a train's prompt while it forks, and reports them in its
 * ProvisionResult. The Queen persists them on the train, passes them to the
 * builder as `DroneTask.ragContext`, and the War Room shows them per lane.
 * The Queen itself never touches Vectorize.
 */

/** Vectorize index name (768 dims, cosine; @cf/baai/bge-base-en-v1.5). */
export const MEMORY_INDEX = "queenos-memory";
export const MEMORY_EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
/** Max memories recalled per train. */
export const MAX_RECALLED_MEMORIES = 5;
/** Recalls below this cosine score are noise and dropped. */
export const MIN_RECALL_SCORE = 0.6;
/** Max chars of `MemoryRecord.text` (also the embedded text). */
export const MAX_MEMORY_TEXT = 1_200;
/** Max chars of a FORK's recallQuery (the train's prompt). */
export const MAX_RECALL_QUERY = 4_000;

/** How the gate judged the change the memory is about. */
export const MemoryOutcomeSchema = z.enum(["PASSED", "FAILED", "REJECTED_BY_REVIEW"]);
export type MemoryOutcome = z.infer<typeof MemoryOutcomeSchema>;

/** One indexed memory. Vectorize id = `memoryId`; the other fields are metadata. */
export const MemoryRecordSchema = z.object({
  /** `<trainId>:<12hex of commitSha>`: one memory per gated head (idempotent upserts). */
  memoryId: z.string().min(1),
  /** Hive name; recall is filtered on it (metadata index on `namespace`). */
  namespace: z.string().min(1),
  trainId: z.string().min(1),
  promptId: z.string().min(1),
  commitSha: z.string().min(1),
  outcome: MemoryOutcomeSchema,
  /** The prompt, truncated to 300 chars, for display. */
  promptText: z.string().max(300),
  /** The embedded text: prompt, builder reasoning, changed files, verdict. */
  text: z.string().min(1).max(MAX_MEMORY_TEXT),
  createdAt: z.number().int(),
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

/** A memory recalled for a train, as stored on the train and shown in the War Room. */
export const RecalledMemorySchema = MemoryRecordSchema.pick({
  memoryId: true,
  trainId: true,
  promptId: true,
  outcome: true,
  promptText: true,
  text: true,
  createdAt: true,
}).extend({
  /** Cosine similarity, 0..1. */
  score: z.number(),
});
export type RecalledMemory = z.infer<typeof RecalledMemorySchema>;

/** The drone-facing form of a memory: one line per memory, for `DroneTask.ragContext`. */
export function memoryToRagSnippet(m: Pick<RecalledMemory, "outcome" | "text">): string {
  return `[${m.outcome}] ${m.text}`;
}

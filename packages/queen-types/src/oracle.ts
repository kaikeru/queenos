import { z } from "zod";
import { ModelChoiceSchema } from "./models.js";
import { TraceContextSchema } from "./trace.js";
import { BuildUsageSchema } from "./train.js";
import { DifficultySchema, PathPatternSchema, PrioritySchema, WorkKindSchema, WorkStatusSchema } from "./work.js";

/**
 * The Oracle Workflow contract (v2 design §2.2, §3.3; `queenos-oracle`,
 * apps/oracle). DECOMPOSE turns a goal into children with dependencies and
 * predicted paths; TRIAGE finds duplicates of an auto-filed item. One
 * Workflow instance per command, id = commandId; results are reported to the
 * Queen over DO RPC (`reportOracleResult`), idempotent by commandId.
 */

const CommandId = z.string().min(1).max(128);
/** Child keys in a DECOMPOSE answer: `c1`..`c99`. */
const ChildKey = z.string().regex(/^c\d{1,2}$/);

export const OracleCommandSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("DECOMPOSE"),
    /** `<itemId>-decompose-<n>`. */
    commandId: CommandId,
    hive: z.string().min(1),
    itemId: z.string().min(1),
    trace: TraceContextSchema.optional(),
    promptText: z.string().min(1).max(16_000),
    /** Router role "planner". */
    model: ModelChoiceSchema,
    /** Up to 30 open items, for "similar to" context and cross-goal path awareness. */
    openItems: z
      .array(
        z.object({
          itemId: z.string(),
          title: z.string().max(120),
          status: WorkStatusSchema,
          paths: z.array(PathPatternSchema).max(10).default([]),
        }),
      )
      .max(30),
    limits: z.object({ maxChildren: z.number().int().min(1).max(12) }),
  }),
  z.object({
    op: z.literal("TRIAGE"),
    commandId: CommandId,
    hive: z.string().min(1),
    itemId: z.string().min(1),
    trace: TraceContextSchema.optional(),
    kind: WorkKindSchema,
    title: z.string().max(120),
    body: z.string().max(2000),
  }),
]);
export type OracleCommand = z.infer<typeof OracleCommandSchema>;
export type OracleCommandInput = z.input<typeof OracleCommandSchema>;

export const SimilarItemSchema = z.object({ itemId: z.string(), score: z.number() });
export type SimilarItem = z.infer<typeof SimilarItemSchema>;

export const DecomposedChildSchema = z.object({
  key: ChildKey,
  kind: z.enum(["feature", "bug", "chore"]),
  title: z.string().min(1).max(120),
  body: z.string().max(2000),
  acceptance: z.array(z.string().max(200)).max(6).default([]),
  priority: PrioritySchema.default(2),
  difficulty: DifficultySchema.default("normal"),
  /** Sibling child keys only. */
  dependsOn: z.array(ChildKey).max(6).default([]),
  /** Predicted touch set (§2.3.5). */
  paths: z.array(PathPatternSchema).max(10).default([]),
  similar: z.array(SimilarItemSchema).max(3).default([]),
});
export type DecomposedChild = z.infer<typeof DecomposedChildSchema>;
export type DecomposedChildInput = z.input<typeof DecomposedChildSchema>;

export const OracleResultSchema = z.object({
  commandId: CommandId,
  op: z.enum(["DECOMPOSE", "TRIAGE"]),
  itemId: z.string(),
  /** false (LLM failure): the Queen falls back to one item with the whole prompt. */
  ok: z.boolean(),
  /** DECOMPOSE. */
  children: z.array(DecomposedChildSchema).max(12).optional(),
  /** TRIAGE. */
  similar: z.array(SimilarItemSchema).max(5).optional(),
  model: z.string().optional(),
  usage: BuildUsageSchema.optional(),
  summary: z.string().max(500).default(""),
});
export type OracleResult = z.infer<typeof OracleResultSchema>;
export type OracleResultInput = z.input<typeof OracleResultSchema>;

/** Vectorize metadata `kind` of work-item vectors in `queenos-memory` (gate memories have no `kind`). */
export const WORK_ITEM_VECTOR_KIND = "work-item";

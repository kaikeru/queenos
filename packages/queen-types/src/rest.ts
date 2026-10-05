import { z } from "zod";
import { EscalationSchema, HiveStatusSchema } from "./autonomy.js";
import { HourlyMetricSchema, QueenEventSchema } from "./observability.js";
import { ReleaseSchema } from "./releases.js";
import { MergeTrainSchema } from "./state.js";
import { RaceSchema, WorkItemSchema } from "./work.js";

/** REST response bodies the dashboard client (apps/dashboard/src/api.ts) parses. */

/** GET /hives/:hive/items/:id */
export const ItemDetailSchema = z.object({
  item: WorkItemSchema,
  children: z.array(WorkItemSchema),
  trains: z.array(MergeTrainSchema),
  races: z.array(RaceSchema),
  release: ReleaseSchema.nullable(),
  escalations: z.array(EscalationSchema),
});
export type ItemDetail = z.infer<typeof ItemDetailSchema>;

/** GET /hives/:hive/metrics?window=24h|7d. `source` labels where the numbers came from (AE vs the Queen's rollups). */
export const MetricsViewSchema = z.object({
  rollups: z.array(HourlyMetricSchema),
  hive: HiveStatusSchema.nullable(),
  source: z.string(),
});
export type MetricsView = z.infer<typeof MetricsViewSchema>;

/** GET /hives/:hive/queue: active cars, passed builds waiting to board, the last 20 conflicts and bisects. */
export const QueueViewSchema = z.object({
  cars: z.array(MergeTrainSchema),
  waiting: z.array(MergeTrainSchema),
  conflicts: z.array(QueenEventSchema),
  bisects: z.array(QueenEventSchema),
});
export type QueueView = z.infer<typeof QueueViewSchema>;

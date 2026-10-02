import { z } from "zod";

/** Push event delivered by Artifacts to the Gatekeepers worker. */
export const PushEventSchema = z.object({
  repo: z.string().min(1),
  ref: z.string().min(1),
  before: z.string().optional(),
  after: z.string().min(1),
  pusher: z.string().optional(),
  commits: z
    .array(z.object({ sha: z.string(), message: z.string().optional() }))
    .default([]),
});
export type PushEvent = z.infer<typeof PushEventSchema>;

import { z } from "zod";

/**
 * Release train (P3). Landed trains accumulate into a release. The Queen walks
 * each release up the ladder: staging, then a tap to ship, then canary steps,
 * then prod. Herald executes deploys and Sentinel returns health verdicts; the
 * Queen only decides.
 *
 * Worker layout per hive (workers.dev, in the hive's connected account):
 *   prod + canary: `<hive>-app` (gradual deployments split stable / candidate)
 *   staging:       `<hive>-staging` (always 100% of the newest candidate)
 *   previews:      Worker Previews on `<hive>-app` (P1)
 */

/** Canary traffic steps (percent of requests on the candidate version). */
export const CANARY_STEPS = [1, 10, 50, 100] as const;

const Summary = z.string().max(500);
const CommandId = z.string().min(1).max(128);

export const ReleasePhaseSchema = z.enum([
  "STAGING", // Herald deploying head to <hive>-staging
  "VALIDATING", // Sentinel checking staging
  "AWAITING_TAP", // staging healthy; waiting for a human tap to ship
  "CANARY", // candidate on <hive>-app at canaryPercent; Sentinel checking each step
  "SHIPPED", // candidate at 100%, now the stable version
  "FAILED", // staging or validation failed (P5 adds bisect + revert)
  "ROLLED_BACK", // canary failed; stable restored at 100%
  "SUPERSEDED", // a newer release replaced it before shipping
]);
export type ReleasePhase = z.infer<typeof ReleasePhaseSchema>;

export const ReleaseSchema = z.object({
  releaseId: z.string().min(1),
  hive: z.string().min(1),
  /** main SHA this release ships. */
  headSha: z.string().min(1),
  /** Trains (in landing order) included since the last shipped release. */
  trainIds: z.array(z.string()),
  phase: ReleasePhaseSchema,
  canaryPercent: z.number().int().min(0).max(100).nullable(),
  stagingUrl: z.string().nullable(),
  prodUrl: z.string().nullable(),
  /** Version uploaded for this release on <hive>-app (the canary candidate). */
  candidateVersionId: z.string().nullable(),
  /** Version that was at 100% on <hive>-app before the canary (the rollback target). */
  stableVersionId: z.string().nullable(),
  tappedBy: z.string().nullable(),
  tappedAt: z.number().int().nullable(),
  summary: Summary.nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Release = z.infer<typeof ReleaseSchema>;

/** POST /hives/:hive/releases/:releaseId/tap. The edge supplies the user via `x-queen-user`. */
export const TapToShipSchema = z.object({ releaseId: z.string().min(1) });

// ---------- Sentinel (health verdicts) ----------

export const SentinelCommandSchema = z.object({
  commandId: CommandId,
  hive: z.string().min(1),
  releaseId: z.string().min(1),
  environment: z.enum(["staging", "canary"]),
  /** Script receiving traffic (`<hive>-staging` or `<hive>-app`). */
  scriptName: z.string().min(1),
  /** Public URL to probe. */
  url: z.string().url(),
  /** Canary: pin probes to each version via Cloudflare-Workers-Version-Overrides. */
  candidateVersionId: z.string().optional(),
  stableVersionId: z.string().optional(),
  canaryPercent: z.number().int().min(1).max(100).optional(),
  /** Paths to probe; default ["/", "/health"]. */
  paths: z.array(z.string().startsWith("/")).default(["/", "/health"]),
  /** Minimum candidate requests per window (synthetic load fills the gap). */
  minRequests: z.number().int().min(1).default(300),
  /** Window length; short for demos, minutes for real use. */
  windowSeconds: z.number().int().min(5).default(300),
});
export type SentinelCommand = z.infer<typeof SentinelCommandSchema>;
export type SentinelCommandInput = z.input<typeof SentinelCommandSchema>;

export const SentinelVerdictSchema = z.object({
  commandId: CommandId,
  releaseId: z.string().min(1),
  environment: z.enum(["staging", "canary"]),
  verdict: z.enum(["PROMOTE", "ROLLBACK"]),
  /** Compact numbers only; the Queen never sees raw logs or traces. */
  metrics: z.object({
    requests: z.number().int().min(0),
    errorRate: z.number().min(0).max(1),
    p99Ms: z.number().min(0).nullable(),
    baselineErrorRate: z.number().min(0).max(1).nullable(),
  }),
  summary: Summary,
});
export type SentinelVerdict = z.infer<typeof SentinelVerdictSchema>;

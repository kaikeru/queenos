import { z } from "zod";

/**
 * Executor contracts. The Queen only decides and records. Every external side
 * effect runs in an executor Workflow, which reports back over Durable Object
 * RPC. Each command carries a `commandId` that the Queen persisted before
 * dispatching, so retried dispatches and duplicate reports are idempotent.
 */

const CommandId = z.string().min(1).max(128);
const Summary = z.string().max(500);

// ---------- Provisioner (Artifacts fork / delete) ----------

export const ProvisionCommandSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("FORK"),
    commandId: CommandId,
    hive: z.string().min(1),
    trainId: z.string().min(1),
    /** Repo to fork from: the hive repo, or the predecessor train's fork. */
    sourceRepo: z.string().min(1),
    /** Fork name chosen by the Queen up front (`<ns>-train-<12hex>`). */
    forkName: z.string().min(1),
  }),
  z.object({
    op: z.literal("DELETE"),
    commandId: CommandId,
    hive: z.string().min(1),
    trainId: z.string().min(1),
    repo: z.string().min(1),
  }),
]);
export type ProvisionCommand = z.infer<typeof ProvisionCommandSchema>;

export const ProvisionResultSchema = z.object({
  commandId: CommandId,
  op: z.enum(["FORK", "DELETE"]),
  trainId: z.string().min(1),
  ok: z.boolean(),
  /** FORK: the created (or reused) fork repo name. */
  artifactRepo: z.string().optional(),
  /** FORK: HEAD of the fork's default branch at fork time. */
  baseSha: z.string().optional(),
  summary: Summary.optional(),
});
export type ProvisionResult = z.infer<typeof ProvisionResultSchema>;

// ---------- Herald (deployments) ----------

export const DeployEnvironmentSchema = z.enum(["preview", "staging", "canary", "prod"]);
export type DeployEnvironment = z.infer<typeof DeployEnvironmentSchema>;

export const DeployCommandSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("DEPLOY"),
    commandId: CommandId,
    hive: z.string().min(1),
    environment: DeployEnvironmentSchema,
    /** Set for preview deploys (one Worker Preview per train). */
    trainId: z.string().min(1).optional(),
    /** Artifacts repo to read the source from (a train fork, or the hive repo). */
    artifactRepo: z.string().min(1),
    commitSha: z.string().min(1),
    /** Canary only: percentage of traffic routed to the new version (1-100). */
    percent: z.number().int().min(1).max(100).optional(),
  }),
  z.object({
    op: z.literal("TEARDOWN"),
    commandId: CommandId,
    hive: z.string().min(1),
    environment: DeployEnvironmentSchema,
    trainId: z.string().min(1).optional(),
  }),
  z.object({
    op: z.literal("ROLLBACK"),
    commandId: CommandId,
    hive: z.string().min(1),
    environment: DeployEnvironmentSchema,
    /** Version to restore at 100%. */
    toVersionId: z.string().min(1),
  }),
]);
export type DeployCommand = z.infer<typeof DeployCommandSchema>;

export const DeployResultSchema = z.object({
  commandId: CommandId,
  op: z.enum(["DEPLOY", "TEARDOWN", "ROLLBACK"]),
  environment: DeployEnvironmentSchema,
  trainId: z.string().optional(),
  ok: z.boolean(),
  /** Public URL of the deployed environment (e.g. a Worker Preview URL). */
  url: z.string().url().optional(),
  versionId: z.string().optional(),
  commitSha: z.string().optional(),
  summary: Summary.optional(),
});
export type DeployResult = z.infer<typeof DeployResultSchema>;

/** One environment's current state, as stored by the Queen and shown in the Sites panel. */
export const DeploymentSchema = z.object({
  deploymentId: z.string().min(1),
  hive: z.string().min(1),
  environment: DeployEnvironmentSchema,
  trainId: z.string().nullable(),
  status: z.enum(["PENDING", "LIVE", "FAILED", "TORN_DOWN"]),
  url: z.string().nullable(),
  versionId: z.string().nullable(),
  commitSha: z.string().nullable(),
  percent: z.number().int().min(0).max(100).nullable(),
  summary: Summary.nullable(),
  updatedAt: z.number().int(),
});
export type Deployment = z.infer<typeof DeploymentSchema>;

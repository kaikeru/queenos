import { z } from "zod";
import { MAX_RECALLED_MEMORIES, MAX_RECALL_QUERY, RecalledMemorySchema } from "./memory.js";
import { TraceContextSchema } from "./trace.js";

/**
 * Executor contracts. The Queen only decides and records. Every external side
 * effect runs in an executor Workflow, which reports back over Durable Object
 * RPC. Each command carries a `commandId` that the Queen persisted before
 * dispatching, so retried dispatches and duplicate reports are idempotent.
 */

const CommandId = z.string().min(1).max(128);
const Summary = z.string().max(500);
/** v2: optional W3C trace context on every command (absent from v1 Queens). */
const Trace = TraceContextSchema.optional();

// ---------- Provisioner (Artifacts fork / delete / notes) ----------

/** Longest text one NOTE command appends. */
export const MAX_NOTE_TEXT = 2000;

export const ProvisionCommandSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("FORK"),
    commandId: CommandId,
    trace: Trace,
    hive: z.string().min(1),
    trainId: z.string().min(1),
    /** Repo to fork from: the hive repo, or the predecessor train's fork. */
    sourceRepo: z.string().min(1),
    /** Fork name chosen by the Queen up front (`<ns>-train-<12hex>`). */
    forkName: z.string().min(1),
    /** The train's prompt: the Provisioner recalls hive memories for it (absent: no recall). */
    recallQuery: z.string().max(MAX_RECALL_QUERY).optional(),
  }),
  z.object({
    op: z.literal("DELETE"),
    commandId: CommandId,
    trace: Trace,
    hive: z.string().min(1),
    trainId: z.string().min(1),
    repo: z.string().min(1),
  }),
  z.object({
    /** Genesis: create the hive repo, seed templates/<template> plus .queen/charter.json, push main. */
    op: z.literal("CREATE_HIVE"),
    commandId: CommandId,
    trace: Trace,
    hive: z.string().min(1),
    template: z.literal("worker-starter"),
    /** Serialized Charter JSON, committed as .queen/charter.json. */
    charterJson: z.string().min(2).max(64_000),
  }),
  z.object({
    /**
     * Human-push design §7: append `text` to the git note on `repo@sha` under `refs/notes/queen`
     * (fetch, append after a separator, push without force, retry on non-fast-forward). `repo` is a
     * contributor's inbox or the train fork; `commandId` is `<trainId>-note-<n>`.
     */
    op: z.literal("NOTE"),
    commandId: CommandId,
    trace: Trace,
    hive: z.string().min(1),
    trainId: z.string().min(1),
    repo: z.string().min(1),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    text: z.string().min(1).max(MAX_NOTE_TEXT),
  }),
]);

/** CREATE_HIVE outcome. The Provisioner reports it to Genesis (GenesisNode RPC `reportHiveCreated`), not to the Queen. */
export const HiveCreatedResultSchema = z.object({
  commandId: CommandId,
  hive: z.string().min(1),
  ok: z.boolean(),
  /** HEAD of main after the seed commit. */
  mainSha: z.string().optional(),
  summary: Summary.optional(),
});
export type HiveCreatedResult = z.infer<typeof HiveCreatedResultSchema>;
export type ProvisionCommand = z.infer<typeof ProvisionCommandSchema>;

export const ProvisionResultSchema = z.object({
  commandId: CommandId,
  op: z.enum(["FORK", "DELETE", "NOTE"]),
  trainId: z.string().min(1),
  ok: z.boolean(),
  /** FORK: the created (or reused) fork repo name. */
  artifactRepo: z.string().optional(),
  /** FORK: HEAD of the fork's default branch at fork time. */
  baseSha: z.string().optional(),
  /** FORK: hive memories recalled for `recallQuery`, best first. Best effort: absent or [] on recall trouble. */
  memories: z.array(RecalledMemorySchema).max(MAX_RECALLED_MEMORIES).optional(),
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
    trace: Trace,
    hive: z.string().min(1),
    environment: DeployEnvironmentSchema,
    /** Set for preview deploys (one Worker Preview per train). */
    trainId: z.string().min(1).optional(),
    /** Artifacts repo to read the source from (a train fork, or the hive repo). */
    artifactRepo: z.string().min(1),
    commitSha: z.string().min(1),
    /** Canary only: percentage of traffic routed to the new version (1-100). */
    percent: z.number().int().min(1).max(100).optional(),
    /** Release this deploy belongs to (staging / canary). */
    releaseId: z.string().min(1).optional(),
    /** Canary steps after the first: reuse this already-uploaded candidate version instead of re-uploading. */
    versionId: z.string().min(1).optional(),
    /** Canary: the version that keeps the remaining traffic. */
    stableVersionId: z.string().min(1).optional(),
  }),
  z.object({
    op: z.literal("TEARDOWN"),
    commandId: CommandId,
    trace: Trace,
    hive: z.string().min(1),
    environment: DeployEnvironmentSchema,
    trainId: z.string().min(1).optional(),
  }),
  z.object({
    op: z.literal("ROLLBACK"),
    commandId: CommandId,
    trace: Trace,
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
  /** Canary: the stable version Herald found (or kept) on the script, i.e. the rollback target. */
  stableVersionId: z.string().optional(),
  releaseId: z.string().optional(),
  percent: z.number().int().min(0).max(100).optional(),
  commitSha: z.string().optional(),
  summary: Summary.optional(),
  /**
   * `ok: false` on infrastructure (Artifacts / Cloudflare API 5xx, 429, network) that outlasted Herald's
   * own retries: not the change's fault. A preview: the Queen re-deploys after a backoff (no attempt
   * charged), and opens EXECUTOR_LOST once its infra retries are spent (never REWORK_EXHAUSTED).
   */
  retryable: z.boolean().optional(),
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

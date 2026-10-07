/**
 * Artifacts `cf.artifacts.repo.pushed` event model + the filter that decides
 * whether a push is gated.
 *
 * The documented envelope is `{type, source:{type, namespace, repoName},
 * payload:{ref, before, after, commits[...]}, metadata}` (docs/discovery.md §1).
 * UNVERIFIED: whether a Workflow's `event.payload` is the whole envelope or just
 * the inner `payload`, so both (and a flat shape) are accepted. Unknown fields
 * are kept, never rejected.
 */
import { z } from "zod";

export const ZERO_SHA = "0000000000000000000000000000000000000000";

const CommitSchema = z.looseObject({
  id: z.string().optional(),
  message: z.string().optional(),
  messageTruncated: z.boolean().optional(),
  timestamp: z.string().optional(),
  parents: z.array(z.string()).optional(),
});

const InnerSchema = z.looseObject({
  ref: z.string().min(1),
  before: z.string().optional(),
  after: z.string().min(1),
  commits: z.array(CommitSchema).default([]),
  totalCommitsCount: z.number().optional(),
  commitsTruncated: z.boolean().optional(),
});

/** The documented envelope. */
export const PushedEnvelopeSchema = z.looseObject({
  type: z.string().optional(),
  source: z.looseObject({
    type: z.string().optional(),
    namespace: z.string().optional(),
    repoName: z.string().min(1),
  }),
  payload: InnerSchema,
  metadata: z.looseObject({ eventTimestamp: z.string().optional(), eventSubscriptionId: z.string().optional() }).optional(),
});

/** Fallback: a flat object (inner payload plus a repo name). */
const FlatSchema = InnerSchema.extend({
  repoName: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  namespace: z.string().optional(),
});

/** Normalised view used by the gatekeeper. */
export interface PushEvent {
  /** Artifacts namespace of the repo (when the event says). */
  namespace: string | undefined;
  repoName: string;
  ref: string;
  before: string | undefined;
  after: string;
  commitMessages: string[];
}

export type ParsedPush = { ok: true; event: PushEvent } | { ok: false; error: string };

export function parsePushEvent(raw: unknown): ParsedPush {
  const env = PushedEnvelopeSchema.safeParse(raw);
  if (env.success) {
    const { source, payload } = env.data;
    return {
      ok: true,
      event: {
        namespace: source.namespace,
        repoName: source.repoName,
        ref: payload.ref,
        before: payload.before,
        after: payload.after,
        commitMessages: payload.commits.flatMap((c) => (c.message ? [c.message] : [])),
      },
    };
  }
  const flat = FlatSchema.safeParse(raw);
  const repoName = flat.success ? (flat.data.repoName ?? flat.data.repo) : undefined;
  if (flat.success && repoName) {
    return {
      ok: true,
      event: {
        namespace: flat.data.namespace,
        repoName,
        ref: flat.data.ref,
        before: flat.data.before,
        after: flat.data.after,
        commitMessages: flat.data.commits.flatMap((c) => (c.message ? [c.message] : [])),
      },
    };
  }
  return { ok: false, error: env.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
}

/** `<hive>-train-<12 hex>` (apps/queen trainRepoName), plus the provisioner's fork-retry suffix `-r<N>`. */
const TRAIN_REPO_RE = /^(.+)-train-([0-9a-f]{12})(?:-r\d+)?$/;

/** The gate's workflow params: a push that passed the filter. */
export const GateTaskSchema = z.object({
  kind: z.literal("gate"),
  /** Artifacts repo (a train fork). */
  repo: z.string().min(1),
  /** The hive namespace the Queen is addressed by (`idFromName`). */
  hive: z.string().min(1),
  /** Branch short name, e.g. `main`. */
  branch: z.string().min(1),
  before: z.string().optional(),
  after: z.string().min(1),
  /**
   * A Queen-started gate (queen-types `GateCommand`, sent when a train enters TESTING): its instance id. The
   * Queen's `GateTarget.gateId` names the gate that owns the round; any other instance stands down, and the
   * verdict carries it as `gateId`. Absent: the push-event gate.
   */
  commandId: z.string().min(1).max(100).optional(),
  /** A Queen-started gate: the train it was started for. */
  trainId: z.string().min(1).optional(),
});
export type GateTask = z.infer<typeof GateTaskSchema>;

export type Classification = { action: "gate"; task: GateTask } | { action: "ignore"; reason: string };

export function classifyPush(e: PushEvent, opts: { artifactsNamespace: string }): Classification {
  if (e.namespace !== undefined && e.namespace !== opts.artifactsNamespace) return { action: "ignore", reason: "foreign-namespace" };
  if (e.ref.startsWith("refs/notes/")) return { action: "ignore", reason: "notes-ref" };
  if (!e.ref.startsWith("refs/heads/")) return { action: "ignore", reason: "not-a-branch" };
  if (/^0+$/.test(e.after)) return { action: "ignore", reason: "deletion" };
  const m = TRAIN_REPO_RE.exec(e.repoName);
  if (!m) return { action: "ignore", reason: "not-a-train-fork" };
  return {
    action: "gate",
    task: { kind: "gate", repo: e.repoName, hive: m[1]!, branch: e.ref.slice("refs/heads/".length), ...(e.before ? { before: e.before } : {}), after: e.after },
  };
}

/** Deterministic Workflow instance id: one gate per (repo, after). */
export function gateInstanceId(task: Pick<GateTask, "repo" | "after">): string {
  return `gate-${task.repo}-${task.after.slice(0, 40)}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100);
}

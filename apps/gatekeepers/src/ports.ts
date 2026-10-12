/**
 * Gatekeeper ports: every side effect the gate performs goes through this
 * object (mirrors apps/drones). Tests swap in fakes via GatekeeperWorkflow.createPorts().
 */
import type { AppendAuditInput, AttemptPushed, AttemptPushedResult, AuditEvent, GateTarget, MemoryRecord, QueenServerMessage, ScribeSummary, TrainResult } from "@queenos/queen-types";
import { HiveMemory, cloneRepo, createAiClient, structuredLog, type AiRunner, type GitRepo, type LogFields } from "@queenos/hive-kit";
import type { GateConfig } from "./config";
import type { GateTask } from "./event";
import type { ReviewLlm } from "./review";
import type { ScribeLlm } from "./scribe";
import { FetchSmokeProbe, type SmokeProbe } from "./smoke";
import { createTestRunner, type TestRunner } from "./test-runner";

// ── Artifacts ────────────────────────────────────────────────────────────

export interface RepoAccess {
  remote: string;
  /** Short-lived repo token. Never leaves the step that minted it. */
  token: string;
}

export interface ArtifactsPort {
  access(repo: string, scope: "read" | "write"): Promise<RepoAccess>;
  /** The repo's `main` head with its full message; null when the repo (or main) is gone. */
  readHead(repo: string): Promise<{ sha: string; message: string } | null>;
}

export const TOKEN_TTL_SECONDS = 15 * 60;

export class BindingArtifactsPort implements ArtifactsPort {
  constructor(private readonly artifacts: Artifacts | undefined) {}
  async access(repo: string, scope: "read" | "write"): Promise<RepoAccess> {
    if (!this.artifacts) throw new Error("UNAVAILABLE: ARTIFACTS binding is not configured");
    using handle = await this.artifacts.get(repo);
    const [{ remote }, { plaintext }] = await Promise.all([handle.info(), handle.createToken(scope, TOKEN_TTL_SECONDS)]);
    return { remote, token: plaintext };
  }
  async readHead(repo: string): Promise<{ sha: string; message: string } | null> {
    if (!this.artifacts) throw new Error("UNAVAILABLE: ARTIFACTS binding is not configured");
    let handle: ArtifactsRepo;
    try {
      handle = await this.artifacts.get(repo);
    } catch (e) {
      if ((e as { code?: string })?.code === "NOT_FOUND") return null;
      throw e;
    }
    using r = handle;
    const [head] = await r.log({ ref: "main", limit: 1 });
    return head ? { sha: head.hash, message: String(head.message) } : null;
  }
}

// ── git ──────────────────────────────────────────────────────────────────

export type GitSession = Pick<GitRepo, "head" | "readCommit" | "listFiles" | "readFiles"> & {
  /** WP1.12: paths changed between two commits. Optional so older hive-kit builds still work (inspect falls back to a commit walk). */
  changedPaths?(from: string, to: string): Promise<string[]>;
};

export interface CloneRequest {
  remote: string;
  token: string;
  ref: string;
  depth: number;
}

export interface GitPort {
  clone(req: CloneRequest): Promise<GitSession>;
}

export const isomorphicGitPort: GitPort = {
  clone: (req) => cloneRepo({ remote: req.remote, token: req.token, ref: req.ref, depth: req.depth }),
};

// ── Queen ────────────────────────────────────────────────────────────────

export type QueenSnapshot = Extract<QueenServerMessage, { type: "snapshot" }>;

/** RPC surface of apps/queen's QueenNode used by the gate. */
export interface QueenPort {
  getSnapshot(): Promise<QueenSnapshot>;
  /**
   * v2 RPC (implemented by Phase 2): what a pushed repo is (lane, members, trace). Optional:
   * an older Queen lacks it, and the gate then scans the snapshot (`lookupTrain`).
   */
  getGateTarget?(repo: string): Promise<GateTarget | null>;
  /** Several consecutive ledger entries in one RPC (one transaction, one broadcast). */
  appendAudits(inputs: AppendAuditInput[]): Promise<Pick<AuditEvent, "eventId">[]>;
  recordScribeSummary(input: ScribeSummary): Promise<unknown>;
  reportTrainResult(input: TrainResult): Promise<{ outcome: string }>;
  /** v17 RPC (MCP attempts): a push to an attempt fork's main. Optional: an older Queen lacks it. */
  attemptPushed?(input: AttemptPushed): Promise<AttemptPushedResult>;
}

/** Cross-script DO binding; one QueenNode per hive, `idFromName(hive)`. */
export function queenRpc(ns: DurableObjectNamespace | undefined, hive: string): QueenPort {
  if (!ns) throw new Error("UNAVAILABLE: QUEEN binding is not configured");
  return ns.get(ns.idFromName(hive)) as unknown as QueenPort;
}

// ── Vectorize (failure memory) ─────────────────────────────────────────────

export interface FailureChunk {
  id: string;
  text: string;
  metadata: { trainId: string; promptId: string; namespace: string; kind: "failure-log"; commitSha: string; chunk: number };
}

export interface FailureStore {
  /** Embed and upsert. Best effort: the caller swallows errors. */
  store(chunks: FailureChunk[]): Promise<{ stored: number }>;
}

export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export class VectorizeFailureStore implements FailureStore {
  constructor(
    private readonly ai: Ai | undefined,
    private readonly index: VectorizeIndex | undefined,
  ) {}

  async store(chunks: FailureChunk[]): Promise<{ stored: number }> {
    if (!this.ai || !this.index) throw new Error("UNAVAILABLE: AI / VECTORIZE binding is not configured");
    if (chunks.length === 0) return { stored: 0 };
    const res = (await (this.ai as unknown as { run(model: string, input: unknown): Promise<unknown> }).run(EMBEDDING_MODEL, {
      text: chunks.map((c) => c.text),
    })) as { data?: number[][] };
    const vectors = res.data;
    if (!vectors || vectors.length !== chunks.length) throw new Error("embedding model returned an unexpected shape");
    await this.index.upsert(
      chunks.map((c, i) => ({
        id: c.id,
        values: vectors[i]!,
        metadata: { ...c.metadata, text: c.text.slice(0, 2000) },
      })),
    );
    return { stored: chunks.length };
  }
}

// ── Workflow dispatch (idempotency) ──────────────────────────────────────────

export interface GateDispatcher {
  /** Create the deterministic gate instance. "exists" = a gate for this (repo, after) already ran / is running. */
  start(id: string, task: GateTask): Promise<"started" | "exists">;
}

export class WorkflowGateDispatcher implements GateDispatcher {
  constructor(private readonly wf: Workflow | undefined) {}
  async start(id: string, task: GateTask): Promise<"started" | "exists"> {
    if (!this.wf) throw new Error("UNAVAILABLE: GATEKEEPER_WORKFLOW binding is not configured");
    try {
      await this.wf.get(id);
      return "exists";
    } catch {
      /* not found: create it */
    }
    try {
      await this.wf.create({ id, params: task });
      return "started";
    } catch (e) {
      if (/already|exist|duplicate|conflict/i.test(String((e as Error)?.message ?? e))) return "exists";
      throw e;
    }
  }
}

// ── bundle ───────────────────────────────────────────────────────────────

export interface GatekeeperPorts {
  artifacts: ArtifactsPort;
  git: GitPort;
  queen(hive: string): QueenPort;
  /** Null: extractive Scribe. */
  llm: ScribeLlm | null;
  /** The REVIEWER's model client. Null in REVIEW_MODE llm means no AI binding: the review fails open. */
  reviewLlm: ReviewLlm | null;
  tests: TestRunner;
  /** `GET <previewUrl>/` against the train's Worker Preview. */
  smoke: SmokeProbe;
  failures: FailureStore;
  /** Hive memory: one record per gate verdict, recalled by future builders. Best effort. */
  memory: { remember(r: MemoryRecord): Promise<void> };
  dispatcher: GateDispatcher;
  /** One JSON log line per gate step (WP1.4's `structuredLog`); never throws. Tests collect the lines. */
  log: (fields: LogFields) => void;
}

/** hive-kit's `structuredLog` is a stub until WP1.4 lands: a log line must never fail a gate. */
export const safeLog = (fields: LogFields): void => {
  try {
    structuredLog(fields);
  } catch {
    /* logging is best effort */
  }
};

export interface GateEnvBindings {
  ARTIFACTS?: Artifacts;
  QUEEN?: DurableObjectNamespace;
  AI?: Ai;
  VECTORIZE?: VectorizeIndex;
  /** Hive memory index `queenos-memory`. */
  MEMORY?: VectorizeIndex;
  GATEKEEPER_WORKFLOW?: Workflow;
}

export function createProdPorts(env: GateEnvBindings, config: GateConfig): GatekeeperPorts {
  const useLlm = config.scribeMode === "llm" || (config.scribeMode === "auto" && config.testMode !== "scripted" && env.AI !== undefined);
  if (useLlm && !env.AI) throw new Error("UNAVAILABLE: SCRIBE_MODE=llm needs the AI binding");
  return {
    artifacts: new BindingArtifactsPort(env.ARTIFACTS),
    git: isomorphicGitPort,
    queen: (hive) => queenRpc(env.QUEEN, hive),
    llm: useLlm ? createAiClient({ ai: env.AI as unknown as AiRunner, gatewayId: config.aiGateway.gatewayId }) : null,
    reviewLlm: config.reviewMode === "llm" && env.AI ? createAiClient({ ai: env.AI as unknown as AiRunner, gatewayId: config.aiGateway.gatewayId }) : null,
    tests: createTestRunner(config.testMode),
    smoke: new FetchSmokeProbe(),
    failures: new VectorizeFailureStore(env.AI, env.VECTORIZE),
    memory: new HiveMemory(env.AI as unknown as AiRunner | undefined, env.MEMORY),
    dispatcher: new WorkflowGateDispatcher(env.GATEKEEPER_WORKFLOW),
    log: safeLog,
  };
}

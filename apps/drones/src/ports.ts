/**
 * Drone ports: every side effect the workflow body performs goes through this
 * object, mirroring the Queen's createPorts() seam. Tests swap in fakes.
 */
import type { NetRetry } from "./net-retry";
import type {
  AppendAuditInput,
  AuditEvent,
  BuildResult,
  DroneTask,
  LandResultInput,
  MergeResultInput,
  TrainResult,
} from "@queenos/queen-types";
import {
  createAiClient,
  type AiRunner,
  cloneRepo,
  type CompletionRequest,
  type CompletionResult,
  type DataPointWriter,
  type GitRepo,
} from "@queenos/hive-kit";
import { getAgentByName } from "agents";
import type { DroneConfig } from "./config";
import type { AgentBuildInput, AgentBuildResult, AgentPort } from "./agent/contract";
import type { BuilderAgent } from "./agent/builder-agent";

// ── Artifacts ────────────────────────────────────────────────────────────

export interface RepoAccess {
  /** HTTPS git remote of the repo. */
  remote: string;
  /** Short-lived repo token (`art_v2_x_…?expires=…`). Never leaves the step that minted it. */
  token: string;
}

export interface ArtifactsPort {
  /** Mint a short-lived token for `repo` and return its remote. */
  access(repo: string, scope: "read" | "write"): Promise<RepoAccess>;
}

/** Token TTL: long enough for clone + push, short enough to be disposable (min 60). */
export const TOKEN_TTL_SECONDS = 15 * 60;

export class BindingArtifactsPort implements ArtifactsPort {
  constructor(private readonly artifacts: Artifacts | undefined) {}

  async access(repo: string, scope: "read" | "write"): Promise<RepoAccess> {
    if (!this.artifacts) throw new Error("UNAVAILABLE: ARTIFACTS binding is not configured");
    // Repo handles are Disposable RPC stubs (docs/discovery.md §1).
    using handle = await this.artifacts.get(repo);
    const [{ remote }, { plaintext }] = await Promise.all([handle.info(), handle.createToken(scope, TOKEN_TTL_SECONDS)]);
    return { remote, token: plaintext };
  }
}

// ── git ──────────────────────────────────────────────────────────────────

/** The subset of hive-kit's GitRepo the drone uses. */
export type GitSession = Pick<
  GitRepo,
  | "writeFiles"
  | "commitAll"
  | "addNote"
  | "readNote"
  | "listNotes"
  | "push"
  | "pushNotes"
  | "fetchRef"
  | "head"
  | "readCommit"
  | "resolveRef"
  | "writeRef"
  | "listFiles"
  | "readFiles"
  | "merge"
  | "findMergeBase"
  | "changedPaths"
  | "deepen"
>;

export interface CloneRequest {
  remote: string;
  token: string;
  ref?: string;
  /** 0 = full history. */
  depth?: number;
}

export interface GitPort {
  clone(req: CloneRequest): Promise<GitSession>;
}

export const isomorphicGitPort: GitPort = {
  clone: (req) => cloneRepo({ remote: req.remote, token: req.token, ...(req.ref ? { ref: req.ref } : {}), depth: req.depth ?? 1 }),
};

// ── Queen ────────────────────────────────────────────────────────────────

/** RPC surface of apps/queen's QueenNode used by drones. */
export interface QueenPort {
  reportBuildResult(input: BuildResult): Promise<{ outcome: string }>;
  reportLandResult(input: LandResultInput): Promise<{ outcome: string }>;
  reportTrainResult(input: TrainResult): Promise<{ outcome: string }>;
  /** v2: the MERGE drone's report for a car (`trainId` = car id). Phase 2 (QueenNode) implements it. */
  reportMergeResult(input: MergeResultInput): Promise<{ outcome: string }>;
  appendAudit(input: AppendAuditInput): Promise<Pick<AuditEvent, "eventId">>;
}

/** Cross-script DO binding to QueenNode; one DO per hive, `idFromName(namespace)`. */
export function queenRpc(ns: DurableObjectNamespace | undefined, namespace: string): QueenPort {
  if (!ns) throw new Error("UNAVAILABLE: QUEEN binding is not configured");
  // The binding is untyped across scripts; QueenPort mirrors QueenNode's RPC methods.
  return ns.get(ns.idFromName(namespace)) as unknown as QueenPort;
}

// ── LLM ──────────────────────────────────────────────────────────────────

export interface LlmPort {
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

// ── merge ────────────────────────────────────────────────────────────────

/**
 * WP1.12's `mergeCar(ports, task, ts)` (src/merge.ts): 3-way merge a car's members onto its fork and
 * push. `trainId` may be omitted from the result (the drone fills in the car id). Idempotent for a
 * fixed `timestamp`.
 */
export type MergeCarFn = (
  ports: Pick<DronePorts, "artifacts" | "git">,
  task: DroneTask,
  timestamp: number,
  net?: NetRetry,
) => Promise<Omit<MergeResultInput, "trainId"> & { trainId?: string }>;

// ── bundle ───────────────────────────────────────────────────────────────

export interface DronePorts {
  artifacts: ArtifactsPort;
  git: GitPort;
  queen(namespace: string): QueenPort;
  /** Null in scripted mode. */
  llm: LlmPort | null;
  /** The tool-loop BuilderAgent (live + DRONE_HARNESS=agent); null otherwise. */
  agent: AgentPort | null;
  /** Analytics Engine `queenos_events`; absent in sim and tests (writes are no-ops). */
  analytics?: DataPointWriter | undefined;
  /** The MERGE implementation; absent = the default adapter (src/merge-adapter.ts). */
  mergeCar?: MergeCarFn | undefined;
}

export interface DroneEnvBindings {
  AI?: Ai;
  ARTIFACTS?: Artifacts;
  QUEEN?: DurableObjectNamespace;
  BUILDER?: DurableObjectNamespace<BuilderAgent>;
  ANALYTICS?: DataPointWriter;
}

/** BuilderAgent DOs by name (`<instanceId>|<model>`), via the Agents SDK so `this.name` is set. */
export function builderAgentPort(ns: DurableObjectNamespace<BuilderAgent> | undefined): AgentPort {
  if (!ns) throw new Error("UNAVAILABLE: BUILDER binding is not configured");
  return {
    async build(name: string, input: AgentBuildInput): Promise<AgentBuildResult> {
      const stub = await getAgentByName(ns, name);
      return (await stub.build(input)) as AgentBuildResult;
    },
  };
}

function liveLlm(ai: Ai | undefined, config: DroneConfig): LlmPort {
  if (!ai) throw new Error("UNAVAILABLE: AI binding is not configured");
  return createAiClient({ ai: ai as unknown as AiRunner, gatewayId: config.aiGateway.gatewayId });
}

export function createProdPorts(env: DroneEnvBindings, config: DroneConfig): DronePorts {
  return {
    artifacts: new BindingArtifactsPort(env.ARTIFACTS),
    git: isomorphicGitPort,
    queen: (namespace) => queenRpc(env.QUEEN, namespace),
    llm: config.llmMode === "live" ? liveLlm(env.AI, config) : null,
    agent: config.llmMode === "live" && config.harness === "agent" ? builderAgentPort(env.BUILDER) : null,
    analytics: env.ANALYTICS,
  };
}

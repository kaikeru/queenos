/**
 * Drone ports: every side effect the workflow body performs goes through this
 * object, mirroring the Queen's createPorts() seam. Tests swap in fakes.
 */
import type {
  AppendAuditInput,
  AuditEvent,
  BuildResult,
  LandResultInput,
  TrainResult,
} from "@queenos/queen-types";
import {
  AiGatewayClient,
  cloneRepo,
  type CompletionRequest,
  type CompletionResult,
  type GitRepo,
} from "@queenos/hive-kit";
import type { DroneConfig } from "./config";

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

// ── bundle ───────────────────────────────────────────────────────────────

export interface DronePorts {
  artifacts: ArtifactsPort;
  git: GitPort;
  queen(namespace: string): QueenPort;
  /** Null in scripted mode. */
  llm: LlmPort | null;
}

export interface DroneEnvBindings {
  ARTIFACTS?: Artifacts;
  QUEEN?: DurableObjectNamespace;
}

export function createProdPorts(env: DroneEnvBindings, config: DroneConfig): DronePorts {
  return {
    artifacts: new BindingArtifactsPort(env.ARTIFACTS),
    git: isomorphicGitPort,
    queen: (namespace) => queenRpc(env.QUEEN, namespace),
    llm:
      config.llmMode === "live"
        ? new AiGatewayClient({ config: config.aiGateway, token: config.aiGatewayToken })
        : null,
  };
}

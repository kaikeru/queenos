/**
 * Oracle ports: every side effect goes through this object (mirrors
 * apps/provisioner). Tests swap in fakes via OracleWorkflow.createPorts().
 */
import type { AnalyticsPoint, OracleResult, SimilarItem } from "@queenos/queen-types";
import { cloneRepo, createAiClient, HiveMemory, writeMetric, type AiRunner, type CompletionRequest, type CompletionResult } from "@queenos/hive-kit";
import { MAX_LISTED_FILES } from "./prompt";

/** DECOMPOSE step 0: the hive repo's file listing (a depth-1 clone of main). Throws on trouble; the caller is best effort. */
export interface RepoPort {
  listFiles(hive: string): Promise<string[]>;
}

/** The planner model client (hive-kit AiClient). */
export interface LlmPort {
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/** Work-item vectors in queenos-memory (HiveMemory). Throws on trouble; the caller is best effort. */
export interface MemoryPort {
  findSimilarItems(namespace: string, texts: string[], opts?: { topK?: number; minScore?: number; excludeIds?: string[] }): Promise<SimilarItem[][]>;
  indexItems(namespace: string, items: { id: string; text: string; title?: string }[]): Promise<void>;
}

/** RPC surface of apps/queen's QueenNode used by the Oracle. */
export interface QueenPort {
  reportOracleResult(input: OracleResult): Promise<unknown>;
}

export interface OraclePorts {
  repo: RepoPort;
  llm: LlmPort | null;
  memory: MemoryPort;
  queen(hive: string): QueenPort;
  /** Fire-and-forget usage point. */
  metric(point: AnalyticsPoint): void;
}

export interface OracleEnvBindings {
  ARTIFACTS?: Artifacts;
  QUEEN?: DurableObjectNamespace;
  AI?: Ai;
  MEMORY?: VectorizeIndex;
  ANALYTICS?: AnalyticsEngineDataset;
  AI_GATEWAY_ID?: string;
}

/** Token TTL for the read-only listing clone (min 60). */
const TOKEN_TTL_SECONDS = 10 * 60;

/** Shallowest paths first, then alphabetical, capped. */
export function capListing(files: string[], max = MAX_LISTED_FILES): string[] {
  const depth = (p: string) => p.split("/").length;
  return [...files].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, max);
}

export class ArtifactsRepoPort implements RepoPort {
  constructor(private readonly artifacts: Artifacts | undefined) {}

  async listFiles(hive: string): Promise<string[]> {
    if (!this.artifacts) throw new Error("UNAVAILABLE: ARTIFACTS binding is not configured");
    // Repo handles are Disposable RPC stubs.
    using handle = await this.artifacts.get(hive);
    const [{ remote }, { plaintext }] = await Promise.all([handle.info(), handle.createToken("read", TOKEN_TTL_SECONDS)]);
    const repo = await cloneRepo({ remote, token: plaintext, depth: 1 });
    return capListing(await repo.listFiles());
  }
}

/** Cross-script DO binding to QueenNode; one DO per hive, `idFromName(hive)`. */
export function queenRpc(ns: DurableObjectNamespace | undefined, hive: string): QueenPort {
  if (!ns) throw new Error("UNAVAILABLE: QUEEN binding is not configured");
  return ns.get(ns.idFromName(hive)) as unknown as QueenPort;
}

export function createProdPorts(env: OracleEnvBindings): OraclePorts {
  return {
    repo: new ArtifactsRepoPort(env.ARTIFACTS),
    llm: env.AI ? createAiClient({ ai: env.AI as unknown as AiRunner, gatewayId: env.AI_GATEWAY_ID?.trim() || "queenos" }) : null,
    memory: new HiveMemory(env.AI as unknown as AiRunner | undefined, env.MEMORY),
    queen: (hive) => queenRpc(env.QUEEN, hive),
    metric: (p) => writeMetric(env.ANALYTICS, p),
  };
}

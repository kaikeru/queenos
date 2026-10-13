/**
 * Every side effect of queenos-mcp goes through these ports (tests swap them via QueenMcp.ports(), test/worker.ts).
 * queenos-mcp is an executor: it does the Artifacts I/O; the Queen decides and records.
 */
import type {
  AttemptAborted,
  AttemptBaseFailed,
  AttemptBaseReady,
  AttemptIntent,
  AttemptIntentDecision,
  AttemptOwnerAction,
  AttemptReady,
  AttemptResult,
  AttemptView,
  HiveStatus,
  ItemAttempts,
  ItemDetail,
  McpAgentIdentity,
  PickRace,
  Project,
  PromptRun,
  QueenServerMessage,
  Race,
  SubmitPrompt,
  WorkItem,
} from "@queenos/queen-types";
import type { ForkDeps } from "@queenos/hive-kit/artifacts";
import { forkDepsFor } from "./fork";

export type Snapshot = Extract<QueenServerMessage, { type: "snapshot" }>;

/** The QueenNode RPC surface queenos-mcp calls (apps/queen/src/queen-node.ts). One QueenNode per hive: idFromName(hive). */
export interface QueenPort {
  hiveStatus(): Promise<HiveStatus | null>;
  submitWork(input: SubmitPrompt & { user?: string }): Promise<{ item: WorkItem; promptRun: PromptRun }>;
  getItemDetail(itemId: string): Promise<ItemDetail>;
  getSnapshot(): Promise<Snapshot>;
  attemptIntent(input: AttemptIntent): Promise<AttemptIntentDecision>;
  attemptBaseReady(input: AttemptBaseReady): Promise<{ outcome: string }>;
  attemptBaseFailed(input: AttemptBaseFailed): Promise<{ outcome: string }>;
  attemptReady(input: AttemptReady): Promise<AttemptResult>;
  attemptAborted(input: AttemptAborted): Promise<{ outcome: string }>;
  attemptRefresh(input: AttemptOwnerAction): Promise<AttemptResult>;
  attemptEnd(input: AttemptOwnerAction): Promise<AttemptResult>;
  /** A Queen older than the regate fix lacks this RPC: the call then throws "does not implement" (see retry_gates). */
  attemptRegate(input: AttemptOwnerAction): Promise<AttemptResult>;
  getAttempt(attemptId: string): Promise<AttemptView | null>;
  attemptsForItem(itemId: string): Promise<ItemAttempts>;
  verdictNote(sha: string): Promise<string | null>;
  closeRaceEntries(input: { hive: string; raceId: string; user: string }): Promise<{ outcome: string; race: Race }>;
  pick(input: { hive: string; raceId: string; user: string; pick: PickRace }): Promise<{ outcome: string; race: Race }>;
}

/** The edge's HiveRegistry, read-only. */
export interface RegistryPort {
  list(): Promise<Project[]>;
  get(hive: string): Promise<Project | null>;
}

/** An attempt of the agent, as its AgentIdentity remembers it (the hive is how own-only tools find it). */
export interface AttemptRef {
  hive: string;
  attemptId: string;
  open: boolean;
}

export interface IdentityPort {
  /** Idempotent: an existing record wins. */
  create(identity: McpAgentIdentity): Promise<McpAgentIdentity>;
  get(): Promise<McpAgentIdentity | null>;
  attempts(): Promise<AttemptRef[]>;
  addAttempt(ref: { hive: string; attemptId: string }): Promise<void>;
  closeAttempt(attemptId: string): Promise<void>;
}

/** The subset of an Artifacts repo handle queenos-mcp uses (the real `ArtifactsRepo` fits it). */
export interface McpRepoHandle extends Disposable {
  info(): Promise<{ remote: string }>;
  createToken(scope: "read" | "write", ttl: number): Promise<{ id: string; plaintext: string; expiresAt: string }>;
  listTokens(): Promise<{ tokens: { id: string; state: string }[] }>;
  revokeToken(tokenOrId: string): Promise<boolean>;
  log(opts?: { ref?: string; limit?: number }): Promise<{ hash: string }[]>;
  fork(name: string, opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean }): Promise<unknown>;
}

export interface McpArtifacts {
  get(name: string): Promise<McpRepoHandle>;
  delete(name: string): Promise<boolean>;
}

export interface McpPorts {
  queen(hive: string): QueenPort;
  registry: RegistryPort;
  identity(agentId: string): IdentityPort;
  artifacts: McpArtifacts;
  fork: ForkDeps;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** `ag_` + 32 hex (128 random bits). */
  newAgentId(): string;
}

export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** QUEEN / REGISTRY / ARTIFACTS exist in prod; `wrangler types` marks them optional because the vitest-only `test` env omits them. */
export function createProdPorts(rawEnv: Env): McpPorts {
  const env = rawEnv as Required<Env>;
  const artifacts = env.ARTIFACTS as unknown as McpArtifacts;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const now = () => Date.now();
  return {
    queen: (hive) => env.QUEEN.get(env.QUEEN.idFromName(hive)) as unknown as QueenPort,
    registry: env.REGISTRY.get(env.REGISTRY.idFromName("registry")) as unknown as RegistryPort,
    identity: (agentId) => env.AGENT_IDENTITY.get(env.AGENT_IDENTITY.idFromName(agentId)) as unknown as IdentityPort,
    artifacts,
    fork: forkDepsFor(artifacts, (input, init) => fetch(input, init), sleep, now),
    sleep,
    now,
    newAgentId: () => `ag_${randomHex(16)}`,
  };
}

/**
 * Genesis ports: every side effect goes through this object (mirrors
 * apps/drones). Tests swap in fakes via GenesisNode.createPorts().
 */
import { createAiClient, type AiRunner, type CompletionRequest, type CompletionResult } from "@queenos/hive-kit";
import type { MergeTrain, Project, ProvisionCommand, SubmitPrompt, VaultStatus } from "@queenos/queen-types";

/** RPC surface of apps/edge's HiveRegistry (cross-script DO, idFromName("registry")). */
export interface RegistryPort {
  register(input: { hive: string; name: string; description: string; createdBy: string }): Promise<Project>;
  update(
    hive: string,
    patch: { status?: Project["status"]; name?: string; description?: string; urls?: Partial<Project["urls"]> },
  ): Promise<Project>;
}

/** apps/vault's VaultWriter entrypoint: status only. Genesis never reads or writes secrets. */
export interface VaultPort {
  status(hive: string): Promise<VaultStatus>;
}

/** RPC surface of apps/queen's QueenNode used by Genesis. */
export interface QueenPort {
  submitPrompt(input: SubmitPrompt): Promise<{ promptId: string }>;
  getSnapshot(): Promise<{ trains: MergeTrain[] }> | { trains: MergeTrain[] };
}

export interface ProvisionerPort {
  /** Start a CREATE_HIVE Workflow instance (instance id = commandId). */
  createHive(cmd: Extract<ProvisionCommand, { op: "CREATE_HIVE" }>): Promise<void>;
}

export interface LlmPort {
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export interface GenesisPorts {
  registry: RegistryPort;
  vault: VaultPort;
  queen(hive: string): QueenPort;
  provisioner: ProvisionerPort;
  /** Null in scripted mode. */
  llm: LlmPort | null;
  now(): number;
  randomId(): string;
}

export interface GenesisConfig {
  llmMode: "scripted" | "live";
  model: string;
  gatewayId: string;
  /** Alarm cadence while launching. */
  pollMs: number;
  /** Launch -> ACTIVE budget. */
  launchTimeoutMs: number;
}

export function loadConfig(env: Partial<Record<string, unknown>>): GenesisConfig {
  const str = (k: string, d: string) => (typeof env[k] === "string" && (env[k] as string).trim() ? (env[k] as string).trim() : d);
  const num = (k: string, d: number) => {
    const n = Number(env[k]);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    llmMode: str("GENESIS_LLM_MODE", "scripted") === "live" ? "live" : "scripted",
    model: str("MODEL_GENESIS", "anthropic/claude-sonnet-5-5"),
    gatewayId: str("AI_GATEWAY_ID", "queenos"),
    pollMs: num("GENESIS_POLL_MS", 5_000),
    launchTimeoutMs: num("GENESIS_LAUNCH_TIMEOUT_MS", 10 * 60_000),
  };
}

export interface GenesisEnvBindings {
  AI?: Ai;
  REGISTRY?: DurableObjectNamespace;
  QUEEN?: DurableObjectNamespace;
  VAULT?: unknown;
  PROVISIONER?: Workflow<unknown>;
  /** DEV ONLY (.dev.vars): "1" lets a missing PROVISIONER be faked by the GenesisNode. */
  GENESIS_DEV_FAKE_PROVISIONER?: string;
}

const missing = (name: string): never => {
  throw new Error(`UNAVAILABLE: ${name} binding is not configured`);
};

/**
 * True only with the explicit dev flag (.dev.vars; never in wrangler.jsonc). The wrangler
 * config still declares PROVISIONER locally, but with no Provisioner Worker running
 * its Workflow create() never completes, so the flag wins over the binding.
 */
export const devFakesProvisioner = (env: GenesisEnvBindings): boolean => env.GENESIS_DEV_FAKE_PROVISIONER === "1";

export function createProdPorts(env: GenesisEnvBindings, config: GenesisConfig): GenesisPorts {
  const registryStub = () => {
    const ns = env.REGISTRY ?? missing("REGISTRY");
    return ns.get(ns.idFromName("registry")) as unknown as RegistryPort;
  };
  return {
    registry: {
      register: (input) => registryStub().register(input),
      update: (hive, patch) => registryStub().update(hive, patch),
    },
    vault: { status: (hive) => ((env.VAULT ?? missing("VAULT")) as VaultPort).status(hive) },
    queen: (hive) => {
      const ns = env.QUEEN ?? missing("QUEEN");
      return ns.get(ns.idFromName(hive)) as unknown as QueenPort;
    },
    provisioner: {
      async createHive(cmd) {
        const wf = env.PROVISIONER ?? missing("PROVISIONER");
        try {
          await wf.create({ id: cmd.commandId, params: cmd });
        } catch (e) {
          if (!/already.*exist|exists/i.test(String((e as Error)?.message ?? e))) throw e; // idempotent dispatch
        }
      },
    },
    llm:
      config.llmMode === "live"
        ? createAiClient({ ai: (env.AI ?? missing("AI")) as unknown as AiRunner, gatewayId: config.gatewayId })
        : null,
    now: () => Date.now(),
    randomId: () => crypto.randomUUID(),
  };
}

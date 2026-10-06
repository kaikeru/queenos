/**
 * Herald ports: every side effect goes through this object (mirrors
 * apps/drones). Tests swap in fakes via HeraldWorkflow.createPorts().
 */
import type { DeployResult } from "@queenos/queen-types";
import { CloudflareClient, cloneRepo, type GitRepo } from "@queenos/hive-kit";

// ── Artifacts ────────────────────────────────────────────────────────────

export interface RepoAccess {
  remote: string;
  /** Short-lived repo token. Never leaves the step that minted it. */
  token: string;
}

export interface ArtifactsPort {
  access(repo: string, scope: "read" | "write"): Promise<RepoAccess>;
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
}

// ── git ──────────────────────────────────────────────────────────────────

export type GitSession = Pick<GitRepo, "head" | "listFiles" | "readFiles">;

export interface CloneRequest {
  remote: string;
  token: string;
  depth: number;
}

export interface GitPort {
  clone(req: CloneRequest): Promise<GitSession>;
}

export const isomorphicGitPort: GitPort = {
  clone: (req) => cloneRepo({ remote: req.remote, token: req.token, depth: req.depth }),
};

// ── Cloudflare credentials ───────────────────────────────────────────────

export interface CloudflareCredentials {
  accountId: string;
  /** Never returned from a step, logged, or put in an error message. */
  token: string;
}

/**
 * Where deploy credentials come from: the Vault, per hive (apps/vault,
 * docs/deploy-discovery.md §6). Call it inside the step that uses the
 * credential; never return, log or persist the value.
 */
export interface CredentialsPort {
  /** `purpose` is recorded in the Vault's audit trail (e.g. the command id). */
  cloudflare(hive: string, purpose?: string): Promise<CloudflareCredentials>;
}

/** RPC surface of the `VaultReader` entrypoint of queenos-vault. */
export interface VaultReaderRpc {
  getCloudflareCredential(hive: string, purpose?: string): Promise<{ accountId: string; apiToken: string }>;
}

/**
 * Reads the hive's Cloudflare credential from the Vault over the VAULT_READER
 * service binding (service "queenos-vault", entrypoint "VaultReader"). Each
 * call is audited by the Vault; nothing is cached here.
 */
export class VaultCredentialsPort implements CredentialsPort {
  constructor(private readonly vault: VaultReaderRpc | undefined) {}
  async cloudflare(hive: string, purpose?: string): Promise<CloudflareCredentials> {
    if (!this.vault) throw new Error("UNAVAILABLE: VAULT_READER binding is not configured");
    const c = await this.vault.getCloudflareCredential(hive, purpose);
    return { accountId: c.accountId, token: c.apiToken };
  }
}

// ── Cloudflare REST ──────────────────────────────────────────────────────

/** The subset of hive-kit's CloudflareClient the Herald uses. */
export type CloudflareApi = Pick<
  CloudflareClient,
  | "ensureWorker"
  | "enableSubdomain"
  | "workerUrl"
  | "getPreview"
  | "createPreview"
  | "deployPreview"
  | "deletePreview"
  | "uploadVersion"
  | "createDeployment"
  | "getCurrentDeployment"
>;

// ── Queen ────────────────────────────────────────────────────────────────

/** RPC surface of apps/queen's QueenNode used by the Herald. */
export interface QueenPort {
  reportDeployResult(input: DeployResult): Promise<unknown>;
}

/** Cross-script DO binding to QueenNode; one DO per hive, `idFromName(hive)`. */
export function queenRpc(ns: DurableObjectNamespace | undefined, hive: string): QueenPort {
  if (!ns) throw new Error("UNAVAILABLE: QUEEN binding is not configured");
  return ns.get(ns.idFromName(hive)) as unknown as QueenPort;
}

// ── bundle ───────────────────────────────────────────────────────────────

export interface HeraldPorts {
  artifacts: ArtifactsPort;
  git: GitPort;
  credentials: CredentialsPort;
  cloudflare(creds: CloudflareCredentials): CloudflareApi;
  queen(hive: string): QueenPort;
  /** Backoff sleep of the in-step transient retry (default setTimeout; tests pass a no-op). */
  sleep?: (ms: number) => Promise<unknown>;
}

export interface HeraldEnvBindings {
  ARTIFACTS?: Artifacts;
  QUEEN?: DurableObjectNamespace;
  /** Service binding to queenos-vault's VaultReader entrypoint. */
  VAULT_READER?: Fetcher | VaultReaderRpc;
}

export function createProdPorts(env: HeraldEnvBindings): HeraldPorts {
  return {
    artifacts: new BindingArtifactsPort(env.ARTIFACTS),
    git: isomorphicGitPort,
    credentials: new VaultCredentialsPort(env.VAULT_READER as VaultReaderRpc | undefined),
    cloudflare: (creds) => new CloudflareClient({ accountId: creds.accountId, token: creds.token }),
    queen: (hive) => queenRpc(env.QUEEN, hive),
  };
}

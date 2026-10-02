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
 * Where deploy credentials come from. P1: wrangler secret + var
 * (EnvCredentialsPort). P2: the Vault DO (`vault.reveal(hive, ref)`), with the
 * same call pattern: reveal inside the step that uses it.
 */
export interface CredentialsPort {
  cloudflare(hive: string): Promise<CloudflareCredentials>;
}

export interface CredentialEnv {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
}

export class EnvCredentialsPort implements CredentialsPort {
  constructor(private readonly env: CredentialEnv) {}
  async cloudflare(): Promise<CloudflareCredentials> {
    const accountId = this.env.CLOUDFLARE_ACCOUNT_ID?.trim();
    const token = this.env.CLOUDFLARE_API_TOKEN?.trim();
    if (!accountId) throw new Error("UNAVAILABLE: CLOUDFLARE_ACCOUNT_ID is not configured");
    if (!token) throw new Error("UNAVAILABLE: the CLOUDFLARE_API_TOKEN secret is not configured");
    return { accountId, token };
  }
}

// ── Cloudflare REST ──────────────────────────────────────────────────────

/** The subset of hive-kit's CloudflareClient the Herald uses. */
export type CloudflareApi = Pick<CloudflareClient, "ensureWorker" | "getPreview" | "createPreview" | "deployPreview" | "deletePreview">;

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
}

export interface HeraldEnvBindings extends CredentialEnv {
  ARTIFACTS?: Artifacts;
  QUEEN?: DurableObjectNamespace;
}

export function createProdPorts(env: HeraldEnvBindings): HeraldPorts {
  return {
    artifacts: new BindingArtifactsPort(env.ARTIFACTS),
    git: isomorphicGitPort,
    credentials: new EnvCredentialsPort(env),
    cloudflare: (creds) => new CloudflareClient({ accountId: creds.accountId, token: creds.token }),
    queen: (hive) => queenRpc(env.QUEEN, hive),
  };
}

/**
 * queenos-vault: the security boundary for deploy credentials
 * (docs/deploy-discovery.md §6).
 *
 * Access control works like IAM, through service bindings. Each consumer binds
 * exactly one named entrypoint:
 *
 *   | entrypoint  | bound by          | methods                                          | returns secrets? |
 *   |-------------|-------------------|--------------------------------------------------|------------------|
 *   | VaultWriter | apps/edge only    | connectCloudflare, status, tokenTemplateUrl      | never            |
 *   | VaultReader | apps/herald only  | getCloudflareCredential (audited per call)       | yes, one per call|
 *
 * The Queen binds neither. The VaultNode DO is bound only by this Worker.
 * The default `fetch` serves `/health` and 404s everything else; the Worker
 * has `workers_dev:false` and no routes, so there is no public HTTP surface.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { HiveSlugSchema, type ConnectCloudflare, type VaultStatus } from "@queenos/queen-types";
import { TOKEN_TEMPLATE_URL } from "./token-template";
import { READER_CALLER, type CloudflareCredential, type VaultEnv, type VaultNode } from "./vault-node";

export { VaultNode } from "./vault-node";
export type { CloudflareCredential } from "./vault-node";

// NOTE: every export of this module is a Worker entrypoint to workerd, so only
// classes and the default handler may be exported here (a string const crashes startup).

function node(env: VaultEnv, hive: unknown): DurableObjectStub<VaultNode> {
  const r = HiveSlugSchema.safeParse(hive);
  if (!r.success) throw new Error("INVALID_INPUT: hive must be a lowercase slug (3-32 chars)");
  return env.VAULT_NODE.get(env.VAULT_NODE.idFromName(r.data));
}

/** Write-only API for the edge Worker. No method returns a secret value. */
export class VaultWriter extends WorkerEntrypoint<VaultEnv> {
  /** Verify (token active + write probe), then store encrypted. `connected:false` means nothing was stored. */
  async connectCloudflare(hive: string, input: ConnectCloudflare, userEmail: string): Promise<VaultStatus> {
    return node(this.env, hive).connectCloudflare(hive, input, userEmail);
  }

  async status(hive: string): Promise<VaultStatus> {
    return node(this.env, hive).status(hive);
  }

  tokenTemplateUrl(): { url: string } {
    return { url: TOKEN_TEMPLATE_URL };
  }
}

/** Read API for the Herald. Every call is audited (never the value). */
export class VaultReader extends WorkerEntrypoint<VaultEnv> {
  /**
   * The hive's Cloudflare credential for one use. Callers must use it inside
   * the step that needs it and never return, log or persist it.
   */
  async getCloudflareCredential(hive: string, purpose?: string): Promise<CloudflareCredential> {
    return node(this.env, hive).revealCloudflare(hive, READER_CALLER, purpose);
  }
}

export default {
  fetch(req: Request): Response {
    if (new URL(req.url).pathname === "/health") return Response.json({ ok: true, service: "vault" });
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<VaultEnv>;

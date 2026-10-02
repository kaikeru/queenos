/** Gatekeeper configuration from vars + secrets (wrangler.jsonc, .dev.vars). */
import { AiGatewayConfigSchema, type AiGatewayConfig } from "@queenos/queen-types";

export type TestMode = "scripted" | "sandbox";
export type ScribeMode = "auto" | "llm" | "extractive";

/** Fast, cheap model for the Scribe (two-sentence compaction). */
export const DEFAULT_SCRIBE_MODEL = "claude-haiku-4-5";

/** Default dependency allowlist; `scope/*` and `prefix*` wildcards are supported. */
export const DEFAULT_ALLOWED_DEPS =
  "hono,zod,acorn,isomorphic-git,@queenos/*,@cloudflare/*,typescript,vitest,wrangler,eslint,typescript-eslint,@types/*";

/** Hosts a train's code may `fetch()` with a literal URL. `*.example.com` matches subdomains. */
export const DEFAULT_ALLOWED_HOSTS = "gateway.ai.cloudflare.com,api.cloudflare.com,*.artifacts.cloudflare.net,localhost,127.0.0.1";

export interface GateConfig {
  testMode: TestMode;
  scribeMode: ScribeMode;
  /** Artifacts namespace whose push events we gate (the trigger filter's twin). */
  artifactsNamespace: string;
  allowedDeps: string[];
  allowedHosts: string[];
  /**
   * Max `lookup train` attempts while waiting for the Queen to reach TESTING.
   * Default 24 x 5 s = 2 min: covers the build-result race AND the preview deploy (DEPLOYING).
   */
  phaseRetries: number;
  phaseWaitMs: number;
  aiGateway: AiGatewayConfig;
  /** Secret CF_AIG_TOKEN; empty means "no LLM" (Scribe falls back to extractive). */
  aiGatewayToken: string;
}

export interface GateVars {
  GATE_TEST_MODE?: string;
  SCRIBE_MODE?: string;
  ARTIFACTS_NAMESPACE?: string;
  POLICY_ALLOWED_DEPS?: string;
  SECURITY_ALLOWED_HOSTS?: string;
  GATE_PHASE_RETRIES?: string;
  GATE_PHASE_WAIT_MS?: string;
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  CF_AIG_TOKEN?: string;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export function splitList(s: string | undefined, fallback: string): string[] {
  return (s === undefined || s.trim() === "" ? fallback : s)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function int(s: string | undefined, fallback: number, min: number, max: number): number {
  const n = s === undefined || s.trim() === "" ? fallback : Number(s);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function readConfig(env: GateVars): GateConfig {
  const testMode = (env.GATE_TEST_MODE ?? "scripted").trim().toLowerCase();
  if (testMode !== "scripted" && testMode !== "sandbox") throw new ConfigError(`GATE_TEST_MODE must be "scripted" or "sandbox", got "${testMode}"`);
  const scribeMode = (env.SCRIBE_MODE ?? "auto").trim().toLowerCase();
  if (scribeMode !== "auto" && scribeMode !== "llm" && scribeMode !== "extractive") {
    throw new ConfigError(`SCRIBE_MODE must be "auto", "llm" or "extractive", got "${scribeMode}"`);
  }
  const gw = {
    accountId: env.AI_GATEWAY_ACCOUNT_ID ?? "",
    gatewayId: env.AI_GATEWAY_ID ?? "",
    provider: (env.AI_PROVIDER ?? "anthropic") as AiGatewayConfig["provider"],
    model: env.AI_MODEL || DEFAULT_SCRIBE_MODEL,
  };
  const token = env.CF_AIG_TOKEN ?? "";
  if (scribeMode === "llm") {
    if (!AiGatewayConfigSchema.safeParse(gw).success) throw new ConfigError("SCRIBE_MODE=llm needs AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID, AI_PROVIDER, AI_MODEL");
    if (!token) throw new ConfigError("SCRIBE_MODE=llm needs the CF_AIG_TOKEN secret");
  }
  return {
    testMode,
    scribeMode,
    artifactsNamespace: env.ARTIFACTS_NAMESPACE?.trim() || "queenos",
    allowedDeps: splitList(env.POLICY_ALLOWED_DEPS, DEFAULT_ALLOWED_DEPS),
    allowedHosts: splitList(env.SECURITY_ALLOWED_HOSTS, DEFAULT_ALLOWED_HOSTS),
    phaseRetries: int(env.GATE_PHASE_RETRIES, 24, 1, 60),
    phaseWaitMs: int(env.GATE_PHASE_WAIT_MS, 5000, 0, 60_000),
    aiGateway: gw,
    aiGatewayToken: token,
  };
}

/** Does `name` match any allowlist entry (exact, or `prefix*` wildcard)? */
export function matchesAllowlist(name: string, allow: readonly string[]): boolean {
  return allow.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
}

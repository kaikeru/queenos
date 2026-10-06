/** Gatekeeper configuration from vars + secrets (wrangler.jsonc, .dev.vars). */
import { modelForRole } from "@queenos/hive-kit";
import type { AiGatewayConfig } from "@queenos/queen-types";
import { DEFAULT_MODEL_REVIEWER, type ReviewMode } from "./review";

export type TestMode = "scripted" | "sandbox";
export type ScribeMode = "auto" | "llm" | "extractive";

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
  /**
   * Gate runs per push when the gate itself fails on infrastructure (GATE_INFRA_ROUNDS, default 3 =
   * the Queen's MAX_INFRA_ATTEMPTS): after an infra report the Queen re-deploys the preview and
   * this instance waits for TESTING again and re-gates.
   */
  infraRounds: number;
  /** Base of the in-step jittered retry of transient (5xx / 429) Artifacts errors (GATE_TRANSIENT_BASE_MS). */
  transientBaseMs: number;
  /** Gateway id and the Scribe model (MODEL_SCRIBE). */
  aiGateway: AiGatewayConfig;
  /** "llm" (production), "scripted" (deterministic, tests/sim) or "off". Unset = "off". */
  reviewMode: ReviewMode;
  /** MODEL_REVIEWER. */
  reviewModel: string;
  /** Per-call reviewer timeout; the call is retried once, then the gate fails open. */
  reviewTimeoutMs: number;
}

export interface GateVars {
  GATE_TEST_MODE?: string;
  SCRIBE_MODE?: string;
  ARTIFACTS_NAMESPACE?: string;
  POLICY_ALLOWED_DEPS?: string;
  SECURITY_ALLOWED_HOSTS?: string;
  GATE_PHASE_RETRIES?: string;
  GATE_PHASE_WAIT_MS?: string;
  GATE_INFRA_ROUNDS?: string;
  GATE_TRANSIENT_BASE_MS?: string;
  AI_GATEWAY_ID?: string;
  MODEL_SCRIBE?: string;
  REVIEW_MODE?: string;
  MODEL_REVIEWER?: string;
  REVIEW_TIMEOUT_MS?: string;
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
  const reviewMode = (env.REVIEW_MODE ?? "off").trim().toLowerCase() || "off";
  if (reviewMode !== "llm" && reviewMode !== "off" && reviewMode !== "scripted") {
    throw new ConfigError(`REVIEW_MODE must be "llm", "off" or "scripted", got "${reviewMode}"`);
  }
  return {
    testMode,
    scribeMode,
    artifactsNamespace: env.ARTIFACTS_NAMESPACE?.trim() || "queenos",
    allowedDeps: splitList(env.POLICY_ALLOWED_DEPS, DEFAULT_ALLOWED_DEPS),
    allowedHosts: splitList(env.SECURITY_ALLOWED_HOSTS, DEFAULT_ALLOWED_HOSTS),
    phaseRetries: int(env.GATE_PHASE_RETRIES, 24, 1, 60),
    phaseWaitMs: int(env.GATE_PHASE_WAIT_MS, 5000, 0, 60_000),
    infraRounds: int(env.GATE_INFRA_ROUNDS, 3, 1, 8),
    transientBaseMs: int(env.GATE_TRANSIENT_BASE_MS, 2000, 0, 30_000),
    aiGateway: { gatewayId: env.AI_GATEWAY_ID?.trim() || "queenos", model: modelForRole("SCRIBE", env) },
    reviewMode,
    reviewModel: env.MODEL_REVIEWER?.trim() || DEFAULT_MODEL_REVIEWER,
    reviewTimeoutMs: int(env.REVIEW_TIMEOUT_MS, 60_000, 1, 300_000),
  };
}

/** Does `name` match any allowlist entry (exact, or `prefix*` wildcard)? */
export function matchesAllowlist(name: string, allow: readonly string[]): boolean {
  return allow.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
}

/** Drone configuration from vars + secrets (wrangler.jsonc, .dev.vars). */
import { AiGatewayConfigSchema, type AiGatewayConfig } from "@queenos/queen-types";

export type LlmMode = "live" | "scripted";

export const DEFAULT_MODEL = "claude-opus-5-5";

export interface DroneConfig {
  llmMode: LlmMode;
  /** Artificial "thinking" delay in scripted mode (a durable step.sleep). */
  scriptedDelayMs: number;
  aiGateway: AiGatewayConfig;
  /** Secret CF_AIG_TOKEN; required in live mode only. */
  aiGatewayToken: string;
  /**
   * Recorded in the ledger. Only sent to the provider when AI_TEMPERATURE is
   * set: Claude Opus 5.5 rejects sampling params, so the default is "unset"
   * and the ledger records the provider default (1).
   */
  temperature: number;
  sendTemperature: boolean;
}

export interface DroneVars {
  DRONE_LLM_MODE?: string;
  DRONE_SCRIPTED_DELAY_MS?: string;
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  AI_TEMPERATURE?: string;
  CF_AIG_TOKEN?: string;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export function readConfig(env: DroneVars): DroneConfig {
  const mode = (env.DRONE_LLM_MODE ?? "scripted").trim().toLowerCase();
  if (mode !== "live" && mode !== "scripted") throw new ConfigError(`DRONE_LLM_MODE must be "live" or "scripted", got "${mode}"`);
  const delay = Number(env.DRONE_SCRIPTED_DELAY_MS ?? "0");
  const temp = env.AI_TEMPERATURE?.trim() ? Number(env.AI_TEMPERATURE) : undefined;
  if (temp !== undefined && (!Number.isFinite(temp) || temp < 0 || temp > 2)) throw new ConfigError("AI_TEMPERATURE must be in [0, 2]");

  const gw = {
    accountId: env.AI_GATEWAY_ACCOUNT_ID ?? "",
    gatewayId: env.AI_GATEWAY_ID ?? "",
    provider: (env.AI_PROVIDER ?? "anthropic") as AiGatewayConfig["provider"],
    model: env.AI_MODEL || DEFAULT_MODEL,
  };
  let aiGateway: AiGatewayConfig;
  if (mode === "live") {
    const parsed = AiGatewayConfigSchema.safeParse(gw);
    if (!parsed.success) {
      throw new ConfigError(`live mode needs AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID, AI_PROVIDER, AI_MODEL: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
    }
    if (!env.CF_AIG_TOKEN) throw new ConfigError("live mode needs the CF_AIG_TOKEN secret");
    aiGateway = parsed.data;
  } else {
    aiGateway = gw; // unused for calls; model name is still recorded
  }
  return {
    llmMode: mode,
    scriptedDelayMs: Number.isFinite(delay) && delay > 0 ? Math.min(delay, 60_000) : 0,
    aiGateway,
    aiGatewayToken: env.CF_AIG_TOKEN ?? "",
    temperature: temp ?? 1,
    sendTemperature: temp !== undefined,
  };
}

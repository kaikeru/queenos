/** Drone configuration from vars + secrets (wrangler.jsonc, .dev.vars). */
import { modelForRole } from "@queenos/hive-kit";
import type { AiGatewayConfig } from "@queenos/queen-types";

export type LlmMode = "live" | "scripted";
/** Live builder: the Think tool-loop agent (default) or the legacy single-shot JSON generator (kill switch). */
export type Harness = "agent" | "single-shot";

export interface DroneConfig {
  llmMode: LlmMode;
  harness: Harness;
  /** Artificial "thinking" delay in scripted mode (a durable step.sleep). */
  scriptedDelayMs: number;
  /** Gateway id and the Builder model (MODEL_BUILDER). The model is recorded in the ledger. */
  aiGateway: AiGatewayConfig;
  /**
   * Recorded in the ledger. Only sent to the provider when AI_TEMPERATURE is
   * set: some models reject sampling params, so the default is "unset"
   * and the ledger records the provider default (1).
   */
  temperature: number;
  sendTemperature: boolean;
}

export interface DroneVars {
  DRONE_LLM_MODE?: string;
  DRONE_HARNESS?: string;
  DRONE_SCRIPTED_DELAY_MS?: string;
  AI_GATEWAY_ID?: string;
  MODEL_BUILDER?: string;
  AI_TEMPERATURE?: string;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export function readConfig(env: DroneVars): DroneConfig {
  const mode = (env.DRONE_LLM_MODE ?? "scripted").trim().toLowerCase();
  if (mode !== "live" && mode !== "scripted") throw new ConfigError(`DRONE_LLM_MODE must be "live" or "scripted", got "${mode}"`);
  const harness = (env.DRONE_HARNESS ?? "agent").trim().toLowerCase();
  if (harness !== "agent" && harness !== "single-shot") throw new ConfigError(`DRONE_HARNESS must be "agent" or "single-shot", got "${harness}"`);
  const delay = Number(env.DRONE_SCRIPTED_DELAY_MS ?? "0");
  const temp = env.AI_TEMPERATURE?.trim() ? Number(env.AI_TEMPERATURE) : undefined;
  if (temp !== undefined && (!Number.isFinite(temp) || temp < 0 || temp > 2)) throw new ConfigError("AI_TEMPERATURE must be in [0, 2]");

  const aiGateway: AiGatewayConfig = { gatewayId: env.AI_GATEWAY_ID?.trim() || "queenos", model: modelForRole("BUILDER", env) };
  return {
    llmMode: mode,
    harness,
    scriptedDelayMs: Number.isFinite(delay) && delay > 0 ? Math.min(delay, 60_000) : 0,
    aiGateway,
    temperature: temp ?? 1,
    sendTemperature: temp !== undefined,
  };
}

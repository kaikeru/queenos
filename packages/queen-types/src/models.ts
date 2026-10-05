import { z } from "zod";

/**
 * Model catalog and routing. Every LLM call goes through the Workers `ai`
 * binding and AI Gateway "queenos", so any catalog model is one string away.
 * The Queen picks the model for each drone task (role, attempt, track record)
 * and records why; executors just run what they are given.
 */

export const ModelTierSchema = z.enum(["light", "fast", "frontier"]);
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const ModelRoleSchema = z.enum(["builder", "rework", "scribe", "genesis"]);
export type ModelRole = z.infer<typeof ModelRoleSchema>;

export const CatalogModelSchema = z.object({
  /** Workers AI / AI Gateway model id, e.g. "@cf/zai-org/glm-5.3". */
  id: z.string().min(1),
  label: z.string().min(1),
  tier: ModelTierSchema,
  contextWindow: z.number().int().positive(),
  /** Relative cost weight (1 = cheapest); used as a tiebreak, not billing. */
  cost: z.number().positive(),
  /** Roles this model is a sensible choice for. */
  roles: z.array(ModelRoleSchema).min(1),
});
export type CatalogModel = z.infer<typeof CatalogModelSchema>;

/**
 * Default catalog (verified available on the account via /ai/models/search on 2026-10-05).
 * Order within a tier is the default preference before any track record exists;
 * set from the real-account bake-off in docs/model-bakeoff.md (2026-10-05).
 */
export const MODEL_CATALOG: readonly CatalogModel[] = [
  { id: "@cf/deepseek-ai/deepseek-v4-pro-0813", label: "DeepSeek V4 Pro", tier: "frontier", contextWindow: 1048576, cost: 9, roles: ["builder", "rework"] },
  { id: "@cf/moonshotai/kimi-k2.7-code", label: "Kimi K2.7 Code", tier: "frontier", contextWindow: 262144, cost: 8, roles: ["builder", "rework"] },
  { id: "@cf/zai-org/glm-5.3", label: "GLM-5.3", tier: "frontier", contextWindow: 1048576, cost: 8, roles: ["builder", "rework", "genesis"] },
  { id: "@cf/deepseek-ai/deepseek-v4-flash-0731", label: "DeepSeek V4 Flash", tier: "fast", contextWindow: 1048576, cost: 3, roles: ["builder", "rework"] },
  { id: "@cf/zai-org/glm-5.3-flash", label: "GLM-5.3 Flash", tier: "fast", contextWindow: 1048576, cost: 3, roles: ["builder", "genesis", "scribe"] },
  { id: "@cf/qwen/qwen3.8-27b", label: "Qwen 3.8 27B", tier: "fast", contextWindow: 262144, cost: 2, roles: ["builder", "genesis"] },
  { id: "@cf/zai-org/glm-4.7-flash", label: "GLM-4.7 Flash", tier: "light", contextWindow: 131072, cost: 1, roles: ["scribe", "genesis"] },
  { id: "@cf/ibm-granite/granite-4.0-h-micro", label: "Granite 4.0 Micro", tier: "light", contextWindow: 131000, cost: 1, roles: ["scribe"] },
  { id: "@cf/meta/llama-3.2-3b-instruct", label: "Llama 3.2 3B", tier: "light", contextWindow: 80000, cost: 1, roles: ["scribe"] },
];

/** Why the router picked a model; shown on train cards and in the ledger. */
export const ModelChoiceSchema = z.object({
  model: z.string().min(1),
  tier: ModelTierSchema,
  role: ModelRoleSchema,
  /** Short human reason, e.g. "rework attempt 2 → escalated to frontier". */
  reason: z.string().max(200),
  /** Next models to try if this one fails to produce a valid change set. */
  fallbacks: z.array(z.string()).max(3).default([]),
});
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;

/** Per-hive track record the router learns from (Queen SQLite). */
export const ModelStatsSchema = z.object({
  model: z.string(),
  role: ModelRoleSchema,
  attempts: z.number().int().min(0),
  /** Trains whose build passed the gate (preview smoke + scans). */
  passes: z.number().int().min(0),
  /** Builds that failed to produce a usable change set, or failed the gate. */
  failures: z.number().int().min(0),
  avgBuildMs: z.number().min(0).nullable(),
  updatedAt: z.number().int(),
});
export type ModelStats = z.infer<typeof ModelStatsSchema>;

/** Hive-wide builder tier floor (AIMD): raised on failures, lowered after a streak of passes. */
export const RouterFloorSchema = z.object({
  tier: ModelTierSchema,
  /** Consecutive builder passes at the current floor (toward backing off). */
  streak: z.number().int().min(0),
  /** Passes needed at this floor before backing off one tier. */
  backoffAfter: z.number().int().min(1),
  /** Builder dispatches until the next probe one tier down (null when already at the cheapest tier). */
  probeIn: z.number().int().min(0).nullable(),
});
export type RouterFloor = z.infer<typeof RouterFloorSchema>;

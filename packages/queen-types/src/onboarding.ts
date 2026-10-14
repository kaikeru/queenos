import { z } from "zod";

/**
 * Onboarding contracts (P2): Hive Charter, Registry, Vault status, Genesis wizard.
 * Every browser call goes through the edge Worker at queenos.example.com, behind
 * Cloudflare Access. The edge verifies the Access JWT and forwards the caller's
 * email to internal Workers over service bindings in `x-queen-user`.
 */

/** Hive slug: also the Artifacts repo name and the Queen DO name. */
export const HiveSlugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/, "lowercase letters, digits and dashes; 3-32 chars");
export type HiveSlug = z.infer<typeof HiveSlugSchema>;

// ---------- Hive Charter (.queen/charter.json in the hive repo) ----------

export const CharterSchema = z.object({
  version: z.literal(1),
  hive: HiveSlugSchema,
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(2000),
  stack: z.object({
    /** P2 supports one target and one template. */
    target: z.literal("cloudflare-workers"),
    template: z.literal("worker-starter"),
    language: z.literal("javascript"),
  }),
  environments: z.object({
    preview: z.literal(true),
    staging: z.boolean().default(true),
    /** Prod always requires a human tap to ship. */
    prod: z.boolean().default(true),
  }),
  policy: z.object({
    allowedDeps: z.array(z.string()).default([]),
    allowedHosts: z.array(z.string()).default([]),
  }),
  /** Secret NAMES only (e.g. "cloudflare"); values live in the Vault. */
  secrets: z.array(z.string().regex(/^[a-z0-9-]{1,40}$/)).default(["cloudflare"]),
  /** Optional per-role model overrides (`@cf/...` or `anthropic/...`). */
  models: z.object({ builder: z.string().optional(), scribe: z.string().optional() }).default({}),
  /** The first prompt submitted to the merge train once the hive exists. */
  firstPrompt: z.string().min(1).max(4000),
});
export type Charter = z.infer<typeof CharterSchema>;
export type CharterInput = z.input<typeof CharterSchema>;

// ---------- Registry (project list; orchestration metadata only, no secrets) ----------

export const ProjectStatusSchema = z.enum(["ONBOARDING", "ACTIVE", "FAILED"]);

export const ProjectSchema = z.object({
  hive: HiveSlugSchema,
  name: z.string(),
  description: z.string(),
  status: ProjectStatusSchema,
  createdBy: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /** Latest known prod/staging/preview URLs, for the projects home. */
  urls: z
    .object({ prod: z.string().nullable(), staging: z.string().nullable(), preview: z.string().nullable() })
    .default({ prod: null, staging: null, preview: null }),
});
export type Project = z.infer<typeof ProjectSchema>;

// ---------- Vault (write-only from the browser) ----------

export const ConnectCloudflareSchema = z.object({
  accountId: z.string().regex(/^[0-9a-f]{32}$/),
  /** Sent once over TLS to the edge, stored encrypted, never returned. */
  apiToken: z.string().min(20).max(400),
});
export type ConnectCloudflare = z.infer<typeof ConnectCloudflareSchema>;

export const VaultStatusSchema = z.object({
  hive: HiveSlugSchema,
  secret: z.string(),
  connected: z.boolean(),
  accountId: z.string().nullable(),
  verifiedAt: z.number().int().nullable(),
  /** Human-readable check results, e.g. "token active", "can upload Workers". */
  checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string().max(300).optional() })).default([]),
});
export type VaultStatus = z.infer<typeof VaultStatusSchema>;

// ---------- Genesis wizard ----------

export const WizardStepSchema = z.enum([
  "DESCRIBE", // chatting; charter draft evolving
  "CHARTER_READY", // user confirmed the charter
  "DEPLOY_CONNECTED", // Vault verified the Cloudflare token
  "HIVE_CREATING", // Provisioner CREATE_HIVE dispatched
  "FIRST_FLIGHT", // first prompt submitted to the Queen; waiting for a preview URL
  "ACTIVE", // first preview live
  "FAILED",
]);
export type WizardStep = z.infer<typeof WizardStepSchema>;

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(8000),
  at: z.number().int(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const WizardStateSchema = z.object({
  hive: HiveSlugSchema,
  step: WizardStepSchema,
  messages: z.array(ChatMessageSchema),
  /** Partial while DESCRIBE; a valid Charter from CHARTER_READY onwards. */
  charterDraft: z.record(z.string(), z.unknown()).nullable(),
  vault: VaultStatusSchema.nullable(),
  previewUrl: z.string().nullable(),
  lastError: z.string().max(500).nullable(),
  updatedAt: z.number().int(),
});
export type WizardState = z.infer<typeof WizardStateSchema>;

/** POST /api/genesis: start a new project. */
export const StartGenesisSchema = z.object({ hive: HiveSlugSchema, name: z.string().min(1).max(80) });
/** POST /api/genesis/:hive/messages */
export const GenesisMessageSchema = z.object({ text: z.string().min(1).max(4000) });
/** PUT /api/genesis/:hive/charter: user edits, then confirms. */
export const ConfirmCharterSchema = z.object({ charter: CharterSchema });

/**
 * Edge HTTP API (all JSON, all behind Access):
 *   GET  /api/me                            -> { email }
 *   GET  /api/projects                      -> Project[]
 *   POST /api/genesis                       StartGenesis -> WizardState
 *   GET  /api/genesis/:hive                 -> WizardState
 *   POST /api/genesis/:hive/messages        GenesisMessage -> WizardState
 *   PUT  /api/genesis/:hive/charter         ConfirmCharter -> WizardState   (DESCRIBE -> CHARTER_READY)
 *   POST /api/vault/:hive/cloudflare        ConnectCloudflare -> VaultStatus (Genesis advances to DEPLOY_CONNECTED)
 *   GET  /api/vault/:hive/status            -> VaultStatus
 *   GET  /api/vault/token-template          -> { url }  (pre-filled Cloudflare "create token" link)
 *   POST /api/genesis/:hive/launch          -> WizardState  (CREATE_HIVE, then first flight)
 *   *    /hives/:hive/...                   -> Queen (existing API + WebSocket room)
 */

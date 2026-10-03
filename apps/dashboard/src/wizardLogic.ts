/** Pure wizard logic: step → screen mapping, charter form, connect form state. Unit-tested. */
import {
  CharterSchema,
  ConnectCloudflareSchema,
  HiveSlugSchema,
  type Charter,
  type VaultStatus,
  type WizardStep,
} from "@queenos/queen-types";

// ---------- step → screen ----------

export type Screen = "describe" | "review" | "connect" | "launch" | "flight" | "active" | "failed";

/** WizardState.step drives the screen; `reviewing` is the client-only sub-view of DESCRIBE. */
export function screenFor(step: WizardStep, reviewing = false): Screen {
  switch (step) {
    case "DESCRIBE":
      return reviewing ? "review" : "describe";
    case "CHARTER_READY":
      return "connect";
    case "DEPLOY_CONNECTED":
      return "launch";
    case "HIVE_CREATING":
    case "FIRST_FLIGHT":
      return "flight";
    case "ACTIVE":
      return "active";
    case "FAILED":
      return "failed";
  }
}

export const STEPPER = [
  { screen: "describe", label: "Describe" },
  { screen: "review", label: "Review charter" },
  { screen: "connect", label: "Connect Cloudflare" },
  { screen: "launch", label: "Launch" },
  { screen: "flight", label: "First flight" },
] as const;

/** Index of the current stepper step (STEPPER.length means everything is done). */
export function stepperIndex(screen: Screen): number {
  if (screen === "active") return STEPPER.length;
  if (screen === "failed") return STEPPER.length - 1;
  return STEPPER.findIndex((s) => s.screen === screen);
}

export function isPolling(step: WizardStep): boolean {
  return step === "HIVE_CREATING" || step === "FIRST_FLIGHT";
}

export type TimelineState = "done" | "active" | "pending";
export interface TimelineItem {
  label: string;
  state: TimelineState;
}

export function timelineFor(step: WizardStep): TimelineItem[] {
  const labels = ["Creating repo", "Seeding template", "First prompt on the merge train", "Deploying preview"];
  const active: number[] =
    step === "HIVE_CREATING" ? [0, 1] : step === "FIRST_FLIGHT" ? [3] : [];
  const doneUpTo = step === "HIVE_CREATING" ? -1 : step === "FIRST_FLIGHT" ? 2 : step === "ACTIVE" ? 3 : -1;
  return labels.map((label, i) => ({
    label,
    state: i <= doneUpTo ? "done" : active.includes(i) ? "active" : "pending",
  }));
}

// ---------- charter ----------

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A full editable Charter from a (possibly partial) draft. */
export function charterFormFromDraft(hive: string, draft: Record<string, unknown> | null): Charter {
  const d = draft ?? {};
  const env = obj(d.environments);
  const policy = obj(d.policy);
  const models = obj(d.models);
  const secrets = strs(d.secrets);
  return {
    version: 1,
    hive: HiveSlugSchema.safeParse(d.hive).success ? (d.hive as string) : hive,
    name: str(d.name),
    description: str(d.description),
    stack: { target: "cloudflare-workers", template: "worker-starter", language: "javascript" },
    environments: { preview: true, staging: bool(env.staging, true), prod: bool(env.prod, true) },
    policy: { allowedDeps: strs(policy.allowedDeps), allowedHosts: strs(policy.allowedHosts) },
    secrets: secrets.length ? secrets : ["cloudflare"],
    models: {
      ...(typeof models.builder === "string" ? { builder: models.builder } : {}),
      ...(typeof models.scribe === "string" ? { scribe: models.scribe } : {}),
    },
    firstPrompt: str(d.firstPrompt),
  };
}

export type CharterValidation =
  | { ok: true; charter: Charter }
  | { ok: false; errors: Record<string, string> };

const NESTED = new Set(["policy", "stack", "environments", "models"]);

/** Validate with CharterSchema; errors are keyed by field ("name", "policy.allowedDeps", ...). */
export function validateCharter(input: unknown): CharterValidation {
  const r = CharterSchema.safeParse(input);
  if (r.success) return { ok: true, charter: r.data };
  const errors: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const path = issue.path.map(String);
    const key = (NESTED.has(path[0] ?? "") ? path.slice(0, 2) : path.slice(0, 1)).join(".") || "charter";
    if (!(key in errors)) errors[key] = friendly(key, issue.code, issue.message);
  }
  return { ok: false, errors };
}

function friendly(key: string, code: string, message: string): string {
  if (code === "too_small" || code === "invalid_type") return "Required";
  if (code === "too_big") {
    const max = { name: 80, description: 2000, firstPrompt: 4000 }[key];
    if (max) return `Max ${max} characters`;
  }
  return message;
}

export interface CharterPreview {
  name: string | null;
  description: string | null;
  allowedDeps: string[];
  allowedHosts: string[];
  staging: boolean | null;
  prod: boolean | null;
  firstPrompt: string | null;
  /** Fraction of the required fields (name, description, firstPrompt) present, 0..1. */
  completeness: number;
}

export function previewFromDraft(draft: Record<string, unknown> | null): CharterPreview {
  const d = draft ?? {};
  const env = obj(d.environments);
  const policy = obj(d.policy);
  const name = str(d.name) || null;
  const description = str(d.description) || null;
  const firstPrompt = str(d.firstPrompt) || null;
  return {
    name,
    description,
    allowedDeps: strs(policy.allowedDeps),
    allowedHosts: strs(policy.allowedHosts),
    staging: typeof env.staging === "boolean" ? env.staging : null,
    prod: typeof env.prod === "boolean" ? env.prod : null,
    firstPrompt,
    completeness: [name, description, firstPrompt].filter(Boolean).length / 3,
  };
}

/** Add a tag (trimmed, no empties, no duplicates). */
export function addTag(tags: string[], raw: string): string[] {
  const t = raw.trim().replace(/,+$/, "").trim();
  return t && !tags.includes(t) ? [...tags, t] : tags;
}

// ---------- hive slug ----------

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 32)
    .replace(/-+$/, "");
}

export function validateSlug(slug: string): string | null {
  const r = HiveSlugSchema.safeParse(slug);
  return r.success ? null : "Use lowercase letters, digits and dashes; 3-32 characters, starting with a letter";
}

// ---------- connect Cloudflare form ----------

export interface ConnectForm {
  accountId: string;
  /** Held only while being typed. Cleared synchronously on submit, whatever the result. */
  apiToken: string;
  phase: "idle" | "submitting" | "failed" | "connected";
  status: VaultStatus | null;
  error: string | null;
}

export const initialConnect: ConnectForm = { accountId: "", apiToken: "", phase: "idle", status: null, error: null };

export type ConnectAction =
  | { type: "edit"; field: "accountId" | "apiToken"; value: string }
  | { type: "submit" }
  | { type: "result"; status: VaultStatus }
  | { type: "error"; message: string; status?: VaultStatus | null };

export function connectReducer(s: ConnectForm, a: ConnectAction): ConnectForm {
  switch (a.type) {
    case "edit":
      return { ...s, [a.field]: a.value, error: null };
    case "submit":
      return { ...s, apiToken: "", phase: "submitting", error: null };
    case "result":
      return { ...s, apiToken: "", status: a.status, phase: a.status.connected ? "connected" : "failed", error: null };
    case "error":
      return { ...s, apiToken: "", phase: "failed", status: a.status ?? s.status, error: a.message };
  }
}

export type ConnectValidation =
  | { ok: true; payload: { accountId: string; apiToken: string } }
  | { ok: false; errors: { accountId?: string; apiToken?: string } };

export function validateConnect(form: Pick<ConnectForm, "accountId" | "apiToken">): ConnectValidation {
  const r = ConnectCloudflareSchema.safeParse({ accountId: form.accountId.trim(), apiToken: form.apiToken.trim() });
  if (r.success) return { ok: true, payload: r.data };
  const errors: { accountId?: string; apiToken?: string } = {};
  for (const issue of r.error.issues) {
    if (issue.path[0] === "accountId") errors.accountId = "Account ID is 32 hex characters";
    if (issue.path[0] === "apiToken") errors.apiToken = "Paste the full API token (20+ characters)";
  }
  return { ok: false, errors };
}

export const lastFour = (accountId: string | null): string => (accountId ? `…${accountId.slice(-4)}` : "…");

/** True once a verification was actually attempted and rejected (a never-connected hive has no checks). */
export const verificationFailed = (status: { connected: boolean; checks: unknown[] } | null | undefined): boolean =>
  !!status && !status.connected && status.checks.length > 0;

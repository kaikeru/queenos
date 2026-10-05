/**
 * The DESCRIBE interview: live prompt/parse for the LLM, and a deterministic
 * scripted twin for demos and tests. Both produce a reply plus a charter draft.
 */
import type { ChatMessage } from "@queenos/queen-types";

export const DEFAULT_MODEL = "@cf/zai-org/glm-5.3-flash";
/** Messages sent to the model (most recent), and the per-message clip. */
export const HISTORY_LIMIT = 12;
export const MESSAGE_CLIP = 2_000;

export type Draft = Record<string, unknown>;

export const SYSTEM_PROMPT = `You are Genesis, the onboarding interviewer for QueenOS. QueenOS builds and ships a new web app on Cloudflare Workers from a plain-English description.

Interview the user concisely. Ask at most three short questions in total across the whole conversation, one or two per turn, about:
1. what the app does,
2. its main routes and features,
3. the dependency and host policy (npm packages it may use, external hosts it may call).
Stop asking once you can draft a charter. Never ask for credentials, tokens or keys: tell the user to use the Connect Cloudflare form instead.

Every turn, answer with ONLY one JSON object, no prose and no code fences:
{"reply": "<one to three short sentences for the user>", "charter": {"name": "<app name>", "description": "<what it does, 1-3 sentences>", "policy": {"allowedDeps": ["<npm package>"], "allowedHosts": ["<hostname>"]}, "firstPrompt": "<the first build instruction for the coding agents: concrete routes and behaviour>"}}
Include only the charter fields you know so far; later turns refine earlier ones. The stack is fixed (a no-build, dependency-free JavaScript Cloudflare Worker), so do not discuss it. allowedDeps and allowedHosts default to empty lists.`;

export interface InterviewResult {
  reply: string;
  /** Partial charter fields to merge into the draft. */
  patch: Draft;
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** The last HISTORY_LIMIT messages, each clipped. */
export function capHistory(messages: ChatMessage[]): { role: "user" | "assistant"; content: string }[] {
  return messages.slice(-HISTORY_LIMIT).map((m) => ({ role: m.role, content: clip(m.content, MESSAGE_CLIP) }));
}

/** A fresh draft with the fixed P2 fields. */
export function baseDraft(hive: string, name: string): Draft {
  return {
    version: 1,
    hive,
    name,
    stack: { target: "cloudflare-workers", template: "worker-starter", language: "javascript" },
    environments: { preview: true, staging: true, prod: true },
    policy: { allowedDeps: [], allowedHosts: [] },
    secrets: ["cloudflare"],
    models: {},
  };
}

const strList = (v: unknown, max = 30): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 120).slice(0, max) : null;

/**
 * Merge a model's partial charter into the draft. Only a whitelist of fields is
 * accepted; the fixed fields (version, hive, stack, preview) can never change.
 */
export function mergeDraft(draft: Draft, patch: unknown): Draft {
  const p = (patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>;
  const out: Draft = { ...draft };
  if (typeof p.name === "string" && p.name.trim()) out.name = clip(p.name.trim(), 80);
  if (typeof p.description === "string" && p.description.trim()) out.description = clip(p.description.trim(), 2_000);
  if (typeof p.firstPrompt === "string" && p.firstPrompt.trim()) out.firstPrompt = clip(p.firstPrompt.trim(), 4_000);
  if (p.policy && typeof p.policy === "object") {
    const pol = p.policy as Record<string, unknown>;
    const cur = (out.policy ?? {}) as Record<string, unknown>;
    out.policy = {
      allowedDeps: strList(pol.allowedDeps) ?? cur.allowedDeps ?? [],
      allowedHosts: strList(pol.allowedHosts) ?? cur.allowedHosts ?? [],
    };
  }
  if (p.environments && typeof p.environments === "object") {
    const e = p.environments as Record<string, unknown>;
    const cur = (out.environments ?? {}) as Record<string, unknown>;
    out.environments = {
      preview: true,
      staging: typeof e.staging === "boolean" ? e.staging : (cur.staging ?? true),
      prod: typeof e.prod === "boolean" ? e.prod : (cur.prod ?? true),
    };
  }
  return out;
}

/** Parse `{"reply","charter"}`; tolerate fences and prose. Unparseable text is the reply with no patch. */
export function parseModelOutput(text: string): InterviewResult {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const j = JSON.parse(trimmed.slice(start, end + 1)) as { reply?: unknown; charter?: unknown };
      const reply = typeof j.reply === "string" && j.reply.trim() ? j.reply.trim() : "Got it.";
      return { reply: clip(reply, 4_000), patch: (j.charter && typeof j.charter === "object" ? j.charter : {}) as Draft };
    } catch {
      /* fall through */
    }
  }
  return { reply: clip(trimmed || "Sorry, I could not produce a reply. Please try again.", 4_000), patch: {} };
}

// ── scripted mode ────────────────────────────────────────────────────────

const HOST_RE = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#]|\b)/gi;

/**
 * Deterministic two-turn interview. Turn 1 drafts a complete, valid charter from
 * the first message and asks about routes and policy. Turn 2 folds the answer in
 * and tells the user to review the charter. Later turns acknowledge.
 */
export function scriptedInterview(draft: Draft, userTurn: number, text: string): InterviewResult {
  const name = String(draft.name ?? "your app");
  const one = text.replace(/\s+/g, " ").trim();
  if (userTurn <= 1) {
    return {
      reply: `Nice: ${name}. I drafted a charter from that. Which routes or features matter most, and may it use any npm packages or call external hosts?`,
      patch: {
        description: clip(one, 2_000),
        firstPrompt: clip(`Build the first working version of ${name}. ${one}`, 4_000),
      },
    };
  }
  if (userTurn === 2) {
    const hosts = [...new Set([...text.matchAll(HOST_RE)].map((m) => m[1]!.toLowerCase()))].slice(0, 10);
    const prev = String(draft.firstPrompt ?? "");
    return {
      reply: "Thanks, the charter is ready. Review it, edit anything you like, then confirm and connect Cloudflare.",
      patch: {
        firstPrompt: clip(`${prev} Routes and features: ${one}`, 4_000),
        policy: { allowedDeps: [], allowedHosts: hosts },
      },
    };
  }
  return { reply: "Noted. Confirm the charter when you are happy with it.", patch: {} };
}

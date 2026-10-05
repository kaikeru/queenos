/**
 * REVIEWER role: does this change satisfy the prompt? Policy, security and the
 * smoke test say the code is safe and alive; only this gate checks intent.
 *
 * Two halves:
 * - buildReviewInput (runs inside the inspect step, where the clone lives):
 *   renders a compact, capped evidence document (prompt, changed files, tree,
 *   what `GET /` on the preview served). Only that string leaves the step.
 * - runReview (its own step): one LLM call with a JSON schema, tolerant parse,
 *   one retry, and a fail-open result when the model is unusable.
 */
import { AiGatewayError, type CompletionRequest, type CompletionResult } from "@queenos/hive-kit";
import { clip } from "./scribe";
import type { SmokeResult } from "./smoke";

export type ReviewMode = "llm" | "off" | "scripted";

export const DEFAULT_MODEL_REVIEWER = "@cf/deepseek-ai/deepseek-v4-flash-0731";
export const SCRIPTED_REVIEW_MODEL = "queenos/review-scripted-v1";
export const REVIEW_FAIL_MARKER = "[review-fail]";
export const MAX_FEEDBACK_CHARS = 400;
export const MAX_REVIEW_ITEMS = 8;
export const MAX_REVIEW_ITEM_CHARS = 200;

/** Input caps (characters). The rendered document never exceeds MAX_REVIEW_INPUT_CHARS. */
export const MAX_REVIEW_INPUT_CHARS = 24_000;
export const MAX_PROMPT_CHARS = 4_000;
export const MAX_COMMIT_CHARS = 800;
export const MAX_TREE_CHARS = 2_000;
export const MAX_PREVIEW_BODY_CHARS = 1_024;
export const MAX_FILE_CHARS = 6_000;
export const MAX_FILES_SHOWN = 20;

export const REVIEWER_SYSTEM_PROMPT = `You are the REVIEWER gatekeeper of a software factory. A builder model changed a repository to satisfy a user's prompt. Policy, security and a smoke test already passed, so the code is safe and serves HTTP. Your single question: does this change satisfy the prompt?

Judge intent, not style. Ignore naming, formatting, test coverage and code quality unless the prompt asked about them.

You get: the prompt, the commit messages, the changed files (full content, possibly truncated), a tree listing, and the preview evidence: the HTTP status, content-type and the first bytes of what GET / actually serves on the deployed preview. Trust the evidence over the builder's claims: if the prompt says to change the page at / and / still serves the old output, the prompt is not satisfied even if a new file exists.

REJECT only when a clear requirement of the prompt is unmet or the change contradicts it. Do not reject for ambiguity you could resolve charitably, or for extra harmless additions. When unsure, APPROVE.

Answer with JSON only:
{"verdict":"APPROVE"|"REJECT","satisfied":[short strings],"missing":[short strings],"feedback":"..."}
- satisfied: requirements of the prompt that are met.
- missing: requirements that are unmet (empty on APPROVE).
- feedback: at most ${MAX_FEEDBACK_CHARS} characters, written directly to the next builder: concrete and actionable, naming files and routes. Example: "/ still returns JSON; the prompt asked to change the status page itself. Make GET / return the HTML page and drop the separate /features/<slug> route." On APPROVE, one short sentence.`;

export const REVIEW_JSON_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["APPROVE", "REJECT"] },
    satisfied: { type: "array", items: { type: "string" } },
    missing: { type: "array", items: { type: "string" } },
    feedback: { type: "string", maxLength: MAX_FEEDBACK_CHARS },
  },
  required: ["verdict", "satisfied", "missing", "feedback"],
  additionalProperties: false,
} as const;

// ── input ───────────────────────────────────────────────────────────────

export interface ReviewEvidence {
  prompt: string;
  commitMessages: string[];
  /** Added/changed files at `after` with their content. */
  changedFiles: Record<string, string>;
  tree: string[];
  rework: boolean;
  /** The smoke probe's view of `GET /`; null when no previewUrl was available. */
  preview: Pick<SmokeResult, "status" | "contentType" | "body"> | null;
}

/** What the inspect step hands to the review step. Small and serializable. */
export interface ReviewPacket {
  /** Commit looks like a REWORK (same detection as the scripted runner). */
  rework: boolean;
  /** The rendered, capped user message for the model. */
  text: string;
}

function cut(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}\n…[${s.length - n} chars truncated]`;
}

/** Render the evidence into one document of at most MAX_REVIEW_INPUT_CHARS. */
export function renderReviewInput(e: ReviewEvidence): string {
  const parts: string[] = [];
  parts.push(`## Prompt\n${cut(e.prompt, MAX_PROMPT_CHARS)}`);
  if (e.rework) parts.push("## Note\nThis is a REWORK: an earlier attempt was rejected. The rework notes in the changed files (a `## Rework` section) say why.");
  parts.push(`## Commit messages\n${cut(e.commitMessages.map((m) => m.trim()).join("\n---\n"), MAX_COMMIT_CHARS)}`);

  const p = e.preview;
  if (p) {
    const body = (p.body ?? "").slice(0, MAX_PREVIEW_BODY_CHARS);
    parts.push(`## Preview evidence: GET /\nstatus: ${p.status ?? "unknown"}\ncontent-type: ${p.contentType ?? "unknown"}\nbody (first ${MAX_PREVIEW_BODY_CHARS} chars):\n${body || "(empty)"}`);
  } else {
    parts.push("## Preview evidence: GET /\n(not available: no preview was deployed)");
  }

  let tree = "";
  let shown = 0;
  for (const path of e.tree) {
    if (tree.length + path.length + 1 > MAX_TREE_CHARS) break;
    tree += `${path}\n`;
    shown++;
  }
  parts.push(`## Tree (${shown}/${e.tree.length} paths)\n${tree.trimEnd()}`);

  const head = parts.join("\n\n");
  const entries = Object.entries(e.changedFiles).sort(([a], [b]) => a.localeCompare(b));
  const out: string[] = [head];
  let budget = MAX_REVIEW_INPUT_CHARS - head.length - 40;
  let listed = 0;
  for (const [path, content] of entries.slice(0, MAX_FILES_SHOWN)) {
    const header = `\n\n## Changed file: ${path}\n`;
    const room = Math.min(MAX_FILE_CHARS, budget - header.length - 40);
    if (room < 200) break;
    const block = header + cut(content, room);
    out.push(block);
    budget -= block.length;
    listed++;
  }
  if (listed < entries.length) out.push(`\n\n(${entries.length - listed} more changed file(s) omitted: ${entries.slice(listed).map(([p]) => p).join(", ").slice(0, 400)})`);
  return out.join("").slice(0, MAX_REVIEW_INPUT_CHARS);
}

// ── verdicts ──────────────────────────────────────────────────────────────

export interface ReviewVerdict {
  verdict: "APPROVE" | "REJECT";
  satisfied: string[];
  missing: string[];
  /** <= 400 chars, addressed to the next builder. */
  feedback: string;
}

export type ReviewOutcome =
  | { kind: "verdict"; verdict: ReviewVerdict; model: string }
  /** Reviewer infrastructure failed: the gate continues (fail-open). */
  | { kind: "unavailable"; reason: string; model: string };

export interface ReviewLlm {
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, MAX_REVIEW_ITEMS).map((x) => clip(x.replace(/\s+/g, " ").trim(), MAX_REVIEW_ITEM_CHARS)) : [];

/**
 * Tolerant parse: strips code fences and chatter around the object, accepts
 * lower-case verdicts, clamps lists and feedback. Null when no verdict can be read.
 */
export function parseReview(text: string): ReviewVerdict | null {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const v = typeof o.verdict === "string" ? o.verdict.trim().toUpperCase() : "";
  if (v !== "APPROVE" && v !== "REJECT") return null;
  const missing = strings(o.missing);
  let feedback = typeof o.feedback === "string" ? o.feedback.replace(/\s+/g, " ").trim() : "";
  if (!feedback && v === "REJECT") feedback = `Prompt not satisfied: ${missing.join("; ") || "see reviewer findings"}.`;
  return { verdict: v, satisfied: strings(o.satisfied), missing: v === "APPROVE" ? [] : missing, feedback: clip(feedback, MAX_FEEDBACK_CHARS) };
}

export interface RunReviewOptions {
  llm: ReviewLlm | null;
  model: string;
  input: string;
  timeoutMs: number;
  metadata?: Record<string, string>;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`reviewer timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** One LLM call (twice on failure). Never throws: infrastructure trouble is `unavailable`. */
export async function runReview(o: RunReviewOptions): Promise<ReviewOutcome> {
  if (!o.llm) return { kind: "unavailable", reason: "no AI binding for the reviewer", model: o.model };
  const llm = o.llm;
  let reason = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await withTimeout(
        llm.complete({
          model: o.model,
          system: REVIEWER_SYSTEM_PROMPT,
          messages: [{ role: "user", content: o.input }],
          // Reasoning models think before answering; the answer itself is small.
          maxTokens: 3_000,
          responseFormat: { type: "json_schema", json_schema: { name: "review", description: "Verdict on whether the change satisfies the prompt", schema: REVIEW_JSON_SCHEMA as unknown as Record<string, unknown> } },
          ...(o.metadata ? { metadata: o.metadata } : {}),
        }),
        o.timeoutMs,
      );
      const verdict = parseReview(res.text);
      if (verdict) return { kind: "verdict", verdict, model: res.model || o.model };
      reason = `unparseable reviewer output: ${clip(res.text.replace(/\s+/g, " "), 120) || "(empty)"}`;
    } catch (e) {
      reason = String((e as Error)?.message ?? e);
      // A non-retryable gateway error (bad model id, auth) will not improve on a second try.
      if (e instanceof AiGatewayError && !e.retryable) break;
    }
  }
  return { kind: "unavailable", reason: clip(reason, 300), model: o.model };
}

/** Deterministic verdict for tests and sim parity. */
export function scriptedReview(prompt: string, rework: boolean): ReviewVerdict {
  if (prompt.includes(REVIEW_FAIL_MARKER) && !rework) {
    return {
      verdict: "REJECT",
      satisfied: [],
      missing: [`scripted review: ${REVIEW_FAIL_MARKER} marker in the prompt, first attempt`],
      feedback: `Scripted reviewer: the change does not satisfy the prompt (${REVIEW_FAIL_MARKER} marker). Rework it.`,
    };
  }
  return { verdict: "APPROVE", satisfied: ["scripted review: no marker"], missing: [], feedback: "Scripted reviewer: approved." };
}

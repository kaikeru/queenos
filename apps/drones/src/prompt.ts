/**
 * Builder prompt assembly for the live LLM path.
 *
 * The target is the no-build `worker-starter` template (templates/worker-starter): plain ES-module
 * JavaScript, relative imports only, features registered in `src/features/index.js`. Open models
 * write code that does not fit unless the prompt shows the exact shapes, so the system prompt spells
 * them out and the user message carries the repo's real file list and key files.
 */
import type { DroneTask } from "@queenos/queen-types";
import type { ChatMessage, ResponseFormat } from "@queenos/hive-kit";
import { MAX_FILE_BYTES, MAX_FILES } from "./change-set";

export const BUILDER_SYSTEM_PROMPT = `You are a QueenOS builder drone. You implement ONE user request as a small, self-contained change to a Git repository that many agents change concurrently (a speculative merge train).

# Output contract
Reply with ONE JSON object and nothing else: no prose, no Markdown fences, no comments. Exact shape:
{"files":[{"path":"src/features/example.js","content":"<the COMPLETE file text>"}],"reasoningSteps":["short step"],"discardedPaths":["approach you rejected"]}
- "files": complete file contents, never diffs or placeholders like "// rest unchanged". At most ${MAX_FILES} files, each under ${MAX_FILE_BYTES} bytes.
- Paths are relative to the repo root. Never write under .git/ or .queen/.
- File contents are JSON strings: escape newlines as \\n and double quotes as \\".
- "reasoningSteps": at most 6 short sentences (stored in the audit ledger). "discardedPaths": alternatives you rejected, may be [].

# The project: a NO-BUILD Cloudflare Worker (JavaScript)
- Every src/**/*.js file is uploaded as-is as an ES module. There is no bundler, no TypeScript, no JSX, no node_modules.
- Plain modern JavaScript only. Use ONLY relative imports with the .js extension (e.g. import { x } from "./util.js"). No npm packages, no bare imports, no require(), no Node built-ins (no node:fs, Buffer-only tricks, process, etc.). Web APIs are fine: Response, Request, URL, fetch, crypto, Date, JSON.
- src/index.js is the router. It already serves "/" and "/health" and every registered feature at GET /features/<slug>. KEEP "/" and "/health" working; do not rewrite src/index.js unless the request cannot be done otherwise.
- Do not edit package.json, wrangler config or .queen/*. Do not add tests, build configs or dependencies.

# How to add a feature (do this for almost every request)
1. Create ONE module src/features/<slug>.js (lowercase letters, digits, hyphens). It must export:
   - export const slug = "<slug>";            // served at GET /features/<slug>
   - export async function handle(request) { ... return a Response ... }
   - optionally export async function guard(request) {}  // runs on EVERY request; throw to block. Leave it out unless truly needed.
2. Register it in src/features/index.js, which has exactly this shape (one namespace import per module, then the array):
   // Feature registry. Keep this exact shape: one 'import * as fN from "./<file>.js";' per feature module, then "export const features = [...]". QueenOS merges it line by line.
   import * as f0 from "./existing-feature.js";
   import * as f1 from "./<slug>.js";
   export const features = [f0, f1];
   Keep every import that is already in the file and ADD yours. (If you forget, the platform adds it, but include it.)
3. Helper code shared by several modules goes in src/lib/<name>.js, NEVER in src/features/ (every file there must be a feature module).
4. Optionally add features/<slug>.md, a 5-line description of the feature.

If the request names a path such as "/status" or "/quote", use that word as the slug ("status", "quote"): it is served at /features/status. Do NOT edit src/index.js to add top-level routes.

Example module src/features/ping.js:
export const slug = "ping";
const startedAt = Date.now();
export async function handle(request) {
  return Response.json({ ok: true, uptimeMs: Date.now() - startedAt });
}

Example registry after adding it (when the repo had no features yet):
// Feature registry. Keep this exact shape: one 'import * as fN from "./<file>.js";' per feature module, then "export const features = [...]". QueenOS merges it line by line.
import * as f0 from "./ping.js";
export const features = [f0];

# Rules of thumb
- Prefer new files over edits to shared files, so concurrent trains stay mergeable.
- Return JSON from handlers (Response.json). Handle only what was asked; keep it short and correct.
- Isolates have no persistent memory between requests: module-level state resets. Do not claim durability you do not have.
- If a <previous_failure> section is present, fix that cause; do not repeat the same change.`;

/** JSON schema for `response_format` (models that support it return exactly this shape). */
export const CHANGE_SET_RESPONSE_FORMAT: ResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "change_set",
    description: "File changes implementing the request",
    schema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
        reasoningSteps: { type: "array", items: { type: "string" } },
        discardedPaths: { type: "array", items: { type: "string" } },
      },
      required: ["files", "reasoningSteps", "discardedPaths"],
    },
  },
};

// ── repo context ─────────────────────────────────────────────────────────

/** What the drone read from the cloned repo to ground the model. */
export interface RepoContext {
  /** Every tracked path (capped when rendered). */
  files: string[];
  /** Key files by path (registry, router, deploy.json, one example feature), already size-capped. */
  key: Record<string, string>;
}

export const MAX_CONTEXT_FILES = 200;
export const MAX_CONTEXT_FILE_CHARS = 6_000;
export const MAX_CONTEXT_TOTAL_CHARS = 20_000;
export const CONTEXT_KEY_FILES = ["src/features/index.js", "src/index.js", ".queen/deploy.json"] as const;

const MAX_RAG_SNIPPETS = 8;
const MAX_RAG_CHARS = 2_000;

export function renderRepoContext(ctx: RepoContext): string {
  const files = ctx.files.slice(0, MAX_CONTEXT_FILES);
  const more = ctx.files.length - files.length;
  const out = [`<repo_files>\n${files.join("\n")}${more > 0 ? `\n… ${more} more` : ""}\n</repo_files>`];
  let budget = MAX_CONTEXT_TOTAL_CHARS;
  for (const [path, raw] of Object.entries(ctx.key)) {
    if (budget <= 0) break;
    const cap = Math.min(MAX_CONTEXT_FILE_CHARS, budget);
    const body = raw.length > cap ? `${raw.slice(0, cap)}\n… [truncated]` : raw;
    budget -= body.length;
    out.push(`<file path="${path}">\n${body}\n</file>`);
  }
  return out.join("\n");
}

export function buildBuilderMessages(
  task: Pick<DroneTask, "promptText" | "action" | "ragContext" | "scribeSummary">,
  context: RepoContext | string[] = [],
): ChatMessage[] {
  const ctx: RepoContext | null = Array.isArray(context) ? (context.length ? { files: context, key: {} } : null) : context;
  const parts: string[] = [];
  if (ctx) parts.push(renderRepoContext(ctx));
  const rag = task.ragContext.slice(0, MAX_RAG_SNIPPETS).map((s) => s.slice(0, MAX_RAG_CHARS));
  if (rag.length) {
    parts.push(`<hive_memory>\n${rag.map((s, i) => `[${i + 1}] ${s}`).join("\n\n")}\n</hive_memory>`);
  }
  if (task.action === "REWORK" && task.scribeSummary) {
    parts.push(
      `<previous_failure>\nThe previous attempt at this request was rejected by the gatekeepers. Scribe summary:\n${task.scribeSummary}\nFix the cause; do not repeat the same change.\n</previous_failure>`,
    );
  }
  parts.push(`<request>\n${task.promptText}\n</request>\n\nRespond with the single JSON object described in the output contract.`);
  return [{ role: "user", content: parts.join("\n\n") }];
}

/** Max chars of the bad answer echoed back in the repair turn. */
export const MAX_REPAIR_ECHO_CHARS = 12_000;

/** The one repair turn: the model's own bad answer plus the validation error. */
export function buildRepairMessages(original: ChatMessage[], badOutput: string, error: string): ChatMessage[] {
  const echoed = badOutput.length > MAX_REPAIR_ECHO_CHARS ? `${badOutput.slice(0, MAX_REPAIR_ECHO_CHARS)}…` : badOutput;
  return [
    ...original,
    { role: "assistant", content: echoed || "(empty reply)" },
    {
      role: "user",
      content: `Your reply was rejected: ${error}\n\nReply again with ONLY the corrected JSON object ({"files":[...],"reasoningSteps":[...],"discardedPaths":[...]}): no prose, no Markdown fences. Keep file contents complete.`,
    },
  ];
}

/**
 * Cognitive Ledger: the GitNotesPayload stored in `refs/notes/queen` (or, when
 * a notes push is refused, in `.queen/ledger/<sha>.json`).
 */
import { GitNotesPayloadSchema, type GitNotesPayload } from "@queenos/queen-types";

/** Matches the Queen's MAX_GIT_NOTES_BYTES (apps/queen appendAudit). */
export const MAX_LEDGER_BYTES = 16 * 1024;
export const MAX_REASONING_STEPS = 20;
export const MAX_STEP_CHARS = 500;
export const MAX_TASK_PROMPT_CHARS = 4_000;
export const MAX_DISCARDED_PATHS = 50;

export const LEDGER_DIR = ".queen/ledger";

export class LedgerError extends Error {
  override readonly name = "LedgerError";
}

export type LedgerInput = Omit<GitNotesPayload, "discardedPaths"> & { discardedPaths?: string[] };

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Validate against GitNotesPayloadSchema and clip to the ledger size limits
 * (reasoning steps, prompt length, total ≤ 16 KiB). Throws LedgerError.
 */
export function buildGitNotesPayload(input: LedgerInput, opts: { maxBytes?: number } = {}): GitNotesPayload {
  const parsed = GitNotesPayloadSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new LedgerError(`invalid ledger payload: ${issues}`);
  }
  const p = parsed.data;
  if (!Number.isFinite(p.executionTimeMs) || p.executionTimeMs < 0) {
    throw new LedgerError("invalid ledger payload: executionTimeMs must be a non-negative number");
  }
  const payload: GitNotesPayload = {
    taskPrompt: clip(p.taskPrompt, MAX_TASK_PROMPT_CHARS),
    model: p.model,
    temperature: p.temperature,
    reasoningSteps: p.reasoningSteps.slice(0, MAX_REASONING_STEPS).map((s) => clip(s, MAX_STEP_CHARS)),
    result: p.result,
    executionTimeMs: Math.round(p.executionTimeMs),
    discardedPaths: p.discardedPaths.slice(0, MAX_DISCARDED_PATHS),
  };
  const maxBytes = opts.maxBytes ?? MAX_LEDGER_BYTES;
  // Still too big: drop reasoning steps from the end until it fits.
  while (ledgerBytes(payload) > maxBytes && payload.reasoningSteps.length > 0) payload.reasoningSteps.pop();
  if (ledgerBytes(payload) > maxBytes) throw new LedgerError(`ledger payload exceeds ${maxBytes} bytes`);
  return payload;
}

export function ledgerBytes(payload: GitNotesPayload): number {
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
}

/** Stable, human-readable note body. */
export function serializeLedger(payload: GitNotesPayload): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function parseLedger(text: string): GitNotesPayload {
  return GitNotesPayloadSchema.parse(JSON.parse(text));
}

/** Fallback location when the notes ref cannot be pushed. */
export function ledgerFilePath(commitSha: string): string {
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new LedgerError(`not a commit sha: ${commitSha}`);
  return `${LEDGER_DIR}/${commitSha}.json`;
}

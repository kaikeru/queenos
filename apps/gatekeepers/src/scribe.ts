/**
 * SCRIBE role: compact a raw failure log into <= 500 chars (2 sentences).
 * The Queen never sees raw logs, only this summary.
 */
import { AiGatewayError, type CompletionRequest, type CompletionResult } from "@queenos/hive-kit";

export const SCRIBE_PROMPT = "Summarize this failure in exactly two sentences.";
export const MAX_SUMMARY_CHARS = 500;
/** Raw log budget sent to the LLM. */
export const MAX_LOG_CHARS = 20_000;

export interface ScribeLlm {
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export interface ScribeResult {
  summary: string;
  method: "llm" | "extractive";
  model?: string;
}

export function clip(s: string, n = MAX_SUMMARY_CHARS): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** Keep the head and the tail of an over-long log (errors cluster at both ends). */
export function truncateLog(log: string, max = MAX_LOG_CHARS): string {
  if (log.length <= max) return log;
  const head = Math.floor(max * 0.6);
  const tail = max - head - 40;
  return `${log.slice(0, head)}\n…[${log.length - head - tail} chars truncated]…\n${log.slice(log.length - tail)}`;
}

const ERROR_LINE_RE = /(?:\b[A-Za-z]*Error\b|\berror:|\bfatal:|\bFAIL\b|\[error\])/i;
const STACK_FRAME_RE = /^\s*(?:at |❯ |\.\.\.)/;

/** First error line (stack frames skipped). */
export function firstErrorLine(log: string): string | undefined {
  return log
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !STACK_FRAME_RE.test(l) && !/^FAIL\s/.test(l) && ERROR_LINE_RE.test(l));
}

/** The failing check: an explicit hint, else a ` FAIL  <name>` line, else a `×` line. */
export function failingCheckOf(log: string, hint?: string): string | undefined {
  if (hint) return hint;
  const fail = /^\s*FAIL\s+(.+)$/m.exec(log)?.[1];
  if (fail) return fail.trim();
  return /^\s*[×✗✕]\s+(.+?)(?:\s+\d+ms)?$/m.exec(log)?.[1]?.trim();
}

/** Deterministic: the failing check plus the first error line, two sentences, <= 500 chars. */
export function extractiveSummary(log: string, failingCheck?: string): string {
  const check = failingCheckOf(log, failingCheck);
  const err = firstErrorLine(log) ?? log.split("\n").find((l) => l.trim())?.trim() ?? "no output";
  const first = check ? `Check "${check}" failed.` : "The gate failed.";
  return clip(`${first} First error: ${err.replace(/\s+/g, " ")}`);
}

/** At most two sentences, whitespace-normalised, <= 500 chars. */
export function enforceSummary(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentences = flat.split(/(?<=[.!?])\s+/);
  return clip(sentences.slice(0, 2).join(" ").trim());
}

export async function summarizeFailure(opts: { log: string; failingCheck?: string; llm: ScribeLlm | null; model: string; metadata?: Record<string, string> }): Promise<ScribeResult> {
  const fallback = (): ScribeResult => ({ summary: extractiveSummary(opts.log, opts.failingCheck), method: "extractive" });
  if (!opts.llm) return fallback();
  try {
    const res = await opts.llm.complete({
      model: opts.model,
      system: SCRIBE_PROMPT,
      messages: [{ role: "user", content: truncateLog(opts.log) }],
      maxTokens: 200,
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    });
    const text = enforceSummary(res.text);
    if (!text) return fallback();
    return { summary: text, method: "llm", model: res.model };
  } catch (e) {
    // Transient gateway trouble: let the step retry. Anything else: extractive.
    if (e instanceof AiGatewayError && e.retryable) throw e;
    return fallback();
  }
}

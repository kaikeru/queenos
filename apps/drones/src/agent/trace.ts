/**
 * Compact tool trace for the Cognitive Ledger, derived from the agent's persisted messages (durable
 * across DO evictions), and the ledger field mapping.
 */
import { MAX_DISCARDED_PATHS, MAX_REASONING_STEPS } from "../change-set";
import type { FinishArgs } from "./tools";
import { describeVerify, type VerifyResult } from "./verify";

/** The UIMessage part shape Think persists for tool calls (`type: "tool-<name>"`). */
export interface ToolPartLike {
  type: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

export const MAX_TRACE_LINES = 14;
const MAX_LINE = 200;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function target(input: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const path = str(o.path) ?? str(o.file_path) ?? str(o.filePath);
  const pattern = str(o.pattern) ?? str(o.query) ?? str(o.glob);
  if (path && pattern) return `${pattern} in ${path}`;
  return (path ?? (pattern ? `"${pattern}"` : "")).replace(/^\//, "");
}

export function traceLine(part: ToolPartLike): string | null {
  if (!part.type.startsWith("tool-")) return null;
  const name = part.type.slice(5);
  if (part.state === "output-error") return `${name} ${target(part.input)} -> error: ${(part.errorText ?? "").slice(0, 120)}`.slice(0, MAX_LINE);
  if (part.state !== "output-available") return null;
  const out = part.output as Record<string, unknown> | null | undefined;
  if (name === "verify") {
    if (out && Array.isArray(out.probes)) return describeVerify(out as unknown as VerifyResult);
    return `verify -> ${str(out?.error) ?? "error"}`.slice(0, MAX_LINE);
  }
  if (name === "finish") return out?.ok ? null : `finish refused: ${str(out?.error) ?? ""}`.slice(0, MAX_LINE);
  const failed = out && typeof out === "object" && typeof out.error === "string" ? ` -> ${out.error.slice(0, 80)}` : "";
  return `${name} ${target(part.input)}${failed}`.trim().slice(0, MAX_LINE);
}

/** Numbered trace lines (`t1 read src/index.js`), consecutive duplicates collapsed, capped (keeps the tail). */
export function traceFromParts(parts: ToolPartLike[]): string[] {
  const lines: string[] = [];
  for (const p of parts) {
    const l = traceLine(p);
    if (l && lines[lines.length - 1] !== l) lines.push(l);
  }
  const numbered = lines.map((l, i) => `t${i + 1} ${l}`);
  if (numbered.length <= MAX_TRACE_LINES) return numbered;
  const tail = numbered.slice(-(MAX_TRACE_LINES - 1));
  return [`… ${numbered.length - tail.length} earlier tool call(s)`, ...tail];
}

/** Ledger `reasoningSteps`: the agent's own reasoning, then its tool trace (≤ MAX_REASONING_STEPS). */
export function ledgerReasoning(finish: FinishArgs | null, trace: string[]): string[] {
  const own = (finish?.reasoningSteps ?? []).slice(0, 6);
  const summary = finish?.summary ? [`Summary: ${finish.summary}`] : [];
  return [...summary, ...own, ...trace].slice(0, MAX_REASONING_STEPS).map((s) => s.slice(0, 2_000));
}

/** Ledger `discardedPaths`: rejected approaches plus the models that failed before the accepted one. */
export function ledgerDiscarded(finish: FinishArgs | null, failures: { model: string; reason: string }[]): string[] {
  return [...(finish?.discardedPaths ?? []), ...failures.map((f) => `model ${f.model}: ${f.reason}`.slice(0, 200))].slice(0, MAX_DISCARDED_PATHS);
}
